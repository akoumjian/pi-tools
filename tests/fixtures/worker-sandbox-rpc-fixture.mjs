#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";

const identity = JSON.parse(process.env.FAKE_WORKER_IDENTITY); const scenario = process.env.FAKE_SCENARIO ?? "default"; const trace = (value) => { if (process.env.FAKE_TRACE) appendFileSync(process.env.FAKE_TRACE, `${value}\n`); }; trace("started");
let sequence = 0; let promptStarted = false; let promptCount = 0; let phase = "hello"; let requestIndex = 0;
if (scenario === "ignore-eof") setInterval(() => {}, 1_000);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { trace(`signal:${signal}`); process.exit(90); });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const host = (id, service, payload) => send({ type: "extension_host_request", id, service, payload });
const state = (admissionState, agentPhase = "idle") => ({ version: 1, workerId: identity.workerId, runId: identity.runId, sequence: ++sequence, agentPhase, activeJobCount: 0, pendingCompletionFollowUp: false, admissionState });
const requests = [
  { service: "worker_beads_tasks", payload: { action: "assigned", extra: true }, success: false, label: "additional-field-rejected" },
  { service: "worker_beads_tasks", payload: { action: "assigned", offset: 0, limit: 1 }, success: true, label: "assigned" },
  { service: "worker_beads_tasks", payload: { action: "get", taskIds: ["personal-test"] }, success: true, label: "get" },
  { service: "worker_beads_tasks", payload: { action: "search", query: "Test", limit: 1 }, success: true, label: "search" },
  { service: "worker_beads_tasks", payload: { action: "design", taskId: "personal-test", offset: 0, limit: 64 }, success: true, label: "design" },
  { service: "worker_beads_tasks", payload: { action: "update", taskId: "personal-test", note: "status-less durable note" }, success: true, label: "update-status-less", noStatus: true },
  { service: "worker_beads_tasks", payload: { action: "update", taskId: "personal-test", note: "status transition", status: "in_progress" }, success: true, label: "update-with-status" }
];
const nextRequest = () => { const request = requests[requestIndex]; if (!request) { phase = "submitting-state"; return host("20000000-0000-4000-8000-000000000001", "worker_runtime_state", state("submitting")); } host(`10000000-0000-4000-8000-${String(++requestIndex).padStart(12, "0")}`, request.service, request.payload); };
let orderingState;
if (scenario === "ordering") { phase = "ordering-before-hello"; host("50000000-0000-4000-8000-000000000001", "worker_runtime_state", state("open")); }
else host("00000000-0000-4000-8000-000000000001", "worker_runtime_hello", { version: 1, ...identity });
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const value = JSON.parse(line); trace(`in:${value.type}:${value.id ?? ""}`);
  if (value.type === "extension_host_response") {
    if (phase === "ordering-before-hello") { if (value.success) return fail("state accepted before hello", value); trace("checked:state-before-hello-rejected"); phase = "ordering-mismatched-hello"; host("50000000-0000-4000-8000-000000000002", "worker_runtime_hello", { version: 1, ...identity, runId: "run_wrong" }); return; }
    if (phase === "ordering-mismatched-hello") { if (value.success) return fail("mismatched hello accepted", value); trace("checked:mismatched-hello-rejected"); phase = "ordering-hello"; host("50000000-0000-4000-8000-000000000003", "worker_runtime_hello", { version: 1, ...identity }); return; }
    if (phase === "ordering-hello") { if (!value.success) return fail("ordering hello", value); phase = "ordering-duplicate-hello"; host("50000000-0000-4000-8000-000000000004", "worker_runtime_hello", { version: 1, ...identity }); return; }
    if (phase === "ordering-duplicate-hello") { if (value.success) return fail("duplicate hello accepted", value); trace("checked:duplicate-hello-rejected"); phase = "ordering-extra-state"; host("50000000-0000-4000-8000-000000000005", "worker_runtime_state", { ...state("submitting"), pid: 1 }); return; }
    if (phase === "ordering-extra-state") { if (value.success) return fail("state extra field accepted", value); trace("checked:state-additional-field-rejected"); phase = "ordering-state"; orderingState = state("submitting"); host("50000000-0000-4000-8000-000000000006", "worker_runtime_state", orderingState); return; }
    if (phase === "ordering-state") { if (!value.success) return fail("ordering state", value); phase = "ordering-state-replay"; host("50000000-0000-4000-8000-000000000007", "worker_runtime_state", orderingState); return; }
    if (phase === "ordering-state-replay") { if (value.success) return fail("state replay accepted", value); trace("checked:state-sequence-replay-rejected"); phase = "ready"; send({ type: "rpc_ready" }); return; }
    if (phase === "hello") { if (!value.success) return fail("hello", value); if (scenario !== "default") { phase = "special-state"; host("00000000-0000-4000-8000-000000000002", "worker_runtime_state", state(scenario.startsWith("outcome-") || scenario === "ignore-eof" || scenario === "cancel-result" ? "submitting" : "open")); } else { phase = "beads"; nextRequest(); } return; }
    if (phase === "special-state") { if (!value.success) return fail("special state", value); phase = "ready"; send({ type: "rpc_ready" }); return; }
    if (phase === "review-repair-submitting") { if (!value.success) return fail("review repair submitting state", value); phase = "review-repair-result"; host("80000000-0000-4000-8000-000000000002", "worker_result_submit", acceptedResult()); return; }
    if (phase === "review-repair-result") { if (!value.success) return fail("review repair result", value); phase = "review-repair-accepted"; host("80000000-0000-4000-8000-000000000003", "worker_runtime_state", state("accepted")); return; }
    if (phase === "review-repair-accepted") { if (!value.success) return fail("review repair accepted state", value); trace("checked:review-repair"); send({ type: "agent_end" }); send({ type: "message_end" }); return; }
    if (phase === "cancel-result-response") { if (!value.success) return fail("cancel result", value); trace("result-response"); return; }
    if (phase === "cancel-mutation-response") { trace(`mutation-response:${value.success ? "success" : "failure"}`); if (!value.success) trace(`mutation-error:${value.error ?? "unknown"}`); trace("cancel-ready"); return; }
    if (phase === "beads") {
      const request = requests[requestIndex - 1];
      if (value.success !== request.success) return fail(request.label, value);
      if (request.noStatus && /"status"\s*:/.test(JSON.stringify(value.result ?? value.data ?? {}))) return fail("status-less response serialized status", value);
      trace(`checked:${request.label}`); nextRequest(); return;
    }
    if (phase === "submitting-state") { if (!value.success) return fail("submitting state", value); phase = "ready"; send({ type: "rpc_ready" }); return; }
    if (phase === "invalid-result") { if (value.success) return fail("result additional field accepted", value); trace("checked:result-additional-field-rejected"); phase = "accepted-result"; host("30000000-0000-4000-8000-000000000002", "worker_result_submit", acceptedResult()); return; }
    if (phase === "outcome-result") { if (!value.success) return fail("outcome result", value); trace(`checked:${scenario}`); phase = "accepted-state"; host("40000000-0000-4000-8000-000000000002", "worker_runtime_state", state("accepted")); return; }
    if (phase === "accepted-result") { if (!value.success) return fail("accepted result", value); trace("dropped:first-accepted-response"); phase = "identical-retry"; host("30000000-0000-4000-8000-000000000003", "worker_result_submit", acceptedResult()); return; }
    if (phase === "identical-retry") { if (!value.success) return fail("identical retry", value); trace("checked:identical-retry-after-response-loss"); phase = "conflicting-retry"; host("30000000-0000-4000-8000-000000000004", "worker_result_submit", { outcome: "completed", summary: "conflicting accepted result" }); return; }
    if (phase === "conflicting-retry") { if (value.success) return fail("conflicting retry accepted", value); trace("checked:conflicting-retry-rejected"); phase = "accepted-state"; host("30000000-0000-4000-8000-000000000005", "worker_runtime_state", state("accepted")); return; }
    if (phase === "accepted-state") { if (!value.success) return fail("accepted state", value); send({ type: "agent_end" }); send({ type: "message_end" }); return; }
    return fail(`unexpected host response in ${phase}`, value);
  }
  if (value.type === "get_state") return send({ type: "response", id: value.id, success: true, data: { sessionId: identity.sessionId, isStreaming: false, isCompacting: false, pendingMessageCount: 0 } });
  if (value.type === "prompt") { promptStarted = true; promptCount += 1; send({ type: "response", id: value.id, success: true }); send({ type: "agent_start" }); if (scenario === "missing") { send({ type: "agent_end" }); send({ type: "message_end" }); return; } if (scenario === "review-repair") { if (promptCount === 1) { send({ type: "agent_end" }); send({ type: "message_end" }); return; } phase = "review-repair-submitting"; host("80000000-0000-4000-8000-000000000001", "worker_runtime_state", state("submitting", "active")); return; } if (scenario === "cancel") { trace("cancel-ready"); return; } if (scenario === "cancel-result") { phase = "cancel-result-response"; trace("result-sent"); host("70000000-0000-4000-8000-000000000001", "worker_result_submit", acceptedResult()); return; } if (scenario === "cancel-mutation") { phase = "cancel-mutation-response"; trace("mutation-sent"); host("60000000-0000-4000-8000-000000000001", "worker_beads_tasks", { action: "update", taskId: "personal-test", note: "drain before cancellation" }); return; } if (scenario.startsWith("outcome-")) { phase = "outcome-result"; host("40000000-0000-4000-8000-000000000001", "worker_result_submit", acceptedResult()); return; } phase = "invalid-result"; host("30000000-0000-4000-8000-000000000001", "worker_result_submit", { outcome: "completed", summary: "must reject extra field", extra: true }); return; }
  send({ type: "response", id: value.id, success: false, error: `unexpected command ${value.type}` });
});
lines.on("close", () => { trace("eof"); if (!promptStarted) process.exitCode = 13; });
function acceptedResult() { const outcome = scenario === "review-repair" ? "approve" : scenario.startsWith("outcome-") ? scenario.slice(8) : "completed"; return { outcome, summary: `spawned ${outcome} result branch`, ...(outcome === "needs_input" ? { question: "Which exact choice?" } : {}), ...(["approve", "request_changes"].includes(outcome) ? { artifacts: ["report.md"] } : {}) }; }
function fail(label, value) { process.stderr.write(`${label}: ${JSON.stringify(value)}\n`); process.exitCode = 12; }
