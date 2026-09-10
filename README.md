# OpenClaw on Vercel Sandbox

A two-sandbox PoC for running OpenClaw with Codex, sleeping between Slack messages, and restoring its files on the next message. Start with the [setup and native Slack test](host/CODEX-POC.md).

```text
Slack → Vercel Connect → Vercel Function
                              ↓ wakes
                     VM1: OpenClaw + Codex
                              ↓ native remote execution
                     VM2: generated commands
                              ↓ workspace reconciliation
                     VM1: drain → stop → disk snapshot
```

VM1 runs the gateway and model/tool coordination. A fresh VM2 runs generated commands with gateway-only egress. This is a controller/code-execution split, not the earlier proposal to put the entire Codex engine in VM2. Returned project files are data; passing their tests does not make them trusted gateway software.

Connect forwards the full Slack payload and supplies the Slack app token. The host verifies the forwarded request, enforces the test allowlist, wakes VM1 and injects Slack/model credentials through the firewall. OpenClaw's native Slack listener handles the turn and posts the answer. Sandbox administration and gateway credentials remain in the trusted controller scope.

Both sandboxes stop between tasks. The next mention restores VM1's disk and restarts its processes. There is no third always-running VM or Workflow dependency.

## Try it

Use Node 26 and npm with `min-release-age` support. From a clean checkout:

```sh
cd worker-provider
npm ci
npm run build
npm run typecheck
npm test
cd ../host
npm ci
npm test
npm run lint
npm run build
npm run typecheck
```

These commands run local checks only. The [hosting guide](host/CODEX-POC.md) covers the pinned OpenClaw build, snapshot preparation, Connect deployment and the paid native Slack test. Keep dependency signature and release-age controls enabled. Never commit environment files, installation artifacts or raw test receipts.

Compatibility is pinned to OpenClaw `2026.9.2` at `3928bad9badfcb6c7d140530435e806fb8092190`, with [two local patches](worker-provider/patches/README.md), Codex `0.153.4`, and Sandbox SDK `3.2.1` in the provider (`3.0.0` in the host lockfile). The runtime snapshot is derived from the digest-pinned official OpenClaw image. It is not an unmodified upstream release.

## What has been demonstrated

Native Slack mentions through Connect, code execution in VM2, same-thread file persistence across VM1 sleep/wake, distinct disposable workers, eyes reactions and stopped sandboxes. The host also sets Slack's processing status before runtime startup; API success is not proof of when Slack paints it.

September 10, 2026 observations took approximately **60–98 seconds** from mention to reply. In one 60-second greeting, about 8 seconds covered intake/wake/runtime checks, 9 seconds OpenClaw/Slack startup, 30 seconds worker preparation/connection and 13 seconds intake/agent/reply. VM2 allocation took 0.38 seconds within the worker-preparation period. VM1 restore was not isolated. These observations do not establish a consistent speedup or a latency benchmark.

## Limits

- This is a review PoC, not a production-ready hosting service. There is no durable post-ack job queue or crash recovery.
- Sessions and worktrees follow Slack threads. The memory plugin is disabled; shared cross-thread memory is not implemented here.
- Browser control, scheduled wake and most gateway dynamic tools are disabled. DMs, slash commands, attachment-only turns and stop buttons are unverified.
- Connect token acquisition works in the tested flow. OAuth expiry/refresh across sessions and adversarial isolation are not verified.
- VM1 snapshots expire after seven days and retain the latest two. Running processes are not checkpointed. Turns and VM sessions are timeboxed.

## Repository map

- [host/](host/): Function entry point, Connect intake, allowlists, Redis admission and sleep/wake lifecycle. Enable `OPENCLAW_ENGINE=codex` and `OPENCLAW_CODEX_NATIVE_SLACK=1` explicitly.
- [worker-provider/](worker-provider/): Vercel worker provider, pinned runtime preparation and native Slack test. The separate `worker-turn` experiment is historical and has no complete passing E2E result.
- [examples/](examples/): standalone official-image boot example, not the complete hosting PoC.
- [docs/](docs/): earlier design research and suspension contracts. The earlier text-only host remains available when Codex is not enabled; its shared-channel session and idle-cron behavior are not the native Slack PoC's behavior.

## License

MIT
