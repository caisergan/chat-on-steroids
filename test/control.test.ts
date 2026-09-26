import { describe, expect, it } from 'vitest';
import { activityLine, deriveTask, STALLED_TURN_MS, taskTurnEvents, turnActivity, type TaskFacts } from '../src/shared/control';
import type { SessionEvent } from '../src/shared/session';

const NOW = 10_000_000;
const text = (value: string) => ({ text: value, truncated: false, chars: value.length });
const ev = (seq: number, time: number, rest: Record<string, unknown>) => ({ seq, time, source: 'extension', ...rest }) as unknown as SessionEvent;
const entry = (state: TaskFacts['entry']['state'], extra: Partial<TaskFacts['entry']> = {}): TaskFacts['entry'] => ({ id: 'task-1', state, sessionId: 'sess-1', ...extra });
const facts = (over: Partial<TaskFacts> & Pick<TaskFacts, 'entry'>): TaskFacts => ({ events: [], activeTurnId: null, now: NOW, ...over });
const asked = ev(1, NOW - 5000, { kind: 'user_message', message: text('do it'), inputId: 'task-1' });

describe('deriveTask', () => {
  it('maps outbox states before the message is sent', () => {
    expect(deriveTask(facts({ entry: entry('queued') })).state).toBe('queued');
    expect(deriveTask(facts({ entry: entry('browser', { error: 'Message queued. Browser startup failed: x' }) }))).toEqual({ taskId: 'task-1', sessionId: 'sess-1', state: 'sending' });
    expect(deriveTask(facts({ entry: entry('cancelled') })).state).toBe('cancelled');
    expect(deriveTask(facts({ entry: entry('failed', { error: 'boom' }) }))).toMatchObject({ state: 'failed', detail: 'boom' });
  });

  it('reports a queued message behind a silent running turn as stalled', () => {
    const idle = ev(2, NOW - STALLED_TURN_MS - 60_000, { kind: 'assistant_message', message: text('x'), final: false });
    const view = deriveTask(facts({ entry: entry('queued'), events: [idle], activeTurnId: 'turn-1' }));
    expect(view).toMatchObject({ state: 'stalled', stalledMinutes: 11 });
    expect(deriveTask(facts({ entry: entry('queued'), events: [idle], activeTurnId: null })).state).toBe('queued');
  });

  it('stays working until the turn after the exact message ends', () => {
    const start = ev(2, NOW - 4000, { kind: 'turn_start' });
    expect(deriveTask(facts({ entry: entry('sent'), events: [asked, start], activeTurnId: 't' })).state).toBe('working');
  });

  it('returns the last final reply when the turn completes', () => {
    const events = [
      asked,
      ev(2, NOW - 4000, { kind: 'assistant_message', message: text('draft'), final: false }),
      ev(3, NOW - 3000, { kind: 'assistant_message', message: text('answer'), final: true }),
      ev(4, NOW - 2000, { kind: 'turn_end', outcome: 'completed' })
    ];
    expect(deriveTask(facts({ entry: entry('sent'), events }))).toMatchObject({ state: 'done', result: 'answer' });
  });

  it('does not credit an earlier turn to this message', () => {
    const before = [
      ev(1, NOW - 9000, { kind: 'assistant_message', message: text('old'), final: true }),
      ev(2, NOW - 8000, { kind: 'turn_end', outcome: 'completed' })
    ];
    const events = [...before, ev(3, NOW - 5000, { kind: 'user_message', message: text('do it'), inputId: 'task-1' })];
    expect(deriveTask(facts({ entry: entry('sent'), events, activeTurnId: 't' })).state).toBe('working');
  });

  it('fails a stopped or errored turn and names the reason', () => {
    const stopped = [asked, ev(2, NOW - 2000, { kind: 'turn_end', outcome: 'stopped' })];
    expect(deriveTask(facts({ entry: entry('sent'), events: stopped }))).toMatchObject({ state: 'failed', detail: 'The turn was stopped.' });
  });

  it('flags a running turn with no progress for ten minutes', () => {
    const old = ev(1, NOW - STALLED_TURN_MS - 1, { kind: 'user_message', message: text('do it'), inputId: 'task-1' });
    expect(deriveTask(facts({ entry: entry('sent'), events: [old], activeTurnId: 't' })).state).toBe('stalled');
    // No longer live and never finished is stalled too, so `wait` stops instead of polling for the whole timeout.
    expect(deriveTask(facts({ entry: entry('sent'), events: [old], activeTurnId: null }))).toMatchObject({ state: 'stalled' });
  });

  it('matches the message by receipt id when the input id was not attached', () => {
    const byMessage = ev(1, NOW - 5000, { kind: 'user_message', message: text('do it'), messageId: 'm-1' });
    const end = ev(2, NOW - 1000, { kind: 'turn_end', outcome: 'completed' });
    expect(deriveTask(facts({ entry: entry('sent', { messageId: 'm-1' }), events: [byMessage, end] })).state).toBe('done');
  });

  it('does not take a later question\'s answer as this task\'s answer', () => {
    const events = [
      asked,
      ev(2, NOW - 4000, { kind: 'user_message', message: text('next'), inputId: 'task-2' }),
      ev(3, NOW - 3000, { kind: 'assistant_message', message: text('other answer'), final: true }),
      ev(4, NOW - 2000, { kind: 'turn_end', outcome: 'completed' })
    ];
    expect(deriveTask(facts({ entry: entry('sent'), events })).state).toBe('working');
  });

  it('keeps working when a failed view is reopened by fresh work', () => {
    const events = [
      asked,
      ev(2, NOW - 4000, { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed' }),
      ev(3, NOW - 3000, { kind: 'tool_call', call: {} })
    ];
    expect(deriveTask(facts({ entry: entry('sent'), events, activeTurnId: 't' })).state).toBe('working');
    const done = [...events, ev(4, NOW - 2500, { kind: 'assistant_message', message: text('ok'), final: true }), ev(5, NOW - 2000, { kind: 'turn_end', outcome: 'completed' })];
    expect(deriveTask(facts({ entry: entry('sent'), events: done }))).toMatchObject({ state: 'done', result: 'ok' });
  });

  it('points at the full text when the stored reply was capped', () => {
    const events = [
      asked,
      ev(2, NOW - 3000, { kind: 'assistant_message', message: { ...text('start…'), truncated: true, assetId: 'a1' }, final: true }),
      ev(3, NOW - 2000, { kind: 'turn_end', outcome: 'completed' })
    ];
    expect(deriveTask(facts({ entry: entry('sent'), events }))).toMatchObject({ state: 'done', resultAssetId: 'a1' });
  });
});

describe('turn activity', () => {
  const prog = (seq: number, time: number, id: string, text: string, origin: number) => ev(seq, time, { kind: 'progress', message: { text, truncated: false, chars: text.length }, progressId: id, origin });
  const tool = (seq: number, time: number, callId: string, title: string) => ev(seq, time, { kind: 'tool_call', call: { callId, summary: { title, tone: 'neutral', kind: 'read' } } });

  it('slices a task turn to its own message and the next question', () => {
    const events = [
      ev(1, 1, { kind: 'user_message', message: text('a'), inputId: 'task-1' }),
      ev(2, 2, { kind: 'progress', message: text('thinking'), progressId: 'p1', origin: 2 }),
      ev(3, 3, { kind: 'user_message', message: text('b'), inputId: 'task-2' }),
      ev(4, 4, { kind: 'progress', message: text('later'), progressId: 'p2', origin: 4 })
    ];
    const turn = taskTurnEvents(events, 'task-1');
    expect(turn.map(e => e.kind)).toEqual(['progress']);
    expect(taskTurnEvents(events, 'missing')).toEqual([]);
  });

  it('renders each event family as a line', () => {
    expect(activityLine(prog(1, 1, 'p1', 'reasoning…', 1))).toEqual({ kind: 'thinking', text: 'reasoning…' });
    expect(activityLine(ev(1, 1, { kind: 'page_tool', messageId: 'm', label: 'Searching the web' }))).toEqual({ kind: 'browsing', text: 'Searching the web' });
    expect(activityLine(tool(1, 1, 'c1', 'Read src/main.ts'))).toEqual({ kind: 'tool', text: 'Read src/main.ts' });
    expect(activityLine(ev(1, 1, { kind: 'turn_start' }))).toBeNull();
  });

  it('collapses a growing caption to one item carrying its latest text', () => {
    const turn = [prog(2, 2, 'p1', 'Reading', 2), prog(3, 3, 'p1', 'Reading files', 2), tool(4, 4, 'c1', 'Read a.ts')];
    const activity = turnActivity(turn);
    expect(activity).toEqual([
      { origin: 2, seq: 3, at: 3, kind: 'thinking', text: 'Reading files' },
      { origin: 4, seq: 4, at: 4, kind: 'tool', text: 'Read a.ts' }
    ]);
  });
});
