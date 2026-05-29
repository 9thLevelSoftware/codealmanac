import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runsDir, listRunRecords } from "./records.js";
import type { RunRecord } from "./types.js";

export interface RunWorkerLock {
  path: string;
  release(): Promise<void>;
}

export function runWorkerLockPath(repoRoot: string): string {
  return join(runsDir(repoRoot), "worker.lock");
}

export async function acquireRunWorkerLock(
  repoRoot: string,
  now: Date,
): Promise<RunWorkerLock | null> {
  if (await tryCreateRunWorkerLock(repoRoot, now)) {
    return workerLock(repoRoot);
  }
  if (!await isStaleRunWorkerLock(repoRoot)) return null;
  await releaseRunWorkerLock(repoRoot);
  return await tryCreateRunWorkerLock(repoRoot, now) ? workerLock(repoRoot) : null;
}

export async function oldestQueuedRun(repoRoot: string): Promise<RunRecord | null> {
  const records = await listRunRecords(repoRoot);
  const queued = records.filter((record) => record.status === "queued");
  queued.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return queued[0] ?? null;
}

function workerLock(repoRoot: string): RunWorkerLock {
  const path = runWorkerLockPath(repoRoot);
  return {
    path,
    release: () => releaseRunWorkerLock(repoRoot),
  };
}

function runWorkerLockOwnerPath(repoRoot: string): string {
  return join(runWorkerLockPath(repoRoot), "owner.json");
}

async function tryCreateRunWorkerLock(repoRoot: string, now: Date): Promise<boolean> {
  try {
    const lock = runWorkerLockPath(repoRoot);
    await mkdir(dirname(lock), { recursive: true });
    await mkdir(lock, { recursive: false });
    await writeFile(
      runWorkerLockOwnerPath(repoRoot),
      `${JSON.stringify({ pid: process.pid, startedAt: now.toISOString() }, null, 2)}\n`,
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

async function releaseRunWorkerLock(repoRoot: string): Promise<void> {
  await rm(runWorkerLockPath(repoRoot), { recursive: true, force: true });
}

async function isStaleRunWorkerLock(repoRoot: string): Promise<boolean> {
  let raw: Record<string, unknown> = {};
  try {
    raw = parseJsonObject(await readFile(runWorkerLockOwnerPath(repoRoot), "utf8")) ?? {};
  } catch {
    return true;
  }
  const pid = typeof raw.pid === "number" ? raw.pid : null;
  return pid === null || !isPidAlive(pid);
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
