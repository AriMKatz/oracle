import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  copyChromeProfile,
  resolveChromeProfileDirectoryForTest,
} from "../../src/browser/profileCopy.js";

describe("copyChromeProfile", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tmpDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
    );
  });

  test("fails fast when the required Local State file cannot be copied", async () => {
    const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
    tmpDirs.push(dest);
    // A source dir without a `Local State` file must fail loudly, not continue with a
    // profile that will later look unauthenticated.
    const srcWithoutLocalState = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-src-"));
    tmpDirs.push(srcWithoutLocalState);

    await expect(copyChromeProfile(srcWithoutLocalState, dest)).rejects.toThrow(/Local State/);
    await expect(stat(dest)).rejects.toThrow();
  });

  test.skipIf(process.platform === "win32")(
    "copies the active Local State profile instead of assuming Default",
    async () => {
      const src = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-src-"));
      const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
      tmpDirs.push(src, dest);
      await mkdir(path.join(src, "Profile 2"), { recursive: true });
      await mkdir(path.join(src, "Default"), { recursive: true });
      await writeFile(
        path.join(src, "Local State"),
        JSON.stringify({ profile: { last_used: "Profile 2" } }),
      );
      await writeFile(path.join(src, "Profile 2", "Cookies"), "active-session");
      await writeFile(path.join(src, "Default", "Cookies"), "wrong-session");

      await expect(copyChromeProfile(src, dest)).resolves.toBe("Profile 2");
      await expect(readFile(path.join(dest, "Profile 2", "Cookies"), "utf8")).resolves.toBe(
        "active-session",
      );
      await expect(stat(path.join(dest, "Default"))).rejects.toThrow();
    },
  );

  test("retries one transient rsync exit 23", async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-src-"));
    const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
    tmpDirs.push(src, dest);
    await mkdir(path.join(src, "Default"), { recursive: true });
    await writeFile(
      path.join(src, "Local State"),
      JSON.stringify({ profile: { last_used: "Default" } }),
    );
    const rsyncRunner = vi
      .fn()
      .mockResolvedValueOnce({ code: 23 })
      .mockResolvedValueOnce({ code: 0 });

    await expect(
      copyChromeProfile(src, dest, null, { rsyncRunner, retryDelayMs: 0 }),
    ).resolves.toBe("Default");
    expect(rsyncRunner).toHaveBeenCalledTimes(2);
  });

  test("accepts rsync exit 24 without retrying", async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-src-"));
    const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
    tmpDirs.push(src, dest);
    await mkdir(path.join(src, "Default"), { recursive: true });
    await writeFile(
      path.join(src, "Local State"),
      JSON.stringify({ profile: { last_used: "Default" } }),
    );
    const rsyncRunner = vi.fn().mockResolvedValue({ code: 24 });

    await expect(
      copyChromeProfile(src, dest, null, { rsyncRunner, retryDelayMs: 0 }),
    ).resolves.toBe("Default");
    expect(rsyncRunner).toHaveBeenCalledTimes(1);
  });

  test("does not retry a non-transient rsync failure", async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-src-"));
    const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
    tmpDirs.push(src, dest);
    await mkdir(path.join(src, "Default"), { recursive: true });
    await writeFile(
      path.join(src, "Local State"),
      JSON.stringify({ profile: { last_used: "Default" } }),
    );
    const rsyncRunner = vi.fn().mockResolvedValue({ code: 1 });

    await expect(
      copyChromeProfile(src, dest, null, { rsyncRunner, retryDelayMs: 0 }),
    ).rejects.toThrow(/attempt 1 exit 1/);
    expect(rsyncRunner).toHaveBeenCalledTimes(1);
    await expect(stat(dest)).rejects.toThrow();
  });

  test("retries from an empty destination", async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-src-"));
    const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
    tmpDirs.push(src, dest);
    const destProfile = path.join(dest, "Default");
    const staleDirectory = path.join(destProfile, "Locked Data");
    await mkdir(path.join(src, "Default"), { recursive: true });
    await writeFile(
      path.join(src, "Local State"),
      JSON.stringify({ profile: { last_used: "Default" } }),
    );
    const rsyncRunner = vi
      .fn()
      .mockImplementationOnce(async () => {
        await mkdir(staleDirectory, { recursive: true });
        await writeFile(path.join(staleDirectory, "Cookies-wal"), "stale");
        await chmod(staleDirectory, 0o500);
        return { code: 23 };
      })
      .mockImplementationOnce(async () => {
        await expect(stat(staleDirectory)).rejects.toThrow();
        await writeFile(path.join(destProfile, "Cookies"), "coherent");
        return { code: 0 };
      });

    await expect(
      copyChromeProfile(src, dest, null, { rsyncRunner, retryDelayMs: 0 }),
    ).resolves.toBe("Default");
    await expect(readFile(path.join(destProfile, "Cookies"), "utf8")).resolves.toBe("coherent");
    await expect(stat(staleDirectory)).rejects.toThrow();
  });

  test.skipIf(process.platform === "win32")("normalizes copied directory permissions", async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-src-"));
    const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
    tmpDirs.push(src, dest);
    const sourceDirectory = path.join(src, "Default", "Locked Data");
    const sourceFile = path.join(sourceDirectory, "Cookies");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(
      path.join(src, "Local State"),
      JSON.stringify({ profile: { last_used: "Default" } }),
    );
    await writeFile(sourceFile, "session-placeholder");
    await chmod(sourceFile, 0o400);
    await chmod(sourceDirectory, 0o500);

    try {
      await expect(copyChromeProfile(src, dest)).resolves.toBe("Default");
      const copiedDirectory = await stat(path.join(dest, "Default", "Locked Data"));
      expect(copiedDirectory.mode & 0o777).toBe(0o700);
    } finally {
      await chmod(sourceDirectory, 0o700).catch(() => undefined);
      await chmod(sourceFile, 0o600).catch(() => undefined);
    }
  });

  test("removes the partial copy when the retry also fails", async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-src-"));
    const dest = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-dest-"));
    tmpDirs.push(src, dest);
    await mkdir(path.join(src, "Default"), { recursive: true });
    await writeFile(
      path.join(src, "Local State"),
      JSON.stringify({ profile: { last_used: "Default" } }),
    );
    const rsyncRunner = vi
      .fn()
      .mockResolvedValueOnce({ code: 23 })
      .mockImplementationOnce(async () => {
        const restrictiveDirectory = path.join(dest, "Default", "Locked Data");
        await mkdir(restrictiveDirectory, { recursive: true });
        await writeFile(path.join(restrictiveDirectory, "Cookies-wal"), "partial");
        await chmod(restrictiveDirectory, 0o500);
        return { code: 23 };
      });

    await expect(
      copyChromeProfile(src, dest, null, { rsyncRunner, retryDelayMs: 0 }),
    ).rejects.toThrow(/attempt 1 exit 23; attempt 2 exit 23/);
    await expect(stat(dest)).rejects.toThrow();
  });

  test("accepts an explicit direct-child profile and rejects nested paths", () => {
    const localState = JSON.stringify({ profile: { last_used: "Profile 2" } });
    expect(
      resolveChromeProfileDirectoryForTest("/tmp/chrome", localState, "/tmp/chrome/Profile 4"),
    ).toBe("Profile 4");
    expect(() =>
      resolveChromeProfileDirectoryForTest("/tmp/chrome", localState, "Profile 4/Cookies"),
    ).toThrow(/direct child/);
  });
});
