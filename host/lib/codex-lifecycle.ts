import { Sandbox, Snapshot, type NetworkPolicy } from '@vercel/sandbox';
import { createExecutionBudget, operationTimeoutMs, type ExecutionBudget } from './execution-budget';
import { codexPhaseRunner, retryableReadinessError } from './codex-diagnostics';

export const CODEX_BASE = '/tmp/openclaw-codex-e2e';
export const CODEX_OWNER = 'openclaw-connect-codex-v1';
const RESUME_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 45_000;
const STOP_RESERVE_MS = STOP_TIMEOUT_MS + 20_000;

export interface CodexTurnReceipt {
  reply: string;
  sessionId: string;
  worktree: string;
  workerName: string;
  runId: string;
  gatewayStopped: true;
  nativeSlackDelivered?: true;
  vm1SnapshotId?: string;
  phases?: { phase: string; at: number }[];
  suspension: { status: 'ready'; suspensionId: string; expiresAtMs: number };
}

export function parseCodexReceipt(stdout: string, now = Date.now()): CodexTurnReceipt {
  const lines = stdout.split('\n').filter(line => line.startsWith('OPENCLAW_HOST_RESULT='));
  if (lines.length !== 1) throw new Error('Missing unique Codex lifecycle receipt');
  const value = JSON.parse(lines[0].slice('OPENCLAW_HOST_RESULT='.length)) as CodexTurnReceipt;
  if (!value.reply?.trim() || !value.sessionId || !value.workerName || !value.runId ||
      value.gatewayStopped !== true || value.suspension?.status !== 'ready' ||
      !value.suspension.suspensionId || !Number.isFinite(value.suspension.expiresAtMs) ||
      value.suspension.expiresAtMs <= now) throw new Error('Incomplete Codex lifecycle receipt');
  return value;
}

export function codexHostPolicy(modelKey: string, slackToken?: string): NetworkPolicy {
  if (!modelKey.trim()) throw new Error('AI_GATEWAY_API_KEY required for Codex');
  // VM1 is the trusted controller; VM2 retains the provider's gateway-only egress policy.
  return { allow: { 'ai-gateway.vercel.sh': [{ transform: [{ headers: { Authorization: `Bearer ${modelKey}` } }] }],
    ...(slackToken ? { 'slack.com': [{ match: { path: { startsWith: '/api/' }, method: ['GET', 'POST'] }, transform: [{ headers: { Authorization: `Bearer ${slackToken}` } }] }] } : {}), '*': [] } };
}

export function codexRegistryEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const authorization = env.OPENCLAW_NPM_AUTHORIZATION;
  const registry = env.OPENCLAW_NPM_AUTH_REGISTRY;
  if (!authorization && !registry) return {};
  if (!authorization || !registry) throw new Error('Complete scoped registry credential required');
  const url = new URL(registry);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid registry credential scope');
  return { OPENCLAW_NPM_AUTHORIZATION: authorization, OPENCLAW_NPM_AUTH_REGISTRY: registry };
}

export interface LifecycleSteps {
  execute: () => Promise<CodexTurnReceipt>;
  onNativeDelivered?: () => void;
  publish: (reply: string) => Promise<void>;
  stop: () => Promise<void>;
  isStopped: () => Promise<boolean>;
}

export async function finishCodexLifecycle(steps: LifecycleSteps): Promise<CodexTurnReceipt> {
  const receipt = await steps.execute();
  try {
    if (receipt.nativeSlackDelivered) steps.onNativeDelivered?.();
    if (!receipt.nativeSlackDelivered) await steps.publish(receipt.reply);
  } finally {
    // The runtime has reconciled VM2, fenced work and exited the gateway before returning.
    await steps.stop();
  }
  if (!(await steps.isStopped())) throw new Error('VM1 stop is not confirmed');
  return receipt;
}

export async function runCodexLifecycle(options: {
  name: string;
  sessionKey: string;
  eventId: string;
  message: string;
  nativeSlack?: { rawBody: string; token: string };
  onNativeDelivered?: () => void;
  oidcToken: string;
  budget?: ExecutionBudget;
  publish: (reply: string) => Promise<void>;
}): Promise<CodexTurnReceipt> {
  const phase = codexPhaseRunner(options.eventId);
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const runtimeDigest = process.env.OPENCLAW_CODEX_RUNTIME_DIGEST;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;
  const modelKey = process.env.AI_GATEWAY_API_KEY;
  await phase('config', () => {
    if (!gatewayToken || !runtimeDigest?.match(/^[a-f0-9]{64}$/) || !projectId || !teamId || !modelKey) throw new Error('Codex host configuration is incomplete');
  });
  const budget = options.budget ?? createExecutionBudget();
  const credentials = { token: options.oidcToken, projectId: projectId!, teamId: teamId! };
  const signal = (capMs: number, reserveReply = true) => AbortSignal.timeout(operationTimeoutMs(budget, 'Codex host', { capMs, reserveReply }));
  const get = (resume: boolean, reserveReply = true) => Sandbox.get({ ...credentials, name: options.name, resume, signal: signal(resume ? RESUME_TIMEOUT_MS : 10_000, reserveReply) });
  const owned = (box: Sandbox) => box.persistent && box.tags?.owner === CODEX_OWNER && box.tags?.runtime === runtimeDigest;
  let sandbox = await phase('inspect', () => get(false));
  await phase('ownership', () => {
    if (!owned(sandbox)) throw new Error('Refusing an unowned or mismatched Codex sandbox');
    if (sandbox.status !== 'stopped') throw new Error('Codex sandbox is not stopped; inspect the previous attempt before retrying');
  });
  const previousSession = sandbox.currentSession().sessionId;
  await phase('policy', () => sandbox.update({ networkPolicy: codexHostPolicy(modelKey!, options.nativeSlack?.token) }, { signal: signal(10_000) }));
  const startupStep = async <T>(name: 'resume' | 'readiness', operation: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try { return await phase(name, operation); }
      catch (error) {
        if (attempt !== 0 || !retryableReadinessError((error as Error).cause)) throw error;
      }
    }
  };
  try {
    sandbox = await startupStep('resume', () => get(true));
    await phase('ownership', () => {
      if (!owned(sandbox) || sandbox.currentSession().sessionId === previousSession) throw new Error('Resumed sandbox identity is unconfirmed');
    });
    // Only named wake and the side-effect-free probe may retry; never the runtime.
    await startupStep('readiness', async () => {
      const result = await sandbox.currentSession().runCommand({ cmd: 'true', signal: signal(20_000), timeoutMs: 5000 });
      if (result.exitCode !== 0) throw new Error('Readiness command failed');
    });
  } catch (error) {
    try {
      await phase('startup-cleanup', async () => {
        const current = await get(false);
        if (!owned(current)) throw new Error('Startup cleanup ownership is unconfirmed');
        if (current.status === 'stopped') return;
        if (current.status !== 'running' || current.currentSession().sessionId === previousSession) throw new Error('Startup cleanup session is unconfirmed');
        // No runtime has been submitted; the held admission lease owns this empty wake.
        try {
          await phase('stop', () => current.stop({ signal: signal(STOP_TIMEOUT_MS) }));
        } catch (stopError) {
          if ((await get(false)).status === 'stopped') return;
          throw stopError;
        }
        if ((await get(false)).status !== 'stopped') throw new Error('Startup cleanup stop is unconfirmed');
      });
    } catch { /* The cleanup phase records its own failure; retain the original cause. */ }
    throw error;
  }
  let vm1SnapshotId: string | undefined;
  const receipt = await finishCodexLifecycle({
    execute: async () => {
      const timeoutMs = operationTimeoutMs({ ...budget, replyReserveMs: budget.replyReserveMs + STOP_RESERVE_MS }, 'Codex lifecycle', { capMs: 235_000 });
      const result = await phase('runtime', () => sandbox.currentSession().runCommand({ cmd: 'node', args: [`${CODEX_BASE}/runtime/turn.mjs`], cwd: CODEX_BASE,
        timeoutMs, signal: AbortSignal.timeout(timeoutMs), env: {
          ...(options.nativeSlack ? {} : codexRegistryEnvironment(process.env)),
          OPENCLAW_GATEWAY_TOKEN: gatewayToken!, VERCEL_OIDC_TOKEN: options.oidcToken,
          OPENCLAW_HOST_INPUT: JSON.stringify({ runtimeDigest, origin: sandbox.domain(3000), sessionKey: options.sessionKey, eventId: options.eventId, message: options.message, ...(options.nativeSlack ? { slackRawBody: options.nativeSlack.rawBody } : {}) }),
        } }));
      return phase('receipt', async () => {
        if (result.exitCode !== 0) throw new Error(`Codex runtime exit ${result.exitCode}; successful sleep/wake is unconfirmed`);
        const receipt = parseCodexReceipt(await result.stdout({ signal: signal(5000) }));
        if (options.nativeSlack && receipt.nativeSlackDelivered !== true) throw new Error('Native Slack delivery is unconfirmed');
        return receipt;
      });
    },
    publish: reply => phase('publish', () => options.publish(reply)),
    onNativeDelivered: options.onNativeDelivered,
    stop: () => phase('stop', async () => { await sandbox.stop({ signal: signal(STOP_TIMEOUT_MS, false) }); }),
    isStopped: () => phase('confirm', async () => {
      const stopped = await get(false, false);
      if (!owned(stopped) || stopped.status !== 'stopped') throw new Error('VM1 stop is not confirmed');
      if (!stopped.currentSnapshotId) throw new Error('VM1 snapshot is not confirmed');
      const snapshot = await Snapshot.get({ ...credentials, snapshotId: stopped.currentSnapshotId, signal: signal(10_000, false) });
      if (snapshot.status !== 'created' || snapshot.sourceSessionId !== sandbox.currentSession().sessionId) throw new Error('VM1 snapshot is not confirmed');
      vm1SnapshotId = snapshot.snapshotId;
      return true;
    }),
  });
  return { ...receipt, vm1SnapshotId };
}
