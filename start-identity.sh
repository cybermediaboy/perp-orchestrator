#!/bin/bash
# Start identity heartbeat daemon for bridge Cascade window
# Run once per session in this workspace terminal
exec node /Users/eugene/CascadeProjects/windsurf-project-4/perp-orchestrator/dist/cascade-identity.js \
  --target bridge \
  --workspace /Users/eugene/CascadeProjects/windsurf-project-4/perp-orchestrator
