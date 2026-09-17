#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { isAsyncJobExecutionAlive } from "../extensions/_shared/async-job-process.js";

const configFile = process.argv[2];
if (!configFile) throw new Error("Usage: worker-host.mjs <host-config.json>");
const config = JSON.parse(readFileSync(configFile, "utf8"));
if (config.version !== 1) throw new Error(`Unsupported worker host config version: ${config.version}`);
if (!Array.isArray(config.rpcArgs) || config.rpcArgs.length === 0) throw new Error("Worker host config requires trusted RPC arguments.");
if (typeof config.authorizationFile !== "string" || !path.isAbsolute(config.authorizationFile) || !Number.isInteger(config.parentPid)) {
  throw new Error("Worker host config requires exact launch authorization.");
}
if (config.shellExecution?.kind !== "docker" && config.shellExecution?.kind !== "native-test") {
  throw new Error("Worker host config requires an explicit shell execution backend.");
}
writeAtomicJson(config.processFile, {
  version: 1,
  workerId: config.workerId,
  runId: config.runId,
  pid: process.pid,
  nonce: config.processNonce,
  hostConfigFile: config.hostConfigFile,
  startedAt: new Date().toISOString()
});
assertLaunchAuthorization();

const client = new RpcClient({
  cliPath: config.piCliPath,
  cwd: config.workspaceRoot,
  env: {
    PI_WORKER_ID: config.workerId,
    PI_WORKER_RUN_ID: config.runId,
    PI_WORKER_RESULT_FILE: config.resultFile,
    PI_WORKER_WORKSPACE_ROOT: config.workspaceRoot,
    PI_WORKER_STATE_ROOT: config.stateRoot,
    PI_WORKER_ASYNC_JOB_ROOT: config.asyncJobRoot,
    ...(config.parentContextSnapshot ? { PI_WORKER_PARENT_CONTEXT_SNAPSHOT: config.parentContextSnapshot } : {}),
    PI_WORKER_TASK_IDS: JSON.stringify(config.taskIds),
    PI_WORKER_BD_PATH: config.bdPath,
    PI_WORKER_BEADS_ROUTE: JSON.stringify(config.beadsRoute),
    ...(config.shellExecution.kind === "docker"
      ? {
          PI_WORKER_CONTAINER: JSON.stringify(config.shellExecution.container),
          PI_WORKER_DOCKER_PATH: config.shellExecution.dockerPath
        }
      : { PI_WORKER_NATIVE_TEST_SHELL: "1" })
  },
  args: config.rpcArgs
});

let stopping = false;
const stop = async (graceMs = 0, signalGroup = false) => {
  if (stopping) return;
  stopping = true;
  try { await client.abort(); } catch {}
  if (graceMs > 0) {
    if (signalGroup) {
      try { process.kill(-process.pid, "SIGTERM"); } catch {}
    }
    await delay(graceMs);
  }
  await client.stop();
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (stopping) return;
    void stop(2_500, false).finally(() => process.exit(signal === "SIGHUP" ? 129 : 143));
  });
}

client.onEvent((event) => {
  const summary = { type: event.type };
  for (const key of ["toolName", "toolCallId", "stopReason"]) {
    if (typeof event[key] === "string") summary[key] = event[key];
  }
  process.stdout.write(`${JSON.stringify({ type: "worker_rpc_event", workerId: config.workerId, runId: config.runId, event: summary })}\n`);
});

let completedSuccessfully = false;
try {
  await client.start();
  const initialState = await client.getState();
  assertSessionIdentity(initialState);
  const handoffSettlement = waitForHandoffSettlement(client, config.resultFile, config.timeoutMs);
  await Promise.all([client.prompt(config.prompt), handoffSettlement]);
  const state = await client.getState();
  assertSessionIdentity(state);
  if (state.isStreaming || state.isCompacting || state.pendingMessageCount !== 0) {
    throw new Error(`Worker RPC was not quiescent after handoff: ${JSON.stringify({ isStreaming: state.isStreaming, isCompacting: state.isCompacting, pendingMessageCount: state.pendingMessageCount })}`);
  }
  assertOwnedShellQuiescence();
  writeAtomicJson(config.settledFile, {
    version: 1,
    workerId: config.workerId,
    runId: config.runId,
    sessionId: state.sessionId,
    resultFile: config.resultFile,
    settledAt: new Date().toISOString()
  });
  completedSuccessfully = true;
  process.stdout.write(`${JSON.stringify({
    type: "worker_host_result",
    workerId: config.workerId,
    runId: config.runId,
    sessionId: state.sessionId,
    resultFile: config.resultFile
  })}\n`);
} finally {
  await stop(completedSuccessfully ? 0 : 3_000, !completedSuccessfully);
}

function assertOwnedShellQuiescence() {
  const jobsDirectory = path.join(config.asyncJobRoot, "jobs");
  if (!existsSync(jobsDirectory)) return;
  for (const entry of readdirSync(jobsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^job_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.name)) continue;
    const metaFile = path.join(jobsDirectory, entry.name, "meta.json");
    if (!existsSync(metaFile)) continue;
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    if (meta.owner?.kind !== "worker-run" || meta.owner.workerId !== config.workerId || meta.owner.runId !== config.runId) continue;
    const terminal = ["exited", "failed", "cancelled", "unknown"].includes(meta.status);
    if (!terminal && (!meta.processToken || isAsyncJobExecutionAlive(meta.pid, meta.processToken))) {
      throw new Error(`Worker handoff settlement found active or unverifiable owned async-shell job ${entry.name}.`);
    }
  }
}

function assertLaunchAuthorization() {
  const value = JSON.parse(readFileSync(config.authorizationFile, "utf8"));
  if (
    value?.version !== 1 ||
    value.workerId !== config.workerId ||
    value.runId !== config.runId ||
    value.parentPid !== config.parentPid ||
    value.processNonce !== config.processNonce ||
    !isProcessAlive(config.parentPid)
  ) {
    throw new Error(`Worker host launch authorization is no longer valid for ${config.workerId}/${config.runId}.`);
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertSessionIdentity(state) {
  if (state.sessionId !== config.sessionId) {
    throw new Error(`Worker RPC session mismatch: expected ${config.sessionId}, found ${state.sessionId}.`);
  }
}

function waitForHandoffSettlement(rpcClient, resultFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    let resultObserved = existsSync(resultFile);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const unsubscribe = rpcClient.onEvent((event) => {
      if (!resultObserved && existsSync(resultFile)) resultObserved = true;
      if (resultObserved && event.type === "agent_settled") finish();
    });
    const timeout = setTimeout(
      () => finish(new Error(`Worker handoff did not reach a settled turn within ${timeoutMs}ms.`)),
      timeoutMs
    );
  });
}

function writeAtomicJson(target, value) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
