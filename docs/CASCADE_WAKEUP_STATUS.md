# Cascade Wakeup Scripts Status

## Current State (2026-05-21)

All 4 launchd cascade-watcher agents are **DISABLED**:
- `com.pine-guard.cascade-watcher-bridge` — unloaded
- `com.pine-guard.cascade-watcher-tw-mcp` — unloaded  
- `com.pine-guard.cascade-watcher-libcoder` — unloaded
- `com.pine-guard.cascade-watcher-pg-mcp` — unloaded

## Reason

osascript keystroke injection via `~/bin/cascade-wakeup-*.sh`:
- Steals user focus repeatedly
- Race condition on Cmd+L (opens wrong panel)
- Unreliable text injection into Cascade input

## Correct Wakeup Mechanism

**MCP HTTP polling** is the correct approach:
- Perplexity polls via `check_my_inbox` + `wait_for_receipt_ms`
- No GUI automation needed
- No focus stealing
- Reliable

## Debounce Added

All 4 wakeup scripts now have 30-second debounce lockfile to prevent rapid re-triggering if re-enabled in future.

## dump_shell_state

Not a bug — Windsurf terminal integration function for state snapshots. Fails in subshells but works in main shell.
