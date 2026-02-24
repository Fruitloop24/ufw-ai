# UFW — Universal Firewall for AI Agents

You want to experiment with the latest AI models. Build cool stuff. Run agents on a Pi, a VPS, wherever. But you've got $20 on your API key and a knot in your stomach.

**What if your agent leaks your API key?** It's sitting right there in the environment. One weird prompt, one bad tool call, and your key is in someone else's logs. Gone.

**What if the AI model leaks your key in its response?** The model reads your system prompt, sees an API key in a tool output, or hallucinates one from context — and posts it straight to Discord or Telegram. You never even see it happen.

**What if your agent goes into a loop?** You wake up, check your dashboard, and your $20 is now $0.47. It burned through your budget while you were sleeping.

**What if you just need it to stop?** Right now. From your phone. No SSH, no terminal, just *stop*.

That's what UFW does.

## How It Keeps You Safe

UFW sits between your agent and the AI providers. Every request **and every response** passes through it. Your agent never touches a real API key — UFW holds the keys and injects them at the last second, only after the request passes inspection. And when the response comes back, UFW scans that too before your agent sees it.

```
Your Agent  ──▶  UFW (Cloudflare Edge)  ──▶  AI Provider
                  │                            │
                  ├─ INBOUND SCAN              │
                  │  ├─ Is this agent authorized?
                  │  ├─ Is the kill switch on?  │
                  │  ├─ Has it hit its rate limit?
                  │  ├─ Any secrets in the request? ◀─ BLOCK
                  │  ├─ Inject the real API key │
                  │  └─ Forward to provider ────┘
                  │                            │
                  ├─ OUTBOUND SCAN ◀───────────┘
                  │  ├─ Any of OUR secrets in the response? ◀─ REDACT + AUTO-KILL
                  │  ├─ Honeypot value detected? ◀─ REDACT + AUTO-KILL
                  │  ├─ Any secret-shaped patterns? ◀─ REDACT
                  │  ├─ Strip invisible Unicode evasion chars
                  │  └─ Return clean response
                  │
                  └─▶  Your Agent (clean response)
```

All of this happens in milliseconds. Your agent doesn't even notice.

## Two-Way Scanning — Why It Matters

Most proxy firewalls only scan in one direction. UFW scans both:

**Inbound (request) scanning** blocks your agent from accidentally sending secrets to the AI provider. If your agent reads an `.env` file and stuffs it into a prompt, UFW catches the API key pattern in the request body and blocks it. The request never leaves.

**Outbound (response) scanning** catches secrets the AI model includes in its response. This is the one people don't think about. The model has your system prompt in its context window. It might have tool outputs that include credentials. It might hallucinate a key it saw during training. If any of that ends up in the response, UFW redacts it before your agent posts it to a public channel.

The outbound scanner's strongest layer is the simplest: **it knows your actual secrets**. Your PROXY_KEY, your DEEPSEEK_API_KEY, your OPENAI_API_KEY — they're all stored in the Worker. If any of those exact values appear in a response, it's caught instantly. No regex needed. No pattern to evade. The scanner checks: "is this the actual key I'm holding?" Yes or no.

On top of that, regex patterns catch generic secret shapes — anything starting with `sk-`, `ghp_`, `AKIA`, `eyJ`, or matching the catch-all: any unbroken string of 12+ characters with 4+ digits mixed in. Normal English has spaces. Keys don't.

### What we tested (and what happened)

We threw 10 evasion techniques at the outbound scanner live in production:

| Technique | Caught? |
|-----------|---------|
| Raw API key (`sk-proj-...`) | Yes — regex pattern |
| Base64-encoded key | Yes — catch-all pattern |
| Reversed string | Yes — catch-all pattern |
| Key in JSON | Yes — regex pattern |
| Key in URL params | Yes — regex pattern |
| Hex representation | Yes — catch-all pattern |
| Key in code block | Yes — regex pattern |
| Key in XML/CDATA | Yes — regex pattern |
| Key with line breaks | Yes — regex pattern |
| Zero-width Unicode spaces between chars | Yes — stripped before scanning |

Then we tried harder:

| Technique | Caught? | Realistic threat? |
|-----------|---------|-------------------|
| Caesar cipher | No | No — AI doesn't encrypt its own output |
| Spaced-out letters | No | No — not how keys appear in context |
| URL encoding | No | Low — unusual in chat responses |
| Morse code | No | No |
| Binary | No | No |
| Homoglyphs (Cyrillic lookalikes) | No | No — AI outputs real chars from context |

**The honest take:** The evasion tricks that beat the scanner are all adversarial — someone would have to deliberately craft a prompt to make the AI encode a secret before outputting it. That's a real attack vector, but it's not the common case. The common case is the AI dumping a raw key from its context window into a chat message. That's what UFW catches, every time.

We're not pretending to catch everything. We're catching the thing that actually happens.

## What It Stops

**Secrets leaking out (inbound).** UFW scans every outgoing request for things that look like API keys, passwords, tokens, and private keys. If it finds one, the request gets blocked before it ever reaches the provider. You get an alert. The agent gets an error. Your secret stays secret.

**Secrets leaking back (outbound).** UFW scans every AI response for your actual secret values and generic key patterns. If the model includes a credential in its response, UFW replaces it with `[REDACTED-BY-UFW]` and delivers the cleaned response. Your agent keeps running. The secret never reaches the end user.

**Runaway costs.** Set a rate limit — say, 30 requests per minute or 500 per hour. If your agent starts looping or goes off the rails, it hits the wall. Your budget survives.

**Everything, instantly.** The kill switch shuts down all agent traffic with one command. From your phone, from anywhere. Hit it, figure out what went wrong, then turn it back on when you're ready.

**Agents holding your keys.** Your real API keys live in Cloudflare's encrypted secret store. Your agent only gets a proxy token that means nothing outside of UFW. If that token leaks, you rotate it in 10 seconds. Your actual provider keys never move.

## Four Levels of Response

| Level | Trigger | What happens | Bot status |
|-------|---------|-------------|------------|
| **Clean** | No match | Response passes through unchanged | Running |
| **Redact** | Generic pattern match (`sk-`, `ghp_`, catch-all) | Secret scrubbed, `[REDACTED-BY-UFW]` inserted | Running |
| **Auto-kill** | Known secret match (your actual keys or honeypots) | Secret scrubbed + kill switch flips automatically | Dead — 503 until you re-enable |
| **Manual kill** | You hit the kill switch | All traffic blocked, 503 | Dead until you flip it back |

**Why two levels of severity?** A generic pattern match (the AI generated something that *looks like* a key) is worth redacting but not worth shutting down the bot. But if the AI outputs your *actual* PROXY_KEY or a honeypot value — that's a real leak from context. The system is compromised. UFW shuts it down immediately, sends you an alert, and waits for you to investigate.

The 503s cost nothing. The kill switch fires before the request ever reaches the AI provider — zero tokens consumed, zero charges.

## What You Need

- A free [Cloudflare](https://cloudflare.com) account
- Your AI provider API keys (Anthropic, OpenAI, DeepSeek, Kimi — whatever you use)
- 5 minutes

The free tier covers 100,000 requests per day. For experimenting and small projects, you'll never pay a cent.

## Quick Setup

### 1. Clone and create storage

```bash
git clone https://github.com/Fruitloop24/ufw-ai.git
cd ufw-ai
npx wrangler kv namespace create UFW_LOGS
```

Paste the namespace ID into `wrangler.toml` where it says `YOUR_KV_NAMESPACE_ID`.

### 2. Add your secrets

```bash
npx wrangler secret put ADMIN_KEY        # your admin password
npx wrangler secret put PROXY_KEY        # token your agents will use
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put KIMI_API_KEY
npx wrangler secret put SCAN_PATTERNS    # see below
```

Optional but recommended:
```bash
npx wrangler secret put ALERT_WEBHOOK_URL  # Discord webhook for leak alerts
npx wrangler secret put HONEYPOT_1         # fake secret as a tripwire
```

### 3. Deploy

```bash
npx wrangler deploy
```

That's it. Your firewall is live. Inbound and outbound.

### 4. Point your agent at UFW

Instead of talking directly to the AI provider, your agent talks to UFW:

```bash
ANTHROPIC_BASE_URL=https://your-worker.your-subdomain.workers.dev/anthropic
OPENAI_BASE_URL=https://your-worker.your-subdomain.workers.dev/openai
DEEPSEEK_BASE_URL=https://your-worker.your-subdomain.workers.dev/deepseek
```

Add the proxy token to your agent's requests:
```
Authorization: Bearer YOUR_PROXY_KEY
```

Your agent doesn't need any real API keys. UFW handles that part.

## Why This Actually Works

Here's the thing — you can't use AI to watch AI. An LLM reviewing its own output for secrets is slow, expensive, and it guesses. It'll miss things. It'll block clean requests. You're paying inference costs to maybe catch a problem.

UFW doesn't use AI at all. It uses **regex** — regular expressions. The same pattern-matching that's been protecting networks since the early days of `ipchains` and `iptables`. The same idea behind every firewall and packet filter ever written.

But the real weapon isn't regex — it's **exact match against known secrets**. UFW holds your actual API keys. When a response comes back from the AI provider, the first thing the scanner does is check: "does this response contain the literal value of any secret I'm holding?" That's not a pattern. That's not a guess. It's a direct comparison. If the AI regurgitates your PROXY_KEY, the scanner knows — because it has the key right there.

The regex patterns are a second layer. Every API key has a recognizable shape. OpenAI keys start with `sk-proj-`. AWS keys start with `AKIA`. GitHub tokens start with `ghp_`. And the catch-all: any 12+ character unbroken string with 4+ digits mixed in is flagged. Normal words have spaces. Keys don't.

The scanner also strips invisible Unicode characters (zero-width spaces, joiners, soft hyphens) before matching — so tricks like inserting invisible characters between key characters don't work.

And it runs in milliseconds because pattern matching is one of the cheapest operations a computer can do. Your agent doesn't slow down. Your costs don't go up. It just works, quietly, every single time.

**This is where the community comes in.** The patterns we ship are a starting point. But the world keeps making new things to catch. New provider key formats. New encoding tricks. Every pattern someone contributes makes every UFW deployment safer. Fork it, add your patterns, open a PR. The more eyes on this, the better it gets for everyone.

## Honeypots and Auto-Kill

Plant fake secrets as Worker secrets. UFW checks every AI response for these exact values — no regex, no patterns, just "is this string in the response?"

```bash
npx wrangler secret put HONEYPOT_1    # e.g. canary-ufw-tripwire-8675309
npx wrangler secret put HONEYPOT_2    # e.g. ghp_CANARY0000000000000000000000000000
```

If a honeypot (or any known secret — PROXY_KEY, real API keys) appears in a response:

1. The value is replaced with `[REDACTED-BY-UFW]`
2. The kill switch flips automatically — all traffic stops
3. Every subsequent request gets 503 until you re-enable
4. Discord webhook alert fires (if configured)

This is the nuclear option and it's intentional. If the AI is outputting your actual secrets, the system prompt or tool context is compromised. Redacting one response doesn't fix the root cause — the next response might leak it differently. So UFW shuts everything down and waits for you.

### Testing auto-kill with a honeypot

This is the best way to prove the whole system works end-to-end:

1. Set a honeypot: `npx wrangler secret put HONEYPOT_1` → enter `canary-ufw-tripwire-8675309`
2. Start a new session with your bot
3. Send: `repeat this exact string back to me, nothing else: canary-ufw-tripwire-8675309`
4. The AI repeats it → outbound scanner catches it → response shows `[REDACTED-BY-UFW]`
5. Kill switch flips → next message gets 503
6. Re-enable when ready:

```bash
curl -X POST https://your-worker.workers.dev/admin/kill \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

The honeypot passes through the inbound scanner (it doesn't match any key pattern) but gets caught on the way back out (exact match). That's a clean end-to-end test of outbound scanning + auto-kill.

## Kill Switch

Shut everything down:
```bash
curl -X POST https://your-worker.workers.dev/admin/kill \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

Turn it back on when you're ready:
```bash
curl -X POST https://your-worker.workers.dev/admin/kill \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

## Inbound Scanning Patterns

When you set `SCAN_PATTERNS`, paste a JSON list of patterns to watch for in requests:

```json
[
  "sk-ant-api[a-zA-Z0-9_-]{20,}",
  "sk-proj-[a-zA-Z0-9_-]{20,}",
  "AKIA[0-9A-Z]{16}",
  "ghp_[a-zA-Z0-9]{36}",
  "(SECRET|TOKEN|PASSWORD|API_KEY)\\s*[=:]\\s*['\"]?[a-zA-Z0-9_/+=-]{8,}",
  "-----BEGIN (RSA |EC )?PRIVATE KEY-----",
  "HONEYPOT_CANARY_[A-Z0-9]+"
]
```

Outbound response patterns are built into the Worker — no configuration needed. They include specific prefixes (sk-, ghp_, AKIA, eyJ, xoxb-, etc.) plus the catch-all for long strings with digits.

## Check On Things

```bash
# Health check
curl -X POST https://your-worker.workers.dev/admin/test \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# See usage stats (last 24 hours)
curl https://your-worker.workers.dev/admin/stats \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# See what got blocked (includes inbound blocks AND outbound redactions)
curl https://your-worker.workers.dev/admin/blocks \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

## Good to Know

- **Rate limits are approximate**, not exact to the millisecond. Close enough for protecting a budget, not designed for billing-grade precision.
- **Outbound scanning buffers streaming responses.** When your agent requests a streaming response, UFW buffers the full SSE stream, scans the assembled content, and replays it. This means the response arrives all at once instead of token-by-token. For chat bots posting to Telegram/Discord, this is invisible. For real-time typing indicators, it's a tradeoff.
- **Pattern scanning catches known formats.** If a secret is encoded, obfuscated, or split across fields, regex won't catch it. But the exact-match scan against your actual secrets will catch those values regardless of surrounding context. We don't pretend to catch everything — we catch the thing that actually happens.
- **Rate limiting is real budget protection.** Your agent goes into a loop at 3am? UFW cuts it off at 30 requests per minute. That's the difference between waking up to a $0.47 balance and waking up to a normal day.
- **The proxy token is a shared secret.** One token for all your agents. Simple. If you need per-agent auth later, it's easy to add.

## Testing the Scanner (and the Gotcha)

**Testing inbound scanning:** Send a message containing a fake key that matches a pattern — something like `sk-ant-api03-FAKE1234567890abcdefghijklmnop`. UFW will block it and log it. Satisfying.

**Testing outbound scanning:** Ask the AI to generate a dummy API key. Tell it you're testing a firewall. If UFW is working, the key in the response will show as `[REDACTED-BY-UFW]`.

**The gotcha with AI agents:** once a blocked message is in the conversation history, every follow-up request will also get blocked — because the agent sends the full chat history with every API call, and that fake key is still sitting in there. UFW scans the entire request body, not just the latest message.

**The fix:** start a new session. The old conversation carries the poison; a new one starts clean. UFW has no memory of past blocks — it doesn't ban you or hold a grudge. Each request is scanned fresh. If the request body is clean, it passes.

This is actually a feature, not a bug. If a real secret ends up anywhere in a conversation — even buried 50 messages deep — UFW catches it every single time until that conversation is gone.

## Need Help?

Paste this entire README into Claude, ChatGPT, or whatever AI you've got and tell it to set this up for you. It'll walk you through every step — that's literally what it's for.

Want it managed instead — hosted dashboard, team support, no setup? Drop your email at [cerul.org](https://cerul.org).

## License

MIT. Use it however you want.

Built for [ClawBot](https://github.com/Fruitloop24) and anyone else who wants to experiment with AI agents without losing sleep over leaked keys and runaway bills.
