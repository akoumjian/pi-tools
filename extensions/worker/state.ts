import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isAsyncJobProcessAlive } from "../_shared/async-job.js";
import { isWorkerId } from "../_shared/worker-id.js";
import type { CompletionDelivery } from "../_shared/completion-delivery.js";
import type { WorkerContainerReference } from "../_shared/worker-container.js";
import { isRepositoryInventorySummary, type InitialRepositoryPin, type RepositoryInventorySummary } from "./repositories.js";

export const WORKER_RECORD_VERSION = 1;

type WorkerRecordChangeListener = (recordFile: string) => void;
const WORKER_RECORD_RUNTIME_HOLDER_KEY = Symbol.for("@akoumjian/pi-tools/worker-record-runtime");
const WORKER_RECORD_RUNTIME_HOLDER_VERSION = 1;

type WorkerRecordRuntimeHolder = {
  version: typeof WORKER_RECORD_RUNTIME_HOLDER_VERSION;
  listeners: Set<WorkerRecordChangeListener>;
};

function workerRecordRuntimeHolder(): WorkerRecordRuntimeHolder {
  const existing = Reflect.get(globalThis, WORKER_RECORD_RUNTIME_HOLDER_KEY) as Partial<WorkerRecordRuntimeHolder> | undefined;
  if (existing !== undefined) {
    if (
      existing === null ||
      typeof existing !== "object" ||
      existing.version !== WORKER_RECORD_RUNTIME_HOLDER_VERSION ||
      !(existing.listeners instanceof Set)
    ) {
      throw new Error(`Incompatible worker-record runtime holder for version ${WORKER_RECORD_RUNTIME_HOLDER_VERSION}.`);
    }
    return existing as WorkerRecordRuntimeHolder;
  }
  const created: WorkerRecordRuntimeHolder = {
    version: WORKER_RECORD_RUNTIME_HOLDER_VERSION,
    listeners: new Set<WorkerRecordChangeListener>()
  };
  Reflect.set(globalThis, WORKER_RECORD_RUNTIME_HOLDER_KEY, created);
  return created;
}

const workerRecordChangeListeners = workerRecordRuntimeHolder().listeners;

export function subscribeWorkerRecordChanges(listener: WorkerRecordChangeListener): () => void {
  workerRecordChangeListeners.add(listener);
  return () => workerRecordChangeListeners.delete(listener);
}

export function notifyWorkerRecordRemoved(recordFile: string): void {
  notifyWorkerRecordChange(path.resolve(recordFile));
}

function notifyWorkerRecordChange(recordFile: string): void {
  for (const listener of workerRecordChangeListeners) {
    try {
      listener(recordFile);
    } catch {
      // Activity display is observational and must never affect durable lifecycle writes.
    }
  }
}

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

export type WorkerIntegrationSnapshot = {
  headCommit: string;
  headTree: string;
  statusSha256: string;
  indexSha256: string;
  refsSha256: string;
  configSha256: string;
  metadataSha256: string;
};

export type WorkerIntegrationRecord = {
  phase: "analysis" | "resolution";
  preparedId: string;
  manifestSha256: string;
  candidateId: string;
  method: "merge" | "squash";
  sourceCandidateIds: string[];
  targetRepo: string;
  targetRef: string;
  targetExpectedCommit: string;
  targetExpectedTree: string;
  candidateHeadCommit: string;
  candidateHeadTree: string;
  preparedArtifactFile: string;
  analysisIndexFile: string;
  analysisIndexSha256: string;
  evidence: Array<{ path: string; size: number; sha256: string }>;
  workspaceRepo: string;
  contextFile: string;
  workspaceContextFile: string;
  contextSha256: string;
  analysisRunId: string;
  analysisSnapshot: WorkerIntegrationSnapshot;
  decisionsFile?: string;
  workspaceDecisionsFile?: string;
  decisionsSha256?: string;
  resolutionRunId?: string;
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
  integration?: WorkerIntegrationRecord;
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
  if (liveWorkerOperationClaims(target).length > 0) {
    throw new Error(`Worker lifecycle operation is already active for ${target}.`);
  }
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
  assertValidWorkerRecord(record, target);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  notifyWorkerRecordChange(target);
}

export function readWorkerRecord(recordFile: string): WorkerRecord {
  const target = path.resolve(recordFile);
  if (!existsSync(target)) throw new Error(`Unknown worker record: ${target}`);
  const value: unknown = JSON.parse(readFileSync(target, "utf8"));
  assertValidWorkerRecord(value, target);
  return value;
}

function assertValidWorkerRecord(value: unknown, target: string): asserts value is WorkerRecord {
  if (
    !isRecord(value) ||
    value.version !== WORKER_RECORD_VERSION ||
    typeof value.workerId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.parentSessionFile !== "string" ||
    typeof value.workspaceRoot !== "string" ||
    !Array.isArray(value.taskIds) ||
    !value.route ||
    !validInitialRepositories(value.initialRepositories) ||
    !validIntegrationRecord(value.integration) ||
    !validRepositoryInventorySummary(isRecord(value.lastRun) ? value.lastRun.repositoryInventory : undefined, target, isRecord(value.lastRun) ? value.lastRun.runId : undefined) ||
    (isRecord(value.lastRun) && value.lastRun.repositoryError !== undefined && (typeof value.lastRun.repositoryError !== "string" || value.lastRun.repositoryError.length > 512))
  ) {
    throw new Error(`Invalid worker record: ${target}`);
  }
}

function validIntegrationRecord(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || (value.phase !== "analysis" && value.phase !== "resolution") || (value.method !== "merge" && value.method !== "squash")) return false;
  const bounded = ["preparedId", "manifestSha256", "candidateId", "targetRepo", "targetRef", "preparedArtifactFile", "analysisIndexFile", "analysisIndexSha256", "workspaceRepo", "contextFile", "workspaceContextFile", "contextSha256", "analysisRunId"];
  if (bounded.some((key) => typeof value[key] !== "string" || !(value[key] as string) || Buffer.byteLength(value[key] as string, "utf8") > 4096)) return false;
  if (!path.isAbsolute(String(value.targetRepo)) || !path.isAbsolute(String(value.preparedArtifactFile)) || !path.isAbsolute(String(value.analysisIndexFile)) || !path.isAbsolute(String(value.contextFile)) || !path.isAbsolute(String(value.workspaceContextFile))) return false;
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(String(value.targetRef)) || !/^repos\/integration-[0-9a-f]{24}$/.test(String(value.workspaceRepo))) return false;
  if (!/^[0-9a-f]{64}$/.test(String(value.analysisIndexSha256)) || !/^prepared_[0-9a-f]{24}$/.test(String(value.preparedId)) || !/^candidate_[0-9a-f]{24}$/.test(String(value.candidateId)) || !/^[0-9a-f]{64}$/.test(String(value.manifestSha256)) || !/^[0-9a-f]{64}$/.test(String(value.contextSha256)) || !/^run_[A-Za-z0-9_-]{1,120}$/.test(String(value.analysisRunId))) return false;
  if (!Array.isArray(value.sourceCandidateIds) || value.sourceCandidateIds.length !== 1 || value.sourceCandidateIds[0] !== value.candidateId) return false;
  if (!Array.isArray(value.evidence) || value.evidence.length > 32 || value.evidence.some((item) => !isRecord(item) || Object.keys(item).sort().join(",") !== "path,sha256,size" || typeof item.path !== "string" || !path.isAbsolute(item.path) || typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 2 * 1024 * 1024 || typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256))) return false;
  if ((value.evidence as Array<{ size: number }>).reduce((total, item) => total + item.size, 0) > 8 * 1024 * 1024) return false;
  for (const key of ["targetExpectedCommit", "targetExpectedTree", "candidateHeadCommit", "candidateHeadTree"]) if (typeof value[key] !== "string" || !/^[0-9a-f]{40,64}$/.test(value[key] as string)) return false;
  if (!validIntegrationSnapshot(value.analysisSnapshot)) return false;
  const decisions = [value.decisionsFile, value.workspaceDecisionsFile, value.decisionsSha256, value.resolutionRunId];
  if (value.phase === "resolution") return decisions.every((item) => typeof item === "string" && item.length > 0 && Buffer.byteLength(item, "utf8") <= 4096) && path.isAbsolute(String(value.decisionsFile)) && path.isAbsolute(String(value.workspaceDecisionsFile)) && /^[0-9a-f]{64}$/.test(String(value.decisionsSha256)) && /^run_[A-Za-z0-9_-]{1,120}$/.test(String(value.resolutionRunId)) && value.resolutionRunId !== value.analysisRunId;
  return decisions.every((item) => item === undefined);
}

function validIntegrationSnapshot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of ["headCommit", "headTree"]) if (typeof value[key] !== "string" || !/^[0-9a-f]{40,64}$/.test(value[key] as string)) return false;
  for (const key of ["statusSha256", "indexSha256", "refsSha256", "configSha256", "metadataSha256"]) if (typeof value[key] !== "string" || !/^[0-9a-f]{64}$/.test(value[key] as string)) return false;
  return true;
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
  if (typeof runId !== "string") return false;
  const expected = path.join(path.dirname(recordFile), "runs", runId, "repository-candidates.json");
  return isRepositoryInventorySummary(value, expected);
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
