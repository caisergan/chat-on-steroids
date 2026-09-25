import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { cosCall, findSecret, handleHook, outgoingText, seenTasks, type HookDeps } from '../src/cli/hooks';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let dir: string;
let views: Record<string, unknown>;
const deps = (over: Partial<HookDeps> = {}): HookDeps => ({
  stateDir: dir, env: {}, now: 1_000_000,
  get: async route => { if (!(route in views)) throw new Error(`unexpected ${route}`); return views[route]; },
  ...over
});
const bashTask = (response: unknown) => ({ session_id: 'claude-1', tool_name: 'Bash', tool_input: { command: 'cos task "fix the tests" --project paseo' }, tool_response: response });

beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'cos-hooks-')); views = {}; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('guard', () => {
  it('only inspects calls that send text to ChatGPT', () => {
    expect(outgoingText('Bash', { command: 'git status' })).toBeNull();
    expect(outgoingText('Bash', { command: 'cos tasks --active' })).toBeNull();
    expect(outgoingText('Bash', { command: 'node out/main/cos.js steer s1 "focus"' })).toContain('steer');
    expect(outgoingText('mcp__plugin_chat-on-steroids_chatgpt__task', { text: 'hi' })).toBe('hi');
  });
  it('finds credentials but not ordinary code', () => {
    expect(findSecret('key is AKIAABCDEFGHIJKLMNOP')).toBe('an AWS access key');
    expect(findSecret(`token ghp_${'a'.repeat(36)}`)).toBe('a GitHub token');
    expect(findSecret('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe('a private key');
    expect(findSecret('const apiKey = process.env.OPENAI_API_KEY; // sk-... placeholder')).toBeNull();
    expect(findSecret('Refactor the task-skeleton component')).toBeNull();
  });
  it('denies a send that carries a secret and explains how to fix it', async () => {
    const out = await handleHook('guard', { tool_name: 'Bash', tool_input: { command: `cos task "deploy with sk-proj-${'x'.repeat(40)}"` } }, deps());
    expect(out).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
    expect(await handleHook('guard', { tool_name: 'Bash', tool_input: { command: 'cos task "add tests"' } }, deps())).toBeNull();
  });
});

describe('tracking and notifications', () => {
  it('classifies cos calls as sending or reading', () => {
    expect(cosCall('Bash', { command: 'cos task "x"' })).toBe('send');
    expect(cosCall('Bash', { command: `cos wait ${A} --timeout 540` })).toBe('read');
    expect(cosCall('Bash', { command: 'cos tasks --active' })).toBeNull();
    expect(cosCall('mcp__plugin_chat-on-steroids_chatgpt__steer', {})).toBe('send');
    expect(cosCall('mcp__plugin_chat-on-steroids_chatgpt__wait', {})).toBe('read');
    expect(cosCall('mcp__plugin_chat-on-steroids_chatgpt__activity', {})).toBeNull();
  });

  it('reads each task id with its own state from every output shape', () => {
    const one = (input: Record<string, unknown>, response: unknown) => Object.fromEntries(seenTasks(input, response).states);
    expect(one({}, { stdout: `task ${A}\nsession ${A}\n`, stderr: '' })).toEqual({ [A]: null });
    expect(one({}, { stdout: 'the answer', stderr: `[cos] task ${A} session s1abcdef\n[cos] working\n[cos] done\n` })).toEqual({ [A]: 'done' });
    expect(one({}, [{ type: 'text', text: `task: ${A}\nsession: s1abcdef\nstate: working (still running; call wait again)` }])).toEqual({ [A]: 'working' });
    // A plain `cos wait ID` names the task only in its command.
    expect(one({ command: `cos wait ${A}` }, { stdout: 'forty-two', stderr: '[cos] working\n[cos] done\n' })).toEqual({ [A]: 'done' });
    // Several tasks keep their own states, in human and JSON form.
    expect(one({}, { stdout: `## task ${A} (done)\nok\n\n## task ${B}: still working\nsession s2`, stderr: '' })).toEqual({ [A]: 'done', [B]: 'working' });
    expect(one({}, { stdout: JSON.stringify([{ taskId: A, sessionId: A, state: 'failed' }, { taskId: B, sessionId: B, state: 'done' }], null, 2) })).toEqual({ [A]: 'failed', [B]: 'done' });
    // A follow-up's different session id is not mistaken for a task.
    expect(one({}, [{ type: 'text', text: `task: ${A}\nsession: ${B}\nstate: done\n\nanswer` }])).toEqual({ [A]: 'done' });
  });

  it('treats a wait that showed the answer as read, so stop does not hold the turn', async () => {
    await handleHook('track', { session_id: 'claude-1', tool_name: 'mcp__plugin_chat-on-steroids_chatgpt__task', tool_input: { text: 'x' }, tool_response: [{ type: 'text', text: `task: ${A}\nsession: ${A}\nstate: queued` }] }, deps());
    await handleHook('track', { session_id: 'claude-1', tool_name: 'mcp__plugin_chat-on-steroids_chatgpt__wait', tool_input: { task_ids: [A] }, tool_response: [{ type: 'text', text: `task: ${A}\nsession: ${A}\nstate: done\n\npong` }] }, deps());
    views[`tasks/${A}`] = { taskId: A, sessionId: A, state: 'done', result: 'pong' };
    expect(await handleHook('stop', { session_id: 'claude-1', stop_hook_active: false }, deps())).toBeNull();
  });

  it('never adopts a task it only read', async () => {
    await handleHook('track', { session_id: 'claude-1', tool_name: 'Bash', tool_input: { command: `cos wait ${B}` }, tool_response: { stdout: 'x', stderr: '[cos] working\n' } }, deps());
    expect(await handleHook('stop', { session_id: 'claude-1' }, deps())).toBeNull();
  });

  it('announces a tracked task once when it finishes', async () => {
    await handleHook('track', bashTask({ stdout: `task ${A}\nsession s1abcdef\n` }), deps());
    views[`tasks/${A}`] = { taskId: A, sessionId: 's1abcdef', state: 'working' };
    expect(await handleHook('notify', { session_id: 'claude-1' }, deps())).toBeNull();
    views[`tasks/${A}`] = { taskId: A, sessionId: 's1abcdef', state: 'done', result: 'All tests pass.' };
    const out = await handleHook('notify', { session_id: 'claude-1' }, deps()) as any;
    expect(out.hookSpecificOutput.additionalContext).toContain(`task ${A} in session s1abcdef is done`);
    expect(out.hookSpecificOutput.additionalContext).toContain('All tests pass.');
    expect(await handleHook('notify', { session_id: 'claude-1' }, deps())).toBeNull();
  });

  it('does not re-announce a task Claude already waited on', async () => {
    await handleHook('track', bashTask({ stdout: 'answer', stderr: `[cos] task ${A} session s1abcdef\n[cos] done\n` }), deps());
    expect(await handleHook('notify', { session_id: 'claude-1' }, deps())).toBeNull();
  });

  it('ignores cos commands that do not start work', async () => {
    await handleHook('track', { session_id: 'claude-1', tool_name: 'Bash', tool_input: { command: 'cos tasks --json' }, tool_response: { stdout: `"taskId": "${A}"` } }, deps());
    expect(await handleHook('notify', { session_id: 'claude-1' }, deps())).toBeNull();
  });
});

describe('stop', () => {
  it('holds the turn once for unread results and unmentioned running work', async () => {
    await handleHook('track', bashTask({ stdout: `task ${A}\nsession s1\n` }), deps());
    await handleHook('track', { ...bashTask({ stdout: `task ${B}\nsession s2\n` }) }, deps());
    views[`tasks/${A}`] = { taskId: A, sessionId: 's1abcdef', state: 'done', result: 'ok' };
    views[`tasks/${B}`] = { taskId: B, sessionId: 's2abcdef', state: 'working' };
    const out = await handleHook('stop', { session_id: 'claude-1', stop_hook_active: false }, deps()) as any;
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(`task ${A} in session s1abcdef is done`);
    expect(out.reason).toContain(`task ${B} in session s2abcdef is still working`);
    // Once told, the same state does not hold the next stop again.
    expect(await handleHook('stop', { session_id: 'claude-1', stop_hook_active: false }, deps())).toBeNull();
  });
  it('never blocks a stop the hook itself caused, or when switched off', async () => {
    await handleHook('track', bashTask({ stdout: `task ${A}\n` }), deps());
    views[`tasks/${A}`] = { taskId: A, sessionId: null, state: 'working' };
    expect(await handleHook('stop', { session_id: 'claude-1', stop_hook_active: true }, deps())).toBeNull();
    expect(await handleHook('stop', { session_id: 'claude-1' }, deps({ env: { COS_HOOK_STOP: 'off' } }))).toBeNull();
  });
  it('stays quiet when the app is closed', async () => {
    await handleHook('track', bashTask({ stdout: `task ${A}\n` }), deps());
    expect(await handleHook('stop', { session_id: 'claude-1' }, deps({ get: null }))).toBeNull();
    expect(await handleHook('session-start', {}, deps({ get: null }))).toBeNull();
  });
});

describe('session start', () => {
  it('lists ChatGPT work already in flight', async () => {
    views['tasks?active=1&limit=10'] = [{ taskId: A, sessionId: 's1abcdef', state: 'working', project: 'paseo', text: 'port the UI' }];
    const out = await handleHook('session-start', {}, deps()) as any;
    expect(out.hookSpecificOutput.additionalContext).toContain(`${A} (working, project paseo, session s1abcdef): port the UI`);
  });
});
