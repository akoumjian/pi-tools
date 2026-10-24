import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startManagedAsyncJob, type ManagedAsyncJobHandle } from "../async-shell/index.js";
import { resolveExecutable } from "../_shared/executable.js";
import { assertSubagentRouteAllowed } from "../_shared/model-spec.js";
import type { WorkerRole } from "./registry.js";
import type { WorkerSandboxReference } from "./sandbox.js";
import type { WorkerCacheLineageRecord } from "./cache-lineage.js";

export type WorkerBeadsRoute = { prefix: "personal"; path: string; databasePath: string };
export type WorkerLaunchRecord = {
  workerId: string; runId: string; jobId: string; sessionId: string; sessionFile: string; workerRoot: string; workspaceRoot: string;
  taskIds: string[]; role: WorkerRole; modelSelection: string; cacheLineage?: WorkerCacheLineageRecord;
};
export type WorkerRuntimeProvenance = { protocolVersion: 1; sandboxName: string; creationNonce: string; piRevision: string; profileRevision: string; piToolsRevision: string; piDocparserRevision: string; resourceManifestSha256: string; imageDigest: string; kitSha256: string; extensionPaths: string[]; observedSandboxId: string; observedRuntimeSha256: string };
export type WorkerHostConfig = {
  version: 2; backend: "docker-sandbox"; workerId: string; runId: string; sessionId: string; sessionFile: string; sessionDir: string;
  workerRoot: string; workspaceRoot: string; supervisionRoot: string; asyncJobRoot: string; taskIds: string[]; role: WorkerRole; cacheLineage?: WorkerCacheLineageRecord;
  resultFile: string; settledFile: string; helloFile: string; stateFile: string; processFile: string; processNonce: string; hostConfigFile: string;
  authorizationFile: string; launchManifestFile: string; launchManifestSha256: string; prompt: string; provider: string; model: string; thinkingLevel: string;
  bdPath: string; beadsRoute: WorkerBeadsRoute; sandbox: WorkerSandboxReference; sandboxShimPath: string; sbxPath: string;
  runtimeProvenance: WorkerRuntimeProvenance; rpcArgs: string[]; timeoutMs?: number;
};
export type WorkerHostProcess = { version: 2; workerId: string; runId: string; pid: number; processToken: string; processStartToken: string; nonce: string; hostConfigFile: string; startedAt: string };
export type WorkerHostSettlement = { version: 1; workerId: string; runId: string; sessionId: string; resultFile: string; helloFile?: string; stateFile?: string; settledAt: string };
export type LaunchWorkerHostInput = {
  record: WorkerLaunchRecord; prompt: string; resultFile: string; runDir: string; processFile: string; processNonce: string;
  timeoutMs?: number; bdPath?: string; beadsRoute?: WorkerBeadsRoute; sandbox: WorkerSandboxReference; sbxPath: string;
};

export function launchWorkerHost(api: ExtensionAPI, context: ExtensionContext, input: LaunchWorkerHostInput): { handle: ManagedAsyncJobHandle; config: WorkerHostConfig; configFile: string } {
  const record = input.record; const route = parseModelSelection(record.modelSelection);
  assertSubagentRouteAllowed(route, `Worker ${record.workerId} host route`);
  if (!record.sessionFile) throw new Error(`Worker ${record.workerId} has no retained session file.`);
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)) throw new Error("Worker host timeoutMs must be a positive safe integer when explicitly configured.");
  const supervisionRoot = path.resolve(input.runDir);
  mkdirSync(input.runDir, { recursive: true, mode: 0o700 });
  const bdPath = input.bdPath ?? resolveExecutable("bd");
  const configFile = path.join(input.runDir, "host.json"); const authorizationFile = path.join(input.runDir, "host-authorization.json"); const launchManifestFile = path.join(input.runDir, "sandbox-launch.json");
  if (!input.sandbox.observedSandboxId || !input.sandbox.observedRuntimeSha256 || !input.sandbox.createEvidenceSha256) throw new Error("Worker Sandbox host observation is required before supervisor launch.");
  const runtimeProvenance: WorkerRuntimeProvenance = { protocolVersion: 1, sandboxName: input.sandbox.sandboxName, creationNonce: input.sandbox.creationNonce, piRevision: input.sandbox.revisions.pi, profileRevision: input.sandbox.revisions.profile, piToolsRevision: input.sandbox.revisions.piTools, piDocparserRevision: input.sandbox.revisions.piDocparser, resourceManifestSha256: input.sandbox.resourceManifestSha256, imageDigest: input.sandbox.imageDigest, kitSha256: input.sandbox.kitSha256, extensionPaths: [...input.sandbox.extensionPaths], observedSandboxId: input.sandbox.observedSandboxId, observedRuntimeSha256: input.sandbox.observedRuntimeSha256 };
  const config: WorkerHostConfig = {
    version: 2, backend: "docker-sandbox", workerId: record.workerId, runId: record.runId, sessionId: record.sessionId,
    sessionFile: record.sessionFile, sessionDir: path.dirname(record.sessionFile), workerRoot: record.workerRoot, workspaceRoot: record.workspaceRoot,
    supervisionRoot, asyncJobRoot: path.join(record.workerRoot, "async-shell"), taskIds: [...record.taskIds], role: record.role, ...(record.cacheLineage ? { cacheLineage: record.cacheLineage } : {}),
    resultFile: input.resultFile, settledFile: path.join(input.runDir, "settled.json"), helloFile: path.join(input.runDir, "runtime-hello.json"), stateFile: path.join(input.runDir, "runtime-state.json"), processFile: input.processFile,
    processNonce: input.processNonce, hostConfigFile: configFile, authorizationFile, launchManifestFile, launchManifestSha256: "", prompt: input.prompt,
    provider: route.provider, model: route.model, thinkingLevel: route.thinkingLevel, bdPath, beadsRoute: input.beadsRoute ?? resolveBeadsRoute(bdPath, context.cwd),
    sandbox: input.sandbox, sandboxShimPath: resolveSandboxShimScript(), sbxPath: input.sbxPath, runtimeProvenance, rpcArgs: [], ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
  };
  config.rpcArgs = buildWorkerRpcArgs(config);
  const authorization = { version: 2, workerId: config.workerId, runId: config.runId, processNonce: config.processNonce, sandboxName: config.sandbox.sandboxName, creationNonce: config.sandbox.creationNonce };
  writeFileSync(authorizationFile, `${JSON.stringify(authorization, null, 2)}\n`, { mode: 0o600 });
  const guestEnvironment: Record<string, string> = {
    HOME: "/home/agent", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", SHELL: "/bin/bash", GIT_OPTIONAL_LOCKS: "0", SEARXNG_URL: config.sandbox.searxngUrl, PI_CODING_AGENT_DIR: config.sandbox.codingAgentDir,
    PI_WORKER_HOST_RPC: "1", PI_WORKER_ID: config.workerId, PI_WORKER_RUN_ID: config.runId, PI_WORKER_WORKSPACE_ROOT: config.workspaceRoot,
    PI_WORKER_STATE_ROOT: config.workerRoot, PI_WORKER_ASYNC_JOB_ROOT: config.asyncJobRoot, PI_WORKER_TASK_IDS: JSON.stringify(config.taskIds), PI_WORKER_ROLE: config.role,
    PI_WORKER_RUNTIME_PROVENANCE: JSON.stringify(runtimeProvenance), ...(config.cacheLineage ? { PI_WORKER_CACHE_LINEAGE: JSON.stringify(config.cacheLineage) } : {})
  };
  const launchManifestText = `${JSON.stringify({ version: 1, sbxPath: config.sbxPath, sandbox: config.sandbox, guestEnvironment }, null, 2)}\n`;
  config.launchManifestSha256 = createHash("sha256").update(launchManifestText).digest("hex");
  writeFileSync(launchManifestFile, launchManifestText, { mode: 0o600 });
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const hostProcessToken = randomUUID();
  const handle = startManagedAsyncJob(api, context, {
    jobId: record.jobId, job_name: `worker ${record.workerId}`, command: `Pi Sandbox worker host ${record.workerId}/${record.runId}`,
    cwd: record.workspaceRoot, executable: process.execPath, args: [resolveWorkerHostScript(), configFile],
    env: { ...process.env, PI_WORKER_JOB_TOKEN: hostProcessToken, PI_WORKER_ID: record.workerId, PI_WORKER_RUN_ID: record.runId, PI_WORKER_RESULT_FILE: input.resultFile,
      PI_WORKER_WORKSPACE_ROOT: record.workspaceRoot, PI_WORKER_STATE_ROOT: record.workerRoot, PI_WORKER_SUPERVISION_ROOT: supervisionRoot, PI_WORKER_ASYNC_JOB_ROOT: config.asyncJobRoot,
      PI_WORKER_TASK_IDS: JSON.stringify(record.taskIds), PI_WORKER_ROLE: config.role, PI_WORKER_BD_PATH: config.bdPath, PI_WORKER_BEADS_ROUTE: JSON.stringify(config.beadsRoute),
      PI_WORKER_AUTHORIZATION_FILE: config.authorizationFile, PI_WORKER_PROCESS_NONCE: config.processNonce, ...(config.cacheLineage ? { PI_WORKER_CACHE_LINEAGE: JSON.stringify(config.cacheLineage) } : {}) },
    notifyOnExit: false, settleProcessGroup: true, processToken: hostProcessToken
  });
  return { handle, config, configFile };
}

export function readWorkerHostProcess(processFile: string): WorkerHostProcess { const value = JSON.parse(readFileSync(processFile, "utf8")) as Partial<WorkerHostProcess>; if (value.version !== 2 || typeof value.workerId !== "string" || typeof value.runId !== "string" || !Number.isInteger(value.pid) || typeof value.processToken !== "string" || typeof value.processStartToken !== "string" || typeof value.nonce !== "string" || typeof value.hostConfigFile !== "string" || typeof value.startedAt !== "string") throw new Error(`Invalid worker host process marker: ${processFile}`); return value as WorkerHostProcess; }
export function readWorkerHostSettlement(settledFile: string): WorkerHostSettlement { const value = JSON.parse(readFileSync(settledFile, "utf8")) as Partial<WorkerHostSettlement>; if (value.version !== 1 || typeof value.workerId !== "string" || typeof value.runId !== "string" || typeof value.sessionId !== "string" || typeof value.resultFile !== "string" || typeof value.settledAt !== "string") throw new Error(`Invalid worker host settlement: ${settledFile}`); return value as WorkerHostSettlement; }
export function buildWorkerRpcArgs(config: WorkerHostConfig): string[] {
  return ["--session", config.sessionFile, "--session-dir", config.sessionDir, "--model", `${config.provider}/${config.model}`, "--thinking", config.thinkingLevel,
    "--no-approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions",
    ...config.sandbox.extensionPaths.flatMap((extensionPath) => ["-e", extensionPath])];
}
export function resolveBeadsRoute(bdPath: string, cwd: string): WorkerBeadsRoute { const output = execFileSync(bdPath, ["where", "--json"], { cwd, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); const value = JSON.parse(output) as { prefix?: unknown; path?: unknown; database_path?: unknown }; if (value.prefix !== "personal" || typeof value.path !== "string" || typeof value.database_path !== "string") throw new Error("Managed workers require the central personal Beads route."); const resolvedPath = path.resolve(value.path); const ambientPath = process.env.BEADS_DIR?.trim(); if (!ambientPath || path.resolve(ambientPath) !== resolvedPath) throw new Error(`Managed workers require ambient BEADS_DIR to match the central route ${resolvedPath}.`); return { prefix: "personal", path: resolvedPath, databasePath: path.resolve(value.database_path) }; }
export { resolveExecutable };
export function resolveWorkerHostScript(): string { return resolvePackageScript("worker-host.mjs"); }
export function resolveSandboxShimScript(): string { return resolvePackageScript("worker-sbx-rpc.mjs"); }
function resolvePackageScript(name: string): string { let current = path.dirname(fileURLToPath(import.meta.url)); while (true) { const candidate = path.join(current, "scripts", name); if (existsSync(candidate)) return candidate; const parent = path.dirname(current); if (parent === current) throw new Error(`Worker script ${name} is missing above ${fileURLToPath(import.meta.url)}.`); current = parent; } }
function parseModelSelection(value: string): { provider: string; model: string; thinkingLevel: any } { const slash = value.indexOf("/"); const colon = value.lastIndexOf(":"); if (slash < 1 || colon <= slash + 1) throw new Error(`Invalid persisted model selection: ${value}.`); return { provider: value.slice(0, slash), model: value.slice(slash + 1, colon), thinkingLevel: value.slice(colon + 1) }; }
