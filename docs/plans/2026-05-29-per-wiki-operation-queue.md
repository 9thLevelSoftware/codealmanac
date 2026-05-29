# Per-Wiki Operation Queue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace capture-specific concurrency throttles with a process-manager-owned per-wiki single-writer queue for Build, Absorb, and Garden, while keeping Almanac run logs as the durable audit trail and making provider sessions ephemeral by default for maintenance operations.

**Architecture:** The existing vocabulary stays intact: `OperationKind` names semantic work, `AgentRunSpec` describes one executable operation run, `RunRecord` stores lifecycle state, and `jobs`/`serve` inspect run records. `startBackgroundProcess()` becomes enqueue-and-wake-worker rather than spawn-one-child-per-run; the worker owns `.almanac/runs/worker.lock`, executes queued runs oldest-first, and keeps running until the per-wiki queue is empty. Provider adapters translate `AgentRunSpec.providerSession.persistence = "ephemeral"` into provider-specific non-persistence controls.

**Tech Stack:** TypeScript, Node child processes, filesystem-backed run records under `.almanac/runs/`, Vitest, existing process manager and harness provider modules.

---

## Current State To Preserve

- `OperationKind` already exists in `src/harness/types.ts` as `"build" | "absorb" | "garden"`.
- `RunStatus` already includes `"queued"` in `src/process/types.ts`.
- `startBackgroundProcess()` currently writes a queued run record, initializes the JSONL log, and immediately spawns `__run-job <run-id>`.
- `runBackgroundChild()` currently reads a single spec and calls `startForegroundProcess()`.
- `capture sweep` currently owns temporary concurrency controls: repo sweep lock, active Absorb check, and `--max-starts`.
- `.almanac/runs/<run-id>.jsonl` is the canonical user-visible transcript. Provider history must not be required for audit.

## Desired Invariants

- For one `repoRoot`, at most one write-capable Almanac operation is running.
- Queued means genuinely waiting behind the per-wiki worker, not "a detached child was spawned immediately."
- Build, Absorb, and Garden all use the same queue path.
- `capture sweep` discovers eligible transcript work and enqueues Absorb runs; it does not own execution concurrency.
- Almanac maintenance operations request ephemeral provider sessions through provider-neutral `AgentRunSpec` data.
- The implementation should remove capture-specific throttles made redundant by the queue.
- Foreground new-run creation and worker execution of an existing queued run share harness execution/finalization code, but do not share record-creation semantics.
- Foreground write operations must not bypass the single-writer invariant. If a foreground run cannot acquire the per-wiki writer lock, it should fail with a clear message telling the user to run the command in background and attach to the queued job.

## Task 1: Add Provider Session Persistence To `AgentRunSpec`

**Files:**
- Modify: `src/harness/types.ts`
- Modify: `src/process/spec.ts`
- Modify: `src/operations/run.ts`
- Test: `test/harness-types.test.ts`
- Test: `test/build-operation.test.ts`
- Test: `test/absorb-operation.test.ts`
- Test: `test/garden-operation.test.ts`

**Step 1: Write the failing type/spec tests**

Add assertions that operation-created specs include:

```ts
providerSession: {
  persistence: "ephemeral",
}
```

Add one harness type test proving this is provider-neutral and not Codex/Claude-specific.

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/harness-types.test.ts test/build-operation.test.ts test/absorb-operation.test.ts test/garden-operation.test.ts
```

Expected: tests fail because `providerSession.persistence` is missing.

**Step 3: Implement the minimal spec shape**

Extend `AgentRunSpec`:

```ts
providerSession?: {
  persistence?: "ephemeral" | "persistent";
};
```

Set `providerSession.persistence = "ephemeral"` in `createOperationRunSpec()` for Build, Absorb, and Garden.

Update `isAgentRunSpec()` to validate the optional session field and reject invalid persistence values.

**Step 4: Run tests**

Run:

```bash
npm test -- test/harness-types.test.ts test/build-operation.test.ts test/absorb-operation.test.ts test/garden-operation.test.ts
```

Expected: selected tests pass.

**Step 5: Commit**

```bash
git add src/harness/types.ts src/process/spec.ts src/operations/run.ts test/harness-types.test.ts test/build-operation.test.ts test/absorb-operation.test.ts test/garden-operation.test.ts
git commit -m "feat: encode provider session persistence on operation specs"
```

## Task 2: Map Provider Persistence In Harness Adapters

**Files:**
- Modify: `src/harness/providers/claude.ts`
- Modify: `src/harness/providers/codex/request.ts`
- Modify: `src/harness/providers/codex/app-server.ts`
- Test: `test/claude-harness-provider.test.ts`
- Test: `test/codex-harness-provider.test.ts`

**Step 1: Write failing provider tests**

Assert:

- Claude receives `persistSession: false` when `spec.providerSession.persistence === "ephemeral"`.
- Codex exec adds `--ephemeral` when `spec.providerSession.persistence === "ephemeral"`.
- Codex app-server thread start sends `ephemeral: true` when `spec.providerSession.persistence === "ephemeral"`.
- Providers do not treat a missing `providerSession.persistence` as an implicit global ephemeral default; the operation spec sets the explicit policy.

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/claude-harness-provider.test.ts test/codex-harness-provider.test.ts
```

Expected: Claude and Codex exec tests fail until mapped.

**Step 3: Implement provider mappings**

In Claude options, map:

```ts
persistSession: spec.providerSession?.persistence === "ephemeral" ? false : undefined
```

In Codex exec request, append `--ephemeral` before the prompt when requested.

In Codex app-server, derive the `ephemeral` parameter from `spec.providerSession?.persistence === "ephemeral"`.

Keep provider-specific mechanics inside provider modules only.

**Step 4: Run tests**

Run:

```bash
npm test -- test/claude-harness-provider.test.ts test/codex-harness-provider.test.ts
```

Expected: selected tests pass.

**Step 5: Commit**

```bash
git add src/harness/providers/claude.ts src/harness/providers/codex/request.ts src/harness/providers/codex/app-server.ts test/claude-harness-provider.test.ts test/codex-harness-provider.test.ts
git commit -m "feat: make maintenance provider sessions ephemeral"
```

## Task 3: Introduce A Per-Wiki Worker Lock And Queue Selection

**Files:**
- Create: `src/process/queue.ts`
- Modify: `src/process/index.ts`
- Test: `test/process-queue.test.ts`

**Step 1: Write failing queue tests**

Cover:

- `acquireRunWorkerLock(repoRoot, now)` creates `.almanac/runs/worker.lock/owner.json`.
- A second acquire returns `null` while the owner process is alive and not stale.
- Stale locks are recovered.
- `oldestQueuedRun(repoRoot)` returns the oldest queued `RunRecord` by `startedAt`.
- Cancelled/failed/done/running records are not selected.

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/process-queue.test.ts
```

Expected: fails because `src/process/queue.ts` does not exist.

**Step 3: Implement queue helpers**

Implement:

```ts
export interface RunWorkerLock {
  path: string;
  release(): Promise<void>;
}

export function runWorkerLockPath(repoRoot: string): string;
export async function acquireRunWorkerLock(repoRoot: string, now: Date): Promise<RunWorkerLock | null>;
export async function oldestQueuedRun(repoRoot: string): Promise<RunRecord | null>;
```

Use directory creation as the atomic lock primitive, matching existing lock style. Use the same stale-owner shape as capture lock: `{ pid, startedAt }`.

**Step 4: Run tests**

Run:

```bash
npm test -- test/process-queue.test.ts
```

Expected: queue tests pass.

**Step 5: Commit**

```bash
git add src/process/queue.ts src/process/index.ts test/process-queue.test.ts
git commit -m "feat: add per-wiki operation queue primitives"
```

## Task 4: Convert Background Starts To Enqueue And Wake Worker

**Files:**
- Modify: `src/process/background.ts`
- Modify: `src/process/manager.ts`
- Modify: `src/cli.ts`
- Modify: `src/process/index.ts`
- Test: `test/process-background.test.ts`
- Test: `test/process-manager.test.ts`

**Step 1: Write failing lifecycle tests**

Update/add tests so:

- `startBackgroundProcess()` writes spec, queued record, log file, and spawns `__run-worker`, not `__run-job <run-id>`.
- Starting two background runs creates two queued records and may spawn duplicate worker wakeups; duplicate workers are harmless because only one can hold the worker lock.
- `runBackgroundWorker(repoRoot)` processes queued runs oldest-first.
- `runBackgroundWorker(repoRoot)` keeps processing until no queued records remain.
- Cancelled queued records are skipped/finalized without invoking the harness.
- Worker execution does not truncate an existing queued run log before running.
- A foreground run acquires the same writer lock before executing; when the lock is held, the foreground path returns a clear failure instead of racing the queued worker.

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/process-background.test.ts test/process-manager.test.ts
```

Expected: tests fail because the current path spawns `__run-job` immediately.

**Step 3: Split queued-run execution from foreground run creation**

Do not call `startForegroundProcess()` directly from the worker in its current shape. It creates a fresh running record and initializes the log, which is correct for a foreground new run but wrong for claiming an existing queued run.

Refactor `src/process/manager.ts` so the shared core is shaped like:

```ts
async function executeStartedRun(args: {
  repoRoot: string;
  spec: AgentRunSpec;
  record: RunRecord;
  now: () => Date;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
  harnessRun?: (spec: AgentRunSpec, hooks?: HarnessRunHooks) => Promise<HarnessResult>;
}): Promise<StartProcessResult>
```

Keep `startForegroundProcess()` as the public entry for attached foreground runs:

1. Build a fresh running record.
2. Check cancellation.
3. Write the record.
4. Initialize the log.
5. Call `executeStartedRun(...)`.

Add a queued-run entry point for the worker:

```ts
export async function startQueuedProcess(args: {
  repoRoot: string;
  runId: string;
  spec: AgentRunSpec;
  now?: () => Date;
  pid?: number;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
  harnessRun?: (spec: AgentRunSpec, hooks?: HarnessRunHooks) => Promise<HarnessResult>;
}): Promise<StartProcessResult | null>
```

`startQueuedProcess()` must:

1. Read the existing run record.
2. Return `null` if it is no longer queued.
3. Check cancellation before claim.
4. Write a running record with the worker pid.
5. Check cancellation after claim.
6. Call `executeStartedRun(...)` without reinitializing the existing JSONL log.

**Step 4: Implement worker path**

Replace single-run background child with:

```ts
export async function runBackgroundWorker(options: RunBackgroundWorkerOptions): Promise<void>
```

Worker algorithm:

1. Acquire `worker.lock`; if unavailable, return.
2. Loop:
   - Find oldest queued record.
   - If none, return.
   - If cancelled, mark cancelled and continue.
   - Read spec and call `startQueuedProcess({ runId })`.
3. If reading a spec or claiming/running one queued run throws, mark that run failed when possible and continue draining later queued runs.
4. Release lock in `finally`.
5. After release, check once for a newly queued run. If one exists, loop back and try to acquire the lock again. This closes the enqueue-at-worker-exit lost-wakeup race: an enqueue that spawned a worker while the old worker still held the lock cannot strand work after the old worker releases.

Keep `runBackgroundChild()` only if tests or compatibility require it; otherwise delete it and remove `__run-job`.

Change `startBackgroundProcess()` to spawn:

```text
__run-worker
```

The worker lock makes duplicate wakeups harmless.

**Step 5: Run tests**

Run:

```bash
npm test -- test/process-background.test.ts test/process-manager.test.ts
```

Expected: selected tests pass.

**Step 6: Commit**

```bash
git add src/process/background.ts src/process/index.ts src/cli.ts test/process-background.test.ts test/process-manager.test.ts
git commit -m "feat: run background operations through a per-wiki worker"
```

## Task 5: Simplify Capture Sweep Around The Queue

**Files:**
- Modify: `src/capture/sweep.ts`
- Modify: `src/capture/lock.ts` if no longer needed
- Modify: `src/commands/capture-sweep.ts`
- Modify: `src/cli/register-wiki-lifecycle-commands.ts`
- Test: `test/capture-sweep.test.ts`

**Step 1: Write failing sweep tests**

Change expectations:

- Live sweep can enqueue multiple eligible transcript captures for the same repo.
- Sweep no longer skips because an Absorb run is already queued/running.
- `--max-starts` is removed from command registration.
- Ledger still marks each enqueued transcript as pending with its own run id.
- Dry-run behavior remains unchanged and writes no ledger.
- The per-repo sweep lock remains because it protects transcript discovery, capture-ledger writes, and per-source reservation. It is not the operation concurrency guard.

**Step 2: Run tests to verify failure**

Run:

```bash
npm test -- test/capture-sweep.test.ts test/cli.test.ts
```

Expected: failures reflect old max-start/active-Absorb behavior.

**Step 3: Remove queue-redundant sweep controls**

Remove:

- `maxStarts` from sweep options and CLI registration.
- `reposStartedThisSweep`.
- `hasActiveAbsorbRun()`.
- `repo-capture-already-running` skip behavior.
- `sweep-start-limit` skip behavior.

Keep:

- transcript quiet-window eligibility
- capture ledger cursor and pending reconciliation
- sweep lock as a short-lived discovery/ledger lock

**Step 4: Run tests**

Run:

```bash
npm test -- test/capture-sweep.test.ts test/cli.test.ts
```

Expected: selected tests pass.

**Step 5: Commit**

```bash
git add src/capture/sweep.ts src/capture/lock.ts src/commands/capture-sweep.ts src/cli/register-wiki-lifecycle-commands.ts test/capture-sweep.test.ts test/cli.test.ts
git commit -m "refactor: let the operation queue own capture concurrency"
```

## Task 6: Remove Internal Transcript Marker Plumbing

**Files:**
- Modify: `src/process/background.ts`
- Modify: `src/harness/providers/claude.ts`
- Modify: `src/harness/providers/codex/request.ts`
- Modify: `src/capture/discovery/claude.ts`
- Modify: `src/capture/discovery/codex.ts`
- Modify: `src/capture/discovery/jsonl.ts`
- Test: `test/capture-sweep.test.ts`
- Test: provider tests touched in Task 2

**Step 1: Write/update tests around the new contract**

Remove tests that depend on `CODEALMANAC_INTERNAL_SESSION` or `CODEALMANAC_ABSORB_RUN` transcript scanning.

Keep or add tests proving maintenance provider sessions are ephemeral through provider mappings.

Explicit decision: this product direction does not preserve compatibility for already-persisted provider maintenance transcripts. The durable contract is non-persistent provider sessions plus persisted `.almanac/runs/` audit logs. Do not replace marker scanning with another hidden content heuristic.

**Step 2: Run tests to observe current marker expectations**

Run:

```bash
npm test -- test/capture-sweep.test.ts test/claude-harness-provider.test.ts test/codex-harness-provider.test.ts
```

Expected: marker-dependent tests fail after code removal until expectations are updated.

**Step 3: Remove marker plumbing**

Remove:

- `CODEALMANAC_INTERNAL_SESSION` and `CODEALMANAC_ABSORB_RUN` injection.
- `isInternalAlmanacTranscript()`.
- Discovery calls that skip by marker.

Do not add a replacement hidden heuristic. The durable fix is ephemeral provider sessions plus the operation queue.

**Step 4: Run tests**

Run:

```bash
npm test -- test/capture-sweep.test.ts test/claude-harness-provider.test.ts test/codex-harness-provider.test.ts
```

Expected: selected tests pass.

**Step 5: Commit**

```bash
git add src/process/background.ts src/harness/providers/claude.ts src/harness/providers/codex/request.ts src/capture/discovery/claude.ts src/capture/discovery/codex.ts src/capture/discovery/jsonl.ts test/capture-sweep.test.ts test/claude-harness-provider.test.ts test/codex-harness-provider.test.ts
git commit -m "refactor: remove internal transcript marker filtering"
```

## Task 7: Update Jobs, Viewer, Docs, And Wiki

**Files:**
- Modify: `src/commands/jobs.ts` if queued/running wording needs adjustment
- Modify: `src/viewer/jobs.ts` and `viewer/jobs-view.js` if UI assumes queued child PID semantics
- Modify: `.almanac/pages/process-manager-runs.md`
- Modify: `.almanac/pages/capture-flow.md`
- Modify: `.almanac/pages/capture-automation.md`
- Modify: docs plan/decision log as needed
- Test: `test/jobs-command.test.ts`
- Test: `test/viewer-api.test.ts`
- Test: `test/viewer-ui-assets.test.ts`

**Step 1: Inspect user-facing assumptions**

Search for text that says a queued run has already spawned a child or that `--max-starts` exists.

Run:

```bash
rg -n "max-starts|CODEALMANAC_INTERNAL_SESSION|CODEALMANAC_ABSORB_RUN|repo-capture-already-running|sweep-start-limit|__run-job|queued" src test viewer .almanac docs
```

**Step 2: Update docs/UI text**

Document:

- `.almanac/runs/worker.lock`
- queued now means waiting for worker
- provider sessions are ephemeral for maintenance
- `.almanac/runs/<run-id>.jsonl` remains the audit transcript
- sweep enqueues eligible work and queue serializes execution

**Step 3: Run focused tests**

Run:

```bash
npm test -- test/jobs-command.test.ts test/viewer-api.test.ts test/viewer-ui-assets.test.ts
```

Expected: selected tests pass.

**Step 4: Commit**

```bash
git add src/commands/jobs.ts src/viewer/jobs.ts viewer/jobs-view.js .almanac/pages/process-manager-runs.md .almanac/pages/capture-flow.md .almanac/pages/capture-automation.md docs/plans/2026-05-29-per-wiki-operation-queue.md test/jobs-command.test.ts test/viewer-api.test.ts test/viewer-ui-assets.test.ts
git commit -m "docs: record per-wiki operation queue architecture"
```

## Task 8: Full Verification, Review, And Push

**Files:**
- All touched files

**Step 1: Run full verification**

Run:

```bash
npm run lint
npm run build
npm test
almanac health
```

Expected: all commands exit 0.

**Step 2: Request code review**

Use the code review agent with:

- Base SHA: commit before Task 1
- Head SHA: current branch head
- Requirements: this plan
- Focus: queue correctness, lifecycle races, cancellation, stale locks, provider session persistence, removal of one-off capture controls.

**Step 3: Fix review findings**

For each critical or important finding:

1. Add or update a failing test when practical.
2. Implement the fix.
3. Run the focused test.
4. Commit with `fix: ...`.

**Step 4: Re-run full verification**

Run:

```bash
npm run lint
npm run build
npm test
almanac health
```

Expected: all commands exit 0.

**Step 5: Push**

Run:

```bash
git push -u origin codex/per-wiki-operation-queue
```

Expected: branch pushed successfully.
