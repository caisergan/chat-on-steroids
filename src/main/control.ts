/**
 * Local control endpoint for the `cos` command line.
 *
 * It is a thin adapter over the functions the desktop UI already calls: `sendDesktopInput` for
 * work, `listInputs`/the session store for state, `stopSessionTurn` and `cancelDesktopInput` for
 * control. It owns no task state of its own: a task is one outbox input, and every answer is
 * derived from those records (`shared/control.ts`), so the CLI can never disagree with the app.
 *
 * Exposure: off until Settings enables it; a Unix socket (named pipe on Windows) that only this
 * OS user can open, plus a random token in a file only this user can read. There is no TCP
 * listener, so no web page and no other machine can reach it.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { app } from 'electron';
import { getConfig } from './config.js';
import { getStatus } from './connection.js';
import { bridgeStatus, sessionControlsFor, stopSessionTurn } from './bridge.js';
import { logInfo, logWarn } from './logger.js';
import { listProjects } from './projects.js';
import { getChatModels } from './chat-models.js';
import { REASONING_EFFORTS } from '../shared/session.js';
import type { InputEntry } from './session/input.js';
import type { SessionEvent } from '../shared/session.js';
import { getSession, listSessionPage, readOverflowText, readRecentEvents } from './session/store.js';
import { listInputs } from './session/input.js';
import { cancelDesktopInput, ready, sendDesktopInput } from './session/start-input.js';
import {
  CONTROL_PROTOCOL,
  TERMINAL_TASK_STATES,
  deriveTask,
  taskTurnEvents,
  turnActivity,
  type ActivityItem,
  type ControlDiscovery,
  type ControlError,
  type ControlErrorCode,
  type TaskState,
  type TaskView
} from '../shared/control.js';

const MAX_BODY_BYTES = 1_000_000;
const SESSION_ID = /^[0-9a-z-]{8,64}$/i;

class ControlHttpError extends Error {
  constructor(readonly status: number, readonly code: ControlErrorCode, message: string) { super(message); }
}

let userDataDir: string | null = null;
let server: http.Server | null = null;
/** Enable/disable transitions run one at a time, so two quick saves cannot open two listeners. */
let transitions: Promise<void> = Promise.resolve();
let shutDown = false;
let token = '';

export function controlDir(userData: string): string { return path.join(userData, 'control'); }
export const CONTROL_TOKEN_FILE = 'token';
export const CONTROL_DISCOVERY_FILE = 'control.json';

/** Unix sockets are capped near 104 bytes, so a long profile path falls back to the temp dir. */
export function controlEndpoint(userData: string, platform: NodeJS.Platform = process.platform, uid = process.getuid?.() ?? 0): string {
  const key = crypto.createHash('sha256').update(userData).digest('hex').slice(0, 12);
  if (platform === 'win32') return `\\\\.\\pipe\\chat-on-steroids-${key}`;
  // A Unix socket path always uses POSIX separators, whatever host computed it.
  const beside = path.posix.join(userData, 'control', 's');
  return beside.length <= 100 ? beside : path.posix.join(os.tmpdir(), `cos-${uid}-${key}.sock`);
}

export function initControl(userData: string): void { userDataDir = userData; }

/** Starts or stops the endpoint to match Settings. Safe to call on every settings save. */
export function applyControlSetting(): Promise<void> {
  transitions = transitions.then(async () => {
    const wanted = !shutDown && getConfig().ui.cliControl === true;
    if (wanted && !server) await startControl();
    else if (!wanted && server) await stopControl();
  }).catch((error: Error) => logWarn(`CLI access: ${error.message}`));
  return transitions;
}

async function startControl(): Promise<void> {
  if (!userDataDir) throw new Error('control endpoint was not initialised');
  const dir = controlDir(userDataDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  token = crypto.randomBytes(32).toString('hex');
  await fs.writeFile(path.join(dir, CONTROL_TOKEN_FILE), token, { mode: 0o600 });
  await fs.chmod(path.join(dir, CONTROL_TOKEN_FILE), 0o600).catch(() => undefined);
  const endpoint = controlEndpoint(userDataDir);
  // The single-instance lock means no other live app owns this socket; a file is a stale leftover.
  if (process.platform !== 'win32') await fs.rm(endpoint, { force: true });
  const created = http.createServer((req, res) => { void route(req, res); });
  created.headersTimeout = 10_000;
  server = created;
  try {
    await new Promise<void>((resolve, reject) => {
      created.once('error', reject);
      created.listen(endpoint, () => { created.off('error', reject); resolve(); });
    });
    if (process.platform !== 'win32') await fs.chmod(endpoint, 0o600);
    const discovery: ControlDiscovery = { protocol: CONTROL_PROTOCOL, endpoint, pid: process.pid, version: app.getVersion() };
    await fs.writeFile(path.join(dir, CONTROL_DISCOVERY_FILE), JSON.stringify(discovery), { mode: 0o600 });
  } catch (error) {
    await stopControl();
    throw error;
  }
  logInfo('CLI access enabled');
}

/** Closes the endpoint for good; later settings saves cannot reopen it. */
export function shutdownControl(): Promise<void> {
  shutDown = true;
  return applyControlSetting();
}

async function stopControl(): Promise<void> {
  const closing = server;
  server = null;
  token = '';
  if (userDataDir) {
    const dir = controlDir(userDataDir);
    await Promise.all([CONTROL_TOKEN_FILE, CONTROL_DISCOVERY_FILE].map(name => fs.rm(path.join(dir, name), { force: true })));
    if (process.platform !== 'win32') await fs.rm(controlEndpoint(userDataDir), { force: true });
  }
  if (!closing?.listening) return;
  await new Promise<void>(resolve => {
    // A long-lived client must not hold shutdown open.
    const timer = setTimeout(() => { closing.closeAllConnections(); resolve(); }, 2000);
    timer.unref?.();
    closing.close(() => { clearTimeout(timer); resolve(); });
    closing.closeIdleConnections();
  });
  logInfo('CLI access disabled');
}

function authorized(header: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(header.slice(7)), digest(token));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ControlHttpError(413, 'bad_request', 'Request body is too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ControlHttpError(400, 'bad_request', 'Request body is not valid JSON'); }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    if (!authorized(req.headers.authorization)) throw new ControlHttpError(401, 'unauthorized', 'Missing or wrong CLI token. Is the app running with CLI access on?');
    const url = new URL(req.url ?? '/', 'http://cos.local');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'v1') throw new ControlHttpError(404, 'not_found', 'Unknown endpoint');
    send(res, 200, await dispatch(req.method ?? 'GET', parts.slice(1), url.searchParams, req));
  } catch (error) {
    const known = error instanceof ControlHttpError ? error
      : error instanceof z.ZodError ? new ControlHttpError(400, 'bad_request', error.issues[0]?.message ?? 'Invalid input')
      : new ControlHttpError(500, 'failed', error instanceof Error ? error.message : String(error));
    const body: ControlError = { error: { code: known.code, message: known.message } };
    send(res, known.status, body);
  }
}

async function dispatch(method: string, parts: string[], query: URLSearchParams, req: http.IncomingMessage): Promise<unknown> {
  const [head, id, action] = parts;
  if (method === 'GET' && head === 'status' && !id) return status();
  if (method === 'POST' && head === 'connect' && !id) return connectNow();
  if (method === 'GET' && head === 'projects' && !id) return (await listProjects()).map(({ id: projectId, name, path: folder }) => ({ id: projectId, name, path: folder }));
  if (method === 'POST' && head === 'tasks' && !id) return createTask(await readJson(req));
  if (method === 'GET' && head === 'tasks' && !id) return listTasks(Number(query.get('limit')) || 20, query.get('active') === '1');
  if (method === 'GET' && head === 'models' && !id) return listModels();
  if (head === 'tasks' && id && !action && method === 'GET') return taskView(taskId(id));
  if (head === 'tasks' && id && action === 'activity' && method === 'GET') return taskActivity(taskId(id));
  if (head === 'tasks' && id && action === 'cancel' && method === 'POST') return { cancelled: await cancelDesktopInput(taskId(id)) };
  if (method === 'GET' && head === 'sessions' && !id) return listSessions(Number(query.get('limit')) || 20);
  if (head === 'sessions' && id && action === 'read' && method === 'GET') return readSession(sessionId(id), Number(query.get('last')) || 6);
  if (head === 'sessions' && id && action === 'stop' && method === 'POST') return stopSession(sessionId(id));
  if (head === 'sessions' && id && action === 'steer' && method === 'POST') return steerSession(sessionId(id), await readJson(req));
  throw new ControlHttpError(404, 'not_found', 'Unknown endpoint');
}

const taskId = (value: string): string => {
  if (!z.string().uuid().safeParse(value).success) throw new ControlHttpError(400, 'bad_request', 'Task ids are UUIDs');
  return value;
};
const sessionId = (value: string): string => {
  if (!SESSION_ID.test(value)) throw new ControlHttpError(400, 'bad_request', 'Invalid session id');
  return value;
};

/**
 * What stops new work from starting at all. Everything else queues durably and is reported per task.
 * The connector is not on this list: the browser sends and records without it, and only
 * file and tool work inside the chat needs it (`status` reports it separately).
 */
async function notReadyReason(): Promise<string | null> {
  const bridge = await bridgeStatus();
  if (!bridge.paired) return 'The browser extension is not paired. Open the app and finish the browser setup.';
  return null;
}

async function status() {
  const connection = getStatus();
  const bridge = await bridgeStatus();
  const reason = await notReadyReason();
  return {
    protocol: CONTROL_PROTOCOL,
    version: app.getVersion(),
    ready: reason === null,
    ...(reason ? { reason } : {}),
    connection: { state: connection.state, detail: connection.detail },
    browser: { paired: bridge.paired, present: bridge.present, extensionVersion: bridge.extensionVersion }
  };
}

/** Brings up the connector exactly as a desktop send does, then reports the result. */
async function connectNow() {
  const error = await ready().then(() => null, (reason: Error) => reason.message);
  return { ...(await status()), ...(error ? { connectError: error } : {}) };
}

const createTaskArgs = z.object({
  text: z.string().trim().min(1, 'Task text is empty'),
  project: z.string().trim().min(1).optional(),
  session: z.string().optional(),
  model: z.string().max(80).optional(),
  effort: z.enum(REASONING_EFFORTS).optional()
}).strict();

async function resolveProject(name: string): Promise<string> {
  const projects = await listProjects();
  const wanted = name.toLowerCase();
  const exact = projects.filter(project => project.name.toLowerCase() === wanted || project.id === name);
  const matches = exact.length ? exact : projects.filter(project => project.name.toLowerCase().startsWith(wanted));
  if (matches.length === 1) return matches[0]!.id;
  const known = projects.map(project => project.name).join(', ') || 'none';
  throw new ControlHttpError(400, 'bad_request', matches.length ? `Project "${name}" is ambiguous (${matches.map(project => project.name).join(', ')})` : `No project named "${name}". Known projects: ${known}`);
}

async function createTask(body: unknown): Promise<{ taskId: string; sessionId: string | null }> {
  const args = createTaskArgs.parse(body);
  const reason = await notReadyReason();
  if (reason) throw new ControlHttpError(409, 'not_ready', reason);
  let projectId: string | null = args.project ? await resolveProject(args.project) : null;
  let existing: string | null = null;
  if (args.session) {
    existing = sessionId(args.session);
    const session = await getSession(existing);
    if (!session) throw new ControlHttpError(404, 'not_found', 'No such session');
    if (projectId && session.projectId !== projectId) throw new ControlHttpError(400, 'bad_request', 'That session belongs to a different project');
    projectId = session.projectId ?? null;
  }
  const id = crypto.randomUUID();
  const entry = await sendDesktopInput({
    id, sessionId: existing, projectId, text: args.text,
    // A new chat starts immediately; a follow-up waits for the chat's current turn instead of interrupting it.
    mode: existing ? 'after-turn' : 'auto',
    dueAt: Date.now(), model: args.model ?? null, reasoningEffort: args.effort ?? null
  });
  return { taskId: entry.id, sessionId: entry.sessionId ?? null };
}

const FACT_KINDS: SessionEvent['kind'][] = ['user_message', 'assistant_message', 'turn_start', 'turn_end'];
const ACTIVITY_KINDS: SessionEvent['kind'][] = [...FACT_KINDS, 'native_image', 'tool_call', 'page_tool', 'agent_message'];
const FEED_KINDS: SessionEvent['kind'][] = ['user_message', 'turn_start', 'turn_end', 'tool_call', 'page_tool', 'progress', 'chat_error'];

/** Outbox rows a person would call a task: their own sends, newest first. */
const listTaskRows = async (): Promise<InputEntry[]> =>
  // Not decisions, and not the app's own automatic finish/loop follow-ups: those are not tasks a person sent.
  (await listInputs()).filter(row => row.purpose !== 'decision' && !row.finishOwner)
    .sort((a, b) => b.createdAt - a.createdAt);

/** The facts `deriveTask` needs for one entry, reading its session only when it has one. */
async function factsFor(entry: InputEntry): Promise<{ events: SessionEvent[]; activeTurnId: string | null }> {
  const session = entry.sessionId ?? entry.deliveredSessionId ?? null;
  if (!session || !(await getSession(session))) return { events: [], activeTurnId: null };
  // Deep enough that a long run of interim replies cannot push the task's own message out of view.
  const [facts, latest] = await Promise.all([readRecentEvents(session, 1000, { kinds: FACT_KINDS }), readRecentEvents(session, 1, { kinds: ACTIVITY_KINDS })]);
  return { events: [...facts, ...latest.filter(event => !facts.some(known => known.seq === event.seq))], activeTurnId: await liveTurn(session) };
}

async function taskView(id: string): Promise<TaskView> {
  const entry = (await listInputs()).find(row => row.id === id && row.purpose !== 'decision');
  if (!entry) throw new ControlHttpError(404, 'not_found', 'No such task');
  const { events, activeTurnId } = await factsFor(entry);
  const { resultAssetId, ...view } = deriveTask({ entry, events, activeTurnId, now: Date.now() });
  if (!resultAssetId || !view.sessionId) return view;
  // The recorded message is capped; an agent reading the answer must get all of it.
  const full = await readOverflowText(view.sessionId, resultAssetId);
  return full === null ? { ...view, detail: 'Only the start of a long reply could be read.' } : { ...view, result: full };
}

interface TaskListItem { taskId: string; sessionId: string | null; state: TaskState; project: string | null; createdAt: number; text: string }

/** `active` keeps only work that has not settled, for an orchestrator checking what is in flight. */
async function listTasks(limit: number, active = false): Promise<TaskListItem[]> {
  const cap = Math.min(Math.max(limit, 1), 60);
  // Settled outbox rows can never become active again, so skip them before reading any history.
  const rows = (await listTaskRows()).filter(row => !active || (row.state !== 'cancelled' && row.state !== 'failed')).slice(0, active ? 60 : cap);
  const projects = new Map((await listProjects()).map(project => [project.id, project.name]));
  return Promise.all(rows.map(async entry => {
    const session = entry.sessionId ?? entry.deliveredSessionId ?? null;
    // A glance-only list: read one shallow pass of facts and skip the per-row live-turn lookup the
    // detail view does. The only state it costs is the working→stalled refinement, which `cos
    // status`/`follow` on the one task still report accurately.
    const events = session && (await getSession(session)) ? await readRecentEvents(session, 400, { kinds: FACT_KINDS }) : [];
    const { state } = deriveTask({ entry, events, activeTurnId: null, now: Date.now() });
    const oneLine = entry.text.replace(/\s+/g, ' ').trim();
    return { taskId: entry.id, sessionId: session, state,
      project: entry.projectId ? projects.get(entry.projectId) ?? null : null, createdAt: entry.createdAt,
      text: oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine };
  })).then(items => active ? items.filter(item => !TERMINAL_TASK_STATES.includes(item.state)).slice(0, cap) : items);
}

/** The account's model picker as last observed; ids are what `task --model` accepts. */
function listModels() {
  const catalog = getChatModels();
  return { state: catalog.state, observedAt: catalog.observedAt, models: catalog.models.map(({ id, label, efforts }) => ({ id, label, efforts })) };
}

/**
 * Puts a message into a chat's *running* turn, the composer's "Inject now": it reaches ChatGPT in
 * that turn's next tool result instead of waiting for the turn to end or interrupting it.
 */
async function steerSession(id: string, body: unknown): Promise<{ taskId: string; sessionId: string }> {
  const { text } = z.object({ text: z.string().trim().min(1, 'Steering text is empty') }).strict().parse(body);
  const reason = await notReadyReason();
  if (reason) throw new ControlHttpError(409, 'not_ready', reason);
  const session = await getSession(id);
  if (!session) throw new ControlHttpError(404, 'not_found', 'No such session');
  try {
    const entry = await sendDesktopInput({
      id: crypto.randomUUID(), sessionId: id, projectId: session.projectId ?? null, text,
      mode: 'auto', delivery: 'tool', dueAt: Date.now(), model: null, reasoningEffort: null
    });
    return { taskId: entry.id, sessionId: id };
  } catch (error) {
    // The outbox refuses injection unless this exact chat has a turn that can take it.
    if (error instanceof Error && /^Inject/.test(error.message)) {
      throw new ControlHttpError(409, 'failed', `That chat has no running turn that can take a message now. Send a follow-up instead: cos task --session ${id} "…"`);
    }
    throw error;
  }
}

async function taskActivity(id: string): Promise<{ task: TaskView; activity: ActivityItem[] }> {
  const entry = (await listInputs()).find(row => row.id === id && row.purpose !== 'decision');
  if (!entry) throw new ControlHttpError(404, 'not_found', 'No such task');
  const task = await taskView(id);
  const session = task.sessionId;
  if (!session) return { task, activity: [] };
  const events = await readRecentEvents(session, 1500, { kinds: FEED_KINDS });
  return { task, activity: turnActivity(taskTurnEvents(events, entry.id, entry.messageId)) };
}

/** The turn the app is actually driving now; a persisted start alone is history, not activity. */
const liveTurn = (session: string): Promise<string | null> => sessionControlsFor(session).then(controls => controls.activeTurnId, () => null);
const fullText = async (session: string, message: { text: string; truncated: boolean; assetId?: string }): Promise<string> =>
  message.truncated && message.assetId ? (await readOverflowText(session, message.assetId)) ?? message.text : message.text;

async function listSessions(limit: number) {
  const page = await listSessionPage({ limit: Math.min(Math.max(limit, 1), 60) });
  return Promise.all(page.sessions.map(async summary => ({
    id: summary.id, title: summary.title, projectId: summary.projectId ?? null, updatedAt: summary.updatedAt,
    messages: summary.userMessages, working: !!summary.activeTurnId && (await liveTurn(summary.id)) !== null
  })));
}

async function readSession(id: string, last: number) {
  const summary = await getSession(id);
  if (!summary) throw new ControlHttpError(404, 'not_found', 'No such session');
  const events = await readRecentEvents(id, 200, { kinds: ['user_message', 'assistant_message'] });
  const shown = events.filter((event): event is Extract<SessionEvent, { kind: 'user_message' | 'assistant_message' }> =>
    event.kind === 'user_message' || (event.kind === 'assistant_message' && event.final)).slice(-Math.min(Math.max(last, 1), 50));
  // A user row shows what the person wrote, not the executor setup the app framed it with.
  const messages = await Promise.all(shown.map(async event => ({
    role: event.kind === 'user_message' ? 'user' : 'assistant', time: event.time,
    text: event.kind === 'user_message' && event.authoredText ? event.authoredText : await fullText(id, event.message)
  })));
  return { sessionId: id, title: summary.title, messages };
}

async function stopSession(id: string) {
  const turn = await liveTurn(id);
  if (!turn) throw new ControlHttpError(409, 'failed', 'That session has no running turn to stop');
  await stopSessionTurn(id, turn);
  return { stopped: true };
}
