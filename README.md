# perp-orchestrator

**Scope: MCP transport bridge only.**

This project is the bridge MCP server providing:
- Perplexity AI search (`perplexity_search`)
- Webhook alert dispatch (`webhook_fire`, `webhook_health`)
- Cloudflare tunnel status (`tunnel_status`)
- Cascade window dispatch system (`dispatch_to_cascade`, `query_dispatch_status`)
- Identity management for multi-window Cascade sessions

## DS_INJECT pine-uploader

DS_INJECT pine-uploader has been moved to `~/bin/tradingview-mcp` (TW MCP coder's project).

- Archive of Bridge's reference implementation: tag `ds-inject-perp-archive-2026-05-20`
- Hand-off design notes: `/tmp/bridge_donation_notes.md`
- Canonical implementation: `~/bin/tradingview-mcp/src/pine_uploader.js`

## Start

```bash
# MCP bridge (stdio, default)
npm start

# MCP bridge (HTTP+SSE on :8766)
npm run start:http

# Cascade identity daemon
npm run start:identity

# Dispatch poller
npm run start:poller
```
