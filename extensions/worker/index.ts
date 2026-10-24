import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Text, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { resolveExtensionModel, assertChildAgentRouteAllowed, parseModelThinkingPair } from "../_shared/model-spec.js";
import { throwIfAborted } from "../_shared/cancellation.js";
import { asyncJobProcessStartToken, createAsyncJobId, isAsyncJobProcessIdentityAlive, signalAsyncJobProcessIdentity } from "../_shared/async-job.js";
import { handleAsyncShellViewerCommand, reconcileTerminatedPersistedAsyncShellJobsForOwner, unsettledPersistedAsyncShellJobsForOwner, type JobMeta, type ManagedAsyncJobHandle } from "../async-shell/index.js";
import { createWorkerContainerAsync, planWorkerContainer, resolveDockerPath, settleWorkerContainerAsync, type WorkerContainerReference } from "../_shared/worker-container.js";
import { inputJsonSchemaGuideline, outputJsonSchemaGuideline } from "../_shared/tool-prompt.js";
import { workerMutationAdmissionPath, workerResultAdmissionPath } from "../_shared/worker-contract.js";
import { workerRoleInstructions } from "../_shared/role-instructions.js";
import { RetainedToolOutputSchemas } from "../_shared/tool-output.js";
import { WorkerControlParamsV2, WorkerMergeApplyParams, WorkerMergeTestParams, WorkerRunParamsV2, type WorkerControlInputV2, type WorkerRunInputV2 } from "./contract.js";
import { applyPreparedWorkerMerges, consumePreparedMergeSet, defaultPreparedMergeRoot, prepareWorkerMerges, readPreparedMergeSet, restoreConsumedPreparedMergeSet } from "./merge.js";
import {
  abandonWorkerDiscard, activeRunsForParent, claimPreparedSetApply, clearWorkerRecoveryError, claimWorkerCancellation, claimWorkerDiscard, claimWorkerDelivery, claimWorkerRun,
  countWorkers, createWorkerRunBatch, finalizeClaimedWorkerRun, finalizeWorkerDiscard, finalizeWorkerRunLaunch, findWorkerRunById, finishPreparedSetApply,
  getWorker, getWorkerRun, listWorkerRuns, listWorkers, markWorkerDeliveryDelivered, openWorkerRegistry, pendingWorkerDeliveries,
  readPreparedSetRecord, recordWorkerSettlementRecovery, recoverInterruptedClaimsForParent, reconcileWorkerDeliveries, registerParentRuntime, releasePreparedSetApply, releaseWorkerDeliveryClaim, releaseWorkerRunClaim, setWorkerRecoveryError, storePreparedSet,
  subscribeWorkerRegistryChanges, updatePreparedSetStatus, updateWorkerRuntimeMetadata, workerRegistryDataVersion,
  type WorkerBatchCreateItem, type WorkerRegistry, type WorkerRegistryRecord, type WorkerRepositoryResult, type WorkerRole, type WorkerRunRecord
} from "./registry.js";
import { readWorkerRuntimeResult } from "./runtime.js";
import { cleanupReviewOverlayAsync, createReviewOverlayAsync, type ReviewOverlayRecord } from "./review-workspace.js";
import { preferredWorkerModel } from "./settings.js";
import { createWorkerId, createWorkerRunId, defaultWorkerRoots, provisionWorkerPaths, workerPaths, type WorkerPaths, type WorkerRoots } from "./identity.js";
import { createWorkerSession, forkWorkerSession, verifyWorkerSession } from "./session.js";
import { launchWorkerHost, readWorkerHostProcess, readWorkerHostSettlement, type WorkerLaunchRecord } from "./runner.js";
import { renderWorkerRuntimePrompt } from "./prompts.js";
import { contextInputs, inputMounts, validateAdditionalInputs, type RetainedInput } from "./inputs.js";
import { inspectInterruptedGitState, inventoryWorkerRepositories, snapshotWorkerRepositories, type RepositorySnapshot } from "./inventory.js";
import { canonicalPathWithin, canonicalRepository, trustedGit } from "./trusted-git.js";
import { prepareWorkerCacheLineage, registerParentCacheLineageCapture, type WorkerCacheLineageRecord } from "./cache-lineage.js";

export { WorkerRunParamsV2 as WorkerRunParams, WorkerControlParamsV2 as WorkerControlParams, WorkerMergeTestParams, WorkerMergeApplyParams };
export type WorkerRunInput = WorkerRunInputV2;
export type WorkerControlInput = WorkerControlInputV2;

export const WORKER_ACTIVITY_STATUS_KEY = "00-pi-tools-worker-activity";

export function activeWorkerCountForContext(registry: WorkerRegistry, context: Pick<ExtensionContext, "sessionManager">): number {
  const parentSessionFile = context.sessionManager.getSessionFile();
  if (!parentSessionFile) return 0;
  try {
    const counts = countWorkers(registry, realpathOrResolve(parentSessionFile));
    return counts.queued + counts.running;
  } catch {
    return 0;
  }
}

export function renderWorkerActivityStatus(count: number, theme: Pick<Theme, "fg">): string | undefined {
  if (count <= 0) return undefined;
  return theme.fg("accent", `w${count}`);
}

type ReviewOverlayPlan = Omit<Parameters<typeof createReviewOverlayAsync>[0], "dockerPath">;
type RunRuntime = {
  version: 2; prompt: string; runDir: string; resultFile: string; settledFile: string; processFile: string; processNonce: string;
  container: WorkerContainerReference; overlay?: ReviewOverlayRecord; reviewOverlayPlan?: ReviewOverlayPlan; contextFile?: string; inputs: RetainedInput[];
  repositoryBefore: RepositorySnapshot[]; pendingWorkSessionId?: string; interruptionWarnings?: string[];
};
type WorkerRuntime = { version: 2; inputs: RetainedInput[]; repositoryBaselines?: Array<{ path: string; resolvedCommit: string }>; cacheLineage?: WorkerCacheLineageRecord };
type PendingRun = { workerId: string; runId: string; parentSessionFile: string; parentSessionId: string; runtime: RunRuntime };
type ActiveRun = { runId: string; handle: ManagedAsyncJobHandle };
type PlannedRun = {
  request: WorkerRunInputV2["runs"][number]; role: WorkerRole; workerId: string; runId: string; jobId: string; paths: WorkerPaths;
  taskIds: string[]; modelSelection: string; binding?: WorkerRunRecord["binding"]; workerRuntime: WorkerRuntime; runRuntime: RunRuntime;
  newWorker: boolean; expectedVersion?: number; reviewedRunId?: string; preparedId?: string; consumedPrepared?: boolean; operationRepositories?: Array<Record<string, unknown>>;
};
type WorkerOperationSnapshot =
  | { scope: "worker_run"; runId: string; operation: WorkerOperation }
  | { scope: "worker_merge_apply"; preparedId: string; operation: WorkerOperation };
export type WorkerExtensionDependencies = {
  runtimeRoot?: string; roots?: WorkerRoots; codeRoot?: string; preparedRoot?: string; targetRoot?: string; now?: () => Date; random?: () => string; dockerPath?: string;
  createContainer?: (dockerPath: string, reference: WorkerContainerReference) => WorkerContainerReference | Promise<WorkerContainerReference>;
  removeContainer?: (dockerPath: string, reference: WorkerContainerReference) => void | Promise<void>;
  launch?: (api: ExtensionAPI, context: ExtensionContext, input: { record: WorkerLaunchRecord; runtime: RunRuntime }) => ManagedAsyncJobHandle;
  createOverlay?: (input: Parameters<typeof createReviewOverlayAsync>[0]) => ReviewOverlayRecord | Promise<ReviewOverlayRecord>; cleanupOverlay?: (dockerPath: string, overlay: ReviewOverlayRecord) => void | Promise<void>;
  waitForHostIdentity?: (runtime: RunRuntime, workerId: string, runId: string) => Promise<void>;
};

export default function workerExtension(api: ExtensionAPI): void { registerWorkerExtension(api); }

export function registerWorkerExtension(api: ExtensionAPI, overrides: WorkerExtensionDependencies = {}): void {
  const roots = overrides.roots ?? defaultWorkerRoots();
  const runtimeRoot = overrides.runtimeRoot ?? path.dirname(roots.stateRoot);
  const now = overrides.now ?? (() => new Date());
  const random = overrides.random ?? randomUUID;
  const testLaunch = overrides.launch;
  let configuredDockerPath = overrides.dockerPath ?? (testLaunch ? "/test/docker" : undefined);
  const docker = () => configuredDockerPath ??= resolveDockerPath();
  const createContainer = overrides.createContainer ?? (testLaunch ? ((_docker, reference) => ({ ...reference, containerId: "f".repeat(64) })) : createWorkerContainerAsync);
  const removeContainer = overrides.removeContainer ?? (testLaunch ? (() => {}) : settleWorkerContainerAsync);
  const createOverlay = overrides.createOverlay ?? createReviewOverlayAsync;
  const verifyHostIdentity = overrides.waitForHostIdentity ?? waitForWorkerHostIdentity;
  const cleanupOverlay = overrides.cleanupOverlay ?? cleanupReviewOverlayAsync;
  let registry: WorkerRegistry | undefined;
  let runtimeGeneration = 0;
  let deliveryTimer: NodeJS.Timeout | undefined;
  let observedDataVersion = 0;
  let currentContext: ExtensionContext | undefined;
  let unsubscribeActivity: (() => void) | undefined;
  let activityGeneration = 0;
  const pending = new Map<string, PendingRun>();
  const active = new Map<string, ActiveRun>();
  const starting = new Map<string, { runId: string; completion: Promise<void> }>();
  const deliveredRecovery = new Set<string>();
  const deliveryAttempts = new Map<string, number>();
  const getRegistry = () => registry ??= openWorkerRegistry(runtimeRoot);
  const operationSnapshots = new Map<string, WorkerOperationSnapshot>();
  const clearOperationSnapshot = (toolCallId: string): void => { if (toolCallId) operationSnapshots.delete(toolCallId); };
  const operationSnapshot = (toolCallId: string): WorkerOperationSnapshot | undefined => toolCallId ? operationSnapshots.get(toolCallId) : undefined;
  const rememberOperationSnapshot = (toolCallId: string, snapshot: WorkerOperationSnapshot | undefined): void => {
    if (!toolCallId || !snapshot) return;
    operationSnapshots.delete(toolCallId);
    operationSnapshots.set(toolCallId, snapshot);
    while (operationSnapshots.size > 128) operationSnapshots.delete(operationSnapshots.keys().next().value!);
  };
  const repaintWorkerActivity = (context: ExtensionContext): void => {
    try { updateWorkerActivityStatus(getRegistry(), context); }
    catch {
      if (context.mode === "tui" && context.hasUI && typeof context.ui?.setStatus === "function") context.ui.setStatus(WORKER_ACTIVITY_STATUS_KEY, undefined);
    }
  };
  registerParentCacheLineageCapture(api, roots.stateRoot, now);

  const launch = (context: ExtensionContext, record: WorkerLaunchRecord, runtime: RunRuntime): ManagedAsyncJobHandle => {
    if (testLaunch) {
      const value = testLaunch(api, context, { record, runtime });
      if (!value || typeof value !== "object" || !("completion" in value)) throw new Error("Injected worker launch did not return a managed handle.");
      return value as ManagedAsyncJobHandle;
    }
    return launchWorkerHost(api, context, { record, prompt: runtime.prompt, resultFile: runtime.resultFile, runDir: runtime.runDir, processFile: runtime.processFile, processNonce: runtime.processNonce, shellExecution: { kind: "docker", dockerPath: docker(), container: runtime.container } }).handle;
  };

  api.on("session_start", (_event, context) => {
    const generation = ++activityGeneration;
    unsubscribeActivity?.();
    unsubscribeActivity = undefined;
    if (context.mode === "tui" && context.hasUI) {
      unsubscribeActivity = subscribeWorkerRegistryChanges(() => {
        if (generation === activityGeneration) repaintWorkerActivity(context);
      });
    }
    try {
      currentContext = context;
      const parent = context.sessionManager.getSessionFile(); if (!parent) return;
      const exactParent = realpathOrResolve(parent);
      runtimeGeneration = registerParentRuntime(getRegistry(), exactParent, randomUUID(), now().toISOString());
      recoverInterruptedDiscardFiles(exactParent, runtimeGeneration);
      recoverInterruptedClaimsForParent(getRegistry(), exactParent, runtimeGeneration, now().toISOString());
      reconcileWorkerDeliveries(getRegistry(), exactParent, sessionDeliveryIds(context));
      deliveryAttempts.clear();
      deliveredRecovery.clear();
      observedDataVersion = workerRegistryDataVersion(getRegistry());
      deliverPendingCompletions(api, getRegistry(), exactParent, runtimeGeneration, deliveryAttempts);
      void Promise.resolve().then(() => reconcileActiveRuns(context, exactParent));
      if (deliveryTimer) clearInterval(deliveryTimer);
      deliveryTimer = setInterval(() => {
        try {
          const current = workerRegistryDataVersion(getRegistry());
          if (current !== observedDataVersion) {
            observedDataVersion = current;
            repaintWorkerActivity(context);
          }
          deliverPendingCompletions(api, getRegistry(), exactParent, runtimeGeneration, deliveryAttempts);
          void reconcileActiveRuns(context, exactParent);
        } catch {}
      }, 1_000);
      deliveryTimer.unref();
    } finally {
      if (generation === activityGeneration) repaintWorkerActivity(context);
    }
  });
  api.on("input", (_event, context) => repaintWorkerActivity(context));
  api.on("turn_end", (_event, context) => {
    const parentFile = context.sessionManager.getSessionFile(); if (!parentFile) return;
    const parent = realpathOrResolve(parentFile); const parentSessionId = context.sessionManager.getSessionId();
    const launches = [...pending.values()].filter((item) => item.parentSessionFile === parent && item.parentSessionId === parentSessionId);
    for (const item of launches) pending.delete(item.runId);
    for (const item of launches) beginPreparedRun(context, item);
  });
  api.on("agent_end", (_event, context) => {
    const parentFile = context.sessionManager.getSessionFile(); if (!parentFile) return;
    reconcileSameGenerationWorkerDeliveries(api, getRegistry(), realpathOrResolve(parentFile), runtimeGeneration, context, deliveryAttempts);
  });
  api.on("message_end", (event, context) => {
    const deliveryId = (event.message as any)?.details?.deliveryId;
    if (typeof deliveryId !== "string" || !deliveryId.startsWith("worker-run:")) return;
    const parent = context.sessionManager.getSessionFile(); if (!parent) return;
    try {
      if (markWorkerDeliveryDelivered(getRegistry(), deliveryId, runtimeGeneration, now().toISOString())) deliveryAttempts.delete(deliveryId);
    } catch {}
  });
  api.on("session_shutdown", (_event, context) => {
    activityGeneration += 1;
    if (context.mode === "tui" && context.hasUI && typeof context.ui?.setStatus === "function") context.ui.setStatus(WORKER_ACTIVITY_STATUS_KEY, undefined);
    unsubscribeActivity?.();
    unsubscribeActivity = undefined;
    currentContext = undefined;
    if (deliveryTimer) clearInterval(deliveryTimer); deliveryTimer = undefined;
    if (active.size === 0) { registry?.close(); registry = undefined; }
  });

  api.registerMessageRenderer("worker-run", (message, _options, theme) => {
    const d = message.details as any; const recovery = d?.event === "worker_recovery_required"; const outcome = recovery ? "recovery required" : String(d?.outcome ?? "completed").replaceAll("_", " "); const role = d?.role ?? "work";
    const counts = recovery ? String(d?.status ?? "running") : `${Number(d?.repositoryCount ?? 0)} repos · ${Number(d?.artifactCount ?? 0)} artifacts`;
    return new Text(theme.fg(recovery || d?.outcome === "failed" ? "error" : d?.outcome === "cancelled" ? "warning" : "success", `${outcome} · ${role} · ${String(d?.workerId ?? "worker").slice(-8)} · ${counts}`), 0, 0);
  });

  const workerRunTool = defineTool({
    name: "worker_run", label: "Run Workers",
    description: "Start durable work, review, or integration workers, or resume previous workers. The `runs` list can launch or resume up to eight workers in one call. Each new worker receives its role-specific inputs, private workspace, retained session, and allowed Beads tasks; resumed workers preserve their exact role, workspace, session, and model selection. Runs execute asynchronously and deliver structured results when they settle.",
    promptSnippet: "Start work, review, or integration workers, or resume previous workers.",
    promptGuidelines: [
      "Use `start` with role `work` for substantial self-contained assignments or substantial independent work that benefits from parallel execution; handle quick, tightly sequential, or parent-context-heavy work directly. Follow every completed work or integration run with a `review` start before relying on its output. Use an `integration` start after `worker_merge_test` reports conflicts when delegating resolution is preferable to resolving them yourself. Use `resume` for answers, corrections, or follow-up on the same worker, and start a replacement only after intentionally abandoning the previous worker. Batch only independent runs.",
      inputJsonSchemaGuideline("worker_run", WorkerRunParamsV2), outputJsonSchemaGuideline("worker_run", RetainedToolOutputSchemas.worker_run),
      "The parent remains sole authority for grounding, semantic acceptance, merge testing, validation, application, publication, Beads closure, and discard.",
      "worker_run constraints: Only result content is provider-visible; details remain internal."
    ],
    parameters: WorkerRunParamsV2, executionMode: "sequential" as const,
    renderCall: (args: unknown, theme: any, context: any) => compactCall(theme, runCallLabel(args), workerRunCallOperationHint(args, renderArgumentsComplete(context))),
    renderResult: (result: AgentToolResult<any>, _options: unknown, theme: any, context: any) => {
      const details = safeResultDetails(result);
      return compactResult(theme, result, "worker run", workerRunResultOperationHint(details, matchingWorkerRunSnapshot(details, operationSnapshot(safeToolCallId(context)))));
    },
    execute: async (toolCallId: string, params: WorkerRunInputV2, signal: AbortSignal, onUpdate: any, context: ExtensionContext): Promise<AgentToolResult<any>> => {
      clearOperationSnapshot(toolCallId);
      throwIfAborted(signal);
      const parentSessionFile = requireParentSession(context);
      const planned = preflightBatch(params, context, parentSessionFile);
      const operation = plannedRunOperation(planned);
      const timestamp = now().toISOString();
      try {
        for (const plan of planned) if (plan.role === "integration" && plan.consumedPrepared && plan.preparedId) assertIntegrationTargetsCurrent(trustedPreparedSet(getRegistry(), parentSessionFile, plan.preparedId));
        const items: WorkerBatchCreateItem[] = planned.map((plan) => {
          const session = plan.runRuntime.pendingWorkSessionId ? undefined : sessionIdentity(plan.paths);
          const hostLogDir = path.join(path.resolve(context.cwd), ".pi", "async-shell", "jobs", plan.jobId);
          const run: WorkerRunRecord = { runId: plan.runId, workerId: plan.workerId, status: "queued", taskIds: plan.taskIds, modelSelection: plan.modelSelection,
            completionDelivery: plan.request.completionDelivery ?? "steer", ...(plan.binding ? { binding: plan.binding } : {}), jobId: plan.jobId,
            stdoutLog: path.join(hostLogDir, "stdout.log"), stderrLog: path.join(hostLogDir, "stderr.log"), ...(session ? { sessionStartLine: countLines(session.sessionFile) + 1 } : {}),
            repositories: [], artifacts: [], errors: [], runtime: plan.runRuntime, createdAt: timestamp };
          if (plan.newWorker) return { kind: "new", worker: { workerId: plan.workerId, parentSessionFile, role: plan.role, status: "queued", activeRunId: plan.runId,
            taskIds: plan.taskIds, modelSelection: plan.modelSelection, ...(session ? { sessionId: session.sessionId, sessionFile: session.sessionFile } : {}),
            workspaceRoot: plan.paths.workspaceRoot, runtime: plan.workerRuntime, createdAt: timestamp, updatedAt: timestamp }, run };
          return { kind: "resume", workerId: plan.workerId, expectedVersion: plan.expectedVersion!, taskIds: plan.taskIds, runtime: plan.workerRuntime, run };
        });
        createWorkerRunBatch(getRegistry(), {
          items,
          reviewLeases: planned.filter((plan) => plan.role === "review").map((plan) => ({ subjectWorkerId: (plan.binding as any).reviewedWorkerId as string, reviewerWorkerId: plan.workerId, reviewedRunId: plan.reviewedRunId! })),
          consumedPrepared: planned.filter((plan) => plan.consumedPrepared).map((plan) => ({ preparedId: plan.preparedId!, parentSessionFile })),
          now: timestamp
        });
      } catch (error) { rollbackPlans(planned, parentSessionFile); throw error; }
      for (const plan of planned) pending.set(plan.runId, { workerId: plan.workerId, runId: plan.runId, parentSessionFile, parentSessionId: context.sessionManager.getSessionId(), runtime: plan.runRuntime });
      const details = { runs: planned.map((plan) => ({ action: plan.request.action, role: plan.role, workerId: plan.workerId, runId: plan.runId, status: "queued", taskIds: plan.taskIds,
        completionDelivery: plan.request.completionDelivery ?? "steer", modelSelection: plan.modelSelection, ...(plan.reviewedRunId ? { reviewedRunId: plan.reviewedRunId } : {}), ...(plan.preparedId ? { preparedId: plan.preparedId } : {}) })) };
      const text = details.runs.map((item) => `queued · ${item.role} · ${item.workerId.slice(-8)}`).join("\n");
      const firstRun = details.runs[0];
      rememberOperationSnapshot(toolCallId, firstRun && operation ? { scope: "worker_run", runId: firstRun.runId, operation } : undefined);
      onUpdate?.(resultText(text, details)); return resultText(text, details);
    }
  });
  api.registerTool(workerRunTool as any);

  const workerControlTool = defineTool({
    name: "worker_control", label: "Manage Workers",
    description: "List and manage durable workers owned by the current parent session. Use `list` for compact worker discovery, `runs` to list one worker’s execution history, and `get` to inspect one exact active or settled run, including logs, session and workspace access, and submitted repository or artifact outputs. Use `cancel` to stop active work while preserving retained state. Use `discard` to permanently delete an idle worker and all retained state.",
    promptSnippet: "List workers and their runs, inspect exact run outputs, cancel active work, or permanently discard idle workers.",
    promptGuidelines: [
      "Do not poll workers; rely on asynchronous completion notifications. Use `get` with the supplied `workerId` and `runId` when exact run evidence is needed for review, merge testing, a resume decision, or diagnosis. Use `list` to discover or recover workers and `runs` only to locate previous runs. Use `cancel` only to stop active work, and `discard` only when no further review, resume, merge, or recovery access is needed.",
      inputJsonSchemaGuideline("worker_control", WorkerControlParamsV2), outputJsonSchemaGuideline("worker_control", RetainedToolOutputSchemas.worker_control),
      "worker_control constraints: Only result content is provider-visible; details remain internal."
    ],
    parameters: WorkerControlParamsV2, executionMode: "sequential" as const,
    renderCall: (args: unknown, theme: any) => compactCall(theme, workerControlCallLabel(args)),
    renderResult: (result: AgentToolResult<any>, _options: unknown, theme: any) => compactResult(theme, result, "worker control"),
    execute: async (_callId: string, params: WorkerControlInputV2, signal: AbortSignal, _update: any, context: ExtensionContext): Promise<AgentToolResult<any>> => {
      throwIfAborted(signal); return control(params, context);
    }
  });
  api.registerTool(workerControlTool as any);

  api.registerTool(defineTool({
    name: "worker_merge_test", label: "Test Repository Merges",
    description: "Test one or more local Git repository candidates against explicit target branches without modifying them. The tool revalidates candidate and target identity, constructs the requested merges or squashes in disposable views, detects ordinary Git conflicts, and returns exact prepared results for validation or integration. This tool does not run project tests or promote target refs.",
    promptSnippet: "Test repository candidates against target branches and prepare exact disposable merge results without promotion.",
    promptGuidelines: [inputJsonSchemaGuideline("worker_merge_test", WorkerMergeTestParams), outputJsonSchemaGuideline("worker_merge_test", RetainedToolOutputSchemas.worker_merge_test), "worker_merge_test use: Prepare exact merges, validate every prepared view separately, and apply only through an explicit worker_merge_apply call.", "worker_merge_test constraints: Only result content is provider-visible; details remain internal."],
    parameters: WorkerMergeTestParams, executionMode: "sequential",
    renderCall: (args, theme, context) => compactCall(theme, "testing merge", mergeCallOperationHint(args, renderArgumentsComplete(context))), renderResult: (result, _options, theme) => compactResult(theme, result as any, "merge test", mergeResultOperationHint(safeResultDetails(result))),
    async execute(_id, params, signal, _update, context) {
      throwIfAborted(signal); const parent = requireParentSession(context);
      const resolved = params.repositories.map((request) => ({ ...request, candidateRef: request.candidateRef ?? "HEAD" }));
      const set = prepareWorkerMerges(parent, resolved, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, sourceForCandidate: managedCandidateWarnings(parent) });
      storePreparedSet(getRegistry(), { preparedId: set.preparedId, parentSessionFile: parent, status: set.status, order: set.order, repositories: set.repositories, createdAt: set.createdAt });
      cleanupSupersededPreparedSets(set);
      const visible = publicPreparedSet(set);
      return resultText(`${set.status === "ready" ? "ready" : "resolution required"} · ${set.repositories.length} repositories`, visible);
    }
  }));
  api.registerTool(defineTool({
    name: "worker_merge_apply", label: "Apply Prepared Repository Merges",
    description: "Apply every repository in one ready and validated prepared set. A prepared set contains one to sixteen repositories that must move together. Before changing any target, the tool verifies the stored prepared results and preflights every repository. It then applies each exact prepared commit in dependency order. Applying multiple repositories is not atomic: if a later update fails, earlier updates remain applied and are reported. The tool does not resolve conflicts, run tests, push, publish, or close tasks.",
    promptSnippet: "Apply every exact repository result in one parent-validated prepared set.",
    promptGuidelines: [inputJsonSchemaGuideline("worker_merge_apply", WorkerMergeApplyParams), outputJsonSchemaGuideline("worker_merge_apply", RetainedToolOutputSchemas.worker_merge_apply), "worker_merge_apply use: Inspect diffs and run checks from every preparedPath before application. On validation failure, create a new prepared set. After partial or failed application, retry only the same preparedId; target drift requires a new worker_merge_test. Push and release remain separate parent actions.", "worker_merge_apply constraints: Only result content is provider-visible; details remain internal."],
    parameters: WorkerMergeApplyParams, executionMode: "sequential",
    renderCall: (args, theme, context) => compactCall(theme, "applying merge", preparedCallOperationHintFromArgs(args, renderArgumentsComplete(context))), renderResult: (result, _options, theme, context) => {
      const details = safeResultDetails(result);
      return compactResult(theme, result as any, "merge apply", mergeApplyResultOperationHint(details, operationSnapshot(safeToolCallId(context))));
    },
    async execute(toolCallId, params, signal, _update, context) {
      clearOperationSnapshot(toolCallId);
      throwIfAborted(signal); const parent = requireParentSession(context); const trustedSet = trustedPreparedSet(getRegistry(), parent, params.preparedId); if (!["ready", "partial", "failed"].includes(trustedSet.status)) throw new Error(`Prepared set ${params.preparedId} is not ready.`);
      const operation = mergeOperation(trustedSet.repositories);
      const nonce = claimNonce(); if (!claimPreparedSetApply(getRegistry(), params.preparedId, parent, nonce, now().toISOString())) throw new Error(`Prepared set ${params.preparedId} is already being applied or changed state.`);
      try { const result = applyPreparedWorkerMerges(parent, params.preparedId, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, sourceForCandidate: managedCandidateWarnings(parent), trustedSet }); finishPreparedSetApply(getRegistry(), params.preparedId, parent, nonce, result.status, now().toISOString()); rememberOperationSnapshot(toolCallId, operation ? { scope: "worker_merge_apply", preparedId: result.preparedId, operation } : undefined); return resultText(`${result.status} · ${result.repositories.filter((item) => item.status === "applied").length} applied`, result); }
      catch (error) { releasePreparedSetApply(getRegistry(), params.preparedId, parent, nonce, now().toISOString()); throw error; }
    }
  }));

  registerCommands();

  async function createOverlaySafely(input: Parameters<typeof createReviewOverlayAsync>[0]): Promise<ReviewOverlayRecord> {
    try { return await createOverlay(input); }
    catch (error) { rmSync(input.contextFile, { force: true }); throw error; }
  }

  function cleanupSupersededPreparedSets(current: ReturnType<typeof prepareWorkerMerges>): void {
    const root = path.resolve(overrides.preparedRoot ?? defaultPreparedMergeRoot()); const currentTargets = current.repositories.map((item) => `${item.targetRepo}\0${item.targetRef}`).sort().join("\n");
    const rows = getRegistry().database.prepare("SELECT prepared_id FROM prepared_sets WHERE parent_session_file=? AND prepared_id<>? AND status IN ('ready','resolution_required','partial','failed')").all(current.parentSessionFile, current.preparedId) as Array<{ prepared_id: string }>;
    for (const row of rows) {
      try { const prior = readPreparedSetRecord(getRegistry(), current.parentSessionFile, row.prepared_id); const targets = prior.repositories.map((item) => `${item.targetRepo}\0${item.targetRef}`).sort().join("\n"); if (targets !== currentTargets) continue; updatePreparedSetStatus(getRegistry(), row.prepared_id, current.parentSessionFile, "superseded", now().toISOString()); rmSync(path.join(root, row.prepared_id), { recursive: true, force: true }); } catch {}
    }
  }

  function preflightBatch(params: WorkerRunInputV2, context: ExtensionContext, parentSessionFile: string): PlannedRun[] {
    const plans: PlannedRun[] = []; const resumed = new Set<string>();
    try {
      for (const request of params.runs) {
        validateRunRequestBounds(request);
        if (request.action === "resume") {
          if (resumed.has(request.workerId)) throw new Error(`Worker ${request.workerId} cannot be resumed twice in one batch.`); resumed.add(request.workerId);
          const worker = ownedWorker(request.workerId, parentSessionFile); if (worker.status !== "idle" || worker.operationKind) throw new Error(`Worker ${worker.workerId} is not idle.`);
          if (worker.reviewedByWorkerId) throw new Error(`Worker ${worker.workerId} is leased to active reviewer ${worker.reviewedByWorkerId}.`);
          if (worker.role === "review" && request.additionalTaskIds?.length) throw new Error("Review workers cannot receive additional Beads tasks.");
          if (!worker.sessionId || !worker.sessionFile) {
            if (worker.role !== "work") throw new Error(`Worker ${worker.workerId} has no retained session.`);
          } else verifyRetainedSession(worker);
          const latest = worker.latestRunId ? getWorkerRun(getRegistry(), worker.workerId, worker.latestRunId) : undefined;
          const binding = latest?.binding; const paths = workerPaths(roots, worker.workerId); provisionWorkerPaths(paths);
          const role = worker.role; const inputs = validateAdditionalInputs({ values: request.additionalInputs, existing: runtimeInputs(worker), role, workspaceRoot: paths.workspaceRoot, runtimeRoot });
          let reviewOverlayPlan: ReviewOverlayPlan | undefined; let contextFile: string | undefined; let reviewedRunId: string | undefined; let preparedId: string | undefined; let operationRepositories: Array<Record<string, unknown>> | undefined; const pendingWorkSessionId = !worker.sessionId && role === "work" ? randomUUID() : undefined; const reservedRunId = role === "review" ? createWorkerRunId(now(), random()) : undefined;
          const mounts = inputMounts(inputs);
          if (role === "review") {
            if (!binding || !("reviewedRunId" in binding)) throw new Error(`Review worker ${worker.workerId} lost its reviewed-run binding.`);
            const subject = reviewSubject(binding.reviewedRunId, parentSessionFile, worker.workerId); reviewedRunId = binding.reviewedRunId;
            contextFile = writeReviewContext(paths, request.workerId, reservedRunId!, subject.worker, subject.run, inputs);
            reviewOverlayPlan = { workerId: worker.workerId, runId: reservedRunId!, subjectWorkspace: subject.worker.workspaceRoot, reviewerWorkspace: paths.workspaceRoot, contextFile, reviewedSessionFile: subject.worker.sessionFile!, additionalInputs: inputs.map((item) => ({ source: item.source, target: item.target })) };
          } else if (role === "integration") {
            if (!binding || !("preparedId" in binding)) throw new Error(`Integration worker ${worker.workerId} lost its prepared-set binding.`); preparedId = binding.preparedId;
            const trustedSet = trustedPreparedSet(getRegistry(), parentSessionFile, preparedId, paths.workspaceRoot); operationRepositories = snapshotOperationRepositories(trustedSet.repositories);
            contextFile = writeIntegrationContext(paths, trustedSet, inputs, true); mounts.push({ kind: "bind", source: paths.workspaceRoot, target: "/workspace" }, { kind: "bind", source: contextFile, target: "/integration/context.json", readOnly: true });
          }
          const retained = retainedWorkerRuntime(worker);
          if (pendingWorkSessionId) retained.cacheLineage = prepareWorkerCacheLineage({ stateRoot: roots.stateRoot, workerStateDir: paths.stateDir, parentSessionFile, parentSessionId: context.sessionManager.getSessionId(), route: parseWorkerModelSelection(worker.modelSelection!), now: now() });
          const plan = finishPlanSafely({ request, role, workerId: worker.workerId, ...(reservedRunId ? { runId: reservedRunId } : {}), paths, taskIds: unique([...worker.taskIds, ...(request.additionalTaskIds ?? [])]), modelSelection: worker.modelSelection!, binding, workerRuntime: { version: 2, inputs, ...retained }, newWorker: false, expectedVersion: worker.version, reviewOverlayPlan, contextFile, reviewedRunId, preparedId, operationRepositories, pendingWorkSessionId, mounts, parentSessionFile, context });
          plans.push(plan); continue;
        }
        const role = request.role;
        const modelSelection = resolveModel(role, role === "work" ? request.modelSelection : undefined, context);
        const workerId = createWorkerId(now(), random()); const paths = workerPaths(roots, workerId); const reservedRunId = role === "review" ? createWorkerRunId(now(), random()) : undefined;
        const taskIds = role === "review" ? [] : unique(request.taskIds);
        let subject: ReturnType<typeof reviewSubject> | undefined;
        let repositoryBaselines: Array<{ path: string; resolvedCommit: string }> | undefined;
        let cacheLineage: WorkerCacheLineageRecord | undefined;
        let integrationSet: ReturnType<typeof readPreparedMergeSet> | undefined;
        let inputs: RetainedInput[] = [];
        if (role === "work") repositoryBaselines = (request.repositoryBaselines ?? []).map((item) => { const repo = canonicalRepository(item.path); return { path: repo, resolvedCommit: trustedGit(repo, ["rev-parse", `${item.revision ?? "HEAD"}^{commit}`]).trim() }; });
        else if (role === "review") { subject = reviewSubject(request.reviewedRunId, parentSessionFile); inputs = validateAdditionalInputs({ values: request.additionalInputs, role, workspaceRoot: paths.workspaceRoot, runtimeRoot }); }
        else { integrationSet = trustedPreparedSet(getRegistry(), parentSessionFile, request.preparedId); inputs = validateAdditionalInputs({ values: request.additionalInputs, role, workspaceRoot: paths.workspaceRoot, runtimeRoot }); }
        provisionWorkerPaths(paths);
        try { if (role === "work") cacheLineage = prepareWorkerCacheLineage({ stateRoot: roots.stateRoot, workerStateDir: paths.stateDir, parentSessionFile, parentSessionId: context.sessionManager.getSessionId(), route: parseWorkerModelSelection(modelSelection), now: now() }); }
        catch (error) { rmSync(paths.stateDir, { recursive: true, force: true }); throw error; }
        let binding: WorkerRunRecord["binding"]; let reviewedRunId: string | undefined; let preparedId: string | undefined; let consumedPrepared = false;
        let reviewOverlayPlan: ReviewOverlayPlan | undefined; let contextFile: string | undefined; let mounts: any[] = [];
        try {
          const pendingWorkSessionId = role === "work" ? randomUUID() : undefined;
          if (role === "review") {
            reviewedRunId = request.reviewedRunId; binding = { reviewedWorkerId: subject!.worker.workerId, reviewedRunId };
            createWorkerSession({ workspaceRoot: paths.workspaceRoot, sessionDir: paths.sessionDir, sessionId: randomUUID() });
            contextFile = writeReviewContext(paths, workerId, reservedRunId!, subject!.worker, subject!.run, inputs);
            reviewOverlayPlan = { workerId, runId: reservedRunId!, subjectWorkspace: subject!.worker.workspaceRoot, reviewerWorkspace: paths.workspaceRoot, contextFile, reviewedSessionFile: subject!.worker.sessionFile!, additionalInputs: inputs.map((item) => ({ source: item.source, target: item.target })) };
          } else if (role === "integration") {
            preparedId = request.preparedId; const trustedSet = integrationSet!; const moved = consumePreparedMergeSet(parentSessionFile, preparedId, workerId, paths.workspaceRoot, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, trustedSet }); consumedPrepared = true; binding = { preparedId };
            createWorkerSession({ workspaceRoot: paths.workspaceRoot, sessionDir: paths.sessionDir, sessionId: randomUUID() });
            contextFile = writeIntegrationContext(paths, moved, inputs, false); mounts = [...inputMounts(inputs), { kind: "bind", source: paths.workspaceRoot, target: "/workspace" }, { kind: "bind", source: contextFile, target: "/integration/context.json", readOnly: true }];
          }
          const plan = finishPlan({ request, role, workerId, ...(reservedRunId ? { runId: reservedRunId } : {}), paths, taskIds: role === "review" ? subject!.run.taskIds : taskIds, modelSelection, binding,
            workerRuntime: { version: 2, inputs, ...(repositoryBaselines ? { repositoryBaselines } : {}), ...(cacheLineage ? { cacheLineage } : {}) }, newWorker: true, reviewOverlayPlan, contextFile, reviewedRunId, preparedId, consumedPrepared, operationRepositories: snapshotOperationRepositories(integrationSet?.repositories), pendingWorkSessionId, mounts, parentSessionFile, context });
          plans.push(plan);
        } catch (error) {
          if (consumedPrepared && preparedId) { try { restoreConsumedPreparedMergeSet(parentSessionFile, preparedId, paths.workspaceRoot, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, trustedSet: trustedPreparedSet(getRegistry(), parentSessionFile, preparedId) }); } catch {} }
          rmSync(paths.stateDir, { recursive: true, force: true });
          throw error;
        }
      }
      return plans;
    } catch (error) { rollbackPlans(plans, parentSessionFile); throw error; }
  }

  function finishPlanSafely(input: Omit<PlannedRun, "runId" | "jobId" | "runRuntime"> & { runId?: string; reviewOverlayPlan?: ReviewOverlayPlan; contextFile?: string; pendingWorkSessionId?: string; mounts: any[]; parentSessionFile: string; context: ExtensionContext }): PlannedRun {
    try { return finishPlan(input); } catch (error) {
      if (input.consumedPrepared && input.preparedId) { try { restoreConsumedPreparedMergeSet(input.parentSessionFile, input.preparedId, input.paths.workspaceRoot, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, trustedSet: trustedPreparedSet(getRegistry(), input.parentSessionFile, input.preparedId) }); } catch {} }
      if (input.newWorker) rmSync(input.paths.stateDir, { recursive: true, force: true }); else if (input.contextFile) rmSync(input.contextFile, { force: true });
      throw error;
    }
  }

  function finishPlan(input: Omit<PlannedRun, "runId" | "jobId" | "runRuntime"> & { runId?: string; reviewOverlayPlan?: ReviewOverlayPlan; contextFile?: string; pendingWorkSessionId?: string; mounts: any[]; parentSessionFile: string; context: ExtensionContext }): PlannedRun {
    const runId = input.runId ?? createWorkerRunId(now(), random()); const jobId = createAsyncJobId(now(), random());
    const runDir = path.join(input.paths.stateDir, "runs", runId); mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const nonce = randomUUID();
    const codeRoot = overrides.codeRoot ?? (testLaunch ? input.context.cwd : path.join(homedir(), "Code"));
    const reference = planWorkerContainer({ workerId: input.workerId, runId, nonce, workspaceRoot: input.paths.workspaceRoot, codeRoot, mounts: input.mounts });
    const roleInstructions = roleInstructionsFor(input.role);
    const request = input.request;
    const previousRun = !input.newWorker ? getWorkerRun(getRegistry(), input.workerId, getWorker(getRegistry(), input.workerId)?.latestRunId ?? "") : undefined;
    const interruptedPreviously = previousRun?.outcome === "cancelled" || (previousRun?.outcome === "failed" && previousRun.outcomeSource === "system");
    const interruptionWarnings = interruptedPreviously ? inspectInterruptedGitState(input.paths.workspaceRoot) : [];
    const prompt = renderWorkerRuntimePrompt(input.role, { workerId: input.workerId, runId, workspaceRoot: input.role === "review" || input.role === "integration" ? "/workspace" : input.paths.workspaceRoot,
      codeRoot, taskIds: input.taskIds, roleInstructions,
      instructions: request.instructions, repositoryBaselines: input.workerRuntime.repositoryBaselines, additionalInputs: contextInputs(input.workerRuntime.inputs),
      reviewSubjectPath: "/review/subject", reviewContextPath: "/review/context.json", integrationContextPath: "/integration/context.json", resumed: !input.newWorker,
      cacheLineageMarker: input.workerRuntime.cacheLineage?.mode === "eligible" ? input.workerRuntime.cacheLineage.marker : undefined, initialSession: Boolean(input.pendingWorkSessionId),
      cancelledPreviously: interruptedPreviously, interruptionWarnings });
    const runRuntime: RunRuntime = { version: 2, prompt, runDir, resultFile: path.join(runDir, "result.json"), settledFile: path.join(runDir, "settled.json"), processFile: path.join(runDir, "host-process.json"), processNonce: nonce,
      container: reference, ...(input.reviewOverlayPlan ? { reviewOverlayPlan: input.reviewOverlayPlan } : {}), ...(input.contextFile ? { contextFile: input.contextFile } : {}), inputs: input.workerRuntime.inputs,
      repositoryBefore: snapshotWorkerRepositories(input.paths.workspaceRoot), ...(input.pendingWorkSessionId ? { pendingWorkSessionId: input.pendingWorkSessionId } : {}), ...(interruptionWarnings.length ? { interruptionWarnings } : {}) };
    return { request, role: input.role, workerId: input.workerId, runId, jobId, paths: input.paths, taskIds: input.taskIds, modelSelection: input.modelSelection, ...(input.binding ? { binding: input.binding } : {}), workerRuntime: input.workerRuntime, runRuntime,
      newWorker: input.newWorker, ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }), ...(input.reviewedRunId ? { reviewedRunId: input.reviewedRunId } : {}), ...(input.preparedId ? { preparedId: input.preparedId } : {}), ...(input.consumedPrepared ? { consumedPrepared: true } : {}), ...(input.operationRepositories ? { operationRepositories: input.operationRepositories } : {}) };
  }

  function rollbackPlans(plans: PlannedRun[], parentSessionFile: string): void {
    for (const plan of [...plans].reverse()) {
      if (plan.consumedPrepared && plan.preparedId) { try { restoreConsumedPreparedMergeSet(parentSessionFile, plan.preparedId, plan.paths.workspaceRoot, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, trustedSet: trustedPreparedSet(getRegistry(), parentSessionFile, plan.preparedId) }); } catch {} }
      if (plan.newWorker) rmSync(plan.paths.stateDir, { recursive: true, force: true });
      else { rmSync(plan.runRuntime.runDir, { recursive: true, force: true }); if (plan.runRuntime.contextFile) rmSync(plan.runRuntime.contextFile, { force: true }); }
    }
  }

  function beginPreparedRun(context: ExtensionContext, item: PendingRun): void {
    if (starting.get(item.workerId)?.runId === item.runId) return;
    // Calling an async function executes synchronously until its first await. Put the
    // whole launch path behind a microtask so turn_end/session_start never perform
    // the session fork, OverlayFS setup, Docker work, or host launch inline.
    const completion = Promise.resolve().then(() => startPreparedRun(context, item));
    starting.set(item.workerId, { runId: item.runId, completion });
    void completion.finally(() => { if (starting.get(item.workerId)?.runId === item.runId) starting.delete(item.workerId); });
  }

  async function startPreparedRun(context: ExtensionContext, item: PendingRun): Promise<void> {
    const nonce = claimNonce(); if (!claimWorkerRun(getRegistry(), item.workerId, item.runId, "launch", nonce, ["queued"])) return;
    let handle: ManagedAsyncJobHandle | undefined; let launchAdmission: string | undefined;
    try {
      let worker = getWorker(getRegistry(), item.workerId)!; const run = getWorkerRun(getRegistry(), item.workerId, item.runId)!; const paths = workerPaths(roots, item.workerId);
      if ((!worker.sessionId || !worker.sessionFile) && worker.role === "work" && item.runtime.pendingWorkSessionId) {
        const forked = forkWorkerSession({ parentSessionFile: worker.parentSessionFile, workspaceRoot: worker.workspaceRoot, sessionDir: paths.sessionDir, sessionId: item.runtime.pendingWorkSessionId });
        assertRunClaim(item.workerId, item.runId, "launch", nonce);
        updateWorkerRuntimeMetadata(getRegistry(), worker.workerId, { sessionId: forked.sessionId, sessionFile: forked.sessionFile, updatedAt: now().toISOString() });
        worker = getWorker(getRegistry(), item.workerId)!;
      }
      const sessionId = worker.sessionId; const sessionFile = worker.sessionFile;
      if (!sessionId || !sessionFile) throw new Error(`Worker ${worker.workerId} session provisioning failed.`);
      if (worker.role === "work") verifyWorkerSession({ sessionFile, sessionId, workspaceRoot: worker.workspaceRoot, parentSessionFile: worker.parentSessionFile });
      const sessionStartLine = countLines(sessionFile) + 1;
      const record: WorkerLaunchRecord = { workerId: worker.workerId, runId: run.runId, jobId: run.jobId!, sessionId, sessionFile, workspaceRoot: worker.workspaceRoot, taskIds: run.taskIds, role: worker.role, modelSelection: worker.modelSelection!, ...(worker.runtime?.cacheLineage ? { cacheLineage: worker.runtime.cacheLineage as WorkerCacheLineageRecord } : {}) };
      assertRunClaim(item.workerId, item.runId, "launch", nonce);
      if (item.runtime.reviewOverlayPlan) {
        item.runtime.overlay = await createOverlaySafely({ dockerPath: docker(), ...item.runtime.reviewOverlayPlan });
        item.runtime.container = planWorkerContainer({ workerId: worker.workerId, runId: run.runId, nonce: item.runtime.processNonce, workspaceRoot: worker.workspaceRoot, codeRoot: item.runtime.container.codeRoot, mounts: item.runtime.overlay.mounts });
        assertRunClaim(item.workerId, item.runId, "launch", nonce);
      }
      item.runtime.container = await createContainer(docker(), item.runtime.container);
      launchAdmission = path.join(item.runtime.runDir, "launch-admitting.json"); writeFileSync(launchAdmission, `${JSON.stringify({ version: 2, workerId: item.workerId, runId: item.runId, pid: process.pid, processStartToken: asyncJobProcessStartToken(process.pid), startedAt: now().toISOString() })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      assertRunClaim(item.workerId, item.runId, "launch", nonce);
      handle = launch(context, record, item.runtime); await verifyHostIdentity(item.runtime, item.workerId, item.runId); assertRunClaim(item.workerId, item.runId, "launch", nonce); const snapshot = handle.snapshot();
      finalizeWorkerRunLaunch(getRegistry(), { workerId: worker.workerId, runId: run.runId, claimNonce: nonce, modelSelection: worker.modelSelection!, sessionId, sessionFile, sessionStartLine, jobId: snapshot.jobId,
        stdoutLog: snapshot.stdoutLog, stderrLog: snapshot.stderrLog, runtime: item.runtime, startedAt: now().toISOString() });
      active.set(worker.workerId, { runId: run.runId, handle }); rmSync(launchAdmission, { force: true }); launchAdmission = undefined;
      void handle.completion.then((job) => settleCompletedRun(worker.workerId, run.runId, job)).catch((error) => recordRecovery(worker.workerId, run.runId, error)).finally(() => { if (active.get(worker.workerId)?.runId === run.runId) active.delete(worker.workerId); });
    } catch (error) {
      if (handle) {
        try { handle.cancel("SIGTERM"); } catch {}
        const terminal = await Promise.race([handle.completion.then((job) => job.status !== "running" && job.status !== "unknown"), delay(5_000).then(() => false)]);
        if (!terminal && launchAdmission) { const marker = launchAdmission; void handle.completion.finally(() => rmSync(marker, { force: true })); launchAdmission = undefined; }
      }
      if (launchAdmission) rmSync(launchAdmission, { force: true });
      const claimed = getWorkerRun(getRegistry(), item.workerId, item.runId);
      if (claimed?.claimKind !== "launch" || claimed.claimNonce !== nonce) { try { await removeContainer(docker(), item.runtime.container); } catch {} if (item.runtime.overlay) { try { await cleanupOverlay(docker(), item.runtime.overlay); } catch {} } }
      await failClaimedRun(item.workerId, item.runId, "launch", nonce, error);
    }
  }

  async function waitForWorkerHostIdentity(runtime: RunRuntime, workerId: string, runId: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (existsSync(runtime.processFile)) { const record = readWorkerHostProcess(runtime.processFile); if (record.workerId !== workerId || record.runId !== runId || record.nonce !== runtime.processNonce || !isAsyncJobProcessIdentityAlive(record)) throw new Error("Worker host process identity was invalid during launch."); return; }
      await delay(25);
    }
    throw new Error(`Worker ${workerId}/${runId} did not publish its host process identity.`);
  }

  function assertRunClaim(workerId: string, runId: string, kind: "launch" | "settlement" | "cancellation", nonce: string): void { const run = getWorkerRun(getRegistry(), workerId, runId); if (run?.claimKind !== kind || run.claimNonce !== nonce) throw new Error(`Worker ${workerId}/${runId} ${kind} authority was revoked.`); }

  async function settleCompletedRun(workerId: string, runId: string, job: Pick<JobMeta, "status" | "exitCode" | "error">): Promise<void> {
    const nonce = claimNonce(); if (!claimWorkerRun(getRegistry(), workerId, runId, "settlement", nonce, ["running"])) return;
    const worker = getWorker(getRegistry(), workerId)!; const run = getWorkerRun(getRegistry(), workerId, runId)!; const runtime = run.runtime as RunRuntime;
    let outcome: any = "failed"; let outcomeSource: "worker" | "system" = "system"; let summary = "Worker run failed before accepting a result."; let question: string | undefined;
    let reported: string[] = []; let artifacts: string[] = []; const errors: Array<{ scope: "run" | "repositories" | "artifacts"; message: string }> = [];
    try {
      if (job.status === "exited" && job.exitCode === 0) {
        const settled = readWorkerHostSettlement(runtime.settledFile); if (settled.workerId !== workerId || settled.runId !== runId || settled.sessionId !== worker.sessionId || path.resolve(settled.resultFile) !== path.resolve(runtime.resultFile)) throw new Error("Worker host settlement identity mismatch.");
        const accepted = readWorkerRuntimeResult(runtime.resultFile); if (accepted.workerId !== workerId || accepted.runId !== runId) throw new Error("Worker result identity mismatch.");
        outcome = accepted.result.outcome; outcomeSource = "worker"; summary = accepted.result.summary; question = accepted.result.question; reported = accepted.result.repositories ?? []; artifacts = accepted.result.artifacts ?? [];
      } else errors.push({ scope: "run", message: sanitizeError(job.error ?? `Worker host exited with status ${job.status}${job.exitCode === undefined ? "" : ` (${job.exitCode})`}.`) });
      await removeContainer(docker(), runtime.container);
      if (runtime.overlay) await cleanupOverlay(docker(), runtime.overlay);
      const inventory = inventoryWorkerRepositories({ workspaceRoot: worker.workspaceRoot, workerId, runId, reported, before: runtime.repositoryBefore });
      errors.push(...inventory.errors.map((message) => ({ scope: "repositories" as const, message: sanitizeError(message) })));
      finalizeClaimedWorkerRun(getRegistry(), { parentSessionFile: worker.parentSessionFile, workerId, runId, claimKind: "settlement", claimNonce: nonce, outcome, outcomeSource, summary: summary.slice(0, 2048), ...(question ? { question } : {}), repositories: inventory.repositories, artifacts, errors, sessionEndLine: worker.sessionFile ? countLines(worker.sessionFile) : undefined, settledAt: now().toISOString() });
      if (currentContext?.sessionManager.getSessionFile() && realpathOrResolve(currentContext.sessionManager.getSessionFile()!) === worker.parentSessionFile) deliverPendingCompletions(api, getRegistry(), worker.parentSessionFile, runtimeGeneration, deliveryAttempts);
    } catch (error) {
      const message = sanitizeError(error);
      const attempts = recordWorkerSettlementRecovery(getRegistry(), { workerId, runId, claimNonce: nonce, error: message, now: now().toISOString() });
      let accepted: ReturnType<typeof readWorkerRuntimeResult> | undefined;
      try { if (existsSync(runtime.resultFile)) accepted = readWorkerRuntimeResult(runtime.resultFile); } catch {}
      if (attempts >= 3) {
        const retained = accepted ? ` Accepted result ${accepted.result.outcome} remains retained at ${runtime.resultFile}.` : ` Settlement evidence remains retained beneath ${runtime.runDir}.`;
        finalizeClaimedWorkerRun(getRegistry(), {
          parentSessionFile: worker.parentSessionFile, workerId, runId, claimKind: "settlement", claimNonce: nonce,
          outcome: "failed", outcomeSource: "system", summary: `Worker result settlement failed after ${attempts} deterministic attempts.`,
          artifacts: accepted?.result.artifacts ?? [], errors: [{ scope: "run", message: `${message}${retained}` }],
          sessionEndLine: worker.sessionFile ? countLines(worker.sessionFile) : undefined, settledAt: now().toISOString()
        });
        if (currentContext?.sessionManager.getSessionFile() && realpathOrResolve(currentContext.sessionManager.getSessionFile()!) === worker.parentSessionFile) deliverPendingCompletions(api, getRegistry(), worker.parentSessionFile, runtimeGeneration, deliveryAttempts);
      } else {
        releaseWorkerRunClaim(getRegistry(), workerId, runId, "settlement", nonce);
        const current = getWorker(getRegistry(), workerId); const currentRun = current && getWorkerRun(getRegistry(), workerId, runId);
        if (current && currentRun) deliverRecovery(current, currentRun, `${message} (settlement attempt ${attempts}/3)`);
      }
    }
  }

  async function failClaimedRun(workerId: string, runId: string, claimKind: "launch" | "settlement", claimNonce: string, error: unknown): Promise<void> {
    const worker = getWorker(getRegistry(), workerId); const run = worker && getWorkerRun(getRegistry(), workerId, runId); if (!worker || !run || run.claimKind !== claimKind || run.claimNonce !== claimNonce) return; const runtime = run.runtime as RunRuntime;
    try { await removeContainer(docker(), runtime.container); if (runtime.overlay) await cleanupOverlay(docker(), runtime.overlay);
      finalizeClaimedWorkerRun(getRegistry(), { parentSessionFile: worker.parentSessionFile, workerId, runId, claimKind, claimNonce, outcome: "failed", outcomeSource: "system", summary: "Worker run failed before accepting a result.", errors: [{ scope: "run", message: sanitizeError(error) }], sessionEndLine: worker.sessionFile ? countLines(worker.sessionFile) : undefined, settledAt: now().toISOString() });
    } catch (cleanupError) { recordRecovery(workerId, runId, cleanupError); }
  }

  async function cancelWorker(worker: WorkerRegistryRecord): Promise<"cancelled" | "not_active"> {
    if (!worker.activeRunId) return "not_active"; const runId = worker.activeRunId;
    const recoveringRun = getWorkerRun(getRegistry(), worker.workerId, runId); const recoveringRuntime = recoveringRun?.runtime as RunRuntime | undefined;
    if (worker.recoveryError && recoveringRun?.status === "running" && recoveringRuntime && existsSync(recoveringRuntime.settledFile) && existsSync(recoveringRuntime.resultFile)) {
      await settleCompletedRun(worker.workerId, runId, { status: "exited", exitCode: 0 });
      const current = getWorker(getRegistry(), worker.workerId); if (!current?.activeRunId) return "not_active";
      throw new Error(`Worker ${worker.workerId}/${runId} has an accepted result whose settlement still requires recovery; cancellation will not discard it.`);
    }
    const nonce = claimNonce();
    if (!claimWorkerCancellation(getRegistry(), worker.workerId, runId, nonce, now().toISOString())) return "not_active";
    pending.delete(runId); const run = getWorkerRun(getRegistry(), worker.workerId, runId)!; const runtime = run.runtime as RunRuntime;
    try {
      const authorizationFile = path.join(runtime.runDir, "host-authorization.json"); rmSync(authorizationFile, { force: true });
      await waitForRuntimeAdmissions(runtime, authorizationFile);
      const launching = starting.get(worker.workerId); if (launching?.runId === runId) await launching.completion;
      const attached = active.get(worker.workerId); if (attached?.runId === runId) { attached.handle.cancel("SIGTERM"); }
      else if (existsSync(runtime.processFile)) { const process = readWorkerHostProcess(runtime.processFile); if (process.workerId !== worker.workerId || process.runId !== runId || process.nonce !== runtime.processNonce) throw new Error("Worker host process identity mismatch during cancellation."); if (isAsyncJobProcessIdentityAlive(process)) signalAsyncJobProcessIdentity(process, "SIGTERM"); }
      await removeContainer(docker(), runtime.container);
      if (attached?.runId === runId) { const terminal = await Promise.race([attached.handle.completion.then((job) => job.status !== "running" && job.status !== "unknown"), delay(5_000).then(() => false)]); if (!terminal) throw new Error("Worker host job did not reach a terminal state during cancellation."); }
      await proveWorkerHostExited(runtime, worker.workerId, runId);
      if (runtime.overlay) await cleanupOverlay(docker(), runtime.overlay);
      await reconcileTerminatedPersistedAsyncShellJobsForOwner(path.join(workerPaths(roots, worker.workerId).stateDir, "async-shell"), { kind: "worker-run", workerId: worker.workerId, runId }, 250);
      const survivors = await waitForWorkerShellRecords(worker.workerId, runId);
      if (survivors.length) throw new Error(`Worker-owned process records remain active after container removal: ${survivors.map((job) => job.jobId).join(", ")}.`);
      finalizeClaimedWorkerRun(getRegistry(), { parentSessionFile: worker.parentSessionFile, workerId: worker.workerId, runId, claimKind: "cancellation", claimNonce: nonce, outcome: "cancelled", outcomeSource: "system", summary: "Worker run was cancelled by its parent.", sessionEndLine: worker.sessionFile ? countLines(worker.sessionFile) : undefined, settledAt: now().toISOString() });
      active.delete(worker.workerId); deliverPendingCompletions(api, getRegistry(), worker.parentSessionFile, runtimeGeneration, deliveryAttempts); return "cancelled";
    } catch (error) { recordRecovery(worker.workerId, runId, error); throw new Error(`Worker ${worker.workerId}/${runId} cancellation requires recovery: ${sanitizeError(error)}`); }
  }

  async function waitForRuntimeAdmissions(runtime: RunRuntime, authorizationFile: string): Promise<void> {
    const files = [workerResultAdmissionPath(runtime.resultFile), workerMutationAdmissionPath(authorizationFile), path.join(runtime.runDir, "launch-admitting.json")];
    for (let attempt = 0; attempt < 480 && files.some(runtimeAdmissionActive); attempt += 1) await delay(25);
    const activeFiles = files.filter(runtimeAdmissionActive); if (activeFiles.length) throw new Error(`Worker runtime mutation admission did not settle after revocation: ${activeFiles.join(", ")}.`);
  }
  function runtimeAdmissionActive(file: string): boolean {
    if (!existsSync(file)) return false; try { const record = JSON.parse(readFileSync(file, "utf8")) as { pid?: number; processStartToken?: string }; if (Number.isSafeInteger(record.pid) && record.pid! > 0 && typeof record.processStartToken === "string") { if (asyncJobProcessStartToken(record.pid!) === record.processStartToken) return true; rmSync(file, { force: true }); return false; } } catch {} return true;
  }

  async function waitForWorkerShellRecords(workerId: string, runId: string): Promise<ReturnType<typeof unsettledPersistedAsyncShellJobsForOwner>> {
    const root = path.join(workerPaths(roots, workerId).stateDir, "async-shell"); const owner = { kind: "worker-run" as const, workerId, runId };
    let jobs = unsettledPersistedAsyncShellJobsForOwner(root, owner).filter((job) => job.status === "running" || job.status === "unknown");
    for (let attempt = 0; attempt < 80 && jobs.length; attempt += 1) { await delay(25); jobs = unsettledPersistedAsyncShellJobsForOwner(root, owner).filter((job) => job.status === "running" || job.status === "unknown"); }
    return jobs;
  }

  async function proveWorkerHostExited(runtime: RunRuntime, workerId: string, runId: string): Promise<void> {
    if (!existsSync(runtime.processFile)) return;
    const processRecord = readWorkerHostProcess(runtime.processFile);
    if (processRecord.workerId !== workerId || processRecord.runId !== runId || processRecord.nonce !== runtime.processNonce) throw new Error("Worker host process identity mismatch during cancellation proof.");
    for (let attempt = 0; attempt < 50 && isAsyncJobProcessIdentityAlive(processRecord); attempt += 1) await delay(100);
    if (isAsyncJobProcessIdentityAlive(processRecord)) { signalAsyncJobProcessIdentity(processRecord, "SIGKILL"); for (let attempt = 0; attempt < 30 && isAsyncJobProcessIdentityAlive(processRecord); attempt += 1) await delay(100); }
    if (isAsyncJobProcessIdentityAlive(processRecord)) throw new Error(`Worker host process group ${processRecord.pid} remained alive after cancellation.`);
  }

  function recoverInterruptedDiscardFiles(parentSessionFile: string, generation: number): void {
    const rows = getRegistry().database.prepare("SELECT worker_id,workspace_root,operation_nonce FROM workers WHERE parent_session_file=? AND operation_kind='discard' AND operation_nonce IS NOT NULL").all(parentSessionFile) as Array<{ worker_id: string; workspace_root: string; operation_nonce: string }>;
    for (const row of rows) {
      if (row.operation_nonce.startsWith(`${generation}-`)) continue;
      const paths = workerPaths(roots, row.worker_id); const stateTrash = `${paths.stateDir}.discard-${row.operation_nonce}`;
      const separateWorkspace = path.resolve(row.workspace_root).startsWith(`${path.resolve(paths.stateDir)}${path.sep}`) ? undefined : `${row.workspace_root}.discard-${row.operation_nonce}`;
      const irreversible = (!existsSync(paths.stateDir) && !existsSync(stateTrash)) || Boolean(separateWorkspace && !existsSync(row.workspace_root) && !existsSync(separateWorkspace));
      if (irreversible) { rmSync(paths.stateDir, { recursive: true, force: true }); rmSync(stateTrash, { recursive: true, force: true }); if (separateWorkspace) { rmSync(row.workspace_root, { recursive: true, force: true }); rmSync(separateWorkspace, { recursive: true, force: true }); } finalizeWorkerDiscard(getRegistry(), row.worker_id, row.operation_nonce); continue; }
      restoreDiscardPath(stateTrash, paths.stateDir); if (separateWorkspace) restoreDiscardPath(separateWorkspace, row.workspace_root);
    }
  }
  function restoreDiscardPath(trash: string, destination: string): void {
    if (!existsSync(trash)) return;
    if (existsSync(destination)) { rmSync(trash, { recursive: true, force: true }); return; }
    renameSync(trash, destination);
  }

  async function discardWorker(worker: WorkerRegistryRecord): Promise<void> {
    const nonce = claimNonce(); claimWorkerDiscard(getRegistry(), worker.workerId, worker.version, nonce, now().toISOString());
    const paths = workerPaths(roots, worker.workerId); const stateTrash = `${paths.stateDir}.discard-${nonce}`; const separateWorkspace = path.resolve(paths.workspaceRoot).startsWith(`${path.resolve(paths.stateDir)}${path.sep}`) ? undefined : `${paths.workspaceRoot}.discard-${nonce}`;
    try {
      if (existsSync(paths.stateDir)) renameSync(paths.stateDir, stateTrash); if (separateWorkspace && existsSync(paths.workspaceRoot)) renameSync(paths.workspaceRoot, separateWorkspace);
      rmSync(stateTrash, { recursive: true, force: true }); if (separateWorkspace) rmSync(separateWorkspace, { recursive: true, force: true }); finalizeWorkerDiscard(getRegistry(), worker.workerId, nonce);
    } catch (error) {
      const irreversible = (!existsSync(paths.stateDir) && !existsSync(stateTrash)) || Boolean(separateWorkspace && !existsSync(paths.workspaceRoot) && !existsSync(separateWorkspace));
      if (!irreversible) { try { if (existsSync(stateTrash) && !existsSync(paths.stateDir)) renameSync(stateTrash, paths.stateDir); if (separateWorkspace && existsSync(separateWorkspace) && !existsSync(paths.workspaceRoot)) renameSync(separateWorkspace, paths.workspaceRoot); } catch {} abandonWorkerDiscard(getRegistry(), worker.workerId, nonce, sanitizeError(error), now().toISOString()); }
      throw error;
    }
  }

  async function control(params: WorkerControlInputV2, context: ExtensionContext): Promise<AgentToolResult<any>> {
    const parent = requireParentSession(context); const db = getRegistry();
    if (params.action === "list") {
      const page = listWorkers(db, { parentSessionFile: parent, status: params.status, role: params.role, limit: params.limit, offset: params.offset }); const counts = countWorkers(db, parent);
      const workers = page.workers.map((worker) => { const latest = worker.latestRunId ? getWorkerRun(db, worker.workerId, worker.latestRunId) : undefined; return { workerId: worker.workerId, role: worker.role, status: worker.status, ...(worker.activeRunId ? { activeRunId: worker.activeRunId } : {}), ...(latest?.outcome ? { latestResult: { runId: latest.runId, outcome: latest.outcome, outcomeSource: latest.outcomeSource } } : {}), taskIds: worker.taskIds, ...(worker.modelSelection ? { modelSelection: worker.modelSelection } : {}), ...(worker.recoveryError ? { recoveryRequired: true } : {}), lastActivityAt: worker.updatedAt }; });
      return resultText(`${page.total} workers · ${counts.running} running, ${counts.queued} queued, ${counts.idle} idle`, { workers, total: page.total, counts, ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) });
    }
    const worker = ownedWorker(params.workerId, parent);
    if (params.action === "runs") { const page = listWorkerRuns(db, worker.workerId, params.limit, params.offset); return resultText(`${page.runs.length} retained runs`, { workerId: worker.workerId, runs: page.runs.map(slimRun), total: page.total, ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) }); }
    if (params.action === "get") { const run = getWorkerRun(db, worker.workerId, params.runId); if (!run) throw new Error(`Unknown run ${params.runId} for worker ${worker.workerId}.`); const details = exactRun(worker, run); return resultText(`${run.outcome ?? run.status} · ${worker.role} · ${worker.workerId.slice(-8)}`, details); }
    if (params.action === "cancel") { const cancellation = await cancelWorker(worker); const current = getWorker(db, worker.workerId) ?? worker; return resultText(`${cancellation.replace("_", " ")} · ${worker.workerId.slice(-8)}`, { cancellation, worker: workerListItem(current) }); }
    await discardWorker(worker); return resultText(`discarded · ${worker.role} · ${worker.workerId.slice(-8)}`, { workerId: worker.workerId, discarded: true });
  }

  function reconcileActiveRuns(context: ExtensionContext, parentSessionFile: string): void {
    for (const { worker, run } of activeRunsForParent(getRegistry(), parentSessionFile)) {
      const runtime = run.runtime as RunRuntime; if (!runtime || runtime.version !== 2 || run.claimKind) { if (worker.recoveryError) deliverRecovery(worker, run, worker.recoveryError); continue; }
      if (worker.recoveryError) {
        if (run.status === "running" && existsSync(runtime.settledFile) && existsSync(runtime.resultFile)) clearWorkerRecoveryError(getRegistry(), worker.workerId, run.runId, now().toISOString());
        else if (run.status === "queued") clearWorkerRecoveryError(getRegistry(), worker.workerId, run.runId, now().toISOString());
        else { deliverRecovery(worker, run, worker.recoveryError); continue; }
      }
      if (run.status === "queued") {
        if (existsSync(runtime.processFile)) {
          try {
            const processRecord = readWorkerHostProcess(runtime.processFile);
            if (processRecord.workerId === worker.workerId && processRecord.runId === run.runId && processRecord.nonce === runtime.processNonce && isAsyncJobProcessIdentityAlive(processRecord)) {
              const nonce = claimNonce();
              if (claimWorkerRun(getRegistry(), worker.workerId, run.runId, "launch", nonce, ["queued"])) finalizeWorkerRunLaunch(getRegistry(), { workerId: worker.workerId, runId: run.runId, claimNonce: nonce, modelSelection: worker.modelSelection!, sessionId: worker.sessionId!, sessionFile: worker.sessionFile!, sessionStartLine: run.sessionStartLine ?? countLines(worker.sessionFile!) + 1, jobId: run.jobId!, stdoutLog: run.stdoutLog!, stderrLog: run.stderrLog!, runtime, startedAt: run.startedAt ?? now().toISOString() });
              continue;
            }
          } catch {}
        }
        if (!pending.has(run.runId) && !starting.has(worker.workerId)) { const item = { workerId: worker.workerId, runId: run.runId, parentSessionFile, parentSessionId: context.sessionManager.getSessionId(), runtime }; beginPreparedRun(context, item); }
        continue;
      }
      if (active.get(worker.workerId)?.runId === run.runId) continue;
      if (existsSync(runtime.settledFile) && existsSync(runtime.resultFile)) { void settleCompletedRun(worker.workerId, run.runId, { status: "exited", exitCode: 0 }); continue; }
      if (existsSync(runtime.processFile)) { try { const process = readWorkerHostProcess(runtime.processFile); if (process.workerId === worker.workerId && process.runId === run.runId && process.nonce === runtime.processNonce && isAsyncJobProcessIdentityAlive(process)) continue; } catch {} }
      const nonce = claimNonce(); if (claimWorkerRun(getRegistry(), worker.workerId, run.runId, "settlement", nonce, ["running"])) void failClaimedRun(worker.workerId, run.runId, "settlement", nonce, new Error("Worker supervisor exited without a verified result settlement."));
    }
  }

  function registerCommands(): void {
    api.registerCommand("worker:list", { description: "List retained workers; optional status and role filters", handler: async (args, context) => { const [status, role] = args.trim().split(/\s+/).filter(Boolean); const result = await control({ action: "list", ...(status ? { status: status as any } : {}), ...(role ? { role: role as any } : {}) }, context); context.ui.notify(compactWorkerList((result as any).details), "info"); } });
    api.registerCommand("worker:show", { description: "Show an active/latest or exact retained worker run", handler: async (args, context) => { const [workerId, runId] = args.trim().split(/\s+/); if (!workerId) return context.ui.notify("Usage: /worker:show <workerId> [runId]", "info"); const worker = ownedWorker(workerId, requireParentSession(context)); const exact = runId ?? worker.activeRunId ?? worker.latestRunId; if (!exact) return context.ui.notify(`Worker ${workerId} has no runs.`, "info"); const result = await control({ action: "get", workerId, runId: exact }, context); context.ui.notify(formatExactRun((result as any).details), "info"); } });
    api.registerCommand("worker:logs", { description: "Open logs for an active/latest or exact retained worker run", handler: async (args, context) => { const [workerId, possibleRun, ...viewer] = args.trim().split(/\s+/).filter(Boolean); if (!workerId) return context.ui.notify("Usage: /worker:logs <workerId> [runId] [viewer options]", "info"); const worker = ownedWorker(workerId, requireParentSession(context)); const hasRun = possibleRun?.startsWith("run_"); const runId = (hasRun ? possibleRun : undefined) ?? worker.activeRunId ?? worker.latestRunId; const run = runId ? getWorkerRun(getRegistry(), workerId, runId) : undefined; if (!run?.jobId) return context.ui.notify("No retained run logs.", "info"); await handleAsyncShellViewerCommand(context, [run.jobId, ...(hasRun ? viewer : [possibleRun, ...viewer].filter(Boolean))].join(" ")); } });
    api.registerCommand("worker:cancel", { description: "Cancel active work while preserving retained state", handler: async (args, context) => { const workerId = args.trim(); if (!workerId) return context.ui.notify("Usage: /worker:cancel <workerId>", "info"); const result = await cancelWorker(ownedWorker(workerId, requireParentSession(context))); context.ui.notify(result === "cancelled" ? `Cancelled ${workerId}.` : "Worker is not active.", "info"); } });
    api.registerCommand("worker:discard", { description: "Permanently discard one idle worker; requires --confirm", handler: async (args, context) => { const [workerId, confirm, ...extra] = args.trim().split(/\s+/).filter(Boolean); if (!workerId || confirm !== "--confirm" || extra.length) return context.ui.notify("Usage: /worker:discard <workerId> --confirm", "info"); await discardWorker(ownedWorker(workerId, requireParentSession(context))); context.ui.notify(`Discarded ${workerId}.`, "info"); } });
  }

  function ownedWorker(workerId: string, parent: string): WorkerRegistryRecord { const worker = getWorker(getRegistry(), workerId); if (!worker || worker.parentSessionFile !== parent) throw new Error(`Unknown worker ${workerId} for this parent session.`); return worker; }
  function reviewSubject(runId: string, parent: string, reviewerWorkerId?: string) {
    const found = findWorkerRunById(getRegistry(), runId); if (!found || found.worker.parentSessionFile !== parent) throw new Error(`Unknown reviewed run ${runId}.`);
    const { worker, run } = found; if (!(["work", "integration"] as WorkerRole[]).includes(worker.role) || run.status !== "settled" || run.outcome !== "completed" || worker.latestRunId !== runId || worker.status !== "idle" || !worker.sessionFile || run.sessionStartLine === undefined || run.sessionEndLine === undefined) throw new Error(`Review requires the latest completed run of an idle work or integration worker; ${runId} is not eligible.`);
    if (worker.reviewedByWorkerId && worker.reviewedByWorkerId !== reviewerWorkerId) throw new Error(`Worker ${worker.workerId} is leased to reviewer ${worker.reviewedByWorkerId}.`); return found;
  }
  function claimNonce(): string { return `${runtimeGeneration}-${randomUUID()}`; }
  function managedCandidateWarnings(parentSessionFile: string) { return (candidateRepo: string, candidateCommit: string) => {
    const rows = getRegistry().database.prepare("SELECT r.run_id,r.repositories_json,w.worker_id,w.latest_run_id,w.status,w.workspace_root FROM runs r JOIN workers w ON w.worker_id=r.worker_id WHERE r.status='settled' AND w.parent_session_file=?").all(parentSessionFile) as Array<any>;
    const exactCandidate = realpathOrResolve(candidateRepo);
    for (const row of rows) { const item = (JSON.parse(row.repositories_json) as WorkerRepositoryResult[]).find((candidate) => realpathOrResolve(path.resolve(row.workspace_root, candidate.path)) === exactCandidate && candidate.commit === candidateCommit); if (!item) continue; const latest = row.run_id === row.latest_run_id; const warnings = [...(!latest ? [`Candidate belongs to historical run ${row.run_id}; latest is ${row.latest_run_id}.`] : []), ...(row.status !== "idle" ? ["Source worker has a newer active run that may supersede this candidate."] : [])]; return { source: { workerId: row.worker_id, runId: row.run_id, latest }, ...(warnings.length ? { warnings } : {}) }; } return {}; } }
  function deliverRecovery(worker: WorkerRegistryRecord, run: WorkerRunRecord, error: string): void { const key = `${runtimeGeneration}:${run.runId}`; if (deliveredRecovery.has(key) || !currentContext?.sessionManager.getSessionFile() || realpathOrResolve(currentContext.sessionManager.getSessionFile()!) !== worker.parentSessionFile) return; deliveredRecovery.add(key); const event = { event: "worker_recovery_required", workerId: worker.workerId, runId: run.runId, role: worker.role, status: run.status === "settled" ? "running" : run.status, error: sanitizeError(error) }; api.sendMessage({ customType: "worker-run", content: JSON.stringify(event), display: true, details: event }, { triggerTurn: true, deliverAs: "steer" }); }
  function recordRecovery(workerId: string, runId: string, error: unknown): void { try { const message = sanitizeError(error); setWorkerRecoveryError(getRegistry(), workerId, runId, message, now().toISOString()); const worker = getWorker(getRegistry(), workerId); const run = worker && getWorkerRun(getRegistry(), workerId, runId); if (worker && run) deliverRecovery(worker, run, message); } catch {} }
}

function updateWorkerActivityStatus(registry: WorkerRegistry, context: ExtensionContext): void {
  if (context.mode !== "tui" || !context.hasUI || typeof context.ui?.setStatus !== "function" || !context.ui.theme) return;
  let count = 0;
  try { count = activeWorkerCountForContext(registry, context); } catch {}
  context.ui.setStatus(WORKER_ACTIVITY_STATUS_KEY, renderWorkerActivityStatus(count, context.ui.theme));
}

function writeReviewContext(paths: WorkerPaths, reviewerWorkerId: string, contextId: string, subjectWorker: WorkerRegistryRecord, subjectRun: WorkerRunRecord, inputs: RetainedInput[]): string {
  const directory = path.join(paths.stateDir, "contexts"); mkdirSync(directory, { recursive: true, mode: 0o700 }); const file = path.join(directory, `review-${contextId}.json`);
  const value = { version: 2, reviewerWorkerId, reviewedWorkerId: subjectWorker.workerId, reviewedRunId: subjectRun.runId, subjectWorkspace: "/review/subject", session: { path: "/review/session.jsonl", range: { startLine: subjectRun.sessionStartLine, endLine: subjectRun.sessionEndLine } }, repositories: subjectRun.repositories, artifacts: subjectRun.artifacts, candidates: subjectRun.repositories.map(({ candidateId, path, reported, changed, dirty, eligible, issues }) => ({ candidateId, path, reported, changed, dirty, eligible, ...(issues ? { issues } : {}) })), additionalInputs: contextInputs(inputs) };
  writeReadonlyJson(file, value); return file;
}
function trustedPreparedSet(registry: WorkerRegistry, parentSessionFile: string, preparedId: string, consumedWorkspace?: string): ReturnType<typeof readPreparedMergeSet> {
  const record = readPreparedSetRecord(registry, parentSessionFile, preparedId);
  const repositories = consumedWorkspace && record.status === "consumed" ? record.repositories.map((item: any) => ({ ...item, preparedPath: path.join(consumedWorkspace, "prepared", preparedId, item.id) })) : record.repositories;
  return { version: 1, preparedId: record.preparedId, parentSessionFile: record.parentSessionFile, status: (["ready", "partial", "failed"] as string[]).includes(record.status) ? "ready" : "resolution_required", order: record.order, repositories: repositories as any, createdAt: record.createdAt };
}
function assertIntegrationTargetsCurrent(set: ReturnType<typeof readPreparedMergeSet>): void { for (const repository of set.repositories) { const current = trustedGit(repository.targetRepo, ["rev-parse", repository.targetRef]).trim(); if (current !== repository.expectedCommit) throw new Error(`Target ${repository.id} moved from ${repository.expectedCommit} to ${current}; run worker_merge_test again before integration.`); } }
function writeIntegrationContext(paths: WorkerPaths, set: ReturnType<typeof readPreparedMergeSet>, inputs: RetainedInput[], resumed: boolean): string {
  const directory = path.join(paths.stateDir, "contexts"); mkdirSync(directory, { recursive: true, mode: 0o700 }); const file = path.join(directory, `integration-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  const preparedId = set.preparedId;
  const value = { version: 2, preparedId, status: set.status, order: set.order, resumed, repositories: set.repositories.map((item: any) => ({ id: item.id, path: path.relative(paths.workspaceRoot, item.preparedPath).split(path.sep).join("/"), method: item.method, status: item.status, dependsOn: item.dependsOn, target: { repo: item.targetRepo, ref: item.targetRef, commit: item.expectedCommit, privateRef: item.targetPrivateRef }, candidate: { repo: item.candidateRepo, commit: item.candidateCommit, privateRef: item.candidatePrivateRef }, mergeBase: item.mergeBase, conflicts: item.conflicts ?? [], mergeMessages: item.mergeMessages ?? [], overlapCount: item.overlapCount })), additionalInputs: contextInputs(inputs) };
  writeReadonlyJson(file, value); return file;
}
function writeReadonlyJson(file: string, value: unknown): void { if (existsSync(file)) chmodSync(file, 0o600); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); chmodSync(file, 0o400); }
function sessionIdentity(paths: WorkerPaths): { sessionId: string; sessionFile: string } { const files = existsSync(paths.sessionDir) ? readdirSync(paths.sessionDir).filter((name) => name.endsWith(".jsonl")) : []; if (files.length !== 1) throw new Error(`Expected one fresh worker session in ${paths.sessionDir}.`); const sessionFile = realpathSync(path.join(paths.sessionDir, files[0]!)); const first = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]!); return { sessionId: first.id, sessionFile }; }
function verifyRetainedSession(worker: WorkerRegistryRecord): void { if (worker.role === "work") verifyWorkerSession({ sessionFile: worker.sessionFile!, sessionId: worker.sessionId!, workspaceRoot: worker.workspaceRoot, parentSessionFile: worker.parentSessionFile }); else { const first = JSON.parse(readFileSync(worker.sessionFile!, "utf8").split("\n")[0]!); if (first.id !== worker.sessionId || realpathOrResolve(first.cwd) !== realpathOrResolve(worker.workspaceRoot) || first.parentSession) throw new Error(`Worker ${worker.workerId} retained independent session is invalid.`); } }
function runtimeInputs(worker: WorkerRegistryRecord): RetainedInput[] { const value = worker.runtime?.inputs; return Array.isArray(value) ? value as RetainedInput[] : []; }
function retainedWorkerRuntime(worker: WorkerRegistryRecord): Partial<WorkerRuntime> { const baselines = worker.runtime?.repositoryBaselines; const cacheLineage = worker.runtime?.cacheLineage; return { ...(Array.isArray(baselines) ? { repositoryBaselines: baselines as any } : {}), ...(cacheLineage && typeof cacheLineage === "object" ? { cacheLineage: cacheLineage as WorkerCacheLineageRecord } : {}) }; }
function parseWorkerModelSelection(value: string): { provider: string; model: string; thinkingLevel: string } { const slash = value.indexOf("/"); const colon = value.lastIndexOf(":"); if (slash < 1 || colon <= slash + 1) throw new Error(`Invalid worker model selection: ${value}.`); return { provider: value.slice(0, slash), model: value.slice(slash + 1, colon), thinkingLevel: value.slice(colon + 1) }; }
function roleInstructionsFor(role: WorkerRole): string { return workerRoleInstructions(role).text; }
function resolveModel(role: WorkerRole, explicit: string | undefined, context: ExtensionContext): string { const errors: string[] = []; for (const requested of preferredWorkerModel(role, explicit)) { try { const parsed = parseModelThinkingPair(requested); const resolved = resolveExtensionModel({ registry: context.modelRegistry, requested, fallbackThinkingLevel: parsed.thinkingLevel, label: `${role} worker`, noModelMessage: `No configured ${role} model is available.` }); assertChildAgentRouteAllowed(resolved.model, resolved.thinkingLevel, `${role} worker`); if (`${resolved.model.provider}/${resolved.model.id}:${resolved.thinkingLevel}` !== requested) throw new Error(`Selection ${requested} could not be honored exactly.`); return requested; } catch (error) { errors.push(sanitizeError(error)); } } throw new Error(`No configured ${role} model selection is available before launch. ${errors.join(" ")}`); }
function requireParentSession(context: ExtensionContext): string { const file = context.sessionManager.getSessionFile(); if (!file) throw new Error("Managed workers require a persisted parent session."); return realpathOrResolve(file); }
function realpathOrResolve(value: string): string { try { return realpathSync(value); } catch { return path.resolve(value); } }
function countLines(file: string): number { try { const text = readFileSync(file, "utf8"); return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0); } catch { return 0; } }
function validateRunRequestBounds(request: WorkerRunInputV2["runs"][number]): void {
  if (Buffer.byteLength(request.instructions ?? "") > 12 * 1024) throw new Error("instructions must be at most 12 KiB UTF-8.");
  for (const value of ("additionalInputs" in request ? request.additionalInputs : undefined) ?? []) if (Buffer.byteLength(value) > 4096) throw new Error("additionalInputs paths must be at most 4 KiB UTF-8.");
  if (request.action === "start" && request.role === "work") {
    if (request.modelSelection !== undefined && Buffer.byteLength(request.modelSelection) > 512) throw new Error("modelSelection must be at most 512 UTF-8 bytes.");
    for (const baseline of request.repositoryBaselines ?? []) {
      if (Buffer.byteLength(baseline.path) > 4096) throw new Error("repositoryBaselines paths must be at most 4 KiB UTF-8.");
      if (baseline.revision !== undefined && Buffer.byteLength(baseline.revision) > 256) throw new Error("repositoryBaselines revisions must be at most 256 UTF-8 bytes.");
    }
  }
}
function unique(values: string[]): string[] { const result = [...new Set(values.map((value) => value.trim()).filter(Boolean))]; if (result.length !== values.length) throw new Error("Worker task IDs and batch identities must be unique."); return result; }
function sanitizeError(error: unknown): string { return String(error instanceof Error ? error.message : error).replaceAll(/[\r\n\t]+/g, " ").slice(0, 2048); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function resultText(_text: string, details: any): AgentToolResult<any> { return { content: [{ type: "text", text: JSON.stringify(details) }], details }; }
function slimRun(run: WorkerRunRecord) { return { runId: run.runId, status: run.status, ...(run.outcome ? { outcome: run.outcome, outcomeSource: run.outcomeSource } : {}), createdAt: run.createdAt, ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.settledAt ? { settledAt: run.settledAt } : {}) }; }
function workerListItem(worker: WorkerRegistryRecord) { return { workerId: worker.workerId, role: worker.role, status: worker.status, ...(worker.activeRunId ? { activeRunId: worker.activeRunId } : {}), taskIds: worker.taskIds, ...(worker.modelSelection ? { modelSelection: worker.modelSelection } : {}), ...(worker.recoveryError ? { recoveryRequired: true } : {}), lastActivityAt: worker.updatedAt }; }
function exactRun(worker: WorkerRegistryRecord, run: WorkerRunRecord) { return { workerId: worker.workerId, role: worker.role, runId: run.runId, status: run.status, taskIds: run.taskIds, ...(run.modelSelection ? { modelSelection: run.modelSelection } : {}), createdAt: run.createdAt, ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.settledAt ? { settledAt: run.settledAt } : {}), ...(run.jobId ? { jobId: run.jobId } : {}), ...(run.stdoutLog ? { stdoutLog: run.stdoutLog } : {}), ...(run.stderrLog ? { stderrLog: run.stderrLog } : {}), ...(worker.sessionId ? { sessionId: worker.sessionId } : {}), ...(worker.sessionFile ? { sessionFile: worker.sessionFile } : {}), sessionRange: { ...(run.sessionStartLine === undefined ? {} : { startLine: run.sessionStartLine }), ...(run.sessionEndLine === undefined ? {} : { endLine: run.sessionEndLine }) }, workspaceRoot: worker.workspaceRoot, ...(run.binding ? { binding: run.binding } : {}), ...(worker.recoveryError ? { recoveryError: worker.recoveryError } : {}), ...((run.runtime as RunRuntime | undefined)?.interruptionWarnings?.length ? { warnings: (run.runtime as RunRuntime).interruptionWarnings } : {}), ...(run.status === "settled" ? { outcome: run.outcome, outcomeSource: run.outcomeSource, ...(run.summary ? { summary: run.summary } : {}), ...(run.question ? { question: run.question } : {}), repositories: run.repositories.map(({ path: relativePath, commit, source, reported, changed, dirty, eligible, issues }) => ({ repositoryPath: path.join(worker.workspaceRoot, relativePath), commit, ...(source ? { source } : {}), reported, changed, dirty, eligible, ...(issues ? { issues } : {}) })), artifacts: run.artifacts, errors: run.errors } : {}) }; }
function compactWorkerList(value: any): string { const workers = Array.isArray(value?.workers) ? value.workers : []; return workers.length ? workers.map((worker: any) => `${worker.status} · ${worker.role} · ${worker.workerId}`).join("\n") : "No workers."; }
function formatExactRun(value: any): string { return `${value.outcome ?? value.status} · ${value.role} · ${value.workerId}\nrun ${value.runId}\n${value.taskIds?.length ?? 0} tasks · ${value.repositories?.length ?? 0} repositories · ${value.artifacts?.length ?? 0} artifacts${value.recoveryError ? `\nrecovery: ${value.recoveryError}` : ""}`; }
function boundedWorkerText(theme: any, text: string, color: string, bold: boolean, maximumWidth: number): Component {
  const safe = sanitizeWorkerOperationText(text);
  return {
    render(width: number): string[] {
      const boundedWidth = Math.max(1, Math.min(maximumWidth, width));
      const visible = sanitizeWorkerOperationText(truncateToWidth(safe, boundedWidth, "…"));
      return [theme.fg(color, bold ? theme.bold(visible) : visible)];
    },
    invalidate() {}
  };
}
function compactCall(theme: any, label: string, hint?: string): Component {
  const text = hint ? `${sanitizeWorkerOperationText(label)} · ${hint}` : sanitizeWorkerOperationText(label);
  return boundedWorkerText(theme, text, "toolTitle", true, 72);
}
function compactResult(theme: any, result: AgentToolResult<any>, fallback: string, hint?: string): Component {
  const summary = compactResultSummary(safeResultDetails(result), fallback);
  return boundedWorkerText(theme, hint ? `${summary} · ${hint}` : summary, "success", false, 96);
}
function compactResultSummary(details: any, fallback: string): string {
  try {
    if (Array.isArray(details?.runs) && details.runs.slice(0, 32).some((run: any) => recordValue(run) && typeof run.action === "string")) return `${details.runs.length} worker run${details.runs.length === 1 ? "" : "s"} queued`;
    if (typeof details?.preparedId === "string") return `${details.status ?? fallback} · ${Array.isArray(details.repositories) ? details.repositories.length : 0} repositories`;
    if (Array.isArray(details?.workers)) return `${Number.isInteger(details.total) ? details.total : details.workers.length} workers`;
    if (Array.isArray(details?.runs)) return `${Number.isInteger(details.total) ? details.total : details.runs.length} retained runs`;
    if (typeof details?.cancellation === "string") return details.cancellation.replace("_", " ");
    if (details?.discarded) return "worker discarded";
    if (typeof details?.workerId === "string" && typeof details?.runId === "string") return `${details.outcome ?? details.status ?? fallback} · ${details.role ?? "worker"}`;
    return fallback;
  } catch { return fallback; }
}

type WorkerOperation =
  | { kind: "work"; taskIds: string[]; title?: string; batchExtra?: number }
  | { kind: "review"; taskIds: string[]; reviewedRunId: string; batchExtra?: number }
  | { kind: "integration"; repositories: Array<Record<string, unknown>>; batchExtra?: number }
  | { kind: "merge"; repositories: Array<Record<string, unknown>> }
  | { kind: "prepared"; preparedId: string; batchExtra?: number };

const PERSONAL_TASK_ID = /^personal-[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*$/;
const PREPARED_ID = /^prepared_[0-9a-f]{24}$/;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const MAX_WORKER_OPERATION_HINT_WIDTH = 48;

export function sanitizeWorkerOperationText(value: unknown): string {
  if (typeof value !== "string") return "";
  const bounded = value.slice(0, 4096);
  return stripTerminalSequences(bounded).replace(TERMINAL_CONTROL_PATTERN, " ").replace(/\s+/gu, " ").trim();
}

function recordValue(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function safeResultDetails(result: unknown): unknown { try { return recordValue(result) ? result.details : undefined; } catch { return undefined; } }
function safeToolCallId(context: unknown): string {
  try { return recordValue(context) && typeof context.toolCallId === "string" ? context.toolCallId : ""; } catch { return ""; }
}
function renderArgumentsComplete(context: unknown): boolean {
  try { return recordValue(context) && (context.argsComplete === true || context.executionStarted === true); } catch { return false; }
}
function matchingWorkerRunSnapshot(details: unknown, snapshot: WorkerOperationSnapshot | undefined): WorkerOperation | undefined {
  try {
    if (snapshot?.scope !== "worker_run" || !recordValue(details) || !Array.isArray(details.runs) || !recordValue(details.runs[0])) return undefined;
    return details.runs[0].runId === snapshot.runId ? snapshot.operation : undefined;
  } catch { return undefined; }
}
function mergeApplyResultOperationHint(details: unknown, snapshot: WorkerOperationSnapshot | undefined): string | undefined {
  try {
    if (!recordValue(details) || typeof details.preparedId !== "string") return undefined;
    if (snapshot?.scope === "worker_merge_apply" && snapshot.preparedId === details.preparedId) return renderWorkerOperationHint(snapshot.operation) ?? mergeResultOperationHint(details);
    return mergeResultOperationHint(details);
  } catch { return undefined; }
}
function validTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).filter((item): item is string => typeof item === "string" && item.length <= 128 && PERSONAL_TASK_ID.test(item));
}
function operationRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.slice(0, 16).filter(recordValue) : [];
}
function snapshotOperationRepositories(value: unknown): Array<Record<string, unknown>> | undefined {
  const repositories = operationRecords(value).map((repository) => {
    const snapshot: Record<string, unknown> = {};
    for (const field of ["targetRepo", "candidateRepo", "preparedPath", "path", "targetRef", "method"] as const) {
      const item = repository[field]; if (typeof item === "string") snapshot[field] = item.slice(0, 4096);
    }
    return snapshot;
  });
  return repositories.length > 0 ? repositories : undefined;
}
function plusCount(value: string, count: number): string { return count > 0 ? `${value} +${count}` : value; }
function repositoryBasename(value: unknown): string {
  const safe = sanitizeWorkerOperationText(value).replaceAll("\\", "/").replace(/\/+$/u, "");
  return safe.split("/").at(-1) ?? "";
}
function withBatchExtra<T extends WorkerOperation>(operation: T, batchExtra: number): T {
  return batchExtra > 0 && operation.kind !== "merge" ? { ...operation, batchExtra } : operation;
}
function workOperation(taskIds: unknown, batchExtra = 0, title?: unknown): WorkerOperation | undefined {
  const trusted = validTaskIds(taskIds); if (!trusted[0]) return undefined;
  return withBatchExtra({ kind: "work", taskIds: trusted, ...(typeof title === "string" ? { title } : {}) }, batchExtra);
}
function reviewOperation(taskIds: unknown, reviewedRunId: unknown, batchExtra = 0): WorkerOperation | undefined {
  if (typeof reviewedRunId !== "string" || !/^run_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reviewedRunId)) return undefined;
  return withBatchExtra({ kind: "review", taskIds: validTaskIds(taskIds), reviewedRunId }, batchExtra);
}
function preparedOperation(preparedId: unknown, batchExtra = 0): WorkerOperation | undefined {
  return typeof preparedId === "string" && PREPARED_ID.test(preparedId) ? withBatchExtra({ kind: "prepared", preparedId }, batchExtra) : undefined;
}
function integrationOperation(repositories: unknown, batchExtra = 0): WorkerOperation | undefined {
  const records = snapshotOperationRepositories(repositories); if (!records?.[0]) return undefined;
  return withBatchExtra({ kind: "integration", repositories: records }, batchExtra);
}
function mergeOperation(repositories: unknown): WorkerOperation | undefined {
  const records = snapshotOperationRepositories(repositories); return records?.[0] ? { kind: "merge", repositories: records } : undefined;
}

export function workerRunCallOperationHint(input: unknown, argsComplete: boolean): string | undefined {
  try {
    if (!argsComplete || !recordValue(input) || !Array.isArray(input.runs)) return undefined;
    const runs = input.runs; const first = runs[0]; if (!recordValue(first)) return undefined;
    const batchExtra = Math.max(0, runs.length - 1);
    if (first.action === "start" && first.role === "work") return renderWorkerOperationHint(workOperation(first.taskIds, batchExtra));
    if (first.action === "start" && first.role === "review") return renderWorkerOperationHint(reviewOperation([], first.reviewedRunId, batchExtra));
    if (first.action === "start" && first.role === "integration") return renderWorkerOperationHint(preparedOperation(first.preparedId, batchExtra));
    return undefined;
  } catch { return undefined; }
}

export function workerRunResultOperationHint(details: unknown, snapshot?: WorkerOperation): string | undefined {
  try {
    if (snapshot) return renderWorkerOperationHint(snapshot);
    if (!recordValue(details) || !Array.isArray(details.runs)) return undefined;
    const runs = details.runs; const first = runs[0]; if (!recordValue(first)) return undefined;
    const batchExtra = Math.max(0, runs.length - 1);
    if (first.action === "start" && first.role === "review") return renderWorkerOperationHint(reviewOperation(first.taskIds, first.reviewedRunId, batchExtra));
    if (first.action === "start" && first.role === "integration") return renderWorkerOperationHint(preparedOperation(first.preparedId, batchExtra));
    return renderWorkerOperationHint(workOperation(first.taskIds, batchExtra));
  } catch { return undefined; }
}

function plannedRunOperation(plans: PlannedRun[]): WorkerOperation | undefined {
  try {
    const first = plans[0]; if (!first) return undefined;
    const batchExtra = Math.max(0, plans.length - 1);
    if (first.request.action === "resume") return workOperation(first.taskIds, batchExtra);
    if (first.role === "review") return reviewOperation(first.taskIds, first.reviewedRunId, batchExtra);
    if (first.role === "integration") return integrationOperation(first.operationRepositories, batchExtra) ?? preparedOperation(first.preparedId, batchExtra);
    return workOperation(first.taskIds, batchExtra);
  } catch { return undefined; }
}

export function renderWorkerOperationHint(operation: unknown): string | undefined {
  try {
    if (!recordValue(operation) || typeof operation.kind !== "string") return undefined;
    let raw = "";
    if (operation.kind === "work") {
      const taskIds = validTaskIds(operation.taskIds); const first = taskIds[0]; if (!first) return undefined;
      const task = plusCount(first, Math.max(0, taskIds.length - 1));
      const title = sanitizeWorkerOperationText(operation.title);
      raw = `${task}${title ? ` — ${title}` : ""}`;
    } else if (operation.kind === "review") {
      const taskIds = validTaskIds(operation.taskIds); const task = taskIds[0];
      const taskPart = task ? plusCount(task, Math.max(0, taskIds.length - 1)) : "review";
      const run = sanitizeWorkerOperationText(operation.reviewedRunId).slice(-8);
      raw = `${taskPart}${run ? ` · run ${run}` : ""}`;
    } else if (operation.kind === "integration") {
      const repositories = operationRecords(operation.repositories); const first = repositories[0]; if (!first) return undefined;
      const repository = repositoryBasename(first.targetRepo ?? first.candidateRepo ?? first.preparedPath ?? first.path); if (!repository) return undefined;
      raw = plusCount(repository, Math.max(0, repositories.length - 1));
    } else if (operation.kind === "merge") {
      const repositories = operationRecords(operation.repositories); const first = repositories[0]; if (!first) return undefined;
      const repository = repositoryBasename(first.targetRepo); if (!repository) return undefined;
      const branch = sanitizeWorkerOperationText(first.targetRef).replace(/^refs\/heads\//u, "");
      const method = first.method === "merge" || first.method === "squash" ? first.method : "";
      raw = `${repository}${branch ? ` → ${branch}` : ""}${method ? ` · ${method}` : ""}${repositories.length > 1 ? ` +${repositories.length - 1}` : ""}`;
    } else if (operation.kind === "prepared") {
      if (typeof operation.preparedId !== "string" || !PREPARED_ID.test(operation.preparedId)) return undefined;
      raw = `prepared ${operation.preparedId.slice(-8)}`;
    } else return undefined;
    if (operation.kind !== "merge" && Number.isInteger(operation.batchExtra) && (operation.batchExtra as number) > 0) raw += ` · +${operation.batchExtra}`;
    const safe = sanitizeWorkerOperationText(raw); if (!safe) return undefined;
    return visibleWidth(safe) <= MAX_WORKER_OPERATION_HINT_WIDTH ? safe : sanitizeWorkerOperationText(truncateToWidth(safe, MAX_WORKER_OPERATION_HINT_WIDTH, "…"));
  } catch { return undefined; }
}
function mergeOperationHint(repositories: unknown): string | undefined { return renderWorkerOperationHint(mergeOperation(repositories)); }
function mergeCallOperationHint(input: unknown, argsComplete: boolean): string | undefined {
  try { return argsComplete && recordValue(input) ? mergeOperationHint(input.repositories) : undefined; } catch { return undefined; }
}
function mergeResultOperationHint(details: unknown): string | undefined {
  try { return recordValue(details) ? mergeOperationHint(details.repositories) : undefined; } catch { return undefined; }
}
function preparedCallOperationHint(preparedId: unknown): string | undefined { return renderWorkerOperationHint(preparedOperation(preparedId)); }
function preparedCallOperationHintFromArgs(input: unknown, argsComplete: boolean): string | undefined {
  try { return argsComplete && recordValue(input) ? preparedCallOperationHint(input.preparedId) : undefined; } catch { return undefined; }
}
function runCallLabel(input: unknown): string {
  try {
    if (!recordValue(input) || !Array.isArray(input.runs) || !recordValue(input.runs[0])) return "Run Workers";
    const first = input.runs[0];
    if (first.action === "resume") return "Resume Worker";
    if (first.role === "review") return "Review Worker Output";
    if (first.role === "integration") return "Resolve Repository Conflicts";
    return "Run Workers";
  } catch { return "Run Workers"; }
}
function workerControlCallLabel(input: unknown): string {
  try { return `worker ${recordValue(input) && typeof input.action === "string" ? sanitizeWorkerOperationText(input.action) || "control" : "control"}`; }
  catch { return "worker control"; }
}
function publicPreparedSet(set: any) { return { preparedId: set.preparedId, status: set.status, order: set.order, repositories: set.repositories.map((item: any) => ({ id: item.id, candidateRepo: item.candidateRepo, candidateCommit: item.candidateCommit, targetRepo: item.targetRepo, targetRef: item.targetRef, method: item.method, status: item.status, expectedCommit: item.expectedCommit, ...(item.desiredCommit ? { desiredCommit: item.desiredCommit } : {}), preparedPath: item.preparedPath, overlapCount: item.overlapCount, dependsOn: item.dependsOn, ...(item.source ? { source: item.source } : {}), ...(item.warnings ? { warnings: item.warnings } : {}) })), ...(set.resolutionCases ? { resolutionCases: set.resolutionCases } : {}) }; }
function sessionDeliveryIds(context: ExtensionContext): string[] { const ids = new Set<string>(); const visit = (value: unknown): void => { if (!value || typeof value !== "object") return; const record = value as Record<string, unknown>; if (typeof record.deliveryId === "string" && record.deliveryId.startsWith("worker-run:")) ids.add(record.deliveryId); for (const child of Object.values(record)) Array.isArray(child) ? child.forEach(visit) : visit(child); }; try { for (const entry of context.sessionManager.getEntries()) visit(entry); } catch {} return [...ids]; }
function deliverPendingCompletions(
  api: ExtensionAPI,
  registry: WorkerRegistry,
  parent: string,
  generation: number,
  attempts?: Map<string, number>
): void {
  for (const delivery of pendingWorkerDeliveries(registry, parent)) {
    if (!claimWorkerDelivery(registry, delivery.deliveryId, parent, generation)) continue;
    const worker = getWorker(registry, delivery.workerId);
    const run = getWorkerRun(registry, delivery.workerId, delivery.runId);
    if (!worker || !run?.outcome || !run.outcomeSource) {
      releaseWorkerDeliveryClaim(registry, delivery.deliveryId, generation);
      continue;
    }
    const event = { event: "worker_settled", workerId: worker.workerId, runId: run.runId, role: worker.role, outcome: run.outcome, outcomeSource: run.outcomeSource, ...(run.summary ? { summary: run.summary } : {}), ...(run.question ? { question: run.question } : {}), repositoryCount: run.repositories.length, artifactCount: run.artifacts.length, ...(run.errors.length ? { errors: run.errors } : {}) };
    try {
      api.sendMessage({ customType: "worker-run", content: JSON.stringify(event), display: true, details: { ...event, deliveryId: delivery.deliveryId } }, { triggerTurn: true, deliverAs: delivery.completionDelivery });
      attempts?.set(delivery.deliveryId, (attempts.get(delivery.deliveryId) ?? 0) + 1);
    } catch {
      releaseWorkerDeliveryClaim(registry, delivery.deliveryId, generation);
    }
  }
}

function reconcileSameGenerationWorkerDeliveries(
  api: ExtensionAPI,
  registry: WorkerRegistry,
  parent: string,
  generation: number,
  context: ExtensionContext,
  attempts: Map<string, number>
): void {
  const observed = new Set(sessionDeliveryIds(context));
  let released = false;
  for (const delivery of pendingWorkerDeliveries(registry, parent)) {
    if (delivery.state !== "claimed" || delivery.runtimeGeneration !== generation) continue;
    if (observed.has(delivery.deliveryId)) {
      if (markWorkerDeliveryDelivered(registry, delivery.deliveryId, generation, new Date().toISOString())) attempts.delete(delivery.deliveryId);
      continue;
    }
    if (attempts.get(delivery.deliveryId) !== 1) continue;
    releaseWorkerDeliveryClaim(registry, delivery.deliveryId, generation);
    released = true;
  }
  if (released) deliverPendingCompletions(api, registry, parent, generation, attempts);
}
