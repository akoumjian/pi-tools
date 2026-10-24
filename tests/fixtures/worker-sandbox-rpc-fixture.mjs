#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";

const identity = JSON.parse(process.env.FAKE_WORKER_IDENTITY); const trace = (value) => { if (process.env.FAKE_TRACE) appendFileSync(process.env.FAKE_TRACE, `${value}\n`); }; trace("started");
let sequence = 0; let promptStarted = false;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const host = (id, service, payload) => send({ type: "extension_host_request", id, service, payload });
const state = (admissionState, agentPhase = "idle") => ({ version: 1, workerId: identity.workerId, runId: identity.runId, sequence: ++sequence, agentPhase, activeJobCount: 0, pendingCompletionFollowUp: false, admissionState });
host("10000000-0000-4000-8000-000000000001", "worker_runtime_hello", { version: 1, ...identity });
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const value = JSON.parse(line); trace(`in:${value.type}:${value.id ?? ""}`);
  if (value.type === "extension_host_response") {
    if (!value.success) {
      if (value.id === "10000000-0000-4000-8000-000000000002") { host("10000000-0000-4000-8000-000000000003", "worker_runtime_state", state("submitting")); return; }
      if (value.id === "10000000-0000-4000-8000-000000000004") { host("10000000-0000-4000-8000-000000000005", "worker_result_submit", { outcome: "completed", summary: "spawned supervisor accepted exact fake Sandbox RPC" }); return; }
      process.stderr.write(`host failure ${value.id}: ${value.error}\n`); process.exitCode = 12; return;
    }
    if (value.id === "10000000-0000-4000-8000-000000000001") host("10000000-0000-4000-8000-000000000002", "worker_beads_tasks", { action: "update", taskId: "personal-test", note: "must reject", status: "closed" });
    else if (value.id === "10000000-0000-4000-8000-000000000003") send({ type: "rpc_ready" });
    else if (value.id === "10000000-0000-4000-8000-000000000005") host("10000000-0000-4000-8000-000000000006", "worker_runtime_state", state("accepted"));
    else if (value.id === "10000000-0000-4000-8000-000000000006") { send({ type: "agent_end" }); send({ type: "message_end" }); }
    return;
  }
  if (value.type === "get_state") return send({ type: "response", id: value.id, success: true, data: { sessionId: identity.sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0 } });
  if (value.type === "prompt") {
    promptStarted = true; send({ type: "response", id: value.id, success: true }); send({ type: "agent_start" });
    host("10000000-0000-4000-8000-000000000004", "worker_result_submit", { outcome: "completed", summary: "must reject extra field", extra: true }); return;
  }
  send({ type: "response", id: value.id, success: false, error: `unexpected command ${value.type}` });
});
lines.on("close", () => { if (!promptStarted) process.exitCode = 13; });
