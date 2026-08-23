# Specialist Agent Tools

Three tools manage specialist task delegation. Which ones apply to you depends
on how you were invoked.

## Am I running as a specialist?

Check your triggering message. If it contains a `specialistTaskId` attribute,
you are running as a **specialist agent** for that task.

These instructions govern **how you deliver your result** (use
`deliver_specialist_result`, not `send_message`). **What work you do** is
defined by your `CLAUDE.local.md` — follow that workflow exactly.

If the message has a `completedSpecialistTaskId` attribute instead, a task you
previously dispatched has completed — its result is the message text. Read it
and continue your own work.

## As a specialist agent (specialistTaskId present)

You were dispatched to complete a specific task and must deliver your result
via `deliver_specialist_result`. **Do not use `send_message` or any other
messaging tool for your final answer** — the result will not reach the
requester.

### Workflow

1. **Do the work.** Use available tools to complete the assigned task.

2. **Deliver the result.** When done, call:
   ```
   deliver_specialist_result(result_text="Your complete answer here.")
   ```
   This is the last tool call you make. The host routes your result to whoever
   requested you and the container exits.

   **Delivering files:** If your work produced files, include them:
   ```
   deliver_specialist_result(
     result_text="Summary of results. See attached file(s).",
     file_paths=["/workspace/ipc-out/report.md", "/workspace/ipc-out/data.csv"]
   )
   ```
   Files must be written to `/workspace/ipc-out/` before delivery. The host
   takes ownership and routes them to the requester's next invocation via
   `/workspace/ipc-in/<transfer_id>/<filename>`. For root tasks only, pass
   `commit_to_memory=True` to copy files into the requester group's
   `memory/reports/` area instead.

3. **If you cannot complete the task**, still call `deliver_specialist_result`
   with an explanation of what you attempted and why it failed. Never exit
   without calling it.

### Delegating to another specialist (optional)

If part of your task requires capabilities from a different specialist, you can
delegate a sub-task:

```
dispatch_sub_task(
  specialist_group_id="<id>",
  prompt="Description of what you need."
)
```

After calling this, end your turn immediately. When the sub-task completes,
its result will be injected into your next invocation and you can continue.

Chain limits apply: depth, total delegations, and same-specialist-type repeat
counts are enforced by the host. If a dispatch is rejected, the refusal is
explained in the tool response.

## As the main agent (no specialistTaskId)

You can dispatch root specialist tasks:

```
dispatch_specialist(
  specialist_group_id="<id>",
  prompt="Description of the task."
)
```

The specialist runs in its own container session. When it calls
`deliver_specialist_result`, the host routes the result back to your session
as a follow-up message. Only the main agent group may call this tool — the
host will reject it from any other group.
