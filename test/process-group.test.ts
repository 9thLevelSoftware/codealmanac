import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  spawnInProcessGroup,
  terminateProcessGroup,
} from "../src/process/process-group.js";
import {
  createProcessTreeFixture,
  isProcessAlive,
  waitForDead,
  waitForPids,
} from "./helpers.js";

describe("process group cleanup", () => {
  it("terminates a spawned child and grandchild together", async () => {
    const dir = await createProcessTreeFixture("codealmanac-process-group-");
    const pidFile = join(dir, "pids.txt");
    const child = spawnInProcessGroup(process.execPath, [join(dir, "child.js"), pidFile], {
      cwd: dir,
      env: process.env,
      stdio: "ignore",
    });

    try {
      const pids = await waitForPids(pidFile, 2);
      expect(pids).toContain(child.pid);

      await terminateProcessGroup(child, { graceMs: 100 });

      await waitForDead(pids);
      for (const pid of pids) {
        expect(isProcessAlive(pid)).toBe(false);
      }
    } finally {
      await terminateProcessGroup(child, { graceMs: 25 }).catch(() => undefined);
    }
  });

  it("escalates when the process group ignores graceful termination", async () => {
    const dir = await createProcessTreeFixture("codealmanac-process-group-ignore-");
    const pidFile = join(dir, "pids.txt");
    const child = spawnInProcessGroup(
      process.execPath,
      [join(dir, "child.js"), pidFile, "ignore-term"],
      {
        cwd: dir,
        env: process.env,
        stdio: "ignore",
      },
    );

    try {
      const pids = await waitForPids(pidFile, 2);
      await terminateProcessGroup(child, { graceMs: 50 });

      await waitForDead(pids);
      for (const pid of pids) {
        expect(isProcessAlive(pid)).toBe(false);
      }
    } finally {
      await terminateProcessGroup(child, { graceMs: 25 }).catch(() => undefined);
    }
  });
});
