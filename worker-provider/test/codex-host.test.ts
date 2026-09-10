import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRemoteTurn, visibleReply } from '../runtime/remote-turn.mjs';
import { redactSensitiveText } from 'openclaw/plugin-sdk/logging-core';
import { lifecycleFixture } from './codex-e2e/lifecycle-fixture.mjs';
import * as hostRuntime from '../runtime/remote-turn.mjs';

test('sleep preparation waits for the same draining lease and records readiness', async () => {
  assert.equal(typeof hostRuntime.prepareHostSleep, 'function');
  let now = 1000;
  const calls: any[] = [], observed: string[] = [];
  const ready = { status: 'ready', suspensionId: 'lease', expiresAtMs: 121000, activeCount: 0, blockers: [] };
  const result = await hostRuntime.prepareHostSleep({ requestId: 'host-event', now: () => now,
    sleep: async (ms: number) => { now += ms; }, observe: (s: any) => observed.push(s.status),
    rpc: async (method: string, params: any) => {
      calls.push([method, params]);
      return calls.length === 1 ? { ...ready, status: 'draining', retryAfterMs: 20000, activeCount: 1, blockers: [{ kind: 'chat-run', count: 1 }] } : { status: 'ready', expiresAtMs: ready.expiresAtMs };
    },
  });
  assert.deepEqual(result, ready);
  assert.equal(now, 21000);
  assert.deepEqual(observed, ['draining', 'ready']);
  assert.deepEqual(calls, [['gateway.suspend.prepare', { requestId: 'host-event', terminalPolicy: 'preserve', drain: true }], ['gateway.suspend.status', { suspensionId: 'lease' }]]);
});

test('sleep preparation fails closed on blockers, expiry or a changed lease', async () => {
  assert.equal(typeof hostRuntime.prepareHostSleep, 'function');
  for (const response of [
    { status: 'busy', activeCount: 1 },
    { status: 'ready', suspensionId: 'lease', expiresAtMs: 1, activeCount: 0, blockers: [] },
    { status: 'ready', suspensionId: 'lease', expiresAtMs: 200000, activeCount: 1, blockers: [] },
    { status: 'draining', suspensionId: 'lease', expiresAtMs: 200000, activeCount: 1, blockers: [], retryAfterMs: 20000 },
  ]) {
    let now = 1000;
    await assert.rejects(hostRuntime.prepareHostSleep({ requestId: 'x', now: () => now, timeoutMs: 10000, sleep: async (ms: number) => { now += ms; }, rpc: async () => response }));
  }
  let calls = 0, now = 1000;
  await assert.rejects(hostRuntime.prepareHostSleep({ requestId: 'x', now: () => now, sleep: async (ms: number) => { now += ms; },
    rpc: async () => (++calls === 1 ? { status: 'draining', suspensionId: 'lease', expiresAtMs: 200000, retryAfterMs: 1 } : { status: 'ready', suspensionId: 'different', expiresAtMs: 200000, activeCount: 0, blockers: [] }),
  }), /lease changed/);
});

test('recall fixture survives secret redaction without disabling protection or leaking the answer into turn two', () => {
  const fixture = lifecycleFixture();
  assert(!redactSensitiveText(`Conversation token: ${fixture.nickname}`).includes(fixture.nickname));
  const reply = redactSensitiveText(`Project nickname: ${fixture.nickname}\nFile contents: ${fixture.fileContent}`);
  fixture.assertReply(reply, 1);
  assert(!fixture.messages[1].includes(fixture.nickname));
  assert(!fixture.messages[1].includes(fixture.fileContent));
  assert.throws(() => fixture.assertReply(fixture.fileContent, 1));
  assert.throws(() => fixture.assertReply(fixture.nickname, 1));
});

const terminal = (runId: string, text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], __openclaw: { runId, runTerminal: true } });

test('host replies are tied to the completed run, never an older response or tool output', () => {
  const messages = [terminal('old', 'old answer'), { ...terminal('new', 'tool input'), __openclaw: { runId: 'new' } }, terminal('new', 'answer')];
  assert.equal(visibleReply({ messages }, 'new'), 'answer');
  assert.throws(() => visibleReply({ messages }, 'missing'));
  assert.throws(() => visibleReply({ messages: [terminal('new', '')] }, 'new'));
});

test('a second host task reuses the saved session but dispatches and approves a fresh worker', async () => {
  let saved: any;
  let launches = 0;
  const calls: string[] = [];
  const session = { key: 'agent:main:slack-c123', sessionId: 'session-1', worktree: { path: '/managed/worktree' } };
  const placement = { state: 'active', environmentId: 'env', remoteWorkspaceDir: '/remote/worktree', activeOwnerEpoch: 1, generation: 1 };
  const rpc = async (method: string) => {
    calls.push(method);
    if (method === 'sessions.describe') return { session: saved ? session : null };
    if (method === 'sessions.create') return session;
    if (method === 'sessions.dispatch') return { placement };
    if (method === 'sessions.reclaim') return {};
    throw new Error(method);
  };
  const options = { base: '/runtime', sessionKey: 'agent:main:slack-C123', rpc, loadSession: async () => saved, saveSession: async (_: string, next: any) => { saved = next; },
    connectOperator: async () => ({ send: async () => ({ runId: 'run' }), wait: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { status: 'ok' }; },
      approveLaunch: async (expected: any) => { assert.equal(expected.sessionId, 'session-1'); assert.equal(expected.nodeId, `node-${launches}`); return true; },
      request: async () => ({ messages: [terminal('run', 'done')] }), close: async () => {}, cancel: async () => {} }),
    workerFor: async () => { launches++; return { nodeId: `node-${launches}`, name: `worker-${launches}`, assertStopped: async () => { calls.push('worker-stopped'); } }; },
  };
  const first = await runRemoteTurn({ ...options, eventId: 'Ev1', message: 'remember' });
  const second = await runRemoteTurn({ ...options, eventId: 'Ev2', message: 'recall' });
  assert.equal(first.sessionId, second.sessionId);
  assert.notEqual(first.workerName, second.workerName);
  assert.equal(calls.filter(call => call === 'sessions.create').length, 1);
  assert.equal(calls.filter(call => call === 'sessions.dispatch').length, 2);
  assert.equal(calls.filter(call => call === 'sessions.reclaim').length, 2);
  assert.equal(calls.filter(call => call === 'worker-stopped').length, 2);
});

test('changed session identity fails before dispatching any code', async () => {
  const methods: string[] = [];
  await assert.rejects(runRemoteTurn({ sessionKey: 'agent:main:slack-C123', eventId: 'Ev1', message: 'test', base: '/runtime',
    loadSession: async () => ({ sessionId: 'saved' }), rpc: async (method: string) => { methods.push(method); return { session: { sessionId: 'changed' } }; },
  }), /identity changed/);
  assert.deepEqual(methods, ['sessions.describe']);
});
