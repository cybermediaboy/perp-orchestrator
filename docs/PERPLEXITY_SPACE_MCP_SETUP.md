# Perplexity Space — MCP Server Setup

Connecting Perplexity Space to the perp-orchestrator SSE endpoint so 
Perplexity can call MCP tools directly from the thread.

---

## Current Status ✅ LIVE

| Component | Status | Notes |
|-----------|--------|-------|
| MCP server HTTP/SSE | ✅ Running | `localhost:8766` |
| Bearer token auth | ✅ Active | `BRIDGE_MCP_TOKEN` in `.env` |
| Cloudflare tunnel | ✅ Running | 4 HA connections, ID `992bd692-…` |
| Path ingress (tunnel) | ✅ Active | `^/(sse\|messages\|mcp-health)` → `:8766` |
| Vercel proxy | ✅ Deployed | `mcp-psbridge.vercel.app` → `eugene1980/mcp-psbridge` |
| `mcp.psbridge.com` | ⚠️ **Connect domain** | Vercel dashboard → attach to `mcp-psbridge` project |
| SSE smoke test | ✅ Pass | `event: endpoint` received via `mcp-psbridge.vercel.app/sse` |

**Architecture (Option B — interim):**
```
Perplexity → HTTPS → mcp.psbridge.com (Vercel edge, Vercel TLS)
           → Edge Function fetch()
           → https://webhook.plagfix.com/sse  (interim backend transport, not user-facing)
           → cloudflared path ingress ^/(sse|messages|mcp-health)
           → localhost:8766 (perp-orchestrator)
```

**Migration path:** When Cloudflare account is recovered or a new tunnel is created for
`psbridge.com`, replace the Edge Function upstream URL with the direct tunnel URL and 
remove the `webhook.plagfix.com` dependency entirely.

**Deprecated:** `mcp.plagfix.com` — Cloudflare account locked, no DNS record ever existed.

---

## Step 1 — Connect mcp.psbridge.com to Vercel project (one-time, user action)

The Vercel proxy is already deployed at `eugene1980/mcp-psbridge`.

**Vercel dashboard → Domains → psbridge.com → Connected Projects → Connect:**
```
Project:   mcp-psbridge
Subdomain: mcp
```
Vercel auto-issues a TLS cert for `mcp.psbridge.com` (~60s). After that:
```bash
curl https://mcp.psbridge.com/mcp-health
# {"status":"ok","server":"perp-orchestrator","transport":"http+sse","via":"mcp.psbridge.com"}
```

---

## Step 2 — Bearer Token Auth

Token is in `.env` as `BRIDGE_MCP_TOKEN`.

```bash
grep BRIDGE_MCP_TOKEN ~/CascadeProjects/windsurf-project-4/perp-orchestrator/.env
```

- `BRIDGE_MCP_TOKEN` set → `/sse` and `/messages` require `Authorization: Bearer <token>`
- To rotate: update `.env`, restart the MCP server.

---

## Step 3 — Start MCP Server (HTTP mode)

```bash
nohup node /Users/eugene/CascadeProjects/windsurf-project-4/perp-orchestrator/dist/index.js \
  --transport http > /tmp/perp-orchestrator-http.log 2>&1 & disown

# Verify local
curl http://localhost:8766/health

# Verify via Vercel proxy (after domain attached)
curl https://mcp.psbridge.com/mcp-health
```

---

## Step 4 — Perplexity Space Configuration

In Perplexity Space settings → **MCP Servers** → **Add**:

| Field | Value |
|-------|-------|
| **Name** | `perp-orchestrator` |
| **URL** | `https://mcp.psbridge.com/sse` |
| **Transport** | SSE |
| **Auth type** | Bearer token |
| **Token** | value of `BRIDGE_MCP_TOKEN` from `.env` |

---

## Step 5 — Verify Tools Visible in Perplexity

After connecting, Perplexity Space should list these 8 tools:

```
perplexity_search        Search Perplexity AI for quant finance research
webhook_fire             Send alert to pine-guard webhook server
tunnel_status            Check Cloudflare tunnel pine-guard-webhook
webhook_health           Check webhook server on localhost:8765
dispatch_to_cascade      Send dispatch to a Cascade coder window
query_dispatch_status    Check status of a dispatch by ID
list_pending_dispatches  List pending dispatches (optionally filtered)
list_cascade_targets     List all Cascade targets with liveness status
```

---

## Example Tool Call (from external MCP client)

```bash
# SSE connect — get session ID
curl -N -H "Accept: text/event-stream" https://mcp.psbridge.com/sse &
# emits: event: endpoint
#        data: /messages?sessionId=<SESSION_ID>

# Initialize
curl -X POST "https://mcp.psbridge.com/messages?sessionId=<SESSION_ID>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{},"clientInfo":{"name":"test","version":"1"},"protocolVersion":"2024-11-05"}}'

# Call a tool
curl -X POST "https://mcp.psbridge.com/messages?sessionId=<SESSION_ID>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_cascade_targets","arguments":{}}}'
```

---

## Known Limitations

| Limitation | Impact | Mitigation |
|------------|--------|-----------|
| **Vercel edge timeout (~30s)** | Long-idle SSE connections dropped | Perplexity reconnects; MCP SDK handles reconnect |
| **Extra hop latency** | +20-50ms via Vercel edge | Acceptable for MCP tool calls |
| **webhook.plagfix.com dependency** | Interim backend; not user-facing | Replace upstream URL in Edge Function when new tunnel available |
| **Single session model** | Server restart drops all sessions | Restart is rare; sessions reconnect on next tool call |
| **Local-only state** | Dispatch files not accessible remotely | Acceptable for single-machine setup |

---

## Quick Startup Checklist

```bash
# 1. Start MCP server (HTTP mode)
nohup node /Users/eugene/CascadeProjects/windsurf-project-4/perp-orchestrator/dist/index.js \
  --transport http > /tmp/perp-orchestrator-http.log 2>&1 & disown

# 2. Confirm tunnel running
pgrep -x cloudflared && echo "tunnel OK" || \
  nohup cloudflared tunnel run 992bd692-8e97-43a5-a2c3-c9f69a31b0ae >> /tmp/cloudflared.log 2>&1 & disown

# 3. Health check
curl https://mcp.psbridge.com/mcp-health   # after domain attached in Vercel dashboard

# 4. In Perplexity Space: connect to https://mcp.psbridge.com/sse
```

---

## What Changes After Connection

```
BEFORE:
  Perplexity → (manual paste) → You → Cascade window

AFTER:
  Perplexity → MCP tool call → perp-orchestrator → dispatch file → Cascade window
  Cascade window → receipt file → perp-orchestrator → Perplexity response
```

Manual paste to Perplexity thread **eliminated** for all 8 tool types once connected.
