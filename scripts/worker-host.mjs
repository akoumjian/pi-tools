#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { readStrictWorkerJobMeta, workerJobIsSettled } from "../extensions/_shared/worker-job-settlement.js";
import { captureAsyncJobProcessIdentity, isAsyncJobExecutionAlive, signalAsyncJobExecution } from "../extensions/_shared/async-job-process.js";
import { writeAtomicJson } from "../extensions/_shared/atomic-json.js";

const configFile = process.argv[2];
if (!configFile) throw new Error("Usage: worker-host.mjs <host-config.json>");
const config = JSON.parse(readFileSync(configFile, "utf8"));
if (config.version !== 1) throw new Error(`Unsupported worker host config version: ${config.version}`);
if (!Array.isArray(config.rpcArgs) || config.rpcArgs.length === 0) throw new Error("Worker host config requires trusted RPC arguments.");
if (typeof config.authorizationFile !== "string" || !path.isAbsolute(config.authorizationFile)) {
  throw new Error("Worker host config requires exact launch authorization.");
}
if (config.shellExecution?.kind !== "docker" && config.shellExecution?.kind !== "native-test") {
  throw new Error("Worker host config requires an explicit shell execution backend.");
}
if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0)) {
  throw new Error("Worker host timeoutMs must be a positive safe integer when explicitly configured.");
}
const processIdentity = captureAsyncJobProcessIdentity(process.pid, process.env.PI_WORKER_JOB_TOKEN);
writeAtomicJson(config.processFile, {
  version: 2,
  workerId: config.workerId,
  runId: config.runId,
  ...processIdentity,
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
    PI_WORKER_TASK_IDS: JSON.stringify(config.taskIds),
    PI_WORKER_BD_PATH: config.bdPath,
    PI_WORKER_BEADS_ROUTE: JSON.stringify(config.beadsRoute),
    ...(config.cacheLineage ? { PI_WORKER_CACHE_LINEAGE: JSON.stringify(config.cacheLineage) } : {}),
    PI_WORKER_AUTHORIZATION_FILE: config.authorizationFile,
    PI_WORKER_PROCESS_NONCE: config.processNonce,
    PI_WORKER_JOB_TOKEN: "",
    GIT_OPTIONAL_LOCKS: "0",
    ...(config.shellExecution.kind === "docker"
      ? {
          PI_WORKER_CONTAINER: JSON.stringify(config.shellExecution.container),
          PI_WORKER_DOCKER_PATH: config.shellExecution.dockerPath
        }
      : { PI_WORKER_NATIVE_TEST_SHELL: "1" })
  },
  args: config.rpcArgs
});

let stopping;
const stop = (cancelOwnedShellWork = false) => {
  stopping ??= (async () => {
    try { await client.abort(); } catch {}
    if (cancelOwnedShellWork) await cancelOwnedShellJobs();
    await client.stop();
  })();
  return stopping;
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    void stop(true).then(
      () => process.exit(signal === "SIGHUP" ? 129 : 143),
      (error) => {
        console.error(error);
        process.exit(1);
      }
    );
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
  const resultSettlement = waitForResultSettlement(client, config.resultFile, config.timeoutMs);
  await Promise.all([client.prompt(config.prompt), resultSettlement]);
  const state = await client.getState();
  assertSessionIdentity(state);
  if (state.isStreaming || state.isCompacting || state.pendingMessageCount !== 0) {
    throw new Error(`Worker RPC was not quiescent after result submission: ${JSON.stringify({ isStreaming: state.isStreaming, isCompacting: state.isCompacting, pendingMessageCount: state.pendingMessageCount })}`);
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
  await stop(!completedSuccessfully);
}

function assertOwnedShellQuiescence() {
  for (const job of ownedShellJobs()) {
    if (!workerJobIsSettled(job)) {
      throw new Error(`Worker result settlement found active or unverifiable owned async-shell job ${job.jobId}.`);
    }
  }
}

async function cancelOwnedShellJobs() {
  const jobs = ownedShellJobs().filter((job) => !workerJobIsSettled(job));
  for (const job of jobs) signalAsyncJobExecution(job.pid, job.processToken, "SIGTERM");
  await waitForOwnedShellJobs(jobs, 2_000);
  for (const job of jobs.filter((candidate) => isAsyncJobExecutionAlive(candidate.pid, candidate.processToken))) {
    signalAsyncJobExecution(job.pid, job.processToken, "SIGKILL");
  }
  await waitForOwnedShellJobs(jobs, 2_000);
  const survivors = jobs.filter((job) => isAsyncJobExecutionAlive(job.pid, job.processToken));
  if (survivors.length) throw new Error(`Worker-owned async-shell jobs survived host shutdown: ${survivors.map((job) => job.jobId).join(", ")}.`);
}

async function waitForOwnedShellJobs(jobs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (jobs.some((job) => isAsyncJobExecutionAlive(job.pid, job.processToken)) && Date.now() < deadline) {
    await delay(25);
  }
}

function ownedShellJobs() {
  const jobsDirectory = path.join(config.asyncJobRoot, "jobs");
  if (!existsSync(jobsDirectory)) return [];
  return readdirSync(jobsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^job_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.name))
    .map((entry) => readStrictWorkerJobMeta(jobsDirectory, entry.name))
    .filter((job) => job.owner.workerId === config.workerId && job.owner.runId === config.runId);
}

function assertLaunchAuthorization() {
  const value = JSON.parse(readFileSync(config.authorizationFile, "utf8"));
  if (
    value?.version !== 1 ||
    value.workerId !== config.workerId ||
    value.runId !== config.runId ||
    value.processNonce !== config.processNonce
  ) {
    throw new Error(`Worker host launch authorization is no longer valid for ${config.workerId}/${config.runId}.`);
  }
}

function assertSessionIdentity(state) {
  if (state.sessionId !== config.sessionId) {
    throw new Error(`Worker RPC session mismatch: expected ${config.sessionId}, found ${state.sessionId}.`);
  }
}

function waitForResultSettlement(rpcClient, resultFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let checking = false;
    let timeout;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error); else resolve();
    };
    const reconcileSettledTurn = async () => {
      if (checking || finished) return;
      checking = true;
      let quiescentSince; let observedOwnedShellWork = false; let requestedSettledFollowUp = false;
      try {
        while (!finished) {
          const ownedShellState = ownedShellJobState();
          const ownedShellActive = ownedShellState.unsettled;
          if (ownedShellState.seen) observedOwnedShellWork = true;
          const state = await rpcClient.getState();
          const rpcActive = state.isStreaming || state.isCompacting || state.pendingMessageCount !== 0;
          if (existsSync(resultFile) && !ownedShellActive && !rpcActive) return finish();
          if (!ownedShellActive && !rpcActive && observedOwnedShellWork && !requestedSettledFollowUp) {
            requestedSettledFollowUp = true; quiescentSince = undefined;
            await rpcClient.prompt("Owned asynchronous work has settled. Inspect its retained completion notification and continue the assignment; submit worker_result_submit only when the run is ready to return control.");
            await delay(50); continue;
          }
          if (ownedShellActive || rpcActive) quiescentSince = undefined;
          else {
            quiescentSince ??= Date.now();
            if (Date.now() - quiescentSince >= 5_000) return finish(new Error("Worker reached a settled quiescent turn without the required typed worker_result_submit."));
          }
          await delay(50);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Worker async-shell settlement could not be verified."));
      } finally { checking = false; }
    };
    const unsubscribe = rpcClient.onEvent((event) => {
      if (event.type === "agent_settled") void reconcileSettledTurn();
    });
    if (timeoutMs !== undefined) timeout = setTimeout(() => finish(new Error(`Worker result did not reach a settled turn within the explicit ${timeoutMs}ms timeout.`)), timeoutMs);
  });
}

function hasUnsettledOwnedShellJobs() { return ownedShellJobState().unsettled; }

function ownedShellJobState() {
  const jobsDirectory = path.join(config.asyncJobRoot, "jobs");
  if (!existsSync(jobsDirectory)) return { seen: false, unsettled: false };
  let seen = false;
  for (const entry of readdirSync(jobsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^job_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.name)) continue;
    const meta = readStrictWorkerJobMeta(jobsDirectory, entry.name);
    if (meta.owner.workerId !== config.workerId || meta.owner.runId !== config.runId) continue;
    seen = true; if (!workerJobIsSettled(meta)) return { seen: true, unsettled: true };
  }
  return { seen, unsettled: false };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
