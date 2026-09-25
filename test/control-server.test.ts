import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';

const { cfg, sendDesktopInput, ready, store, listInputs } = vi.hoisted(() => ({
  ready: vi.fn(async () => undefined),
  cfg: { ui: { cliControl: true } },
  sendDesktopInput: vi.fn(async (input: { id: string; sessionId: string | null }) => ({ id: input.id, sessionId: input.sessionId ?? input.id })),
  listInputs: vi.fn(async () => [] as any[]),
  store: {
    getSession: vi.fn(async (_id: string) => null as any),
    listSessionPage: vi.fn(async () => ({ sessions: [] as any[] })),
    readRecentEvents: vi.fn(async () => [] as any[]),
    readOverflowText: vi.fn(async () => null)
  }
}));
vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }));
vi.mock('../src/main/config', () => ({ getConfig: () => cfg }));
vi.mock('../src/main/connection', () => ({ getStatus: () => ({ state: 'connected', detail: '' }) }));
vi.mock('../src/main/bridge', () => ({
  bridgeStatus: async () => ({ paired: true, present: true, extensionVersion: '1' }),
  sessionControlsFor: async () => ({ activeTurnId: null }),
  stopSessionTurn: vi.fn()
}));
vi.mock('../src/main/logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../src/main/chat-models', () => ({ getChatModels: () => ({ state: 'ready', requestedAt: 1, observedAt: 2, models: [{ id: 'gpt-5-6', label: 'GPT-5.6', efforts: ['low', 'high'], aliases: ['x'] }] }) }));
vi.mock('../src/main/projects', () => ({ listProjects: async () => [{ id: '11111111-1111-4111-8111-111111111111', name: 'Paseo', path: '/p' }] }));
vi.mock('../src/main/session/store', () => store);
vi.mock('../src/main/session/input', () => ({ listInputs }));
vi.mock('../src/main/session/start-input', () => ({ sendDesktopInput, ready, cancelDesktopInput: async () => false }));

import { applyControlSetting, controlEndpoint, initControl } from '../src/main/control';

let dir: string;
const request = (method: string, route: string, token: string | null, body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
  const req = http.request({ socketPath: controlEndpoint(dir), path: `/v1/${route}`, method, headers: token ? { authorization: `Bearer ${token}` } : {} }, res => {
    let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }));
  });
  req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
});
const token = () => readFileSync(path.join(dir, 'control', 'token'), 'utf8');

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cos-')); initControl(dir); cfg.ui.cliControl = true;
  sendDesktopInput.mockClear();
  listInputs.mockResolvedValue([]);
  store.getSession.mockResolvedValue(null); store.listSessionPage.mockResolvedValue({ sessions: [] });
  store.readRecentEvents.mockResolvedValue([]); store.readOverflowText.mockResolvedValue(null);
  await applyControlSetting();
});
afterEach(async () => { cfg.ui.cliControl = false; await applyControlSetting(); rmSync(dir, { recursive: true, force: true }); });

describe('control endpoint', () => {
  it('keeps the token and socket private to the user', () => {
    if (process.platform === 'win32') return;
    expect(statSync(path.join(dir, 'control', 'token')).mode & 0o077).toBe(0);
    expect(statSync(controlEndpoint(dir)).mode & 0o077).toBe(0);
  });
  it('rejects requests without the exact token', async () => {
    expect((await request('GET', 'status', null)).status).toBe(401);
    expect((await request('GET', 'status', 'wrong')).status).toBe(401);
    expect((await request('GET', 'status', token())).json).toMatchObject({ ready: true, version: '9.9.9' });
  });
  it('is gone once switched off', async () => {
    cfg.ui.cliControl = false; await applyControlSetting();
    await expect(request('GET', 'status', 'x')).rejects.toThrow();
  });
  it('creates a task in a named project and reports it as a new chat', async () => {
    const res = await request('POST', 'tasks', token(), { text: ' hello ', project: 'pas' });
    expect(res.status).toBe(200);
    expect(sendDesktopInput).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello', projectId: '11111111-1111-4111-8111-111111111111', sessionId: null, mode: 'auto' }));
    expect(res.json.taskId).toBe(res.json.sessionId);
  });
  it('names the known projects when one does not match', async () => {
    const res = await request('POST', 'tasks', token(), { text: 'x', project: 'nope' });
    expect(res.status).toBe(400);
    expect(res.json.error.message).toContain('Paseo');
    expect(sendDesktopInput).not.toHaveBeenCalled();
  });
  it('opens one listener when enable is saved twice quickly', async () => {
    cfg.ui.cliControl = false; await applyControlSetting();
    cfg.ui.cliControl = true;
    await Promise.all([applyControlSetting(), applyControlSetting()]);
    expect((await request('GET', 'status', token())).status).toBe(200);
  });
  it('connects the way a send does and reports why it could not', async () => {
    expect((await request('POST', 'connect', token())).json).not.toHaveProperty('connectError');
    ready.mockRejectedValueOnce(new Error('tunnel-client was not found.'));
    expect((await request('POST', 'connect', token())).json).toMatchObject({ connectError: 'tunnel-client was not found.' });
    expect(ready).toHaveBeenCalledTimes(2);
  });
  it('rejects unknown fields and malformed ids', async () => {
    expect((await request('POST', 'tasks', token(), { text: 'x', extra: 1 })).status).toBe(400);
    expect((await request('GET', 'tasks/not-a-uuid', token())).status).toBe(400);
  });
});

describe('controlEndpoint', () => {
  it('keeps the socket in the private control folder when the path is short', () => {
    expect(controlEndpoint('/home/u/cos', 'linux', 1000)).toBe('/home/u/cos/control/s');
  });
  it('falls back to the temp dir when the path would overflow the socket limit', () => {
    expect(controlEndpoint(`/Users/${'x'.repeat(120)}/chat-on-steroids`, 'darwin', 501)).toMatch(/cos-501-[0-9a-f]{12}\.sock$/);
  });
  it('uses a named pipe on Windows', () => {
    expect(controlEndpoint('C:\\Users\\u\\AppData\\Roaming\\chat-on-steroids', 'win32')).toMatch(/^\\\\\.\\pipe\\chat-on-steroids-[0-9a-f]{12}$/);
  });
});

describe('task list and activity', () => {
  const text = (t: string) => ({ text: t, truncated: false, chars: t.length });
  const entry = (over: Record<string, unknown>) => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', state: 'sent', sessionId: 's1abcdef', purpose: 'user', text: 'do the thing', mode: 'auto', createdAt: 1000, ...over });

  it('lists a person\'s tasks with derived state, newest first', async () => {
    listInputs.mockResolvedValue([
      entry({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: 1000, projectId: '11111111-1111-4111-8111-111111111111' }),
      entry({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt: 2000, state: 'queued', sessionId: null }),
      { ...entry({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }), purpose: 'decision' }
    ]);
    store.getSession.mockResolvedValue({ id: 's1abcdef', conversationId: 'c1' });
    store.readRecentEvents.mockResolvedValue([{ seq: 1, time: 1, kind: 'user_message', message: text('do'), inputId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, { seq: 2, time: 2, kind: 'turn_end', outcome: 'completed' }]);
    const { json } = await request('GET', 'tasks', token());
    expect(json.map((r: any) => r.taskId)).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
    expect(json.find((r: any) => r.taskId.startsWith('aaaa'))).toMatchObject({ state: 'done', project: 'Paseo' });
  });

  it('returns a task\'s thinking and tool activity', async () => {
    const t = Date.now();
    listInputs.mockResolvedValue([entry({})]);
    store.getSession.mockResolvedValue({ id: 's1abcdef', conversationId: 'c1' });
    store.readRecentEvents.mockResolvedValue([
      { seq: 1, time: t - 4, kind: 'user_message', message: text('do'), inputId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { seq: 2, time: t - 3, kind: 'progress', message: text('Reading'), progressId: 'p1', origin: 2 },
      { seq: 3, time: t - 2, kind: 'progress', message: text('Reading files'), progressId: 'p1', origin: 2 },
      { seq: 4, time: t - 1, kind: 'tool_call', call: { callId: 'x', summary: { title: 'Read a.ts', tone: 'neutral', kind: 'read' } } }
    ]);
    const { json } = await request('GET', 'tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/activity', token());
    expect(json.task.state).toBe('working');
    expect(json.activity.map((a: any) => ({ origin: a.origin, seq: a.seq, kind: a.kind, text: a.text }))).toEqual([
      { origin: 2, seq: 3, kind: 'thinking', text: 'Reading files' },
      { origin: 4, seq: 4, kind: 'tool', text: 'Read a.ts' }
    ]);
  });
});

describe('orchestration routes', () => {
  const text = (t: string) => ({ text: t, truncated: false, chars: t.length });
  const row = (id: string, over: Record<string, unknown> = {}) => ({ id, state: 'sent', sessionId: 's1abcdef', purpose: 'user', text: 't', mode: 'auto', createdAt: 1, ...over });

  it('lists the account models without internal aliases', async () => {
    expect((await request('GET', 'models', token())).json).toEqual({ state: 'ready', observedAt: 2, models: [{ id: 'gpt-5-6', label: 'GPT-5.6', efforts: ['low', 'high'] }] });
  });

  it('keeps only unsettled tasks when asked for active ones', async () => {
    const t = Date.now();
    listInputs.mockResolvedValue([
      row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { state: 'queued', sessionId: null }),
      row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { state: 'cancelled' })
    ]);
    store.getSession.mockResolvedValue({ id: 's1abcdef' });
    store.readRecentEvents.mockResolvedValue([
      { seq: 1, time: t, kind: 'user_message', message: text('t'), inputId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { seq: 2, time: t, kind: 'turn_end', outcome: 'completed' }
    ]);
    const { json } = await request('GET', 'tasks?active=1', token());
    expect(json.map((r: any) => r.taskId)).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
  });

  it('steers a running turn through the outbox injection path', async () => {
    store.getSession.mockResolvedValue({ id: 's1abcdef', projectId: '11111111-1111-4111-8111-111111111111' });
    const res = await request('POST', 'sessions/s1abcdef/steer', token(), { text: ' focus on tests ' });
    expect(res.status).toBe(200);
    expect(sendDesktopInput).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1abcdef', text: 'focus on tests', delivery: 'tool', mode: 'auto', projectId: '11111111-1111-4111-8111-111111111111' }));
  });

  it('explains how to follow up when the chat has no turn to steer', async () => {
    store.getSession.mockResolvedValue({ id: 's1abcdef' });
    sendDesktopInput.mockRejectedValueOnce(new Error('Inject up to 10 images into an active chat; otherwise use Send or After this turn'));
    const res = await request('POST', 'sessions/s1abcdef/steer', token(), { text: 'x' });
    expect(res.status).toBe(409);
    expect(res.json.error.message).toContain('cos task --session s1abcdef');
  });
});
