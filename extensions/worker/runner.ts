import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startManagedAsyncJob, type ManagedAsyncJobHandle } from "../async-shell/index.js";
import { resolveExecutable } from "../_shared/executable.js";
import { assertSubagentRouteAllowed } from "../_shared/model-spec.js";
import type { WorkerRole } from "./registry.js";
import type { WorkerContainerReference } from "../_shared/worker-container.js";
import { MANAGED_WORKER_TOOL_NAMES, type WorkerCacheLineageRecord } from "./cache-lineage.js";

export type WorkerBeadsRoute = { prefix: "personal"; path: string; databasePath: string };
export type WorkerShellExecution = { kind: "docker"; dockerPath: string; container: WorkerContainerReference } | { kind: "native-test" };
export type WorkerLaunchRecord = {
  workerId: string; runId: string; jobId: string; sessionId: string; sessionFile: string; workspaceRoot: string;
  taskIds: string[]; role: WorkerRole; modelSelection: string; cacheLineage?: WorkerCacheLineageRecord;
};
export type WorkerHostConfig = {
  version: 1; workerId: string; runId: string; sessionId: string; sessionFile: string; sessionDir: string;
  workspaceRoot: string; stateRoot: string; asyncJobRoot: string; taskIds: string[]; role: WorkerRole; cacheLineage?: WorkerCacheLineageRecord;
  resultFile: string; settledFile: string; processFile: string; processNonce: string; hostConfigFile: string;
  authorizationFile: string; prompt: string; provider: string; model: string; thinkingLevel: string;
  piCliPath: string; bdPath: string; beadsRoute: WorkerBeadsRoute; extensionPaths: string[];
  shellExecution: WorkerShellExecution; rpcArgs: string[]; timeoutMs?: number;
};
export type WorkerHostProcess = { version: 2; workerId: string; runId: string; pid: number; processToken: string; processStartToken: string; nonce: string; hostConfigFile: string; startedAt: string };
export type WorkerHostSettlement = { version: 1; workerId: string; runId: string; sessionId: string; resultFile: string; settledAt: string };
export type LaunchWorkerHostInput = {
  record: WorkerLaunchRecord; prompt: string; resultFile: string; runDir: string; processFile: string; processNonce: string;
  timeoutMs?: number; piCliPath?: string; bdPath?: string; beadsRoute?: WorkerBeadsRoute; extensionPaths?: string[]; shellExecution: WorkerShellExecution;
};

export function launchWorkerHost(api: ExtensionAPI, context: ExtensionContext, input: LaunchWorkerHostInput): { handle: ManagedAsyncJobHandle; config: WorkerHostConfig; configFile: string } {
  const record = input.record;
  const route = parseModelSelection(record.modelSelection);
  assertSubagentRouteAllowed(route, `Worker ${record.workerId} host route`);
  if (!record.sessionFile) throw new Error(`Worker ${record.workerId} has no retained session file.`);
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)) throw new Error("Worker host timeoutMs must be a positive safe integer when explicitly configured.");
  const stateRoot = path.dirname(path.dirname(input.runDir));
  mkdirSync(input.runDir, { recursive: true, mode: 0o700 });
  const bdPath = input.bdPath ?? resolveExecutable("bd");
  const configFile = path.join(input.runDir, "host.json");
  const authorizationFile = path.join(input.runDir, "host-authorization.json");
  const config: WorkerHostConfig = {
    version: 1, workerId: record.workerId, runId: record.runId, sessionId: record.sessionId,
    sessionFile: record.sessionFile, sessionDir: path.dirname(record.sessionFile), workspaceRoot: record.workspaceRoot,
    stateRoot, asyncJobRoot: path.join(stateRoot, "async-shell"), taskIds: [...record.taskIds], role: record.role, ...(record.cacheLineage ? { cacheLineage: record.cacheLineage } : {}),
    resultFile: input.resultFile, settledFile: path.join(input.runDir, "settled.json"), processFile: input.processFile,
    processNonce: input.processNonce, hostConfigFile: configFile, authorizationFile, prompt: input.prompt,
    provider: route.provider, model: route.model, thinkingLevel: route.thinkingLevel,
    piCliPath: input.piCliPath ?? resolvePiCliPath(), bdPath, beadsRoute: input.beadsRoute ?? resolveBeadsRoute(bdPath, context.cwd),
    extensionPaths: input.extensionPaths ?? defaultWorkerExtensionPaths(), shellExecution: input.shellExecution, rpcArgs: [],
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
  };
  config.rpcArgs = buildWorkerRpcArgs(config);
  writeFileSync(authorizationFile, `${JSON.stringify({ version: 1, workerId: config.workerId, runId: config.runId, processNonce: config.processNonce }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const hostProcessToken = randomUUID();
  const handle = startManagedAsyncJob(api, context, {
    jobId: record.jobId, job_name: `worker ${record.workerId}`, command: `Pi worker host ${record.workerId}/${record.runId}`,
    cwd: record.workspaceRoot, executable: process.execPath, args: [resolveWorkerHostScript(), configFile],
    env: { ...process.env, PI_WORKER_JOB_TOKEN: hostProcessToken, PI_WORKER_ID: record.workerId, PI_WORKER_RUN_ID: record.runId, PI_WORKER_RESULT_FILE: input.resultFile,
      PI_WORKER_WORKSPACE_ROOT: record.workspaceRoot, PI_WORKER_STATE_ROOT: config.stateRoot, PI_WORKER_ASYNC_JOB_ROOT: config.asyncJobRoot,
      PI_WORKER_TASK_IDS: JSON.stringify(record.taskIds), PI_WORKER_ROLE: config.role, PI_WORKER_BD_PATH: config.bdPath,
      PI_WORKER_BEADS_ROUTE: JSON.stringify(config.beadsRoute), ...(config.cacheLineage ? { PI_WORKER_CACHE_LINEAGE: JSON.stringify(config.cacheLineage) } : {}), ...workerShellEnvironment(config.shellExecution) },
    notifyOnExit: false, settleProcessGroup: true, processToken: hostProcessToken,
    managedBy: { kind: "worker-host", workerId: record.workerId, runId: record.runId }
  });
  return { handle, config, configFile };
}

export function readWorkerHostProcess(processFile: string): WorkerHostProcess {
  const value = JSON.parse(readFileSync(processFile, "utf8")) as Partial<WorkerHostProcess>;
  if (value.version !== 2 || typeof value.workerId !== "string" || typeof value.runId !== "string" || !Number.isInteger(value.pid) || typeof value.processToken !== "string" || typeof value.processStartToken !== "string" || typeof value.nonce !== "string" || typeof value.hostConfigFile !== "string" || typeof value.startedAt !== "string") throw new Error(`Invalid worker host process marker: ${processFile}`);
  return value as WorkerHostProcess;
}
export function readWorkerHostSettlement(settledFile: string): WorkerHostSettlement {
  const value = JSON.parse(readFileSync(settledFile, "utf8")) as Partial<WorkerHostSettlement>;
  if (value.version !== 1 || typeof value.workerId !== "string" || typeof value.runId !== "string" || typeof value.sessionId !== "string" || typeof value.resultFile !== "string" || typeof value.settledAt !== "string") throw new Error(`Invalid worker host settlement: ${settledFile}`);
  return value as WorkerHostSettlement;
}
export function buildWorkerRpcArgs(config: WorkerHostConfig): string[] {
  return ["--session", config.sessionFile, "--session-dir", config.sessionDir, "--model", `${config.provider}/${config.model}`, "--thinking", config.thinkingLevel,
    "--no-approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions", "--no-builtin-tools",
    "--tools", MANAGED_WORKER_TOOL_NAMES.join(","), ...config.extensionPaths.flatMap((extensionPath) => ["-e", extensionPath])];
}
export function resolveBeadsRoute(bdPath: string, cwd: string): WorkerBeadsRoute {
  const output = execFileSync(bdPath, ["where", "--json"], { cwd, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const value = JSON.parse(output) as { prefix?: unknown; path?: unknown; database_path?: unknown };
  if (value.prefix !== "personal" || typeof value.path !== "string" || typeof value.database_path !== "string") throw new Error("Managed workers require the central personal Beads route.");
  const resolvedPath = path.resolve(value.path); const ambientPath = process.env.BEADS_DIR?.trim();
  if (!ambientPath || path.resolve(ambientPath) !== resolvedPath) throw new Error(`Managed workers require ambient BEADS_DIR to match the central route ${resolvedPath}.`);
  return { prefix: "personal", path: resolvedPath, databasePath: path.resolve(value.database_path) };
}
export { resolveExecutable };
export function resolveWorkerHostScript(): string { let current = path.dirname(fileURLToPath(import.meta.url)); while (true) { const candidate = path.join(current, "scripts", "worker-host.mjs"); if (existsSync(candidate)) return candidate; const parent = path.dirname(current); if (parent === current) throw new Error(`Worker host script is missing above ${fileURLToPath(import.meta.url)}.`); current = parent; } }
export function resolvePiCliPath(): string { const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")); const cli = path.join(path.dirname(entry), "cli.js"); if (!existsSync(cli)) throw new Error(`Unable to resolve Pi CLI beside ${entry}.`); return cli; }
export function defaultWorkerExtensionPaths(): string[] { return [resolveExtensionSource("./runtime"), resolveExtensionSource("../async-shell/index")]; }
function resolveExtensionSource(relativePath: string): string { const typescript = fileURLToPath(new URL(`${relativePath}.ts`, import.meta.url)); if (existsSync(typescript)) return typescript; const javascript = fileURLToPath(new URL(`${relativePath}.js`, import.meta.url)); if (existsSync(javascript)) return javascript; throw new Error(`Worker extension source is missing: ${typescript} or ${javascript}`); }
function parseModelSelection(value: string): { provider: string; model: string; thinkingLevel: any } { const slash = value.indexOf("/"); const colon = value.lastIndexOf(":"); if (slash < 1 || colon <= slash + 1) throw new Error(`Invalid persisted model selection: ${value}.`); return { provider: value.slice(0, slash), model: value.slice(slash + 1, colon), thinkingLevel: value.slice(colon + 1) }; }
function workerShellEnvironment(execution: WorkerShellExecution): NodeJS.ProcessEnv { return execution.kind === "native-test" ? { PI_WORKER_NATIVE_TEST_SHELL: "1", GIT_OPTIONAL_LOCKS: "0" } : { GIT_OPTIONAL_LOCKS: "0", PI_WORKER_CONTAINER: JSON.stringify(execution.container), PI_WORKER_DOCKER_PATH: execution.dockerPath }; }
