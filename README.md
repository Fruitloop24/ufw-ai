# UFW — Universal Firewall for AI Agents

An edge-deployed API proxy that scans AI agent traffic for leaked secrets, injects API keys so agents never hold them, and gives you a kill switch for everything. One Cloudflare Worker. Zero dependencies.

## The Problem

AI agents run autonomously. They generate content, make API calls, and process data — often without you watching. If an agent leaks an API key, an env var, or a secret in its request body, that secret hits the provider's servers before you even know it happened.

You can't solve this with more AI. An LLM reviewing its own output for secrets is slow, expensive, and unreliable. It might miss things. It might hallucinate blocks on clean requests.

## The Solution: Go Old-School

UFW applies one of the oldest, most battle-tested filtering methods in computing to AI agent traffic: **regex pattern matching**.

The same principle behind `ipchains`, `iptables`, and every packet filter ever written. You define patterns — API key prefixes like `sk-ant-`, `AKIA`, `sk-`, env var formats like `SECRET=`, `TOKEN=`, even honeypot strings you plant deliberately. Every outbound request body gets scanned at the Cloudflare edge before it reaches any provider.

Match = block + Discord alert + full logging.

No AI in the scanning loop. No inference costs. No hallucinated blocks. Just deterministic boolean matching against known secret formats. It catches what AI can't outsmart because there's nothing to outsmart — it's a pattern match.

**And it runs in ~1ms at the edge.** Your agent doesn't even feel it.

## How It Works

```
┌──────────────┐         ┌─────────────────────────────┐         ┌──────────────┐
│              │         │     UFW (Cloudflare Edge)    │         │              │
│   AI Agent   │────────▶│                              │────────▶│  Provider    │
│  (Pi, VPS,   │         │  1. Auth check               │         │  (Anthropic, │
│   laptop)    │◀────────│  2. Kill switch check         │◀────────│   OpenAI,    │
│              │         │  3. Rate limit check          │         │   OpenRouter)│
└──────────────┘         │  4. Regex secret scan ◀─ BLOCK│         └──────────────┘
                         │  5. Inject real API key       │
                         │  6. Forward + log             │
                         └─────────────────────────────┘
                                    ~1ms
```

Your agent sends requests to `https://force.cerul.org/anthropic/v1/messages` instead of `https://api.anthropic.com/v1/messages`. UFW handles the rest.

## What You Get

- **Secret scanning** — regex patterns catch API keys, env vars, and honeypot tokens before they leave your network
- **API key injection** — agents never hold real provider keys. UFW stores them encrypted in Cloudflare secrets and injects them at the edge
- **Kill switch** — shut down all agent API access with one curl from your phone
- **Rate limiting** — per-agent, per-minute and per-hour limits. Configurable via secrets
- **Discord alerts** — instant notification when a request gets blocked
- **Multi-provider routing** — Anthropic, OpenAI, and OpenRouter through one endpoint
- **Usage logging** — every request logged with agent ID, provider, model, timestamp
- **Block logging** — blocked requests stored with full context for review
- **Multi-agent support** — `X-Agent-ID` header for per-agent tracking and limits

## Setup (5 minutes)

### 1. Clone and create KV namespace

```bash
git clone https://github.com/YOUR_USERNAME/ufw.git
cd ufw
wrangler kv namespace create UFW_LOGS
```

Copy the namespace ID from the output and paste it into `wrangler.toml` replacing `YOUR_KV_NAMESPACE_ID`.

### 2. Set your secrets

```bash
# Admin endpoint auth (pick something strong)
wrangler secret put ADMIN_KEY

# Proxy auth token (your agents will send this)
wrangler secret put PROXY_KEY

# Provider API keys
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put OPENROUTER_API_KEY
wrangler secret put OPENAI_API_KEY

# Secret scanning patterns (see example below)
wrangler secret put SCAN_PATTERNS

# Discord webhook for block alerts
wrangler secret put DISCORD_WEBHOOK_URL

# Rate limits (optional — defaults: 30/min, 500/hour)
wrangler secret put RATE_LIMIT_PER_MIN
wrangler secret put RATE_LIMIT_PER_HOUR
```

### 3. Deploy

```bash
wrangler deploy
```

### 4. Custom domain (optional)

In the Cloudflare dashboard:
1. Go to Workers & Pages → your `ufw` worker
2. Settings → Triggers → Custom Domains
3. Add `force.cerul.org` (or your domain)

Or uncomment the `routes` section in `wrangler.toml` and redeploy.

## Agent Configuration

Point your agent's provider base URLs at UFW and add the proxy auth header.

```bash
# Environment variables for OpenClaw or any agent
ANTHROPIC_BASE_URL=https://force.cerul.org/anthropic
OPENAI_BASE_URL=https://force.cerul.org/openai
OPENROUTER_BASE_URL=https://force.cerul.org/openrouter

# Auth header (add to all requests)
Authorization: Bearer YOUR_PROXY_KEY

# Optional: identify this agent for per-agent tracking
X-Agent-ID: openclaw-pi-01
```

That's it. Two env vars and a header. Your agent talks to UFW, UFW talks to the providers.

## Admin Endpoints

All admin endpoints require the `X-Admin-Key` header.

### Health check
```bash
curl -X POST https://force.cerul.org/admin/test \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

### Toggle kill switch
```bash
# Kill everything
curl -X POST https://force.cerul.org/admin/kill \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# Resume
curl -X POST https://force.cerul.org/admin/kill \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

### View usage stats (last 24h)
```bash
curl https://force.cerul.org/admin/stats \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

### View blocked requests
```bash
curl https://force.cerul.org/admin/blocks \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

## Scan Patterns

When prompted by `wrangler secret put SCAN_PATTERNS`, paste a JSON array of regex strings:

```json
[
  "AKIA[0-9A-Z]{16}",
  "sk-ant-api[a-zA-Z0-9_-]{20,}",
  "sk-[a-zA-Z0-9]{20,}",
  "(SECRET|TOKEN|PASSWORD|API_KEY|APIKEY)\\s*[=:]\\s*['\"]?[a-zA-Z0-9_/+=-]{8,}",
  "-----BEGIN (RSA |EC )?PRIVATE KEY-----",
  "ghp_[a-zA-Z0-9]{36}",
  "HONEYPOT_CANARY_[A-Z0-9]+"
]
```

**How to use honeypot tokens**: Plant fake secrets in your agent's environment (e.g., `HONEYPOT_CANARY_ABC123`). If your agent ever includes them in a request, UFW catches it instantly. It's a tripwire — if it fires, something is wrong.

Update patterns anytime with `wrangler secret put SCAN_PATTERNS` and paste the new array. Takes effect on next deploy or within minutes.

## Limitations

**KV rate limiting is eventually consistent.** Cloudflare KV propagates globally in ~60 seconds. For personal use and small teams, this means your rate limits are approximate, not exact. At scale, the upgrade path is Cloudflare Durable Objects — same Worker, stronger guarantees.

**Auth is a static bearer token.** This isn't multi-tenant OAuth. It's a shared secret between your agent and your Worker. Simple, effective, and you rotate it with one command: `wrangler secret put PROXY_KEY`. For teams, you'd want per-agent keys — easy to add.

**Pattern scanning catches known formats.** It won't catch a secret that's been base64-encoded or split across multiple fields. That's by design — no false positives, no AI guessing, just deterministic matching. Add patterns as you discover new formats.

**Free to run.** Cloudflare Workers free tier includes 100K requests/day and KV includes 100K reads + 1K writes/day. More than enough for personal use. Paid plans start at $5/month if you outgrow it.

## License

MIT. Use it, fork it, deploy it.

If you want this as a managed service — no setup, hosted dashboard, team support — drop your email at [cerul.org](https://cerul.org). Or just paste this README into your AI and deploy it yourself.
