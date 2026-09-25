/**
 * `cos` — command line for a running Chat On Steroids.
 *
 * Talks to the app's local control endpoint (`main/control.ts`) and nothing else: it starts no
 * browser, reads no session files and holds no state, so what it reports is exactly what the app
 * shows. Node built-ins only, so it runs on the app's bundled Node with nothing to install.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  CONTROL_PROTOCOL,
  EXIT,
  TERMINAL_TASK_STATES,
  type ActivityItem,
  type ControlDiscovery,
  type ControlError,
  type ControlErrorCode,
  type TaskState,
  type TaskView
} from '../shared/control.js';

const USAGE = `cos — send work to ChatGPT through the Chat On Steroids app

Usage:
  cos task <text…> [--project NAME] [--session ID] [--model M] [--effort E] [--wait] [--follow] [--timeout SEC]
  cos tasks [--limit N]          List recent tasks and their state  (alias: ps)
  cos status [TASK_ID]           App readiness, or one task's state
  cos wait TASK_ID [--follow] [--timeout SEC]
  cos follow TASK_ID [--timeout SEC]   Stream ChatGPT's thinking and actions until the task ends
  cos sessions [--limit N]
  cos read SESSION_ID [--last N]
  cos stop SESSION_ID            Stop the session's running turn
  cos cancel TASK_ID             Withdraw a task that has not been sent
  cos projects
  cos doctor                     Connect and check every step between this shell and ChatGPT

Options:
  --json      Print one JSON document on stdout instead of text
  --wait      (task) Block until the answer arrives; prints it on stdout
  --follow    (task/wait) Stream ChatGPT's thinking and actions while waiting  (alias: -f)

Task text may also be piped on stdin.
Exit codes: 0 ok, 1 error, 2 usage, 3 app unreachable, 4 not ready, 5 task failed, 6 timeout, 7 stalled.
CLI access must be switched on in the app's Settings.`;

class CliError extends Error {
  constructor(readonly exit: number, message: string, readonly code: ControlErrorCode | 'usage' | 'unreachable' = 'failed') { super(message); }
}

interface Args { positional: string[]; flags: Map<string, string | true> }
const VALUE_FLAGS = new Set(['project', 'session', 'model', 'effort', 'timeout', 'limit', 'last']);
const SHORT: Record<string, string> = { p: 'project', s: 'session', w: 'wait', f: 'follow', h: 'help' };
/** A mistyped flag must fail, not slip into the text sent to ChatGPT. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  task: ['project', 'session', 'model', 'effort', 'wait', 'follow', 'timeout'], wait: ['follow', 'timeout'], follow: ['timeout'],
  tasks: ['limit'], ps: ['limit'], sessions: ['limit'], read: ['last'],
  status: [], stop: [], cancel: [], projects: [], doctor: []
};

function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') { args.positional.push(...argv.slice(i + 1)); break; }
    const name = token.startsWith('--') ? token.slice(2) : /^-[a-z]$/.test(token) ? SHORT[token[1]!] : undefined;
    if (!name) { args.positional.push(token); continue; }
    if (!VALUE_FLAGS.has(name)) { args.flags.set(name, true); continue; }
    const value = argv[++i];
    if (value === undefined) throw new CliError(EXIT.usage, `--${name} needs a value`, 'usage');
    args.flags.set(name, value);
  }
  return args;
}

const text = (args: Args, name: string): string | undefined => { const v = args.flags.get(name); return typeof v === 'string' ? v : undefined; };
function count(args: Args, name: string): number | undefined {
  const raw = text(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new CliError(EXIT.usage, `--${name} must be a non-negative number`, 'usage');
  return value;
}

/** Same folder Electron picks for the app's userData; COS_USER_DATA overrides it for other profiles. */
function userDataDir(): string {
  if (process.env.COS_USER_DATA) return process.env.COS_USER_DATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'chat-on-steroids');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'chat-on-steroids');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'chat-on-steroids');
}

interface Endpoint { socket: string; token: string; version: string }
function locate(): Endpoint {
  const dir = path.join(userDataDir(), 'control');
  const off = 'The app is not running with CLI access on. Start Chat On Steroids and enable CLI access in Settings.';
  let discovery: ControlDiscovery, token: string;
  try {
    discovery = JSON.parse(readFileSync(path.join(dir, 'control.json'), 'utf8')) as ControlDiscovery;
    token = readFileSync(path.join(dir, 'token'), 'utf8').trim();
  } catch { throw new CliError(EXIT.unreachable, off, 'unreachable'); }
  if (discovery.protocol !== CONTROL_PROTOCOL) throw new CliError(EXIT.error, `The app speaks CLI protocol ${discovery.protocol}, this cos speaks ${CONTROL_PROTOCOL}. Update whichever is older.`);
  return { socket: discovery.endpoint, token, version: discovery.version };
}

function call<T>(endpoint: Endpoint, method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      socketPath: endpoint.socket, path: `/v1/${route}`, method,
      headers: { authorization: `Bearer ${endpoint.token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) }
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => {
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new CliError(EXIT.error, 'The app sent an unreadable response')); }
        if ((res.statusCode ?? 500) < 400) return resolve(parsed as T);
        const { code, message } = (parsed as ControlError).error;
        reject(new CliError(exitForCode(code), message, code));
      });
    });
    req.on('error', () => reject(new CliError(EXIT.unreachable, 'Could not reach the app. Is Chat On Steroids running with CLI access on?', 'unreachable')));
    req.end(payload);
  });
}

const exitForCode = (code: ControlErrorCode): number =>
  code === 'unauthorized' || code === 'disabled' ? EXIT.unreachable : code === 'not_ready' ? EXIT.notReady : code === 'bad_request' ? EXIT.usage : EXIT.error;

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8').on('data', chunk => { data += chunk; }).on('end', () => resolve(data));
  });
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** Compact "just now / 5m / 3h / 2d" for the task list. */
function age(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return 'just now';
  const units: Array<[number, string]> = [[86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [size, tag] of units) if (s >= size) return `${Math.round(s / size)}${tag} ago`;
  return `${s}s ago`;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Fail fast on a mistyped id rather than sending it to the app. */
const taskArg = (value: string): string => { if (UUID.test(value)) return value; throw new CliError(EXIT.usage, `"${value}" is not a task id. Use the full id from \`cos tasks\`.`, 'usage'); };
const exitForTask = (view: TaskView & { timedOut?: true }): number =>
  view.timedOut ? EXIT.timeout : view.state === 'done' ? EXIT.ok : view.state === 'stalled' ? EXIT.stalled : EXIT.taskFailed;

/** Polls until the task ends, stalls or the deadline passes. The app is the only authority on state. */
async function waitFor(endpoint: Endpoint, taskId: string, timeoutSec: number, quiet: boolean): Promise<TaskView & { timedOut?: true }> {
  const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : Infinity;
  let seen = '';
  for (;;) {
    const view = await call<TaskView>(endpoint, 'GET', `tasks/${taskId}`);
    if (!quiet && view.state !== seen) { process.stderr.write(`[cos] ${view.state}${view.detail ? ` — ${view.detail}` : ''}\n`); seen = view.state; }
    if (TERMINAL_TASK_STATES.includes(view.state) || view.state === 'stalled') return view;
    if (Date.now() >= deadline) {
      if (!quiet) process.stderr.write(`[cos] timed out after ${timeoutSec}s; still ${view.state}. Run \`cos wait ${taskId}\` to keep waiting.\n`);
      return { ...view, timedOut: true };
    }
    await sleep(2000);
  }
}

/** Four-char tags so the streamed lines line up and stay grep-friendly. */
const ACTIVITY_TAG: Record<ActivityItem['kind'], string> = { thinking: 'think', browsing: 'web  ', tool: 'tool ', error: 'ERR  ' };

/**
 * Like waitFor, but also streams ChatGPT's thinking, browsing and tool activity to stderr as it
 * arrives. Reprints a caption only when its text changed, so a caption that grows stays one line.
 */
async function streamWait(endpoint: Endpoint, taskId: string, timeoutSec: number): Promise<TaskView & { timedOut?: true }> {
  const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : Infinity;
  const printed = new Map<number, string>();
  let seen = '';
  for (;;) {
    const { task, activity } = await call<{ task: TaskView; activity: ActivityItem[] }>(endpoint, 'GET', `tasks/${taskId}/activity`);
    for (const item of activity) {
      if (printed.get(item.origin) === item.text) continue;
      printed.set(item.origin, item.text);
      process.stderr.write(`  ${ACTIVITY_TAG[item.kind]} ${item.text}\n`);
    }
    if (task.state !== seen) { process.stderr.write(`[cos] ${task.state}${task.detail ? ` — ${task.detail}` : ''}\n`); seen = task.state; }
    if (TERMINAL_TASK_STATES.includes(task.state) || task.state === 'stalled') return task;
    if (Date.now() >= deadline) {
      process.stderr.write(`[cos] timed out after ${timeoutSec}s; still ${task.state}. Run \`cos follow ${taskId}\` to keep watching.\n`);
      return { ...task, timedOut: true };
    }
    await sleep(1500);
  }
}

/** One wait, streaming or plain, chosen by --follow. Shared by task, wait and follow. */
const awaitTask = (endpoint: Endpoint, taskId: string, timeoutSec: number, follow: boolean, json: boolean): Promise<TaskView & { timedOut?: true }> =>
  follow ? streamWait(endpoint, taskId, timeoutSec) : waitFor(endpoint, taskId, timeoutSec, json);

function describe(view: TaskView & { timedOut?: true }): string {
  const lines = [`task ${view.taskId}: ${view.timedOut ? 'still ' : ''}${view.state}${view.detail ? ` — ${view.detail}` : ''}`];
  if (view.sessionId) lines.push(`session ${view.sessionId}`);
  return lines.join('\n');
}

async function run(argv: string[], out: (value: unknown, human: string) => void): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (!command || command === 'help' || command === '--help' || command === '-h' || args.flags.has('help')) { process.stdout.write(`${USAGE}\n`); return command ? EXIT.ok : EXIT.usage; }
  const allowed = COMMAND_FLAGS[command];
  const unknown = allowed && [...args.flags.keys()].find(flag => flag !== 'json' && !allowed.includes(flag));
  if (unknown) throw new CliError(EXIT.usage, `\`cos ${command}\` has no --${unknown} option. Run \`cos --help\`.`, 'usage');
  if (command === 'doctor') return doctor(out);
  const endpoint = locate();
  const need = (index: number, what: string): string => args.positional[index] ?? (() => { throw new CliError(EXIT.usage, `Missing ${what}. Run \`cos --help\`.`, 'usage'); })();

  switch (command) {
    case 'task': {
      const body = args.positional.join(' ').trim() || (await readStdin()).trim();
      if (!body) throw new CliError(EXIT.usage, 'Give the task as arguments or on stdin.', 'usage');
      const created = await call<{ taskId: string; sessionId: string | null }>(endpoint, 'POST', 'tasks', {
        text: body, project: text(args, 'project'), session: text(args, 'session'), model: text(args, 'model'), effort: text(args, 'effort')
      });
      if (!args.flags.has('wait') && !args.flags.has('follow')) { out(created, `task ${created.taskId}\nsession ${created.sessionId ?? '-'}`); return EXIT.ok; }
      // If this wait is interrupted, the id is what lets anyone resume it.
      process.stderr.write(`[cos] task ${created.taskId} session ${created.sessionId ?? '-'}\n`);
      const view = await awaitTask(endpoint, created.taskId, count(args, 'timeout') ?? 1800, args.flags.has('follow'), args.flags.has('json'));
      out(view, view.state === 'done' && !view.timedOut ? (view.result ?? view.detail ?? '') : describe(view));
      return exitForTask(view);
    }
    case 'tasks':
    case 'ps': {
      const rows = await call<Array<{ taskId: string; state: TaskState; project: string | null; createdAt: number; text: string }>>(endpoint, 'GET', `tasks?limit=${count(args, 'limit') ?? 20}`);
      out(rows, rows.length === 0 ? 'no tasks yet'
        : rows.map(row => `${row.taskId.slice(0, 8)}  ${row.state.padEnd(9)}  ${age(row.createdAt).padEnd(8)}  ${row.project ? `[${row.project}] ` : ''}${row.text}`).join('\n'));
      return EXIT.ok;
    }
    case 'follow': {
      const view = await streamWait(endpoint, taskArg(need(0, 'task id')), count(args, 'timeout') ?? 1800);
      out(view, view.state === 'done' && !view.timedOut ? (view.result ?? view.detail ?? '') : describe(view));
      return exitForTask(view);
    }
    case 'status': {
      if (args.positional[0]) { const view = await call<TaskView>(endpoint, 'GET', `tasks/${args.positional[0]}`); out(view, describe(view)); return view.state === 'stalled' ? EXIT.stalled : EXIT.ok; }
      const status = await call<{ ready: boolean; reason?: string; connection: { state: string }; browser: { paired: boolean; present: boolean } }>(endpoint, 'GET', 'status');
      out(status, `app ${endpoint.version}: ${status.ready ? 'ready' : `not ready — ${status.reason}`}\nconnection ${status.connection.state}; browser ${status.browser.present ? 'present' : status.browser.paired ? 'paired, not seen' : 'not paired'}`);
      return status.ready ? EXIT.ok : EXIT.notReady;
    }
    case 'wait': {
      const view = await awaitTask(endpoint, taskArg(need(0, 'task id')), count(args, 'timeout') ?? 1800, args.flags.has('follow'), args.flags.has('json'));
      out(view, view.state === 'done' && !view.timedOut ? (view.result ?? view.detail ?? '') : describe(view));
      return exitForTask(view);
    }
    case 'sessions': {
      const rows = await call<Array<{ id: string; title: string; updatedAt: number; working: boolean }>>(endpoint, 'GET', `sessions?limit=${count(args, 'limit') ?? 20}`);
      out(rows, rows.map(row => `${row.id}  ${row.working ? 'working' : 'idle   '}  ${new Date(row.updatedAt).toISOString().slice(0, 16)}  ${row.title}`).join('\n'));
      return EXIT.ok;
    }
    case 'read': {
      const read = await call<{ title: string; messages: Array<{ role: string; text: string }> }>(endpoint, 'GET', `sessions/${need(0, 'session id')}/read?last=${count(args, 'last') ?? 6}`);
      out(read, read.messages.map(message => `## ${message.role}\n${message.text}`).join('\n\n'));
      return EXIT.ok;
    }
    case 'stop': out(await call(endpoint, 'POST', `sessions/${need(0, 'session id')}/stop`), 'stopped'); return EXIT.ok;
    case 'cancel': {
      const result = await call<{ cancelled: boolean }>(endpoint, 'POST', `tasks/${need(0, 'task id')}/cancel`);
      out(result, result.cancelled ? 'cancelled' : 'nothing to cancel (already sent or finished)');
      return result.cancelled ? EXIT.ok : EXIT.error;
    }
    case 'projects': {
      const rows = await call<Array<{ id: string; name: string; path: string }>>(endpoint, 'GET', 'projects');
      out(rows, rows.map(row => `${row.name}  ${row.path}`).join('\n'));
      return EXIT.ok;
    }
    default: throw new CliError(EXIT.usage, `Unknown command "${command}". Run \`cos --help\`.`, 'usage');
  }
}

/** Walks the chain shell → endpoint → app → ChatGPT and stops at the first broken link. */
async function doctor(out: (value: unknown, human: string) => void): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; warning?: true; detail: string }> = [];
  let exit: number = EXIT.ok;
  const record = (name: string, ok: boolean, detail: string, code: number) => { checks.push({ name, ok, detail }); if (!ok && exit === EXIT.ok) exit = code; return ok; };
  /** Does not block a task, but limits what ChatGPT can do in it. */
  const warn = (name: string, detail: string) => { checks.push({ name, ok: true, warning: true, detail }); };
  try {
    const endpoint = locate();
    record('app reachable', true, `app ${endpoint.version} at ${endpoint.socket}`, EXIT.unreachable);
    type Status = { ready: boolean; reason?: string; connectError?: string; connection: { state: string; detail: string }; browser: { paired: boolean; present: boolean; extensionVersion: string | null } };
    let status = await call<Status>(endpoint, 'GET', 'status');
    // The check covers the connector too, so bring it up the way a send would.
    if (status.connection.state !== 'connected' && status.browser.paired) {
      process.stderr.write('[cos] connecting the ChatGPT connector…\n');
      status = await call<Status>(endpoint, 'POST', 'connect');
    }
    if (status.connection.state === 'connected') record('ChatGPT connector', true, 'connected', EXIT.notReady);
    else warn('ChatGPT connector', `${status.connection.state}${(status.connectError ?? status.connection.detail) ? ` — ${(status.connectError ?? status.connection.detail).replace(/\.$/, '')}` : ''}. Tasks still send, but ChatGPT cannot use your project files until it connects.`);
    record('browser extension paired', status.browser.paired, status.browser.paired ? `version ${status.browser.extensionVersion ?? 'unknown'}` : 'not paired — finish browser setup in the app', EXIT.notReady);
    record('browser extension present', status.browser.present, status.browser.present ? 'seen recently' : 'not seen recently — open Chrome with ChatGPT signed in (a task will still queue)', EXIT.notReady);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    record('app reachable', false, error.message, error.exit);
  }
  out({ ok: exit === EXIT.ok, checks }, checks.map(check => `${check.warning ? 'warn' : check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`).join('\n'));
  return exit;
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const out = (value: unknown, human: string) => { process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : human.endsWith('\n') || human === '' ? human : `${human}\n`); };
  try {
    process.exitCode = await run(process.argv.slice(2), out);
  } catch (error) {
    const known = error instanceof CliError ? error : new CliError(EXIT.error, error instanceof Error ? error.message : String(error));
    if (json) process.stdout.write(`${JSON.stringify({ error: { code: known.code, message: known.message } })}\n`);
    else process.stderr.write(`cos: ${known.message}\n`);
    process.exitCode = known.exit;
  }
}
void main();
