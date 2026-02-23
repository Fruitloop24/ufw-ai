// UFW — Universal Firewall for AI Agents
// Single Cloudflare Worker: secret scanning, rate limiting, kill switch, provider routing

const PROVIDERS = {
  anthropic: { upstream: 'https://api.anthropic.com', keyHeader: 'x-api-key', keyEnv: 'ANTHROPIC_API_KEY' },
  openrouter: { upstream: 'https://openrouter.ai/api', keyHeader: 'authorization', keyPrefix: 'Bearer ', keyEnv: 'OPENROUTER_API_KEY' },
  openai: { upstream: 'https://api.openai.com', keyHeader: 'authorization', keyPrefix: 'Bearer ', keyEnv: 'OPENAI_API_KEY' },
  deepseek: { upstream: 'https://api.deepseek.com', keyHeader: 'authorization', keyPrefix: 'Bearer ', keyEnv: 'DEEPSEEK_API_KEY' },
  kimi: { upstream: 'https://api.moonshot.ai', keyHeader: 'authorization', keyPrefix: 'Bearer ', keyEnv: 'KIMI_API_KEY' },
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
});

const truncate = (str, max = 4096) => str.length > max ? str.slice(0, max) + '...[truncated]' : str;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Admin endpoints ---
    if (path.startsWith('/admin/')) {
      return handleAdmin(path, request, env);
    }

    // --- Provider routing ---
    const segments = path.split('/').filter(Boolean);
    const providerName = segments[0];
    const provider = PROVIDERS[providerName];
    if (!provider) {
      return json({ error: 'Unknown route. Use /anthropic/*, /openai/*, /openrouter/*, /deepseek/*, or /kimi/*' }, 404);
    }

    const agentId = request.headers.get('x-agent-id') || 'default';
    const body = request.method !== 'GET' ? await request.text() : '';

    // --- Kill switch ---
    const enabled = await env.UFW_LOGS.get('ENABLED');
    if (enabled === 'false') {
      ctx.waitUntil(logBlock(env, agentId, providerName, 'kill_switch', body));
      return json({ error: 'UFW kill switch is active. All requests are blocked.', code: 'KILL_SWITCH' }, 503);
    }

    // --- Proxy auth ---
    const authHeader = request.headers.get('authorization') || '';
    const proxyToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!proxyToken || proxyToken !== env.PROXY_KEY) {
      return json({ error: 'Unauthorized. Provide Authorization: Bearer <PROXY_KEY>' }, 401);
    }

    // --- Rate limiting ---
    const now = new Date();
    const minBucket = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
    const hrBucket = now.toISOString().slice(0, 13);   // YYYY-MM-DDTHH
    const perMin = parseInt(env.RATE_LIMIT_PER_MIN) || 30;
    const perHour = parseInt(env.RATE_LIMIT_PER_HOUR) || 500;

    const rateLimitResult = await checkRateLimit(env, agentId, minBucket, hrBucket, perMin, perHour);
    if (rateLimitResult) {
      ctx.waitUntil(logBlock(env, agentId, providerName, rateLimitResult, body));
      return json({ error: `Rate limit exceeded: ${rateLimitResult}`, code: 'RATE_LIMITED' }, 429);
    }

    // --- Secret scanning ---
    if (body) {
      const scanResult = scanSecrets(env, body);
      if (scanResult) {
        ctx.waitUntil(logBlock(env, agentId, providerName, `secret_detected:${scanResult}`, body));
        return json({ error: 'Request blocked: potential secret detected in request body', code: 'SECRET_DETECTED', pattern: scanResult }, 403);
      }
    }

    // --- Proxy forward ---
    const restPath = '/' + segments.slice(1).join('/');
    const upstreamUrl = provider.upstream + restPath + url.search;
    const isChatCompletions = restPath.endsWith('/chat/completions');

    // Force non-streaming on chat completions so we can scan the full response
    let forwardBody = body;
    let wasStreaming = false;
    if (isChatCompletions && body && request.method === 'POST') {
      try {
        const parsed = JSON.parse(body);
        if (parsed.stream) {
          wasStreaming = true;
          parsed.stream = false;
          delete parsed.stream_options;
          forwardBody = JSON.stringify(parsed);
        }
      } catch {
        // Not valid JSON — forward as-is
      }
    }

    const proxyHeaders = new Headers(request.headers);
    // Remove the proxy auth header before forwarding
    proxyHeaders.delete('authorization');
    // Inject the real API key
    const realKey = env[provider.keyEnv];
    if (provider.keyPrefix) {
      proxyHeaders.set(provider.keyHeader, provider.keyPrefix + realKey);
    } else {
      proxyHeaders.set(provider.keyHeader, realKey);
    }
    proxyHeaders.delete('host');
    // Recalculate content-length when we modified the body
    if (wasStreaming) {
      proxyHeaders.delete('content-length');
    }

    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? forwardBody : undefined,
    });

    // --- Usage logging (non-blocking) ---
    ctx.waitUntil(logUsage(env, agentId, providerName, body, now));

    // --- Outbound response scanning (chat completions only) ---
    if (isChatCompletions && upstreamResponse.status === 200) {
      const contentType = upstreamResponse.headers.get('content-type') || '';
      const isSSE = contentType.includes('text/event-stream');

      let responseBody;
      if (isSSE) {
        // Provider ignored stream:false — buffer SSE, extract content, build JSON response
        responseBody = await assembleSSEResponse(upstreamResponse);
        console.log(`[UFW] Assembled SSE response: ${responseBody.length} bytes`);
      } else {
        responseBody = await upstreamResponse.text();
      }

      console.log(`[UFW] Scanning response: ${responseBody.length} bytes, content-type: ${contentType}`);
      const { redacted, matched } = scanResponseContent(env, responseBody);

      const responseHeaders = new Headers(upstreamResponse.headers);
      responseHeaders.set('content-type', 'application/json');
      responseHeaders.delete('content-length');

      if (matched.length > 0) {
        ctx.waitUntil(logResponseLeak(env, agentId, providerName, matched));
        return new Response(redacted, { status: 200, headers: responseHeaders });
      }

      return new Response(responseBody, { status: 200, headers: responseHeaders });
    }

    // Non-chat or non-200 — pass through unchanged
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers,
    });
  },
};

// ==================== Admin Handlers ====================

async function handleAdmin(path, request, env) {
  const adminKey = request.headers.get('x-admin-key');
  if (!adminKey || adminKey !== env.ADMIN_KEY) {
    return json({ error: 'Unauthorized. Provide X-Admin-Key header.' }, 401);
  }

  if (path === '/admin/kill' && request.method === 'POST') {
    return adminKill(request, env);
  }
  if (path === '/admin/stats' && request.method === 'GET') {
    return adminStats(env);
  }
  if (path === '/admin/blocks' && request.method === 'GET') {
    return adminBlocks(env);
  }
  if (path === '/admin/test' && request.method === 'POST') {
    return adminTest(env);
  }

  return json({ error: 'Unknown admin endpoint' }, 404);
}

async function adminKill(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.enabled !== 'boolean') {
    return json({ error: 'Body must be {"enabled": true/false}' }, 400);
  }
  await env.UFW_LOGS.put('ENABLED', String(body.enabled));
  return json({ status: 'ok', enabled: body.enabled });
}

async function adminStats(env) {
  const now = new Date();
  const stats = {};

  // List all stat keys once
  const list = await env.UFW_LOGS.list({ prefix: 'stats:' });

  // Build set of valid hourly buckets (last 24h)
  const validBuckets = new Set();
  for (let i = 0; i < 24; i++) {
    validBuckets.add(new Date(now.getTime() - i * 3600000).toISOString().slice(0, 13));
  }

  // Filter and aggregate
  const reads = list.keys
    .filter(k => {
      const parts = k.name.split(':');
      return parts.length === 3 && validBuckets.has(parts[2]);
    })
    .map(async k => {
      const parts = k.name.split(':'); // stats:{agent}:{bucket}
      const agent = parts[1];
      const bucket = parts[2];
      const val = parseInt(await env.UFW_LOGS.get(k.name)) || 0;
      if (!stats[agent]) stats[agent] = { total: 0, hours: {} };
      stats[agent].total += val;
      stats[agent].hours[bucket] = val;
    });

  await Promise.all(reads);
  return json({ period: 'last_24h', stats });
}

async function adminBlocks(env) {
  const list = await env.UFW_LOGS.list({ prefix: 'blocked:', limit: 50 });
  const blocks = [];
  for (const key of list.keys) {
    const val = await env.UFW_LOGS.get(key.name);
    try {
      blocks.push(JSON.parse(val));
    } catch {
      blocks.push({ key: key.name, raw: val });
    }
  }
  return json({ count: blocks.length, blocks });
}

async function adminTest(env) {
  const enabled = await env.UFW_LOGS.get('ENABLED');
  const agentList = await env.UFW_LOGS.list({ prefix: 'stats:' });
  const agents = [...new Set(agentList.keys.map(k => k.name.split(':')[1]))];

  return json({
    status: 'ok',
    enabled: enabled !== 'false',
    agents_seen: agents,
    timestamp: new Date().toISOString(),
  });
}

// ==================== Rate Limiting ====================

async function checkRateLimit(env, agentId, minBucket, hrBucket, perMin, perHour) {
  const minKey = `rate:${agentId}:min:${minBucket}`;
  const hrKey = `rate:${agentId}:hr:${hrBucket}`;

  const [minCount, hrCount] = await Promise.all([
    env.UFW_LOGS.get(minKey).then(v => parseInt(v) || 0),
    env.UFW_LOGS.get(hrKey).then(v => parseInt(v) || 0),
  ]);

  if (minCount >= perMin) return `${perMin}/min`;
  if (hrCount >= perHour) return `${perHour}/hr`;

  // Increment both counters
  await Promise.all([
    env.UFW_LOGS.put(minKey, String(minCount + 1), { expirationTtl: 120 }),
    env.UFW_LOGS.put(hrKey, String(hrCount + 1), { expirationTtl: 7200 }),
  ]);

  return null;
}

// ==================== Secret Scanning ====================

function scanSecrets(env, body) {
  let patterns;
  try {
    patterns = JSON.parse(env.SCAN_PATTERNS || '[]');
  } catch {
    return null; // If patterns are malformed, don't block
  }

  for (const pat of patterns) {
    try {
      if (new RegExp(pat, 'i').test(body)) {
        return pat;
      }
    } catch {
      continue; // Skip invalid regex
    }
  }
  return null;
}

// ==================== SSE Response Assembly ====================

async function assembleSSEResponse(response) {
  const text = await response.text();
  const lines = text.split('\n');

  let role = 'assistant';
  let content = '';
  let model = 'unknown';
  let id = '';
  let finishReason = null;

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;

    try {
      const chunk = JSON.parse(data);
      if (chunk.id) id = chunk.id;
      if (chunk.model) model = chunk.model;
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.role) role = delta.role;
      if (delta?.content) content += delta.content;
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    } catch {
      continue;
    }
  }

  // Rebuild as a standard non-streaming response
  const assembled = {
    id: id || 'chatcmpl-assembled',
    object: 'chat.completion',
    model,
    choices: [{
      index: 0,
      message: { role, content },
      finish_reason: finishReason || 'stop',
    }],
  };

  return JSON.stringify(assembled);
}

// ==================== Outbound Response Scanning ====================

const RESPONSE_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,          // OpenAI, DeepSeek, generic (sk-proj-*, sk-ant-api03-*, etc.)
  /ghp_[a-zA-Z0-9]{36}/g,            // GitHub personal access tokens
  /eyJ[a-zA-Z0-9_-]{20,}/g,          // JWT tokens
  /AKIA[A-Z0-9]{16}/g,               // AWS access key IDs
  /rpa_[a-zA-Z0-9]{40,}/g,           // RunPod API keys
  /xox[bpras]-[a-zA-Z0-9-]{10,}/g,   // Slack tokens
  /[0-9]+:AA[a-zA-Z0-9_-]{30,}/g,    // Telegram bot tokens
  /[a-f0-9]{64}/g,                   // 64-char hex strings (gateway tokens, etc.)
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[a-f0-9]{32}/g, // fal.ai UUID:hex
];

const KNOWN_SECRET_KEYS = [
  'PROXY_KEY', 'ADMIN_KEY',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY', 'KIMI_API_KEY',
];

function getKnownSecrets(env) {
  const secrets = [];
  for (const key of KNOWN_SECRET_KEYS) {
    const val = env[key];
    if (val && val.length >= 8) secrets.push({ name: key, value: val });
  }
  // Honeypots
  for (let i = 1; i <= 10; i++) {
    const val = env[`HONEYPOT_${i}`];
    if (val) secrets.push({ name: `HONEYPOT_${i}`, value: val });
  }
  return secrets;
}

function scanResponseContent(env, responseBody) {
  let parsed;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return { redacted: responseBody, matched: [] };
  }

  const choices = parsed.choices;
  if (!Array.isArray(choices)) {
    return { redacted: responseBody, matched: [] };
  }

  const matched = [];
  const knownSecrets = getKnownSecrets(env);

  for (const choice of choices) {
    const content = choice?.message?.content;
    if (typeof content !== 'string') continue;

    let scanned = content;

    // Check known secrets first (exact match — PROXY_KEY, real API keys, honeypots)
    for (const secret of knownSecrets) {
      if (scanned.includes(secret.value)) {
        matched.push(`known:${secret.name}`);
        scanned = scanned.split(secret.value).join('[REDACTED-BY-UFW]');
      }
    }

    // Regex pattern scan for generic secret shapes
    for (const pattern of RESPONSE_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(scanned)) {
        matched.push(`pattern:${pattern.source.slice(0, 30)}`);
        pattern.lastIndex = 0;
        scanned = scanned.replace(pattern, '[REDACTED-BY-UFW]');
      }
    }

    if (scanned !== content) {
      choice.message.content = scanned;
    }
  }

  if (matched.length > 0) {
    return { redacted: JSON.stringify(parsed), matched };
  }

  return { redacted: responseBody, matched: [] };
}

// ==================== Logging ====================

async function logBlock(env, agentId, provider, reason, body) {
  const ts = new Date().toISOString();
  const key = `blocked:${ts}:${agentId}`;
  const record = {
    timestamp: ts,
    agent_id: agentId,
    provider,
    reason,
    body: truncate(body),
  };

  await env.UFW_LOGS.put(key, JSON.stringify(record), { expirationTtl: 86400 * 7 });

  // Discord alert (fire and forget)
  if (env.DISCORD_WEBHOOK_URL) {
    try {
      await fetch(env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: `**UFW BLOCK** | Agent: \`${agentId}\` | Provider: \`${provider}\` | Reason: \`${reason}\` | Time: ${ts}`,
        }),
      });
    } catch {
      // Discord alert is best-effort
    }
  }
}

async function logResponseLeak(env, agentId, provider, matched) {
  const ts = new Date().toISOString();
  const key = `blocked:${ts}:${agentId}:response`;
  const record = {
    timestamp: ts,
    agent_id: agentId,
    provider,
    reason: 'response_secret_redacted',
    matched_patterns: matched,
  };

  await env.UFW_LOGS.put(key, JSON.stringify(record), { expirationTtl: 86400 * 7 });

  // Alert webhook (Discord or other)
  const webhookUrl = env.ALERT_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: `**UFW RESPONSE REDACTION** | Agent: \`${agentId}\` | Provider: \`${provider}\` | Patterns: \`${matched.join(', ')}\` | Time: ${ts}`,
        }),
      });
    } catch {
      // Alert is best-effort
    }
  }

  console.log(`[UFW] Response redaction: agent=${agentId} provider=${provider} patterns=${matched.join(',')}`);
}

async function logUsage(env, agentId, provider, body, now) {
  const hrBucket = now.toISOString().slice(0, 13);
  const statsKey = `stats:${agentId}:${hrBucket}`;

  // Increment hourly counter
  const current = parseInt(await env.UFW_LOGS.get(statsKey)) || 0;
  await env.UFW_LOGS.put(statsKey, String(current + 1), { expirationTtl: 86400 * 2 });

  // Individual call log
  let model = 'unknown';
  try {
    const parsed = JSON.parse(body);
    model = parsed.model || 'unknown';
  } catch {
    // Not JSON or no model field
  }

  const ts = now.toISOString();
  const logKey = `log:${ts}:${agentId}`;
  await env.UFW_LOGS.put(logKey, JSON.stringify({
    timestamp: ts,
    agent_id: agentId,
    provider,
    model,
    status: 'passed',
  }), { expirationTtl: 86400 * 2 });
}
