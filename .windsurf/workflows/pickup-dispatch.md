---
description: Pick up and execute a pending dispatch for this Cascade window
---

# Pickup Dispatch Workflow

This workflow is installed in each Cascade coder workspace.
Replace `TARGET_ID` with this window's target (tw-mcp, libcoder, researcher, trajectory).
Replace `PICKUP_HELPER` with the absolute path to pickup-helper.js.

## Steps

1. Check for pending dispatch
// turbo
node /Users/eugene/CascadeProjects/windsurf-project-4/perp-orchestrator/scripts/pickup-helper.js --target TARGET_ID --check

2. If NO_DISPATCH printed above: stop here. Otherwise read full dispatch:
// turbo
node /Users/eugene/CascadeProjects/windsurf-project-4/perp-orchestrator/scripts/pickup-helper.js --target TARGET_ID --read

3. Check requires_approval flag:
   - If dispatch shows `requires_approval: false` → proceed directly to step 4 (auto-execute)
   - If `requires_approval: true` OR undefined → ask user: "Execute this dispatch? (y/n)"
     - If user says no → go to step 6 (reject)
     - If user says yes → proceed to step 4

4. Execute the dispatch body (printed above) as your next Cascade task. Note the DISPATCH_ID from the output.

5. After execution is complete, write the receipt:
// turbo
node /Users/eugene/CascadeProjects/windsurf-project-4/perp-orchestrator/scripts/pickup-helper.js --target TARGET_ID --write-receipt --dispatch-id DISPATCH_ID --status complete --response "Brief summary of what was done"

6. If execution failed, write rejection receipt instead:
// turbo
node /Users/eugene/CascadeProjects/windsurf-project-4/perp-orchestrator/scripts/pickup-helper.js --target TARGET_ID --reject --dispatch-id DISPATCH_ID --error "Reason for failure"
