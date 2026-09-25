---
name: orchestrate-chatgpt
description: Plan, dispatch, supervise and verify work done by ChatGPT through the Chat On Steroids app — one or several ChatGPT chats working in parallel, each with its own brief. Use when a job splits into pieces ChatGPT can do on its own (implementation in a local project, research, review, a second opinion), when the user asks you to use, coordinate or check on ChatGPT or GPT, or when ChatGPT work is already running.
---

# Orchestrate ChatGPT

You are the lead engineer; ChatGPT chats are the workers you brief, watch, correct and check.
Each worker is a real ChatGPT conversation in the user's browser, driven by the Chat On Steroids
desktop app. When a task names a project, that chat can read, edit and run commands in the
project folder. It cannot see this conversation, and you cannot see its screen, only what the
tools report.

## Tools

Use the `chatgpt` MCP tools from this plugin. Every one has a `cos` command for Bash, which you
can use when the tools are unavailable or in scripts.

| Need | MCP tool | CLI |
| --- | --- | --- |
| Check the path to ChatGPT | `doctor` | `cos doctor` |
| See what is already running | `tasks` with `active_only: true` | `cos tasks --active` |
| Start work in a new chat | `task` with `text`, `project` | `cos task --project P <<'TASK' … TASK` |
| Continue an existing chat | `task` with `text`, `session` | `cos task --session S "…"` |
| Collect answers | `wait` with `task_ids`, `mode` | `cos wait ID… [--any] --timeout 540` |
| Watch thinking and actions | `activity` with `task_id` | `cos follow ID` |
| Correct a running turn | `steer` with `session`, `text` | `cos steer S "…"` |
| End a running turn | `stop` with `session` | `cos stop S` |
| Withdraw a queued task | `cancel` with `task_id` | `cos cancel ID` |
| Read a whole chat | `read` with `session` | `cos read S --last 10` |
| Pick a project or model | `projects`, `models` | `cos projects`, `cos models` |

A task id identifies one message you sent; a session id identifies the chat it went to. For a new
chat they start out equal. Keep both.

## Workflow

1. **Preflight.** Run `doctor` once per session. Then check `tasks` with `active_only`: do not
   start work that overlaps a chat that is already busy. Report and stop on any failed check.
2. **Decide what to delegate.** Good fits: self-contained implementation in a project, broad
   research, independent review, a second opinion on a design, long mechanical changes. Keep for
   yourself: anything that needs this conversation's context you cannot write down, small edits
   that are faster to make than to brief, and anything involving secrets.
3. **Decompose.** Split into units that can run at the same time without touching the same
   files. Give each unit its own chat. Order dependent units; start a unit only when what it
   depends on is verified.
4. **Brief** each unit with the template below. A vague brief is the main cause of wasted runs.
5. **Dispatch.** Send every independent unit at once with `seconds: 0` (the default) and record a
   table of unit, task id and session id. Keep to about three chats at a time unless the user
   asks for more: each is a live chat in their browser and counts against their ChatGPT limits.
6. **Supervise.** Call `wait` with `mode: "any"` and `seconds: 300`, and handle each chat as it
   settles, using the state table below. For a long unit, check `activity`. If it drifts, `steer`
   it while its turn is still running. Once the turn has ended, send a follow-up `task` with
   `session` instead. If it is clearly wrong, `stop` it and send a corrected follow-up.
7. **Verify** before believing anything. In the project: `git status`, `git diff`, read the
   changed files, and run the tests or typecheck yourself. Check every acceptance criterion from
   the brief. ChatGPT's report is a claim, not evidence.
8. **Iterate in the same chat.** Send concrete review findings as a follow-up `task` with its
   `session`; it keeps its context. Do not open a new chat for fixes.
9. **Integrate and report.** Tell the user what each chat did, what you verified and how, and
   what remains, and say which parts came from ChatGPT. Include the task and session ids.

## Brief template

```
Goal: <one sentence: the outcome, not the steps>
Context: <project and relevant files, what they do, decisions already made, links between parts>
Scope: <what you may change> — do NOT change: <files and areas other chats own or that must stay>
Constraints: <conventions to follow; do not commit or push; do not add dependencies unless …>
Acceptance: <checks that must pass: commands to run and their expected result, behaviour>
Report: finish with (1) files changed and why, (2) commands run with their real results,
(3) anything not done, and open questions or risks. Do not claim checks you did not run.
```

## States

| State | Meaning | What to do |
| --- | --- | --- |
| `queued` | Waiting for the browser or for the chat's current turn | Wait. A `detail` naming a problem means the setup needs the user. |
| `sending` / `working` | ChatGPT has it | Wait; use `activity` to look inside. |
| `stalled` | No progress for 10 minutes | Check `activity`; then `stop` and resend, or tell the user. |
| `done` | The answer is in the result | Verify it, then use it. |
| `failed` / `cancelled` | Ended without an answer | Read `detail`; resend only with a fixed brief. |

A `wait` that returns "still running" only means that call's time ran out. Call it again.

## Rules

- Never put credentials, tokens or private data in a brief. The guard hook blocks obvious
  credentials; describe where a secret lives instead ("use the key in `.env`").
- Parallel chats must not edit the same files or run conflicting commands in one repository.
- Tell ChatGPT not to commit or push unless the user asked for that.
- Do not resend a task that is still queued or working. A follow-up to a busy chat waits for the
  chat's current turn automatically.
- Pro and very high effort models can take a long time; pick them only for hard reasoning.
  Check `models` for what this account offers. By default the chat keeps its current model.
- Hooks from this plugin: at session start they list ChatGPT work already in flight. When the user
  writes, they report tasks you started that finished since you last looked. When you try to
  finish, they hold the turn once if a task you started finished unread or is still running
  unmentioned. Act on those messages: collect the answer, or tell the user what is still running
  and how to check it (`cos tasks --active`).
- To supervise a long unit without filling this conversation, hand it to the `chatgpt-worker`
  agent; launch one per unit for parallel work.
