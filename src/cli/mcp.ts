/**
 * `cos mcp`: the cos operations as MCP tools over stdio, for Claude Code and other MCP clients.
 *
 * A thin layer over `client.ts`, so a tool and its CLI command cannot disagree. Newline-delimited
 * JSON-RPC with Node built-ins only. Every tool call locates the app afresh, so the server can start
 * before the app does. Tool failures are tool results (`isError`), never protocol errors, so the
 * model reads what went wrong and what to do.
 */
import { createInterface } from 'node:readline';
import { EXIT, type ActivityItem, type TaskView } from '../shared/control.js';
import { REASONING_EFFORTS } from '../shared/session.js';
import { APP_VERSION } from '../main/version.js';
import { CliError, UUID, call, locate, pollTask, pollTasks, runDoctor, type Endpoint, type Waited } from './client.js';

/** Longest wait one tool call may hold; long work is waited on across several calls. */
export const MAX_WAIT_SECONDS = 540;
/** Keep one result inside a client's tool-output budget; the chat keeps the full text. */
const MAX_TEXT = 80_000;

type Json = Record<string, unknown>;
interface Tool { name: string; description: string; inputSchema: Json; run: (args: Json, context: ToolContext) => Promise<string> }
interface ToolContext { endpoint: () => Endpoint; signal: AbortSignal; progress: (message: string) => void }

const str = { type: 'string' } as const;
const seconds = (fallback: number) => ({ type: 'integer', minimum: 0, maximum: MAX_WAIT_SECONDS, description: `Seconds to wait before returning (default ${fallback}, max ${MAX_WAIT_SECONDS}). 0 returns at once.` });
const schema = (properties: Json, required: string[] = []): Json => ({ type: 'object', properties, required, additionalProperties: false });

function arg(args: Json, name: string, kind: 'string'): string | undefined;
function arg(args: Json, name: string, kind: 'number'): number | undefined;
function arg(args: Json, name: string, kind: 'boolean'): boolean | undefined;
function arg(args: Json, name: string, kind: 'string' | 'number' | 'boolean'): unknown {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== kind) throw new CliError(EXIT.usage, `${name} must be a ${kind}`, 'usage');
  return value;
}
const required = (args: Json, name: string): string => {
  const value = arg(args, name, 'string')?.trim();
  if (!value) throw new CliError(EXIT.usage, `${name} is required`, 'usage');
  return value;
};
const taskId = (value: string): string => { if (UUID.test(value)) return value; throw new CliError(EXIT.usage, `"${value}" is not a task id; use the full id from the tasks tool`, 'usage'); };
const waitSeconds = (args: Json, fallback: number): number => Math.min(Math.max(Math.floor(arg(args, 'seconds', 'number') ?? fallback), 0), MAX_WAIT_SECONDS);

const clip = (text: string): string => text.length <= MAX_TEXT ? text
  : `${text.slice(0, MAX_TEXT)}\n\n[… ${text.length - MAX_TEXT} more characters. Read the whole chat with the read tool.]`;

/** A task as the model should read it: state first, then the answer or what to do next. */
function renderTask(view: Waited): string {
  const head = [`task: ${view.taskId}`, `session: ${view.sessionId ?? '-'}`, `state: ${view.timedOut ? `${view.state} (still running; call wait again)` : view.state}`];
  if (view.detail) head.push(`detail: ${view.detail}`);
  if (view.stalledMinutes !== undefined) head.push(`no progress for: ${view.stalledMinutes} min`);
  return view.state === 'done' && !view.timedOut ? `${head.join('\n')}\n\n${view.result ?? ''}` : head.join('\n');
}
const json = (value: unknown) => JSON.stringify(value, null, 2);
const activityLine = (item: ActivityItem) => `${item.kind}: ${item.text}`;

async function waitOne(context: ToolContext, id: string, timeoutSec: number): Promise<Waited> {
  if (timeoutSec === 0) return call<TaskView>(context.endpoint(), 'GET', `tasks/${id}`);
  return pollTask(context.endpoint(), id, { timeoutSec, signal: context.signal, onActivity: item => context.progress(activityLine(item)), onState: view => context.progress(`state: ${view.state}`) });
}

export const TOOLS: Tool[] = [
  {
    name: 'task',
    description: 'Send a task to ChatGPT through the Chat On Steroids app. Without session it opens a new ChatGPT chat; with session it queues a follow-up in that chat after its current turn. project gives ChatGPT that local project folder. Returns the task id at once (seconds 0, the default) or waits for the answer. ChatGPT cannot see this conversation: write a self-contained brief.',
    inputSchema: schema({
      text: { ...str, description: 'The complete, self-contained task for ChatGPT.' },
      project: { ...str, description: 'Project name from the projects tool; ChatGPT works in that folder.' },
      session: { ...str, description: 'Existing session id to continue instead of opening a new chat.' },
      model: { ...str, description: 'Model id from the models tool; omit to keep the chat\'s current model.' },
      effort: { type: 'string', enum: [...REASONING_EFFORTS], description: 'Reasoning effort for the model.' },
      seconds: seconds(0)
    }, ['text']),
    async run(args, context) {
      const created = await call<{ taskId: string; sessionId: string | null }>(context.endpoint(), 'POST', 'tasks', {
        text: required(args, 'text'), project: arg(args, 'project', 'string'), session: arg(args, 'session', 'string'),
        model: arg(args, 'model', 'string'), effort: arg(args, 'effort', 'string')
      });
      return renderTask(await waitOne(context, created.taskId, waitSeconds(args, 0)));
    }
  },
  {
    name: 'wait',
    description: `Wait for tasks to settle (done, failed, cancelled or stalled) and return their answers. mode "all" (default) waits for every task, "any" returns when the first settles. Returns early with "still running" after seconds (max ${MAX_WAIT_SECONDS}); call again to keep waiting.`,
    inputSchema: schema({
      task_ids: { type: 'array', items: str, minItems: 1, maxItems: 20, description: 'Task ids to wait for.' },
      mode: { type: 'string', enum: ['all', 'any'] },
      seconds: seconds(300)
    }, ['task_ids']),
    async run(args, context) {
      const ids = Array.isArray(args.task_ids) ? args.task_ids.map(value => taskId(String(value))) : [];
      if (ids.length === 0) throw new CliError(EXIT.usage, 'task_ids needs at least one id', 'usage');
      const timeoutSec = waitSeconds(args, 300);
      if (ids.length === 1) return renderTask(await waitOne(context, ids[0]!, timeoutSec));
      const views = await pollTasks(context.endpoint(), ids, { timeoutSec, any: args.mode === 'any', signal: context.signal, onState: view => context.progress(`${view.taskId.slice(0, 8)}: ${view.state}`) });
      return views.map(renderTask).join('\n\n---\n\n');
    }
  },
  {
    name: 'steer',
    description: 'Put a message into a chat\'s RUNNING turn without stopping it (ChatGPT receives it with its next tool result). Use it to correct course mid-task. Fails if that chat has no running turn; then send a follow-up with task + session instead.',
    inputSchema: schema({ session: { ...str, description: 'Session id of the running chat.' }, text: { ...str, description: 'The correction or extra instruction.' }, seconds: seconds(0) }, ['session', 'text']),
    async run(args, context) {
      const created = await call<{ taskId: string }>(context.endpoint(), 'POST', `sessions/${required(args, 'session')}/steer`, { text: required(args, 'text') });
      return renderTask(await waitOne(context, created.taskId, waitSeconds(args, 0)));
    }
  },
  {
    name: 'status',
    description: 'With task_id: that task\'s current state (and answer, once done). Without: whether the app, the ChatGPT connector and the browser are ready.',
    inputSchema: schema({ task_id: str }),
    async run(args, context) {
      const id = arg(args, 'task_id', 'string');
      return id ? renderTask(await call<TaskView>(context.endpoint(), 'GET', `tasks/${taskId(id)}`)) : json(await call(context.endpoint(), 'GET', 'status'));
    }
  },
  {
    name: 'tasks',
    description: 'List recent ChatGPT tasks with their state, project and text. active_only lists just the ones still queued, sending, working or stalled; check it before delegating so you do not pile work onto a busy chat.',
    inputSchema: schema({ active_only: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 60 } }),
    async run(args, context) {
      const limit = arg(args, 'limit', 'number') ?? 20;
      return json(await call(context.endpoint(), 'GET', `tasks?limit=${limit}${arg(args, 'active_only', 'boolean') ? '&active=1' : ''}`));
    }
  },
  {
    name: 'activity',
    description: 'What ChatGPT is doing in a task right now: its thinking captions, web browsing and tool calls (file reads, edits, commands), newest last. Use it to check progress on a long task or decide whether to steer or stop it.',
    inputSchema: schema({ task_id: str, last: { type: 'integer', minimum: 1, maximum: 200, description: 'How many recent lines (default 40).' } }, ['task_id']),
    async run(args, context) {
      const feed = await call<{ task: TaskView; activity: ActivityItem[] }>(context.endpoint(), 'GET', `tasks/${taskId(required(args, 'task_id'))}/activity`);
      const lines = feed.activity.slice(-(arg(args, 'last', 'number') ?? 40)).map(activityLine);
      return `${renderTask({ ...feed.task, result: undefined })}\n\n${lines.length ? lines.join('\n') : '(no activity recorded yet)'}`;
    }
  },
  {
    name: 'read',
    description: 'Read the latest messages of a ChatGPT chat (session), user and assistant, in full.',
    inputSchema: schema({ session: str, last: { type: 'integer', minimum: 1, maximum: 50 } }, ['session']),
    async run(args, context) {
      const read = await call<{ title: string; messages: Array<{ role: string; text: string }> }>(context.endpoint(), 'GET', `sessions/${required(args, 'session')}/read?last=${arg(args, 'last', 'number') ?? 6}`);
      return `# ${read.title}\n\n${read.messages.map(message => `## ${message.role}\n${message.text}`).join('\n\n')}`;
    }
  },
  {
    name: 'stop',
    description: 'Stop the running turn of a chat, like pressing Stop in ChatGPT. Use when a task went wrong or is stalled.',
    inputSchema: schema({ session: str }, ['session']),
    async run(args, context) { await call(context.endpoint(), 'POST', `sessions/${required(args, 'session')}/stop`); return 'stopped'; }
  },
  {
    name: 'cancel',
    description: 'Withdraw a task that has not been sent to ChatGPT yet (queued). A task already sent cannot be cancelled; stop its session instead.',
    inputSchema: schema({ task_id: str }, ['task_id']),
    async run(args, context) {
      const result = await call<{ cancelled: boolean }>(context.endpoint(), 'POST', `tasks/${taskId(required(args, 'task_id'))}/cancel`);
      return result.cancelled ? 'cancelled' : 'nothing to cancel: the task was already sent or finished (use stop on its session)';
    }
  },
  {
    name: 'sessions',
    description: 'List recent ChatGPT chats (sessions) known to the app, newest first.',
    inputSchema: schema({ limit: { type: 'integer', minimum: 1, maximum: 60 } }),
    async run(args, context) { return json(await call(context.endpoint(), 'GET', `sessions?limit=${arg(args, 'limit', 'number') ?? 20}`)); }
  },
  {
    name: 'projects',
    description: 'List the local project folders ChatGPT can be given with task.project.',
    inputSchema: schema({}),
    async run(_args, context) { return json(await call(context.endpoint(), 'GET', 'projects')); }
  },
  {
    name: 'models',
    description: 'List the models and reasoning efforts this ChatGPT account offers, for task.model and task.effort.',
    inputSchema: schema({}),
    async run(_args, context) { return json(await call(context.endpoint(), 'GET', 'models')); }
  },
  {
    name: 'doctor',
    description: 'Check, and bring up where possible, every link between here and ChatGPT: the app, the ChatGPT connector and the browser extension. Run it first when anything fails.',
    inputSchema: schema({}),
    async run(_args, context) {
      const { exit, checks } = await runDoctor(() => context.progress('connecting the ChatGPT connector…'));
      return `${exit === EXIT.ok ? 'ready' : 'NOT READY'}\n${checks.map(check => `${check.warning ? 'warn' : check.ok ? 'ok' : 'FAIL'} ${check.name}: ${check.detail}`).join('\n')}`;
    }
  }
];

const INSTRUCTIONS = `Controls ChatGPT through the Chat On Steroids desktop app on this computer. Each task runs in a real ChatGPT chat; with a project, ChatGPT can read and edit that folder and run commands there. ChatGPT cannot see this conversation, so every task text must be a complete brief. Send independent tasks without waiting (seconds 0), then collect them with wait. Check tasks (active_only) before delegating, activity to watch progress, steer to correct a running turn, stop to end one. Verify ChatGPT's changes yourself before relying on them. If a tool reports the app unreachable, CLI access is off or the app is closed: ask the user to open Chat On Steroids and enable Settings → CLI access.`;

export interface McpDeps { locate: () => Endpoint; version: string; write: (message: Json) => void }

/** The protocol core, independent of stdio so it can be driven directly in tests. */
export function createMcpHandler(deps: McpDeps) {
  const running = new Map<string | number, AbortController>();
  const reply = (id: string | number, result: Json) => deps.write({ jsonrpc: '2.0', id, result });
  const fail = (id: string | number, code: number, message: string) => deps.write({ jsonrpc: '2.0', id, error: { code, message } });

  async function callTool(id: string | number, params: Json): Promise<void> {
    const tool = TOOLS.find(candidate => candidate.name === params.name);
    if (!tool) return fail(id, -32602, `Unknown tool: ${String(params.name)}`);
    const controller = new AbortController();
    running.set(id, controller);
    const token = (params._meta as Json | undefined)?.progressToken as string | number | undefined;
    let step = 0;
    const progress = (message: string) => { if (token !== undefined) deps.write({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } }); };
    try {
      const text = await tool.run((params.arguments as Json | undefined) ?? {}, { endpoint: deps.locate, signal: controller.signal, progress });
      reply(id, { content: [{ type: 'text', text: clip(text) }] });
    } catch (error) {
      const message = error instanceof CliError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
      reply(id, { content: [{ type: 'text', text: message }], isError: true });
    } finally { running.delete(id); }
  }

  return async function handle(message: Json): Promise<void> {
    const { id, method } = message as { id?: string | number; method?: string };
    const params = (message.params as Json | undefined) ?? {};
    if (method === 'notifications/cancelled') { running.get(params.requestId as string | number)?.abort(); return; }
    if (id === undefined || id === null) return; // Other notifications need no answer.
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'chat-on-steroids', version: deps.version }, instructions: INSTRUCTIONS
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (method === 'tools/call') return callTool(id, params);
    fail(id, -32601, `Method not found: ${String(method)}`);
  };
}

/** Serves until stdin closes. The exit code is only for a broken transport. */
export function runMcp(): Promise<number> {
  const handle = createMcpHandler({ locate, version: APP_VERSION, write: message => { process.stdout.write(`${JSON.stringify(message)}\n`); } });
  const pending = new Set<Promise<void>>();
  return new Promise(resolve => {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on('line', line => {
      if (!line.trim()) return;
      let message: Json;
      try { message = JSON.parse(line) as Json; } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
        return;
      }
      const work = handle(message).catch(error => { process.stderr.write(`cos mcp: ${error instanceof Error ? error.message : String(error)}\n`); });
      pending.add(work); void work.finally(() => pending.delete(work));
    });
    lines.on('close', () => { void Promise.allSettled([...pending]).then(() => resolve(EXIT.ok)); });
  });
}
