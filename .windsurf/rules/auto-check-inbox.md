---
trigger: always_on
---

# Auto Inbox Check Protocol

After completing ANY task and before responding "done"/"complete"/"ready" — ALWAYS call:

```
check_my_inbox(target_id="bridge")
```

If `auto_executable_count > 0`:
- Pickup and execute each dispatch with `requires_approval=false`
- Write receipts using pickup-helper.js
- Then respond to original user query

This is part of definition-of-done, not optional.
