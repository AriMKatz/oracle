import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { sessionStore } from "../../src/sessionStore.js";
import { __test__, acquireSessionReattachLease } from "../../src/cli/sessionReattachLease.js";

let tmpHome: string;
let sessionId: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-lease-"));
  setOracleHomeDirOverrideForTest(tmpHome);
  await sessionStore.ensureStorage();
  const session = await sessionStore.createSession(
    {
      prompt: "Test reattach lease",
      model: "gpt-5.2-pro",
      mode: "browser",
      browserConfig: {},
    },
    "/repo",
  );
  sessionId = session.id;
});

afterEach(async () => {
  setOracleHomeDirOverrideForTest(null);
  await fs.rm(tmpHome, { recursive: true, force: true });
});

async function lockDir(): Promise<string> {
  const paths = await sessionStore.getPaths(sessionId);
  return path.join(paths.dir, __test__.dirname);
}

async function writeLeaseDirectory(
  target: string,
  owner: { pid: number; leaseId: string; createdAt: string; processStartIdentity?: string | null },
): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, __test__.ownerFilename), JSON.stringify(owner), "utf8");
}

describe("session reattach lease", () => {
  test("publishes a nonempty directory and allows exactly one concurrent owner", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => acquireSessionReattachLease(sessionId)),
    );
    const acquired = attempts.filter((attempt) => attempt.acquired);
    const busy = attempts.filter((attempt) => !attempt.acquired);

    expect(acquired).toHaveLength(1);
    expect(busy).toHaveLength(7);
    expect(busy.every((attempt) => attempt.ownerPid === process.pid)).toBe(true);
    expect(await fs.readdir(await lockDir())).toContain(__test__.ownerFilename);

    if (!acquired[0]?.acquired) throw new Error("Expected an acquired lease");
    await acquired[0].lease.release();
  });

  test("returns busy without disturbing a live owner", async () => {
    const first = await acquireSessionReattachLease(sessionId);
    expect(first.acquired).toBe(true);

    const second = await acquireSessionReattachLease(sessionId);
    expect(second).toEqual({ acquired: false, ownerPid: process.pid });
    expect(await fs.readFile(path.join(await lockDir(), __test__.ownerFilename), "utf8")).toContain(
      `"pid":${process.pid}`,
    );

    if (first.acquired) await first.lease.release();
  });

  test("allows exactly one winner when concurrent contenders reclaim a dead owner", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await once(child, "exit");
    if (!child.pid) throw new Error("Missing child pid");
    await writeLeaseDirectory(await lockDir(), {
      pid: child.pid,
      leaseId: "dead-owner",
      createdAt: new Date().toISOString(),
      processStartIdentity: "dead-process-start",
    });

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => acquireSessionReattachLease(sessionId)),
    );
    const acquired = attempts.filter((attempt) => attempt.acquired);
    expect(acquired).toHaveLength(1);
    expect(
      __test__.parseLeaseRecord(
        await fs.readFile(path.join(await lockDir(), __test__.ownerFilename), "utf8"),
      ),
    ).toEqual(expect.objectContaining({ pid: process.pid }));
    if (acquired[0]?.acquired) await acquired[0].lease.release();
  });

  test("reclaims a corrupt owner record through the in-directory marker", async () => {
    await fs.mkdir(await lockDir(), { recursive: true });
    await fs.writeFile(path.join(await lockDir(), __test__.ownerFilename), "not-json", "utf8");

    const acquired = await acquireSessionReattachLease(sessionId);
    expect(acquired.acquired).toBe(true);
    expect(await fs.readdir(await lockDir())).not.toContain(__test__.reclaimFilename);
    if (acquired.acquired) await acquired.lease.release();
  });

  test("takes over a stale reclaim marker and completes recovery", async () => {
    const target = await lockDir();
    await writeLeaseDirectory(target, {
      pid: 9100,
      leaseId: "stale-parent",
      createdAt: "2026-07-20T00:00:00.000Z",
      processStartIdentity: "stale-parent-start",
    });
    await writeLeaseDirectory(path.join(target, __test__.reclaimFilename), {
      pid: 9101,
      leaseId: "dead-reclaimer",
      createdAt: "2026-07-20T00:00:01.000Z",
      processStartIdentity: "dead-reclaimer-start",
    });

    const acquired = await __test__.acquireAtPath(target, {
      pid: 9102,
      leaseId: "replacement-reclaimer",
      isProcessAlive: (pid) => pid === 9102,
      readProcessStartIdentity: async (pid) => `start-${pid}`,
    });

    expect(acquired.acquired).toBe(true);
    expect(await fs.readdir(target)).toEqual([__test__.ownerFilename]);
    if (acquired.acquired) await acquired.lease.release();
  });

  test("treats a live reclaim marker as busy without exposing partial state", async () => {
    const target = await lockDir();
    const parentOwner = {
      pid: 9200,
      leaseId: "stale-parent",
      createdAt: "2026-07-20T00:00:00.000Z",
      processStartIdentity: "stale-parent-start",
    };
    const markerOwner = {
      pid: 9201,
      leaseId: "live-reclaimer",
      createdAt: "2026-07-20T00:00:01.000Z",
      processStartIdentity: "start-9201",
    };
    await writeLeaseDirectory(target, parentOwner);
    await writeLeaseDirectory(path.join(target, __test__.reclaimFilename), markerOwner);

    const result = await __test__.acquireAtPath(target, {
      pid: 9202,
      leaseId: "observer",
      isProcessAlive: (pid) => pid === markerOwner.pid || pid === 9202,
      readProcessStartIdentity: async (pid) => `start-${pid}`,
    });

    expect(result).toEqual({ acquired: false, ownerPid: markerOwner.pid });
    expect(
      __test__.parseLeaseRecord(
        await fs.readFile(
          path.join(target, __test__.reclaimFilename, __test__.ownerFilename),
          "utf8",
        ),
      ),
    ).toEqual(markerOwner);
  });

  test("a delayed stale-marker contender cannot move a replacement marker", async () => {
    const target = await lockDir();
    await writeLeaseDirectory(target, {
      pid: 9300,
      leaseId: "stale-parent",
      createdAt: "2026-07-20T00:00:00.000Z",
      processStartIdentity: "stale-parent-start",
    });
    await writeLeaseDirectory(path.join(target, __test__.reclaimFilename), {
      pid: 9301,
      leaseId: "stale-reclaimer",
      createdAt: "2026-07-20T00:00:01.000Z",
      processStartIdentity: "stale-reclaimer-start",
    });
    const freshMarker = {
      pid: 9304,
      leaseId: "fresh-reclaimer",
      createdAt: "2026-07-20T00:00:03.000Z",
      processStartIdentity: "start-9304",
    };
    let replacementLease:
      | Extract<Awaited<ReturnType<typeof __test__.acquireAtPath>>, { acquired: true }>
      | undefined;

    const delayed = await __test__.acquireAtPath(target, {
      pid: 9302,
      leaseId: "delayed-contender",
      isProcessAlive: (pid) => pid === 9303 || pid === freshMarker.pid,
      readProcessStartIdentity: async (pid) => `start-${pid}`,
      afterStaleMarkerRevalidation: async () => {
        const winner = await __test__.acquireAtPath(target, {
          pid: 9303,
          leaseId: "takeover-winner",
          isProcessAlive: (pid) => pid === 9303,
          readProcessStartIdentity: async (pid) => `start-${pid}`,
        });
        if (!winner.acquired) throw new Error("Expected takeover winner");
        replacementLease = winner;
        await writeLeaseDirectory(path.join(target, __test__.reclaimFilename), freshMarker);
      },
    });

    expect(delayed.acquired).toBe(false);
    expect(
      __test__.parseLeaseRecord(
        await fs.readFile(
          path.join(target, __test__.reclaimFilename, __test__.ownerFilename),
          "utf8",
        ),
      ),
    ).toEqual(freshMarker);
    await replacementLease?.lease.release();
  });

  test("does not delete a replacement directory swapped in after reclaim marker acquisition", async () => {
    const target = await lockDir();
    await writeLeaseDirectory(target, {
      pid: 9001,
      leaseId: "stale-owner",
      createdAt: "2026-07-20T00:00:00.000Z",
      processStartIdentity: "stale-start",
    });
    const displaced = `${target}.displaced`;
    const replacementOwner = {
      pid: 9002,
      leaseId: "replacement-owner",
      createdAt: "2026-07-20T00:00:01.000Z",
      processStartIdentity: "replacement-start",
    };

    const result = await __test__.acquireAtPath(target, {
      pid: 9003,
      leaseId: "claimant",
      readProcessStartIdentity: async (pid) => `actual-${pid}`,
      isProcessAlive: (pid) => pid === replacementOwner.pid,
      afterReclaimMarker: async () => {
        await fs.rename(target, displaced);
        await writeLeaseDirectory(target, replacementOwner);
      },
    });

    expect(result).toEqual({ acquired: false, ownerPid: replacementOwner.pid });
    expect(
      __test__.parseLeaseRecord(
        await fs.readFile(path.join(target, __test__.ownerFilename), "utf8"),
      ),
    ).toEqual(replacementOwner);
    expect(await fs.readdir(target)).not.toContain(__test__.reclaimFilename);
  });

  test("reclaims an alive PID when its process-start identity does not match", async () => {
    const target = await lockDir();
    await writeLeaseDirectory(target, {
      pid: 9020,
      leaseId: "reused-pid-owner",
      createdAt: new Date().toISOString(),
      processStartIdentity: "old-process-start",
    });

    const acquired = await __test__.acquireAtPath(target, {
      pid: 9021,
      leaseId: "claimant",
      isProcessAlive: () => true,
      readProcessStartIdentity: async (pid) =>
        pid === 9020 ? "new-process-start" : "claimant-start",
    });
    expect(acquired.acquired).toBe(true);
    if (acquired.acquired) await acquired.lease.release();
  });

  test("falls back conservatively when a live owner's start identity is unavailable", async () => {
    const target = await lockDir();
    await writeLeaseDirectory(target, {
      pid: 9010,
      leaseId: "unknown-start-owner",
      createdAt: new Date().toISOString(),
      processStartIdentity: "recorded-start",
    });

    const result = await __test__.acquireAtPath(target, {
      pid: 9011,
      isProcessAlive: () => true,
      readProcessStartIdentity: async () => null,
    });
    expect(result).toEqual({ acquired: false, ownerPid: 9010 });
  });

  test("an old owner cannot release a replacement directory", async () => {
    const first = await acquireSessionReattachLease(sessionId);
    if (!first.acquired) throw new Error("Expected first lease");

    await fs.rm(await lockDir(), { recursive: true, force: true });
    const replacement = await acquireSessionReattachLease(sessionId);
    if (!replacement.acquired) throw new Error("Expected replacement lease");
    const replacementRaw = await fs.readFile(
      path.join(await lockDir(), __test__.ownerFilename),
      "utf8",
    );

    await first.lease.release();
    expect(await fs.readFile(path.join(await lockDir(), __test__.ownerFilename), "utf8")).toBe(
      replacementRaw,
    );

    await replacement.lease.release();
  });
});
