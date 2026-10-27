import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Text, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { resolveExtensionModel, assertChildAgentRouteAllowed, parseModelThinkingPair } from "../_shared/model-spec.js";
import { throwIfAborted } from "../_shared/cancellation.js";
import { asyncJobProcessStartToken, createAsyncJobId, probeAsyncJobProcessIdentity, signalAsyncJobProcessIdentity, type AsyncJobProcessIdentityLiveness } from "../_shared/async-job.js";
import * as asyncJobProcessPackage from "../_shared/async-job-process.js";
import * as atomicJsonPackage from "../_shared/atomic-json.js";
import { createPiToolsPackageGenerationGuard } from "../_shared/package-generation.js";
import * as workerJobSettlementPackage from "../_shared/worker-job-settlement.js";
import { handleAsyncShellViewerCommand, reconcileTerminatedPersistedAsyncShellJobsForOwner, unsettledPersistedAsyncShellJobsForOwner, type JobMeta, type ManagedAsyncJobHandle } from "../async-shell/index.js";
import { createWorkerSandboxAsync, planWorkerSandbox, resolveSbxPath, settleWorkerSandboxAsync, type WorkerSandboxMount, type WorkerSandboxReference, type WorkerSandboxRelease } from "./sandbox.js";
import { inputJsonSchemaGuideline, outputJsonSchemaGuideline } from "../_shared/tool-prompt.js";
import { workerMutationAdmissionPath, workerResultAdmissionPath } from "../_shared/worker-contract.js";
import { writeAtomicJson } from "../_shared/atomic-json.js";
import { workerRoleInstructions } from "../_shared/role-instructions.js";
import { RetainedToolOutputSchemas } from "../_shared/tool-output.js";
import { WorkerControlParamsV2, WorkerMergeApplyParams, WorkerMergeTestParams, WorkerRunParamsV2, type WorkerControlInputV2, type WorkerRunInputV2 } from "./contract.js";
import { applyPreparedWorkerMerges, consumePreparedMergeSet, defaultPreparedMergeRoot, prepareWorkerMerges, readPreparedMergeSet, restoreConsumedPreparedMergeSet } from "./merge.js";
import {
  abandonWorkerDiscard, activeRunsForParent, claimPreparedSetApply, claimWorkerAcceptedSettlement, clearWorkerRecoveryError, claimWorkerDiscard, claimWorkerRecoveryDiscard, markWorkerCleanupRecovery, claimWorkerDelivery, claimWorkerRun, claimWorkerTerminalIntent,
  countWorkers, createWorkerRunBatch, finalizeClaimedWorkerRun, finalizeWorkerDiscard, finalizeWorkerRunLaunch, findWorkerRunById, finishPreparedSetApply,
  getWorker, getWorkerDeliveryForRun, getWorkerRun, listWorkerRuns, listWorkers, markWorkerDeliveryDelivered, markWorkerDeliverySendStarted, openWorkerRegistry, pendingWorkerDeliveries,
  currentParentRuntime, latestParentRuntimeMembers, parentRuntimeMemberForGeneration, promoteParentRuntime, readPreparedSetRecord, recordWorkerSettlementRecovery, reconcileWorkerDeliveries, registerParentRuntimeAndRecoverClaims, recoverInterruptedPreparedSetAppliesForParent, releasePreparedSetApply, releaseWorkerDeliveryClaim, releaseWorkerRunClaim, recoverProvablyDeadWorkerDeliveryClaim, recoverProvablyDeadWorkerRunClaim, requestWorkerCancellation, requestWorkerFailure, retireParentRuntime, setClaimedWorkerTerminalIntent, setWorkerRecoveryError, storePreparedSet,
  subscribeWorkerRegistryChanges, updateClaimedWorkerRunRuntime, updatePreparedSetStatus, updateWorkerRuntimeMetadata, workerRegistryDataVersion,
  type ParentRuntimeIdentity, type ParentRuntimeMember, type WorkerBatchCreateItem, type WorkerDeliveryRecord, type WorkerLifecycleClaimRecoveryCandidate, type WorkerRegistry, type WorkerRegistryRecord, type WorkerRepositoryResult, type WorkerRole, type WorkerRunRecord, type WorkerTerminalIntent
} from "./registry.js";
import { readWorkerRuntimeResult } from "./runtime.js";

import { preferredWorkerModel } from "./settings.js";
import { CURRENT_WORKER_STORAGE_LAYOUT, createWorkerId, createWorkerRunId, defaultWorkerRoots, provisionWorkerPaths, storedWorkerPaths, workerPaths, type WorkerPaths, type WorkerRoots } from "./identity.js";
import { createWorkerSession, forkWorkerSession, readWorkerSessionHeader, readWorkerSessionText, verifyWorkerSession } from "./session.js";
import { launchWorkerHost, readWorkerHostProcess, readWorkerHostSettlement, type WorkerLaunchRecord } from "./runner.js";
import { renderWorkerRuntimePrompt } from "./prompts.js";
import { contextInputs, inputMounts, validateAdditionalInputs, type RetainedInput } from "./inputs.js";
import { inspectInterruptedGitState, inventoryWorkerRepositories, snapshotWorkerRepositories, type RepositorySnapshot } from "./inventory.js";
import { countSessionLines, openWorkerSessionViewer, sanitizeViewText, type WorkerSessionViewTarget } from "./view.js";
import { canonicalPathWithin, canonicalRepository, trustedGit } from "./trusted-git.js";
import { continueWorkerCacheLineage, prepareWorkerCacheLineage, registerParentCacheLineageCapture, type WorkerCacheLineageRecord } from "./cache-lineage.js";
import { adoptCleanupWorkers, adoptPreparedSetDiscard, buildCleanupInventory, classifyCleanupWorker, classifyPreparedCleanupIds, claimPreparedSetDiscard, consumeCleanupSnapshot, invalidateCleanupSnapshot, createCleanupSnapshot, deleteCleanupLeftovers, deletePlannedWorkerHostLogs, finishPreparedSetDiscard, loadCleanupSnapshot, loadCleanupScanCursor, invalidateCleanupScanCursor, advanceCleanupScanCursor, planSettledWorkerHostLogs, preflightWorkerDiscard, preservationRecords, preserveWorkerArtifacts, preparedCleanupTaskIds, readCleanupBeadsFacts, recoverPreparedSetDiscards, revalidateCleanupSnapshot, type CleanupInventory, type CleanupOwnerAuthority, type CleanupSnapshotWorker, type PersistedCleanupPreview } from "./cleanup.js";

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

type RunRuntime = {
  version: 4; prompt: string; runDir: string; resultFile: string; settledFile: string; processFile: string; processNonce: string;
  sandbox: WorkerSandboxReference; contextFile?: string; inputs: RetainedInput[];
  repositoryBefore: RepositorySnapshot[]; pendingWorkSessionId?: string; interruptionWarnings?: string[]; runtimeFingerprint: string; releaseOrdinal: number;
  launchProjectCwd?: string; parentSessionId?: string;
};
type WorkerRuntime = { version: 2; inputs: RetainedInput[]; repositoryBaselines?: Array<{ path: string; resolvedCommit: string }>; cacheLineage?: WorkerCacheLineageRecord };
type PendingRun = { workerId: string; runId: string; parentSessionFile: string; parentSessionId: string; runtime: RunRuntime };
type ActiveRun = { runId: string; handle: ManagedAsyncJobHandle };
type LifecycleClaimKind = "launch" | "settlement" | "cancellation";
type LifecycleAdmissionRecord = { version: 1; workerId: string; runId: string; claimKind: LifecycleClaimKind; claimNonce: string; pid: number; processStartToken: string; startedAt: string };
class WorkerHostIdentityError extends Error {}
class WorkerContainmentError extends Error {}
class WorkerLifecycleOwnerBusyError extends Error {}
type PlannedRun = {
  request: WorkerRunInputV2["runs"][number]; role: WorkerRole; workerId: string; runId: string; jobId: string; paths: WorkerPaths;
  taskIds: string[]; modelSelection: string; binding?: WorkerRunRecord["binding"]; workerRuntime: WorkerRuntime; runRuntime: RunRuntime;
  newWorker: boolean; sessionStartLine?: number; expectedVersion?: number; reviewedRunId?: string; preparedId?: string; consumedPrepared?: boolean; operationRepositories?: Array<Record<string, unknown>>;
};
type WorkerOperationSnapshot =
  | { scope: "worker_run"; runId: string; operation: WorkerOperation }
  | { scope: "worker_merge_apply"; preparedId: string; operation: WorkerOperation };
export type WorkerExtensionDependencies = {
  runtimeRoot?: string; roots?: WorkerRoots; codeRoot?: string; preparedRoot?: string; targetRoot?: string; bdPath?: string; now?: () => Date; random?: () => string; sbxPath?: string; sandboxRelease?: WorkerSandboxRelease;
  createSandbox?: (sbxPath: string, reference: WorkerSandboxReference) => WorkerSandboxReference | Promise<WorkerSandboxReference>;
  removeSandbox?: (sbxPath: string, reference: WorkerSandboxReference) => void | Promise<void>;
  launch?: (api: ExtensionAPI, context: ExtensionContext, input: { record: WorkerLaunchRecord; runtime: RunRuntime }) => ManagedAsyncJobHandle;
  waitForHostIdentity?: (runtime: RunRuntime, workerId: string, runId: string) => Promise<void>;
  assertPackageGeneration?: () => void;
  probeHostIdentity?: (identity: ReturnType<typeof readWorkerHostProcess>) => AsyncJobProcessIdentityLiveness;
  beforeCreateRunBatch?: () => void | Promise<void>;
  cleanupHostLogs?: typeof planSettledWorkerHostLogs;
  beforeDiscardRootClaim?: (worker:WorkerRegistryRecord)=>void;
  signalHostIdentity?: (identity: ReturnType<typeof readWorkerHostProcess>, signal: NodeJS.Signals) => boolean;
  hostTerminationGraceAttempts?: number; hostForcedTerminationAttempts?: number; hostProbeDelayMs?: number;
  readProcessStartToken?: (pid: number) => string | undefined; ownerProbeIntervalMs?: number; ownerWaitTimeoutMs?: number;
  cancellationResultGraceMs?: number; cancellationEofGraceMs?: number;
};

export default function workerExtension(api: ExtensionAPI): void { registerWorkerExtension(api); }

export function registerWorkerExtension(api: ExtensionAPI, overrides: WorkerExtensionDependencies = {}): void {
  const assertCurrentPackageGeneration = overrides.assertPackageGeneration ?? createPiToolsPackageGenerationGuard(import.meta.url, [
    { name: "async-job-process", path: "extensions/_shared/async-job-process.js", fingerprint: asyncJobProcessPackage.PI_TOOLS_MODULE_FINGERPRINT },
    { name: "atomic-json", path: "extensions/_shared/atomic-json.js", fingerprint: atomicJsonPackage.PI_TOOLS_MODULE_FINGERPRINT },
    { name: "worker-job-settlement", path: "extensions/_shared/worker-job-settlement.js", fingerprint: workerJobSettlementPackage.PI_TOOLS_MODULE_FINGERPRINT }
  ]);
  assertCurrentPackageGeneration();
  const roots = overrides.roots ?? defaultWorkerRoots();
  const runtimeRoot = overrides.runtimeRoot ?? path.dirname(roots.stateRoot);
  const now = overrides.now ?? (() => new Date());
  const random = overrides.random ?? randomUUID;
  const readProcessStartToken = overrides.readProcessStartToken ?? asyncJobProcessStartToken;
  const parentProcessStartToken = readProcessStartToken(process.pid);
  const ownerProbeIntervalMs = overrides.ownerProbeIntervalMs ?? 500;
  const ownerWaitTimeoutMs = overrides.ownerWaitTimeoutMs ?? 12_000;
  const testLaunch = overrides.launch;
  let configuredSbxPath = overrides.sbxPath ?? (testLaunch ? "/test/sbx" : undefined);
  const sbx = () => configuredSbxPath ??= resolveSbxPath();
  const sandboxRelease = overrides.sandboxRelease ?? (testLaunch ? testWorkerSandboxRelease() : undefined);
  const createSandbox = overrides.createSandbox ?? (testLaunch ? ((_sbx, reference) => ({ ...reference, createEvidenceSha256: "f".repeat(64) })) : createWorkerSandboxAsync);
  const removeSandbox = overrides.removeSandbox ?? (testLaunch ? (() => {}) : settleWorkerSandboxAsync);
  const cleanupHostLogs = overrides.cleanupHostLogs ?? planSettledWorkerHostLogs;
  const verifyHostIdentity = overrides.waitForHostIdentity ?? waitForWorkerHostIdentity;
  const probeHostIdentity = overrides.probeHostIdentity ?? probeAsyncJobProcessIdentity;
  const signalHostIdentity = overrides.signalHostIdentity ?? signalAsyncJobProcessIdentity;
  const cancellationResultGraceMs = overrides.cancellationResultGraceMs ?? 5_000;
  const cancellationEofGraceMs = overrides.cancellationEofGraceMs ?? 12_000;
  let registry: WorkerRegistry | undefined;
  let runtimeGeneration = 0;
  const parentRuntimeRegistrations = new Map<string, { runtimeId: string; generation: number }>();
  let deliveryTimer: NodeJS.Timeout | undefined;
  let observedDataVersion = 0;
  let currentContext: ExtensionContext | undefined;
  let unsubscribeActivity: (() => void) | undefined;
  let activityGeneration = 0;
  let generationMismatchNotifiedForRuntime = -1;
  const pending = new Map<string, PendingRun>();
  const active = new Map<string, ActiveRun>();
  const starting = new Map<string, { runId: string; completion: Promise<void> }>();
  const terminalRecoveries = new Map<string, Promise<"cancelled" | "failed" | "not_active">>();
  const deliveredRecovery = new Set<string>();
  let unconfirmedWarningGeneration = 0;
  const warnedUnconfirmedRuns = new Set<string>();
  const cleanupInventoryByParent = new Map<string, CleanupInventory>();
  const cleanupAnnounced = new Set<string>();
  const otherSessionSummaries=new Set<string>();
  const cleanupInFlight = new Map<string, Promise<CleanupInventory>>();
  const lifecycleClaimProbeAt = new Map<string, number>();
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
    return launchWorkerHost(api, context, { record, prompt: runtime.prompt, resultFile: runtime.resultFile, runDir: runtime.runDir, processFile: runtime.processFile, processNonce: runtime.processNonce, sandbox: runtime.sandbox, sbxPath: sbx() }).handle;
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
      const exactParent = realpathOrResolve(parent); const launchInputs = snapshotLaunchInputs(context);
      const initialized = parentRuntimeRegistrations.get(exactParent);
      if (initialized === undefined) {
        const runtimeId = randomUUID();
        runtimeGeneration = registerParentRuntimeAndRecoverClaims(getRegistry(), exactParent, runtimeId, now().toISOString(), lifecycleClaimIsLive,
          parentProcessStartToken ? { pid: process.pid, processStartToken: parentProcessStartToken } : undefined);
        parentRuntimeRegistrations.set(exactParent, { runtimeId, generation: runtimeGeneration });
      } else runtimeGeneration = initialized.generation;
      if (initialized === undefined) {
        recoverInterruptedPreparedSetAppliesForParent(getRegistry(), exactParent, runtimeGeneration, now().toISOString(), ({ runtimeGeneration: ownerGeneration }) => {
          const member = parentRuntimeMemberForGeneration(getRegistry(), exactParent, ownerGeneration);
          return !member || member.retired || parentRuntimeMemberLiveness(member) === "dead";
        });
      }
      recoverInterruptedDiscardFiles(exactParent, runtimeGeneration);
      // A pre-commit interrupted claim becomes unclaimed above; only then may old,
      // unrelated discard trash be removed without racing claimed recovery state.
      recoverAbandonedDiscardTrash(exactParent);
      recoverPreparedSetDiscards(getRegistry(), overrides.preparedRoot ?? defaultPreparedMergeRoot());
      reconcileWorkerDeliveries(getRegistry(), exactParent, sessionDeliveryIds(context));
      deliveredRecovery.clear();
      observedDataVersion = workerRegistryDataVersion(getRegistry());
      recoverDeadDeliveryClaims(exactParent);
      warnUnconfirmedCompletionSends(exactParent);
      deliverPendingCompletions(api, getRegistry(), exactParent, runtimeGeneration);
      void Promise.resolve().then(() => reconcileActiveRuns(launchInputs, exactParent)).catch(() => {});
      void refreshCleanupInventory(exactParent, context.cwd).catch(() => {});
      if (deliveryTimer) clearInterval(deliveryTimer);
      deliveryTimer = setInterval(() => {
        try {
          const current = workerRegistryDataVersion(getRegistry());
          if (current !== observedDataVersion) {
            observedDataVersion = current;
            repaintWorkerActivity(context);
          }
          recoverDeadDeliveryClaims(exactParent);
          deliverPendingCompletions(api, getRegistry(), exactParent, runtimeGeneration);
          void Promise.resolve().then(() => reconcileActiveRuns(launchInputs, exactParent)).catch(() => {});
        } catch {}
      }, 1_000);
      deliveryTimer.unref();
    } finally {
      if (generation === activityGeneration) repaintWorkerActivity(context);
    }
  });
  api.on("input", (_event, context) => repaintWorkerActivity(context));
  api.on("turn_end", (_event, context) => {
    assertCurrentPackageGeneration();
    const parentFile = context.sessionManager.getSessionFile(); if (!parentFile) return;
    const parent = realpathOrResolve(parentFile); const parentSessionId = context.sessionManager.getSessionId();
    const launches = [...pending.values()].filter((item) => item.parentSessionFile === parent && item.parentSessionId === parentSessionId);
    for (const item of launches) pending.delete(item.runId);
    for (const item of launches) beginPreparedRun(item);
  });
  api.on("agent_end", (_event, context) => {
    try {
      const parentFile = context.sessionManager.getSessionFile(); if (!parentFile) return;
      // Exact same-session history is authoritative receipt evidence. This only
      // acknowledges observed delivery IDs; it never releases, retries, or sends.
      const exactParent = realpathOrResolve(parentFile);
      reconcileWorkerDeliveries(getRegistry(), exactParent, sessionDeliveryIds(context));
      void announceCleanupAfterAgentEnd(exactParent, context.cwd);
    } catch {}
  });
  api.on("message_end", (event, context) => {
    const receipt = managedWorkerCompletionReceipt(event.message);
    if (receipt?.source !== "message") return;
    const parent = context.sessionManager.getSessionFile(); if (!parent) return;
    try {
      const delivery = pendingWorkerDeliveries(getRegistry(), realpathOrResolve(parent)).find((item) => item.deliveryId === receipt.deliveryId);
      if (delivery?.runtimeGeneration !== undefined) markWorkerDeliveryDelivered(getRegistry(), receipt.deliveryId, delivery.runtimeGeneration, now().toISOString());
    } catch {}
  });
  api.on("session_shutdown", (_event, context) => {
    activityGeneration += 1;
    if (context.mode === "tui" && context.hasUI && typeof context.ui?.setStatus === "function") context.ui.setStatus(WORKER_ACTIVITY_STATUS_KEY, undefined);
    unsubscribeActivity?.();
    unsubscribeActivity = undefined;
    currentContext = undefined;
    if (deliveryTimer) clearInterval(deliveryTimer); deliveryTimer = undefined;
    const parentFile = context.sessionManager.getSessionFile();
    if (parentFile) {
      const parent = realpathOrResolve(parentFile); const registration = parentRuntimeRegistrations.get(parent);
      if (registration) { try { retireParentRuntime(getRegistry(), parent, registration.runtimeId, now().toISOString()); } catch {} parentRuntimeRegistrations.delete(parent); }
    }
    if (active.size === 0) { registry?.close(); registry = undefined; }
  });

  api.registerMessageRenderer("worker-run", (message, _options, theme) => {
    const d = message.details as any; const recovery = d?.event === "worker_recovery_required"; const outcome = recovery ? "recovery required" : String(d?.outcome ?? "completed").replaceAll("_", " "); const role = d?.role ?? "work";
    const counts = recovery ? String(d?.status ?? "running") : `${Number(d?.repositoryCount ?? 0)} repos · ${Number(d?.artifactCount ?? 0)} artifacts`;
    return new Text(theme.fg(recovery || d?.outcome === "failed" ? "error" : d?.outcome === "cancelled" ? "warning" : "success", `${outcome} · ${role} · ${String(d?.workerId ?? "worker").slice(-8)} · ${counts}`), 0, 0);
  });
  api.registerMessageRenderer("worker-cleanup", (message, _options, theme) => {
    const d = message.details as any; const workers = Array.isArray(d?.workers) ? d.workers.length : 0; const prepared = Array.isArray(d?.preparedIds) ? d.preparedIds.length : 0;
    return new Text(theme.fg("warning", `cleanup due · ${workers} workers · ${prepared} prepared sets`), 0, 0);
  });

  const workerRunTool = defineTool({
    name: "worker_run", label: "Run Workers",
    description: "Start durable work, review, or integration workers, or resume previous workers. The `runs` list can launch or resume up to eight workers in one call. Each new worker receives its role-specific inputs, private workspace, retained session, and allowed Beads tasks; resumed workers preserve their exact role, workspace, session, and model selection. Runs execute asynchronously and deliver structured results when they settle.",
    promptSnippet: "Start work, review, or integration workers, or resume previous workers.",
    promptGuidelines: [
      "Use `start` with role `work` for substantial self-contained assignments or substantial independent work that benefits from parallel execution; handle quick, tightly sequential, or parent-context-heavy work directly. Treat only work/integration outcome `completed` as ready for review, and start an independent `review` before relying on it; the worker system selects a different provider or fails before launch. On `request_changes`, resume the subject with the findings and review its next completed run, with at most one correction/re-review cycle by default. Use an `integration` start after `worker_merge_test` reports conflicts when delegating resolution is preferable to resolving them yourself. Use `resume` for answers, corrections, or follow-up on the same worker, and start a replacement only after intentionally abandoning the previous worker. Batch only independent runs.",
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
      assertCurrentPackageGeneration();
      throwIfAborted(signal);
      const parentSessionFile = requireParentSession(context);
      assertCurrentRuntimeAuthority(parentSessionFile);
      const planned = preflightBatch(params, context, parentSessionFile);
      const operation = plannedRunOperation(planned);
      const timestamp = now().toISOString();
      try {
        for (const plan of planned) if (plan.role === "integration" && plan.consumedPrepared && plan.preparedId) assertIntegrationTargetsCurrent(trustedPreparedSet(getRegistry(), parentSessionFile, plan.preparedId));
        const items: WorkerBatchCreateItem[] = planned.map((plan) => {
          const session = plan.runRuntime.pendingWorkSessionId ? undefined : sessionIdentity(plan.paths);
          const sessionStartLine = session ? plan.sessionStartLine ?? (plan.newWorker ? 2 : undefined) : undefined;
          if (session && sessionStartLine === undefined) throw new Error(`Worker ${plan.workerId} has no retained session boundary for resume.`);
          const run: WorkerRunRecord = { runId: plan.runId, workerId: plan.workerId, status: "queued", taskIds: plan.taskIds, modelSelection: plan.modelSelection,
            completionDelivery: plan.request.completionDelivery ?? "steer", ...(plan.binding ? { binding: plan.binding } : {}), jobId: plan.jobId,
            stdoutLog: path.join(plan.runRuntime.runDir, "launch-stdout.log"), stderrLog: path.join(plan.runRuntime.runDir, "launch-stderr.log"), ...(sessionStartLine === undefined ? {} : { sessionStartLine }),
            repositories: [], artifacts: [], errors: [], runtime: plan.runRuntime, createdAt: timestamp };
          if (plan.newWorker) return { kind: "new", worker: { workerId: plan.workerId, parentSessionFile, role: plan.role, status: "queued", activeRunId: plan.runId,
            taskIds: plan.taskIds, modelSelection: plan.modelSelection, ...(session ? { sessionId: session.sessionId, sessionFile: session.sessionFile } : {}),
            workspaceRoot: plan.paths.workspaceRoot, runtime: plan.workerRuntime, createdAt: timestamp, updatedAt: timestamp }, run };
          return { kind: "resume", workerId: plan.workerId, expectedVersion: plan.expectedVersion!, taskIds: plan.taskIds, runtime: plan.workerRuntime, run };
        });
        await overrides.beforeCreateRunBatch?.();
        createWorkerRunBatch(getRegistry(), {
          items,
          reviewLeases: planned.filter((plan) => plan.role === "review").map((plan) => ({ subjectWorkerId: (plan.binding as any).reviewedWorkerId as string, reviewerWorkerId: plan.workerId, reviewedRunId: plan.reviewedRunId! })),
          consumedPrepared: planned.filter((plan) => plan.consumedPrepared).map((plan) => ({ preparedId: plan.preparedId!, parentSessionFile })),
          authority: { parentSessionFile, runtimeGeneration }, now: timestamp
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
    description: "List and manage durable workers. Use `list`, `runs`, and `get` for retained lifecycle evidence; `inventory` for bounded Beads-derived cleanup classes; `preserve` for explicit atomic non-Git artifact copies; `cancel` to stop active work; and exact batched `discard` for idle current-session workers or prepared sets after complete preflight.",
    promptSnippet: "Inspect durable workers, derive cleanup inventory, preserve valuable artifacts, cancel active work, or explicitly discard exact idle state.",
    promptGuidelines: [
      "Do not poll workers; rely on asynchronous completion notifications. Use `get` with exact identities for evidence, `list` for discovery, and `runs` only to locate previous runs. Cleanup is never automatic: inspect `inventory`, preserve valuable non-Git artifacts, and use exact batched `discard` only when no review, resume, merge, recovery, or unacknowledged artifact access is needed. Cross-session deletion remains preview-bound through /worker:cleanup.",
      inputJsonSchemaGuideline("worker_control", WorkerControlParamsV2), outputJsonSchemaGuideline("worker_control", RetainedToolOutputSchemas.worker_control),
      "worker_control constraints: Only result content is provider-visible; details remain internal."
    ],
    parameters: WorkerControlParamsV2, executionMode: "sequential" as const,
    renderCall: (args: unknown, theme: any) => compactCall(theme, workerControlCallLabel(args)),
    renderResult: (result: AgentToolResult<any>, _options: unknown, theme: any) => compactResult(theme, result, "worker control"),
    execute: async (_callId: string, params: WorkerControlInputV2, signal: AbortSignal, _update: any, context: ExtensionContext): Promise<AgentToolResult<any>> => {
      assertCurrentPackageGeneration();
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
      assertCurrentPackageGeneration();
      throwIfAborted(signal); const parent = requireParentSession(context);
      const resolved = params.repositories.map((request) => ({ ...request, candidateRef: request.candidateRef ?? "HEAD" }));
      const set = prepareWorkerMerges(parent, resolved, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, sourceForCandidate: managedCandidateWarnings(parent) });
      const taskIds = [...new Set(set.repositories.flatMap((repository) => repository.source ? (getWorker(getRegistry(), repository.source.workerId)?.taskIds ?? []) : []))];
      storePreparedSet(getRegistry(), { preparedId: set.preparedId, parentSessionFile: parent, status: set.status, order: set.order, taskIds, repositories: set.repositories.map((repository) => ({ ...repository, taskIds: repository.source ? (getWorker(getRegistry(), repository.source.workerId)?.taskIds ?? []) : [] })), createdAt: set.createdAt });
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
      assertCurrentPackageGeneration();
      throwIfAborted(signal); const parent = requireParentSession(context); const trustedSet = trustedPreparedSet(getRegistry(), parent, params.preparedId); if (!["ready", "partial", "failed"].includes(trustedSet.status)) throw new Error(`Prepared set ${params.preparedId} is not ready.`);
      const operation = mergeOperation(trustedSet.repositories);
      const nonce = claimNonce(); if (!claimPreparedSetApply(getRegistry(), params.preparedId, parent, nonce, now().toISOString())) throw new Error(`Prepared set ${params.preparedId} is already being applied or changed state.`);
      try { const result = applyPreparedWorkerMerges(parent, params.preparedId, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, sourceForCandidate: managedCandidateWarnings(parent), trustedSet }); finishPreparedSetApply(getRegistry(), params.preparedId, parent, nonce, result.status, now().toISOString()); rememberOperationSnapshot(toolCallId, operation ? { scope: "worker_merge_apply", preparedId: result.preparedId, operation } : undefined); return resultText(`${result.status} · ${result.repositories.filter((item) => item.status === "applied").length} applied`, result); }
      catch (error) { releasePreparedSetApply(getRegistry(), params.preparedId, parent, nonce, now().toISOString()); throw error; }
    }
  }));

  registerCommands();

  function cleanupSupersededPreparedSets(current: ReturnType<typeof prepareWorkerMerges>): void {
    const root=path.resolve(overrides.preparedRoot??defaultPreparedMergeRoot());const currentTargets=current.repositories.map((item)=>`${item.targetRepo}\0${item.targetRef}`).sort().join("\n");const database=getRegistry().database;const removed:string[]=[];database.exec("BEGIN IMMEDIATE");try{const rows=database.prepare("SELECT prepared_id,status FROM prepared_sets WHERE parent_session_file=? AND prepared_id<>? AND apply_nonce IS NULL AND status IN ('ready','resolution_required','partial','failed')").all(current.parentSessionFile,current.preparedId) as Array<{prepared_id:string;status:string}>;for(const row of rows){try{const prior=readPreparedSetRecord(getRegistry(),current.parentSessionFile,row.prepared_id);const targets=prior.repositories.map((item)=>`${item.targetRepo}\0${item.targetRef}`).sort().join("\n");if(targets!==currentTargets)continue;const changed=database.prepare("UPDATE prepared_sets SET status='superseded',updated_at=? WHERE prepared_id=? AND parent_session_file=? AND status=? AND apply_nonce IS NULL").run(now().toISOString(),row.prepared_id,current.parentSessionFile,row.status);if(Number(changed.changes)===1)removed.push(row.prepared_id);}catch{}}database.exec("COMMIT");}catch(error){database.exec("ROLLBACK");throw error;}for(const preparedId of removed)rmSync(path.join(root,preparedId),{recursive:true,force:true});
  }

  function preflightBatch(params: WorkerRunInputV2, context: ExtensionContext, parentSessionFile: string): PlannedRun[] {
    const plans: PlannedRun[] = []; const resumed = new Set<string>(); let pendingReservation: { paths: WorkerPaths; runId: string } | undefined;
    try {
      for (const request of params.runs) {
        validateRunRequestBounds(request);
        if (request.action === "resume") {
          if (resumed.has(request.workerId)) throw new Error(`Worker ${request.workerId} cannot be resumed twice in one batch.`); resumed.add(request.workerId);
          const worker = ownedWorker(request.workerId, parentSessionFile); const paths = currentWorkerPaths(worker); assertWorkerStoragePaths(paths); if (worker.status !== "idle" || worker.operationKind) throw new Error(`Worker ${worker.workerId} is not idle.`);
          if (worker.runtime && typeof worker.runtime.adoptedFromSession === "string") throw new Error(`Adopted worker ${worker.workerId} may be inspected, preserved, or discarded, but not resumed.`);
          if (worker.reviewedByWorkerId) throw new Error(`Worker ${worker.workerId} is leased to active reviewer ${worker.reviewedByWorkerId}.`);
          if (worker.role === "review" && request.additionalTaskIds?.length) throw new Error("Review workers cannot receive additional Beads tasks.");
          if (!worker.sessionId || !worker.sessionFile) {
            if (worker.role !== "work") throw new Error(`Worker ${worker.workerId} has no retained session.`);
          } else verifyRetainedSession(worker, paths);
          const latest = worker.latestRunId ? getWorkerRun(getRegistry(), worker.workerId, worker.latestRunId) : undefined;
          const sessionStartLine = worker.sessionFile ? nextRetainedRunStart(worker, latest) : undefined;
          const binding = latest?.binding; provisionWorkerPaths(paths);
          const role = worker.role;
          const retainedInputs = validateAdditionalInputs({ values: request.additionalInputs, existing: runtimeInputs(worker), role, workspaceRoot: paths.workspaceRoot, runtimeRoot });
          let contextFile: string | undefined; let reviewSubjectWorkspace: string | undefined; let reviewedRunId: string | undefined; let preparedId: string | undefined; let operationRepositories: Array<Record<string, unknown>> | undefined;
          const pendingWorkSessionId = !worker.sessionId && role === "work" ? randomUUID() : undefined;
          const reservedRunId = createWorkerRunId(now(), random());
          pendingReservation = { paths, runId: reservedRunId };
          const inputs = snapshotAdditionalInputs(runInputDirectory(paths, reservedRunId), retainedInputs);
          const mounts: WorkerSandboxMount[] = inputMounts(inputs);
          let modelSelection = worker.modelSelection!;
          if (role === "review") {
            if (!binding || !("reviewedRunId" in binding)) throw new Error(`Review worker ${worker.workerId} lost its reviewed-run binding.`);
            const subject = reviewSubject(binding.reviewedRunId, parentSessionFile, worker.workerId); reviewedRunId = binding.reviewedRunId; reviewSubjectWorkspace = subject.worker.workspaceRoot;
            if (!modelSelection) throw new Error(`Review worker ${worker.workerId} has no model provider provenance.`);
            modelSelection = resolveModel(role, modelSelection, context, reviewedRunProvider(subject.run));
            contextFile = writeReviewContext(runInputDirectory(paths, reservedRunId), currentWorkerPaths(subject.worker), request.workerId, reservedRunId, subject.worker, subject.run, inputs);
            mounts.splice(0, mounts.length, { source: path.dirname(contextFile), readOnly: true });
          } else if (role === "integration") {
            if (!binding || !("preparedId" in binding)) throw new Error(`Integration worker ${worker.workerId} lost its prepared-set binding.`); preparedId = binding.preparedId;
            const trustedSet = trustedPreparedSet(getRegistry(), parentSessionFile, preparedId, paths.workspaceRoot); operationRepositories = snapshotOperationRepositories(trustedSet.repositories);
            contextFile = writeIntegrationContext(paths, runInputDirectory(paths, reservedRunId), trustedSet, inputs, true); mounts.splice(0, mounts.length, { source: path.dirname(contextFile), readOnly: true });
          }
          const retained = retainedWorkerRuntime(worker);
          if (role === "work") {
            const prior = retained.cacheLineage; const priorFingerprint = prior?.mode === "eligible" ? prior.runtimeFingerprint : undefined; const lineageDir = prepareCacheLineageDirectory(paths, reservedRunId);
            if (prior?.mode === "eligible") for (const file of [prior.snapshotFile, prior.summaryFile, ...(existsSync(prior.adoptionFile) ? [prior.adoptionFile] : [])]) assertContainedPathWithoutSymlinks(paths.stateDir, file, "retained cache-lineage evidence");
            retained.cacheLineage = prior ? continueWorkerCacheLineage(prior, lineageDir, reservedRunId) : undefined;
            retained.cacheLineage ??= { ...prepareWorkerCacheLineage({ stateRoot: roots.stateRoot, workerStateDir: lineageDir, parentSessionFile, parentSessionId: context.sessionManager.getSessionId(), route: parseWorkerModelSelection(worker.modelSelection!), now: now() }), hostGeneration: reservedRunId };
            if (retained.cacheLineage.mode === "eligible" && priorFingerprint) retained.cacheLineage.runtimeFingerprint = priorFingerprint;
          }
          const plan = finishPlanSafely({ request, role, workerId: worker.workerId, runId: reservedRunId, paths, promptInputs: inputs, taskIds: unique([...worker.taskIds, ...(request.additionalTaskIds ?? [])]), modelSelection, binding, workerRuntime: { version: 2, inputs: retainedInputs, ...retained }, newWorker: false, ...(sessionStartLine === undefined ? {} : { sessionStartLine }), expectedVersion: worker.version, contextFile, reviewSubjectWorkspace, reviewedRunId, preparedId, operationRepositories, pendingWorkSessionId, mounts, parentSessionFile, context });
          plans.push(plan); pendingReservation = undefined; continue;
        }
        const role = request.role;
        const workerId = createWorkerId(now(), random()); const paths = workerPaths(roots, workerId); const reservedRunId = createWorkerRunId(now(), random());
        const taskIds = role === "review" ? [] : unique(request.taskIds);
        let subject: ReturnType<typeof reviewSubject> | undefined;
        let repositoryBaselines: Array<{ path: string; resolvedCommit: string }> | undefined;
        let cacheLineage: WorkerCacheLineageRecord | undefined;
        let integrationSet: ReturnType<typeof readPreparedMergeSet> | undefined;
        let inputs: RetainedInput[] = [];
        if (role === "work") repositoryBaselines = (request.repositoryBaselines ?? []).map((item) => { const repo = canonicalRepository(item.path); return { path: repo, resolvedCommit: trustedGit(repo, ["rev-parse", `${item.revision ?? "HEAD"}^{commit}`]).trim() }; });
        else if (role === "review") {
          subject = reviewSubject(request.reviewedRunId, parentSessionFile);
          inputs = validateAdditionalInputs({ values: request.additionalInputs, role, workspaceRoot: paths.workspaceRoot, runtimeRoot });
        }
        else { integrationSet = trustedPreparedSet(getRegistry(), parentSessionFile, request.preparedId); inputs = validateAdditionalInputs({ values: request.additionalInputs, role, workspaceRoot: paths.workspaceRoot, runtimeRoot }); }
        const excludedProvider = subject ? reviewedRunProvider(subject.run) : undefined;
        const modelSelection = resolveModel(role, role === "work" ? request.modelSelection : undefined, context, excludedProvider);
        provisionWorkerPaths(paths);
        try { if (role === "work") cacheLineage = { ...prepareWorkerCacheLineage({ stateRoot: roots.stateRoot, workerStateDir: prepareCacheLineageDirectory(paths, reservedRunId), parentSessionFile, parentSessionId: context.sessionManager.getSessionId(), route: parseWorkerModelSelection(modelSelection), now: now() }), hostGeneration: reservedRunId }; }
        catch (error) { rmSync(paths.stateDir, { recursive: true, force: true }); throw error; }
        let binding: WorkerRunRecord["binding"]; let reviewedRunId: string | undefined; let preparedId: string | undefined; let consumedPrepared = false;
        let contextFile: string | undefined; let reviewSubjectWorkspace: string | undefined; let mounts: WorkerSandboxMount[] = [];
        try {
          const pendingWorkSessionId = role === "work" ? randomUUID() : undefined;
          const mountedInputs = snapshotAdditionalInputs(runInputDirectory(paths, reservedRunId), inputs);
          if (role === "review") {
            reviewedRunId = request.reviewedRunId; reviewSubjectWorkspace = subject!.worker.workspaceRoot; binding = { reviewedWorkerId: subject!.worker.workerId, reviewedRunId };
            createWorkerSession({ workspaceRoot: paths.workspaceRoot, sessionDir: paths.sessionDir, sessionId: randomUUID() });
            contextFile = writeReviewContext(runInputDirectory(paths, reservedRunId), currentWorkerPaths(subject!.worker), workerId, reservedRunId, subject!.worker, subject!.run, mountedInputs);
            mounts = [{ source: path.dirname(contextFile), readOnly: true }];
          } else if (role === "integration") {
            preparedId = request.preparedId; const trustedSet = integrationSet!; const moved = consumePreparedMergeSet(parentSessionFile, preparedId, workerId, paths.workspaceRoot, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, trustedSet }); consumedPrepared = true; binding = { preparedId };
            createWorkerSession({ workspaceRoot: paths.workspaceRoot, sessionDir: paths.sessionDir, sessionId: randomUUID() });
            contextFile = writeIntegrationContext(paths, runInputDirectory(paths, reservedRunId), moved, mountedInputs, false); mounts = [{ source: path.dirname(contextFile), readOnly: true }];
          }
          const plan = finishPlan({ request, role, workerId, ...(reservedRunId ? { runId: reservedRunId } : {}), paths, promptInputs: mountedInputs, taskIds: role === "review" ? subject!.run.taskIds : taskIds, modelSelection, binding,
            workerRuntime: { version: 2, inputs, ...(repositoryBaselines ? { repositoryBaselines } : {}), ...(cacheLineage ? { cacheLineage } : {}) }, newWorker: true, contextFile, reviewSubjectWorkspace, reviewedRunId, preparedId, consumedPrepared, operationRepositories: snapshotOperationRepositories(integrationSet?.repositories), pendingWorkSessionId, mounts, parentSessionFile, context });
          plans.push(plan);
        } catch (error) {
          if (consumedPrepared && preparedId) { try { restoreConsumedPreparedMergeSet(parentSessionFile, preparedId, paths.workspaceRoot, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, trustedSet: trustedPreparedSet(getRegistry(), parentSessionFile, preparedId) }); } catch {} }
          removeOwnerTree(paths.workerDir);
          throw error;
        }
      }
      return plans;
    } catch (error) { if (pendingReservation) cleanupReservedRun(pendingReservation.paths, pendingReservation.runId); rollbackPlans(plans, parentSessionFile); throw error; }
  }

  function cleanupReservedRun(paths: WorkerPaths, runId: string): void {
    removeOwnerTree(path.join(paths.supervisionDir, "runs", runId));
    removeOwnerTree(runInputDirectory(paths, runId, false));
    removeOwnerTree(path.join(paths.stateDir, "cache-lineage", runId));
  }

  function finishPlanSafely(input: Omit<PlannedRun, "runId" | "jobId" | "runRuntime"> & { runId?: string; contextFile?: string; reviewSubjectWorkspace?: string; pendingWorkSessionId?: string; promptInputs: RetainedInput[]; mounts: WorkerSandboxMount[]; parentSessionFile: string; context: ExtensionContext }): PlannedRun {
    try { return finishPlan(input); } catch (error) {
      if (input.consumedPrepared && input.preparedId) { try { restoreConsumedPreparedMergeSet(input.parentSessionFile, input.preparedId, input.paths.workspaceRoot, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, trustedSet: trustedPreparedSet(getRegistry(), input.parentSessionFile, input.preparedId) }); } catch {} }
      if (input.newWorker) removeOwnerTree(input.paths.workerDir);
      else if (input.runId) cleanupReservedRun(input.paths, input.runId);
      throw error;
    }
  }

  function finishPlan(input: Omit<PlannedRun, "runId" | "jobId" | "runRuntime"> & { runId?: string; contextFile?: string; reviewSubjectWorkspace?: string; pendingWorkSessionId?: string; promptInputs: RetainedInput[]; mounts: WorkerSandboxMount[]; parentSessionFile: string; context: ExtensionContext }): PlannedRun {
    assertWorkerStoragePaths(input.paths);
    const runId = input.runId ?? createWorkerRunId(now(), random()); const jobId = createAsyncJobId(now(), random());
    const runDir = path.join(input.paths.supervisionDir, "runs", runId); mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const nonce = randomUUID();
    const codeRoot = overrides.codeRoot ?? (testLaunch ? input.context.cwd : path.join(homedir(), "Code"));
    const hostRoot = path.resolve(input.paths.supervisionDir);
    if (input.mounts.some((mount) => { const source=path.resolve(mount.source); return source===hostRoot||source.startsWith(`${hostRoot}${path.sep}`); })) throw new Error("Worker Sandbox mounts cannot expose host-only supervision state.");
    const sandbox = planWorkerSandbox({ workerId: input.workerId, runId, creationNonce: nonce, workerRoot: input.paths.stateDir, workingDirectory: input.paths.workspaceRoot, codeRoot, mounts: input.mounts.map((mount) => ({ source: mount.source, ...(mount.readOnly ? { readOnly: true } : {}) })), ...(input.reviewSubjectWorkspace ? { reviewSubjectWorkspace: input.reviewSubjectWorkspace } : {}), ...(sandboxRelease ? { release: sandboxRelease } : {}) });
    const runtimeFingerprint = createHash("sha256").update(JSON.stringify({ imageDigest: sandbox.imageDigest, kitSha256: sandbox.kitSha256, sbxVersion: sandbox.sbxVersion, sbxBuildCommit: sandbox.sbxBuildCommit, templateId: sandbox.templateId, templateRepository: sandbox.templateRepository, templateTag: sandbox.templateTag, templateFlavor: sandbox.templateFlavor, stagedLockSha256: sandbox.stagedLockSha256, resourceManifestSha256: sandbox.resourceManifestSha256, runtimeProvenanceSha256: sandbox.runtimeProvenanceSha256, revisions: sandbox.revisions })).digest("hex");
    const roleInstructions = roleInstructionsFor(input.role);
    const cacheBoundaryFingerprint = createHash("sha256").update(JSON.stringify({ runtimeFingerprint, role: input.role, modelSelection: input.modelSelection, roleInstructions, taskIds: [...input.taskIds].sort(), repositoryBaselines: input.workerRuntime.repositoryBaselines ?? [] })).digest("hex");
    if (input.workerRuntime.cacheLineage?.mode === "eligible") input.workerRuntime.cacheLineage = input.workerRuntime.cacheLineage.runtimeFingerprint && input.workerRuntime.cacheLineage.runtimeFingerprint !== cacheBoundaryFingerprint ? { version: 1, mode: "fresh", reason: "Trusted runtime, tool, role, model, assignment, or fork boundary changed; prior cache generation was retired.", hostGeneration: runId } : { ...input.workerRuntime.cacheLineage, runtimeFingerprint: cacheBoundaryFingerprint };
    const request = input.request;
    const previousRun = !input.newWorker ? getWorkerRun(getRegistry(), input.workerId, getWorker(getRegistry(), input.workerId)?.latestRunId ?? "") : undefined;
    const previousRuntime = previousRun?.runtime as RunRuntime | undefined;
    if (previousRuntime?.releaseOrdinal !== undefined && sandbox.releaseOrdinal < previousRuntime.releaseOrdinal) throw new Error(`Worker runtime downgrade refused: release ${sandbox.releaseOrdinal} is older than retained release ${previousRuntime.releaseOrdinal}.`);
    const legacyRuntimeTransition = Boolean(previousRun && (!previousRuntime || previousRuntime.version !== 4));
    const runtimeChanged = Boolean(previousRuntime?.runtimeFingerprint && previousRuntime.runtimeFingerprint !== runtimeFingerprint);
    const interruptedPreviously = previousRun?.outcome === "cancelled" || (previousRun?.outcome === "failed" && previousRun.outcomeSource === "system");
    const interruptionWarnings = interruptedPreviously ? inspectInterruptedGitState(input.paths.workspaceRoot) : [];
    const prompt = renderWorkerRuntimePrompt(input.role, { workerId: input.workerId, runId, workspaceRoot: input.paths.workspaceRoot,
      codeRoot, taskIds: input.taskIds, roleInstructions,
      instructions: request.instructions, repositoryBaselines: input.workerRuntime.repositoryBaselines, additionalInputs: immutablePromptInputs(input.promptInputs),
      reviewSubjectPath: input.role === "review" ? sandbox.reviewOverlay?.mergedDirectory : undefined, reviewContextPath: input.role === "review" ? input.contextFile : undefined, integrationContextPath: input.role === "integration" ? input.contextFile : undefined, resumed: !input.newWorker,
      cacheLineageMarker: input.workerRuntime.cacheLineage?.mode === "eligible" ? input.workerRuntime.cacheLineage.marker : undefined, initialSession: Boolean(input.pendingWorkSessionId),
      cancelledPreviously: interruptedPreviously, interruptionWarnings, runtimeChange: legacyRuntimeTransition ? "This is the first version-4 Docker Sandbox run after retained legacy metadata; the old runtime was not reattached or trusted, a fresh immutable Sandbox was created, and executable contracts were refreshed." : runtimeChanged ? `Approved runtime changed from ${previousRuntime!.runtimeFingerprint.slice(0, 12)} to ${runtimeFingerprint.slice(0, 12)} (release ${previousRuntime!.releaseOrdinal} -> ${sandbox.releaseOrdinal}); executable contracts were refreshed and cache lineage is fresh.` : undefined });
    const runRuntime: RunRuntime = { version: 4, prompt, runDir, resultFile: path.join(runDir, "result.json"), settledFile: path.join(runDir, "settled.json"), processFile: path.join(runDir, "host-process.json"), processNonce: nonce,
      sandbox, runtimeFingerprint, releaseOrdinal: sandbox.releaseOrdinal, ...(input.contextFile ? { contextFile: input.contextFile } : {}), inputs: input.workerRuntime.inputs,
      repositoryBefore: snapshotWorkerRepositories(input.paths.workspaceRoot), launchProjectCwd: path.resolve(input.context.cwd), parentSessionId: input.context.sessionManager.getSessionId(),
      ...(input.pendingWorkSessionId ? { pendingWorkSessionId: input.pendingWorkSessionId } : {}), ...(interruptionWarnings.length ? { interruptionWarnings } : {}) };
    return { request, role: input.role, workerId: input.workerId, runId, jobId, paths: input.paths, taskIds: input.taskIds, modelSelection: input.modelSelection, ...(input.binding ? { binding: input.binding } : {}), workerRuntime: input.workerRuntime, runRuntime,
      newWorker: input.newWorker, ...(input.sessionStartLine === undefined ? {} : { sessionStartLine: input.sessionStartLine }), ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }), ...(input.reviewedRunId ? { reviewedRunId: input.reviewedRunId } : {}), ...(input.preparedId ? { preparedId: input.preparedId } : {}), ...(input.consumedPrepared ? { consumedPrepared: true } : {}), ...(input.operationRepositories ? { operationRepositories: input.operationRepositories } : {}) };
  }

  function rollbackPlans(plans: PlannedRun[], parentSessionFile: string): void {
    for (const plan of [...plans].reverse()) {
      if (plan.consumedPrepared && plan.preparedId) { try { restoreConsumedPreparedMergeSet(parentSessionFile, plan.preparedId, plan.paths.workspaceRoot, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, trustedSet: trustedPreparedSet(getRegistry(), parentSessionFile, plan.preparedId) }); } catch {} }
      if (plan.newWorker) removeOwnerTree(plan.paths.workerDir);
      else { removeOwnerTree(plan.runRuntime.runDir); if (plan.runRuntime.contextFile) removeOwnerTree(path.dirname(plan.runRuntime.contextFile)); }
    }
  }

  function parentRuntimeMemberLiveness(member: ParentRuntimeMember): AsyncJobProcessIdentityLiveness {
    if (member.retired) return "dead";
    if (member.pid <= 0 || !member.processStartToken) return "unknown";
    const observed = member.pid === process.pid ? parentProcessStartToken : readProcessStartToken(member.pid);
    if (observed === member.processStartToken) return "alive";
    if (observed) return "dead";
    try { process.kill(member.pid, 0); return "unknown"; }
    catch (error) { return error && typeof error === "object" && "code" in error && error.code === "ESRCH" ? "dead" : "unknown"; }
  }

  function ensureCurrentRuntimeAuthority(parentSessionFile: string): "current" | "superseded" | "unknown" {
    const registration = parentRuntimeRegistrations.get(parentSessionFile);
    if (!registration) return "superseded";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = currentParentRuntime(getRegistry(), parentSessionFile);
      if (!current) return "unknown";
      if (current.generation === registration.generation && current.runtimeId === registration.runtimeId) { runtimeGeneration = registration.generation; return "current"; }
      if (!parentProcessStartToken) return "unknown";
      let uncertain = false;
      const observed = latestParentRuntimeMembers(getRegistry(), parentSessionFile, registration.generation, current.generation);
      if (current.runtimeId !== registration.runtimeId && !observed.some((member) => member.generation === current.generation && member.runtimeId === current.runtimeId)) return "unknown";
      const newer = observed.filter((member) => member.runtimeId !== registration.runtimeId);
      for (const member of newer) {
        const state = parentRuntimeMemberLiveness(member);
        if (state === "alive") return "superseded";
        if (state === "unknown") uncertain = true;
      }
      if (uncertain) return "unknown";
      const identity: ParentRuntimeIdentity = { runtimeId: registration.runtimeId, pid: process.pid, processStartToken: parentProcessStartToken };
      const promoted = promoteParentRuntime(getRegistry(), { parentSessionFile, expectedGeneration: current.generation, expectedRuntimeId: current.runtimeId, identity, now: now().toISOString() });
      if (promoted !== undefined) { registration.generation = promoted; runtimeGeneration = promoted; warnUnconfirmedCompletionSends(parentSessionFile); return "current"; }
    }
    return "superseded";
  }

  function assertCurrentRuntimeAuthority(parentSessionFile: string): void {
    const authority = ensureCurrentRuntimeAuthority(parentSessionFile);
    if (authority === "current") return;
    if (authority === "unknown") throw new Error("Parent runtime authority is uncertain; restart or reload this session before starting workers.");
    throw new Error("Parent runtime was superseded; reload this session to regain worker lifecycle authority.");
  }

  function snapshotLaunchInputs(context: ExtensionContext): { projectCwd: string; parentSessionId: string } {
    return { projectCwd: path.resolve(context.cwd), parentSessionId: context.sessionManager.getSessionId() };
  }

  function immutableLaunchContext(runtime: RunRuntime): ExtensionContext {
    if (!runtime.launchProjectCwd || !runtime.parentSessionId) throw new WorkerContainmentError("Worker launch inputs were not durably snapshotted.");
    const projectCwd = runtime.launchProjectCwd; const parentSessionId = runtime.parentSessionId;
    const sessionManager = Object.freeze({ getSessionId: () => parentSessionId });
    return Object.freeze({ cwd: projectCwd, sessionManager, isIdle: () => false }) as unknown as ExtensionContext;
  }

  function beginPreparedRun(item: PendingRun): void {
    if (starting.get(item.workerId)?.runId === item.runId) return;
    // Calling an async function executes synchronously until its first await. Put the
    // whole launch path behind a microtask so turn_end/session_start never perform
    // the session fork, Sandbox setup, or host launch inline.
    const completion = Promise.resolve().then(() => startPreparedRun(item));
    starting.set(item.workerId, { runId: item.runId, completion });
    void completion.finally(() => { if (starting.get(item.workerId)?.runId === item.runId) starting.delete(item.workerId); }).catch((error) => recordRecovery(item.workerId, item.runId, error));
  }

  async function startPreparedRun(item: PendingRun): Promise<void> {
    let nonce: string;
    try { nonce = lifecycleClaimNonce(); }
    catch (error) { requestWorkerFailure(getRegistry(), item.workerId, item.runId, sanitizeError(error), now().toISOString(), runtimeGeneration); return; }
    if (!claimWorkerRun(getRegistry(), item.workerId, item.runId, "launch", nonce, ["queued"], runtimeGeneration)) return;
    let handle: ManagedAsyncJobHandle | undefined; let handleCancellationAttempted = false; let operationAdmission: string | undefined;
    try {
      assertCurrentPackageGeneration();
      operationAdmission = beginLifecycleAdmission(item.runtime, item.workerId, item.runId, "launch", nonce);
      persistClaimedRuntime(item.runtime, item.workerId, item.runId, "launch", nonce);
      let worker = getWorker(getRegistry(), item.workerId)!; const run = getWorkerRun(getRegistry(), item.workerId, item.runId)!; const paths = currentWorkerPaths(worker);
      if ((!worker.sessionId || !worker.sessionFile) && worker.role === "work" && item.runtime.pendingWorkSessionId) {
        const pendingSessionId = item.runtime.pendingWorkSessionId;
        const forked = await launchSideEffect(item.workerId, item.runId, nonce, () => forkWorkerSession({ parentSessionFile: worker.parentSessionFile, workspaceRoot: worker.workspaceRoot, sessionDir: paths.sessionDir, sessionId: pendingSessionId }));
        await launchSideEffect(item.workerId, item.runId, nonce, () => updateWorkerRuntimeMetadata(getRegistry(), worker.workerId, { sessionId: forked.sessionId, sessionFile: forked.sessionFile, updatedAt: now().toISOString() }));
        worker = getWorker(getRegistry(), item.workerId)!;
      }
      const sessionId = worker.sessionId; const sessionFile = worker.sessionFile;
      if (!sessionId || !sessionFile) throw new Error(`Worker ${worker.workerId} session provisioning failed.`);
      if (worker.role === "work") verifyWorkerSession({ sessionFile, sessionDir: paths.sessionDir, sessionId, workspaceRoot: worker.workspaceRoot, parentSessionFile: worker.parentSessionFile });
      const sessionStartLine = requiredRunStartLine(run, item.runtime, sessionFile);
      const record: WorkerLaunchRecord = { workerId: worker.workerId, runId: run.runId, jobId: run.jobId!, sessionId, sessionFile, workerRoot: paths.stateDir, workspaceRoot: worker.workspaceRoot, taskIds: run.taskIds, role: worker.role, modelSelection: worker.modelSelection!, ...(worker.runtime?.cacheLineage ? { cacheLineage: worker.runtime.cacheLineage as WorkerCacheLineageRecord } : {}) };
      assertLaunchClaimOpen(item.workerId, item.runId, nonce);
      item.runtime.sandbox = await launchSideEffect(item.workerId, item.runId, nonce, () => createSandbox(sbx(), item.runtime.sandbox));
      writeReadonlyJson(path.join(item.runtime.runDir, "sandbox-created.json"), { version: 1, workerId: item.workerId, runId: item.runId, creationNonce: item.runtime.sandbox.creationNonce, sandboxName: item.runtime.sandbox.sandboxName, sandboxId: item.runtime.sandbox.observedSandboxId, imageReference: item.runtime.sandbox.imageReference, imageDigest: item.runtime.sandbox.imageDigest, kitReference: item.runtime.sandbox.kitReference, kitSha256: item.runtime.sandbox.kitSha256, sbxVersion: item.runtime.sandbox.sbxVersion, sbxBuildCommit: item.runtime.sandbox.sbxBuildCommit, templateId: item.runtime.sandbox.templateId, templateRepository: item.runtime.sandbox.templateRepository, templateTag: item.runtime.sandbox.templateTag, templateFlavor: item.runtime.sandbox.templateFlavor, createEvidenceSha256: item.runtime.sandbox.createEvidenceSha256, inspectEvidenceSha256: item.runtime.sandbox.inspectEvidenceSha256, sbxVersionEvidenceSha256: item.runtime.sandbox.sbxVersionEvidenceSha256, stagedLockSha256: item.runtime.sandbox.stagedLockSha256, runtimeProvenanceSha256: item.runtime.sandbox.runtimeProvenanceSha256, observedRuntimeSha256: item.runtime.sandbox.observedRuntimeSha256, observedCpu: item.runtime.sandbox.observedCpu, observedMemoryBytes: item.runtime.sandbox.observedMemoryBytes, reviewOverlay: item.runtime.sandbox.reviewOverlay, observedAt: now().toISOString() });
      assertLaunchClaimOpen(item.workerId, item.runId, nonce);
      persistClaimedRuntime(item.runtime, item.workerId, item.runId, "launch", nonce); assertLaunchClaimOpen(item.workerId, item.runId, nonce);
      assertLaunchClaimOpen(item.workerId, item.runId, nonce);
      handle = launch(immutableLaunchContext(item.runtime), record, item.runtime);
      try { assertLaunchClaimOpen(item.workerId, item.runId, nonce); }
      catch (error) { handleCancellationAttempted = true; try { handle.cancel("SIGTERM"); } catch {} await Promise.race([handle.completion, delay(5_000)]); throw error; }
      await launchSideEffect(item.workerId, item.runId, nonce, () => verifyHostIdentity(item.runtime, item.workerId, item.runId));
      const snapshot = handle.snapshot(); assertLaunchClaimOpen(item.workerId, item.runId, nonce);
      finalizeWorkerRunLaunch(getRegistry(), { workerId: worker.workerId, runId: run.runId, claimNonce: nonce, modelSelection: worker.modelSelection!, sessionId, sessionFile, sessionStartLine, jobId: snapshot.jobId,
        stdoutLog: snapshot.stdoutLog, stderrLog: snapshot.stderrLog, runtime: item.runtime, startedAt: now().toISOString() });
      active.set(worker.workerId, { runId: run.runId, handle });
      void handle.completion.then((job) => settleCompletedRun(worker.workerId, run.runId, job)).catch((error) => recordRecovery(worker.workerId, run.runId, error)).finally(() => { if (active.get(worker.workerId)?.runId === run.runId) active.delete(worker.workerId); });
    } catch (error) {
      if (handle && !handleCancellationAttempted) {
        handleCancellationAttempted = true; try { handle.cancel("SIGTERM"); } catch {}
        await Promise.race([handle.completion, delay(5_000)]);
      }
      const claimed = getWorkerRun(getRegistry(), item.workerId, item.runId);
      if (claimed?.claimKind !== "launch" || claimed.claimNonce !== nonce) { try { await removeSandbox(sbx(), item.runtime.sandbox); } catch {} return; }
      ensureFailedLaunchLogs(claimed, error);
      await failClaimedRun(item.workerId, item.runId, "launch", nonce, error);
    } finally {
      if (operationAdmission) endLifecycleAdmission(operationAdmission, nonce);
    }
  }

  function ensureFailedLaunchLogs(run: WorkerRunRecord, error: unknown): void {
    try {
      if (!run.stdoutLog || !run.stderrLog) return;
      const stdoutDir = path.dirname(run.stdoutLog); const stderrDir = path.dirname(run.stderrLog); if (stdoutDir !== stderrDir) return;
      mkdirSync(stdoutDir, { recursive: true, mode: 0o700 });
      writeFileSync(run.stdoutLog, "", { flag: "a", mode: 0o600 });
      writeFileSync(run.stderrLog, `[worker launch failed before host log publication] ${sanitizeError(error)}\n`, { flag: "a", mode: 0o600 });
    } catch {}
  }
  function lifecycleAdmissionPath(runtime: RunRuntime): string { return path.join(runtime.runDir, "lifecycle-admitting.json"); }

  function beginLifecycleAdmission(runtime: RunRuntime, workerId: string, runId: string, claimKind: LifecycleClaimKind, claimNonce: string): string {
    assertRunClaim(workerId, runId, claimKind, claimNonce);
    const file = lifecycleAdmissionPath(runtime); const prior = readLifecycleAdmission(file);
    if (prior) {
      const state = lifecycleAdmissionLiveness(prior);
      if (state !== "dead" && prior.workerId === workerId && prior.runId === runId && prior.claimKind === claimKind && prior.claimNonce === claimNonce) return file;
      if (state !== "dead") throw new WorkerContainmentError(`Another live lifecycle operation still owns ${workerId}/${runId}.`);
      rmSync(file, { force: true });
    }
    if (!parentProcessStartToken) throw new WorkerContainmentError("Unable to capture the parent lifecycle operation start token.");
    const processStartToken = parentProcessStartToken;
    const record: LifecycleAdmissionRecord = { version: 1, workerId, runId, claimKind, claimNonce, pid: process.pid, processStartToken, startedAt: now().toISOString() };
    writeFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { assertRunClaim(workerId, runId, claimKind, claimNonce); }
    catch (error) { endLifecycleAdmission(file, claimNonce); throw error; }
    return file;
  }

  function endLifecycleAdmission(file: string, claimNonce: string): void {
    const record = readLifecycleAdmission(file);
    if (record?.claimNonce === claimNonce) rmSync(file, { force: true });
  }

  function readLifecycleAdmission(file: string): LifecycleAdmissionRecord | undefined {
    if (!existsSync(file)) return undefined;
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as Partial<LifecycleAdmissionRecord>;
      if (value.version !== 1 || typeof value.workerId !== "string" || typeof value.runId !== "string" || !["launch", "settlement", "cancellation"].includes(value.claimKind ?? "") || typeof value.claimNonce !== "string" || !value.claimNonce || !Number.isSafeInteger(value.pid) || value.pid! <= 0 || typeof value.processStartToken !== "string" || !value.processStartToken || typeof value.startedAt !== "string") return undefined;
      return value as LifecycleAdmissionRecord;
    } catch { return undefined; }
  }

  function lifecycleAdmissionLiveness(record: LifecycleAdmissionRecord): AsyncJobProcessIdentityLiveness {
    const observed = record.pid === process.pid ? parentProcessStartToken : readProcessStartToken(record.pid);
    if (observed === record.processStartToken) return "alive";
    if (observed) return "dead";
    try { process.kill(record.pid, 0); return "unknown"; }
    catch (error) { return error && typeof error === "object" && "code" in error && error.code === "ESRCH" ? "dead" : "unknown"; }
  }

  function lifecycleClaimIsLive(claim: WorkerLifecycleClaimRecoveryCandidate): boolean {
    const runtime = claim.runtime as RunRuntime; if (!runtime?.runDir) return false;
    const file = lifecycleAdmissionPath(runtime); const admission = readLifecycleAdmission(file);
    if (admission && admission.workerId === claim.workerId && admission.runId === claim.runId && admission.claimKind === claim.claimKind && admission.claimNonce === claim.claimNonce) {
      const state = lifecycleAdmissionLiveness(admission);
      if (state === "dead") { endLifecycleAdmission(file, admission.claimNonce); return false; }
      return true;
    }
    const ownerState = lifecycleClaimNonceLiveness(claim.claimNonce);
    return ownerState !== undefined && ownerState !== "dead";
  }

  async function waitForBlockingLifecycleClaim(workerId: string, runId: string, runtime: RunRuntime): Promise<void> {
    const deadline = Date.now() + ownerWaitTimeoutMs; let nextOwnerProbeAt = 0;
    while (Date.now() < deadline) {
      const run = getWorkerRun(getRegistry(), workerId, runId);
      if (!run || !run.claimKind || !run.claimNonce) return;
      const observedAt = Date.now();
      if (observedAt >= nextOwnerProbeAt) {
        nextOwnerProbeAt = observedAt + ownerProbeIntervalMs;
        const file = lifecycleAdmissionPath(runtime); const admission = readLifecycleAdmission(file);
        if (admission && admission.workerId === workerId && admission.runId === runId && admission.claimKind === run.claimKind && admission.claimNonce === run.claimNonce) {
          const state = lifecycleAdmissionLiveness(admission);
          if (state === "dead") { endLifecycleAdmission(file, admission.claimNonce); recoverDeadLifecycleClaim(workerId, run, true); return; }
        } else if (lifecycleClaimNonceLiveness(run.claimNonce) === "dead") {
          recoverDeadLifecycleClaim(workerId, run, true); return;
        }
      }
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    throw new WorkerLifecycleOwnerBusyError(`Worker ${workerId}/${runId} still has a live lifecycle operation; terminal intent remains pending.`);
  }

  function recoverDeadLifecycleClaim(workerId: string, run: WorkerRunRecord, forceProbe = false): boolean {
    if (!run.claimKind || !run.claimNonce) return false;
    const observedAt = Date.now(); const nextProbe = lifecycleClaimProbeAt.get(run.claimNonce) ?? 0;
    if (!forceProbe && observedAt < nextProbe) return false;
    lifecycleClaimProbeAt.set(run.claimNonce, observedAt + Math.max(ownerProbeIntervalMs, 250));
    const candidate: WorkerLifecycleClaimRecoveryCandidate = { workerId, runId: run.runId, claimKind: run.claimKind, claimNonce: run.claimNonce, runtime: run.runtime ?? {} };
    if (lifecycleClaimIsLive(candidate)) return false;
    const recovered = recoverProvablyDeadWorkerRunClaim(getRegistry(), { workerId, runId: run.runId, claimKind: run.claimKind, claimNonce: run.claimNonce, runtimeGeneration, now: now().toISOString() });
    if (recovered) { lifecycleClaimProbeAt.delete(run.claimNonce); if (run.claimKind === "launch") pending.delete(run.runId); }
    return recovered;
  }

  function validAcceptedResultEvidence(worker: WorkerRegistryRecord, run: WorkerRunRecord): boolean {
    if (run.status !== "running") return false;
    const runtime = run.runtime as RunRuntime; if (!runtime?.settledFile || !runtime.resultFile || !existsSync(runtime.settledFile) || !existsSync(runtime.resultFile)) return false;
    try {
      const settled = readWorkerHostSettlement(runtime.settledFile); const accepted = readWorkerRuntimeResult(runtime.resultFile);
      return settled.workerId === worker.workerId && settled.runId === run.runId && settled.sessionId === worker.sessionId && path.resolve(settled.resultFile) === path.resolve(runtime.resultFile)
        && accepted.workerId === worker.workerId && accepted.runId === run.runId;
    } catch { return false; }
  }

  function persistClaimedRuntime(runtime: RunRuntime, workerId: string, runId: string, claimKind: LifecycleClaimKind, claimNonce: string): void {
    updateClaimedWorkerRunRuntime(getRegistry(), { workerId, runId, claimKind, claimNonce, runtime });
  }

  async function launchSideEffect<T>(workerId: string, runId: string, claimNonce: string, action: () => T | Promise<T>): Promise<T> {
    assertLaunchClaimOpen(workerId, runId, claimNonce);
    const value = await action();
    assertLaunchClaimOpen(workerId, runId, claimNonce);
    return value;
  }

  async function waitForWorkerHostIdentity(runtime: RunRuntime, workerId: string, runId: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (existsSync(runtime.processFile)) {
        const record = readExactWorkerHostProcess(runtime, workerId, runId, "launch");
        const liveness = probeHostIdentity(record);
        if (liveness === "alive") return;
        if (liveness === "unknown") throw new WorkerHostIdentityError("Worker host process identity could not be verified during launch.");
        throw new Error("Worker host process identity was not alive during launch.");
      }
      await delay(25);
    }
    throw new Error(`Worker ${workerId}/${runId} did not publish its host process identity.`);
  }

  function assertRunClaim(workerId: string, runId: string, kind: "launch" | "settlement" | "cancellation", nonce: string): void {
    const run = getWorkerRun(getRegistry(), workerId, runId);
    if (run?.claimKind !== kind || run.claimNonce !== nonce) throw new Error(`Worker ${workerId}/${runId} ${kind} authority was revoked.`);
  }
  function assertLaunchClaimOpen(workerId: string, runId: string, nonce: string): void {
    assertRunClaim(workerId, runId, "launch", nonce);
    if (getWorkerRun(getRegistry(), workerId, runId)?.terminalIntent) throw new Error(`Worker ${workerId}/${runId} launch authority was revoked.`);
  }

  async function settleCompletedRun(workerId: string, runId: string, job: Pick<JobMeta, "status" | "exitCode" | "error">): Promise<void> {
    const worker = getWorker(getRegistry(), workerId); const before = worker && getWorkerRun(getRegistry(), workerId, runId); if (!worker || !before) return;
    const accepted = job.status === "exited" && job.exitCode === 0 && validAcceptedResultEvidence(worker, before);
    const nonce = lifecycleClaimNonce();
    const claimed = accepted ? claimWorkerAcceptedSettlement(getRegistry(), workerId, runId, nonce, runtimeGeneration) : claimWorkerRun(getRegistry(), workerId, runId, "settlement", nonce, ["running"], runtimeGeneration);
    if (!claimed) return;
    const runtime = getWorkerRun(getRegistry(), workerId, runId)!.runtime as RunRuntime; let operationAdmission: string | undefined; let releaseClaim = false;
    try { operationAdmission = beginLifecycleAdmission(runtime, workerId, runId, "settlement", nonce); releaseClaim = await settleClaimedRun(workerId, runId, job, nonce); }
    catch (error) { releaseClaim = true; recordRecovery(workerId, runId, error); }
    finally { if (operationAdmission) endLifecycleAdmission(operationAdmission, nonce); if (releaseClaim) releaseWorkerRunClaim(getRegistry(), workerId, runId, "settlement", nonce); }
  }

  async function settleClaimedRun(workerId: string, runId: string, job: Pick<JobMeta, "status" | "exitCode" | "error">, nonce: string): Promise<boolean> {
    const worker = getWorker(getRegistry(), workerId)!; const run = getWorkerRun(getRegistry(), workerId, runId)!; const runtime = run.runtime as RunRuntime;
    let outcome: any = "failed"; let outcomeSource: "worker" | "system" = "system"; let summary = "Worker run failed before accepting a result."; let question: string | undefined;
    let reported: string[] = []; let artifacts: string[] = []; const errors: Array<{ scope: "run" | "repositories" | "artifacts"; message: string }> = [];
    let evidenceError: unknown; let containmentProven = false;
    if (job.status === "exited" && job.exitCode === 0) {
      try {
        const settled = readWorkerHostSettlement(runtime.settledFile); if (settled.workerId !== workerId || settled.runId !== runId || settled.sessionId !== worker.sessionId || path.resolve(settled.resultFile) !== path.resolve(runtime.resultFile)) throw new Error("Worker host settlement identity mismatch.");
        const accepted = readWorkerRuntimeResult(runtime.resultFile); if (accepted.workerId !== workerId || accepted.runId !== runId) throw new Error("Worker result identity mismatch.");
        outcome = accepted.result.outcome; outcomeSource = "worker"; summary = accepted.result.summary; question = accepted.result.question; reported = accepted.result.repositories ?? []; artifacts = accepted.result.artifacts ?? [];
      } catch (error) { evidenceError = error; }
    } else errors.push({ scope: "run", message: sanitizeError(job.error ?? `Worker host exited with status ${job.status}${job.exitCode === undefined ? "" : ` (${job.exitCode})`}.`) });
    try {
      await containWorkerRun(runtime, workerId, runId, "result settlement");
      containmentProven = true;
      if (evidenceError) throw evidenceError;
      try { assertWorkerStoragePaths(currentWorkerPaths(worker)); }
      catch (storageError) {
        const storageErrors: Array<{ scope: "run" | "repositories" | "artifacts"; message: string }> = [{ scope: "run", message: `Worker storage policy violation after exact Sandbox absence was proven: ${sanitizeError(storageError)}` }];
        const sessionEndLine = bestEffortSessionEndLine(worker.sessionFile, storageErrors, run.sessionStartLine);
        finalizeClaimedWorkerRun(getRegistry(), { parentSessionFile: worker.parentSessionFile, workerId, runId, claimKind: "settlement", claimNonce: nonce, outcome: "failed", outcomeSource: "system", summary: "Worker result evidence was retained, but the run failed trusted storage-policy validation after containment.", artifacts, errors: storageErrors, sessionEndLine, settledAt: now().toISOString() });
        if (currentContext?.sessionManager.getSessionFile() && realpathOrResolve(currentContext.sessionManager.getSessionFile()!) === worker.parentSessionFile) deliverPendingCompletions(api, getRegistry(), worker.parentSessionFile, runtimeGeneration);
        return false;
      }
      const inventory = inventoryWorkerRepositories({ workspaceRoot: worker.workspaceRoot, workerId, runId, reported, before: runtime.repositoryBefore });
      errors.push(...inventory.errors.map((message) => ({ scope: "repositories" as const, message: sanitizeError(message) })));
      const sessionEndLine = bestEffortSessionEndLine(worker.sessionFile, errors, run.sessionStartLine);
      finalizeClaimedWorkerRun(getRegistry(), { parentSessionFile: worker.parentSessionFile, workerId, runId, claimKind: "settlement", claimNonce: nonce, outcome, outcomeSource, summary: summary.slice(0, 2048), ...(question ? { question } : {}), repositories: inventory.repositories, artifacts, errors, sessionEndLine, settledAt: now().toISOString() });
      if (currentContext?.sessionManager.getSessionFile() && realpathOrResolve(currentContext.sessionManager.getSessionFile()!) === worker.parentSessionFile) deliverPendingCompletions(api, getRegistry(), worker.parentSessionFile, runtimeGeneration);
    } catch (error) {
      const message = sanitizeError(error);
      if (!containmentProven || error instanceof WorkerHostIdentityError || error instanceof WorkerContainmentError) {
        recordRecovery(workerId, runId, error);
        return true;
      }
      const attempts = recordWorkerSettlementRecovery(getRegistry(), { workerId, runId, claimNonce: nonce, error: message, now: now().toISOString() });
      let accepted: ReturnType<typeof readWorkerRuntimeResult> | undefined;
      try { if (existsSync(runtime.resultFile)) accepted = readWorkerRuntimeResult(runtime.resultFile); } catch {}
      if (attempts >= 3) {
        const retained = accepted ? ` Accepted result ${accepted.result.outcome} remains retained at ${runtime.resultFile}.` : ` Settlement evidence remains retained beneath ${runtime.runDir}.`;
        const fallbackErrors: Array<{ scope: "run" | "repositories" | "artifacts"; message: string }> = [{ scope: "run", message: `${message}${retained}` }];
        const sessionEndLine = bestEffortSessionEndLine(worker.sessionFile, fallbackErrors, accepted ? run.sessionStartLine : run.sessionStartLine === undefined ? undefined : run.sessionStartLine - 1);
        finalizeClaimedWorkerRun(getRegistry(), {
          parentSessionFile: worker.parentSessionFile, workerId, runId, claimKind: "settlement", claimNonce: nonce,
          outcome: "failed", outcomeSource: "system", summary: `Worker result settlement failed after ${attempts} deterministic attempts.`,
          artifacts: accepted?.result.artifacts ?? [], errors: fallbackErrors,
          sessionEndLine, settledAt: now().toISOString()
        });
        if (currentContext?.sessionManager.getSessionFile() && realpathOrResolve(currentContext.sessionManager.getSessionFile()!) === worker.parentSessionFile) deliverPendingCompletions(api, getRegistry(), worker.parentSessionFile, runtimeGeneration);
      } else {
        const current = getWorker(getRegistry(), workerId); const currentRun = current && getWorkerRun(getRegistry(), workerId, runId);
        if (current && currentRun) deliverRecovery(current, currentRun, `${message} (settlement attempt ${attempts}/3)`);
        return true;
      }
    }
    return false;
  }
  async function failClaimedRun(workerId: string, runId: string, claimKind: "launch" | "settlement", claimNonce: string, error: unknown): Promise<void> {
    const worker = getWorker(getRegistry(), workerId); const run = worker && getWorkerRun(getRegistry(), workerId, runId); if (!worker || !run || run.claimKind !== claimKind || run.claimNonce !== claimNonce) return; const runtime = run.runtime as RunRuntime;
    let operationAdmission: string | undefined; let terminalIntentPersisted = false;
    try {
      const terminalIntent = setClaimedWorkerTerminalIntent(getRegistry(), { workerId, runId, claimKind, claimNonce, terminalIntent: "failure", terminalError: sanitizeError(error), now: now().toISOString() }); terminalIntentPersisted = true;
      operationAdmission = beginLifecycleAdmission(runtime, workerId, runId, claimKind, claimNonce);
      await containWorkerRun(runtime, workerId, runId, "failed-run cleanup", { signalAttached: true });
      const cancelled = terminalIntent === "cancellation";
      const errors: Array<{ scope: "run" | "repositories" | "artifacts"; message: string }> = cancelled ? [] : [{ scope: "run", message: sanitizeError(error) }];
      const sessionEndLine = bestEffortSessionEndLine(worker.sessionFile, errors, run.sessionStartLine === undefined ? undefined : run.sessionStartLine - 1);
      finalizeClaimedWorkerRun(getRegistry(), { parentSessionFile: worker.parentSessionFile, workerId, runId, claimKind, claimNonce,
        outcome: cancelled ? "cancelled" : "failed", outcomeSource: "system", summary: cancelled ? "Worker run was cancelled by its parent." : "Worker run failed before accepting a result.",
        errors, sessionEndLine, settledAt: now().toISOString() });
    } catch (cleanupError) {
      if (operationAdmission) { endLifecycleAdmission(operationAdmission, claimNonce); operationAdmission = undefined; }
      if (terminalIntentPersisted) releaseWorkerRunClaim(getRegistry(), workerId, runId, claimKind, claimNonce);
      recordRecovery(workerId, runId, cleanupError);
    } finally { if (operationAdmission) endLifecycleAdmission(operationAdmission, claimNonce); }
  }

  function beginTerminalRecovery(workerId: string, runId: string): Promise<"cancelled" | "failed" | "not_active"> {
    const existing = terminalRecoveries.get(runId); if (existing) return existing;
    const recovery = recoverTerminalRun(workerId, runId);
    terminalRecoveries.set(runId, recovery);
    void recovery.finally(() => { if (terminalRecoveries.get(runId) === recovery) terminalRecoveries.delete(runId); }).catch(() => {});
    return recovery;
  }

  async function recoverTerminalRun(workerId: string, runId: string): Promise<"cancelled" | "failed" | "not_active"> {
    let worker = getWorker(getRegistry(), workerId); let run = worker && getWorkerRun(getRegistry(), workerId, runId);
    if (!worker || worker.activeRunId !== runId || !run || run.status === "settled" || !run.terminalIntent) return "not_active";
    const runtime = run.runtime as RunRuntime; await waitForBlockingLifecycleClaim(workerId, runId, runtime);
    worker = getWorker(getRegistry(), workerId); run = getWorkerRun(getRegistry(), workerId, runId);
    if (run?.status === "settled") return run.outcome === "cancelled" ? "cancelled" : run.outcome === "failed" ? "failed" : "not_active";
    if (!worker || worker.activeRunId !== runId || !run || !run.terminalIntent) return "not_active";
    if (validAcceptedResultEvidence(worker, run)) {
      await settleCompletedRun(workerId, runId, { status: "exited", exitCode: 0 });
      return "not_active";
    }
    const terminalIntent = run.terminalIntent; const claimKind = terminalIntent === "cancellation" ? "cancellation" : "settlement"; const nonce = lifecycleClaimNonce();
    if (!claimWorkerTerminalIntent(getRegistry(), { workerId, runId, terminalIntent, claimKind, claimNonce: nonce, now: now().toISOString(), runtimeGeneration })) return "not_active";
    pending.delete(runId);
    const claimedWorker = getWorker(getRegistry(), workerId); const claimedRun = getWorkerRun(getRegistry(), workerId, runId);
    if (claimedWorker && claimedRun && validAcceptedResultEvidence(claimedWorker, claimedRun)) {
      releaseWorkerRunClaim(getRegistry(), workerId, runId, claimKind, nonce);
      await settleCompletedRun(workerId, runId, { status: "exited", exitCode: 0 });
      return "not_active";
    }
    if (terminalIntent === "failure") {
      await failClaimedRun(workerId, runId, "settlement", nonce, new Error(run.terminalError ?? "Worker run failed before accepting a result."));
      const after = getWorkerRun(getRegistry(), workerId, runId);
      if (after?.status === "settled") return "failed";
      throw new WorkerContainmentError(`Worker ${workerId}/${runId} failed-run cleanup remains pending.`);
    }
    let operationAdmission: string | undefined;
    try {
      operationAdmission = beginLifecycleAdmission(runtime, workerId, runId, "cancellation", nonce);
      await containWorkerRun(runtime, workerId, runId, "cancellation", { signalAttached: true });
      await reconcileTerminatedPersistedAsyncShellJobsForOwner(path.join(cleanupWorkerPaths(worker).stateDir, "async-shell"), { kind: "worker-run", workerId, runId }, 250);
      const survivors = await waitForWorkerShellRecords(workerId, runId);
      if (survivors.length) throw new WorkerContainmentError(`Worker-owned process records remain active after Sandbox removal: ${survivors.map((job) => job.jobId).join(", ")}.`);
      const beforeFinalizationWorker = getWorker(getRegistry(), workerId); const beforeFinalizationRun = getWorkerRun(getRegistry(), workerId, runId);
      if (beforeFinalizationWorker && beforeFinalizationRun && validAcceptedResultEvidence(beforeFinalizationWorker, beforeFinalizationRun)) {
        releaseWorkerRunClaim(getRegistry(), workerId, runId, "cancellation", nonce);
        await settleCompletedRun(workerId, runId, { status: "exited", exitCode: 0 });
        return "not_active";
      }
      const acceptedWithoutSettlement = readAcceptedResultForRun(runtime, workerId, runId);
      if (acceptedWithoutSettlement) {
        finalizeAcceptedCancellation(worker, run, runtime, nonce, acceptedWithoutSettlement);
        active.delete(workerId); deliverPendingCompletions(api, getRegistry(), worker.parentSessionFile, runtimeGeneration);
        return "not_active";
      }
      const errors: Array<{ scope: "run" | "repositories" | "artifacts"; message: string }> = [];
      const sessionEndLine = bestEffortSessionEndLine(worker.sessionFile, errors, run.sessionStartLine === undefined ? undefined : run.sessionStartLine - 1);
      finalizeClaimedWorkerRun(getRegistry(), { parentSessionFile: worker.parentSessionFile, workerId, runId, claimKind: "cancellation", claimNonce: nonce, outcome: "cancelled", outcomeSource: "system", summary: "Worker run was cancelled by its parent.", ...(errors.length ? { errors } : {}), sessionEndLine, settledAt: now().toISOString() });
      active.delete(workerId); deliverPendingCompletions(api, getRegistry(), worker.parentSessionFile, runtimeGeneration); return "cancelled";
    } catch (error) {
      if (operationAdmission) { endLifecycleAdmission(operationAdmission, nonce); operationAdmission = undefined; }
      releaseWorkerRunClaim(getRegistry(), workerId, runId, "cancellation", nonce); recordRecovery(workerId, runId, error); throw error;
    } finally { if (operationAdmission) endLifecycleAdmission(operationAdmission, nonce); }
  }

  async function cancelWorker(worker: WorkerRegistryRecord): Promise<"cancelled" | "accepted_pending" | "superseded" | "not_active"> {
    assertCurrentPackageGeneration();
    if (!worker.activeRunId) return "not_active"; const runId = worker.activeRunId;
    const recoveringRun = getWorkerRun(getRegistry(), worker.workerId, runId); const recoveringRuntime = recoveringRun?.runtime as RunRuntime | undefined;
    if (recoveringRun && recoveringRuntime && !recoveringRun.terminalIntent && existsSync(recoveringRuntime.resultFile) && !existsSync(recoveringRuntime.settledFile)) {
      const deadline = Date.now() + cancellationResultGraceMs;
      while (!existsSync(recoveringRuntime.settledFile) && Date.now() < deadline) await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    if (recoveringRun && !recoveringRun.terminalIntent && validAcceptedResultEvidence(worker, recoveringRun)) {
      // The attached handle still owns normal completion. Do not enter
      // containment merely because cancellation observed accepted evidence.
      if (active.get(worker.workerId)?.runId === runId) return "superseded";
      if (ensureCurrentRuntimeAuthority(worker.parentSessionFile) === "current" && recoveringRun.claimKind) recoverDeadLifecycleClaim(worker.workerId, recoveringRun, true);
      await settleCompletedRun(worker.workerId, runId, { status: "exited", exitCode: 0 });
      // A live settlement owner needs no recovery and the accepted result has
      // already superseded cancellation, even if finalization is still pending.
      return "superseded";
    }
    if (!recoveringRun || !recoveringRuntime) return "superseded";
    if (!requestWorkerCancellation(getRegistry(), worker.workerId, runId, now().toISOString())) {
      const after = getWorkerRun(getRegistry(), worker.workerId, runId);
      return after?.outcome === "cancelled" ? "cancelled" : "superseded";
    }
    const requested = getWorkerRun(getRegistry(), worker.workerId, runId);
    if (requested?.terminalIntent !== "cancellation") return requested?.outcome === "cancelled" ? "cancelled" : "superseded";
    const authority = ensureCurrentRuntimeAuthority(worker.parentSessionFile);
    if (authority !== "current") return "accepted_pending";
    try {
      const result = await beginTerminalRecovery(worker.workerId, runId);
      if (result === "cancelled") return "cancelled";
      const after = getWorkerRun(getRegistry(), worker.workerId, runId);
      return after?.terminalIntent === "cancellation" && after.status !== "settled" ? "accepted_pending" : after?.outcome === "cancelled" ? "cancelled" : "superseded";
    } catch (error) {
      if (error instanceof WorkerLifecycleOwnerBusyError) throw new Error(`Worker ${worker.workerId}/${runId} cancellation remains pending behind its live lifecycle owner.`);
      throw new Error(`Worker ${worker.workerId}/${runId} cancellation requires recovery: ${sanitizeError(error)}`);
    }
  }


  function readAcceptedResultForRun(runtime: RunRuntime, workerId: string, runId: string): ReturnType<typeof readWorkerRuntimeResult> | undefined {
    if (!existsSync(runtime.resultFile)) return undefined;
    try {
      const accepted = readWorkerRuntimeResult(runtime.resultFile);
      return accepted.workerId === workerId && accepted.runId === runId ? accepted : undefined;
    } catch { return undefined; }
  }

  function finalizeAcceptedCancellation(worker: WorkerRegistryRecord, run: WorkerRunRecord, runtime: RunRuntime, nonce: string, accepted: ReturnType<typeof readWorkerRuntimeResult>): void {
    const reported = accepted.result.repositories ?? []; const artifacts = accepted.result.artifacts ?? [];
    const errors: Array<{ scope: "run" | "repositories" | "artifacts"; message: string }> = [];
    let repositories: WorkerRepositoryResult[] = [];
    try {
      assertWorkerStoragePaths(currentWorkerPaths(worker));
      const inventory = inventoryWorkerRepositories({ workspaceRoot: worker.workspaceRoot, workerId: worker.workerId, runId: run.runId, reported, before: runtime.repositoryBefore });
      repositories = inventory.repositories;
      errors.push(...inventory.errors.map((message) => ({ scope: "repositories" as const, message: sanitizeError(message) })));
    } catch (storageError) { errors.push({ scope: "run", message: `Accepted worker result was retained, but post-containment storage inventory was unavailable: ${sanitizeError(storageError)}` }); }
    const sessionEndLine = bestEffortSessionEndLine(worker.sessionFile, errors, run.sessionStartLine);
    finalizeClaimedWorkerRun(getRegistry(), { parentSessionFile: worker.parentSessionFile, workerId: worker.workerId, runId: run.runId, claimKind: "cancellation", claimNonce: nonce, outcome: accepted.result.outcome, outcomeSource: "worker", summary: accepted.result.summary.slice(0, 2048), ...(accepted.result.question ? { question: accepted.result.question } : {}), repositories, artifacts, errors, sessionEndLine, settledAt: now().toISOString() });
  }
  async function containWorkerRun(runtime: RunRuntime, workerId: string, runId: string, operation: string, options: { signalAttached?: boolean; waitForLaunch?: Promise<void> } = {}): Promise<void> {
    const failures: string[] = [];
    const capture = async (label: string, action: () => void | Promise<void>): Promise<void> => {
      try { await action(); } catch (error) { failures.push(`${label}: ${sanitizeError(error)}`); }
    };
    if (runtime.version !== 4) throw new WorkerContainmentError(`Worker ${workerId}/${runId} uses unsupported retained runtime schema; ${operation} refuses an unproved legacy target.`);
    const authorizationFile = path.join(runtime.runDir, "host-authorization.json");
    await capture("authorization revocation", () => { revokeRuntimeAuthorization(runtime); });
    await capture("runtime admission drain", () => waitForRuntimeAdmissions(runtime, authorizationFile));
    if (options.waitForLaunch) await capture("launch boundary", () => options.waitForLaunch!);
    const attached = active.get(workerId)?.runId === runId ? active.get(workerId)!.handle : undefined;
    let detached: ReturnType<typeof readWorkerHostProcess> | undefined;
    if (options.signalAttached && attached) {
      await capture("attached host cancellation request", () => writeWorkerCancellationRequest(runtime, workerId, runId));
      await capture("attached host graceful EOF request", () => { attached.cancel("SIGTERM"); });
    } else if (options.signalAttached && !attached) await capture("detached host graceful EOF request", () => { detached = requestDetachedWorkerShutdown(runtime, workerId, runId, operation); });
    if (options.signalAttached && attached) await capture("attached host settlement", async () => {
      const terminal = await Promise.race([attached.completion.then((job) => job.status !== "running" && job.status !== "unknown"), delay(cancellationEofGraceMs).then(() => false)]);
      if (!terminal) throw new Error(`Worker host job did not reach a terminal state during ${operation}.`);
    });
    if (options.signalAttached && detached) await capture("detached host settlement", async () => {
      const deadline = Date.now() + cancellationEofGraceMs;
      while (probeHostIdentity(detached!) === "alive" && Date.now() < deadline) await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    });
    // Sandbox stop/remove is the exact containment boundary and the escalation
    // after bounded RPC stdin EOF handling; it is never ordinary guest-job settlement.
    await capture("exact Sandbox removal", () => removeSandbox(sbx(), runtime.sandbox));
    await capture("host termination proof", () => proveWorkerHostExited(runtime, workerId, runId));
    if (failures.length) throw new WorkerContainmentError(`Worker ${workerId}/${runId} ${operation} requires recovery; ${failures.join(" | ")}`);
  }

  function revokeRuntimeAuthorization(runtime: RunRuntime): string {
    const authorizationFile = path.join(runtime.runDir, "host-authorization.json");
    rmSync(authorizationFile, { force: true });
    return authorizationFile;
  }

  function requestDetachedWorkerShutdown(runtime: RunRuntime, workerId: string, runId: string, operation: string): ReturnType<typeof readWorkerHostProcess> | undefined {
    if (!existsSync(runtime.processFile)) return undefined;
    const processRecord = readExactWorkerHostProcess(runtime, workerId, runId, operation);
    const liveness = probeHostIdentity(processRecord);
    if (liveness === "unknown") throw new WorkerHostIdentityError(`Worker host process identity could not be verified during ${operation}.`);
    if (liveness === "alive") writeWorkerCancellationRequest(runtime, workerId, runId);
    return processRecord;
  }

  function writeWorkerCancellationRequest(runtime: RunRuntime, workerId: string, runId: string): void {
    const requestFile = path.join(runtime.runDir, "cancel-request.json");
    const text = `${JSON.stringify({ version: 1, workerId, runId, requestedAt: now().toISOString() })}\n`;
    try { writeFileSync(requestFile, text, { flag: "wx", mode: 0o600 }); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    try {
      const retained = JSON.parse(readBoundedNoFollowFile(requestFile, runtime.runDir, 4096, "worker cancellation request").toString("utf8")) as { version?: unknown; workerId?: unknown; runId?: unknown };
      if (retained.version === 1 && retained.workerId === workerId && retained.runId === runId) return;
    } catch {}
    rmSync(requestFile, { force: true });
    writeFileSync(requestFile, text, { flag: "wx", mode: 0o600 });
  }
  async function waitForRuntimeAdmissions(runtime: RunRuntime, authorizationFile: string): Promise<void> {
    const files = [workerResultAdmissionPath(runtime.resultFile), workerMutationAdmissionPath(authorizationFile)];
    for (let attempt = 0; attempt < 480 && files.some(runtimeAdmissionActive); attempt += 1) await delay(25);
    const activeFiles = files.filter(runtimeAdmissionActive); if (activeFiles.length) throw new Error(`Worker runtime mutation admission did not settle after revocation: ${activeFiles.join(", ")}.`);
  }
  function runtimeAdmissionActive(file: string): boolean {
    if (!existsSync(file)) return false; try { const record = JSON.parse(readFileSync(file, "utf8")) as { pid?: number; processStartToken?: string }; if (Number.isSafeInteger(record.pid) && record.pid! > 0 && typeof record.processStartToken === "string") { if (asyncJobProcessStartToken(record.pid!) === record.processStartToken) return true; rmSync(file, { force: true }); return false; } } catch {} return true;
  }

  async function waitForWorkerShellRecords(workerId: string, runId: string): Promise<ReturnType<typeof unsettledPersistedAsyncShellJobsForOwner>> {
    const worker = getWorker(getRegistry(), workerId); if (!worker) return [];
    const root = path.join(cleanupWorkerPaths(worker).stateDir, "async-shell"); const owner = { kind: "worker-run" as const, workerId, runId };
    let jobs = unsettledPersistedAsyncShellJobsForOwner(root, owner).filter((job) => job.status === "running" || job.status === "unknown");
    for (let attempt = 0; attempt < 80 && jobs.length; attempt += 1) { await delay(25); jobs = unsettledPersistedAsyncShellJobsForOwner(root, owner).filter((job) => job.status === "running" || job.status === "unknown"); }
    return jobs;
  }

  async function proveWorkerHostExited(runtime: RunRuntime, workerId: string, runId: string): Promise<void> {
    if (!existsSync(runtime.processFile)) return;
    const processRecord = readExactWorkerHostProcess(runtime, workerId, runId, "termination proof");
    let liveness = await waitForHostLiveness(processRecord, overrides.hostTerminationGraceAttempts ?? 50);
    if (liveness === "unknown") throw new WorkerHostIdentityError("Worker host process identity remained ambiguous during termination proof.");
    if (liveness === "dead") return;
    signalVerifiedWorkerHost(processRecord, "SIGKILL", "forced termination");
    liveness = await waitForHostLiveness(processRecord, overrides.hostForcedTerminationAttempts ?? 30);
    if (liveness === "unknown") throw new WorkerHostIdentityError("Worker host process identity became ambiguous after forced termination.");
    if (liveness === "alive") throw new WorkerContainmentError(`Worker host process group ${processRecord.pid} remained alive after forced termination.`);
  }

  function signalVerifiedWorkerHost(processRecord: ReturnType<typeof readWorkerHostProcess>, signal: NodeJS.Signals, operation: string): void {
    if (signalHostIdentity(processRecord, signal)) return;
    const after = probeHostIdentity(processRecord);
    if (after === "dead") return;
    if (after === "unknown") throw new WorkerHostIdentityError(`Worker host process identity became ambiguous before ${signal} during ${operation}.`);
    throw new WorkerContainmentError(`Worker host process ${processRecord.pid} remained alive without accepting ${signal} during ${operation}.`);
  }

  async function waitForHostLiveness(processRecord: ReturnType<typeof readWorkerHostProcess>, attempts: number): Promise<AsyncJobProcessIdentityLiveness> {
    let liveness: AsyncJobProcessIdentityLiveness = "unknown";
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      liveness = probeHostIdentity(processRecord);
      if (liveness === "dead") return liveness;
      await delay(overrides.hostProbeDelayMs ?? 100);
    }
    return liveness;
  }

  function readExactWorkerHostProcess(runtime: RunRuntime, workerId: string, runId: string, operation: string): ReturnType<typeof readWorkerHostProcess> {
    let processRecord: ReturnType<typeof readWorkerHostProcess>;
    try { processRecord = readWorkerHostProcess(runtime.processFile); }
    catch (error) { throw new WorkerHostIdentityError(`Worker host process marker could not be read during ${operation}: ${sanitizeError(error)}`); }
    if (processRecord.workerId !== workerId || processRecord.runId !== runId || processRecord.nonce !== runtime.processNonce) throw new WorkerHostIdentityError(`Worker host process identity mismatched during ${operation}.`);
    return processRecord;
  }

  function recoverAbandonedDiscardTrash(parentSessionFile: string): void {
    const rows = getRegistry().database.prepare("SELECT worker_id FROM workers WHERE parent_session_file=? AND operation_kind IS NULL").all(parentSessionFile) as Array<{ worker_id: string }>;
    for (const row of rows) {
      const worker = getWorker(getRegistry(), row.worker_id); if (!worker) continue;
      let paths: WorkerPaths; try { paths = cleanupWorkerPaths(worker); } catch { continue; }
      const originals = [paths.workerDir, ...externalStoragePaths(paths)];
      for (const original of originals) {
        const trash = discardTrashPaths(original); if (!trash.length) continue;
        try {
          for (const candidate of trash) prepareOwnerRemovalTree(candidate);
          // An abandoned old-nonce trash tree may already be partially removed. It has no
          // trustworthy completeness marker, so never restore it over a deleted live tree.
          // Current-operation rollback restores its exact nonce synchronously in discardWorker.
          for (const candidate of trash) removeOwnerTree(candidate);
        } catch {}
      }
    }
  }

  function recoverInterruptedDiscardFiles(parentSessionFile: string, generation: number): void {
    const rows = getRegistry().database.prepare("SELECT worker_id,operation_nonce,recovery_error FROM workers WHERE parent_session_file=? AND operation_kind='discard' AND operation_nonce IS NOT NULL").all(parentSessionFile) as Array<{ worker_id: string; operation_nonce: string; recovery_error: string | null }>;
    for (const row of rows) {
      if (row.operation_nonce.startsWith(`${generation}-`) && !row.recovery_error?.toLowerCase().includes("irreversible discard requires recovery:")) continue;
      const worker = getWorker(getRegistry(), row.worker_id); if (!worker) continue;
      let paths: WorkerPaths; try { paths = cleanupWorkerPaths(worker); } catch (error) {
        getRegistry().database.prepare("UPDATE workers SET recovery_error=?,version=version+1,updated_at=? WHERE worker_id=? AND operation_kind='discard' AND operation_nonce=?").run(`Interrupted irreversible discard requires recovery: ${sanitizeError(error)}`, now().toISOString(), row.worker_id, row.operation_nonce);
        continue;
      }
      const workerTrash = `${paths.workerDir}.discard-${row.operation_nonce}`;
      const external = externalStoragePaths(paths); const externalTrash = external.map((item) => `${item}.discard-${row.operation_nonce}`);
      const committed = existsSync(workerTrash) || externalTrash.some(existsSync) || (!existsSync(paths.workerDir) && external.every((item) => !existsSync(item)));
      if (!committed) { abandonWorkerDiscard(getRegistry(), row.worker_id, row.operation_nonce, "Interrupted discard claim was rolled back before the root claim.", now().toISOString()); continue; }
      try {
        const plan = cleanupHostLogs(getRegistry(), worker);
        if (plan.leftovers.length) throw new Error(`Worker host logs remain live or unsafe: ${plan.leftovers.map((item) => `${item.path}: ${item.reason}`).join("; ")}`);
        for (const candidate of [workerTrash, paths.workerDir, ...externalTrash, ...external]) prepareOwnerRemovalTree(candidate);
        const deleted = deletePlannedWorkerHostLogs(plan);
        for (const candidate of [...externalTrash, ...external, workerTrash, paths.workerDir]) removeOwnerTree(candidate);
        finalizeWorkerDiscard(getRegistry(), row.worker_id, row.operation_nonce);
        void deleted;
      } catch (error) {
        getRegistry().database.prepare("UPDATE workers SET recovery_error=?,version=version+1,updated_at=? WHERE worker_id=? AND operation_kind='discard' AND operation_nonce=?").run(`Interrupted irreversible discard requires recovery: ${sanitizeError(error)}`, now().toISOString(), row.worker_id, row.operation_nonce);
      }
    }
  }

  async function discardWorker(worker: WorkerRegistryRecord, existingNonce?: string, preflightPlan?:ReturnType<typeof planSettledWorkerHostLogs>): Promise<{ hostLogs: string[] }> {
    assertCurrentPackageGeneration(); const plan=preflightPlan??cleanupHostLogs(getRegistry(),worker); if(plan.leftovers.length)throw new Error(`Worker host logs could not be deleted safely: ${plan.leftovers.map((item)=>`${item.path}: ${item.reason}`).join("; ")}`); const nonce=existingNonce??claimNonce(); let current:WorkerRegistryRecord|undefined; let paths:WorkerPaths|undefined; let workerTrash:string|undefined; let external:string[]=[]; let externalTrash:string[]=[]; let committed=false;
    try {
      if(existingNonce===undefined)claimWorkerDiscard(getRegistry(),worker.workerId,worker.version,nonce,now().toISOString());
      current=getWorker(getRegistry(),worker.workerId); if(!current)throw new Error(`Worker ${worker.workerId} disappeared after discard claim.`); paths=cleanupWorkerPaths(current); workerTrash=`${paths.workerDir}.discard-${nonce}`; external=externalStoragePaths(paths); externalTrash=external.map((item)=>`${item}.discard-${nonce}`);
      const staleTrash = [...discardTrashPaths(paths.workerDir), ...external.flatMap(discardTrashPaths)];
      for (const candidate of [paths.workerDir, ...external, ...staleTrash]) prepareOwnerRemovalTree(candidate);
      for (const trash of staleTrash) removeOwnerTree(trash);
      overrides.beforeDiscardRootClaim?.(current);
      if (existsSync(workerTrash) || externalTrash.some(existsSync)) throw new Error("Discard trash destination already exists.");
      if (existsSync(paths.workerDir)) renameSync(paths.workerDir, workerTrash);
      for (let index=0; index<external.length; index+=1) if (existsSync(external[index]!)) renameSync(external[index]!, externalTrash[index]!);
      committed = true;
      const deleted = deletePlannedWorkerHostLogs(plan);
      for (const candidate of [...externalTrash, workerTrash]) removeOwnerTree(candidate);
      finalizeWorkerDiscard(getRegistry(), current.workerId, nonce);
      return { hostLogs: deleted };
    } catch (error) {
      if (!committed) {
        try { if(paths&&workerTrash)restoreDiscardPath(workerTrash, paths.workerDir); for (let index=0; index<external.length; index+=1) restoreDiscardPath(externalTrash[index]!, external[index]!); } catch {}
        abandonWorkerDiscard(getRegistry(), current?.workerId??worker.workerId, nonce, sanitizeError(error), now().toISOString());
      } else {
        getRegistry().database.prepare("UPDATE workers SET recovery_error=?,version=version+1,updated_at=? WHERE worker_id=? AND operation_kind='discard' AND operation_nonce=?").run(`Irreversible discard requires recovery: ${sanitizeError(error)}`, now().toISOString(), current!.workerId, nonce);
      }
      throw error;
    }
  }
  function externalStoragePaths(paths: WorkerPaths): string[] { const parent=path.resolve(paths.workerDir); return [paths.supervisionDir,paths.workspaceRoot].map((candidate)=>path.resolve(candidate)).filter((candidate,index,all)=>candidate!==parent&&!candidate.startsWith(`${parent}${path.sep}`)&&all.indexOf(candidate)===index); }
  function restoreDiscardPath(trash:string,destination:string):void{if(!existsSync(trash))return;if(existsSync(destination)){removeOwnerTree(trash);return;}renameSync(trash,destination);}

  async function refreshCleanupInventory(parent: string, cwd: string): Promise<CleanupInventory> {
    const existing = cleanupInFlight.get(parent); if (existing) return existing;
    const work = buildCleanupInventory(getRegistry(), { parentSessionFile: parent, allSessions: false, cwd, ...(overrides.bdPath?{bdPath:overrides.bdPath}:{}) }).then((inventory) => { cleanupInventoryByParent.set(parent, inventory); return inventory; }).finally(() => cleanupInFlight.delete(parent));
    cleanupInFlight.set(parent, work); return work;
  }

  async function announceCleanupAfterAgentEnd(parent:string,cwd:string):Promise<void>{
    const generation=runtimeGeneration,scope=`${parent}\0${generation}\0`;try{
      const inventory=await refreshCleanupInventory(parent,cwd),includeOther=!otherSessionSummaries.has(scope);let otherSessions:Array<Record<string,unknown>>=[],additionalOtherSessions=0,otherSessionsPartial=false,otherSessionsNextOffset:number|undefined;
      if(includeOther){
        otherSessionSummaries.add(scope);const grouped=new Map<string,{owner:unknown;workerIds:string[];preparedIds:string[];attention:number}>();let offset=0,pages=0,complete=false;const deadline=Date.now()+10_000;
        while(pages<10&&Date.now()<deadline){const page=await buildCleanupInventory(getRegistry(),{parentSessionFile:parent,allSessions:true,cwd,bdPath:overrides.bdPath,limit:100,offset});for(const item of page.workers)if(item.ownerSession!==parent&&["due","recovery","unknown:task_missing"].includes(item.class)){const value=grouped.get(item.ownerSession)??{owner:item.owner,workerIds:[],preparedIds:[],attention:0};if(item.class==="due")value.workerIds.push(item.workerId);else value.attention+=1;grouped.set(item.ownerSession,value);}for(const item of page.prepared)if(item.ownerSession!==parent&&["due","explicit_decision","partial"].includes(item.class)){const value=grouped.get(item.ownerSession)??{owner:item.owner,workerIds:[],preparedIds:[],attention:0};if(item.class==="due")value.preparedIds.push(item.preparedId);else value.attention+=1;grouped.set(item.ownerSession,value);}pages+=1;const more=page.total.workers>offset+page.workers.length||page.total.prepared>offset+page.prepared.length;if(!more){complete=true;break;}offset+=100;}
        otherSessionsPartial=!complete;if(otherSessionsPartial)otherSessionsNextOffset=offset;const values=[...grouped.values()];otherSessions=values.slice(0,20).map((item)=>({...item,workerIds:item.workerIds.slice(0,8),additionalWorkers:Math.max(0,item.workerIds.length-8),preparedIds:item.preparedIds.slice(0,8),additionalPrepared:Math.max(0,item.preparedIds.length-8)}));additionalOtherSessions=Math.max(0,values.length-otherSessions.length);
      }
      const announceable=[...inventory.workers.filter((item)=>["due","recovery","unknown:task_missing"].includes(item.class)).map((item)=>({kind:"worker",id:item.workerId,class:item.class})),...inventory.prepared.filter((item)=>["due","explicit_decision","partial"].includes(item.class)).map((item)=>({kind:"prepared",id:item.preparedId,class:item.class}))];const current=new Set(announceable.map((item)=>`${scope}${item.kind}:${item.id}:${item.class}`));for(const key of [...cleanupAnnounced])if(key.startsWith(scope)&&!current.has(key))cleanupAnnounced.delete(key);const fresh=announceable.filter((item)=>!cleanupAnnounced.has(`${scope}${item.kind}:${item.id}:${item.class}`));const otherHasItems=otherSessions.some((item:any)=>item.workerIds.length||item.preparedIds.length||item.attention)||otherSessionsPartial;if((!fresh.length&&!otherHasItems)||generation!==runtimeGeneration||!currentContext?.sessionManager.getSessionFile()||realpathOrResolve(currentContext.sessionManager.getSessionFile()!)!==parent)return;for(const item of announceable)cleanupAnnounced.add(`${scope}${item.kind}:${item.id}:${item.class}`);
      const dueWorkers=inventory.workers.filter((item)=>item.class==="due"),duePrepared=inventory.prepared.filter((item)=>item.class==="due"),recovery=inventory.workers.filter((item)=>item.class==="recovery"),unknown=inventory.workers.filter((item)=>item.class==="unknown:task_missing"),partial=inventory.prepared.filter((item)=>item.class==="partial"),explicitDecision=inventory.prepared.filter((item)=>item.class==="explicit_decision");const event={event:"worker_cleanup_due",workers:dueWorkers.slice(0,16).map((item)=>({workerId:item.workerId,role:item.role,class:item.class,new:fresh.some((candidate)=>candidate.kind==="worker"&&candidate.id===item.workerId),...(item.after?{after:item.after}:{}),unpreservedArtifacts:item.unpreservedArtifacts.slice(0,4),additionalUnpreservedArtifacts:Math.max(0,item.unpreservedArtifacts.length-4)})),additionalWorkers:Math.max(0,dueWorkers.length-16),preparedIds:duePrepared.slice(0,16).map((item)=>item.preparedId),additionalPrepared:Math.max(0,duePrepared.length-16),attention:{recovery:recovery.slice(0,16).map((item)=>({workerId:item.workerId,error:item.recoveryError??item.reason})),additionalRecovery:Math.max(0,recovery.length-16),unknown:unknown.slice(0,16).map((item)=>({workerId:item.workerId,reason:item.reason})),additionalUnknown:Math.max(0,unknown.length-16),partial:partial.slice(0,16).map((item)=>item.preparedId),additionalPartial:Math.max(0,partial.length-16),explicitDecision:explicitDecision.slice(0,16).map((item)=>item.preparedId),additionalExplicitDecision:Math.max(0,explicitDecision.length-16)},beadsUnavailable:inventory.workers.filter((item)=>item.class==="unknown:beads_unavailable").length,currentSessionPartial:inventory.scan.partial,otherSessions,additionalOtherSessions,otherSessionsPartial,...(otherSessionsNextOffset===undefined?{}:{otherSessionsNextOffset})};api.sendMessage({customType:"worker-cleanup",content:JSON.stringify(event),display:true,details:event},{triggerTurn:true,deliverAs:"followUp"});
    }catch{/* advisory only */}
  }

  function cleanupOwnerAuthority(owner:string,current:string):CleanupOwnerAuthority { if(owner===current)return{state:"current",generation:runtimeGeneration};const generation=currentParentRuntime(getRegistry(),owner);if(!generation)return{state:"missing"};const rawMembers=latestParentRuntimeMembers(getRegistry(),owner,0,generation.generation);const members=rawMembers.slice(0,128).map((member)=>({...member,liveness:member.retired?"retired":parentRuntimeMemberLiveness(member)}));if(rawMembers.length>128)return{state:"ambiguous",generation:generation.generation,members};if(!members.length)return{state:"missing",generation:generation.generation,members};if(members.some((m)=>!m.retired&&m.liveness==="alive"))return{state:"live",generation:generation.generation,members};if(members.some((m)=>!m.retired&&m.liveness!=="dead"))return{state:"ambiguous",generation:generation.generation,members};return{state:members.every((m)=>m.retired)?"retired":"dead",generation:generation.generation,members}; }
  function exactAcknowledgements(expected:string[],actual:string[]|undefined,label:string):Set<string>{const value=new Set(actual??[]);if(value.size!==(actual??[]).length||[...value].some((id)=>!expected.includes(id))||expected.some((id)=>!value.has(id)))throw new Error(`${label} must exactly acknowledge: ${expected.join(", ")||"none"}.`);return value;}
  function toolResultWithFailures(summary:string,details:Record<string,unknown>,failed:boolean):AgentToolResult<any>{const result=resultText(summary,details);if(failed)(result as any).isError=true;return result;}

  async function control(params: WorkerControlInputV2, context: ExtensionContext): Promise<AgentToolResult<any>> {
    assertCurrentPackageGeneration();const parent=requireParentSession(context);const db=getRegistry();const preparedRoot=overrides.preparedRoot??defaultPreparedMergeRoot();
    if(params.action==="cleanup_inventory"){if(params.cursor&&!params.allSessions)throw new Error("Cleanup scan cursors require allSessions=true.");const scanState=params.cursor?loadCleanupScanCursor(db,parent,params.cursor):undefined;let inventory:CleanupInventory;try{inventory=await buildCleanupInventory(db,{parentSessionFile:parent,allSessions:params.allSessions??false,cwd:context.cwd,bdPath:overrides.bdPath,roots,preparedRoot,limit:params.limit,offset:params.offset,scanState});}catch(error){if(params.cursor)invalidateCleanupScanCursor(db,parent,params.cursor,now().toISOString());throw error;}if(!params.allSessions)cleanupInventoryByParent.set(parent,inventory);const nextCursor=params.allSessions?advanceCleanupScanCursor(db,parent,params.cursor,inventory.scan.continuation,now().toISOString()):undefined;const{continuation:_continuation,...publicScan}=inventory.scan;const maximum=Math.max(inventory.total.workers,inventory.total.prepared),offset=params.offset??0,limit=params.limit??20;return resultText(`${inventory.total.workers} workers · ${inventory.total.prepared} prepared sets · ${inventory.total.leftovers}${inventory.scan.partial?"+":""} leftovers`,{inventory:{workers:inventory.workers.map(publicCleanupWorker),prepared:inventory.prepared,leftovers:inventory.leftovers,total:inventory.total,scan:publicScan,generatedAt:inventory.generatedAt,...(offset+limit<maximum?{nextOffset:offset+limit}:{}),...(nextCursor?{nextCursor}:{})}});}
    if(params.action==="cleanup_preview") { const preview=await createCleanupSnapshot(db,{parentSessionFile:parent,workerIds:params.workerIds,preparedIds:params.preparedIds,leftoverIds:params.leftoverIds,cwd:context.cwd,bdPath:overrides.bdPath,roots,preparedRoot,ownerAuthority:(owner)=>cleanupOwnerAuthority(owner,parent),now:now()});return resultText(`cleanup preview · ${preview.snapshot.workers.length} workers · ${preview.snapshot.prepared.length} prepared · ${preview.snapshot.leftovers.length} leftovers`,publicCleanupPreview(preview)); }
    if(params.action==="cleanup_apply") {
      const loaded=loadCleanupSnapshot(db,parent,params.token);let preview:PersistedCleanupPreview;try{preview=await revalidateCleanupSnapshot(db,loaded,{cwd:context.cwd,bdPath:overrides.bdPath,roots,preparedRoot,ownerAuthority:(owner)=>cleanupOwnerAuthority(owner,parent),now:now()});}catch(error){invalidateCleanupSnapshot(db,parent,params.token,now().toISOString());throw error;}const snapshots=preview.snapshot.workers;const ids=snapshots.map((item)=>item.item.workerId);
      for(const snap of snapshots){if(snap.item.additionalPendingResults||snap.item.additionalUnpreservedArtifacts||snap.item.additionalPendingPreservations)throw new Error(`Worker ${snap.item.workerId} cleanup evidence exceeds the exact preview bound.`);if(snap.item.taskFacts.some((fact)=>fact.status==="missing"||fact.status==="unavailable"))throw new Error(`Worker ${snap.item.workerId} has unknown Beads facts and cannot be cleanup-applied.`);}const open=ids.filter((id)=>snapshots.find((item)=>item.item.workerId===id)!.item.taskFacts.some((fact)=>fact.status!=="closed"));const artifacts=ids.filter((id)=>snapshots.find((item)=>item.item.workerId===id)!.item.unpreservedArtifacts.length>0);const pending=ids.filter((id)=>snapshots.find((item)=>item.item.workerId===id)!.item.pendingResults.some((delivery)=>delivery.state==="pending"));const claimed=ids.filter((id)=>snapshots.find((item)=>item.item.workerId===id)!.item.pendingResults.some((delivery)=>delivery.state==="claimed"));
      const openAck=exactAcknowledgements(open,params.openTaskAbandonmentAcknowledged,"Open-task abandonment");const artifactAck=exactAcknowledgements(artifacts,params.artifactLossAcknowledged,"Artifact loss");const pendingAck=exactAcknowledgements(pending,params.pendingDeliveryTakeoverAcknowledged,"Pending-delivery takeover");const claimedAck=exactAcknowledgements(claimed,params.claimedDeliveryTakeoverAcknowledged,"Claimed-delivery takeover");const recovery=ids.filter((id)=>Boolean(snapshots.find((item)=>item.item.workerId===id)!.item.recoveryError));const recoveryAck=exactAcknowledgements(recovery,params.recoveryAcknowledged,"Recovery retry");void openAck;void artifactAck;
      for(const snap of snapshots){if(snap.status!=="idle"||snap.operationKind||snap.runClaims.length)throw new Error(`Worker ${snap.item.workerId} is active or claimed.`);if(snap.item.recoveryError&&snap.item.ownerSession!==parent){const recoveryFact=snap.runtime.cleanupRecovery as Record<string,unknown>|undefined;if(recoveryFact?.phase!=="precommit"||recoveryFact.error!==snap.item.recoveryError)throw new Error(`Foreign recovery for ${snap.item.workerId} is irreversible or lacks exact pre-commit evidence.`);}if(snap.item.ownerSession!==parent&&!['dead','retired','missing'].includes(snap.authority.state))throw new Error(`Owner of ${snap.item.workerId} is live or ambiguous.`);if(snap.item.ownerSession===parent&&snap.item.pendingResults.length)throw new Error(`Current-session non-delivered result for ${snap.item.workerId} must settle through normal delivery recovery.`);}
      for(const prepared of preview.snapshot.prepared){if(prepared.applyNonce)throw new Error(`Prepared set ${prepared.preparedId} retains apply authority and cannot be taken over.`);if(prepared.class==="retained"||/Task ownership is missing/.test(prepared.reason))throw new Error(`Prepared set ${prepared.preparedId} has open, missing, or unavailable Beads facts.`);}for(const leftover of preview.snapshot.leftovers)if(!leftover.eligible)throw new Error(`Leftover ${leftover.leftoverId} is not eligible.`);
      consumeCleanupSnapshot(db,parent,params.token,preview.snapshotHash,now().toISOString());const results:Array<Record<string,unknown>>=[];const processed=new Set<string>();const reviewerSnapshots=snapshots.filter((item)=>item.item.role==="review");const singles=snapshots.filter((item)=>item.item.role!=="review"&&!snapshots.some((reviewer)=>reviewer.item.role==="review"&&db.database.prepare("SELECT 1 FROM workers WHERE worker_id=? AND reviewed_by_worker_id=?").get(item.item.workerId,reviewer.item.workerId)));
      const executeGroup=async(reviewer:CleanupSnapshotWorker,subject?:CleanupSnapshotWorker):Promise<void>=>{const group=subject?[reviewer,subject]:[reviewer];const nonce=claimNonce();let adopted=false;try{const reviewerBefore=getWorker(db,reviewer.item.workerId);if(!reviewerBefore)throw new Error(`Worker ${reviewer.item.workerId} disappeared before host-log preflight.`);const reviewerPlan=cleanupHostLogs(db,reviewerBefore);if(reviewerPlan.leftovers.length)throw new Error(`Worker host logs could not be deleted safely: ${reviewerPlan.leftovers.map((entry)=>`${entry.path}: ${entry.reason}`).join("; ")}`);adoptCleanupWorkers(db,{snapshots:group,newParentSessionFile:parent,claimWorkerIds:[reviewer.item.workerId],nonce,now:now().toISOString(),pendingAcknowledged:pendingAck,claimedAcknowledged:claimedAck,recoveryAcknowledged:recoveryAck,consent:{token:params.token,snapshotHash:preview.snapshotHash,openTaskAbandonmentAcknowledged:[...openAck],artifactLossAcknowledged:[...artifactAck],pendingDeliveryTakeoverAcknowledged:[...pendingAck],claimedDeliveryTakeoverAcknowledged:[...claimedAck],recoveryAcknowledged:[...recoveryAck]},ownerAuthority:(owner)=>cleanupOwnerAuthority(owner,parent)});adopted=true;const claimedWorker=getWorker(db,reviewer.item.workerId)!;const done=await discardWorker(claimedWorker,nonce,reviewerPlan);results.push({kind:"worker",id:reviewer.item.workerId,status:"discarded",erasedArtifacts:reviewer.item.unpreservedArtifacts,deletedHostLogs:done.hostLogs});processed.add(reviewer.item.workerId);if(subject){const current=getWorker(db,subject.item.workerId);if(!current||current.parentSessionFile!==parent||current.latestRunId!==subject.item.latestRunId||current.version!==subject.item.version+2||current.reviewedByWorkerId)throw new Error(`Subject ${subject.item.workerId} changed after reviewer discard.`);const subjectPlan=cleanupHostLogs(db,current);if(subjectPlan.leftovers.length)throw new Error(`Worker host logs could not be deleted safely: ${subjectPlan.leftovers.map((entry)=>`${entry.path}: ${entry.reason}`).join("; ")}`);const freshNonce=claimNonce();if(current.recoveryError)claimWorkerRecoveryDiscard(db,current.workerId,current.version,current.recoveryError,freshNonce,now().toISOString());else claimWorkerDiscard(db,current.workerId,current.version,freshNonce,now().toISOString());const subjectDone=await discardWorker(getWorker(db,current.workerId)!,freshNonce,subjectPlan);results.push({kind:"worker",id:subject.item.workerId,status:"discarded",erasedArtifacts:subject.item.unpreservedArtifacts,deletedHostLogs:subjectDone.hostLogs});processed.add(subject.item.workerId);}}
        catch(error){const reason=sanitizeError(error);for(const item of group){if(processed.has(item.item.workerId))continue;if(adopted)markWorkerCleanupRecovery(db,item.item.workerId,parent,reason,now().toISOString());results.push({kind:"worker",id:item.item.workerId,status:"failed",reason});}}};
      for(const reviewer of reviewerSnapshots){if(processed.has(reviewer.item.workerId))continue;const subject=snapshots.find((item)=>item.item.reviewedByWorkerId===reviewer.item.workerId);await executeGroup(reviewer,subject);}
      for(const item of singles){if(processed.has(item.item.workerId))continue;await executeGroup(item);}
      for(const item of preview.snapshot.prepared){try{if(item.status==="discarding")finishPreparedSetDiscard(db,preparedRoot,item.preparedId);else if(item.ownerSession===parent)claimPreparedSetDiscard(db,parent,item.preparedId,now().toISOString());else{if(!['dead','retired','missing'].includes(cleanupOwnerAuthority(item.ownerSession,parent).state))throw new Error("prepared owner remains live or ambiguous");adoptPreparedSetDiscard(db,{preparedId:item.preparedId,expectedOwner:item.ownerSession,newParentSessionFile:parent,now:now().toISOString(),expectedAuthority:item.authority,ownerAuthority:(owner)=>cleanupOwnerAuthority(owner,parent)});}if(item.status!=="discarding")finishPreparedSetDiscard(db,preparedRoot,item.preparedId);results.push({kind:"prepared",id:item.preparedId,status:"discarded",...(item.status==="partial"||item.class==="partial"?{warning:"Discarded a partially applied prepared set."}:{})});}catch(error){results.push({kind:"prepared",id:item.preparedId,status:"failed",reason:sanitizeError(error)});}}
      const leftoverResults=await deleteCleanupLeftovers(db,preview.snapshot.leftovers,{roots,preparedRoot,projectCwd:context.cwd,prevalidated:true});for(const item of leftoverResults)results.push({kind:"leftover",...item});const failures=results.filter((item)=>item.status==="failed").length;return toolResultWithFailures(`${results.length-failures}/${results.length} cleanup items discarded`,{cleanup:{token:params.token,results}},failures>0);
    }
    if(params.action==="list") {const page=listWorkers(db,{parentSessionFile:parent,status:params.status,role:params.role,limit:params.limit,offset:params.offset});const counts=countWorkers(db,parent);const cached=new Map((cleanupInventoryByParent.get(parent)?.workers??[]).map((item)=>[item.workerId,item]));const workers=page.workers.map((worker)=>{const latest=worker.latestRunId?getWorkerRun(db,worker.workerId,worker.latestRunId):undefined;const notification=latest?publicDeliveryNotification(getWorkerDeliveryForRun(db,worker.workerId,latest.runId)):undefined;const cleanup=cached.get(worker.workerId);return{workerId:worker.workerId,role:worker.role,status:worker.status,...(worker.activeRunId?{activeRunId:worker.activeRunId}:{}),...(latest?.outcome?{latestResult:{runId:latest.runId,outcome:latest.outcome,outcomeSource:latest.outcomeSource}}:{}),...(notification?{notification}:{}),taskIds:worker.taskIds,...(worker.modelSelection?{modelSelection:worker.modelSelection}:{}),...(worker.recoveryError?{recoveryRequired:true}:{}),...(cleanup?{cleanup:{class:cleanup.class,reason:cleanup.reason,unpreservedArtifacts:cleanup.unpreservedArtifacts.slice(0,4),additionalUnpreservedArtifacts:Math.max(0,cleanup.unpreservedArtifacts.length-4),pendingPreservations:cleanup.preservations.filter((item)=>item.status==="pending").slice(0,64),additionalPendingPreservations:Math.max(0,cleanup.preservations.filter((item)=>item.status==="pending").length-64)}}:{}),lastActivityAt:worker.updatedAt};});void refreshCleanupInventory(parent,context.cwd).catch(()=>{});return resultText(`${page.total} workers · ${counts.running} running, ${counts.queued} queued, ${counts.idle} idle`,{workers,total:page.total,counts,...(page.nextOffset===undefined?{}:{nextOffset:page.nextOffset})});}
    if(params.action==="preserve"){ownedWorker(params.workerId,parent);const preserved=await preserveWorkerArtifacts(db,roots,runtimeRoot,{workerId:params.workerId,destination:params.destination,projectCwd:context.cwd,...(params.paths?{paths:params.paths}:{}),now:now()});return resultText(`preserved · ${preserved.items.length} items · ${params.workerId.slice(-8)}`,{preservation:preserved});}
    if(params.action==="discard") {const legacy="workerId" in params&&typeof params.workerId==="string";const workerIds="workerIds" in params&&params.workerIds?params.workerIds:legacy?[params.workerId]:[];const preparedIds="preparedIds" in params?params.preparedIds??[]:[];if(!workerIds.length&&!preparedIds.length)throw new Error("Discard requires at least one exact workerId or preparedId.");const rows=workerIds.map((id)=>{const worker=ownedWorker(id,parent);return worker;});const preparedTaskIds=preparedCleanupTaskIds(db,preparedIds);const facts=await readCleanupBeadsFacts([...new Set([...rows.flatMap((worker)=>worker.taskIds),...preparedTaskIds])],{cwd:context.cwd,...(overrides.bdPath?{bdPath:overrides.bdPath}:{})});for(const worker of rows){const item=classifyCleanupWorker(db,worker,facts);if(item.taskFacts.some((fact)=>fact.status!=="closed"))throw new Error(`Worker ${worker.workerId} has open or unavailable tasks; use cleanup_preview/cleanup_apply with exact abandonment consent.`);if(item.pendingResults.length)throw new Error(`Worker ${worker.workerId} has non-delivered results; use cleanup_preview/cleanup_apply with exact takeover consent.`);}const plans=workerIds.length?preflightWorkerDiscard(db,parent,{workerIds,...("artifactLossAcknowledged" in params&&params.artifactLossAcknowledged?{artifactLossAcknowledged:params.artifactLossAcknowledged}:{})}):[];const problems:string[]=[];for(const item of classifyPreparedCleanupIds(db,preparedIds,facts)){if(item.ownerSession!==parent)problems.push(`Prepared set ${item.preparedId} belongs to another parent session.`);else if(item.status!=="discarding"&&item.class!=="due")problems.push(`Prepared set ${item.preparedId} is ${item.class}; use cleanup_preview/cleanup_apply for explicit guarded cleanup.`);}if(problems.length)throw new Error(`Discard preflight failed:\n- ${problems.join("\n- ")}`);const items:Array<Record<string,unknown>>=[];for(const plan of plans){try{const current=getWorker(db,plan.worker.workerId);if(!current)throw new Error("worker disappeared after preflight");const completed=await discardWorker(current);items.push({kind:"worker",id:current.workerId,status:"discarded",erasedArtifacts:plan.erasedArtifacts,deletedHostLogs:completed.hostLogs});}catch(error){items.push({kind:"worker",id:plan.worker.workerId,status:"failed",reason:sanitizeError(error)});}}for(const preparedId of preparedIds){try{const claimedSet=claimPreparedSetDiscard(db,parent,preparedId,now().toISOString());finishPreparedSetDiscard(db,preparedRoot,preparedId);items.push({kind:"prepared",id:preparedId,status:"discarded",...(claimedSet.partial?{warning:"Discarded a partially applied prepared set."}:{})});}catch(error){items.push({kind:"prepared",id:preparedId,status:"failed",reason:sanitizeError(error)});}}const failures=items.filter((item)=>item.status==="failed").length;if(legacy&&items.length===1&&!failures)return resultText(`discarded · ${workerIds[0]!.slice(-8)}`,{workerId:workerIds[0]!,discarded:true});return toolResultWithFailures(`${items.length-failures}/${items.length} discarded`,{discarded:items},failures>0);}
    const worker=ownedWorker(params.workerId,parent);if(params.action==="runs"){const page=listWorkerRuns(db,worker.workerId,params.limit,params.offset);return resultText(`${page.runs.length} retained runs`,{workerId:worker.workerId,runs:page.runs.map(slimRun),total:page.total,...(page.nextOffset===undefined?{}:{nextOffset:page.nextOffset})});}if(params.action==="get"){const run=getWorkerRun(db,worker.workerId,params.runId);if(!run)throw new Error(`Unknown run ${params.runId} for worker ${worker.workerId}.`);const details=exactRun(worker,run,getWorkerDeliveryForRun(db,worker.workerId,run.runId),preservationRecords(db,worker.workerId));return resultText(`${run.outcome??run.status} · ${worker.role} · ${worker.workerId.slice(-8)}`,details);}const cancellation=await cancelWorker(worker);const current=getWorker(db,worker.workerId)??worker;return resultText(`${cancellation.replaceAll("_"," ")} · ${worker.workerId.slice(-8)}`,{cancellation,worker:workerListItem(current)});
  }

  function warnUnconfirmedCompletionSends(parentSessionFile: string): void {
    try {
      const context = currentContext;
      if (context?.mode !== "tui" || !context.hasUI || typeof context.ui?.notify !== "function") return;
      if (unconfirmedWarningGeneration !== runtimeGeneration) { unconfirmedWarningGeneration = runtimeGeneration; warnedUnconfirmedRuns.clear(); }
      for (const delivery of pendingWorkerDeliveries(getRegistry(), parentSessionFile)) {
        if (!delivery.sendStartedAt || delivery.state === "delivered" || warnedUnconfirmedRuns.has(delivery.runId)) continue;
        warnedUnconfirmedRuns.add(delivery.runId);
        context.ui.notify(`Worker ${delivery.workerId}/${delivery.runId} completed, but its notification is send_started_unconfirmed and will not be replayed automatically. Use /worker:show ${delivery.workerId} ${delivery.runId} for the retained result.`, "warning");
      }
    } catch { /* UI-only visibility must never affect lifecycle or model delivery. */ }
  }

  function recoverDeadDeliveryClaims(parentSessionFile: string): void {
    if (ensureCurrentRuntimeAuthority(parentSessionFile) !== "current") return;
    for (const delivery of pendingWorkerDeliveries(getRegistry(), parentSessionFile)) {
      if (delivery.state !== "claimed" || delivery.sendStartedAt || delivery.runtimeGeneration === undefined) continue;
      const owner = parentRuntimeMemberForGeneration(getRegistry(), parentSessionFile, delivery.runtimeGeneration);
      if (!owner || parentRuntimeMemberLiveness(owner) !== "dead") continue;
      recoverProvablyDeadWorkerDeliveryClaim(getRegistry(), { deliveryId: delivery.deliveryId, parentSessionFile, ownerGeneration: delivery.runtimeGeneration, runtimeGeneration });
    }
  }

  function reconcileActiveRuns(launchInputs: { projectCwd: string; parentSessionId: string }, parentSessionFile: string): void {
    const activeRuns = activeRunsForParent(getRegistry(), parentSessionFile);
    if (activeRuns.length === 0) return;
    try { assertCurrentPackageGeneration(); }
    catch (error) {
      if (generationMismatchNotifiedForRuntime !== runtimeGeneration) {
        generationMismatchNotifiedForRuntime = runtimeGeneration;
        try { currentContext?.ui.notify(sanitizeError(error), "error"); } catch {}
      }
      return;
    }
    if (ensureCurrentRuntimeAuthority(parentSessionFile) !== "current") return;
    const observedClaims = new Set<string>();
    for (const activeRun of activeRuns) {
      let worker = activeRun.worker; let run = activeRun.run; const runtime = run.runtime as RunRuntime;
      if (worker.storageLayout !== CURRENT_WORKER_STORAGE_LAYOUT) {
        deliverRecovery(worker, run, worker.recoveryError ?? `Worker ${worker.workerId} uses legacy storage layout ${worker.storageLayout}; explicit guarded cleanup is required.`);
        continue;
      }
      if (!runtime || runtime.version !== 4) {
        const schema = runtime && typeof runtime === "object" ? (runtime as { version?: unknown }).version ?? "unknown" : "missing";
        const message = `Unsupported retained worker runtime schema ${schema}; exact manual containment/migration is required and no downgrade will be attempted.`;
        setWorkerRecoveryError(getRegistry(), worker.workerId, run.runId, message, now().toISOString());
        deliverRecovery(worker, run, message);
        continue;
      }
      if (run.claimNonce) observedClaims.add(run.claimNonce);
      if (run.status === "running" && active.get(worker.workerId)?.runId !== run.runId && validAcceptedResultEvidence(worker, run)) {
        if (run.claimKind && !recoverDeadLifecycleClaim(worker.workerId, run)) continue;
        void settleCompletedRun(worker.workerId, run.runId, { status: "exited", exitCode: 0 }).catch((error) => recordRecovery(worker.workerId, run.runId, error));
        continue;
      }
      if (run.terminalIntent) {
        void beginTerminalRecovery(worker.workerId, run.runId).catch((error) => { if (!(error instanceof WorkerLifecycleOwnerBusyError)) { const current = getWorker(getRegistry(), worker.workerId); if (!current?.recoveryError) recordRecovery(worker.workerId, run.runId, error); } });
        continue;
      }
      if (run.claimKind) {
        if (!recoverDeadLifecycleClaim(worker.workerId, run)) { if (worker.recoveryError) deliverRecovery(worker, run, worker.recoveryError); continue; }
        worker = getWorker(getRegistry(), worker.workerId) ?? worker; run = getWorkerRun(getRegistry(), worker.workerId, run.runId) ?? run;
        if (run.claimKind) continue;
      }
      if (worker.recoveryError) {
        if (run.status === "running" && existsSync(runtime.settledFile) && existsSync(runtime.resultFile)) clearWorkerRecoveryError(getRegistry(), worker.workerId, run.runId, now().toISOString());
        else if (run.status === "queued") clearWorkerRecoveryError(getRegistry(), worker.workerId, run.runId, now().toISOString());
        else { deliverRecovery(worker, run, worker.recoveryError); continue; }
      }
      if (run.status === "queued") {
        if (existsSync(runtime.processFile)) {
          try {
            const processRecord = readExactWorkerHostProcess(runtime, worker.workerId, run.runId, "queued-run reconciliation");
            const liveness = probeHostIdentity(processRecord);
            if (liveness === "unknown") { recordRecovery(worker.workerId, run.runId, new WorkerHostIdentityError("Worker host process identity was ambiguous during queued-run reconciliation.")); continue; }
            if (liveness === "alive") {
              const nonce = lifecycleClaimNonce();
              if (claimWorkerRun(getRegistry(), worker.workerId, run.runId, "launch", nonce, ["queued"], runtimeGeneration)) {
                try { finalizeWorkerRunLaunch(getRegistry(), { workerId: worker.workerId, runId: run.runId, claimNonce: nonce, modelSelection: worker.modelSelection!, sessionId: worker.sessionId!, sessionFile: worker.sessionFile!, sessionStartLine: requiredRunStartLine(run, runtime, worker.sessionFile!), jobId: run.jobId!, stdoutLog: run.stdoutLog!, stderrLog: run.stderrLog!, runtime, startedAt: run.startedAt ?? now().toISOString() }); }
                catch (error) { releaseWorkerRunClaim(getRegistry(), worker.workerId, run.runId, "launch", nonce); throw error; }
              }
              continue;
            }
          } catch (error) { recordRecovery(worker.workerId, run.runId, error); continue; }
        }
        if (!pending.has(run.runId) && !starting.has(worker.workerId)) {
          runtime.launchProjectCwd ??= launchInputs.projectCwd; runtime.parentSessionId ??= launchInputs.parentSessionId;
          const item = { workerId: worker.workerId, runId: run.runId, parentSessionFile, parentSessionId: runtime.parentSessionId, runtime }; beginPreparedRun(item);
        }
        continue;
      }
      if (active.get(worker.workerId)?.runId === run.runId) continue;
      if (existsSync(runtime.settledFile) && existsSync(runtime.resultFile)) { void settleCompletedRun(worker.workerId, run.runId, { status: "exited", exitCode: 0 }).catch((error) => recordRecovery(worker.workerId, run.runId, error)); continue; }
      if (existsSync(runtime.processFile)) {
        try {
          const process = readExactWorkerHostProcess(runtime, worker.workerId, run.runId, "running-run reconciliation");
          const liveness = probeHostIdentity(process);
          if (liveness === "alive") continue;
          if (liveness === "unknown") { recordRecovery(worker.workerId, run.runId, new WorkerHostIdentityError("Worker host process identity was ambiguous during running-run reconciliation.")); continue; }
        } catch (error) { recordRecovery(worker.workerId, run.runId, error); continue; }
      }
      let nonce: string;
      try { nonce = lifecycleClaimNonce(); }
      catch (error) { requestWorkerFailure(getRegistry(), worker.workerId, run.runId, sanitizeError(error), now().toISOString(), runtimeGeneration); continue; }
      if (claimWorkerRun(getRegistry(), worker.workerId, run.runId, "settlement", nonce, ["running"], runtimeGeneration)) void failClaimedRun(worker.workerId, run.runId, "settlement", nonce, new Error("Worker supervisor exited without a verified result settlement.")).catch((error) => recordRecovery(worker.workerId, run.runId, error));
    }
    for (const nonce of lifecycleClaimProbeAt.keys()) if (!observedClaims.has(nonce)) lifecycleClaimProbeAt.delete(nonce);
  }

  function registerCommands(): void {
    api.registerCommand("worker:list", { description: "List retained workers; optional status and role filters", handler: async (args, context) => { const [status, role] = args.trim().split(/\s+/).filter(Boolean); const result = await control({ action: "list", ...(status ? { status: status as any } : {}), ...(role ? { role: role as any } : {}) }, context); context.ui.notify(compactWorkerList((result as any).details), "info"); } });
    api.registerCommand("worker:show", { description: "Show an active/latest or exact retained worker run", handler: async (args, context) => { const [workerId, runId] = args.trim().split(/\s+/); if (!workerId) return context.ui.notify("Usage: /worker:show <workerId> [runId]", "info"); const worker = ownedWorker(workerId, requireParentSession(context)); const exact = runId ?? worker.activeRunId ?? worker.latestRunId; if (!exact) return context.ui.notify(`Worker ${workerId} has no runs.`, "info"); const result = await control({ action: "get", workerId, runId: exact }, context); context.ui.notify(formatExactRun((result as any).details), "info"); } });
    api.registerCommand("worker:view", { description: "Open a bounded read-only conversation view for an active/latest or exact worker run", handler: async (args, context) => {
      const values = args.trim().split(/\s+/).filter(Boolean); const [workerId, runId, ...extra] = values;
      if (!workerId || extra.length || (runId !== undefined && !runId.startsWith("run_"))) return context.ui.notify("Usage: /worker:view <workerId> [runId]", "info");
      try {
        const parent = requireParentSession(context);
        const target = workerViewTarget(workerId, runId, parent);
        await openWorkerSessionViewer(context, target, () => workerViewTarget(workerId, target.runId, parent));
      } catch (error) { context.ui.notify(sanitizeViewText(error instanceof Error ? error.message : String(error)), "error"); }
    } });
    api.registerCommand("worker:logs", { description: "Open logs for an active/latest or exact retained worker run", handler: async (args, context) => { const [workerId, possibleRun, ...viewer] = args.trim().split(/\s+/).filter(Boolean); if (!workerId) return context.ui.notify("Usage: /worker:logs <workerId> [runId] [viewer options]", "info"); const worker = ownedWorker(workerId, requireParentSession(context)); const hasRun = possibleRun?.startsWith("run_"); const runId = (hasRun ? possibleRun : undefined) ?? worker.activeRunId ?? worker.latestRunId; const run = runId ? getWorkerRun(getRegistry(), workerId, runId) : undefined; if (!run?.jobId) return context.ui.notify("No retained run logs.", "info"); await handleAsyncShellViewerCommand(context, [run.jobId, ...(hasRun ? viewer : [possibleRun, ...viewer].filter(Boolean))].join(" ")); } });
    api.registerCommand("worker:cancel", { description: "Cancel active work while preserving retained state", handler: async (args, context) => { const workerId = args.trim(); if (!workerId) return context.ui.notify("Usage: /worker:cancel <workerId>", "info"); const result = await cancelWorker(ownedWorker(workerId, requireParentSession(context))); context.ui.notify(result === "cancelled" ? `Cancelled ${workerId}.` : result === "accepted_pending" ? `Cancellation accepted for ${workerId}; the current runtime will finish it.` : result === "superseded" ? `Cancellation for ${workerId} was superseded by a terminal result.` : "Worker is not active.", "info"); } });
    api.registerCommand("worker:discard", { description: "Discard one delivered, closed-task idle worker; early loss uses /worker:cleanup", handler: async (args, context) => { const [workerId,confirm,...extra]=args.trim().split(/\s+/).filter(Boolean);if(!workerId||confirm!=="--confirm"||extra.length)return context.ui.notify("Usage: /worker:discard <workerId> --confirm", "info");try{await control({action:"discard",workerId},context);context.ui.notify(`Discarded ${workerId}.`,"info");}catch(error){context.ui.notify(`${sanitizeError(error)} Use /worker:cleanup to preview early loss or delivery takeover.`,"error");} } });
    api.registerCommand("worker:cleanup", { description: "Page, preview, or apply the same persisted cleanup workflow as worker_control", handler: async (args, context) => {
      const values=args.trim().split(/\s+/).filter(Boolean);const confirmAt=values.indexOf("--confirm"),token=confirmAt>=0?values[confirmAt+1]:undefined,allSessions=values.includes("--all-sessions"),offsetAt=values.indexOf("--offset"),offset=offsetAt>=0?Number(values[offsetAt+1]):0,cursorAt=values.indexOf("--cursor"),cursor=cursorAt>=0?values[cursorAt+1]:undefined;
      if(!Number.isSafeInteger(offset)||offset<0||(cursor&&!allSessions)||(confirmAt>=0&&(!token||confirmAt+2!==values.length))||values.some((value,index)=>!["--all-sessions","--offset","--cursor","--confirm"].includes(value)&&index!==offsetAt+1&&index!==cursorAt+1&&index!==confirmAt+1))return context.ui.notify("Usage: /worker:cleanup [--all-sessions] [--offset N] [--cursor <cleanup_scan token>] [--confirm <cleanup token>]","info");
      if(token){const parent=requireParentSession(context);const preview=loadCleanupSnapshot(getRegistry(),parent,token);const workers=preview.snapshot.workers;const applied=await control({action:"cleanup_apply",token,openTaskAbandonmentAcknowledged:workers.filter((item)=>item.item.taskFacts.some((fact)=>fact.status!=="closed")).map((item)=>item.item.workerId),artifactLossAcknowledged:workers.filter((item)=>item.item.unpreservedArtifacts.length).map((item)=>item.item.workerId),pendingDeliveryTakeoverAcknowledged:workers.filter((item)=>item.item.pendingResults.some((delivery)=>delivery.state==="pending")).map((item)=>item.item.workerId),claimedDeliveryTakeoverAcknowledged:workers.filter((item)=>item.item.pendingResults.some((delivery)=>delivery.state==="claimed")).map((item)=>item.item.workerId),recoveryAcknowledged:workers.filter((item)=>Boolean(item.item.recoveryError)).map((item)=>item.item.workerId)},context);const results=((applied as any).details.cleanup.results as Array<{kind:string;id:string;status:string;warning?:string;reason?:string}>),failed=results.filter((item)=>item.status==="failed").length,lines=results.map((item)=>`${item.kind} ${item.id}: ${item.status}${item.warning?` · warning: ${item.warning}`:""}${item.reason?` · ${item.reason}`:""}`);context.ui.notify(`${failed?`Cleanup failed for ${failed}/${results.length} items.`:`Cleanup completed for ${results.length}/${results.length} items.`}\n${lines.join("\n")}`,failed?"error":results.some((item)=>item.warning)?"warning":"info");return;}
      const inventoryResult=await control({action:"cleanup_inventory",allSessions,limit:32,offset,...(cursor?{cursor}:{})},context);const inventory=(inventoryResult as any).details.inventory as {workers:Array<{workerId:string;class:string}>;prepared:Array<{preparedId:string;class:string}>;leftovers:Array<{leftoverId:string;eligible:boolean}>;nextOffset?:number;nextCursor?:string};const workerIds=inventory.workers.filter((item)=>item.class==="due").map((item)=>item.workerId);const preparedIds=inventory.prepared.filter((item)=>item.class==="due"||item.class==="discarding").map((item)=>item.preparedId);const leftoverIds=inventory.leftovers.filter((item)=>item.eligible).map((item)=>item.leftoverId);if(!workerIds.length&&!preparedIds.length&&!leftoverIds.length){context.ui.notify(`No eligible cleanup items on page at offset ${offset}.${inventory.nextOffset!==undefined?` Next offset: ${inventory.nextOffset}.`:""}${inventory.nextCursor?` Resume filesystem scan with --cursor ${inventory.nextCursor}.`:""}`,"info");return;}const previewResult=await control({action:"cleanup_preview",...(workerIds.length?{workerIds}:{}),...(preparedIds.length?{preparedIds}:{}),...(leftoverIds.length?{leftoverIds}:{})},context);context.ui.notify(`${(previewResult.content[0] as any).text}\n${JSON.stringify((previewResult as any).details)}\nConfirm with /worker:cleanup --confirm ${(previewResult as any).details.token}${inventory.nextOffset!==undefined?`\nNext registry page: --offset ${inventory.nextOffset}`:""}${inventory.nextCursor?`\nResume filesystem inventory: --all-sessions --cursor ${inventory.nextCursor}`:""}`,"warning");
    } });
  }

  function workerViewTarget(workerId: string, requestedRunId: string | undefined, parent: string): WorkerSessionViewTarget {
    const worker = ownedWorker(workerId, parent);
    const runId = requestedRunId ?? worker.activeRunId ?? worker.latestRunId;
    if (!runId) throw new Error("Worker has no retained runs.");
    const run = getWorkerRun(getRegistry(), worker.workerId, runId);
    if (!run) throw new Error("Worker has no matching retained run.");
    if (!worker.sessionId || !worker.sessionFile) throw new Error("Worker has no retained Pi session.");
    return { workerId: worker.workerId, role: worker.role, workerStatus: worker.status, runId: run.runId, runStatus: run.status, ...(run.outcome ? { outcome: run.outcome } : {}), ...(run.modelSelection ?? worker.modelSelection ? { modelSelection: run.modelSelection ?? worker.modelSelection } : {}), sessionId: worker.sessionId, sessionFile: worker.sessionFile, sessionRoot: storedWorkerPaths(roots, worker).sessionDir, workspaceRoot: worker.workspaceRoot, parentSessionFile: worker.parentSessionFile, ...(run.sessionStartLine === undefined ? {} : { sessionStartLine: run.sessionStartLine }), ...(run.sessionEndLine === undefined ? {} : { sessionEndLine: run.sessionEndLine }) };
  }
  function currentWorkerPaths(worker: WorkerRegistryRecord): WorkerPaths {
    if (worker.storageLayout !== CURRENT_WORKER_STORAGE_LAYOUT) throw new Error(`Worker ${worker.workerId} uses legacy storage layout ${worker.storageLayout}; explicit guarded cleanup is required and resume is refused.`);
    return storedWorkerPaths(roots, worker);
  }
  function cleanupWorkerPaths(worker: WorkerRegistryRecord): WorkerPaths { return storedWorkerPaths(roots, worker); }
  function ownedWorker(workerId: string, parent: string): WorkerRegistryRecord { const worker = getWorker(getRegistry(), workerId); if (!worker || worker.parentSessionFile !== parent) throw new Error(`Unknown worker ${workerId} for this parent session.`); return worker; }
  function reviewSubject(runId: string, parent: string, reviewerWorkerId?: string) {
    const found = findWorkerRunById(getRegistry(), runId); if (!found || found.worker.parentSessionFile !== parent) throw new Error(`Unknown reviewed run ${runId}.`);
    const { worker, run } = found; if (!(["work", "integration"] as WorkerRole[]).includes(worker.role) || run.status !== "settled" || run.outcome !== "completed" || worker.latestRunId !== runId || worker.status !== "idle" || !worker.sessionFile || run.sessionStartLine === undefined || run.sessionEndLine === undefined) throw new Error(`Review requires the latest completed run of an idle work or integration worker; ${runId} is not eligible.`);
    if (worker.reviewedByWorkerId && worker.reviewedByWorkerId !== reviewerWorkerId) throw new Error(`Worker ${worker.workerId} is leased to reviewer ${worker.reviewedByWorkerId}.`); return found;
  }
  function discardTrashPaths(original: string): string[] {
    const parent = path.dirname(original); if (!existsSync(parent)) return [];
    const prefix = `${path.basename(original)}.discard-`;
    return readdirSync(parent).filter((name) => name.startsWith(prefix) && /^\d+-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name.slice(prefix.length))).sort().map((name) => path.join(parent, name));
  }

  function claimNonce(): string { return `${runtimeGeneration}-${randomUUID()}`; }
  function lifecycleClaimNonce(): string {
    if (!parentProcessStartToken) throw new WorkerContainmentError("Unable to capture the parent lifecycle claim owner start token.");
    const digest = createHash("sha256").update(parentProcessStartToken).digest("hex");
    return `${runtimeGeneration}-${process.pid}-${digest}-${randomUUID()}`;
  }
  function lifecycleClaimNonceLiveness(nonce: string): AsyncJobProcessIdentityLiveness | undefined {
    const match = /^(?:[1-9][0-9]*)-([1-9][0-9]*)-([a-f0-9]{64})-/.exec(nonce);
    if (!match) return undefined;
    const pid = Number(match[1]); const expectedDigest = match[2]!; const observed = pid === process.pid ? parentProcessStartToken : readProcessStartToken(pid);
    if (observed) return createHash("sha256").update(observed).digest("hex") === expectedDigest ? "alive" : "dead";
    try { process.kill(pid, 0); return "unknown"; }
    catch (error) { return error && typeof error === "object" && "code" in error && error.code === "ESRCH" ? "dead" : "unknown"; }
  }
  function managedCandidateWarnings(parentSessionFile: string) { return (candidateRepo: string, candidateCommit: string) => {
    const rows = getRegistry().database.prepare("SELECT r.run_id,r.repositories_json,w.worker_id,w.latest_run_id,w.status,w.workspace_root FROM runs r JOIN workers w ON w.worker_id=r.worker_id WHERE r.status='settled' AND w.parent_session_file=?").all(parentSessionFile) as Array<any>;
    const exactCandidate = realpathOrResolve(candidateRepo);
    for (const row of rows) { const item = (JSON.parse(row.repositories_json) as WorkerRepositoryResult[]).find((candidate) => realpathOrResolve(path.resolve(row.workspace_root, candidate.path)) === exactCandidate && candidate.commit === candidateCommit); if (!item) continue; const latest = row.run_id === row.latest_run_id; const warnings = [...(!latest ? [`Candidate belongs to historical run ${row.run_id}; latest is ${row.latest_run_id}.`] : []), ...(row.status !== "idle" ? ["Source worker has a newer active run that may supersede this candidate."] : [])]; return { source: { workerId: row.worker_id, runId: row.run_id, latest }, ...(warnings.length ? { warnings } : {}) }; } return {}; } }
  function deliverRecovery(worker: WorkerRegistryRecord, run: WorkerRunRecord, error: string): void { const key = `${runtimeGeneration}:${run.runId}`; if (deliveredRecovery.has(key) || !currentContext?.sessionManager.getSessionFile() || realpathOrResolve(currentContext.sessionManager.getSessionFile()!) !== worker.parentSessionFile) return; deliveredRecovery.add(key); const event = { event: "worker_recovery_required", workerId: worker.workerId, runId: run.runId, role: worker.role, status: run.status === "settled" ? "running" : run.status, error: sanitizeError(error) }; api.sendMessage({ customType: "worker-run", content: JSON.stringify(event), display: true, details: event }, { triggerTurn: true, deliverAs: "steer" }); }
  function recordRecovery(workerId: string, runId: string, error: unknown): void { try { const message = sanitizeError(error); setWorkerRecoveryError(getRegistry(), workerId, runId, message, now().toISOString()); const worker = getWorker(getRegistry(), workerId); const run = worker && getWorkerRun(getRegistry(), workerId, runId); if (worker && run) deliverRecovery(worker, run, message); } catch {} }
}

function prepareOwnerRemovalTree(root: string): void {
  let rootMetadata: ReturnType<typeof lstatSync>;
  try { rootMetadata = lstatSync(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return;
  const pending = [root]; let visited = 0;
  while (pending.length) {
    const directory = pending.pop()!; if (++visited > 1_000_000) throw new Error(`Owner-removal preflight exceeds 1000000 directories beneath ${root}.`);
    const metadata = lstatSync(directory); if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue; chmodSync(directory, 0o700);
    for (const name of readdirSync(directory)) { const candidate = path.join(directory, name); const child = lstatSync(candidate); if (child.isDirectory() && !child.isSymbolicLink()) pending.push(candidate); }
  }
}
function removeOwnerTree(root: string): void { prepareOwnerRemovalTree(root); rmSync(root, { recursive: true, force: true }); }

function immutablePromptInputs(inputs: RetainedInput[]): Array<{ sourcePath: string; mountedPath: string; type: "file" | "directory" }> {
  return inputs.map((item) => ({ sourcePath: item.mountedPath, mountedPath: item.mountedPath, type: item.type }));
}

function updateWorkerActivityStatus(registry: WorkerRegistry, context: ExtensionContext): void {
  if (context.mode !== "tui" || !context.hasUI || typeof context.ui?.setStatus !== "function" || !context.ui.theme) return;
  let count = 0;
  try { count = activeWorkerCountForContext(registry, context); } catch {}
  context.ui.setStatus(WORKER_ACTIVITY_STATUS_KEY, renderWorkerActivityStatus(count, context.ui.theme));
}

export function assertWorkerStoragePaths(paths: WorkerPaths): void {
  const worker = lstatSync(paths.workerDir); if (!worker.isDirectory() || worker.isSymbolicLink()) throw new Error("Worker parent must remain an ordinary directory.");
  ensureContainedOrdinaryDirectory(paths.workerDir, paths.stateDir, "worker guest directory");
  ensureContainedOrdinaryDirectory(paths.workerDir, paths.supervisionDir, "worker host directory");
  if (path.dirname(paths.stateDir) !== paths.workerDir || path.basename(paths.stateDir) !== "guest" || path.dirname(paths.supervisionDir) !== paths.workerDir || path.basename(paths.supervisionDir) !== "host") throw new Error("Worker storage must use exact guarded guest/host children.");
  if (path.resolve(paths.supervisionDir).startsWith(`${path.resolve(paths.stateDir)}${path.sep}`)) throw new Error("Worker host state cannot be nested beneath the guest-writable root.");
  ensureContainedOrdinaryDirectory(paths.stateDir, paths.sessionDir, "worker session directory");
  ensureContainedOrdinaryDirectory(paths.stateDir, path.join(paths.stateDir, "async-shell"), "worker async directory");
  ensureContainedOrdinaryDirectory(path.dirname(paths.workspaceRoot), paths.workspaceRoot, "worker workspace");
  for (const [directory, label] of [[paths.reposDir, "repository"], [paths.scratchDir, "scratch"], [paths.cacheDir, "cache"], [paths.artifactsDir, "artifact"], [paths.tempDir, "temporary"]] as const) ensureContainedOrdinaryDirectory(paths.workspaceRoot, directory, `worker ${label} directory`);
  for (const name of ["config", "data", "state"]) ensureContainedOrdinaryDirectory(paths.cacheDir, path.join(paths.cacheDir, name), `worker cache ${name} directory`);
}
function ensureContainedOrdinaryDirectory(root: string, directory: string, label: string): void {
  try { assertContainedOrdinaryDirectory(root, directory, label); return; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertContainedOrdinaryDirectory(root, directory, label);
}

function prepareCacheLineageDirectory(paths: WorkerPaths, runId: string): string {
  const root = path.join(paths.stateDir, "cache-lineage"); ensureContainedOrdinaryDirectory(paths.stateDir, root, "worker cache-lineage root"); const generation = path.join(root, runId);
  if (existsSync(generation)) throw new Error(`Worker cache-lineage generation already exists: ${runId}.`); mkdirSync(generation, { mode: 0o700 }); assertContainedOrdinaryDirectory(root, generation, "worker cache-lineage generation"); return generation;
}
function runInputDirectory(paths: WorkerPaths, runId: string, ensure = true): string {
  const root=path.join(paths.stateDir,"run-inputs"),directory=path.join(root,runId);
  if (ensure) { ensureContainedOrdinaryDirectory(paths.stateDir,root,"worker run-input root"); ensureContainedOrdinaryDirectory(root,directory,"worker run-input directory"); }
  return directory;
}
export function snapshotAdditionalInputs(directory: string, inputs: RetainedInput[]): RetainedInput[] {
  const root = path.join(directory, "additional"); rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true, mode: 0o700 });
  const budget = { nodes: 0, bytes: 0 };
  return inputs.map((item, index) => {
    const original = realpathSync(item.sourcePath); const name = `${String(index + 1).padStart(3, "0")}-${createHash("sha256").update(original).digest("hex").slice(0, 12)}-${path.basename(original)}`; const target = path.join(root, name);
    const metadata = lstatSync(original);
    if (metadata.isFile()) { mkdirSync(target, { mode: 0o700 }); const mountedPath = path.join(target, path.basename(original)); snapshotOrdinaryNode(original, mountedPath, budget); chmodSync(target, 0o700); return { ...item, source: target, target, mountedPath }; }
    snapshotOrdinaryNode(original, target, budget);
    return { ...item, source: target, target, mountedPath: target };
  });
}
function snapshotOrdinaryNode(source: string, target: string, budget: { nodes: number; bytes: number }): void {
  if (++budget.nodes > 10_000) throw new Error("Additional-input snapshot exceeds 10000 ordinary filesystem nodes.");
  const metadata = lstatSync(source); if (metadata.isSymbolicLink()) throw new Error(`Additional-input snapshots reject symbolic links: ${source}.`);
  if (metadata.isDirectory()) { mkdirSync(target, { mode: 0o700 }); for (const name of readdirSync(source).sort()) snapshotOrdinaryNode(path.join(source, name), path.join(target, name), budget); chmodSync(target, 0o700); return; }
  if (!metadata.isFile()) throw new Error(`Additional-input snapshots accept ordinary files and directories only: ${source}.`);
  if ((budget.bytes += metadata.size) > 256 * 1024 * 1024) throw new Error("Additional-input snapshot exceeds 256 MiB.");
  const descriptor = openSync(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); try { const current = fstatSync(descriptor); if (!current.isFile() || current.dev !== metadata.dev || current.ino !== metadata.ino || current.size !== metadata.size) throw new Error(`Additional input changed during snapshot: ${source}.`); writeFileSync(target, readFileSync(descriptor), { mode: 0o400, flag: "wx" }); } finally { closeSync(descriptor); }
}
function writeReviewContext(directory: string, subjectPaths: WorkerPaths, reviewerWorkerId: string, contextId: string, subjectWorker: WorkerRegistryRecord, subjectRun: WorkerRunRecord, inputs: RetainedInput[]): string {
  if (path.resolve(subjectWorker.workspaceRoot) !== path.resolve(subjectPaths.workspaceRoot)) throw new Error("Review subject workspace identity mismatch.");
  assertContainedOrdinaryDirectory(path.dirname(subjectPaths.workspaceRoot), subjectWorker.workspaceRoot, "review subject workspace");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(directory, "session.jsonl");
  const session = readBoundedNoFollowFile(subjectWorker.sessionFile!, subjectPaths.stateDir, 128 * 1024 * 1024, "review subject session");
  const sessionText = new TextDecoder("utf-8", { fatal: true }).decode(session); const lines = sessionText.split("\n");
  const sourceLineCount = sessionText === "" ? 0 : lines.length - (sessionText.endsWith("\n") ? 1 : 0);
  const startLine = subjectRun.sessionStartLine ?? 1; const endLine = subjectRun.sessionEndLine ?? sourceLineCount;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine > sourceLineCount) throw new Error("Review subject session range is invalid.");
  const selected = lines.slice(startLine - 1, endLine).join("\n");
  writeFileSync(sessionFile, `${selected}${selected && !selected.endsWith("\n") ? "\n" : ""}`, { mode: 0o400 });
  const skippedRepositories: Array<{ candidateId: string; path: string; reason: string }> = [];
  const repositories: WorkerRepositoryResult[] = [];
  for (const repository of subjectRun.repositories) {
    if (!repository.eligible || !/^[0-9a-f]{40}$/.test(repository.commit)) { skippedRepositories.push({ candidateId: repository.candidateId, path: repository.path, reason: repository.eligible ? "The reported commit is not an exact lowercase 40-hex object ID." : (repository.issues?.join("; ") || "Repository was not eligible at result acceptance.") }); continue; }
    const source = path.join(subjectWorker.workspaceRoot, repository.path); assertContainedOrdinaryDirectory(subjectWorker.workspaceRoot, source, "review candidate repository");
    if (trustedGit(source, ["rev-parse", `${repository.commit}^{commit}`]).trim() !== repository.commit) throw new Error("Review candidate commit is unavailable from its reported repository.");
    repositories.push({ ...repository, path: repository.path });
  }
  const overlayPath = (source: string, label: string): string => { assertContainedPathWithoutSymlinks(subjectWorker.workspaceRoot, source, label); const relative = path.relative(subjectWorker.workspaceRoot, source); return path.posix.join("/review/subject", ...relative.split(path.sep)); };
  const artifacts = subjectRun.artifacts.map((artifact) => overlayPath(path.resolve(subjectWorker.workspaceRoot, artifact), "review subject artifact"));
  const available = new Map(repositories.map((repository) => [repository.candidateId, repository]));
  const candidates = subjectRun.repositories.map(({ candidateId, path: reportedPath, reported, changed, dirty, eligible, issues }) => { const repository = available.get(candidateId); return { candidateId, reportedPath, reported, changed, dirty, eligible, available: Boolean(repository), ...(repository ? { path: repository.path } : {}), ...(issues ? { issues } : {}) }; });
  const file = path.join(directory, "context.json");
  const value = { version: 3, reviewerWorkerId, reviewedWorkerId: subjectWorker.workerId, reviewedRunId: subjectRun.runId, subjectWorkspace: "/review/subject", session: { path: sessionFile, sourceRange: { startLine, endLine }, snapshotRange: { startLine: 1, endLine: endLine - startLine + 1 } }, repositories, skippedRepositories, artifacts, candidates, additionalInputs: contextInputs(inputs) };
  writeReadonlyJson(file, value); return file;
}
function reviewSessionFile(contextFile: string): string { return path.join(path.dirname(contextFile), "session.jsonl"); }
function readBoundedNoFollowFile(file: string, trustedRoot: string, maximumBytes: number, label: string): Buffer {
  assertContainedPathWithoutSymlinks(trustedRoot, file, label);
  const descriptor = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try { const stat = fstatSync(descriptor); if (!stat.isFile() || stat.size > maximumBytes) throw new Error(`${label} must be an ordinary file no larger than ${maximumBytes} bytes.`); return readFileSync(descriptor); }
  finally { closeSync(descriptor); }
}
function assertContainedOrdinaryDirectory(trustedRoot: string, directory: string, label: string): void {
  assertContainedPathWithoutSymlinks(trustedRoot, directory, label);
  if (!lstatSync(directory).isDirectory()) throw new Error(`${label} must be an ordinary directory.`);
}
function assertContainedPathWithoutSymlinks(trustedRoot: string, candidate: string, label: string): void {
  const root = realpathSync(trustedRoot); const lexical = path.resolve(candidate); const relative = path.relative(root, lexical);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} must remain beneath its retained worker root.`);
  let current = root;
  for (const component of relative.split(path.sep)) { current = path.join(current, component); if (lstatSync(current).isSymbolicLink()) throw new Error(`${label} may not traverse symbolic links.`); }
  const exact = realpathSync(lexical); const exactRelative = path.relative(root, exact);
  if (exactRelative === "" || exactRelative === ".." || exactRelative.startsWith(`..${path.sep}`) || path.isAbsolute(exactRelative)) throw new Error(`${label} resolves outside its retained worker root.`);
}

function trustedPreparedSet(registry: WorkerRegistry, parentSessionFile: string, preparedId: string, consumedWorkspace?: string): ReturnType<typeof readPreparedMergeSet> {
  const record = readPreparedSetRecord(registry, parentSessionFile, preparedId);
  const repositories = consumedWorkspace && record.status === "consumed" ? record.repositories.map((item: any) => ({ ...item, preparedPath: path.join(consumedWorkspace, "prepared", preparedId, item.id) })) : record.repositories;
  return { version: 1, preparedId: record.preparedId, parentSessionFile: record.parentSessionFile, status: (["ready", "partial", "failed"] as string[]).includes(record.status) ? "ready" : "resolution_required", order: record.order, repositories: repositories as any, createdAt: record.createdAt };
}
function assertIntegrationTargetsCurrent(set: ReturnType<typeof readPreparedMergeSet>): void { for (const repository of set.repositories) { const current = trustedGit(repository.targetRepo, ["rev-parse", repository.targetRef]).trim(); if (current !== repository.expectedCommit) throw new Error(`Target ${repository.id} moved from ${repository.expectedCommit} to ${current}; run worker_merge_test again before integration.`); } }
function writeIntegrationContext(paths: WorkerPaths, directory: string, set: ReturnType<typeof readPreparedMergeSet>, inputs: RetainedInput[], resumed: boolean): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 }); const file = path.join(directory, "context.json");
  const preparedId = set.preparedId;
  const value = { version: 2, preparedId, status: set.status, order: set.order, resumed, repositories: set.repositories.map((item: any) => ({ id: item.id, path: path.relative(paths.workspaceRoot, item.preparedPath).split(path.sep).join("/"), method: item.method, status: item.status, dependsOn: item.dependsOn, target: { repo: item.targetRepo, ref: item.targetRef, commit: item.expectedCommit, privateRef: item.targetPrivateRef }, candidate: { repo: item.candidateRepo, commit: item.candidateCommit, privateRef: item.candidatePrivateRef }, mergeBase: item.mergeBase, conflicts: item.conflicts ?? [], mergeMessages: item.mergeMessages ?? [], overlapCount: item.overlapCount })), additionalInputs: contextInputs(inputs) };
  writeReadonlyJson(file, value); return file;
}
function writeReadonlyJson(file: string, value: unknown): void { if (existsSync(file)) chmodSync(file, 0o600); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); chmodSync(file, 0o400); }
function sessionIdentity(paths: WorkerPaths): { sessionId: string; sessionFile: string; sessionDir: string } {
  const files = existsSync(paths.sessionDir) ? readdirSync(paths.sessionDir).filter((name) => name.endsWith(".jsonl")) : [];
  if (files.length !== 1) throw new Error(`Expected one fresh worker session in ${paths.sessionDir}.`);
  const { sessionFile, header } = readWorkerSessionHeader(path.join(paths.sessionDir, files[0]!), { sessionDir: paths.sessionDir });
  return { sessionId: header.id, sessionFile, sessionDir: paths.sessionDir };
}
function verifyRetainedSession(worker: WorkerRegistryRecord, paths: WorkerPaths): void {
  if (worker.role === "work") {
    verifyWorkerSession({ sessionFile: worker.sessionFile!, sessionDir: paths.sessionDir, sessionId: worker.sessionId!, workspaceRoot: worker.workspaceRoot, parentSessionFile: worker.parentSessionFile });
    return;
  }
  const { header } = readWorkerSessionHeader(worker.sessionFile!, { sessionDir: paths.sessionDir });
  if (header.id !== worker.sessionId || realpathOrResolve(header.cwd) !== realpathOrResolve(worker.workspaceRoot) || header.parentSession) throw new Error(`Worker ${worker.workerId} retained independent session is invalid.`);
}
function runtimeInputs(worker: WorkerRegistryRecord): RetainedInput[] { const value = worker.runtime?.inputs; return Array.isArray(value) ? value as RetainedInput[] : []; }
function retainedWorkerRuntime(worker: WorkerRegistryRecord): Partial<WorkerRuntime> { const baselines = worker.runtime?.repositoryBaselines; const cacheLineage = worker.runtime?.cacheLineage; return { ...(Array.isArray(baselines) ? { repositoryBaselines: baselines as any } : {}), ...(cacheLineage && typeof cacheLineage === "object" ? { cacheLineage: cacheLineage as WorkerCacheLineageRecord } : {}) }; }
function parseWorkerModelSelection(value: string): { provider: string; model: string; thinkingLevel: string } { const slash = value.indexOf("/"); const colon = value.lastIndexOf(":"); if (slash < 1 || colon <= slash + 1) throw new Error(`Invalid worker model selection: ${value}.`); return { provider: value.slice(0, slash), model: value.slice(slash + 1, colon), thinkingLevel: value.slice(colon + 1) }; }
function reviewedRunProvider(run: WorkerRunRecord): string { if (!run.modelSelection) throw new Error(`Reviewed run ${run.runId} has no model provider provenance.`); return parseWorkerModelSelection(run.modelSelection).provider; }
function roleInstructionsFor(role: WorkerRole): string { return workerRoleInstructions(role).text; }
function resolveModel(role: WorkerRole, explicit: string | undefined, context: ExtensionContext, excludedProvider?: string): string {
  const errors: string[] = [];
  for (const requested of preferredWorkerModel(role, explicit)) {
    try {
      const parsed = parseModelThinkingPair(requested);
      const resolved = resolveExtensionModel({ registry: context.modelRegistry, requested, fallbackThinkingLevel: parsed.thinkingLevel, label: `${role} worker`, noModelMessage: `No configured ${role} model is available.` });
      assertChildAgentRouteAllowed(resolved.model, resolved.thinkingLevel, `${role} worker`);
      if (excludedProvider !== undefined && resolved.model.provider === excludedProvider) throw new Error(`Selection ${requested} is not independent from the subject provider ${excludedProvider}.`);
      if (`${resolved.model.provider}/${resolved.model.id}:${resolved.thinkingLevel}` !== requested) throw new Error(`Selection ${requested} could not be honored exactly.`);
      return requested;
    } catch (error) { errors.push(sanitizeError(error)); }
  }
  const requirement = excludedProvider === undefined ? "" : ` independent from subject provider ${excludedProvider}`;
  throw new Error(`No configured ${role} model selection${requirement} is available before launch. ${errors.join(" ")}`);
}

function requireParentSession(context: ExtensionContext): string { const file = context.sessionManager.getSessionFile(); if (!file) throw new Error("Managed workers require a persisted parent session."); return realpathOrResolve(file); }
function realpathOrResolve(value: string): string { try { return realpathSync(value); } catch { return path.resolve(value); } }
function bestEffortSessionEndLine(file: string | undefined, errors: Array<{ scope: "run" | "repositories" | "artifacts"; message: string }>, minimum?: number): number | undefined {
  if (!file) return undefined;
  try {
    const count = countLines(file);
    if (minimum !== undefined && count < minimum) throw new Error(`Worker session was truncated below retained line ${minimum}.`);
    return count;
  } catch (error) {
    errors.push({ scope: "run", message: `Worker session end line could not be recorded safely: ${sanitizeError(error)}`.slice(0, 768) });
    return undefined;
  }
}

function requiredRunStartLine(run: WorkerRunRecord, runtime: RunRuntime, sessionFile: string): number {
  if (run.sessionStartLine !== undefined) return run.sessionStartLine;
  if (runtime.pendingWorkSessionId) return countLines(sessionFile) + 1;
  throw new Error(`Worker run ${run.runId} has no retained session start boundary.`);
}

function nextRetainedRunStart(worker: WorkerRegistryRecord, latest: WorkerRunRecord | undefined): number {
  if (!latest || latest.status !== "settled" || latest.sessionEndLine === undefined) throw new Error(`Worker ${worker.workerId} has no complete retained session boundary for resume.`);
  if (!Number.isSafeInteger(latest.sessionEndLine) || latest.sessionEndLine < 0) throw new Error(`Worker ${worker.workerId} has an invalid retained session boundary.`);
  return latest.sessionEndLine + 1;
}

function countLines(file: string): number { return countSessionLines(file); }
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
function testWorkerSandboxRelease(): WorkerSandboxRelease {
  return { schemaVersion: 1, protocolVersion: 1, releaseOrdinal: 1, status: "approved", kit: { reference: "/test/pi-worker-kit", sha256: "a".repeat(64) }, image: { reference: `example.invalid/pi-worker@sha256:${"b".repeat(64)}`, digest: "b".repeat(64) }, sandbox: { version: "v0.49.1", buildCommit: "c5b19951af121b439800029695f88bf1139a0b0b", template: { id: "template-test-1234", repository: "docker.io/akoumjian/pi-worker-test", tag: "loaded", flavor: "pi-managed-worker" } }, revisions: { pi: "1".repeat(40), profile: "2".repeat(40), piTools: "3".repeat(40), piDocparser: "4".repeat(40) }, guest: { stagedLockSha256: "e".repeat(64), piCli: "/usr/local/bin/pi", rpcLauncher: "/opt/pi-worker/launch.mjs", codingAgentDir: "/run/pi-worker/agent", resourceManifestSha256: "c".repeat(64), runtimeProvenanceSha256: "d".repeat(64), extensionPaths: ["/opt/pi-tools/extensions/worker/runtime.ts"], searxngUrl: "http://host.docker.internal:18888" } };
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function resultText(_text: string, details: any): AgentToolResult<any> { return { content: [{ type: "text", text: JSON.stringify(details) }], details }; }
function slimRun(run: WorkerRunRecord) { return { runId: run.runId, status: run.status, ...(run.outcome ? { outcome: run.outcome, outcomeSource: run.outcomeSource } : {}), createdAt: run.createdAt, ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.settledAt ? { settledAt: run.settledAt } : {}) }; }
function workerListItem(worker: WorkerRegistryRecord) { return { workerId: worker.workerId, role: worker.role, status: worker.status, ...(worker.activeRunId ? { activeRunId: worker.activeRunId } : {}), taskIds: worker.taskIds, ...(worker.modelSelection ? { modelSelection: worker.modelSelection } : {}), ...(worker.recoveryError ? { recoveryRequired: true } : {}), lastActivityAt: worker.updatedAt }; }
function publicDeliveryNotification(delivery: WorkerDeliveryRecord | undefined) {
  if (!delivery) return undefined;
  if (delivery.sendStartedAt && delivery.state !== "delivered") return { state: "send_started_unconfirmed" as const, runId: delivery.runId, ...(delivery.runtimeGeneration === undefined ? {} : { runtimeGeneration: delivery.runtimeGeneration }), sendStartedAt: delivery.sendStartedAt };
  return { state: delivery.state, runId: delivery.runId, ...(delivery.runtimeGeneration === undefined ? {} : { runtimeGeneration: delivery.runtimeGeneration }), ...(delivery.deliveredAt ? { deliveredAt: delivery.deliveredAt } : {}) };
}
function exactRun(worker: WorkerRegistryRecord, run: WorkerRunRecord, delivery?: WorkerDeliveryRecord, preservations: ReturnType<typeof preservationRecords> = []) { const notification = publicDeliveryNotification(delivery); return { workerId: worker.workerId, role: worker.role, runId: run.runId, status: run.status, taskIds: run.taskIds, ...(run.modelSelection ? { modelSelection: run.modelSelection } : {}), createdAt: run.createdAt, ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.settledAt ? { settledAt: run.settledAt } : {}), ...(run.jobId ? { jobId: run.jobId } : {}), ...(run.stdoutLog ? { stdoutLog: run.stdoutLog } : {}), ...(run.stderrLog ? { stderrLog: run.stderrLog } : {}), ...(worker.sessionId ? { sessionId: worker.sessionId } : {}), ...(worker.sessionFile ? { sessionFile: worker.sessionFile } : {}), sessionRange: { ...(run.sessionStartLine === undefined ? {} : { startLine: run.sessionStartLine }), ...(run.sessionEndLine === undefined ? {} : { endLine: run.sessionEndLine }) }, workspaceRoot: worker.workspaceRoot, ...(run.binding ? { binding: run.binding } : {}), ...(worker.recoveryError ? { recoveryError: worker.recoveryError } : {}), ...(preservations.length ? { preservations } : {}), ...((run.runtime as RunRuntime | undefined)?.interruptionWarnings?.length ? { warnings: (run.runtime as RunRuntime).interruptionWarnings } : {}), ...(run.status === "settled" ? { outcome: run.outcome, outcomeSource: run.outcomeSource, ...(notification ? { notification } : {}), ...(run.summary ? { summary: run.summary } : {}), ...(run.question ? { question: run.question } : {}), repositories: run.repositories.map(({ path: relativePath, commit, source, reported, changed, dirty, eligible, issues }) => ({ repositoryPath: path.join(worker.workspaceRoot, relativePath), commit, ...(source ? { source } : {}), reported, changed, dirty, eligible, ...(issues ? { issues } : {}) })), artifacts: run.artifacts, errors: run.errors } : {}) }; }
function compactWorkerList(value: any): string { const workers = Array.isArray(value?.workers) ? value.workers : []; return workers.length ? workers.map((worker: any) => `${worker.status} · ${worker.role} · ${worker.workerId}${worker.notification?.state === "send_started_unconfirmed" ? ` · send_started_unconfirmed · ${worker.notification.runId}` : ""}`).join("\n") : "No workers."; }
function formatExactRun(value: any): string { return `${value.outcome ?? value.status} · ${value.role} · ${value.workerId}\nrun ${value.runId}\n${value.taskIds?.length ?? 0} tasks · ${value.repositories?.length ?? 0} repositories · ${value.artifacts?.length ?? 0} artifacts${value.notification?.state === "send_started_unconfirmed" ? "\nnotification: send_started_unconfirmed; it will not be replayed automatically" : ""}${value.recoveryError ? `\nrecovery: ${value.recoveryError}` : ""}`; }
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
function publicCleanupWorker(item: import("./cleanup.js").CleanupWorkerItem) { const pendingPreservations=item.preservations.filter((record)=>record.status==="pending");return{workerId:item.workerId,ownerSession:item.ownerSession,owner:item.owner,role:item.role,class:item.class,reason:item.reason,version:item.version,...(item.latestRunId?{latestRunId:item.latestRunId}:{}),...(item.reviewedByWorkerId?{reviewedByWorkerId:item.reviewedByWorkerId}:{}),taskIds:item.taskIds,taskFacts:item.taskFacts,unpreservedArtifacts:item.unpreservedArtifacts.slice(0,4),additionalUnpreservedArtifacts:item.additionalUnpreservedArtifacts+Math.max(0,item.unpreservedArtifacts.length-4),pendingResults:item.pendingResults.slice(0,4),additionalPendingResults:item.additionalPendingResults+Math.max(0,item.pendingResults.length-4),pendingPreservations:pendingPreservations.slice(0,4),additionalPendingPreservations:item.additionalPendingPreservations+Math.max(0,pendingPreservations.length-4),...(item.after?{after:item.after}:{}),...(item.recoveryError?{recoveryError:item.recoveryError}:{})};}
function publicCleanupPreview(preview:PersistedCleanupPreview){return{token:preview.token,snapshotHash:preview.snapshotHash,createdAt:preview.snapshot.createdAt,workers:preview.snapshot.workers.map((entry)=>({worker:{...publicCleanupWorker(entry.item),unpreservedArtifacts:entry.item.unpreservedArtifacts.slice(0,64),additionalUnpreservedArtifacts:entry.item.additionalUnpreservedArtifacts+Math.max(0,entry.item.unpreservedArtifacts.length-64),pendingResults:entry.item.pendingResults,additionalPendingResults:entry.item.additionalPendingResults},status:entry.status,...(entry.operationKind?{operationKind:entry.operationKind}:{}),...(entry.operationNonce?{operationNonce:entry.operationNonce}:{}),runClaims:entry.runClaims,authority:entry.authority})),prepared:preview.snapshot.prepared,leftovers:preview.snapshot.leftovers,scan:preview.snapshot.scan};}

function workerControlCallLabel(input: unknown): string {
  try { return `worker ${recordValue(input) && typeof input.action === "string" ? sanitizeWorkerOperationText(input.action) || "control" : "control"}`; }
  catch { return "worker control"; }
}
function publicPreparedSet(set: any) { return { preparedId: set.preparedId, status: set.status, order: set.order, repositories: set.repositories.map((item: any) => ({ id: item.id, candidateRepo: item.candidateRepo, candidateCommit: item.candidateCommit, targetRepo: item.targetRepo, targetRef: item.targetRef, method: item.method, status: item.status, expectedCommit: item.expectedCommit, ...(item.desiredCommit ? { desiredCommit: item.desiredCommit } : {}), preparedPath: item.preparedPath, overlapCount: item.overlapCount, dependsOn: item.dependsOn, ...(item.source ? { source: item.source } : {}), ...(item.warnings ? { warnings: item.warnings } : {}) })), ...(set.resolutionCases ? { resolutionCases: set.resolutionCases } : {}) }; }
type ManagedWorkerCompletionReceipt = { source: "message" | "session"; deliveryId: string };
function managedWorkerCompletionReceipt(value: unknown): ManagedWorkerCompletionReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  const source = message.role === "custom" && !("type" in message)
    ? "message"
    : message.type === "custom_message" && !("role" in message)
      ? "session"
      : undefined;
  if (!source || message.customType !== "worker-run") return undefined;
  const details = message.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const record = details as Record<string, unknown>;
  if (record.event !== "worker_settled" || typeof record.workerId !== "string" || !record.workerId || typeof record.runId !== "string" || !record.runId || typeof record.deliveryId !== "string") return undefined;
  const deliveryId = `worker-run:${record.workerId}:${record.runId}`;
  return record.deliveryId === deliveryId ? { source, deliveryId } : undefined;
}
function sessionDeliveryIds(context: ExtensionContext): string[] {
  const ids = new Set<string>();
  try {
    for (const entry of context.sessionManager.getEntries()) {
      const receipt = managedWorkerCompletionReceipt(entry);
      if (receipt?.source === "session") ids.add(receipt.deliveryId);
    }
  } catch {}
  return [...ids];
}
function deliverPendingCompletions(api: ExtensionAPI, registry: WorkerRegistry, parent: string, generation: number): void {
  for (const delivery of pendingWorkerDeliveries(registry, parent)) {
    if (!claimWorkerDelivery(registry, delivery.deliveryId, parent, generation)) continue;
    const worker = getWorker(registry, delivery.workerId); const run = getWorkerRun(registry, delivery.workerId, delivery.runId);
    if (!worker || !run?.outcome || !run.outcomeSource) { releaseWorkerDeliveryClaim(registry, delivery.deliveryId, generation); continue; }
    const event = { event: "worker_settled", workerId: worker.workerId, runId: run.runId, role: worker.role, outcome: run.outcome, outcomeSource: run.outcomeSource, ...(run.summary ? { summary: run.summary } : {}), ...(run.question ? { question: run.question } : {}), repositoryCount: run.repositories.length, artifactCount: run.artifacts.length, ...(run.errors.length ? { errors: run.errors } : {}) };
    // Persist the send boundary first. A crash or exception after this CAS is
    // ambiguous and must never cause an automatic duplicate notification.
    if (!markWorkerDeliverySendStarted(registry, delivery.deliveryId, generation, new Date().toISOString())) continue;
    try { api.sendMessage({ customType: "worker-run", content: JSON.stringify(event), display: true, details: { ...event, deliveryId: delivery.deliveryId } }, { triggerTurn: true, deliverAs: delivery.completionDelivery }); }
    catch { /* send started: leave the unconfirmed attempt visible and do not replay */ }
  }
}
