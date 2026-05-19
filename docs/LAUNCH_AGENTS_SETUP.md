# cascade-identity LaunchAgents Setup

Runs all four cascade-identity daemons as persistent macOS LaunchAgents.
No more foreground terminals required. Survives reboots, auto-restarts on crash.

---

## Why LaunchAgents

| Approach | Problem |
|----------|---------|
| Foreground terminal (`./start-identity.sh`) | Blocks Cascade session; can't run tool calls while daemon runs |
| `nohup` background | Dies on shell exit (SIGHUP) |
| **launchd LaunchAgent** | ✅ Persistent, auto-restarts, login-scoped, no terminal needed |

---

## Agents

| Label | Target | Workspace | Log |
|-------|--------|-----------|-----|
| `com.eugene.bridge-identity` | bridge | `perp-orchestrator/` | `/tmp/bridge-identity.log` |
| `com.cascade-identity.tw-mcp` | tw-mcp | `~/CascadeProjects/tw-mcp` | `~/Library/Logs/cascade-identity-tw-mcp.log` |
| `com.cascade-identity.pg-mcp` | pg-mcp | `~/bin/pine-guard-mcp` | `~/Library/Logs/cascade-identity-pg-mcp.log` |
| `com.cascade-identity.libcoder` | libcoder | `~/CascadeProjects/windsurf-project-3` | `~/Library/Logs/cascade-identity-libcoder.log` |

---

## Install

```bash
cd ~/CascadeProjects/windsurf-project-4/perp-orchestrator
./scripts/install-launch-agents.sh
```

With custom workspace paths:
```bash
./scripts/install-launch-agents.sh \
  --tw-mcp /path/to/tw-mcp-workspace \
  --pg-mcp /path/to/pg-mcp-workspace \
  --libcoder /path/to/libcoder-workspace
```

Expected output:
```
=== cascade-identity LaunchAgent Installer ===
  ✅  loaded com.cascade-identity.tw-mcp
  ✅  loaded com.cascade-identity.pg-mcp
  ✅  loaded com.cascade-identity.libcoder
  ✅  tw-mcp — pid=XXXXX age=2s
  ✅  pg-mcp — pid=XXXXX age=2s
  ✅  libcoder — pid=XXXXX age=2s
  ✅  bridge — pid=XXXXX age=Xs
=== 4 alive / 0 failed ===
ALL PASS ✅
```

---

## Verify

```bash
# Quick status from launchd
launchctl list | grep cascade-identity

# Full liveness check
python3 -c "
import json, glob, datetime, os
for f in sorted(glob.glob(os.path.expanduser('~/CascadeProjects/shared_state/targets/*.json'))):
    d = json.load(open(f))
    age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(d['last_seen'].replace('Z','+00:00'))).total_seconds()
    alive = '✅' if age < 90 else '❌'
    print(f'{alive} {d[\"target_id\"]:12} pid={d[\"pid\"]} age={age:.0f}s')
"
```

---

## Uninstall

```bash
./scripts/uninstall-launch-agents.sh           # also removes logs
./scripts/uninstall-launch-agents.sh --keep-logs
```

Does NOT remove `com.eugene.bridge-identity` (bridge's own agent).

---

## Edge Cases

**Workspace path changed:**
```bash
./scripts/install-launch-agents.sh --tw-mcp /new/path
# Unloads old agent, loads new one with updated path
```

**Accidental manual daemon running alongside launchd agent:**
Last-writer-wins per `cascade-identity.ts` conflict resolution. The conflict warning is logged but harmless. Stop the manual daemon — launchd one takes over.

**Check logs after failure:**
```bash
tail -f ~/Library/Logs/cascade-identity-tw-mcp.log
tail -f ~/Library/Logs/cascade-identity-pg-mcp.log
tail -f ~/Library/Logs/cascade-identity-libcoder.log
tail -f /tmp/bridge-identity.log
```

**Reboot:**
All agents start automatically at next login (`RunAtLoad=true`).
