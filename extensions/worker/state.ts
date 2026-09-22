import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isAsyncJobProcessAlive } from "../_shared/async-job.js";
import { isWorkerId } from "../_shared/worker-id.js";
import type { CompletionDelivery } from "../_shared/completion-delivery.js";
import type { WorkerContainerReference } from "../_shared/worker-container.js";
import type { InitialRepositoryPin, RepositoryInventorySummary } from "./repositories.js";

export const WORKER_RECORD_VERSION = 1;

export type WorkerRoute = {
  provider: string;
  model: string;
  thinkingLevel: string;
};

export type WorkerLease = {
  version: 1;
  workerId: string;
  runId: string;
  parentPid: number;
  acquiredAt: string;
};

export type WorkerRecord = {
  version: typeof WORKER_RECORD_VERSION;
  workerId: string;
  sessionId: string;
  sessionFile?: string;
  parentSessionFile: string;
  workspaceRoot: string;
  taskIds: string[];
  route: WorkerRoute;
  initialRepositories?: InitialRepositoryPin[];
  status: "queued" | "running" | "handed_off" | "failed" | "cancelled";
  container?: WorkerContainerReference;
  activeRun?: {
    runId: string;
    jobId: string;
    status: "queued" | "running";
    completionDelivery?: CompletionDelivery;
    pid?: number;
    logDir?: string;
    stdoutLog?: string;
    stderrLog?: string;
    resultFile?: string;
    settledFile?: string;
    hostConfigFile?: string;
    processFile?: string;
    processNonce?: string;
    container?: WorkerContainerReference;
    recoveryError?: string;
    hostProcessSettled?: boolean;
    cleanupOwner?: string;
  };
  lastRun?: {
    runId: string;
    jobId: string;
    status: "handed_off" | "failed" | "cancelled";
    resultFile?: string;
    delivery?: "pending" | "delivered";
    completionDelivery?: CompletionDelivery;
    processStatus?: string;
    exitCode?: number | null;
    pid?: number;
    logDir?: string;
    stdoutLog?: string;
    stderrLog?: string;
    error?: string;
    repositoryInventory?: RepositoryInventorySummary;
    repositoryError?: string;
  };
  updatedAt: string;
};

export type WorkerRoots = {
  stateRoot: string;
  workspaceRoot: string;
};

export type WorkerPaths = {
  stateDir: string;
  recordFile: string;
  leaseFile: string;
  operationLockFile: string;
  sessionDir: string;
  workspaceRoot: string;
  reposDir: string;
  scratchDir: string;
  cacheDir: string;
  artifactsDir: string;
  tempDir: string;
};

export function defaultWorkerRoots(home = homedir()): WorkerRoots {
  return {
    stateRoot: path.join(home, ".local", "share", "agent", "workers"),
    workspaceRoot: path.join(home, ".local", "share", "agent", "workspaces")
  };
}

export function createWorkerId(now = new Date(), random: string = randomUUID()): string {
  return createScopedId("worker", now, random);
}

export function createWorkerRunId(now = new Date(), random: string = randomUUID()): string {
  return createScopedId("run", now, random);
}

export function workerPaths(roots: WorkerRoots, workerId: string): WorkerPaths {
  assertWorkerId(workerId);
  const stateDir = path.join(path.resolve(roots.stateRoot), workerId);
  const workspaceRoot = path.join(path.resolve(roots.workspaceRoot), workerId);
  return {
    stateDir,
    recordFile: path.join(stateDir, "worker.json"),
    leaseFile: path.join(stateDir, "lease.json"),
    operationLockFile: path.join(path.resolve(roots.stateRoot), ".locks", `${workerId}.lock`),
    sessionDir: path.join(stateDir, "session"),
    workspaceRoot,
    reposDir: path.join(workspaceRoot, "repos"),
    scratchDir: path.join(workspaceRoot, "scratch"),
    cacheDir: path.join(workspaceRoot, "cache"),
    artifactsDir: path.join(workspaceRoot, "artifacts"),
    tempDir: path.join(workspaceRoot, "tmp")
  };
}

export function provisionWorkerPaths(paths: WorkerPaths): void {
  for (const directory of [
    paths.stateDir,
    paths.sessionDir,
    paths.workspaceRoot,
    paths.reposDir,
    paths.scratchDir,
    paths.cacheDir,
    path.join(paths.cacheDir, "config"),
    path.join(paths.cacheDir, "data"),
    path.join(paths.cacheDir, "state"),
    paths.artifactsDir,
    paths.tempDir
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

export type WorkerOperationLock = {
  lockFile: string;
  claimFile: string;
  token: string;
};

export function acquireWorkerOperationLock(
  lockFile: string,
  nonce: string = randomUUID()
): WorkerOperationLock {
  const target = path.resolve(lockFile);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${nonce}`;
  const claimFile = path.join(target, `claim-${process.pid}-${randomUUID()}`);
  writeFileSync(claimFile, token, { flag: "wx", mode: 0o600 });
  try {
    const claims = liveWorkerOperationClaims(target);
    if (claims[0]?.path !== claimFile) {
      throw new Error(`Worker lifecycle operation is already active for ${target}.`);
    }
    return { lockFile: target, claimFile, token };
  } catch (error) {
    try { unlinkSync(claimFile); } catch {}
    throw error;
  }
}

export function releaseWorkerOperationLock(lock: WorkerOperationLock): void {
  let token: string;
  try {
    token = readFileSync(lock.claimFile, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (token !== lock.token) {
    throw new Error(`Refusing to release a worker lifecycle operation owned by another process.`);
  }
  unlinkSync(lock.claimFile);
}

function liveWorkerOperationClaims(lockDirectory: string): Array<{ path: string; createdAt: bigint }> {
  const live: Array<{ path: string; createdAt: bigint }> = [];
  for (const entry of readdirSync(lockDirectory)) {
    if (!entry.startsWith("claim-")) {
      throw new Error(`Worker lifecycle operation lock contains an invalid claim: ${entry}.`);
    }
    const claimPath = path.join(lockDirectory, entry);
    let token: string;
    try {
      token = readFileSync(claimPath, "utf8");
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    const ownerPid = Number.parseInt(token.split(":", 1)[0] ?? "", 10);
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
      throw new Error(`Worker lifecycle operation lock contains an invalid owner: ${entry}.`);
    }
    if (!isAsyncJobProcessAlive(ownerPid)) {
      try { unlinkSync(claimPath); } catch (error) { if (!isErrorCode(error, "ENOENT")) throw error; }
      continue;
    }
    try {
      const createdAt = statSync(claimPath, { bigint: true }).birthtimeNs;
      live.push({ path: claimPath, createdAt });
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
  }
  return live.sort((left, right) => left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.path.localeCompare(right.path));
}

export function acquireWorkerLease(leaseFile: string, lease: WorkerLease): void {
  const target = path.resolve(leaseFile);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(target, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(lease, null, 2)}\n`);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      unlinkSync(target);
    }
    if (existsSync(target)) throw new Error(`Worker ${lease.workerId} already has an active run lease.`);
    throw error;
  }
  closeSync(descriptor);
}

export function readWorkerLease(leaseFile: string): WorkerLease | undefined {
  const target = path.resolve(leaseFile);
  if (!existsSync(target)) return undefined;
  const value = JSON.parse(readFileSync(target, "utf8")) as Partial<WorkerLease>;
  if (
    value.version !== 1 ||
    typeof value.workerId !== "string" ||
    typeof value.runId !== "string" ||
    !Number.isInteger(value.parentPid) ||
    typeof value.acquiredAt !== "string"
  ) throw new Error(`Invalid worker lease: ${target}`);
  return value as WorkerLease;
}

export function releaseWorkerLease(leaseFile: string, workerId: string, runId: string): void {
  const target = path.resolve(leaseFile);
  if (!existsSync(target)) return;
  const lease = readWorkerLease(target);
  if (!lease || lease.workerId !== workerId || lease.runId !== runId) {
    throw new Error(`Refusing to release mismatched worker lease for ${workerId}/${runId}.`);
  }
  unlinkSync(target);
}

export function writeWorkerRecord(recordFile: string, record: WorkerRecord): void {
  const target = path.resolve(recordFile);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

export function readWorkerRecord(recordFile: string): WorkerRecord {
  const target = path.resolve(recordFile);
  if (!existsSync(target)) throw new Error(`Unknown worker record: ${target}`);
  const value = JSON.parse(readFileSync(target, "utf8")) as Partial<WorkerRecord>;
  if (
    value.version !== WORKER_RECORD_VERSION ||
    typeof value.workerId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.parentSessionFile !== "string" ||
    typeof value.workspaceRoot !== "string" ||
    !Array.isArray(value.taskIds) ||
    !value.route ||
    !validInitialRepositories(value.initialRepositories) ||
    !validRepositoryInventorySummary(value.lastRun?.repositoryInventory, target, value.lastRun?.runId) ||
    (value.lastRun?.repositoryError !== undefined && (typeof value.lastRun.repositoryError !== "string" || value.lastRun.repositoryError.length > 512))
  ) {
    throw new Error(`Invalid worker record: ${target}`);
  }
  return value as WorkerRecord;
}

function validInitialRepositories(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= 16 && value.every((item) => {
    if (!isRecord(item) || typeof item.source !== "string" || item.source.length > 2048 || !["pinned", "unresolved", "unsupported"].includes(String(item.status))) return false;
    if (item.revision !== undefined && (typeof item.revision !== "string" || item.revision.length > 256)) return false;
    if (item.canonicalSource !== undefined && (typeof item.canonicalSource !== "string" || item.canonicalSource.length > 2048)) return false;
    if (item.issue !== undefined && (typeof item.issue !== "string" || item.issue.length > 160)) return false;
    for (const key of ["baseCommit", "baseTree"] as const) {
      if (item[key] !== undefined && (typeof item[key] !== "string" || !/^[0-9a-f]{40,64}$/.test(item[key]))) return false;
    }
    if (item.status === "pinned" && (typeof item.baseCommit !== "string" || typeof item.baseTree !== "string" || typeof item.canonicalSource !== "string")) return false;
    if ((item.baseCommit === undefined) !== (item.baseTree === undefined)) return false;
    return true;
  });
}

function validRepositoryInventorySummary(value: unknown, recordFile: string, runId: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || typeof runId !== "string") return false;
  const expected = path.join(path.dirname(recordFile), "runs", runId, "repository-candidates.json");
  if (typeof value.inventoryFile !== "string" || path.resolve(value.inventoryFile) !== expected) return false;
  if (typeof value.inventorySha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.inventorySha256)) return false;
  if (!Array.isArray(value.candidates) || value.candidates.length > 32 || !Array.isArray(value.discrepancies) || value.discrepancies.length > 128) return false;
  if (value.candidateCount !== value.candidates.length || value.discrepancyCount !== value.discrepancies.length) return false;
  const foldableCount = value.candidates.filter((candidate) => isRecord(candidate) && candidate.foldable === true).length;
  if (value.foldableCount !== foldableCount) return false;
  if (!value.candidates.every((candidate) =>
    isRecord(candidate) &&
    typeof candidate.candidateId === "string" && /^candidate_[0-9a-f]{24}$/.test(candidate.candidateId) &&
    typeof candidate.workspaceRepo === "string" && candidate.workspaceRepo.length > 0 && candidate.workspaceRepo.length <= 1024 &&
    typeof candidate.reported === "boolean" && typeof candidate.dirty === "boolean" && typeof candidate.changed === "boolean" && typeof candidate.foldable === "boolean" &&
    Array.isArray(candidate.policyIssues) && candidate.policyIssues.length <= 64 && candidate.policyIssues.every((issue) => typeof issue === "string" && issue.length <= 160)
  )) return false;
  return value.discrepancies.every((item) =>
    isRecord(item) &&
    ["unreported_changed", "reported_missing", "reported_not_repository", "symlink_skipped", "scan_limit"].includes(String(item.kind)) &&
    typeof item.workspaceRepo === "string" && item.workspaceRepo.length > 0 && item.workspaceRepo.length <= 1024 &&
    typeof item.detail === "string" && item.detail.length > 0 && item.detail.length <= 512
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function createScopedId(prefix: string, now: Date, random: string): string {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${prefix}_${timestamp}_${random.slice(0, 8)}`;
}

function assertWorkerId(workerId: string): void {
  if (!isWorkerId(workerId)) throw new Error(`Invalid worker id: ${workerId}`);
}
