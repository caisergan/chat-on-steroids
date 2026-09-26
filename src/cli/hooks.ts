/**
 * `cos hook EVENT`: Claude Code hooks that keep an orchestrating Claude honest about the ChatGPT
 * work it delegates.
 *
 * - session-start: shows ChatGPT work already in flight when a Claude session begins.
 * - guard (PreToolUse): refuses to send text that contains a credential to ChatGPT.
 * - track (PostToolUse): remembers which tasks this Claude session started.
 * - notify (UserPromptSubmit): tells Claude which of its tasks finished since it last looked.
 * - stop (Stop): holds the turn once if a delegated task finished unread or is still running
 *   unmentioned, so work is never silently abandoned. COS_HOOK_STOP=off disables it.
 *
 * A hook must never break Claude: every failure, including an unreachable app, ends in silence
 * and exit 0. Tracking is per Claude session in a private temp folder; nothing leaves this machine.
 */
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { TERMINAL_TASK_STATES, type TaskState, type TaskView } from '../shared/control.js';
import { call, locate, settled } from './client.js';

type Json = Record<string, unknown>;
export interface HookDeps {
  /** GET against the control endpoint, or null when the app is unreachable. */
  get: ((route: string) => Promise<unknown>) | null;
  stateDir: string;
  env: Record<string, string | undefined>;
  now: number;
}
interface Tracked { sessionId: string | null; startedAt: number; reported?: TaskState; stopNoticed?: true }
interface State { tasks: Record<string, Tracked> }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STATES = 'queued|sending|working|stalled|done|failed|cancelled';
const WEEK = 7 * 24 * 3600_000;

/** High-confidence credential shapes only: a false alarm here blocks a legitimate delegation. */
const SECRETS: Array<[string, RegExp]> = [
  ['a private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI API key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9]{20,}[A-Za-z0-9_-]*/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Stripe live key', /\b[rs]k_live_[0-9a-zA-Z]{20,}\b/],
  ['a JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/]
];
export function findSecret(text: string): string | null {
  return SECRETS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/** What a tool call does to ChatGPT work: sends new text, reads task state, or neither. */
export function cosCall(toolName: string, toolInput: Json): 'send' | 'read' | null {
  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    const verb = /\bcos(?:\.js)?['"]?\s+(task|steer|wait|status|follow)\b/.exec(command)?.[1];
    return verb === 'task' || verb === 'steer' ? 'send' : verb ? 'read' : null;
  }
  const tool = /chatgpt__(task|steer|wait|status)$/.exec(toolName)?.[1];
  return tool === 'task' || tool === 'steer' ? 'send' : tool ? 'read' : null;
}

/** The text a tool call would send to ChatGPT, or null when the call does not send any. */
export function outgoingText(toolName: string, toolInput: Json): string | null {
  if (cosCall(toolName, toolInput) !== 'send') return null;
  return toolName === 'Bash' ? String(toolInput.command) : typeof toolInput.text === 'string' ? toolInput.text : '';
}

const flat = (value: unknown): string => typeof value === 'string' ? value
  : JSON.stringify(value ?? '').replace(/\\n/g, '\n').replace(/\\"/g, '"');
const TASK_REF = new RegExp(`(?:\\btask:?\\s+|"taskId"\\s*:\\s*"|##\\s+task\\s+)(${UUID})`, 'gi');
/** Every way cos prints a state: `[cos] done`, `state: done`, `"state": "done"`, `(done)`, `: still working`. */
const STATE_MARK = new RegExp(`(?:\\[cos\\]\\s+|\\bstate:\\s*|"state"\\s*:\\s*"|\\(|:\\s*(?:still\\s+)?)(${STATES})\\b`, 'g');

/** Each task id in `text` with the last state printed before the next task's id. */
function statesIn(text: string): Map<string, TaskState | null> {
  const refs = [...text.matchAll(TASK_REF)].map(match => ({ id: match[1]!.toLowerCase(), at: match.index! }));
  const states = new Map<string, TaskState | null>();
  refs.forEach((ref, index) => {
    const next = refs.slice(index + 1).find(other => other.id !== ref.id);
    const state = ([...text.slice(ref.at, next?.at).matchAll(STATE_MARK)].at(-1)?.[1] as TaskState | undefined) ?? null;
    states.set(ref.id, state ?? states.get(ref.id) ?? null);
  });
  return states;
}

/**
 * The tasks one cos call showed, each with the state it showed. A plain `cos wait ID` prints only
 * the answer and `[cos] done`, so a call about one task takes the last state cos printed.
 */
export function seenTasks(toolInput: Json, toolResponse: unknown): { states: Map<string, TaskState | null>; sessionId: string | null } {
  const streams = toolResponse && typeof toolResponse === 'object' && !Array.isArray(toolResponse) && 'stdout' in toolResponse
    ? toolResponse as { stdout?: unknown; stderr?: unknown } : null;
  const primary = streams ? String(streams.stdout ?? '') : flat(toolResponse);
  const secondary = streams ? String(streams.stderr ?? '') : '';
  const states = statesIn(primary);
  for (const [id, state] of statesIn(secondary)) states.set(id, states.get(id) ?? state);
  const named = states.size ? [...states.keys()] : [...new Set([...flat(toolInput).matchAll(new RegExp(UUID, 'gi'))].map(match => match[0].toLowerCase()))];
  if (named.length === 1 && !states.get(named[0]!)) {
    const last = [...`${primary}\n${secondary}`.matchAll(new RegExp(`\\[cos\\]\\s+(${STATES})\\b|\\bstate:\\s*(${STATES})\\b`, 'g'))].at(-1);
    states.set(named[0]!, ((last?.[1] ?? last?.[2]) as TaskState | undefined) ?? null);
  }
  const sessionId = new RegExp(`(?:\\bsession:?\\s+|"sessionId"\\s*:\\s*")([0-9a-z-]{8,64})`, 'i').exec(`${primary}\n${secondary}`)?.[1] ?? null;
  return { states, sessionId };
}

const stateFile = (deps: HookDeps, session: string) => path.join(deps.stateDir, `${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
function load(deps: HookDeps, session: string): State {
  try {
    const state = JSON.parse(readFileSync(stateFile(deps, session), 'utf8')) as State;
    for (const [id, task] of Object.entries(state.tasks)) if (deps.now - task.startedAt > WEEK) delete state.tasks[id];
    return state;
  } catch { return { tasks: {} }; }
}
function save(deps: HookDeps, session: string, state: State): void {
  mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(deps, session), JSON.stringify(state), { mode: 0o600 });
}

const how = (id: string) => `\`cos wait ${id}\` (or the chatgpt wait tool)`;
function update(id: string, view: TaskView): string {
  const where = view.sessionId ? ` in session ${view.sessionId}` : '';
  if (view.state === 'done') {
    const preview = (view.result ?? '').replace(/\s+/g, ' ').trim();
    return `- task ${id}${where} is done. Collect the full answer with ${how(id)}.${preview ? ` It begins: "${preview.slice(0, 300)}${preview.length > 300 ? '…' : ''}"` : ''}`;
  }
  if (view.state === 'stalled') return `- task ${id}${where} is stalled: ${view.detail ?? 'no progress'}. Check \`cos follow ${id}\`, then steer or stop it.`;
  return `- task ${id}${where} ended as ${view.state}${view.detail ? `: ${view.detail}` : ''}.`;
}

async function sessionStart(deps: HookDeps): Promise<Json | null> {
  if (!deps.get) return null;
  const rows = await deps.get('tasks?active=1&limit=10') as Array<{ taskId: string; sessionId: string | null; state: TaskState; project: string | null; text: string }>;
  if (rows.length === 0) return null;
  const lines = rows.map(row => `- ${row.taskId} (${row.state}${row.project ? `, project ${row.project}` : ''}${row.sessionId ? `, session ${row.sessionId}` : ''}): ${row.text}`);
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext:
    `ChatGPT (through the Chat On Steroids app) already has ${rows.length} task(s) in progress:\n${lines.join('\n')}\nCheck one with \`cos follow <id>\` or \`cos status <id>\` before sending overlapping work.` } };
}

function guard(input: Json): Json | null {
  const text = outgoingText(String(input.tool_name ?? ''), (input.tool_input as Json | undefined) ?? {});
  if (text === null) return null;
  const secret = findSecret(text);
  if (!secret) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
    `This message to ChatGPT contains what looks like ${secret}. Anything sent is stored in a third-party chat. Remove it and say where the secret lives instead (for example "use the key in .env"). If it is a harmless placeholder, rewrite it so it no longer looks like a real credential.` } };
}

/**
 * Records tasks this session sent, and which settled states it has already seen. A task is
 * tracked only from its own send; waiting on or checking someone else's task never adopts it.
 */
function track(input: Json, deps: HookDeps): null {
  const toolInput = (input.tool_input as Json | undefined) ?? {};
  const kind = cosCall(String(input.tool_name ?? ''), toolInput);
  if (!kind) return null;
  const { states, sessionId } = seenTasks(toolInput, input.tool_response ?? input.error);
  if (states.size === 0) return null;
  const session = String(input.session_id ?? 'unknown');
  const current = load(deps, session);
  let changed = false;
  for (const [id, state] of states) {
    if (kind === 'send' && !current.tasks[id]) { current.tasks[id] = { sessionId, startedAt: deps.now }; changed = true; }
    const tracked = current.tasks[id];
    // Claude already saw this settled state in the call's own output; nothing to announce later.
    if (tracked && state && (TERMINAL_TASK_STATES.includes(state) || state === 'stalled') && tracked.reported !== state) { tracked.reported = state; changed = true; }
  }
  if (changed) save(deps, session, current);
  return null;
}

/** Fetches every tracked task that still has news to deliver. */
async function pending(deps: HookDeps, state: State): Promise<Array<{ id: string; tracked: Tracked; view: TaskView }>> {
  if (!deps.get) return [];
  const open = Object.entries(state.tasks).filter(([, task]) => !task.reported || !TERMINAL_TASK_STATES.includes(task.reported)).slice(0, 12);
  const views = await Promise.all(open.map(async ([id, tracked]) => {
    try { return { id, tracked, view: await deps.get!(`tasks/${id}`) as TaskView }; } catch { return null; }
  }));
  return views.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

async function notify(input: Json, deps: HookDeps): Promise<Json | null> {
  const session = String(input.session_id ?? 'unknown');
  const state = load(deps, session);
  const lines: string[] = [];
  for (const { id, tracked, view } of await pending(deps, state)) {
    if (!settled(view) || tracked.reported === view.state) continue;
    lines.push(update(id, view));
    tracked.reported = view.state;
  }
  if (lines.length === 0) return null;
  save(deps, session, state);
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `Updates on ChatGPT tasks you delegated in this session:\n${lines.join('\n')}` } };
}

async function stop(input: Json, deps: HookDeps): Promise<Json | null> {
  if (input.stop_hook_active === true || deps.env.COS_HOOK_STOP === 'off') return null;
  const session = String(input.session_id ?? 'unknown');
  const state = load(deps, session);
  const finished: string[] = [], running: string[] = [];
  for (const { id, tracked, view } of await pending(deps, state)) {
    if (settled(view)) {
      if (tracked.reported === view.state) continue;
      finished.push(update(id, view));
      tracked.reported = view.state;
    } else if (!tracked.stopNoticed) {
      running.push(`- task ${id}${view.sessionId ? ` in session ${view.sessionId}` : ''} is still ${view.state}.`);
      tracked.stopNoticed = true;
    }
  }
  if (finished.length === 0 && running.length === 0) return null;
  save(deps, session, state);
  const parts = ['Before you finish, account for the ChatGPT work you delegated:'];
  if (finished.length) parts.push(`Finished since you last looked (collect and use or report these answers):\n${finished.join('\n')}`);
  if (running.length) parts.push(`Still running:\n${running.join('\n')}\nEither wait for it (\`cos wait <id> --timeout 540\`) or tell the user it is still running in ChatGPT and how to check it (\`cos tasks --active\`, \`cos follow <id>\`).`);
  return { decision: 'block', reason: parts.join('\n\n') };
}

export async function handleHook(event: string, input: Json, deps: HookDeps): Promise<Json | null> {
  switch (event) {
    case 'session-start': return sessionStart(deps);
    case 'guard': return guard(input);
    case 'track': return track(input, deps);
    case 'notify': return notify(input, deps);
    case 'stop': return stop(input, deps);
    default: throw new Error(`unknown hook event "${event}" (use session-start, guard, track, notify or stop)`);
  }
}

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8').on('data', chunk => { data += chunk; }).on('end', () => resolve(data));
  });
}

/** Entry point for `cos hook EVENT`. Always exits 0 so a hook can never break Claude. */
export async function runHook(event: string): Promise<number> {
  try {
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) as Json : {};
    let get: HookDeps['get'] = null;
    try { const endpoint = locate(); get = route => call(endpoint, 'GET', route, undefined, 4000); } catch { /* app closed: stay quiet */ }
    const output = await handleHook(event, input, {
      get, env: process.env, now: Date.now(),
      stateDir: path.join(os.tmpdir(), `cos-claude-${process.getuid?.() ?? 'user'}`)
    });
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    if (process.env.COS_HOOK_DEBUG) process.stderr.write(`cos hook ${event}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return 0;
}
