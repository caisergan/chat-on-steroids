/**
 * The one client of the app's control endpoint, shared by the `cos` commands, its MCP server and
 * its Claude Code hooks. Node built-ins only: this runs on the app's bundled Node.
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
  type TaskView
} from '../shared/control.js';

export class CliError extends Error {
  constructor(readonly exit: number, message: string, readonly code: ControlErrorCode | 'usage' | 'unreachable' = 'failed') { super(message); }
}

/** Same folder Electron picks for the app's userData; COS_USER_DATA overrides it for other profiles. */
function userDataDir(): string {
  if (process.env.COS_USER_DATA) return process.env.COS_USER_DATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'chat-on-steroids');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'chat-on-steroids');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'chat-on-steroids');
}

export interface Endpoint { socket: string; token: string; version: string }
export function locate(): Endpoint {
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

const exitForCode = (code: ControlErrorCode): number =>
  code === 'unauthorized' || code === 'disabled' ? EXIT.unreachable : code === 'not_ready' ? EXIT.notReady : code === 'bad_request' ? EXIT.usage : EXIT.error;

/** `timeoutMs` bounds callers that must never hang, such as hooks; commands leave it unset. */
export function call<T>(endpoint: Endpoint, method: 'GET' | 'POST', route: string, body?: unknown, timeoutMs?: number): Promise<T> {
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
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(new CliError(EXIT.unreachable, 'Could not reach the app. Is Chat On Steroids running with CLI access on?', 'unreachable')));
    req.end(payload);
  });
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export type Waited = TaskView & { timedOut?: true };
/** A task a caller can stop waiting on: it ended, or it needs a person. */
export const settled = (view: TaskView): boolean => TERMINAL_TASK_STATES.includes(view.state) || view.state === 'stalled';
export const exitForTask = (view: Waited): number =>
  view.timedOut ? EXIT.timeout : view.state === 'done' ? EXIT.ok : view.state === 'stalled' ? EXIT.stalled : EXIT.taskFailed;

export interface PollOptions {
  timeoutSec: number;
  /** Also read the task's activity feed and report each new or changed line. */
  onActivity?: (item: ActivityItem) => void;
  onState?: (view: TaskView) => void;
  signal?: AbortSignal;
}

/**
 * Polls one task until it settles, the deadline passes or the signal aborts. The app is the only
 * authority on state; a caption that grows in place is reported again only when its text changed.
 */
export async function pollTask(endpoint: Endpoint, taskId: string, options: PollOptions): Promise<Waited> {
  const deadline = options.timeoutSec > 0 ? Date.now() + options.timeoutSec * 1000 : Infinity;
  const printed = new Map<number, string>();
  let seen = '';
  for (;;) {
    let view: TaskView;
    if (options.onActivity) {
      const feed = await call<{ task: TaskView; activity: ActivityItem[] }>(endpoint, 'GET', `tasks/${taskId}/activity`);
      for (const item of feed.activity) {
        if (printed.get(item.origin) === item.text) continue;
        printed.set(item.origin, item.text);
        options.onActivity(item);
      }
      view = feed.task;
    } else view = await call<TaskView>(endpoint, 'GET', `tasks/${taskId}`);
    if (view.state !== seen) { options.onState?.(view); seen = view.state; }
    if (settled(view)) return view;
    if (Date.now() >= deadline || options.signal?.aborted) return { ...view, timedOut: true };
    await sleep(options.onActivity ? 1500 : 2000, options.signal);
  }
}

/**
 * Waits on several tasks at once: until all settle, or with `any` until the first does. Tasks
 * still running at the deadline come back with `timedOut`, in the order they were given.
 */
export async function pollTasks(endpoint: Endpoint, taskIds: string[], options: { timeoutSec: number; any?: boolean; onState?: (view: TaskView) => void; signal?: AbortSignal }): Promise<Waited[]> {
  const deadline = options.timeoutSec > 0 ? Date.now() + options.timeoutSec * 1000 : Infinity;
  const latest = new Map<string, TaskView>();
  for (;;) {
    for (const id of taskIds) {
      const prior = latest.get(id);
      if (prior && settled(prior)) continue;
      const view = await call<TaskView>(endpoint, 'GET', `tasks/${id}`);
      if (prior?.state !== view.state) options.onState?.(view);
      latest.set(id, view);
    }
    const views = taskIds.map(id => latest.get(id)!);
    const done = views.filter(settled).length;
    if (done === views.length || (options.any && done > 0)) return views;
    if (Date.now() >= deadline || options.signal?.aborted) return views.map(view => settled(view) ? view : { ...view, timedOut: true as const });
    await sleep(2000, options.signal);
  }
}

export interface DoctorCheck { name: string; ok: boolean; warning?: true; detail: string }

/** Walks the chain endpoint → app → connector → browser and reports every link. */
export async function runDoctor(onConnecting?: () => void): Promise<{ exit: number; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  let exit: number = EXIT.ok;
  const record = (name: string, ok: boolean, detail: string, code: number) => { checks.push({ name, ok, detail }); if (!ok && exit === EXIT.ok) exit = code; };
  /** Does not block a task, but limits what ChatGPT can do in it. */
  const warn = (name: string, detail: string) => { checks.push({ name, ok: true, warning: true, detail }); };
  try {
    const endpoint = locate();
    record('app reachable', true, `app ${endpoint.version} at ${endpoint.socket}`, EXIT.unreachable);
    type Status = { connectError?: string; connection: { state: string; detail: string }; browser: { paired: boolean; present: boolean; extensionVersion: string | null } };
    let status = await call<Status>(endpoint, 'GET', 'status');
    // The check covers the connector too, so bring it up the way a send would.
    if (status.connection.state !== 'connected' && status.browser.paired) {
      onConnecting?.();
      status = await call<Status>(endpoint, 'POST', 'connect');
    }
    const why = (status.connectError ?? status.connection.detail).replace(/\.$/, '');
    if (status.connection.state === 'connected') record('ChatGPT connector', true, 'connected', EXIT.notReady);
    else warn('ChatGPT connector', `${status.connection.state}${why ? ` — ${why}` : ''}. Tasks still send, but ChatGPT cannot use your project files until it connects.`);
    record('browser extension paired', status.browser.paired, status.browser.paired ? `version ${status.browser.extensionVersion ?? 'unknown'}` : 'not paired — finish browser setup in the app', EXIT.notReady);
    record('browser extension present', status.browser.present, status.browser.present ? 'seen recently' : 'not seen recently — open Chrome with ChatGPT signed in (a task will still queue)', EXIT.notReady);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    record('app reachable', false, error.message, error.exit);
  }
  return { exit, checks };
}
