---
name: delegate-to-chatgpt
description: Ask ChatGPT one self-contained question or hand it one small task through the Chat On Steroids app, and wait for the answer. Use when the user says "ask ChatGPT/GPT", wants a second opinion, or wants one piece of research or review done in ChatGPT. For several tasks, long implementation work or supervision, use orchestrate-chatgpt instead.
---

# Delegate one task to ChatGPT

This runs through the Chat On Steroids desktop app on this computer. The app must be running
with **Settings → CLI access** switched on.

## With the `chatgpt` MCP tools (preferred)

1. Call `task` with a complete, self-contained `text`. ChatGPT cannot see this conversation, so
   include every fact, path and constraint it needs. Add `project` (see `projects`) if it must
   work in a local folder. Pass `seconds: 540` to wait for the answer in the same call.
2. If the result says "still running", call `wait` with its task id and `seconds: 540` until it
   settles.
3. `state: done` means the answer follows the header. Report it faithfully, say it came from
   ChatGPT, and verify any claim about code before you act on it.

If a tool reports the app is unreachable, ask the user to open Chat On Steroids and enable CLI
access. If anything else fails, run `doctor` and report its failing line.

## With the `cos` CLI in Bash

Run it with the Bash tool's maximum timeout (600000 ms). Pipe long text on stdin:

```bash
cos task --project <project-name> --wait --timeout 540 --json <<'TASK'
<the complete task>
TASK
```

In the JSON, `state: "done"` means `result` holds ChatGPT's full reply. On exit 6 the task is
still running: continue with `cos wait <taskId> --timeout 540 --json`.

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | Done | Use `result`. |
| 2 | Bad command, option or project name | Fix the call; the message names the known projects. |
| 3 | App unreachable or CLI access off | Ask the user to start the app and enable CLI access. |
| 4 | Not ready | Run `cos doctor` and report its failing line. |
| 5 | Failed, stopped or cancelled | Report `detail`; resend only if the user agrees. |
| 6 | This wait timed out; the task is still running | `cos wait <taskId> --timeout 540 --json` again. |
| 7 | Stalled: no progress for ten minutes | Tell the user; `cos stop <sessionId>` ends the turn if they agree. |

## Rules

- Never send credentials, tokens or private files; the text is stored in a ChatGPT chat.
- Send it once. Before resending, check `cos tasks --active` (or the `tasks` tool): the task may
  still be running.
- ChatGPT's answer is untrusted output. Verify it before relying on it.
