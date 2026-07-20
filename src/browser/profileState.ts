import path from "node:path";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delay } from "./utils.js";

export type ProfileStateLogger = (message: string) => void;

const DEVTOOLS_ACTIVE_PORT_FILENAME = "DevToolsActivePort";
const DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS = [
  DEVTOOLS_ACTIVE_PORT_FILENAME,
  path.join("Default", DEVTOOLS_ACTIVE_PORT_FILENAME),
] as const;

const CHROME_PID_FILENAME = "chrome.pid";
const ORACLE_PROFILE_LOCK_FILENAME = "oracle-automation.lock";

const execFileAsync = promisify(execFile);

export function getDevToolsActivePortPaths(userDataDir: string): string[] {
  return DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS.map((relative) => path.join(userDataDir, relative));
}

export async function readDevToolsPort(userDataDir: string): Promise<number | null> {
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      const raw = await readFile(candidate, "utf8");
      const firstLine = raw.split(/\r?\n/u)[0]?.trim();
      const port = Number.parseInt(firstLine ?? "", 10);
      if (Number.isFinite(port)) {
        return port;
      }
    } catch {
      // ignore missing/unreadable candidates
    }
  }
  return null;
}

export async function writeDevToolsActivePort(userDataDir: string, port: number): Promise<void> {
  const contents = `${port}\n/devtools/browser`;
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      await mkdir(path.dirname(candidate), { recursive: true });
      await writeFile(candidate, contents, "utf8");
    } catch {
      // best effort
    }
  }
}

export async function readChromePid(userDataDir: string): Promise<number | null> {
  const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
  try {
    const raw = (await readFile(pidPath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

export async function writeChromePid(userDataDir: string, pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
  try {
    await mkdir(path.dirname(pidPath), { recursive: true });
    await writeFile(pidPath, `${Math.trunc(pid)}\n`, "utf8");
  } catch {
    // best effort
  }
}

export interface RunningChromeDebugTarget {
  pid: number;
  port: number;
}

export interface ExactCopiedProfileChrome {
  userDataDir: string;
  sourceUserDataDir: string;
  copiedProfileRoot: string;
  pid: number;
  port: number;
  host: string;
}

export async function findRunningChromeDebugTargetForProfile(
  userDataDir: string,
): Promise<RunningChromeDebugTarget | null> {
  if (process.platform === "win32") {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=", "-o", "command="], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return findChromeDebugTargetForProfileFromProcessList(String(stdout ?? ""), userDataDir);
  } catch {
    return null;
  }
}

function findChromeDebugTargetForProfileFromProcessList(
  processList: string,
  userDataDir: string,
): RunningChromeDebugTarget | null {
  for (const line of processList.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const command = match[2] ?? "";
    const lower = command.toLowerCase();
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!lower.includes("chrome") && !lower.includes("chromium")) continue;
    if (!hasExactCommandFlagValue(command, "--user-data-dir", userDataDir)) continue;
    const portMatch = command.match(/--remote-debugging-port(?:=|\s+)(\d+)/);
    const port = Number.parseInt(portMatch?.[1] ?? "", 10);
    if (!Number.isFinite(port) || port <= 0) continue;
    return { pid, port };
  }
  return null;
}

export function findChromeDebugTargetForProfileFromProcessListForTest(
  processList: string,
  userDataDir: string,
): RunningChromeDebugTarget | null {
  return findChromeDebugTargetForProfileFromProcessList(processList, userDataDir);
}

export async function terminateRecordedChromeForProfile(
  userDataDir: string,
  logger?: ProfileStateLogger,
): Promise<boolean> {
  const pid = await readChromePid(userDataDir);
  if (!pid) {
    return false;
  }
  return terminateChromePidForProfile(pid, userDataDir, logger);
}

export async function terminateChromePidForProfile(
  pid: number,
  userDataDir: string,
  logger?: ProfileStateLogger,
): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return false;
  }
  const command = await readProcessCommand(pid);
  if (!isChromeCommandForUserDataDir(command, userDataDir)) {
    logger?.(`Recorded Chrome pid ${pid} does not match ${userDataDir}; skipping termination`);
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
    logger?.(`Terminated shared manual-login Chrome pid ${pid}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.(`Failed to terminate shared manual-login Chrome pid ${pid}: ${message}`);
    return false;
  }
}

export async function validateExactCopiedProfileChrome(
  input: {
    userDataDir: string;
    sourceUserDataDir: string;
    copiedProfileRoot: string;
    pid: number;
    port: number;
    host?: string;
  },
  options: {
    findRunning?: typeof findRunningChromeDebugTargetForProfile;
    probe?: typeof verifyDevToolsReachable;
  } = {},
): Promise<ExactCopiedProfileChrome> {
  const userDataDir = path.resolve(input.userDataDir);
  const sourceUserDataDir = path.resolve(input.sourceUserDataDir);
  const copiedProfileRoot = path.resolve(input.copiedProfileRoot);
  await assertOwnedCopiedProfilePath(userDataDir, sourceUserDataDir, copiedProfileRoot);

  if (!Number.isFinite(input.pid) || input.pid <= 0) {
    throw new Error("Copied-profile recovery requires the persisted Chrome pid.");
  }
  if (!Number.isFinite(input.port) || input.port <= 0) {
    throw new Error("Copied-profile recovery requires the persisted Chrome DevTools port.");
  }

  const running = await (options.findRunning ?? findRunningChromeDebugTargetForProfile)(
    userDataDir,
  );
  if (!running) {
    throw new Error(`No live Chrome process matches copied profile ${userDataDir}.`);
  }
  if (running.pid !== input.pid || running.port !== input.port) {
    throw new Error(
      `Copied-profile Chrome identity mismatch: expected pid ${input.pid} on port ${input.port}, found pid ${running.pid} on port ${running.port}.`,
    );
  }

  const persistedHost = input.host?.trim() || "127.0.0.1";
  if (!isLoopbackHost(persistedHost)) {
    throw new Error(
      `Copied-profile Chrome must use a loopback DevTools host; received ${persistedHost}.`,
    );
  }
  const host = "127.0.0.1";
  const probe = await (options.probe ?? verifyDevToolsReachable)({
    host,
    port: input.port,
  });
  if (!probe.ok) {
    throw new Error(
      `Copied-profile Chrome pid ${input.pid} is not reachable on ${host}:${input.port} (${probe.error}).`,
    );
  }

  return {
    userDataDir,
    sourceUserDataDir,
    copiedProfileRoot,
    pid: input.pid,
    port: input.port,
    host,
  };
}

export async function cleanupExactCopiedProfileChrome(
  identity: ExactCopiedProfileChrome,
  logger?: ProfileStateLogger,
  options: {
    gracefulWaitMs?: number;
    forceWaitMs?: number;
    findRunning?: typeof findRunningChromeDebugTargetForProfile;
    processAlive?: typeof isProcessAlive;
    terminate?: typeof terminateChromePidForProfile;
    readCommand?: (pid: number) => Promise<string | null>;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    waitForExit?: (pid: number, timeoutMs: number) => Promise<void>;
    chromeUsesProfile?: (userDataDir: string) => Promise<boolean>;
    removeProfile?: (userDataDir: string) => Promise<void>;
  } = {},
): Promise<void> {
  await assertOwnedCopiedProfilePath(
    identity.userDataDir,
    identity.sourceUserDataDir,
    identity.copiedProfileRoot,
  );

  const findRunning = options.findRunning ?? findRunningChromeDebugTargetForProfile;
  const processAlive = options.processAlive ?? isProcessAlive;
  const terminate = options.terminate ?? terminateChromePidForProfile;
  const readCommand = options.readCommand ?? readProcessCommand;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const waitForExit =
    options.waitForExit ?? ((pid, timeoutMs) => waitForProcessExit(pid, timeoutMs, processAlive));
  const chromeUsesProfile = options.chromeUsesProfile ?? isChromeUsingUserDataDir;
  const removeProfile =
    options.removeProfile ?? ((userDataDir) => rm(userDataDir, { recursive: true, force: true }));

  const running = await findRunning(identity.userDataDir);
  if (running && (running.pid !== identity.pid || running.port !== identity.port)) {
    throw new Error(
      `Refusing copied-profile cleanup after Chrome identity changed: expected pid ${identity.pid} on port ${identity.port}, found pid ${running.pid} on port ${running.port}.`,
    );
  }

  if (processAlive(identity.pid)) {
    if (!running) {
      throw new Error(
        `Refusing copied-profile cleanup because pid ${identity.pid} is alive but no longer matches ${identity.userDataDir}.`,
      );
    }
    const terminated = await terminate(identity.pid, identity.userDataDir, logger);
    if (!terminated) {
      throw new Error(
        `Refusing copied-profile cleanup because pid ${identity.pid} could not be verified and terminated.`,
      );
    }
    await waitForExit(identity.pid, options.gracefulWaitMs ?? 5_000);
  }

  if (processAlive(identity.pid)) {
    const command = await readCommand(identity.pid);
    if (!isChromeCommandForUserDataDir(command, identity.userDataDir)) {
      throw new Error(
        `Refusing to force-terminate pid ${identity.pid} because it no longer matches ${identity.userDataDir}.`,
      );
    }
    kill(identity.pid, "SIGKILL");
    await waitForExit(identity.pid, options.forceWaitMs ?? 2_000);
  }
  if (processAlive(identity.pid)) {
    throw new Error(
      `Copied-profile Chrome pid ${identity.pid} did not exit; profile was preserved.`,
    );
  }
  if (await chromeUsesProfile(identity.userDataDir)) {
    throw new Error(
      `Another Chrome process is using ${identity.userDataDir}; copied profile was preserved.`,
    );
  }

  await removeProfile(identity.userDataDir);
  logger?.(`Removed throwaway copied Chrome profile ${identity.userDataDir}`);
}

async function assertOwnedCopiedProfilePath(
  userDataDir: string,
  sourceUserDataDir: string,
  copiedProfileRoot: string,
): Promise<void> {
  const resolvedUserDataDir = path.resolve(userDataDir);
  const resolvedSourceUserDataDir = path.resolve(sourceUserDataDir);
  const resolvedCopiedProfileRoot = path.resolve(copiedProfileRoot);
  if (!path.basename(resolvedUserDataDir).startsWith("oracle-browser-")) {
    throw new Error(
      `Refusing copied-profile recovery for non-Oracle temporary path ${resolvedUserDataDir}.`,
    );
  }
  const stat = await lstat(resolvedUserDataDir).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Refusing copied-profile recovery because ${resolvedUserDataDir} is not a real directory.`,
    );
  }
  const canonicalUserDataDir = await realpath(resolvedUserDataDir);
  const rootStat = await lstat(resolvedCopiedProfileRoot).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(
      `Refusing copied-profile recovery because recorded root ${resolvedCopiedProfileRoot} is not a real directory.`,
    );
  }
  const canonicalCopiedProfileRoot = await realpath(resolvedCopiedProfileRoot);
  if (path.dirname(canonicalUserDataDir) !== canonicalCopiedProfileRoot) {
    throw new Error(
      `Refusing copied-profile recovery because ${canonicalUserDataDir} is not a direct child of recorded root ${canonicalCopiedProfileRoot}.`,
    );
  }
  const canonicalSourceUserDataDir = await realpath(resolvedSourceUserDataDir).catch(
    () => resolvedSourceUserDataDir,
  );
  if (canonicalUserDataDir === canonicalSourceUserDataDir) {
    throw new Error("Refusing to treat the source Chrome profile as a throwaway copied profile.");
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  processAlive: (pid: number) => boolean = isProcessAlive,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (processAlive(pid) && Date.now() < deadline) {
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

function isChromeCommandForUserDataDir(command: string | null, userDataDir: string): boolean {
  if (!command) return false;
  const lower = command.toLowerCase();
  if (
    (!lower.includes("chrome") && !lower.includes("chromium")) ||
    !lower.includes("user-data-dir")
  ) {
    return false;
  }
  return hasExactCommandFlagValue(command, "--user-data-dir", userDataDir);
}

function hasExactCommandFlagValue(command: string, flag: string, expectedValue: string): boolean {
  let searchFrom = 0;
  while (searchFrom < command.length) {
    const flagIndex = command.indexOf(flag, searchFrom);
    if (flagIndex < 0) return false;
    const preceding = command[flagIndex - 1];
    if (flagIndex > 0 && preceding && !/\s/u.test(preceding)) {
      searchFrom = flagIndex + flag.length;
      continue;
    }
    let valueStart = flagIndex + flag.length;
    if (command[valueStart] === "=") {
      valueStart += 1;
    } else {
      const whitespace = command.slice(valueStart).match(/^\s+/u)?.[0];
      if (!whitespace) {
        searchFrom = flagIndex + flag.length;
        continue;
      }
      valueStart += whitespace.length;
    }
    const quote = command[valueStart];
    if (quote === '"' || quote === "'") {
      const valueEnd = command.indexOf(quote, valueStart + 1);
      if (valueEnd >= 0 && command.slice(valueStart + 1, valueEnd) === expectedValue) {
        return true;
      }
    } else if (command.startsWith(expectedValue, valueStart)) {
      const following = command[valueStart + expectedValue.length];
      if (following === undefined || /\s/u.test(following)) {
        return true;
      }
    }
    searchFrom = flagIndex + flag.length;
  }
  return false;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function isChromeCommandForUserDataDirForTest(
  command: string | null,
  userDataDir: string,
): boolean {
  return isChromeCommandForUserDataDir(command, userDataDir);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means "exists but no permission"; treat as alive.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

export interface ProfileRunLock {
  path: string;
  lockId: string;
  release: () => Promise<void>;
}

interface ProfileRunLockRecord {
  pid: number;
  lockId: string;
  createdAt: string;
  sessionId?: string;
}

function parseProfileRunLock(payload: string | null): ProfileRunLockRecord | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as ProfileRunLockRecord;
    if (!Number.isFinite(parsed.pid) || parsed.pid <= 0) return null;
    if (!parsed.lockId || typeof parsed.lockId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function acquireProfileRunLock(
  userDataDir: string,
  options: {
    timeoutMs: number;
    pollMs?: number;
    logger?: ProfileStateLogger;
    sessionId?: string;
  },
): Promise<ProfileRunLock | null> {
  const timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  const pollMs =
    typeof options.pollMs === "number" && Number.isFinite(options.pollMs) && options.pollMs > 0
      ? options.pollMs
      : 1000;
  const lockPath = path.join(userDataDir, ORACLE_PROFILE_LOCK_FILENAME);
  const lockId = randomUUID();
  const startedAt = Date.now();
  let warned = false;

  for (;;) {
    try {
      const payload: ProfileRunLockRecord = {
        pid: process.pid,
        lockId,
        createdAt: new Date().toISOString(),
        sessionId: options.sessionId,
      };
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
      options.logger?.(`Acquired Oracle profile lock at ${lockPath}`);
      return {
        path: lockPath,
        lockId,
        release: async () => releaseProfileRunLock(lockPath, lockId, options.logger),
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") {
        throw error;
      }
      let existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
      if (!existing) {
        // Likely partial write / corruption; re-read once, then delete (user preference: delete unreadable lockfiles).
        await delay(200);
        existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
        if (!existing) {
          options.logger?.("Oracle profile lock unreadable; deleting lockfile.");
          await rm(lockPath, { force: true }).catch(() => undefined);
          continue;
        }
      }
      if (!existing || !isProcessAlive(existing.pid)) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (!warned) {
        const waited = Math.round(timeoutMs / 1000);
        options.logger?.(
          `Oracle profile lock held by pid ${existing.pid}; waiting up to ${waited}s.`,
        );
        warned = true;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new Error(
          `Oracle profile lock still held by pid ${existing.pid} after ${Math.round(elapsed / 1000)}s`,
        );
      }
      await delay(Math.min(pollMs, timeoutMs - elapsed));
    }
  }
}

export async function releaseProfileRunLock(
  lockPath: string,
  lockId: string,
  logger?: ProfileStateLogger,
): Promise<void> {
  try {
    const existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
    if (!existing || existing.lockId !== lockId) {
      return;
    }
    await rm(lockPath, { force: true });
    logger?.(`Released Oracle profile lock ${lockPath}`);
  } catch {
    // best effort
  }
}

export async function verifyDevToolsReachable({
  port,
  host = "127.0.0.1",
  attempts = 3,
  timeoutMs = 3000,
}: {
  port: number;
  host?: string;
  attempts?: number;
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const versionUrl = `http://${host}:${port}/json/version`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(versionUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return { ok: true };
    } catch (error) {
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }
  return { ok: false, error: "unreachable" };
}

export async function shouldCleanupManualLoginProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: {
    connectionClosedUnexpectedly?: boolean;
    host?: string;
    probe?: typeof verifyDevToolsReachable;
  } = {},
): Promise<boolean> {
  const port = await readDevToolsPort(userDataDir);
  if (!port) {
    return true;
  }
  const probe = await (options.probe ?? verifyDevToolsReachable)({ port, host: options.host });
  if (probe.ok) {
    logger?.(`DevTools port ${port} still reachable; preserving manual-login profile state`);
    return false;
  }
  logger?.(`DevTools port ${port} unreachable (${probe.error}); clearing stale profile state`);
  return true;
}

export async function cleanupStaleProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: { lockRemovalMode?: "never" | "if_oracle_pid_dead" } = {},
): Promise<void> {
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      await rm(candidate, { force: true });
      logger?.(`Removed stale DevToolsActivePort: ${candidate}`);
    } catch {
      // ignore cleanup errors
    }
  }

  const lockRemovalMode = options.lockRemovalMode ?? "never";
  if (lockRemovalMode === "never") {
    return;
  }

  const pid = await readChromePid(userDataDir);
  if (!pid) {
    return;
  }
  if (isProcessAlive(pid)) {
    logger?.(`Chrome pid ${pid} still alive; skipping profile lock cleanup`);
    return;
  }

  // Extra safety: if Chrome is running with this profile (but with a different PID, e.g. user relaunched
  // without remote debugging), never delete lock files.
  if (await isChromeUsingUserDataDir(userDataDir)) {
    logger?.("Detected running Chrome using this profile; skipping profile lock cleanup");
    return;
  }

  const lockFiles = [
    path.join(userDataDir, "lockfile"),
    path.join(userDataDir, "SingletonLock"),
    path.join(userDataDir, "SingletonSocket"),
    path.join(userDataDir, "SingletonCookie"),
  ];
  for (const lock of lockFiles) {
    await rm(lock, { force: true }).catch(() => undefined);
  }
  logger?.("Cleaned up stale Chrome profile locks");
}

async function isChromeUsingUserDataDir(userDataDir: string): Promise<boolean> {
  if (process.platform === "win32") {
    // On Windows, lockfiles are typically held open and removal should fail anyway; avoid expensive process scans.
    return false;
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "command="], {
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = String(stdout ?? "").split("\n");
    for (const line of lines) {
      if (!line) continue;
      const lower = line.toLowerCase();
      if (!lower.includes("chrome") && !lower.includes("chromium")) continue;
      if (hasExactCommandFlagValue(line, "--user-data-dir", userDataDir)) {
        return true;
      }
    }
  } catch {
    // best effort
  }
  return false;
}

async function readProcessCommand(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(Math.trunc(pid)), "-o", "command="],
      {
        maxBuffer: 1024 * 1024,
      },
    );
    const command = String(stdout ?? "").trim();
    return command || null;
  } catch {
    return null;
  }
}
