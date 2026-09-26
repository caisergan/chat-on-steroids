import { describe, expect, it } from 'vitest';

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterAll, beforeAll } from 'vitest';
import { createMcpHandler, TOOLS } from '../src/cli/mcp';

/** A stand-in control endpoint on a real Unix socket (a named pipe on Windows), so the real client code runs. */
const calls: Array<{ method: string; route: string; body?: unknown }> = [];
let responses: Record<string, unknown> = {};
let dir: string, socket: string, fake: http.Server;
beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cos-mcp-')); socket = process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(dir)}` : path.join(dir, 's');
  fake = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      const route = (req.url ?? '').replace(/^\/v1\//, '');
      calls.push({ method: req.method ?? '', route, body: body ? JSON.parse(body) : undefined });
      const found = route in responses;
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(found ? responses[route] : { error: { code: 'not_found', message: `no route ${route}` } }));
    });
  });
  await new Promise<void>(resolve => fake.listen(socket, resolve));
});
afterAll(async () => { await new Promise(resolve => fake.close(resolve)); rmSync(dir, { recursive: true, force: true }); });

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function server(locate = () => ({ socket, token: 't', version: '1' })) {
  const sent: any[] = [];
  const handle = createMcpHandler({ locate, version: '1', write: message => { sent.push(message); } });
  return { sent, handle };
}

describe('cos mcp', () => {
  it('initializes and lists every tool with a schema', async () => {
    const { sent, handle } = server();
    await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(sent[0].result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'chat-on-steroids' } });
    await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = sent[1].result.tools.map((tool: any) => tool.name);
    expect(names).toEqual(['task', 'wait', 'steer', 'status', 'tasks', 'activity', 'read', 'stop', 'cancel', 'sessions', 'projects', 'models', 'doctor']);
    for (const tool of sent[1].result.tools) expect(tool.inputSchema.type).toBe('object');
    expect(sent).toHaveLength(2);
  });

  it('sends a task and returns its id without waiting by default', async () => {
    responses = { tasks: { taskId: A, sessionId: A }, [`tasks/${A}`]: { taskId: A, sessionId: A, state: 'queued' } };
    const { sent, handle } = server();
    await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task', arguments: { text: 'hello', project: 'paseo' } } });
    expect(calls.find(c => c.route === 'tasks')?.body).toMatchObject({ text: 'hello', project: 'paseo' });
    expect(sent[0].result.content[0].text).toContain(`task: ${A}`);
    expect(sent[0].result.content[0].text).toContain('state: queued');
  });

  it('returns the answer of a finished task', async () => {
    const done = { taskId: A, sessionId: A, state: 'done', result: 'forty-two' };
    responses = { [`tasks/${A}/activity`]: { task: done, activity: [{ origin: 1, seq: 1, at: 1, kind: 'thinking', text: 'Computing' }] } };
    const { sent, handle } = server();
    await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wait', arguments: { task_ids: [A], seconds: 5 }, _meta: { progressToken: 'p' } } });
    // Progress notifications carry ChatGPT's activity while the call waits.
    expect(sent[0]).toMatchObject({ method: 'notifications/progress', params: { progressToken: 'p', message: 'thinking: Computing' } });
    expect(sent.at(-1).result.content[0].text).toMatch(/state: done[\s\S]*forty-two/);
  });

  it('waits on several tasks: any returns at the first to settle, all reports each state', async () => {
    const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    responses = { [`tasks/${A}`]: { taskId: A, sessionId: A, state: 'working' }, [`tasks/${B}`]: { taskId: B, sessionId: B, state: 'done', result: 'second' } };
    const { sent, handle } = server();
    await handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'wait', arguments: { task_ids: [A, B], mode: 'any', seconds: 30 } } });
    const text = sent.at(-1).result.content[0].text;
    expect(text).toMatch(new RegExp(`task: ${A}[\\s\\S]*state: working[\\s\\S]*task: ${B}[\\s\\S]*state: done[\\s\\S]*second`));
    const started = Date.now();
    await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'wait', arguments: { task_ids: [A, B], seconds: 1 } } });
    expect(sent.at(-1).result.content[0].text).toContain('state: working (still running; call wait again)');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports failures as tool errors the model can act on', async () => {
    responses = {};
    const { sent, handle } = server(() => ({ socket: path.join(dir, 'missing'), token: 't', version: '1' }));
    await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'status', arguments: {} } });
    expect(sent[0].result).toMatchObject({ isError: true });
    expect(sent[0].result.content[0].text).toMatch(/^unreachable: Could not reach the app/);
    await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'wait', arguments: { task_ids: ['nope'] } } });
    expect(sent[1].result.content[0].text).toContain('is not a task id');
    await handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'bogus' } });
    expect(sent[2].error.code).toBe(-32602);
  });

  it('describes every tool', () => {
    for (const tool of TOOLS) expect(tool.description.length).toBeGreaterThan(40);
  });
});
