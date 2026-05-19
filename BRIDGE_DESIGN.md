# Bridge Option A Design Specification

**Status:** 🟡 DESIGN PHASE — Implementation queued post-Phase 1.5  
**Build trigger:** T5-prod PASS + TW MCP Phase 5 + LibCoder Phase 3 Module 6 complete  
**ETA at build start:** 2-3h implementation + 30min validation

---

## Architecture Overview

```
Perplexity Orchestrator (external)
  ↓ HTTPS/SSE via Cloudflare tunnel
perp-orchestrator MCP (:8766 HTTP mode)
  ↓ writes dispatch JSON
~/CascadeProjects/shared_state/dispatches/inbox/
  ↓ Cascade polls (1-2s interval)
Windsurf Cascade (target coder)
  ↓ processes, writes receipt
~/CascadeProjects/shared_state/dispatches/receipts/
  ↓ perp-orchestrator polls (1-2s)
Response back to Perplexity
```

---

## Directory Schema

```
~/CascadeProjects/shared_state/
  dispatches/
    inbox/           ← perp-orchestrator writes new dispatches here
    processing/      ← Cascade moves dispatch here when picked up
    receipts/        ← Cascade writes ACK/response here
    failed/          ← Errors/timeouts moved here
    archive/         ← Completed dispatches (optional, for audit)
```

**File naming convention:**
- Dispatch: `dispatch_<timestamp>_<uuid>.json`
- Receipt: `receipt_<dispatch_uuid>_<timestamp>.json`

**Permissions:** 0644 (read/write for user, read for group/other)

---

## Dispatch Envelope Schema

```json
{
  "dispatch_id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-05-19T09:29:00.000Z",
  "source": "orchestrator",
  "target": "tw-mcp" | "libcoder" | "researcher" | "trajectory" | "bridge",
  "priority": "urgent" | "normal" | "low",
  "supersedes": "previous-dispatch-id-if-any",
  "envelope": {
    "type": "command" | "query" | "info",
    "body_markdown": "Fix compilation error in REOS_v5.8.2.pine line 42:\nundefined variable `ltf_ema_fast`",
    "context": {
      "file": "REOS_v5.8.2.pine",
      "line": 42,
      "severity": "error",
      "metadata": {}
    }
  },
  "expects_ack": true,
  "ttl_seconds": 300,
  "reply_to": "perplexity-thread-abc123"
}
```

**Field definitions:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `dispatch_id` | UUID | ✅ | Unique identifier for this dispatch |
| `timestamp` | ISO8601 | ✅ | Creation time (UTC) |
| `source` | string | ✅ | Origin: "orchestrator", "perplexity", "manual" |
| `target` | enum | ✅ | Destination coder window |
| `priority` | enum | ✅ | "urgent" (immediate), "normal" (queue), "low" (batch) |
| `supersedes` | UUID | ❌ | If set, cancels previous dispatch |
| `envelope.type` | enum | ✅ | "command" (action), "query" (question), "info" (FYI) |
| `envelope.body_markdown` | string | ✅ | Main message content |
| `envelope.context` | object | ❌ | Additional metadata |
| `expects_ack` | boolean | ✅ | If true, wait for receipt |
| `ttl_seconds` | number | ❌ | Timeout (default: 300s) |
| `reply_to` | string | ❌ | Return address for async response |

---

## Receipt Schema

```json
{
  "receipt_id": "660e8400-e29b-41d4-a716-446655440001",
  "dispatch_id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-05-19T09:29:15.000Z",
  "responder": "tw-mcp",
  "status": "received" | "processing" | "complete" | "rejected" | "timeout",
  "response_body_markdown": "✅ Fixed: Added `ltf_ema_fast = ta.ema(close, ltf_length)` at line 38.\nValidation: pine-guard PASS, no blockers.",
  "error": null,
  "processing_time_ms": 15234,
  "metadata": {
    "files_modified": ["REOS_v5.8.2.pine"],
    "validation_result": "ok"
  }
}
```

**Status lifecycle:**
1. `received` — Cascade picked up dispatch, moved to processing/
2. `processing` — Work in progress
3. `complete` — Success, response included
4. `rejected` — Cascade refused (e.g., invalid target, busy)
5. `timeout` — TTL expired, no response

---

## Polling Configuration

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| **Inbox poll interval** | 1-2s | Balance responsiveness vs CPU |
| **Receipt poll interval** | 1-2s | Same as inbox |
| **Orphan sweep interval** | 60s | Cleanup stale dispatches |
| **Receipt retention** | 24h | Archive after 1 day |
| **Failed dispatch retention** | 7d | Debug window |

**Configurable via `.env`:**
```bash
DISPATCH_INBOX_POLL_MS=1500
DISPATCH_RECEIPT_POLL_MS=1500
DISPATCH_ORPHAN_SWEEP_MS=60000
DISPATCH_RECEIPT_RETENTION_HOURS=24
```

---

## Failure Handling

### Retry Policy
- **Transient errors:** 3 retries with exponential backoff (1s, 2s, 4s)
- **Permanent errors:** Move to `failed/` immediately
- **Timeout:** After TTL expires, move to `failed/`, write timeout receipt

### Dead Letter Queue (DLQ)
- Location: `~/CascadeProjects/shared_state/dispatches/failed/`
- Contains: Original dispatch + error metadata
- Retention: 7 days
- Manual recovery: Move back to `inbox/` to retry

### Orphan Detection
- **Orphan dispatch:** In `processing/` >TTL with no receipt
- **Action:** Move to `failed/`, log warning
- **Sweep frequency:** Every 60s

### Stale Receipt Warning
- **Condition:** Receipt timestamp >TTL after dispatch timestamp
- **Action:** Log warning, mark as "late receipt"
- **No auto-action:** Receipt still valid, just slow

---

## Target Definitions

| Target ID | Description | Typical Use |
|-----------|-------------|-------------|
| `tw-mcp` | TradingView MCP coder | Pine Script edits, chart ops |
| `libcoder` | Library coder | L0/L1/L2 library development |
| `researcher` | Research assistant | Perplexity queries, docs |
| `trajectory` | Trajectory searcher | Conversation history search |
| `bridge` | Bridge itself | Health checks, config |

**Discovery:** `list_cascade_targets()` tool returns available targets with status.

---

## New MCP Tools (perp-orchestrator)

### 1. `dispatch_to_cascade`

```typescript
dispatch_to_cascade(
  target: "tw-mcp" | "libcoder" | "researcher" | "trajectory" | "bridge",
  message: string,
  priority?: "urgent" | "normal" | "low",
  context?: object,
  expects_ack?: boolean,
  ttl_seconds?: number
) → {
  dispatch_id: string,
  status: "queued" | "rejected",
  eta_seconds?: number
}
```

**Behavior:**
1. Generate UUID for `dispatch_id`
2. Create dispatch JSON with envelope
3. Write to `inbox/dispatch_<timestamp>_<uuid>.json`
4. If `expects_ack=true`, start polling `receipts/` for matching receipt
5. Return dispatch_id immediately (async)

### 2. `query_dispatch_status`

```typescript
query_dispatch_status(
  dispatch_id: string
) → {
  dispatch_id: string,
  status: "queued" | "processing" | "complete" | "rejected" | "timeout" | "not_found",
  receipt?: Receipt,
  age_seconds: number
}
```

**Behavior:**
1. Check `inbox/` for queued
2. Check `processing/` for in-progress
3. Check `receipts/` for complete
4. Check `failed/` for timeout/rejected
5. Return current status + receipt if available

### 3. `list_pending_dispatches`

```typescript
list_pending_dispatches(
  target?: string,
  priority?: string
) → {
  count: number,
  dispatches: Array<{
    dispatch_id: string,
    target: string,
    priority: string,
    age_seconds: number,
    status: "queued" | "processing"
  }>
}
```

**Behavior:**
1. Scan `inbox/` and `processing/`
2. Filter by target/priority if specified
3. Return summary list

### 4. `list_cascade_targets`

```typescript
list_cascade_targets() → {
  targets: Array<{
    target_id: string,
    description: string,
    status: "available" | "busy" | "offline",
    pending_count: number,
    last_seen?: string
  }>
}
```

**Behavior:**
1. Return hardcoded target list
2. Check `processing/` for pending count per target
3. Infer status from recent receipt timestamps

---

## Cascade Workflow Integration

Create `.windsurf/workflows/check-dispatches.md`:

```markdown
---
description: Poll dispatch inbox and process messages
---

1. Check for new dispatches
// turbo
python ~/bin/cascade-dispatch-poller.py --check-inbox

2. If dispatch found, move to processing and execute
// turbo
python ~/bin/cascade-dispatch-poller.py --process

3. Write receipt
// turbo
python ~/bin/cascade-dispatch-poller.py --write-receipt
```

**Alternative:** Background daemon process (Node.js/Python) that polls and executes.

---

## Test Plan (Post-Phase 1.5)

### Phase 1: Echo Test
1. Create mock `echo-coder` target
2. Dispatch: "HEALTH-CHECK ping"
3. Echo-coder writes receipt: "PONG"
4. Verify round-trip <5s

### Phase 2: TW MCP Test
1. Dispatch to `tw-mcp`: "Get chart state"
2. TW MCP executes `chart_get_state()`
3. Receipt includes JSON response
4. Verify success

### Phase 3: Error Handling
1. Dispatch to offline target
2. Verify timeout → `failed/`
3. Dispatch with invalid JSON
4. Verify rejection receipt

### Phase 4: Load Test
1. Send 10 dispatches in 1s
2. Verify all processed
3. Check for race conditions

### Phase 5: Supersede Test
1. Send dispatch A
2. Send dispatch B with `supersedes: A`
3. Verify A cancelled, B processed

---

## Implementation Checklist

**perp-orchestrator changes:**
- [ ] Add `src/tools/dispatch.ts` with 4 new tools
- [ ] Add `src/lib/dispatch-manager.ts` for file I/O
- [ ] Add polling logic for receipts
- [ ] Add orphan sweep background task
- [ ] Update `src/index.ts` to register new tools
- [ ] Add `.env` config for polling intervals

**Cascade integration:**
- [ ] Create `~/bin/cascade-dispatch-poller.py` (or .js)
- [ ] Add `.windsurf/workflows/check-dispatches.md`
- [ ] Test manual workflow execution
- [ ] Optional: systemd/launchd daemon for auto-polling

**Shared state setup:**
- [ ] Create directory structure
- [ ] Set permissions
- [ ] Add `.gitignore` for `shared_state/`

**Testing:**
- [ ] Echo test
- [ ] TW MCP integration test
- [ ] Error handling test
- [ ] Load test
- [ ] Supersede test

**Documentation:**
- [ ] Update README with dispatch examples
- [ ] Add troubleshooting guide
- [ ] Document receipt schema for coder targets

---

## Build Trigger Conditions

✅ **Ready to build when:**
1. T5-prod manual test verdict: **PASS**
2. TW MCP Phase 5 closure: **CONFIRMED**
3. LibCoder Phase 3 Module 6: **COMPLETE**
4. Orchestrator dispatch: **BUILD START**

⏱️ **Estimated time:** 2-3h implementation + 30min validation

---

## Known Limitations

1. **No inter-MCP communication:** File-based only, no direct MCP-to-MCP
2. **Single Cascade instance:** Can't address multiple Windsurf windows
3. **Polling latency:** 1-2s minimum, not real-time
4. **No encryption:** Files in plaintext (local only, acceptable)
5. **No priority queue:** FIFO processing, priority is metadata only

---

## Future Enhancements (Post-MVP)

- WebSocket transport for real-time (replace polling)
- Priority queue with urgent-first processing
- Multi-workspace support (address different Windsurf instances)
- Encrypted dispatch payloads
- Web UI for dispatch monitoring
- Metrics/observability (Prometheus exporter)

---

**Last updated:** 2026-05-19 09:29 UTC+03:00  
**Status:** Design complete, awaiting build trigger
