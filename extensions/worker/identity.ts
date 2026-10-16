import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isWorkerId } from "../_shared/worker-id.js";

export type WorkerRoots = { stateRoot: string; workspaceRoot: string };
export type WorkerPaths = { stateDir: string; sessionDir: string; workspaceRoot: string; reposDir: string; scratchDir: string; cacheDir: string; artifactsDir: string; tempDir: string };
export function defaultWorkerRoots(home = homedir()): WorkerRoots { const root = path.join(home, ".local", "share", "agent", "worker-runtime", "workers"); return { stateRoot: root, workspaceRoot: root }; }
export function createWorkerId(now = new Date(), random: string = randomUUID()): string { return createScopedId("worker", now, random); }
export function createWorkerRunId(now = new Date(), random: string = randomUUID()): string { return createScopedId("run", now, random); }
export function workerPaths(roots: WorkerRoots, workerId: string): WorkerPaths { if (!isWorkerId(workerId)) throw new Error(`Invalid worker id: ${workerId}`); const stateDir = path.join(path.resolve(roots.stateRoot), workerId); const workspaceRoot = path.resolve(roots.workspaceRoot) === path.resolve(roots.stateRoot) ? path.join(stateDir, "workspace") : path.join(path.resolve(roots.workspaceRoot), workerId); return { stateDir, sessionDir: path.join(stateDir, "session"), workspaceRoot, reposDir: path.join(workspaceRoot, "repos"), scratchDir: path.join(workspaceRoot, "scratch"), cacheDir: path.join(workspaceRoot, "cache"), artifactsDir: path.join(workspaceRoot, "artifacts"), tempDir: path.join(workspaceRoot, "tmp") }; }
export function provisionWorkerPaths(paths: WorkerPaths): void { for (const directory of [paths.stateDir, path.join(paths.stateDir, "async-shell"), paths.sessionDir, paths.workspaceRoot, paths.reposDir, paths.scratchDir, paths.cacheDir, path.join(paths.cacheDir, "config"), path.join(paths.cacheDir, "data"), path.join(paths.cacheDir, "state"), paths.artifactsDir, paths.tempDir]) mkdirSync(directory, { recursive: true, mode: 0o700 }); }
function createScopedId(prefix: string, now: Date, random: string): string { return `${prefix}_${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${random.slice(0, 8)}`; }
