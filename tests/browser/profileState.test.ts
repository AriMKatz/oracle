import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as profileState from "../../src/browser/profileState.js";

describe("profileState", () => {
  test("writes DevToolsActivePort to both root and Default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      const root = path.join(dir, "DevToolsActivePort");
      const nested = path.join(dir, "Default", "DevToolsActivePort");
      expect(existsSync(root)).toBe(true);
      expect(existsSync(nested)).toBe(true);
      expect((await readFile(root, "utf8")).split("\n")[0]?.trim()).toBe("12345");
      expect((await readFile(nested, "utf8")).split("\n")[0]?.trim()).toBe("12345");
      await expect(profileState.readDevToolsPort(dir)).resolves.toBe(12345);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cleans DevToolsActivePort, but only removes locks when oracle pid is dead", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    const lockFiles = [
      path.join(dir, "lockfile"),
      path.join(dir, "SingletonLock"),
      path.join(dir, "SingletonSocket"),
      path.join(dir, "SingletonCookie"),
    ];
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      for (const lock of lockFiles) {
        await writeFile(lock, "x");
      }

      // Alive pid => keep locks
      await profileState.writeChromePid(dir, process.pid);
      await profileState.cleanupStaleProfileState(dir, undefined, {
        lockRemovalMode: "if_oracle_pid_dead",
      });
      expect(existsSync(path.join(dir, "DevToolsActivePort"))).toBe(false);
      for (const lock of lockFiles) {
        expect(existsSync(lock)).toBe(true);
      }

      // Dead pid => remove locks
      for (const lock of lockFiles) {
        await writeFile(lock, "x");
      }
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await once(child, "exit");
      await profileState.writeChromePid(dir, child.pid ?? 0);
      await profileState.cleanupStaleProfileState(dir, undefined, {
        lockRemovalMode: "if_oracle_pid_dead",
      });
      for (const lock of lockFiles) {
        expect(existsSync(lock)).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips manual-login cleanup when DevTools port is still reachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      await expect(
        profileState.shouldCleanupManualLoginProfileState(dir, undefined, {
          connectionClosedUnexpectedly: true,
          probe: async () => ({ ok: true }),
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips normal manual-login cleanup when reused Chrome is still reachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      await expect(
        profileState.shouldCleanupManualLoginProfileState(dir, undefined, {
          connectionClosedUnexpectedly: false,
          probe: async () => ({ ok: true }),
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs manual-login cleanup when DevTools port is unreachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      await expect(
        profileState.shouldCleanupManualLoginProfileState(dir, undefined, {
          connectionClosedUnexpectedly: true,
          probe: async () => ({ ok: false, error: "offline" }),
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("acquires and releases the manual-login profile lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 500, pollMs: 50 });
      expect(lock).not.toBeNull();
      const lockPath = path.join(dir, "oracle-automation.lock");
      expect(existsSync(lockPath)).toBe(true);
      await lock?.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("waits for profile lock and errors on timeout", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 500, pollMs: 50 });
      await expect(
        profileState.acquireProfileRunLock(dir, { timeoutMs: 150, pollMs: 50 }),
      ).rejects.toThrow(/profile lock/i);
      await lock?.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clears stale profile lock when pid is dead", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await once(child, "exit");
      if (!child.pid) {
        throw new Error("Missing child pid");
      }
      const lockPath = path.join(dir, "oracle-automation.lock");
      await writeFile(
        lockPath,
        JSON.stringify({ pid: child.pid, lockId: "stale", createdAt: new Date().toISOString() }),
      );
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 500, pollMs: 50 });
      expect(lock).not.toBeNull();
      await lock?.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deletes unreadable profile lock and continues", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const lockPath = path.join(dir, "oracle-automation.lock");
      await writeFile(lockPath, "not-json");
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 2000, pollMs: 50 });
      expect(lock).not.toBeNull();
      expect(existsSync(lockPath)).toBe(true);
      await lock?.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("matches recorded Chrome commands to the expected profile", () => {
    const dir = "/Users/example/.oracle/browser-profile";
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir}`,
        dir,
      ),
    ).toBe(true);
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/other",
        dir,
      ),
    ).toBe(false);
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir}-attacker`,
        dir,
      ),
    ).toBe(false);
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir="/tmp/profile with spaces"',
        "/tmp/profile with spaces",
      ),
    ).toBe(true);
    expect(profileState.isChromeCommandForUserDataDirForTest("node worker.js", dir)).toBe(false);
  });

  test("discovers running Chrome DevTools port from process list", () => {
    const dir = "/Users/example/.oracle/browser-profile";
    const processList = `
      123 node worker.js
      456 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=64304 --user-data-dir=${dir}-attacker about:blank
      457 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=64305 --user-data-dir=${dir} about:blank
      789 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/other
    `;

    expect(
      profileState.findChromeDebugTargetForProfileFromProcessListForTest(processList, dir),
    ).toEqual({
      pid: 457,
      port: 64305,
    });
  });

  test("validates, terminates, and removes only the exact copied-profile Chrome", async () => {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "oracle-source-profile-"));
    const copiedDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-"));
    const pid = 4242;
    const port = 64321;
    let alive = true;
    try {
      const identity = await profileState.validateExactCopiedProfileChrome(
        {
          userDataDir: copiedDir,
          sourceUserDataDir: sourceDir,
          copiedProfileRoot: path.dirname(copiedDir),
          pid,
          port,
        },
        {
          findRunning: async () => ({ pid, port }),
          probe: async () => ({ ok: true }),
        },
      );

      expect(identity).toMatchObject({
        userDataDir: copiedDir,
        sourceUserDataDir: sourceDir,
        copiedProfileRoot: path.dirname(copiedDir),
        pid,
        port,
        host: "127.0.0.1",
      });

      await profileState.cleanupExactCopiedProfileChrome(identity, undefined, {
        findRunning: async () => ({ pid, port }),
        processAlive: () => alive,
        terminate: async () => {
          alive = false;
          return true;
        },
        waitForExit: async () => {},
        chromeUsesProfile: async () => false,
      });

      expect(alive).toBe(false);
      expect(existsSync(copiedDir)).toBe(false);
      expect(existsSync(sourceDir)).toBe(true);
    } finally {
      await rm(copiedDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("preserves a copied profile when the persisted Chrome identity mismatches", async () => {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "oracle-source-profile-"));
    const copiedDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-"));
    const pid = 4242;
    const port = 64322;
    try {
      const identity = await profileState.validateExactCopiedProfileChrome(
        {
          userDataDir: copiedDir,
          sourceUserDataDir: sourceDir,
          copiedProfileRoot: path.dirname(copiedDir),
          pid,
          port,
        },
        {
          findRunning: async () => ({ pid, port }),
          probe: async () => ({ ok: true }),
        },
      );

      await expect(
        profileState.cleanupExactCopiedProfileChrome({ ...identity, port: port + 1 }, undefined, {
          findRunning: async () => ({ pid, port }),
        }),
      ).rejects.toThrow(/identity changed/i);
      expect(existsSync(copiedDir)).toBe(true);
    } finally {
      await rm(copiedDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("rejects a copied profile that is not a direct child of its recorded root", async () => {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "oracle-source-profile-"));
    const copiedProfileRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-copy-root-"));
    const nestedRoot = path.join(copiedProfileRoot, "nested");
    await mkdir(nestedRoot);
    const copiedDir = await mkdtemp(path.join(nestedRoot, "oracle-browser-"));
    try {
      await expect(
        profileState.validateExactCopiedProfileChrome(
          {
            userDataDir: copiedDir,
            sourceUserDataDir: sourceDir,
            copiedProfileRoot,
            pid: 4242,
            port: 64323,
          },
          {
            findRunning: async () => ({ pid: 4242, port: 64323 }),
            probe: async () => ({ ok: true }),
          },
        ),
      ).rejects.toThrow(/not a direct child/i);
      expect(existsSync(copiedDir)).toBe(true);
    } finally {
      await rm(copiedProfileRoot, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test("rejects a non-loopback copied-profile DevTools host", async () => {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "oracle-source-profile-"));
    const copiedDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-"));
    try {
      await expect(
        profileState.validateExactCopiedProfileChrome(
          {
            userDataDir: copiedDir,
            sourceUserDataDir: sourceDir,
            copiedProfileRoot: path.dirname(copiedDir),
            pid: 4242,
            port: 64324,
            host: "attacker.invalid",
          },
          {
            findRunning: async () => ({ pid: 4242, port: 64324 }),
            probe: async () => ({ ok: true }),
          },
        ),
      ).rejects.toThrow(/loopback DevTools host/i);
      expect(existsSync(copiedDir)).toBe(true);
    } finally {
      await rm(copiedDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});
