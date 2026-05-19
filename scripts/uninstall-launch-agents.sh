#!/bin/bash
# uninstall-launch-agents.sh — remove cascade-identity launchd agents
#
# Usage: ./scripts/uninstall-launch-agents.sh [--keep-logs]
#
# Does NOT uninstall com.eugene.bridge-identity (bridge's own agent).

AGENTS_DIR="$HOME/Library/LaunchAgents"
TARGETS_DIR="${TARGETS_DIR:-$HOME/CascadeProjects/shared_state/targets}"
KEEP_LOGS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --keep-logs) KEEP_LOGS=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

LABELS=(
  "com.cascade-identity.tw-mcp"
  "com.cascade-identity.pg-mcp"
  "com.cascade-identity.libcoder"
)

echo "=== cascade-identity LaunchAgent Uninstaller ==="

for LABEL in "${LABELS[@]}"; do
  PLIST="$AGENTS_DIR/$LABEL.plist"
  TARGET="${LABEL#com.cascade-identity.}"

  # Unload
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null && echo "  unloaded $LABEL" || echo "  (not loaded) $LABEL"
    rm -f "$PLIST"
    echo "  removed $PLIST"
  else
    echo "  (not installed) $LABEL"
  fi

  # Mark identity offline (set last_seen to epoch)
  IDENTITY_FILE="$TARGETS_DIR/$TARGET.identity.json"
  if [ -f "$IDENTITY_FILE" ]; then
    python3 -c "
import json
d = json.load(open('$IDENTITY_FILE'))
d['last_seen'] = '1970-01-01T00:00:00.000Z'
open('$IDENTITY_FILE', 'w').write(json.dumps(d, indent=2))
" 2>/dev/null && echo "  marked $TARGET offline"
  fi

  # Remove logs (unless --keep-logs)
  if [ "$KEEP_LOGS" = false ]; then
    rm -f "$HOME/Library/Logs/cascade-identity-${TARGET}.log"
  fi
done

echo ""
echo "=== Uninstall complete. Bridge agent (com.eugene.bridge-identity) unchanged. ==="
echo "To reinstall: ./scripts/install-launch-agents.sh"
