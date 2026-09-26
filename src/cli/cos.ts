/**
 * `cos` — command line for a running Chat On Steroids.
 *
 * Talks to the app's local control endpoint (`main/control.ts`) and nothing else: it starts no
 * browser, reads no session files and holds no state, so what it reports is exactly what the app
 * shows. Node built-ins only, so it runs on the app's bundled Node with nothing to install.
 * `cos mcp` serves the same operations as MCP tools and `cos hook` answers Claude Code hooks.
 */
import { EXIT, type ActivityItem, type TaskState, type TaskView } from '../shared/control.js';
import { CliError, UUID, call, exitForTask, locate, pollTask, pollTasks, runDoctor, type Endpoint, type Waited } from './client.js';
import { runHook } from './hooks.js';
import { runMcp } from './mcp.js';

const USAGE = `cos — send work to ChatGPT through the Chat On Steroids app

Usage:
  cos task <text…> [--project NAME] [--session ID] [--model M] [--effort E] [--wait] [--follow] [--timeout SEC]
  cos steer SESSION_ID <text…> [--wait] [--follow] [--timeout SEC]
                                 Put a message into that chat's running turn without stopping it
  cos tasks [--active] [--limit N]   List recent tasks and their state  (alias: ps)
  cos status [TASK_ID]           App readiness, or one task's state
  cos wait TASK_ID… [--any] [--follow] [--timeout SEC]
                                 Wait for every task (or, with --any, the first) to settle
  cos follow TASK_ID [--timeout SEC]   Stream ChatGPT's thinking and actions until the task ends
  cos sessions [--limit N]
  cos read SESSION_ID [--last N]
  cos stop SESSION_ID            Stop the session's running turn
  cos cancel TASK_ID             Withdraw a task that has not been sent
  cos projects
  cos models                     Models and reasoning efforts this ChatGPT account offers
  cos doctor                     Connect and check every step between this shell and ChatGPT
  cos mcp                        Serve these operations as MCP tools over stdio
  cos hook EVENT                 Answer a Claude Code hook (session-start, guard, track, notify, stop)

Options:
  --json      Print one JSON document on stdout instead of text
  --wait      (task/steer) Block until the answer arrives; prints it on stdout
  --follow    (task/steer/wait) Stream ChatGPT's thinking and actions while waiting  (alias: -f)

Task text may also be piped on stdin.
Exit codes: 0 ok, 1 error, 2 usage, 3 app unreachable, 4 not ready, 5 task failed, 6 timeout, 7 stalled.
CLI access must be switched on in the app's Settings.`;

interface Args { positional: string[]; flags: Map<string, string | true> }
const VALUE_FLAGS = new Set(['project', 'session', 'model', 'effort', 'timeout', 'limit', 'last']);
const SHORT: Record<string, string> = { p: 'project', s: 'session', w: 'wait', f: 'follow', h: 'help' };
/** A mistyped flag must fail, not slip into the text sent to ChatGPT. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  task: ['project', 'session', 'model', 'effort', 'wait', 'follow', 'timeout'], steer: ['wait', 'follow', 'timeout'],
  wait: ['any', 'follow', 'timeout'], follow: ['timeout'], tasks: ['active', 'limit'], ps: ['active', 'limit'],
  sessions: ['limit'], read: ['last'], status: [], stop: [], cancel: [], projects: [], models: [], doctor: []
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

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8').on('data', chunk => { data += chunk; }).on('end', () => resolve(data));
  });
}

/** Compact "just now / 5m ago / 3h ago" for the task list. */
function age(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return 'just now';
  const units: Array<[number, string]> = [[86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [size, tag] of units) if (s >= size) return `${Math.round(s / size)}${tag} ago`;
  return `${s}s ago`;
}
/** Fail fast on a mistyped id rather than sending it to the app. */
const taskArg = (value: string): string => { if (UUID.test(value)) return value; throw new CliError(EXIT.usage, `"${value}" is not a task id. Use the full id from \`cos tasks\`.`, 'usage'); };

/** Four-char tags so the streamed lines line up and stay grep-friendly. */
const ACTIVITY_TAG: Record<ActivityItem['kind'], string> = { thinking: 'think', browsing: 'web  ', tool: 'tool ', error: 'ERR  ' };
const printState = (view: TaskView) => process.stderr.write(`[cos] ${view.state}${view.detail ? ` — ${view.detail}` : ''}\n`);

/** One wait, streaming or plain, chosen by --follow. Progress goes to stderr; `quiet` silences it for --json. */
async function awaitTask(endpoint: Endpoint, taskId: string, timeoutSec: number, follow: boolean, quiet: boolean): Promise<Waited> {
  const view = await pollTask(endpoint, taskId, {
    timeoutSec,
    ...(follow ? { onActivity: item => process.stderr.write(`  ${ACTIVITY_TAG[item.kind]} ${item.text}\n`) } : {}),
    ...(follow || !quiet ? { onState: printState } : {})
  });
  if (view.timedOut && (follow || !quiet)) process.stderr.write(`[cos] timed out after ${timeoutSec}s; still ${view.state}. Run \`cos wait ${taskId}\` to keep waiting.\n`);
  return view;
}

function describe(view: Waited): string {
  const lines = [`task ${view.taskId}: ${view.timedOut ? 'still ' : ''}${view.state}${view.detail ? ` — ${view.detail}` : ''}`];
  if (view.sessionId) lines.push(`session ${view.sessionId}`);
  return lines.join('\n');
}
const answer = (view: Waited): string => view.state === 'done' && !view.timedOut ? (view.result ?? view.detail ?? '') : describe(view);

type Out = (value: unknown, human: string) => void;

/** Sends work (a task or a steer) and optionally waits for it, printing the id first. */
async function sendAndMaybeWait(endpoint: Endpoint, args: Args, out: Out, created: { taskId: string; sessionId: string | null }): Promise<number> {
  if (!args.flags.has('wait') && !args.flags.has('follow')) { out(created, `task ${created.taskId}\nsession ${created.sessionId ?? '-'}`); return EXIT.ok; }
  // If this wait is interrupted, the id is what lets anyone resume it.
  process.stderr.write(`[cos] task ${created.taskId} session ${created.sessionId ?? '-'}\n`);
  const view = await awaitTask(endpoint, created.taskId, count(args, 'timeout') ?? 1800, args.flags.has('follow'), args.flags.has('json'));
  out(view, answer(view));
  return exitForTask(view);
}

async function run(argv: string[], out: Out): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'mcp') return runMcp();
  if (command === 'hook') return runHook(rest[0] ?? '');
  const args = parseArgs(rest);
  if (!command || command === 'help' || command === '--help' || command === '-h' || args.flags.has('help')) { process.stdout.write(`${USAGE}\n`); return command ? EXIT.ok : EXIT.usage; }
  const allowed = COMMAND_FLAGS[command];
  const unknown = allowed && [...args.flags.keys()].find(flag => flag !== 'json' && !allowed.includes(flag));
  if (unknown) throw new CliError(EXIT.usage, `\`cos ${command}\` has no --${unknown} option. Run \`cos --help\`.`, 'usage');
  if (command === 'doctor') {
    const { exit, checks } = await runDoctor(() => process.stderr.write('[cos] connecting the ChatGPT connector…\n'));
    out({ ok: exit === EXIT.ok, checks }, checks.map(check => `${check.warning ? 'warn' : check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`).join('\n'));
    return exit;
  }
  const endpoint = locate();
  const need = (index: number, what: string): string => args.positional[index] ?? (() => { throw new CliError(EXIT.usage, `Missing ${what}. Run \`cos --help\`.`, 'usage'); })();

  switch (command) {
    case 'task': {
      const body = args.positional.join(' ').trim() || (await readStdin()).trim();
      if (!body) throw new CliError(EXIT.usage, 'Give the task as arguments or on stdin.', 'usage');
      return sendAndMaybeWait(endpoint, args, out, await call(endpoint, 'POST', 'tasks', {
        text: body, project: text(args, 'project'), session: text(args, 'session'), model: text(args, 'model'), effort: text(args, 'effort')
      }));
    }
    case 'steer': {
      const session = need(0, 'session id');
      const body = args.positional.slice(1).join(' ').trim() || (await readStdin()).trim();
      if (!body) throw new CliError(EXIT.usage, 'Give the steering message as arguments or on stdin.', 'usage');
      return sendAndMaybeWait(endpoint, args, out, await call(endpoint, 'POST', `sessions/${session}/steer`, { text: body }));
    }
    case 'tasks':
    case 'ps': {
      const rows = await call<Array<{ taskId: string; sessionId: string | null; state: TaskState; project: string | null; createdAt: number; text: string }>>(
        endpoint, 'GET', `tasks?limit=${count(args, 'limit') ?? 20}${args.flags.has('active') ? '&active=1' : ''}`);
      out(rows, rows.length === 0 ? (args.flags.has('active') ? 'no active tasks' : 'no tasks yet')
        : rows.map(row => `${row.taskId.slice(0, 8)}  ${row.state.padEnd(9)}  ${age(row.createdAt).padEnd(8)}  ${row.project ? `[${row.project}] ` : ''}${row.text}`).join('\n'));
      return EXIT.ok;
    }
    case 'follow': {
      const view = await awaitTask(endpoint, taskArg(need(0, 'task id')), count(args, 'timeout') ?? 1800, true, args.flags.has('json'));
      out(view, answer(view));
      return exitForTask(view);
    }
    case 'status': {
      if (args.positional[0]) { const view = await call<TaskView>(endpoint, 'GET', `tasks/${taskArg(args.positional[0])}`); out(view, describe(view)); return view.state === 'stalled' ? EXIT.stalled : EXIT.ok; }
      const status = await call<{ ready: boolean; reason?: string; connection: { state: string }; browser: { paired: boolean; present: boolean } }>(endpoint, 'GET', 'status');
      out(status, `app ${endpoint.version}: ${status.ready ? 'ready' : `not ready — ${status.reason}`}\nconnection ${status.connection.state}; browser ${status.browser.present ? 'present' : status.browser.paired ? 'paired, not seen' : 'not paired'}`);
      return status.ready ? EXIT.ok : EXIT.notReady;
    }
    case 'wait': {
      if (args.positional.length === 0) need(0, 'task id');
      const ids = args.positional.map(taskArg);
      const timeoutSec = count(args, 'timeout') ?? 1800;
      if (ids.length === 1 && !args.flags.has('any')) {
        const view = await awaitTask(endpoint, ids[0]!, timeoutSec, args.flags.has('follow'), args.flags.has('json'));
        out(view, answer(view));
        return exitForTask(view);
      }
      if (args.flags.has('follow')) throw new CliError(EXIT.usage, '--follow streams one task; wait on several without it, or follow each one.', 'usage');
      const views = await pollTasks(endpoint, ids, { timeoutSec, any: args.flags.has('any'), ...(args.flags.has('json') ? {} : { onState: view => process.stderr.write(`[cos] ${view.taskId.slice(0, 8)} ${view.state}\n`) }) });
      out(views, views.map(view => view.state === 'done' && !view.timedOut ? `## task ${view.taskId} (done)\n${view.result ?? view.detail ?? ''}` : `## ${describe(view)}`).join('\n\n'));
      // The worst outcome decides: a failure beats a stall beats a timeout beats success.
      const exits = views.map(exitForTask);
      return [EXIT.taskFailed, EXIT.stalled, EXIT.timeout].find(code => exits.includes(code)) ?? EXIT.ok;
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
      const result = await call<{ cancelled: boolean }>(endpoint, 'POST', `tasks/${taskArg(need(0, 'task id'))}/cancel`);
      out(result, result.cancelled ? 'cancelled' : 'nothing to cancel (already sent or finished)');
      return result.cancelled ? EXIT.ok : EXIT.error;
    }
    case 'projects': {
      const rows = await call<Array<{ id: string; name: string; path: string }>>(endpoint, 'GET', 'projects');
      out(rows, rows.map(row => `${row.name}  ${row.path}`).join('\n'));
      return EXIT.ok;
    }
    case 'models': {
      const catalog = await call<{ state: string; models: Array<{ id: string; label: string; efforts: string[] }> }>(endpoint, 'GET', 'models');
      out(catalog, catalog.models.length === 0 ? `no models observed yet (${catalog.state}); open the model picker in the app once`
        : catalog.models.map(model => `${model.id.padEnd(24)} ${model.label}  [${model.efforts.join(', ')}]`).join('\n'));
      return EXIT.ok;
    }
    default: throw new CliError(EXIT.usage, `Unknown command "${command}". Run \`cos --help\`.`, 'usage');
  }
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const out: Out = (value, human) => { process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : human.endsWith('\n') || human === '' ? human : `${human}\n`); };
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
