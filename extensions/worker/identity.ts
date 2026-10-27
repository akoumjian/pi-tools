import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isWorkerId } from "../_shared/worker-id.js";

export const CURRENT_WORKER_STORAGE_LAYOUT = 2 as const;
export const LEGACY_WORKER_STORAGE_LAYOUT = 1 as const;
export type WorkerStorageLayout = typeof CURRENT_WORKER_STORAGE_LAYOUT | typeof LEGACY_WORKER_STORAGE_LAYOUT;

export const WORKER_RUNTIME_DIRECTORY = "worker-runtime-v10";
export const WORKER_PREPARED_DIRECTORY = "prepared";
export const WORKER_HOST_JOB_DIRECTORY = "worker-host-jobs";
export function defaultWorkerRuntimeRoot(home = homedir()): string { return path.join(home, ".local", "share", "agent", WORKER_RUNTIME_DIRECTORY); }
export function workerPreparedRoot(runtimeRoot = defaultWorkerRuntimeRoot()): string { return path.join(path.resolve(runtimeRoot), WORKER_PREPARED_DIRECTORY); }
export function workerHostJobRoot(runtimeRoot = defaultWorkerRuntimeRoot()): string { return path.join(path.resolve(runtimeRoot), WORKER_HOST_JOB_DIRECTORY); }
export type WorkerRoots = { stateRoot: string; workspaceRoot: string; supervisionRoot?: string };
export type WorkerPaths = { workerDir: string; stateDir: string; supervisionDir: string; evidenceDir: string; sessionDir: string; workspaceRoot: string; reposDir: string; scratchDir: string; cacheDir: string; artifactsDir: string; tempDir: string };
export function defaultWorkerRoots(home = homedir()): WorkerRoots {
  const runtimeRoot = defaultWorkerRuntimeRoot(home);
  const workersRoot = path.join(runtimeRoot, "workers");
  // supervisionRoot remains for schema compatibility and explicit cleanup of layout-1
  // records in injected registries. New workers place host state beneath workerDir/host.
  return { stateRoot: workersRoot, workspaceRoot: workersRoot, supervisionRoot: path.join(runtimeRoot, "supervision") };
}
export function createWorkerId(now = new Date(), random: string = randomUUID()): string { return createScopedId("worker", now, random); }
export function createWorkerRunId(now = new Date(), random: string = randomUUID()): string { return createScopedId("run", now, random); }
export function workerPaths(roots: WorkerRoots, workerId: string): WorkerPaths {
  assertCommonWorkerRoot(roots);
  if (!isWorkerId(workerId)) throw new Error(`Invalid worker id: ${workerId}`);
  const workerDir = path.join(path.resolve(roots.stateRoot), workerId);
  return pathsForLayout(workerDir, path.join(workerDir, "guest"), path.join(workerDir, "host"));
}
export function legacyWorkerPaths(roots: WorkerRoots, workerId: string): WorkerPaths {
  assertCommonWorkerRoot(roots);
  if (!isWorkerId(workerId)) throw new Error(`Invalid worker id: ${workerId}`);
  const workerDir = path.join(path.resolve(roots.stateRoot), workerId);
  const supervisionBase = path.resolve(roots.supervisionRoot ?? path.join(path.dirname(path.resolve(roots.stateRoot)), "supervision"));
  return pathsForLayout(workerDir, workerDir, path.join(supervisionBase, workerId));
}
export function storedWorkerPaths(roots: WorkerRoots, worker: { workerId: string; workspaceRoot: string; storageLayout: WorkerStorageLayout }): WorkerPaths {
  if (worker.storageLayout !== CURRENT_WORKER_STORAGE_LAYOUT && worker.storageLayout !== LEGACY_WORKER_STORAGE_LAYOUT) throw new Error(`Worker ${worker.workerId} has unsupported storage layout ${worker.storageLayout}.`);
  const paths = worker.storageLayout === CURRENT_WORKER_STORAGE_LAYOUT ? workerPaths(roots, worker.workerId) : legacyWorkerPaths(roots, worker.workerId);
  if (path.resolve(worker.workspaceRoot) !== path.resolve(paths.workspaceRoot)) throw new Error(`Worker ${worker.workerId} storage layout ${worker.storageLayout} does not match its exact registered workspace.`);
  return paths;
}
export function provisionWorkerPaths(paths: WorkerPaths): void {
  for (const directory of [paths.workerDir, paths.stateDir, paths.supervisionDir, paths.evidenceDir, path.join(paths.stateDir, "async-shell"), paths.sessionDir, paths.workspaceRoot, paths.reposDir, paths.scratchDir, paths.cacheDir, path.join(paths.cacheDir, "config"), path.join(paths.cacheDir, "data"), path.join(paths.cacheDir, "state"), paths.artifactsDir, paths.tempDir]) mkdirSync(directory, { recursive: true, mode: 0o700 });
}
function assertCommonWorkerRoot(roots: WorkerRoots): void {
  if (path.resolve(roots.stateRoot) !== path.resolve(roots.workspaceRoot)) throw new Error("Managed worker state and workspace roots must be the same guarded workers root.");
}
function pathsForLayout(workerDir: string, stateDir: string, supervisionDir: string): WorkerPaths {
  const evidenceDir = path.join(supervisionDir, "evidence");
  const workspaceRoot = path.join(stateDir, "workspace");
  return { workerDir, stateDir, supervisionDir, evidenceDir, sessionDir: path.join(stateDir, "session"), workspaceRoot, reposDir: path.join(workspaceRoot, "repos"), scratchDir: path.join(workspaceRoot, "scratch"), cacheDir: path.join(workspaceRoot, "cache"), artifactsDir: path.join(workspaceRoot, "artifacts"), tempDir: path.join(workspaceRoot, "tmp") };
}
function createScopedId(prefix: string, now: Date, random: string): string { return `${prefix}_${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${random.slice(0, 8)}`; }
