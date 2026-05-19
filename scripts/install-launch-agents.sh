#!/bin/bash
# install-launch-agents.sh — install cascade-identity launchd agents
#
# Usage:
#   ./scripts/install-launch-agents.sh
#   ./scripts/install-launch-agents.sh --tw-mcp /custom/path/tw-mcp \
#                                       --pg-mcp /custom/path/pg-mcp \
#                                       --libcoder /custom/path/windsurf-project-3
#
# Installs RunAtLoad+KeepAlive launchd agents for tw-mcp, pg-mcp, libcoder.
# Bridge agent (com.eugene.bridge-identity) is managed separately.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PERP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCHD_DIR="$SCRIPT_DIR/launchd"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs"

SHARED_STATE_DIR="${SHARED_STATE_DIR:-$HOME/CascadeProjects/shared_state/dispatches}"
TARGETS_DIR="${TARGETS_DIR:-$HOME/CascadeProjects/shared_state/targets}"

# ─── Default workspace paths ─────────────────────────────────────────────────

TW_MCP_WORKSPACE="$HOME/CascadeProjects/tw-mcp"
PG_MCP_WORKSPACE="$HOME/bin/pine-guard-mcp"
LIBCODER_WORKSPACE="$HOME/CascadeProjects/windsurf-project-3"

# ─── Parse optional overrides ────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    --tw-mcp)    TW_MCP_WORKSPACE="$2";  shift 2 ;;
    --pg-mcp)    PG_MCP_WORKSPACE="$2";  shift 2 ;;
    --libcoder)  LIBCODER_WORKSPACE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "=== cascade-identity LaunchAgent Installer ==="
echo "  perp-orchestrator: $PERP_DIR"
echo "  tw-mcp workspace:  $TW_MCP_WORKSPACE"
echo "  pg-mcp workspace:  $PG_MCP_WORKSPACE"
echo "  libcoder workspace:$LIBCODER_WORKSPACE"
echo "  shared_state:      $SHARED_STATE_DIR"
echo "  targets:           $TARGETS_DIR"
echo ""

mkdir -p "$AGENTS_DIR" "$LOG_DIR"

# ─── install_agent <label> <template> <workspace> ────────────────────────────

install_agent() {
  local LABEL="$1"
  local TEMPLATE="$LAUNCHD_DIR/$LABEL.plist"
  local WORKSPACE="$2"
  local DEST="$AGENTS_DIR/$LABEL.plist"

  if [ ! -f "$TEMPLATE" ]; then
    echo "ERROR: template not found: $TEMPLATE"
    return 1
  fi

  # Substitute placeholders
  sed \
    -e "s|PERP_ORCHESTRATOR_DIR|$PERP_DIR|g" \
    -e "s|WORKSPACE_PATH|$WORKSPACE|g" \
    -e "s|SHARED_STATE_DIR|$SHARED_STATE_DIR|g" \
    -e "s|TARGETS_DIR|$TARGETS_DIR|g" \
    -e "s|LOG_DIR|$LOG_DIR|g" \
    "$TEMPLATE" > "$DEST"

  # Unload if already loaded (ignore error)
  launchctl unload "$DEST" 2>/dev/null || true

  # Load
  launchctl load "$DEST"
  echo "  ✅  loaded $LABEL"
}

echo "Installing agents..."
install_agent "com.cascade-identity.tw-mcp"  "$TW_MCP_WORKSPACE"
install_agent "com.cascade-identity.pg-mcp"  "$PG_MCP_WORKSPACE"
install_agent "com.cascade-identity.libcoder" "$LIBCODER_WORKSPACE"

echo ""
echo "Waiting for heartbeats..."
sleep 2

# ─── Verify ──────────────────────────────────────────────────────────────────

PASS=0; FAIL=0

check_alive() {
  local TARGET="$1"
  local IDENTITY_FILE="$TARGETS_DIR/$TARGET.identity.json"

  if [ ! -f "$IDENTITY_FILE" ]; then
    echo "  ❌  $TARGET — identity file missing"
    FAIL=$((FAIL+1))
    return
  fi

  AGE=$(python3 -c "
import json, datetime, sys
d = json.load(open('$IDENTITY_FILE'))
age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(d['last_seen'].replace('Z','+00:00'))).total_seconds()
print(f'{age:.0f}')
" 2>/dev/null || echo "999")

  if [ "$AGE" -lt 90 ]; then
    PID=$(python3 -c "import json; print(json.load(open('$IDENTITY_FILE'))['pid'])" 2>/dev/null)
    echo "  ✅  $TARGET — pid=$PID age=${AGE}s"
    PASS=$((PASS+1))
  else
    echo "  ❌  $TARGET — identity stale (age=${AGE}s)"
    FAIL=$((FAIL+1))
  fi
}

check_alive "tw-mcp"
check_alive "pg-mcp"
check_alive "libcoder"
# Bridge is managed by separate agent (com.eugene.bridge-identity)
check_alive "bridge"

echo ""
echo "=== $PASS alive / $FAIL failed ==="
[ "$FAIL" -eq 0 ] && echo "ALL PASS ✅ — all session-scoped daemons launchd-managed" || echo "FAILURES ❌ — check ~/Library/Logs/cascade-identity-*.log"
