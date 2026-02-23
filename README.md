# UFW — Universal Firewall for AI Agents

You want to experiment with the latest AI models. Build cool stuff. Run agents on a Pi, a VPS, wherever. But you've got $20 on your API key and a knot in your stomach.

**What if your agent leaks your API key?** It's sitting right there in the environment. One weird prompt, one bad tool call, and your key is in someone else's logs. Gone.

**What if your agent goes into a loop?** You wake up, check your dashboard, and your $20 is now $0.47. It burned through your budget while you were sleeping.

**What if you just need it to stop?** Right now. From your phone. No SSH, no terminal, just *stop*.

That's what UFW does.

## How It Keeps You Safe

UFW sits between your agent and the AI providers. Every request passes through it. Your agent never touches a real API key — UFW holds the keys and injects them at the last second, only after the request passes inspection.

```
Your Agent  ──▶  UFW (Cloudflare Edge)  ──▶  Anthropic / OpenAI / OpenRouter
                  ├─ Is this agent authorized?
                  ├─ Is the kill switch on?
                  ├─ Has this agent hit its rate limit?
                  ├─ Are there any secrets in this request? ◀─ BLOCK
                  ├─ Inject the real API key
                  └─ Forward and log
```

All of this happens in about 1 millisecond. Your agent doesn't even notice.

## What It Stops

**Secrets leaking out.** UFW scans every outgoing request for things that look like API keys, passwords, tokens, and private keys. If it finds one, the request gets blocked before it ever leaves your network. You get an alert. The agent gets an error. Your secret stays secret.

**Runaway costs.** Set a rate limit — say, 30 requests per minute or 500 per hour. If your agent starts looping or goes off the rails, it hits the wall. Your budget survives.

**Everything, instantly.** The kill switch shuts down all agent traffic with one command. From your phone, from anywhere. Hit it, figure out what went wrong, then turn it back on when you're ready.

**Agents holding your keys.** Your real API keys live in Cloudflare's encrypted secret store. Your agent only gets a proxy token that means nothing outside of UFW. If that token leaks, you rotate it in 10 seconds. Your actual provider keys never move.

## What You Need

- A free [Cloudflare](https://cloudflare.com) account
- Your AI provider API keys (Anthropic, OpenAI, OpenRouter — whatever you use)
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
npx wrangler secret put SCAN_PATTERNS    # see below
```

### 3. Deploy

```bash
npx wrangler deploy
```

That's it. Your firewall is live.

### 4. Point your agent at UFW

Instead of talking directly to the AI provider, your agent talks to UFW:

```bash
ANTHROPIC_BASE_URL=https://your-worker.your-subdomain.workers.dev/anthropic
OPENAI_BASE_URL=https://your-worker.your-subdomain.workers.dev/openai
```

Add the proxy token to your agent's requests:
```
Authorization: Bearer YOUR_PROXY_KEY
```

Your agent doesn't need any real API keys. UFW handles that part.

## Why This Actually Works

Here's the thing — you can't use AI to watch AI. An LLM reviewing its own output for secrets is slow, expensive, and it guesses. It'll miss things. It'll block clean requests. You're paying inference costs to maybe catch a problem.

UFW doesn't use AI at all. It uses **regex** — regular expressions. The same pattern-matching that's been protecting networks since the early days of `ipchains` and `iptables`. The same idea behind every firewall and packet filter ever written.

It works like this: every API key has a recognizable shape. Anthropic keys start with `sk-ant-api`. OpenAI keys start with `sk-proj-`. AWS keys start with `AKIA` followed by exactly 16 uppercase characters. GitHub tokens start with `ghp_`. These aren't secrets about secrets — they're public prefixes that every developer knows.

UFW checks every outbound request body against these patterns. Does this string contain something shaped like an API key? Yes or no. That's it. There's no intelligence to outsmart, no model to jailbreak, no prompt injection that gets around it. It's a boolean match. It either looks like a key or it doesn't.

And it runs in about a millisecond because pattern matching is one of the cheapest operations a computer can do. Your agent doesn't slow down. Your costs don't go up. It just works, quietly, every single time.

**This is where the community comes in.** The patterns we ship are a starting point — common API keys, passwords, private keys. But the world keeps making new things to catch. QR code payloads. Weird encoding tricks. New provider key formats. Irregular stuff nobody's thought of yet. Every pattern someone contributes makes every UFW deployment safer. Fork it, add your patterns, open a PR. The more eyes on this, the better it gets for everyone.

Old-school regex stopping the smartest machines on the planet. Sometimes the simple thing is the right thing.

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

## Secret Scanning Patterns

When you set `SCAN_PATTERNS`, paste a JSON list of patterns to watch for:

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

**Pro tip:** Plant a fake secret like `HONEYPOT_CANARY_ABC123` in your agent's environment. If it ever shows up in a request, you'll know something is seriously wrong. It's a tripwire.

## Check On Things

```bash
# Health check
curl -X POST https://your-worker.workers.dev/admin/test \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# See usage stats (last 24 hours)
curl https://your-worker.workers.dev/admin/stats \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# See what got blocked
curl https://your-worker.workers.dev/admin/blocks \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

## Good to Know

- **Rate limits are approximate**, not exact to the millisecond. Close enough for protecting a budget, not designed for billing-grade precision.
- **Pattern scanning catches known formats.** If a secret is encoded or split across fields, it won't catch it. That's on purpose — no false positives, no guessing.
- **The proxy token is a shared secret.** One token for all your agents. Simple. If you need per-agent auth later, it's easy to add.

## Need Help?

Paste this entire README into Claude, ChatGPT, or whatever AI you've got and tell it to set this up for you. It'll walk you through every step — that's literally what it's for.

Want it managed instead — hosted dashboard, team support, no setup? Drop your email at [cerul.org](https://cerul.org).

## License

MIT. Use it however you want.

Built for [ClawBot](https://github.com/Fruitloop24) and anyone else who wants to experiment with AI agents without losing sleep over leaked keys and runaway bills.
