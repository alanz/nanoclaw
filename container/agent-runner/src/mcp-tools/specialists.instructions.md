# Specialist Agent Tools

Three tools manage specialist task delegation. Which ones apply to you depends
on how you were invoked.

## Am I running as a specialist?

Check your triggering message. If it contains a `specialistTaskId` attribute,
you are running as a **specialist agent** for that task.

These instructions govern **how you deliver your result** (use
`deliver_specialist_result`, not `send_message`). **What work you do** is
defined by your standing instructions (`instructions.prepend.md`, the persona
at the top of this document) — follow that workflow exactly.

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
   Files your dispatcher handed you are in `/workspace/ipc-in/` (read-only);
   the end of your prompt lists their paths. They stay there for the whole
   task, including after a sub-task returns.

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
   Files must be written to `/workspace/ipc-out/` before delivery — only files
   there (real files, not symlinks) are taken; anything else is reported back
   as not delivered. To pass on a file you received in `/workspace/ipc-in/`,
   copy it into `/workspace/ipc-out/` first. The host
   takes ownership and routes them to the requester's next invocation via
   `/workspace/ipc-in/<transfer_id>/<filename>`. For root tasks only, pass
   `commit_to_memory=True` to copy files into the requester group's
   `zettel/reports/` (its Zettelkasten) instead.

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

To give the sub-task files, copy them into `/workspace/ipc-out/` and list
them in `file_paths` (a file you received in `/workspace/ipc-in/` too — copy
it first). The host takes them before your container exits. If the sub-task
is rejected, or fails, the files come back to your `/workspace/ipc-in/` and
the message telling you so names where they are.

After calling this, end your turn immediately. Your container exits; when the
sub-task completes, you are restarted with your conversation intact and its
result arrives as a new message. `/workspace/ipc-out` starts empty again, so
anything you left there before dispatching is lost — write files for your own
result after the sub-task returns.

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

The specialist cannot see your workspace, so a path to a file of yours means
nothing to it. To hand it a file — a PDF the user sent, say — copy the file
into `/workspace/ipc-out/` and list it:

```
dispatch_specialist(
  specialist_group_id="<id>",
  prompt="Read the attached paper and report on it.",
  file_paths=["/workspace/ipc-out/paper.pdf"]
)
```

The files arrive in the specialist's `/workspace/ipc-in/`, and its prompt is
rewritten to their new paths. A path that cannot be handed over (not in
`/workspace/ipc-out/`, missing) is named in the "Specialist task dispatched"
note you get back, as `[Not delivered: …]`; the dispatch still goes ahead.

Once you have listed a file, the host is responsible for it: you can end your
turn. If the dispatch is refused, or the specialist fails, the files come back
to your `/workspace/ipc-in/`, and the message that tells you names their
paths. Copy anything you want to keep out of `/workspace/ipc-in/` during that
turn — it is cleared afterwards.

The specialist runs in its own container session. When it calls
`deliver_specialist_result`, the host routes the result back to your session
as a follow-up message, marked `completed_task="<id>"` with the id you were
given when you dispatched it — use that to tell results apart when several are
in flight. Only the main agent group may call this tool — the
host will reject it from any other group.
