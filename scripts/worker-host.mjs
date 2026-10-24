#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { captureAsyncJobProcessIdentity } from "../extensions/_shared/async-job-process.js";
import { writeAtomicJson } from "../extensions/_shared/atomic-json.js";
import { executeWorkerBeadsHostRequest, executeWorkerResultHostRequest } from "../extensions/worker/runtime.js";

const execFileAsync = promisify(execFile);
const configFile = process.argv[2];
if (!configFile) throw new Error("Usage: worker-host.mjs <host-config.json>");
const config = JSON.parse(readFileSync(configFile, "utf8"));
const PROMPT_START_TIMEOUT_MS = 5_000;
if (config.version !== 2 || config.backend !== "docker-sandbox") throw new Error(`Unsupported worker host config: ${config.version}/${config.backend}`);
if (!Array.isArray(config.rpcArgs) || config.rpcArgs.length === 0) throw new Error("Worker host config requires trusted RPC arguments.");
if (typeof config.authorizationFile !== "string" || !path.isAbsolute(config.authorizationFile)) throw new Error("Worker host config requires exact launch authorization.");
if (typeof config.launchManifestFile !== "string" || !path.isAbsolute(config.launchManifestFile) || !/^[a-f0-9]{64}$/.test(config.launchManifestSha256 ?? "")) throw new Error("Worker host config requires an exact Sandbox launch manifest.");
if (createHash("sha256").update(readFileSync(config.launchManifestFile)).digest("hex") !== config.launchManifestSha256) throw new Error("Worker Sandbox launch manifest hash mismatch.");
if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0)) throw new Error("Worker host timeoutMs must be a positive safe integer when explicitly configured.");
const processIdentity = captureAsyncJobProcessIdentity(process.pid, process.env.PI_WORKER_JOB_TOKEN);
writeAtomicJson(config.processFile, { version: 2, workerId: config.workerId, runId: config.runId, ...processIdentity, nonce: config.processNonce, hostConfigFile: config.hostConfigFile, startedAt: new Date().toISOString() });
assertLaunchAuthorization();

let acceptedHello;
let runtimeState;
let revoked = false;
let hostAdmissionState = "open";
let admittedMutations = 0;
const mutationDrainWaiters = new Set();
const client = new RpcClient({
  cliPath: config.sandboxShimPath,
  cwd: config.workspaceRoot,
  env: { PI_WORKER_SANDBOX_LAUNCH_MANIFEST: config.launchManifestFile },
  args: config.rpcArgs,
  hostRequestHandlers: {
    worker_runtime_hello: async (payload) => {
      assertAuthorized("worker_runtime_hello");
      if (acceptedHello) throw new Error("Worker runtime hello was already accepted.");
      const hello = validateHello(payload);
      acceptedHello = hello;
      writeAtomicJson(config.helloFile, { ...hello, acceptedAt: new Date().toISOString() });
      return { accepted: true, protocolVersion: 1 };
    },
    worker_runtime_state: async (payload) => {
      assertAuthorized("worker_runtime_state");
      if (!acceptedHello) throw new Error("Worker runtime hello is required before state.");
      const state = validateState(payload);
      if (runtimeState && state.sequence <= runtimeState.sequence) throw new Error("Worker runtime state sequence must increase.");
      runtimeState = state;
      writeAtomicJson(config.stateFile, state);
      return { accepted: true, sequence: state.sequence };
    },
    worker_result_submit: async (payload) => {
      assertAuthorized("worker_result_submit");
      if (!acceptedHello || !runtimeState) throw new Error("Worker runtime compatibility and state are required before result submission.");
      if (hostAdmissionState === "submitting") throw new Error("Worker result admission is already in progress.");
      const recoveringAcceptedResult = hostAdmissionState === "accepted";
      if (!recoveringAcceptedResult) {
        if (runtimeState.admissionState !== "submitting" || runtimeState.activeJobCount !== 0 || runtimeState.pendingCompletionFollowUp) throw new Error("Worker runtime is not quiescent for result admission.");
        hostAdmissionState = "submitting";
        await drainAdmittedMutations();
      }
      try {
        const result = await executeWorkerResultHostRequest(payload);
        if (result?.details?.status === "accepted") { hostAdmissionState = "accepted"; revoked = true; }
        else if (!recoveringAcceptedResult) hostAdmissionState = "open";
        return result;
      } catch (error) { if (!recoveringAcceptedResult) hostAdmissionState = "open"; throw error; }
    },
    worker_beads_tasks: async (payload) => {
      assertAuthorized("worker_beads_tasks");
      if (!acceptedHello) throw new Error("Worker runtime compatibility is required before Beads access.");
      const mutation = payload?.action === "update";
      if (mutation && hostAdmissionState !== "open") throw new Error("Worker mutation authority is sealed during or after result admission.");
      if (mutation) admittedMutations += 1;
      try { return await executeWorkerBeadsHostRequest(payload); }
      finally { if (mutation && --admittedMutations === 0) { for (const resolve of mutationDrainWaiters) resolve(); mutationDrainWaiters.clear(); } }
    }
  }
});

let stopping;
const stop = () => stopping ??= (async () => { revoked = true; await drainAdmittedMutations(); await client.stop(); })();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { const exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143; void stopBoundedly().then(() => process.exit(exitCode), (error) => { console.error(error); process.exit(1); }); });
client.onEvent((event) => {
  const summary = { type: event.type };
  for (const key of ["toolName", "toolCallId", "stopReason"]) if (typeof event[key] === "string") summary[key] = event[key];
  process.stdout.write(`${JSON.stringify({ type: "worker_rpc_event", workerId: config.workerId, runId: config.runId, event: summary })}\n`);
});

let completedSuccessfully = false;
try {
  await client.start();
  if (!acceptedHello) throw new Error("Worker RPC became ready without an accepted runtime hello.");
  const initialState = await client.getState(); assertSessionIdentity(initialState);
  const resultSettlement = waitForResultSettlement(client, config.resultFile, config.timeoutMs);
  const promptStart = observePromptStart(client);
  const promptAttempt = client.prompt(config.prompt).then(() => promptStart.acknowledge(), (error) => { if (isPromptResponseTimeout(error) && promptStart.sawCompaction()) return; promptStart.fail(error); });
  await Promise.all([promptAttempt, promptStart.promise, resultSettlement]);
  const state = await client.getState(); assertSessionIdentity(state);
  if (state.isStreaming || state.isCompacting || state.pendingMessageCount !== 0) throw new Error(`Worker RPC was not quiescent after result submission: ${JSON.stringify({ isStreaming: state.isStreaming, isCompacting: state.isCompacting, pendingMessageCount: state.pendingMessageCount })}`);
  if (!runtimeState || runtimeState.admissionState !== "accepted" || runtimeState.agentPhase !== "idle" || runtimeState.activeJobCount !== 0 || runtimeState.pendingCompletionFollowUp) throw new Error(`Worker typed runtime state was not quiescent after result submission: ${JSON.stringify(runtimeState)}`);
  writeAtomicJson(config.settledFile, { version: 1, workerId: config.workerId, runId: config.runId, sessionId: state.sessionId, resultFile: config.resultFile, helloFile: config.helloFile, stateFile: config.stateFile, settledAt: new Date().toISOString() });
  completedSuccessfully = true;
  process.stdout.write(`${JSON.stringify({ type: "worker_host_result", workerId: config.workerId, runId: config.runId, sessionId: state.sessionId, resultFile: config.resultFile })}\n`);
} finally {
  try { await stopBoundedly(); }
  catch (error) { if (!completedSuccessfully) throw error; console.error(`Worker RPC graceful shutdown failed after settled evidence: ${error instanceof Error ? error.message : String(error)}`); }
}

async function stopBoundedly() {
  const graceful = stop();
  const first = await boundedSettlement(graceful, 5_000);
  if (first.done && first.error === undefined) return;
  try { await execFileAsync(config.sbxPath, ["stop", config.sandbox.sandboxName], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000 }); } catch {}
  const hard = await boundedSettlement(graceful, 5_000);
  if (!hard.done) throw new Error(`Worker RPC did not exit after exact Sandbox stop for ${config.sandbox.sandboxName}.`);
  if (hard.error !== undefined) throw hard.error;
}
function boundedSettlement(promise, milliseconds) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ done: false }); } }, milliseconds); timer.unref();
    promise.then(() => { if (!settled) { settled = true; clearTimeout(timer); resolve({ done: true }); } }, (error) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ done: true, error }); } });
  });
}

function assertAuthorized(service) {
  if (revoked && service !== "worker_runtime_state" && service !== "worker_result_submit") throw new Error("Worker host authority is revoked.");
  if (existsSync(config.resultFile) && (service === "worker_runtime_state" || service === "worker_result_submit")) return;
  assertLaunchAuthorization();
}
function assertLaunchAuthorization() {
  const value = JSON.parse(readFileSync(config.authorizationFile, "utf8"));
  if (value?.version !== 2 || value.workerId !== config.workerId || value.runId !== config.runId || value.processNonce !== config.processNonce || value.sandboxName !== config.sandbox.sandboxName || value.creationNonce !== config.sandbox.creationNonce) throw new Error(`Worker host launch authorization is no longer valid for ${config.workerId}/${config.runId}.`);
}
async function drainAdmittedMutations() { if (admittedMutations === 0) return; await new Promise((resolve) => mutationDrainWaiters.add(resolve)); }
function validateHello(value) {
  const expected = config.runtimeProvenance;
  if (!value || value.version !== 1 || value.workerId !== config.workerId || value.runId !== config.runId || value.role !== config.role || value.sessionId !== config.sessionId || value.protocolVersion !== 1 || value.sandboxName !== config.sandbox.sandboxName || value.creationNonce !== config.sandbox.creationNonce) throw new Error("Worker runtime hello identity mismatch.");
  for (const key of ["piRevision", "profileRevision", "piToolsRevision", "piDocparserRevision", "resourceManifestSha256", "imageDigest", "kitSha256"]) if (value[key] !== expected[key]) throw new Error(`Worker runtime hello ${key} mismatch.`);
  if (JSON.stringify(value.extensionPaths) !== JSON.stringify(expected.extensionPaths)) throw new Error("Worker runtime hello extensionPaths mismatch.");
  return value;
}
function validateState(value) {
  if (!value || value.version !== 1 || value.workerId !== config.workerId || value.runId !== config.runId || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !["active", "idle", "shutting_down"].includes(value.agentPhase) || !Number.isSafeInteger(value.activeJobCount) || value.activeJobCount < 0 || typeof value.pendingCompletionFollowUp !== "boolean" || !["open", "submitting", "accepted"].includes(value.admissionState)) throw new Error("Invalid worker runtime state.");
  return value;
}
function assertSessionIdentity(state) { if (state.sessionId !== config.sessionId) throw new Error(`Worker RPC session mismatch: expected ${config.sessionId}, found ${state.sessionId}.`); }
function observePromptStart(rpcClient) {
  let finish; let finished = false; let promptAcknowledged = false; let compactionObserved = false; let timeout;
  const promise = new Promise((resolve, reject) => { finish = (error) => { if (finished) return; finished = true; if (timeout !== undefined) clearTimeout(timeout); unsubscribe(); if (error) reject(error); else resolve(); }; });
  const unsubscribe = rpcClient.onEvent((event) => { if (event.type === "compaction_start") { compactionObserved = true; return; } if (event.type === "response" && event.command === "prompt" && event.success === false) { finish(new Error(typeof event.error === "string" ? event.error : "Worker RPC prompt failed after compaction.")); return; } if (event.type === "agent_start") finish(); });
  return { promise, acknowledge() { if (finished || promptAcknowledged) return; promptAcknowledged = true; timeout = setTimeout(() => finish(new Error("Worker RPC prompt response did not begin an agent turn.")), PROMPT_START_TIMEOUT_MS); }, fail(error) { finish(error instanceof Error ? error : new Error("Worker RPC prompt failed.")); }, sawCompaction() { return compactionObserved; } };
}
function isPromptResponseTimeout(error) { return error instanceof Error && error.message.startsWith("Timeout waiting for response to prompt."); }
function waitForResultSettlement(rpcClient, resultFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false; let checking = false; let timeout;
    const finish = (error) => { if (finished) return; finished = true; if (timeout !== undefined) clearTimeout(timeout); unsubscribe(); if (error) reject(error); else resolve(); };
    const reconcile = async () => { if (checking || finished) return; checking = true; let idleSince;
      try { while (!finished) { const state = await rpcClient.getState(); const rpcActive = state.isStreaming || state.isCompacting || state.pendingMessageCount !== 0; const typedIdle = runtimeState?.admissionState === "accepted" && runtimeState?.agentPhase === "idle" && runtimeState?.activeJobCount === 0 && !runtimeState?.pendingCompletionFollowUp; if (existsSync(resultFile) && !rpcActive && typedIdle) return finish(); if (!rpcActive && runtimeState?.admissionState === "open" && runtimeState?.agentPhase === "idle" && runtimeState?.activeJobCount === 0) { idleSince ??= Date.now(); if (Date.now() - idleSince >= 5_000) return finish(new Error("Worker turn settled without worker_result_submit.")); } else idleSince = undefined; await delay(50); } }
      catch (error) { finish(error); } finally { checking = false; } };
    const unsubscribe = rpcClient.onEvent((event) => { if (event.type === "agent_end" || event.type === "message_end") void reconcile(); });
    if (timeoutMs !== undefined) timeout = setTimeout(() => finish(new Error(`Worker result settlement timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
