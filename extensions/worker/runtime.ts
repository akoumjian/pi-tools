import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeAsyncShellJobsForOwner, cancelAsyncShellJobsForOwner, cancelPersistedAsyncShellJobsForOwner, hasPendingAsyncShellCompletionFollowUpForOwner, sealAsyncShellCompletionForOwner, subscribeAsyncShellActivity, unsettledPersistedAsyncShellJobsForOwner, type AsyncShellJobOwner } from "../async-shell/index.js";
import { createWorkerCacheLineageRuntime, registerWorkerCacheLineageRuntimeHooks, validateWorkerCacheLineageRecord, type WorkerCacheLineageRecord } from "./cache-lineage.js";
import { WorkerBeadsTasksParams, WorkerBeadsTasksReadParams, WorkerReviewResultSubmitParams, WorkerWorkResultSubmitParams } from "./contract.js";
import { inputJsonSchemaGuideline } from "../_shared/tool-prompt.js";
import {
  canonicalJson,
  rejectedResult,
  requiredEnvironment,
  validateAndNormalizeWorkerResult,
  validateBeadsAction,
  workerRuntimeRole,
  type WorkerResultDetails
} from "./host-runtime.js";

export * from "./host-runtime.js";

export function readCacheLineageEnvironment(raw: string | undefined = process.env.PI_WORKER_CACHE_LINEAGE): WorkerCacheLineageRecord | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`Invalid PI_WORKER_CACHE_LINEAGE JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!validateWorkerCacheLineageRecord(parsed)) throw new Error("Invalid PI_WORKER_CACHE_LINEAGE state.");
  return parsed;
}

export default function workerRuntimeExtension(api: ExtensionAPI): void {
  const remoteHost = process.env.PI_WORKER_HOST_RPC === "1";
  const requestHost = <T>(service: string, payload: unknown): Promise<T> => (api as ExtensionAPI & { requestHost<TValue>(service: string, payload: unknown): Promise<TValue> }).requestHost<T>(service, payload);
  const identity = remoteHost ? workerGuestIdentity() : undefined;
  let runtimeSequence = 0;
  let agentPhase: "active" | "idle" | "shutting_down" = "idle";
  let admissionState: "open" | "submitting" | "accepted" = "open";
  let uncertainSubmissionSha256: string | undefined;
  const publishAdmissionState = () => Reflect.set(globalThis, Symbol.for("pi.worker.admission-state"), admissionState);
  publishAdmissionState();
  let stateDelivery = Promise.resolve();
  const sendRuntimeState = async (): Promise<void> => {
    if (!remoteHost || !identity) return;
    const sequence = ++runtimeSequence;
    const activeJobIds = new Set([...activeAsyncShellJobsForOwner(identity.owner), ...unsettledPersistedAsyncShellJobsForOwner(identity.asyncJobRoot, identity.owner)].filter((job) => job.status === "running" || job.status === "unknown").map((job) => job.jobId));
    const state = { version: 1, workerId: identity.workerId, runId: identity.runId, sequence, agentPhase, activeJobCount: activeJobIds.size, pendingCompletionFollowUp: hasPendingAsyncShellCompletionFollowUpForOwner(identity.owner), admissionState };
    stateDelivery = stateDelivery.catch(() => undefined).then(() => requestHost("worker_runtime_state", state)).then(() => undefined);
    await stateDelivery;
  };
  if (remoteHost && identity) {
    const unsubscribeAsyncActivity = subscribeAsyncShellActivity(() => { void sendRuntimeState().catch(() => {}); });
    api.on("session_start", async (_event, context) => {
      const provenance = JSON.parse(requiredEnvironment("PI_WORKER_RUNTIME_PROVENANCE")) as Record<string, unknown>;
      await requestHost("worker_runtime_hello", { version: 1, workerId: identity.workerId, runId: identity.runId, role: workerRuntimeRole(), sessionId: context.sessionManager.getSessionId(), ...provenance });
      await sendRuntimeState();
    });
    api.on("agent_start", async () => { agentPhase = "active"; await sendRuntimeState(); });
    api.on("agent_end", async () => { agentPhase = "idle"; await sendRuntimeState(); });
    api.on("session_shutdown", async () => { agentPhase = "shutting_down"; await sendRuntimeState(); unsubscribeAsyncActivity(); });
  }
  if (remoteHost) api.on("tool_call", (event) => admissionState === "open" || event.toolName === "worker_result_submit" ? undefined : ({ block: true, reason: "Worker run is sealed during or after result admission." }));
  const cacheLineage = createWorkerCacheLineageRuntime(readCacheLineageEnvironment());
  registerWorkerCacheLineageRuntimeHooks(api, cacheLineage);
  api.registerTool(defineTool({
    name: "worker_beads_tasks", label: "Read and Update Beads Tasks",
    description: "Read bounded assigned or relevant central Beads tasks, continue canonical design fields, search task metadata, or append a progress note to one assigned task. Work and integration workers may update only assigned tasks; review workers have read-only branches. The tool cannot close tasks or change dependencies.",
    promptSnippet: "Read or search Beads tasks, and when permitted update one assigned task.",
    promptGuidelines: [
      "worker_beads_tasks use: Use assigned for this worker's task page, get for exact task IDs, and design with both the returned UTF-8 byte offset and sha256 to continue a truncated canonical design. Restart at offset zero if the digest changes. Use search for bounded discovery and update only for meaningful progress or blockers on one assigned task.",
      inputJsonSchemaGuideline("worker_beads_tasks", WorkerBeadsTasksParams),
      "worker_beads_tasks constraints: Reads and canonical design chunks share a 64 KiB provider-visible response ceiling. Updates append notes and may set only in_progress or blocked; review workers cannot update. The adapter never exposes the database, routing, or arbitrary commands."
    ],
    parameters: workerRuntimeRole() === "review" ? WorkerBeadsTasksReadParams : WorkerBeadsTasksParams, executionMode: "sequential",
    async execute(_id, params): Promise<AgentToolResult<unknown>> {
      validateBeadsAction(params);
      if (!remoteHost) throw new Error("worker_beads_tasks requires the managed RPC host runtime.");
      return requestHost<AgentToolResult<unknown>>("worker_beads_tasks", params);
    }
  }));
  api.registerTool(defineTool({
    name: "worker_result_submit", label: "Submit Worker Result",
    description: "End the current worker run by submitting a structured result. Use it for completed work, requests for guidance, blockers, and review verdicts. The tool records the outcome, summary, optional question, repository roots, and ordinary non-repository artifact entry points, then seals the run and returns control to the parent. Completed reviewers must report a non-empty ordinary report file. It does not approve work, apply repositories, close tasks, or discard the worker.",
    promptSnippet: "Submit the current run’s completed work, request for guidance, blocker, or review verdict.",
    promptGuidelines: [
      "Use `worker_result_submit` when the current run should return control to the parent. Use `completed` only when the assigned work is finished, `needs_input` for parent-answerable questions required to continue, and `blocked` when an unavailable prerequisite or required intervention prevents progress. Review workers use `approve` or `request_changes` for completed reviews. Summarize the result and report useful repository and artifact entry points.",
      inputJsonSchemaGuideline("worker_result_submit", workerRuntimeRole() === "review" ? WorkerReviewResultSubmitParams : WorkerWorkResultSubmitParams),
      "worker_result_submit constraints: Rejected semantic results return stable coded field errors and do not seal the run. The runtime canonicalizes every reported path, rejects Git roots in artifacts, requires completed reviewers to report a non-empty ordinary report file, and internally reconciles owned work before acceptance."
    ],
    parameters: workerRuntimeRole() === "review" ? WorkerReviewResultSubmitParams : WorkerWorkResultSubmitParams, executionMode: "sequential",
    async execute(_id, params): Promise<AgentToolResult<WorkerResultDetails>> {
      if (!remoteHost) throw new Error("worker_result_submit requires the managed RPC host runtime.");
      const guest = workerGuestIdentity();
      const validation = validateAndNormalizeWorkerResult(params, guest.requestedWorkspaceRoot);
      if (validation.errors.length) return rejectedResult(validation.errors);
      if (admissionState === "accepted") {
        try { return await requestHost<AgentToolResult<WorkerResultDetails>>("worker_result_submit", params); }
        catch (error) { const message = error instanceof Error ? error.message : String(error); return rejectedResult([{ code: /revoked/.test(message) ? "authorization_revoked" : "operational_failure", path: "run", message }]); }
      }
      const submissionSha256 = createHash("sha256").update(canonicalJson(params)).digest("hex");
      if (admissionState === "submitting") {
        if (uncertainSubmissionSha256 !== submissionSha256) return rejectedResult([{ code: "operational_failure", path: "run", message: "A different worker result is already in uncertain host admission; authority remains sealed." }]);
        try { const recovered = await requestHost<AgentToolResult<WorkerResultDetails>>("worker_result_submit", params); if (recovered.details.status === "accepted") { admissionState = "accepted"; uncertainSubmissionSha256 = undefined; publishAdmissionState(); try { await sendRuntimeState(); } catch {} } return recovered; }
        catch (error) { const message = error instanceof Error ? error.message : String(error); return rejectedResult([{ code: /revoked/.test(message) ? "authorization_revoked" : "operational_failure", path: "run", message }]); }
      }
      let submissionAttempted = false; let hostAccepted = false; uncertainSubmissionSha256 = submissionSha256;
      try {
        admissionState = "submitting"; publishAdmissionState();
        await reconcileGuestOwnedWork(guest);
        await sendRuntimeState();
        submissionAttempted = true;
        const result = await requestHost<AgentToolResult<WorkerResultDetails>>("worker_result_submit", params);
        hostAccepted = result.details.status === "accepted";
        admissionState = hostAccepted ? "accepted" : "open"; uncertainSubmissionSha256 = undefined; publishAdmissionState();
        await sendRuntimeState();
        return result;
      } catch (error) {
        if (submissionAttempted && !hostAccepted) {
          try {
            const recovered = await requestHost<AgentToolResult<WorkerResultDetails>>("worker_result_submit", params);
            if (recovered.details.status === "accepted") {
              hostAccepted = true; admissionState = "accepted"; uncertainSubmissionSha256 = undefined; publishAdmissionState();
              try { await sendRuntimeState(); } catch {}
              return recovered;
            }
          } catch {}
        }
        admissionState = hostAccepted ? "accepted" : submissionAttempted ? "submitting" : "open"; if (!submissionAttempted) uncertainSubmissionSha256 = undefined; publishAdmissionState();
        const message = error instanceof Error ? error.message : String(error);
        return rejectedResult([{ code: /revoked/.test(message) ? "authorization_revoked" : "operational_failure", path: "run", message }]);
      }
    }
  }));
}

async function reconcileGuestOwnedWork(identity: { owner: AsyncShellJobOwner; asyncJobRoot: string }): Promise<void> {
  sealAsyncShellCompletionForOwner(identity.owner);
  await cancelAsyncShellJobsForOwner(identity.owner, "SIGTERM", 2_000);
  await cancelPersistedAsyncShellJobsForOwner(identity.asyncJobRoot, identity.owner, 2_000);
  const active = [...activeAsyncShellJobsForOwner(identity.owner), ...unsettledPersistedAsyncShellJobsForOwner(identity.asyncJobRoot, identity.owner)].filter((job) => job.status === "running" || job.status === "unknown");
  if (active.length) throw new Error(`Owned asynchronous work could not be reconciled: ${[...new Set(active.map((job) => job.jobId))].sort().join(", ")}.`);
}

function workerGuestIdentity(): { workerId: string; runId: string; workspaceRoot: string; requestedWorkspaceRoot: string; asyncJobRoot: string; owner: AsyncShellJobOwner } {
  const workerId = requiredEnvironment("PI_WORKER_ID"); const runId = requiredEnvironment("PI_WORKER_RUN_ID");
  const requestedWorkspaceRoot = path.resolve(requiredEnvironment("PI_WORKER_WORKSPACE_ROOT"));
  const workspaceRoot = realpathSync(requestedWorkspaceRoot);
  const asyncJobRoot = realpathSync(requiredEnvironment("PI_WORKER_ASYNC_JOB_ROOT"));
  return { workerId, runId, workspaceRoot, requestedWorkspaceRoot, asyncJobRoot, owner: { kind: "worker-run", workerId, runId } };
}
