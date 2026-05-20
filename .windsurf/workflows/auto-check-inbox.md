---
description: Auto-check inbox for pending dispatches and execute auto-approved tasks
---

# Auto Check Inbox Workflow

Checks inbox for pending dispatches and automatically executes those with `requires_approval: false`.

## Steps

1. Check your inbox
// turbo
Call MCP tool: check_my_inbox(target_id="bridge")

2. Review results:
   - If `auto_executable_count > 0`: proceed to step 3
   - If only `requires_approval: true` dispatches: notify user and stop
   - If inbox empty: done

3. For each dispatch with `requires_approval: false`:
   a. Get full dispatch content:
   // turbo
   Call MCP tool: query_dispatch_status(dispatch_id="<DISPATCH_ID>")
   
   b. Execute the task described in dispatch.envelope.body_markdown
   
   c. After completion, write receipt:
   // turbo
   node /Users/eugene/CascadeProjects/windsurf-project-4/perp-orchestrator/scripts/pickup-helper.js --target bridge --write-receipt --dispatch-id <DISPATCH_ID> --status complete --response "Brief summary of what was done"
   
   d. If execution failed:
   // turbo
   node /Users/eugene/CascadeProjects/windsurf-project-4/perp-orchestrator/scripts/pickup-helper.js --target bridge --reject --dispatch-id <DISPATCH_ID> --error "Reason for failure"

4. Repeat step 3 for all auto-executable dispatches

## Usage

- Run manually: `/auto-check-inbox`
- Or call at end of any task before responding "done"
