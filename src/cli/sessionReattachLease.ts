import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { sessionStore } from "../sessionStore.js";

const REATTACH_LEASE_DIRNAME = ".oracle-reattach.lock";
const OWNER_FILENAME = "owner.json";
const RECLAIM_FILENAME = ".reclaim";
const MAX_RECLAIM_ATTEMPTS = 6;

interface SessionReattachLeaseRecord {
  pid: number;
  leaseId: string;
  createdAt: string;
  processStartIdentity?: string | null;
}

interface LeaseDirectoryObservation {
  identity: string;
  ownerRaw: string | null;
  owner: SessionReattachLeaseRecord | null;
}

interface SessionReattachLeaseDeps {
  pid?: number;
  leaseId?: string;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartIdentity?: (pid: number) => Promise<string | null>;
  afterReclaimMarker?: () => Promise<void>;
  afterStaleMarkerRevalidation?: () => Promise<void>;
}

export interface SessionReattachLease {
  release(): Promise<void>;
}

export type SessionReattachLeaseResult =
  | { acquired: true; lease: SessionReattachLease }
  | { acquired: false; ownerPid?: number };

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    return code === "EPERM";
  }
}

function parseLeaseRecord(raw: string | null): SessionReattachLeaseRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionReattachLeaseRecord>;
    if (!Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return null;
    if (typeof parsed.leaseId !== "string" || parsed.leaseId.length === 0) return null;
    if (typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt))) {
      return null;
    }
    if (
      parsed.processStartIdentity !== undefined &&
      parsed.processStartIdentity !== null &&
      typeof parsed.processStartIdentity !== "string"
    ) {
      return null;
    }
    return parsed as SessionReattachLeaseRecord;
  } catch {
    return null;
  }
}

async function runPsForStartIdentity(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart="],
        {
          encoding: "utf8",
          env: { ...process.env, LANG: "C", LC_ALL: "C" },
        },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const normalized = stdout.trim().replace(/\s+/g, " ");
          resolve(normalized ? `ps-lstart:${normalized}` : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fieldsAfterCommand = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const startTicks = fieldsAfterCommand[19];
      if (startTicks && /^\d+$/.test(startTicks)) {
        return `linux-proc-start:${startTicks}`;
      }
    } catch {
      // Fall through to ps. A live process with unavailable identity is
      // handled conservatively and is never reclaimed on PID alone.
    }
  }
  if (process.platform === "darwin" || process.platform === "linux") {
    return runPsForStartIdentity(pid);
  }
  return null;
}

async function directoryIdentity(dirPath: string): Promise<string | null> {
  try {
    const stats = await lstat(dirPath, { bigint: true });
    if (!stats.isDirectory()) return null;
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return null;
  }
}

async function observeLeaseDirectory(lockDir: string): Promise<LeaseDirectoryObservation | null> {
  const identityBefore = await directoryIdentity(lockDir);
  if (!identityBefore) return null;
  const ownerRaw = await readFile(path.join(lockDir, OWNER_FILENAME), "utf8").catch(() => null);
  const identityAfter = await directoryIdentity(lockDir);
  if (!identityAfter || identityAfter !== identityBefore) return null;
  return {
    identity: identityBefore,
    ownerRaw,
    owner: parseLeaseRecord(ownerRaw),
  };
}

async function publishLeaseDirectory(
  lockDir: string,
  record: SessionReattachLeaseRecord,
): Promise<boolean> {
  const candidateDir = `${lockDir}.candidate-${record.leaseId}`;
  await mkdir(path.dirname(lockDir), { recursive: true });
  await mkdir(candidateDir, { recursive: false });
  try {
    await writeFile(path.join(candidateDir, OWNER_FILENAME), JSON.stringify(record), "utf8");
    try {
      // The source directory is nonempty before publication. Renaming it is
      // atomic, while an existing nonempty destination makes this contender
      // the loser rather than replacing the current owner.
      await rename(candidateDir, lockDir);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        return false;
      }
      throw error;
    }
  } finally {
    await rm(candidateDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ownerIsCurrent(
  owner: SessionReattachLeaseRecord,
  deps: Required<Pick<SessionReattachLeaseDeps, "isProcessAlive" | "readProcessStartIdentity">>,
): Promise<boolean> {
  if (!deps.isProcessAlive(owner.pid)) {
    return false;
  }
  if (!owner.processStartIdentity) {
    return true;
  }
  const actualIdentity = await deps.readProcessStartIdentity(owner.pid);
  if (!actualIdentity) {
    return true;
  }
  return actualIdentity === owner.processStartIdentity;
}

async function markerIsOwned(lockDir: string, leaseId: string): Promise<boolean> {
  const marker = await observeLeaseDirectory(path.join(lockDir, RECLAIM_FILENAME));
  return marker?.owner?.leaseId === leaseId;
}

async function removeOwnedMarker(lockDir: string, leaseId: string): Promise<void> {
  const markerPath = path.join(lockDir, RECLAIM_FILENAME);
  const observed = await observeLeaseDirectory(markerPath);
  if (observed?.owner?.leaseId !== leaseId) return;
  const verified = await observeLeaseDirectory(markerPath);
  if (
    !verified ||
    verified.identity !== observed.identity ||
    verified.ownerRaw !== observed.ownerRaw ||
    verified.owner?.leaseId !== leaseId
  ) {
    return;
  }
  await rm(markerPath, { recursive: true, force: true }).catch(() => undefined);
}

function sameObservation(
  current: LeaseDirectoryObservation | null,
  observed: LeaseDirectoryObservation,
): boolean {
  return Boolean(
    current && current.identity === observed.identity && current.ownerRaw === observed.ownerRaw,
  );
}

async function quarantineObservedReclaimMarker(
  lockDir: string,
  parentObserved: LeaseDirectoryObservation,
  markerObserved: LeaseDirectoryObservation,
  afterRevalidation?: () => Promise<void>,
): Promise<boolean> {
  const markerPath = path.join(lockDir, RECLAIM_FILENAME);
  const parentIdentityKey = parentObserved.identity.replace(/[^a-zA-Z0-9._-]/g, "-");
  const markerIdentityKey = markerObserved.identity.replace(/[^a-zA-Z0-9._-]/g, "-");
  // Keep the fixed quarantine beside the parent lease, not inside it. It must
  // survive removal/replacement of the stale parent so a delayed contender
  // still cannot move a fresh parent's marker into the now-vacant guard path.
  const quarantinePath = `${lockDir}.reclaim-stale-${parentIdentityKey}-${markerIdentityKey}`;
  const currentParent = await observeLeaseDirectory(lockDir);
  const currentMarker = await observeLeaseDirectory(markerPath);
  if (
    !sameObservation(currentParent, parentObserved) ||
    !sameObservation(currentMarker, markerObserved)
  ) {
    return false;
  }
  await afterRevalidation?.();
  try {
    // The fixed, nonempty quarantine destination is the stale-marker CAS.
    // Once one contender moves this exact marker, later stale observers
    // cannot move a replacement marker over the still-present quarantine.
    await rename(markerPath, quarantinePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") {
      return false;
    }
    throw error;
  }
  const parentAfter = await observeLeaseDirectory(lockDir);
  const quarantined = await observeLeaseDirectory(quarantinePath);
  return (
    sameObservation(parentAfter, parentObserved) && sameObservation(quarantined, markerObserved)
  );
}

async function acquireReclaimMarker(
  lockDir: string,
  parentObserved: LeaseDirectoryObservation,
  claimant: SessionReattachLeaseRecord,
  deps: Required<Pick<SessionReattachLeaseDeps, "isProcessAlive" | "readProcessStartIdentity">> &
    Pick<SessionReattachLeaseDeps, "afterStaleMarkerRevalidation">,
): Promise<{ acquired: boolean; ownerPid?: number }> {
  const markerPath = path.join(lockDir, RECLAIM_FILENAME);
  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    if (await publishLeaseDirectory(markerPath, claimant)) {
      return { acquired: true };
    }
    const markerObserved = await observeLeaseDirectory(markerPath);
    if (!markerObserved) continue;
    if (markerObserved.owner && (await ownerIsCurrent(markerObserved.owner, deps))) {
      return { acquired: false, ownerPid: markerObserved.owner.pid };
    }
    if (
      !(await quarantineObservedReclaimMarker(
        lockDir,
        parentObserved,
        markerObserved,
        deps.afterStaleMarkerRevalidation,
      ))
    ) {
      return { acquired: false, ownerPid: markerObserved.owner?.pid };
    }
  }
  const marker = await observeLeaseDirectory(markerPath);
  return { acquired: false, ownerPid: marker?.owner?.pid };
}

async function reclaimObservedDirectory(
  lockDir: string,
  observed: LeaseDirectoryObservation,
  claimant: SessionReattachLeaseRecord,
  deps: SessionReattachLeaseDeps,
): Promise<{ reclaimed: boolean; ownerPid?: number }> {
  const marker = await acquireReclaimMarker(lockDir, observed, claimant, {
    isProcessAlive: deps.isProcessAlive ?? isProcessAlive,
    readProcessStartIdentity: deps.readProcessStartIdentity ?? readProcessStartIdentity,
    afterStaleMarkerRevalidation: deps.afterStaleMarkerRevalidation,
  });
  if (!marker.acquired) {
    return { reclaimed: false, ownerPid: marker.ownerPid };
  }

  try {
    await deps.afterReclaimMarker?.();
    const current = await observeLeaseDirectory(lockDir);
    if (
      !current ||
      current.identity !== observed.identity ||
      current.ownerRaw !== observed.ownerRaw ||
      !(await markerIsOwned(lockDir, claimant.leaseId))
    ) {
      return { reclaimed: false, ownerPid: current?.owner?.pid };
    }
    await rm(lockDir, { recursive: true, force: true });
    return { reclaimed: true };
  } finally {
    await removeOwnedMarker(lockDir, claimant.leaseId);
  }
}

async function releaseOwnedLease(lockDir: string, leaseId: string): Promise<void> {
  const observed = await observeLeaseDirectory(lockDir);
  if (observed?.owner?.leaseId !== leaseId) return;
  const verified = await observeLeaseDirectory(lockDir);
  if (
    !verified ||
    verified.identity !== observed.identity ||
    verified.ownerRaw !== observed.ownerRaw ||
    verified.owner?.leaseId !== leaseId
  ) {
    return;
  }
  await rm(lockDir, { recursive: true, force: true });
}

async function acquireAtPath(
  lockDir: string,
  deps: SessionReattachLeaseDeps = {},
): Promise<SessionReattachLeaseResult> {
  const pid = deps.pid ?? process.pid;
  const leaseId = deps.leaseId ?? randomUUID();
  const now = deps.now ?? (() => new Date());
  const processIdentityReader = deps.readProcessStartIdentity ?? readProcessStartIdentity;
  const livenessProbe = deps.isProcessAlive ?? isProcessAlive;
  const record: SessionReattachLeaseRecord = {
    pid,
    leaseId,
    createdAt: now().toISOString(),
    processStartIdentity: await processIdentityReader(pid),
  };

  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    if (await publishLeaseDirectory(lockDir, record)) {
      return {
        acquired: true,
        lease: { release: async () => releaseOwnedLease(lockDir, leaseId) },
      };
    }

    const observed = await observeLeaseDirectory(lockDir);
    if (!observed) continue;
    if (
      observed.owner &&
      (await ownerIsCurrent(observed.owner, {
        isProcessAlive: livenessProbe,
        readProcessStartIdentity: processIdentityReader,
      }))
    ) {
      return { acquired: false, ownerPid: observed.owner.pid };
    }

    const reclaimed = await reclaimObservedDirectory(lockDir, observed, record, deps);
    if (!reclaimed.reclaimed) {
      return { acquired: false, ownerPid: reclaimed.ownerPid };
    }
  }

  const owner = await observeLeaseDirectory(lockDir);
  return { acquired: false, ownerPid: owner?.owner?.pid };
}

export async function acquireSessionReattachLease(
  sessionId: string,
): Promise<SessionReattachLeaseResult> {
  const { dir } = await sessionStore.getPaths(sessionId);
  return acquireAtPath(path.join(dir, REATTACH_LEASE_DIRNAME));
}

export const __test__ = {
  dirname: REATTACH_LEASE_DIRNAME,
  ownerFilename: OWNER_FILENAME,
  reclaimFilename: RECLAIM_FILENAME,
  acquireAtPath,
  parseLeaseRecord,
  publishLeaseDirectory,
  readProcessStartIdentity,
};
