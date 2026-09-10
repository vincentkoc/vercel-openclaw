import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export async function prepareHostSleep({ rpc, requestId, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), observe = () => {}, timeoutMs = 60_000 }) {
  const deadline = now() + timeoutMs;
  let result = await rpc('gateway.suspend.prepare', { requestId, terminalPolicy: 'preserve', drain: true });
  const suspensionId = result.suspensionId;
  while (true) {
    observe(result);
    assert(typeof suspensionId === 'string' && suspensionId && result.suspensionId === suspensionId, 'Suspension lease changed or missing');
    assert(Number.isFinite(result.expiresAtMs) && result.expiresAtMs > now() + 15_000, 'Suspension lease expired');
    if (result.status === 'ready') {
      assert(result.activeCount === 0 && Array.isArray(result.blockers) && result.blockers.length === 0, 'Ready suspension still has blockers');
      return result;
    }
    assert(result.status === 'draining', `Gateway cannot suspend: ${result.status}`);
    assert(Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0, 'Invalid suspension retry delay');
    assert(now() + result.retryAfterMs < deadline, `Suspension drain deadline reached: ${JSON.stringify(result.blockers)}`);
    await sleep(result.retryAfterMs);
    const status = await rpc('gateway.suspend.status', { suspensionId });
    assert(status.suspensionId === undefined || status.suspensionId === suspensionId, 'Suspension lease changed');
    // Status deliberately omits the lease ID and idle counts from its ready response.
    result = { ...(status.status === 'ready' ? { activeCount: 0, blockers: [] } : {}), ...status, suspensionId };
  }
}

export function visibleReply(history, runId) {
  const last = history.messages.findLast(message => message.role === 'assistant' && message.__openclaw?.runId === runId && message.__openclaw?.runTerminal === true);
  assert(last, 'No terminal assistant message for this run');
  const text = typeof last.content === 'string' ? last.content : (last.content ?? [])
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n');
  assert(text.trim(), 'No channel-visible answer');
  return text;
}

export async function runRemoteTurn({ sessionKey, eventId, message, base, rpc, connectOperator, workerFor, saveSession, loadSession, startNativeTurn, awaitNativeDelivery, observe = () => {} }) {
  assert(/^agent:main:(slack-[A-Z0-9]+|slack:(channel:[A-Z0-9]+|direct:[A-Z0-9]+)(:thread:[0-9]+\.[0-9]+)?|main)$/i.test(sessionKey), 'Invalid host session key');
  sessionKey = sessionKey.toLowerCase();
  assert(typeof eventId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(eventId), 'Explicit event identity required');
  assert(typeof message === 'string' && message.trim() && message.length <= 40_000, 'Invalid message');
  let session = await loadSession(sessionKey);
  if (session) {
    const current = (await rpc('sessions.describe', { key: sessionKey })).session;
    assert(current?.sessionId === session.sessionId, 'Saved session identity changed');
  } else {
    const existing = (await rpc('sessions.describe', { key: sessionKey })).session;
    assert(!existing, 'Unowned pre-existing session');
    session = await rpc('sessions.create', { key: sessionKey, worktree: true, cwd: `${base}/repo`, worktreeName: `slack-${createHash('sha256').update(sessionKey).digest('hex').slice(0,16)}` });
    assert(session.key === sessionKey && session.sessionId && session.worktree?.path, 'Missing managed session');
    await saveSession(sessionKey, session);
  }
  let operator;
  observe('session-ready');
  let dispatched = false;
  try {
    dispatched = true;
    const { placement } = await rpc('sessions.dispatch', { key: sessionKey, profileId: 'vercel' }, 180_000);
    assert(placement?.state === 'active', 'Worker placement is not active');
    observe('worker-dispatched');
    const worker = await workerFor(placement);
    observe('worker-ready');
    operator = await connectOperator(sessionKey);
    const expected = { sessionKey, sessionId: session.sessionId, environmentId: placement.environmentId, nodeId: worker.nodeId, cwd: placement.remoteWorkspaceDir, ownerEpoch: placement.activeOwnerEpoch, placementGeneration: placement.generation };
    const turn = startNativeTurn ? await startNativeTurn(operator, expected) : await operator.send(message, eventId);
    observe('turn-started');
    let finished = false;
    let approved = false;
    const approvals = (async () => {
      while (!finished) {
        if (await operator.approveLaunch({ ...expected, runId: turn.runId })) approved = true;
        if (!finished) await new Promise(resolve => setTimeout(resolve, 200));
      }
    })();
    const completion = operator.wait(turn.runId).finally(() => { finished = true; });
    // An approval failure must abort the pending turn, not leave a second unobserved promise.
    const approvalResult = approvals.catch(async error => { await operator.cancel(turn.runId).catch(() => {}); throw error; });
    const [result] = await Promise.all([completion, approvalResult]);
    assert(approved && result.status === 'ok', 'Codex turn did not complete with its exact launch approval');
    observe('turn-completed');
    const reply = visibleReply(await operator.request('chat.history', { sessionKey, limit: 100 }), turn.runId);
    if (awaitNativeDelivery) await awaitNativeDelivery();
    observe('reply-delivered');
    await rpc('sessions.reclaim', { key: sessionKey }, 60_000);
    await worker.assertStopped();
    dispatched = false;
    return { reply, sessionId: session.sessionId, worktree: session.worktree.path, workerName: worker.name, runId: turn.runId, ...(startNativeTurn ? { nativeSlackDelivered: true } : {}) };
  } finally {
    try { await operator?.close(); }
    finally { if (dispatched) await rpc('sessions.reclaim', { key: sessionKey }, 60_000); }
  }
}
