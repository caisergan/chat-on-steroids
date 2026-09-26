/**
 * Contract between the app's local control endpoint (`main/control.ts`) and the `cos` CLI.
 *
 * Nothing here owns state: a task is one outbox input and its session, and its state is derived
 * from those records every time it is asked for. The CLI and the endpoint share this file so the
 * exit codes and task states cannot drift apart.
 */
import type { SessionEvent } from './session.js';

export const CONTROL_PROTOCOL = 1;

/** Process exit codes of `cos`. Scripts and agents branch on these, so they are append-only. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  /** The app is not running, or its CLI access is switched off. */
  unreachable: 3,
  /** The app is running but ChatGPT or the browser is not ready to take work. */
  notReady: 4,
  /** The task ended without an answer: failed, stopped or cancelled. */
  taskFailed: 5,
  timeout: 6,
  /** ChatGPT still reports the turn as running but has shown no progress. */
  stalled: 7
} as const;

export type TaskState = 'queued' | 'sending' | 'working' | 'stalled' | 'done' | 'failed' | 'cancelled';

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['done', 'failed', 'cancelled'];

/** Same threshold the queue's "waiting behind a stalled turn" notice uses. */
export const STALLED_TURN_MS = 10 * 60_000;

export interface TaskView {
  taskId: string;
  sessionId: string | null;
  state: TaskState;
  /** Why the task is in this state, in a sentence a person can act on. */
  detail?: string;
  /** Present once the turn has ended with an answer. */
  result?: string;
  /** The stored reply was capped; the endpoint replaces `result` with this asset's full text. */
  resultAssetId?: string;
  /** Minutes since ChatGPT last showed progress; only set while stalled. */
  stalledMinutes?: number;
}

export interface TaskFacts {
  entry: {
    id: string;
    state: 'queued' | 'browser' | 'tool' | 'sent' | 'cancelled' | 'failed' | 'decision';
    sessionId: string | null;
    deliveredSessionId?: string | null;
    error?: string;
    messageId?: string;
  };
  /** The session's recorded events, oldest first. */
  events: SessionEvent[];
  /** The session's turn as the app currently controls it; null when it is idle. */
  activeTurnId: string | null;
  now: number;
}

const ACTIVITY: ReadonlySet<SessionEvent['kind']> = new Set(['assistant_message', 'native_image', 'tool_call', 'page_tool', 'agent_message', 'turn_start', 'user_message']);

export function deriveTask(facts: TaskFacts): TaskView {
  const { entry, events, activeTurnId, now } = facts;
  const sessionId = entry.sessionId ?? entry.deliveredSessionId ?? null;
  const view = (state: TaskState, extra: Partial<TaskView> = {}): TaskView => ({ taskId: entry.id, sessionId, state, ...extra });
  const lastActivity = Math.max(0, ...events.filter(event => ACTIVITY.has(event.kind)).map(event => event.time));
  const idleMs = lastActivity > 0 ? now - lastActivity : 0;
  const idle = lastActivity > 0 && idleMs >= STALLED_TURN_MS;
  // A queued message can only be *behind* a stalled turn while one is genuinely live. An
  // unfinished sent task is stalled either way: a live turn sitting idle, or one the app no
  // longer tracks and that never produced an answer — both mean "stop waiting for this".
  const stalled = activeTurnId !== null && idle;
  const stall = { stalledMinutes: Math.floor(idleMs / 60_000) };

  if (entry.state === 'cancelled') return view('cancelled');
  if (entry.state === 'failed') return view('failed', { detail: entry.error ?? 'The message could not be sent.' });
  if (entry.state === 'queued') {
    if (stalled) return view('stalled', { ...stall, detail: 'Waiting behind a ChatGPT turn that shows no progress. Stop it to continue.' });
    return view('queued', entry.error ? { detail: entry.error } : {});
  }
  // A startup error recorded while queued is history once the browser has claimed the message.
  if (entry.state !== 'sent') return view('sending');

  if (!events.some(event => isUserMessage(event, entry.id, entry.messageId))) {
    return stalled ? view('stalled', { ...stall, detail: 'ChatGPT has the message but has shown no progress.' })
      : view('working', { detail: 'ChatGPT has the message; waiting for its turn to be recorded.' });
  }
  // This message's answer ends at the next question; a later turn never belongs to this task.
  const turn = taskTurnEvents(events, entry.id, entry.messageId);
  const endAt = turn.findLastIndex(event => event.kind === 'turn_end' && event.outcome !== 'unknown');
  const end = turn[endAt] as Extract<SessionEvent, { kind: 'turn_end' }> | undefined;
  // Fresh work after an end (e.g. after a Thinking-failed view) reopens the same turn.
  const reopened = end && turn.slice(endAt + 1).some(event => event.kind === 'tool_call' || event.kind === 'turn_start' ||
    (event.kind === 'assistant_message' && event.time > end.time));
  if (!end || reopened) {
    if (!idle) return view('working');
    return view('stalled', { ...stall, detail: activeTurnId !== null
      ? 'ChatGPT still reports the turn as running but has shown no progress.'
      : 'The turn is no longer running and never produced an answer. Read the chat or resend.' });
  }
  if (end.outcome !== 'completed') return view('failed', { detail: end.outcome === 'stopped' ? 'The turn was stopped.' : `The turn ended: ${end.detail ?? end.outcome}.` });
  const reply = turn.slice(0, endAt).findLast((event): event is Extract<SessionEvent, { kind: 'assistant_message' }> => event.kind === 'assistant_message' && event.final);
  return view('done', reply ? { result: reply.message.text, ...(reply.message.truncated ? { resultAssetId: reply.message.assetId } : {}) }
    : { detail: 'The turn completed without a recorded final reply.' });
}

/** Recorded order: a revised message keeps the position where it first appeared. */
const originOf = (event: SessionEvent): number => ('origin' in event && typeof event.origin === 'number' ? event.origin : event.seq);
const isUserMessage = (event: SessionEvent, taskId: string, messageId?: string): boolean =>
  event.kind === 'user_message' && (event.inputId === taskId || (!!messageId && event.messageId === messageId));

/**
 * The events that belong to one task's turn: everything after its own `user_message` and before
 * the next question in the same chat. Shared so the live feed and the derived state read the same
 * window; returns an empty array when the task's message is not recorded yet.
 */
export function taskTurnEvents(events: SessionEvent[], taskId: string, messageId?: string): SessionEvent[] {
  const ordered = [...events].sort((a, b) => originOf(a) - originOf(b));
  const anchor = ordered.findIndex(event => isUserMessage(event, taskId, messageId));
  if (anchor < 0) return [];
  const next = ordered.findIndex((event, index) => index > anchor && event.kind === 'user_message');
  return ordered.slice(anchor + 1, next < 0 ? undefined : next);
}

/** What ChatGPT is doing, in the same four families the app's timeline shows. */
export type ActivityKind = 'thinking' | 'browsing' | 'tool' | 'error';
export interface ActivityItem { origin: number; seq: number; at: number; kind: ActivityKind; text: string }

/** One event rendered as a live line, or null when it is not visible activity. */
export function activityLine(event: SessionEvent): { kind: ActivityKind; text: string } | null {
  if (event.kind === 'progress') return { kind: 'thinking', text: event.message.text };
  if (event.kind === 'page_tool') return { kind: 'browsing', text: event.label };
  if (event.kind === 'chat_error') return { kind: 'error', text: event.message.text };
  if (event.kind === 'tool_call') {
    const { title, detail, metric } = event.call.summary;
    return { kind: 'tool', text: `${title}${detail ? ` (${detail})` : ''}${metric ? ` ${metric}` : ''}` };
  }
  return null;
}

/** Identity of the *logical* activity item, so a caption that grows in place stays one line. */
const activityId = (event: SessionEvent): string =>
  event.kind === 'progress' ? `p:${event.progressId ?? event.seq}`
  : event.kind === 'page_tool' ? `g:${event.messageId}`
  : event.kind === 'tool_call' ? `t:${event.call.callId}`
  : `e:${event.seq}`;

/**
 * Collapses a turn's events into its ordered activity, each logical item carrying its latest text
 * at its first-seen position. A reader that remembers the last text it printed per `origin` gets a
 * clean growing log without a cursor protocol.
 */
export function turnActivity(turn: SessionEvent[]): ActivityItem[] {
  const byId = new Map<string, { origin: number; event: SessionEvent }>();
  for (const event of turn) {
    if (!activityLine(event)) continue;
    const id = activityId(event);
    const prior = byId.get(id);
    // Keep the newest revision's text, but the earliest position it appeared at.
    if (!prior || event.seq >= prior.event.seq) byId.set(id, { origin: Math.min(originOf(event), prior?.origin ?? originOf(event)), event });
  }
  return [...byId.values()]
    .map(({ origin, event }) => ({ origin, seq: event.seq, at: event.time, ...activityLine(event)! }))
    .sort((a, b) => a.origin - b.origin);
}

/** Wire errors carry a stable `code` so the CLI can pick an exit code without parsing prose. */
export type ControlErrorCode = 'unauthorized' | 'disabled' | 'not_ready' | 'not_found' | 'bad_request' | 'failed';
export interface ControlError { error: { code: ControlErrorCode; message: string } }

/** Discovery file the app writes next to the token; the CLI never guesses an endpoint. */
export interface ControlDiscovery { protocol: number; endpoint: string; pid: number; version: string }
