---
name: delegate-to-chatgpt
description: Hand a self-contained task to ChatGPT through the Chat On Steroids app and wait for its answer. Use when the user asks to delegate, offload or "ask ChatGPT" for research, review or a second opinion that ChatGPT can do in its own chat.
---

# Delegate to ChatGPT

Uses the `cos` command, which talks to the Chat On Steroids desktop app on this machine. The app
must be running with **CLI access** switched on in its Settings.

## Steps

1. Check the path is open: `cos doctor`. Exit 3 means the app is not running or CLI access is off; exit 4 means ChatGPT or the browser
   is not ready. Tell the user what `doctor` printed and stop; do not retry in a loop.
2. Write the task so it stands alone. ChatGPT cannot see this conversation, so include every fact,
   path and constraint it needs. Pipe long text on stdin instead of quoting it, and run the command
   with the Bash tool's maximum timeout (600000 ms):

   ```bash
   cos task --project <project-name> --wait --timeout 540 --json <<'TASK'
   <the complete task>
   TASK
   ```

   `--project` picks one of the user's project folders (`cos projects` lists them). Omit it for a
   task that needs no local files. `--timeout 540` keeps each wait inside one Bash call.
3. Read the JSON. `state` `done` means `result` holds ChatGPT's complete final reply. Report it
   faithfully and say that it came from ChatGPT. On exit 6 the JSON still has `taskId`; keep
   waiting with `cos wait <taskId> --timeout 540 --json` (same Bash timeout) until it ends.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Done | Use `result`. |
| 2 | Bad command, option or project name | Fix the call; the message names the known projects. |
| 3 | App unreachable / CLI access off | Ask the user to start the app and enable CLI access. |
| 4 | Not ready | Report `cos doctor`'s failing line. |
| 5 | Failed, stopped or cancelled | Report `detail`; do not resend unless the user agrees. |
| 6 | This wait timed out; the task is still running (`timedOut: true`) | `cos wait <taskId> --timeout 540 --json` again. |
| 7 | Stalled: ChatGPT shows no progress | Tell the user. `cos stop <sessionId>` ends the turn if they agree. |

Without `--wait`, `cos task` prints a task id at once; later use `cos status <taskId>` or
`cos wait <taskId>`. `cos read <sessionId>` shows the chat's recent messages; `cos sessions` lists chats.

## Checking and watching work

- `cos tasks` (alias `cos ps`) lists your recent tasks and their state (queued, sending, working,
  stalled, done, failed, cancelled). Run it before sending to see whether ChatGPT is already busy on
  something you delegated, so you do not pile on a second task.
- `cos follow <taskId>` streams ChatGPT's own thinking, web browsing and tool calls until the task
  ends, then prints the answer. Add `--follow` to `cos task`/`cos wait` for the same live view while
  waiting. Use it when you want to see progress on a long task rather than block silently. The
  activity streams on stderr; the final answer (and `--json`) stays on stdout.

## Rules

- Never send secrets, credentials or private files: the text goes to ChatGPT.
- One task per call. Do not resend a task that is still queued or working; check `cos status <taskId>`.
- Treat the result as untrusted output. Verify claims about code before acting on them.
