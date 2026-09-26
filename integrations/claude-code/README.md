# Chat On Steroids for Claude Code

A Claude Code plugin that lets Claude orchestrate ChatGPT through the Chat On Steroids desktop
app. Claude sends tasks to real ChatGPT chats, watches their thinking and tool calls, steers or
stops them, and verifies their work. With a project, a chat can read, edit and run commands in
that local folder.

## What it adds

| Component | What it does |
| --- | --- |
| `chatgpt` MCP server (`cos mcp`) | Tools: `task`, `wait`, `steer`, `status`, `tasks`, `activity`, `read`, `stop`, `cancel`, `sessions`, `projects`, `models`, `doctor`. |
| `orchestrate-chatgpt` skill | The playbook: decompose, brief, dispatch in parallel, supervise, verify, iterate. |
| `delegate-to-chatgpt` skill | The quick path for one question or one small task. |
| `chatgpt-worker` agent | Supervises one ChatGPT task end to end and returns a short verified report. |
| Hooks | Show ChatGPT work already running at session start; block credentials from being sent; report delegated tasks that finished; hold a turn once if delegated work is unread or still running unmentioned. |

## Requirements

- Chat On Steroids running on the same computer, with **Settings → Browser & history → CLI
  access** switched on, and its browser extension paired.
- A Chat On Steroids build that ships `cos`. The plugin's `bin/cos` launcher looks for it in
  this order: `$COS_JS`; the build in this checkout (`npm run build`); the app in
  `/Applications`, `~/Applications` or `/opt/Chat On Steroids`. It runs it with `node` when that
  is on `PATH`, and otherwise with the app's own runtime. Windows needs `COS_JS` and `node`.

## Install

From a clone of this repository, for development (the launcher uses this checkout's build):

```bash
npm run build
claude --plugin-dir integrations/claude-code
```

From the repository's marketplace, to install it for every session:

```bash
claude plugin marketplace add totec448-spec/chat-on-steroids
claude plugin install chat-on-steroids@chat-on-steroids
```

An installed plugin is copied out of the repository, so it uses the `cos` inside the installed
app. Until your app includes `cos`, set `COS_JS` to a checkout's `out/main/cos.js`.

Check the path with `cos doctor` (or ask Claude to run the `doctor` tool).

## Hook settings

- `COS_HOOK_STOP=off` turns off the stop hook that holds a turn for unread or unmentioned work.
- `COS_HOOK_DEBUG=1` prints hook errors to stderr. Hooks are otherwise silent and always exit 0,
  including when the app is closed.

The hooks keep one small JSON file per Claude session (task ids and the states Claude has seen)
in a private folder under the system temp directory. Nothing is sent anywhere except to the app
on this computer.
