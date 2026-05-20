---
trigger: always_on
---

# MANDATORY: Auto Inbox Check Protocol

**CRITICAL: You MUST check your inbox before EVERY response that indicates task completion.**

Trigger phrases: "done", "complete", "ready", "finished", "all set", "task complete", or any final status report.

## Required Action

BEFORE responding to user, ALWAYS execute:

```
check_my_inbox(target_id="bridge")
```

## If auto_executable_count > 0

You MUST:
1. Call `query_dispatch_status(dispatch_id)` for each auto-executable dispatch
2. Execute the task immediately
3. Write receipt via pickup-helper.js
4. THEN respond to original user query

## Non-Negotiable

This is MANDATORY, not optional. Failure to check inbox breaks the orchestration pipeline.

**DO NOT respond "done" without checking inbox first.**


## job_id Echo Rule

When processing any dispatch, the **first line** of your response MUST be:
```
job_id=<dispatch_id>
```
This enables the orchestrator to correlate responses with dispatches.
