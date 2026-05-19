# Perplexity Space — MCP Server Setup

Connecting Perplexity Space to the perp-orchestrator SSE endpoint so 
Perplexity can call MCP tools directly from the thread.

---

## Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| MCP server HTTP/SSE mode | ✅ Ready | `localhost:8766/sse` returns 200 |
| Cloudflare tunnel running | ✅ Active | PID confirmed, 4 HA connections |
| `webhook.plagfix.com` | ⚠️ Routes to `:8765` | Wrong port — webhook server, not MCP |
| MCP SSE exposed externally | ❌ Not yet | Needs new ingress rule + DNS CNAME |

**Blocker:** The existing tunnel only exposes `:8765`. MCP SSE runs on `:8766` and needs its own hostname.

---

## Step 1 — Expose MCP SSE via Cloudflare Tunnel

### Option A: Named hostname on plagfix.com (recommended, permanent)

**1a. Add DNS CNAME in Cloudflare dashboard:**
```
Type:    CNAME
Name:    mcp          (→ mcp.plagfix.com)
Target:  992bd692-8e97-43a5-a2c3-c9f69a31b0ae.cfargotunnel.com
Proxy:   ✅ Proxied (orange cloud)
```

**1b. Add ingress rule to `~/.cloudflared/config.yml`:**
```yaml
tunnel: 992bd692-8e97-43a5-a2c3-c9f69a31b0ae
credentials-file: /Users/eugene/.cloudflared/992bd692-8e97-43a5-a2c3-c9f69a31b0ae.json

ingress:
  - hostname: webhook.plagfix.com
    service: http://localhost:8765
  - hostname: mcp.plagfix.com          # ← ADD THIS
    service: http://localhost:8766      # ← perp-orchestrator SSE
  - service: http_status:404
```

**1c. Restart the tunnel:**
```bash
pkill cloudflared
cloudflared tunnel run 992bd692-8e97-43a5-a2c3-c9f69a31b0ae
```

**1d. Verify:**
```bash
curl https://mcp.plagfix.com/health
# Expected: {"status":"ok","server":"perp-orchestrator","transport":"http+sse"}
```

---

### Option B: Quick tunnel (testing only, random URL, not persistent)

```bash
# Start MCP server
node /Users/eugene/CascadeProjects/windsurf-project-4/perp-orchestrator/dist/index.js --transport http &

# Open quick tunnel — note the https://*.trycloudflare.com URL printed
cloudflared tunnel --url http://localhost:8766
```

Use the random URL for Perplexity Space temporarily. Tunnel URL changes every restart.

---

## Step 2 — Add Bearer Token Auth (recommended)

The MCP server currently has no auth. Add via `.env`:

```bash
# In perp-orchestrator/.env:
MCP_API_KEY=your-secret-token-here
```

Then update `src/index.ts` to add auth middleware on the `/sse` and `/messages` routes:

```typescript
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  const expected = `Bearer ${process.env.MCP_API_KEY}`;
  if (process.env.MCP_API_KEY && auth !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});
```

Build after change: `npm run build`

---

## Step 3 — Start MCP Server (HTTP mode)

```bash
cd /Users/eugene/CascadeProjects/windsurf-project-4/perp-orchestrator
nohup node dist/index.js --transport http > /tmp/perp-orchestrator-http.log 2>&1 &
echo $! > /tmp/perp-orchestrator-http.pid
echo "Started PID: $(cat /tmp/perp-orchestrator-http.pid)"
```

Verify:
```bash
curl https://mcp.plagfix.com/health
# {"status":"ok","server":"perp-orchestrator","transport":"http+sse"}
```

---

## Step 4 — Perplexity Space Configuration

In Perplexity Space settings → **MCP Servers** → **Add**:

| Field | Value |
|-------|-------|
| **Name** | `perp-orchestrator` |
| **URL** | `https://mcp.plagfix.com/sse` |
| **Transport** | SSE |
| **Auth type** | Bearer token (if enabled) |
| **Token** | value of `MCP_API_KEY` |

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
curl -N -H "Accept: text/event-stream" https://mcp.plagfix.com/sse &

# The SSE stream emits:
# event: endpoint
# data: /messages?sessionId=<SESSION_ID>

# Initialize
curl -X POST "https://mcp.plagfix.com/messages?sessionId=<SESSION_ID>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{},"clientInfo":{"name":"test","version":"1"},"protocolVersion":"2024-11-05"}}'

# Call a tool
curl -X POST "https://mcp.plagfix.com/messages?sessionId=<SESSION_ID>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_cascade_targets","arguments":{}}}'
```

---

## Known Limitations

| Limitation | Impact | Mitigation |
|------------|--------|-----------|
| **SSE timeout** | Cloudflare drops idle SSE connections after ~100s | Perplexity reconnects automatically; MCP SDK handles reconnect |
| **No QUIC keepalive for SSE** | `timeout no recent network activity` in tunnel logs | Normal — not a bug, tunnel logs this for QUIC keepalive cycles |
| **Single session model** | `src/index.ts` stores transports in memory — server restart drops all sessions | Restart is rare; sessions reconnect on next tool call |
| **No rate limiting** | Unbounded calls | Add `express-rate-limit` if needed post-Phase 2 |
| **Local-only state** | Dispatch files in `~/CascadeProjects/shared_state/` — not accessible from remote machines | Acceptable for single-machine setup |
| **HTTP only (no HTTPS on 8766)** | TLS terminated at Cloudflare | Fine — end-to-end encryption via tunnel |

---

## Quick Startup Checklist

```bash
# 1. Start MCP server (HTTP mode)
nohup node /Users/eugene/CascadeProjects/windsurf-project-4/perp-orchestrator/dist/index.js \
  --transport http > /tmp/perp-orchestrator-http.log 2>&1 &

# 2. Confirm tunnel is running
pgrep -x cloudflared && echo "tunnel OK" || cloudflared tunnel run 992bd692-8e97-43a5-a2c3-c9f69a31b0ae &

# 3. Health check
curl https://mcp.plagfix.com/health

# 4. In Perplexity Space: connect to https://mcp.plagfix.com/sse
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
