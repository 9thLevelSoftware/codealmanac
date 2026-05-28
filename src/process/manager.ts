import { join } from "node:path";

import type { HarnessEvent, HarnessResult } from "../harness/events.js";
import type { AgentRunSpec, HarnessRunHooks } from "../harness/types.js";
import { getHarnessProvider } from "../harness/providers/index.js";
import { runIndexer } from "../indexer/index.js";
import { createRunId } from "./ids.js";
import { appendRunEvent, initializeRunLog } from "./logs.js";
import {
  buildStartedRunRecord,
  finishRunRecord,
  isRunCancellationRequested,
  readRunRecord,
  runRecordPath,
  writeRunRecord,
} from "./records.js";
import { acquireRunWorkerLock } from "./queue.js";
import { diffPageSnapshots, snapshotPages } from "./snapshots.js";
import type { RunPageChanges, RunRecord, RunSummary } from "./types.js";

export interface StartProcessOptions {
  repoRoot: string;
  spec: AgentRunSpec;
  runId?: string;
  now?: () => Date;
  pid?: number;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
  harnessRun?: (
    spec: AgentRunSpec,
    hooks?: HarnessRunHooks,
  ) => Promise<HarnessResult>;
}

export interface StartProcessResult {
  runId: string;
  record: RunRecord;
  result: HarnessResult;
}

export async function startForegroundProcess(
  options: StartProcessOptions,
): Promise<StartProcessResult> {
  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? createRunId(now());
  const startedAt = now();
  const lock = await acquireRunWorkerLock(options.repoRoot, startedAt);
  if (lock === null) {
    throw new Error(
      "another Almanac operation is already running for this wiki; run without --foreground to queue this operation",
    );
  }
  try {
    const recordPath = runRecordPath(options.repoRoot, runId);
    const started = buildStartedRunRecord({
      runId,
      repoRoot: options.repoRoot,
      spec: options.spec,
      startedAt,
      pid: options.pid,
    });

    const preStart = await cancelledRecordIfRequested({
      recordPath,
      repoRoot: options.repoRoot,
      runId,
      fallback: started,
      finishedAt: now(),
    });
    if (preStart !== null) {
      return {
        runId,
        record: preStart,
        result: {
          success: false,
          result: "",
          error: "run cancelled before start",
        },
      };
    }

    await writeRunRecord(recordPath, started);
    await initializeRunLog(started.logPath);
    const afterStart = await cancelledRecordIfRequested({
      recordPath,
      repoRoot: options.repoRoot,
      runId,
      fallback: started,
      finishedAt: now(),
    });
    if (afterStart !== null) {
      return {
        runId,
        record: afterStart,
        result: {
          success: false,
          result: "",
          error: "run cancelled before start",
        },
      };
    }

    return executeStartedRun({
      repoRoot: options.repoRoot,
      spec: options.spec,
      record: started,
      now,
      onEvent: options.onEvent,
      harnessRun: options.harnessRun,
    });
  } finally {
    await lock.release();
  }
}

export async function startQueuedProcess(
  options: Omit<StartProcessOptions, "runId"> & { runId: string },
): Promise<StartProcessResult | null> {
  const now = options.now ?? (() => new Date());
  const recordPath = runRecordPath(options.repoRoot, options.runId);
  const existing = await readRunRecord(recordPath);
  if (existing === null || existing.status !== "queued") return null;

  const beforeClaim = await cancelledRecordIfRequested({
    recordPath,
    repoRoot: options.repoRoot,
    runId: options.runId,
    fallback: existing,
    finishedAt: now(),
  });
  if (beforeClaim !== null) {
    return {
      runId: options.runId,
      record: beforeClaim,
      result: {
        success: false,
        result: "",
        error: "run cancelled before start",
      },
    };
  }

  const running: RunRecord = {
    ...existing,
    status: "running",
    pid: options.pid ?? process.pid,
    startedAt: now().toISOString(),
    finishedAt: undefined,
    durationMs: undefined,
    summary: undefined,
    pageChanges: undefined,
    error: undefined,
    failure: undefined,
  };
  await writeRunRecord(recordPath, running);

  const afterClaim = await cancelledRecordIfRequested({
    recordPath,
    repoRoot: options.repoRoot,
    runId: options.runId,
    fallback: running,
    finishedAt: now(),
  });
  if (afterClaim !== null) {
    return {
      runId: options.runId,
      record: afterClaim,
      result: {
        success: false,
        result: "",
        error: "run cancelled before start",
      },
    };
  }

  return executeStartedRun({
    repoRoot: options.repoRoot,
    spec: options.spec,
    record: running,
    now,
    onEvent: options.onEvent,
    harnessRun: options.harnessRun,
  });
}

async function executeStartedRun(args: {
  repoRoot: string;
  spec: AgentRunSpec;
  record: RunRecord;
  now: () => Date;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
  harnessRun?: (
    spec: AgentRunSpec,
    hooks?: HarnessRunHooks,
  ) => Promise<HarnessResult>;
}): Promise<StartProcessResult> {
  const runId = args.record.id;
  const recordPath = runRecordPath(args.repoRoot, runId);
  const started = args.record;
  const now = args.now;

  const harnessRun =
    args.harnessRun ??
    ((spec, hooks) => getHarnessProvider(spec.provider.id).run(spec, hooks));
  const eventWrites: Promise<void>[] = [];

  let result: HarnessResult;
  let finalRecord: RunRecord;
  let summary: RunSummary | undefined;
  let pageChanges: RunPageChanges | undefined;
  try {
    const pagesDir = join(args.repoRoot, ".almanac", "pages");
    const before = await snapshotPages(pagesDir);
    try {
      result = await harnessRun(args.spec, {
        onEvent: eventLogger({
          logPath: started.logPath,
          runId,
          now,
          writes: eventWrites,
          recordPath,
          fallbackRecord: started,
          observer: args.onEvent,
        }),
      });
    } catch (err: unknown) {
      result = {
        success: false,
        result: "",
        error: err instanceof Error ? err.message : String(err),
      };
      await appendRunEvent(started.logPath, {
        type: "error",
        error: result.error ?? "unknown error",
      }, now(), { runId, sequence: eventWrites.length + 1 });
    }
    await Promise.allSettled(eventWrites);

    const after = await snapshotPages(pagesDir);
    const delta = diffPageSnapshots(before, after);
    summary = {
      created: delta.created.length,
      updated: delta.updated.length,
      archived: delta.archived.length,
      deleted: delta.deleted.length,
      costUsd: result.costUsd,
      turns: result.turns,
      usage: result.usage,
    };
    const resultSummary = harnessResultSummary(result.result);
    pageChanges = {
      version: 1,
      runId,
      created: delta.created,
      updated: delta.updated,
      archived: delta.archived,
      deleted: delta.deleted,
      ...(resultSummary !== undefined ? { summary: resultSummary } : {}),
    };
    if (result.success) {
      await runIndexer({ repoRoot: args.repoRoot });
    }
    finalRecord = await finishUnlessCancelled({
      recordPath,
      fallback: started,
      status: result.success ? "done" : "failed",
      finishedAt: now(),
      providerSessionId: result.providerSessionId,
      summary,
      pageChanges,
      error: result.error,
      failure: result.failure,
    });
  } catch (err: unknown) {
    result = {
      success: false,
      result: "",
      error: err instanceof Error ? err.message : String(err),
    };
    try {
      await appendRunEvent(started.logPath, {
        type: "error",
        error: result.error ?? "unknown error",
      }, now(), { runId, sequence: eventWrites.length + 1 });
    } catch {
      // The run record is the source of truth; do not let a broken log write
      // prevent terminal status recording.
    }
    await Promise.allSettled(eventWrites);
    finalRecord = await finishUnlessCancelled({
      recordPath,
      fallback: started,
      status: "failed",
      finishedAt: now(),
      summary,
      pageChanges,
      error: result.error,
      failure: result.failure,
    });
  }

  if (finalRecord.status === "cancelled" && result.success) {
    result = {
      success: false,
      result: "",
      error: "run cancelled before final status",
    };
  }
  return { runId, record: finalRecord, result };
}

async function finishUnlessCancelled(args: {
  recordPath: string;
  fallback: RunRecord;
  status: "done" | "failed";
  finishedAt: Date;
  providerSessionId?: string;
  summary?: RunSummary;
  pageChanges?: RunPageChanges;
  error?: string;
  failure?: import("../harness/events.js").HarnessFailure;
}): Promise<RunRecord> {
  const current = await readRunRecord(args.recordPath);
  if (
    current?.status === "cancelled" ||
    isRunCancellationRequested(args.fallback.repoRoot, args.fallback.id)
  ) {
    return finishCancelled({
      recordPath: args.recordPath,
      fallback: current ?? args.fallback,
      finishedAt: args.finishedAt,
    });
  }
  const base = current ?? args.fallback;
  const finished = finishRunRecord({
    record: base,
    status: args.status,
    finishedAt: args.finishedAt,
    providerSessionId: args.providerSessionId,
    summary: args.summary,
    pageChanges: args.pageChanges,
    error: args.error,
    failure: args.failure,
  });
  await writeRunRecord(args.recordPath, finished);
  return finished;
}

async function cancelledRecordIfRequested(args: {
  recordPath: string;
  repoRoot: string;
  runId: string;
  fallback: RunRecord;
  finishedAt: Date;
}): Promise<RunRecord | null> {
  const current = await readRunRecord(args.recordPath);
  if (
    current?.status !== "cancelled" &&
    !isRunCancellationRequested(args.repoRoot, args.runId)
  ) {
    return null;
  }
  return finishCancelled({
    recordPath: args.recordPath,
    fallback: current ?? args.fallback,
    finishedAt: args.finishedAt,
  });
}

async function finishCancelled(args: {
  recordPath: string;
  fallback: RunRecord;
  finishedAt: Date;
}): Promise<RunRecord> {
  const cancelled =
    args.fallback.status === "cancelled"
      ? args.fallback
      : finishRunRecord({
          record: args.fallback,
          status: "cancelled",
          finishedAt: args.finishedAt,
        });
  await writeRunRecord(args.recordPath, cancelled);
  return cancelled;
}

function eventLogger(args: {
  logPath: string;
  runId: string;
  now: () => Date;
  writes: Promise<void>[];
  recordPath: string;
  fallbackRecord: RunRecord;
  observer?: (event: HarnessEvent) => void | Promise<void>;
}): (event: HarnessEvent) => Promise<void> {
  let sequence = 0;
  return (event) => {
    sequence += 1;
    const writes = [
      appendRunEvent(args.logPath, event, args.now(), { runId: args.runId, sequence }),
      persistProviderSessionId({
        recordPath: args.recordPath,
        fallbackRecord: args.fallbackRecord,
        event,
      }),
    ];
    if (args.observer !== undefined) {
      writes.push(Promise.resolve(args.observer(event)));
    }
    const write = Promise.allSettled(writes).then(() => undefined);
    args.writes.push(write);
    return write;
  };
}

async function persistProviderSessionId(args: {
  recordPath: string;
  fallbackRecord: RunRecord;
  event: HarnessEvent;
}): Promise<void> {
  const providerSessionId = providerSessionIdFromEvent(args.event);
  if (providerSessionId === undefined) return;
  const current = await readRunRecord(args.recordPath);
  const record = current ?? args.fallbackRecord;
  if (record.providerSessionId !== undefined) return;
  await writeRunRecord(args.recordPath, {
    ...record,
    providerSessionId,
  });
}

function providerSessionIdFromEvent(event: HarnessEvent): string | undefined {
  if (event.type === "provider_session") {
    return event.providerSessionId;
  }
  if (event.type === "done" && event.providerSessionId !== undefined) {
    return event.providerSessionId;
  }
  return undefined;
}

function harnessResultSummary(result: string): string | undefined {
  for (const rawLine of result.split(/\r?\n/)) {
    const line = rawLine.replace(/^#+\s*/, "").trim();
    if (line.length === 0 || line === "---") continue;
    return line.length > 500 ? `${line.slice(0, 497)}...` : line;
  }
  return undefined;
}
