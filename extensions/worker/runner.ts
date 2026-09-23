import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startManagedAsyncJob, type ManagedAsyncJobHandle } from "../async-shell/index.js";
import { resolveExecutable } from "../_shared/executable.js";
import { managedWorkerRoleSkillPath, type ManagedWorkerRoleSkill } from "../_shared/role-skills.js";
import type { WorkerContainerReference } from "../_shared/worker-container.js";
import type { WorkerIntegrationRecord, WorkerRecord } from "./state.js";

export type WorkerBeadsRoute = {
  prefix: "personal";
  path: string;
  databasePath: string;
};

export type WorkerShellExecution =
  | { kind: "docker"; dockerPath: string; container: WorkerContainerReference }
  | { kind: "native-test" };

export type WorkerHostConfig = {
  version: 1;
  workerId: string;
  runId: string;
  sessionId: string;
  sessionFile: string;
  sessionDir: string;
  workspaceRoot: string;
  stateRoot: string;
  asyncJobRoot: string;
  parentContextSnapshot?: string;
  taskIds: string[];
  roleSkill: Extract<ManagedWorkerRoleSkill, "implementation" | "integration">;
  integration?: WorkerIntegrationRecord;
  resultFile: string;
  settledFile: string;
  processFile: string;
  processNonce: string;
  hostConfigFile: string;
  authorizationFile: string;
  parentPid: number;
  prompt: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  piCliPath: string;
  bdPath: string;
  beadsRoute: WorkerBeadsRoute;
  extensionPaths: string[];
  shellExecution: WorkerShellExecution;
  rpcArgs: string[];
  timeoutMs: number;
};

export type WorkerHostProcess = {
  version: 1;
  workerId: string;
  runId: string;
  pid: number;
  nonce: string;
  hostConfigFile: string;
  startedAt: string;
};

export type WorkerHostSettlement = {
  version: 1;
  workerId: string;
  runId: string;
  sessionId: string;
  resultFile: string;
  settledAt: string;
};

export type LaunchWorkerHostInput = {
  record: WorkerRecord;
  prompt: string;
  resultFile: string;
  runDir: string;
  parentContextSnapshot?: string;
  processFile: string;
  processNonce: string;
  jobId: string;
  timeoutMs?: number;
  piCliPath?: string;
  bdPath?: string;
  beadsRoute?: WorkerBeadsRoute;
  extensionPaths?: string[];
  shellExecution: WorkerShellExecution;
};

export function launchWorkerHost(
  api: ExtensionAPI,
  context: ExtensionContext,
  input: LaunchWorkerHostInput
): { handle: ManagedAsyncJobHandle; config: WorkerHostConfig; configFile: string } {
  if (!input.record.sessionFile) throw new Error(`Worker ${input.record.workerId} has no forked session file.`);
  if (!input.record.activeRun) throw new Error(`Worker ${input.record.workerId} has no active run to launch.`);
  const activeRun = input.record.activeRun;
  const stateRoot = path.dirname(path.dirname(input.runDir));
  mkdirSync(input.runDir, { recursive: true, mode: 0o700 });
  const bdPath = input.bdPath ?? resolveExecutable("bd");
  const configFile = path.join(input.runDir, "host.json");
  const authorizationFile = path.join(input.runDir, "host-authorization.json");
  const config: WorkerHostConfig = {
    version: 1,
    workerId: input.record.workerId,
    runId: activeRun.runId,
    sessionId: input.record.sessionId,
    sessionFile: input.record.sessionFile,
    sessionDir: path.dirname(input.record.sessionFile),
    workspaceRoot: input.record.workspaceRoot,
    stateRoot,
    asyncJobRoot: path.join(stateRoot, "async-shell"),
    parentContextSnapshot: input.parentContextSnapshot,
    taskIds: [...input.record.taskIds],
    roleSkill: input.record.integration ? "integration" : "implementation",
    integration: input.record.integration,
    resultFile: input.resultFile,
    settledFile: path.join(input.runDir, "settled.json"),
    processFile: input.processFile,
    processNonce: input.processNonce,
    hostConfigFile: configFile,
    authorizationFile,
    parentPid: process.pid,
    prompt: input.prompt,
    provider: input.record.route.provider,
    model: input.record.route.model,
    thinkingLevel: input.record.route.thinkingLevel,
    piCliPath: input.piCliPath ?? resolvePiCliPath(),
    bdPath,
    beadsRoute: input.beadsRoute ?? resolveBeadsRoute(bdPath, context.cwd),
    extensionPaths: input.extensionPaths ?? defaultWorkerExtensionPaths(),
    shellExecution: input.shellExecution,
    rpcArgs: [],
    timeoutMs: input.timeoutMs ?? 3_600_000
  };
  config.rpcArgs = buildWorkerRpcArgs(config);
  writeFileSync(authorizationFile, `${JSON.stringify({
    version: 1,
    workerId: config.workerId,
    runId: config.runId,
    parentPid: config.parentPid,
    processNonce: config.processNonce
  }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const hostScript = resolveWorkerHostScript();
  const shellEnvironment = workerShellEnvironment(config.shellExecution);

  const handle = startManagedAsyncJob(api, context, {
    jobId: input.jobId,
    job_name: `worker ${input.record.workerId}`,
    command: `Pi worker host ${input.record.workerId}/${activeRun.runId}`,
    cwd: input.record.workspaceRoot,
    executable: process.execPath,
    args: [hostScript, configFile],
    env: {
      ...process.env,
      PI_WORKER_ID: input.record.workerId,
      PI_WORKER_RUN_ID: activeRun.runId,
      PI_WORKER_RESULT_FILE: input.resultFile,
      PI_WORKER_WORKSPACE_ROOT: input.record.workspaceRoot,
      PI_WORKER_STATE_ROOT: config.stateRoot,
      PI_WORKER_ASYNC_JOB_ROOT: config.asyncJobRoot,
      ...(config.parentContextSnapshot ? { PI_WORKER_PARENT_CONTEXT_SNAPSHOT: config.parentContextSnapshot } : {}),
      PI_WORKER_TASK_IDS: JSON.stringify(input.record.taskIds),
      ...(input.record.integration ? { PI_WORKER_INTEGRATION: JSON.stringify(input.record.integration) } : {}),
      PI_WORKER_BD_PATH: config.bdPath,
      PI_WORKER_BEADS_ROUTE: JSON.stringify(config.beadsRoute),
      ...shellEnvironment
    },
    notifyOnExit: false,
    settleProcessGroup: true
  });
  return { handle, config, configFile };
}

export function readWorkerHostProcess(processFile: string): WorkerHostProcess {
  const value = JSON.parse(readFileSync(processFile, "utf8")) as Partial<WorkerHostProcess>;
  if (
    value.version !== 1 ||
    typeof value.workerId !== "string" ||
    typeof value.runId !== "string" ||
    !Number.isInteger(value.pid) ||
    typeof value.nonce !== "string" ||
    typeof value.hostConfigFile !== "string" ||
    typeof value.startedAt !== "string"
  ) {
    throw new Error(`Invalid worker host process marker: ${processFile}`);
  }
  return value as WorkerHostProcess;
}

export function readWorkerHostSettlement(settledFile: string): WorkerHostSettlement {
  const value = JSON.parse(readFileSync(settledFile, "utf8")) as Partial<WorkerHostSettlement>;
  if (
    value.version !== 1 ||
    typeof value.workerId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.resultFile !== "string" ||
    typeof value.settledAt !== "string"
  ) {
    throw new Error(`Invalid worker host settlement: ${settledFile}`);
  }
  return value as WorkerHostSettlement;
}

export function buildWorkerRpcArgs(config: WorkerHostConfig): string[] {
  return [
    "--session", config.sessionFile,
    "--session-dir", config.sessionDir,
    "--model", `${config.provider}/${config.model}`,
    "--thinking", config.thinkingLevel,
    "--no-approve",
    "--no-context-files",
    "--no-skills",
    "--skill", managedWorkerRoleSkillPath(config.roleSkill),
    "--no-prompt-templates",
    "--no-themes",
    "--no-extensions",
    "--no-builtin-tools",
    "--tools", "worker_handoff,worker_task_read,worker_task_update,shell_start,shell_status,shell_read,shell_cancel",
    ...config.extensionPaths.flatMap((extensionPath) => ["-e", extensionPath])
  ];
}

export function resolveBeadsRoute(bdPath: string, cwd: string): WorkerBeadsRoute {
  const output = execFileSync(bdPath, ["where", "--json"], {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const value = JSON.parse(output) as { prefix?: unknown; path?: unknown; database_path?: unknown };
  if (value.prefix !== "personal" || typeof value.path !== "string" || typeof value.database_path !== "string") {
    throw new Error("Managed workers require the central personal Beads route.");
  }
  const resolvedPath = path.resolve(value.path);
  const ambientPath = process.env.BEADS_DIR?.trim();
  if (!ambientPath || path.resolve(ambientPath) !== resolvedPath) {
    throw new Error(`Managed workers require ambient BEADS_DIR to match the central route ${resolvedPath}.`);
  }
  return {
    prefix: "personal",
    path: resolvedPath,
    databasePath: path.resolve(value.database_path)
  };
}

export { resolveExecutable };

export function resolveWorkerHostScript(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(current, "scripts", "worker-host.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Worker host script is missing above ${fileURLToPath(import.meta.url)}.`);
    current = parent;
  }
}

export function resolvePiCliPath(): string {
  const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const cliPath = path.join(path.dirname(packageEntry), "cli.js");
  if (!existsSync(cliPath)) throw new Error(`Unable to resolve Pi CLI beside ${packageEntry}.`);
  return cliPath;
}

function workerShellEnvironment(execution: WorkerShellExecution): NodeJS.ProcessEnv {
  if (execution.kind === "native-test") return { PI_WORKER_NATIVE_TEST_SHELL: "1", GIT_OPTIONAL_LOCKS: "0" };
  return {
    GIT_OPTIONAL_LOCKS: "0",
    PI_WORKER_CONTAINER: JSON.stringify(execution.container),
    PI_WORKER_DOCKER_PATH: execution.dockerPath
  };
}

export function defaultWorkerExtensionPaths(): string[] {
  return [
    resolveExtensionSource("./runtime"),
    resolveExtensionSource("../async-shell/index")
  ];
}

function resolveExtensionSource(relativePath: string): string {
  const typescript = fileURLToPath(new URL(`${relativePath}.ts`, import.meta.url));
  if (existsSync(typescript)) return typescript;
  const javascript = fileURLToPath(new URL(`${relativePath}.js`, import.meta.url));
  if (existsSync(javascript)) return javascript;
  throw new Error(`Worker extension source is missing: ${typescript} or ${javascript}`);
}
