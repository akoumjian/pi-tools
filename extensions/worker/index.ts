import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Text } from "@earendil-works/pi-tui";
import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveExtensionModel, assertChildAgentRouteAllowed, parseModelThinkingPair } from "../_shared/model-spec.js";
import { throwIfAborted } from "../_shared/cancellation.js";
import { createAsyncJobId, isAsyncJobProcessGroupAlive, signalAsyncJobProcessGroup } from "../_shared/async-job.js";
import { handleAsyncShellViewerCommand, unsettledPersistedAsyncShellJobsForOwner, type JobMeta, type ManagedAsyncJobHandle } from "../async-shell/index.js";
import { createWorkerContainer, planWorkerContainer, resolveDockerPath, settleWorkerContainer, type WorkerContainerReference } from "../_shared/worker-container.js";
import { inputJsonSchemaGuideline, outputJsonSchemaGuideline } from "../_shared/tool-prompt.js";
import { RetainedToolOutputSchemas } from "../_shared/tool-output.js";
import { WorkerControlParamsV2, WorkerMergeApplyParams, WorkerMergeTestParams, WorkerRunParamsV2, type WorkerControlInputV2, type WorkerRunInputV2 } from "./contract.js";
import { applyPreparedWorkerMerges, consumePreparedMergeSet, defaultPreparedMergeRoot, prepareWorkerMerges, readPreparedMergeSet, restoreConsumedPreparedMergeSet } from "./merge.js";
import {
  abandonWorkerDiscard, activeRunsForParent, claimWorkerCancellation, claimWorkerDiscard, claimWorkerDelivery, claimWorkerRun,
  countWorkers, createWorkerRunBatch, finalizeClaimedWorkerRun, finalizeWorkerDiscard, finalizeWorkerRunLaunch, findWorkerRunById,
  getWorker, getWorkerRun, listWorkerRuns, listWorkers, markWorkerDeliveryDelivered, openWorkerRegistry, pendingWorkerDeliveries,
  reconcileWorkerDeliveries, registerParentRuntime, releaseWorkerDeliveryClaim, setWorkerRecoveryError, storePreparedSet,
  updatePreparedSetStatus, updateWorkerAndRunRuntime, workerRegistryDataVersion,
  type WorkerBatchCreateItem, type WorkerRegistry, type WorkerRegistryRecord, type WorkerRepositoryResult, type WorkerRole, type WorkerRunRecord
} from "./registry.js";
import { readWorkerRuntimeResult } from "./runtime.js";
import { cleanupReviewOverlay, createReviewOverlay, type ReviewOverlayRecord } from "./review-workspace.js";
import { preferredWorkerModel } from "./settings.js";
import { createWorkerId, createWorkerRunId, defaultWorkerRoots, provisionWorkerPaths, workerPaths, type WorkerPaths, type WorkerRoots } from "./identity.js";
import { createWorkerSession, forkWorkerSession, verifyWorkerSession } from "./session.js";
import { launchWorkerHost, readWorkerHostProcess, readWorkerHostSettlement, type WorkerLaunchRecord } from "./runner.js";
import { renderWorkerRuntimePrompt } from "./prompts.js";
import { contextInputs, inputMounts, validateAdditionalInputs, type RetainedInput } from "./inputs.js";
import { inventoryWorkerRepositories, snapshotWorkerRepositories, type RepositorySnapshot } from "./inventory.js";
import { canonicalPathWithin, canonicalRepository, trustedGit } from "./trusted-git.js";

export { WorkerRunParamsV2 as WorkerRunParams, WorkerControlParamsV2 as WorkerControlParams, WorkerMergeTestParams, WorkerMergeApplyParams };
export type WorkerRunInput = WorkerRunInputV2;
export type WorkerControlInput = WorkerControlInputV2;

type RunRuntime = {
  version: 2; prompt: string; runDir: string; resultFile: string; settledFile: string; processFile: string; processNonce: string;
  container: WorkerContainerReference; overlay?: ReviewOverlayRecord; contextFile?: string; inputs: RetainedInput[];
  repositoryBefore: RepositorySnapshot[];
};
type WorkerRuntime = { version: 2; inputs: RetainedInput[]; repositoryBaselines?: Array<{ path: string; resolvedCommit: string }> };
type PendingRun = { workerId: string; runId: string; parentSessionFile: string; parentSessionId: string; runtime: RunRuntime };
type ActiveRun = { runId: string; handle: ManagedAsyncJobHandle };
type PlannedRun = {
  request: WorkerRunInputV2["runs"][number]; role: WorkerRole; workerId: string; runId: string; jobId: string; paths: WorkerPaths;
  taskIds: string[]; modelSelection: string; binding?: WorkerRunRecord["binding"]; workerRuntime: WorkerRuntime; runRuntime: RunRuntime;
  newWorker: boolean; expectedVersion?: number; reviewedRunId?: string; preparedId?: string; consumedPrepared?: boolean;
};
export type WorkerExtensionDependencies = {
  runtimeRoot?: string; roots?: WorkerRoots; codeRoot?: string; preparedRoot?: string; targetRoot?: string; now?: () => Date; random?: () => string; dockerPath?: string;
  createContainer?: (dockerPath: string, reference: WorkerContainerReference) => WorkerContainerReference;
  removeContainer?: (dockerPath: string, reference: WorkerContainerReference) => void;
  launch?: (api: ExtensionAPI, context: ExtensionContext, input: { record: WorkerLaunchRecord; runtime: RunRuntime }) => ManagedAsyncJobHandle;
  createOverlay?: typeof createReviewOverlay; cleanupOverlay?: typeof cleanupReviewOverlay;
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
  const createContainer = overrides.createContainer ?? (testLaunch ? ((_docker, reference) => ({ ...reference, containerId: "f".repeat(64) })) : createWorkerContainer);
  const removeContainer = overrides.removeContainer ?? (testLaunch ? (() => {}) : settleWorkerContainer);
  const createOverlay = overrides.createOverlay ?? createReviewOverlay;
  const cleanupOverlay = overrides.cleanupOverlay ?? cleanupReviewOverlay;
  let registry: WorkerRegistry | undefined;
  let runtimeGeneration = 0;
  let deliveryTimer: NodeJS.Timeout | undefined;
  let observedDataVersion = 0;
  let currentContext: ExtensionContext | undefined;
  const pending = new Map<string, PendingRun>();
  const active = new Map<string, ActiveRun>();
  const deliveredRecovery = new Set<string>();
  const getRegistry = () => registry ??= openWorkerRegistry(runtimeRoot);

  const launch = (context: ExtensionContext, record: WorkerLaunchRecord, runtime: RunRuntime): ManagedAsyncJobHandle => {
    if (testLaunch) {
      const value = testLaunch(api, context, { record, runtime });
      if (!value || typeof value !== "object" || !("completion" in value)) throw new Error("Injected worker launch did not return a managed handle.");
      return value as ManagedAsyncJobHandle;
    }
    return launchWorkerHost(api, context, { record, prompt: runtime.prompt, resultFile: runtime.resultFile, runDir: runtime.runDir, processFile: runtime.processFile, processNonce: runtime.processNonce, shellExecution: { kind: "docker", dockerPath: docker(), container: runtime.container } }).handle;
  };

  api.on("session_start", async (_event, context) => {
    currentContext = context;
    const parent = context.sessionManager.getSessionFile(); if (!parent) return;
    const exactParent = realpathOrResolve(parent);
    reconcileWorkerDeliveries(getRegistry(), exactParent, sessionDeliveryIds(context));
    runtimeGeneration = registerParentRuntime(getRegistry(), exactParent, randomUUID(), now().toISOString());
    deliveredRecovery.clear();
    observedDataVersion = workerRegistryDataVersion(getRegistry());
    deliverPendingCompletions(api, getRegistry(), exactParent, runtimeGeneration);
    await reconcileActiveRuns(context, exactParent);
    if (deliveryTimer) clearInterval(deliveryTimer);
    deliveryTimer = setInterval(() => {
      try {
        const current = workerRegistryDataVersion(getRegistry());
        if (current !== observedDataVersion) observedDataVersion = current;
        deliverPendingCompletions(api, getRegistry(), exactParent, runtimeGeneration);
        void reconcileActiveRuns(context, exactParent);
      } catch {}
    }, 1_000);
    deliveryTimer.unref();
  });
  api.on("turn_end", async (_event, context) => {
    const parentFile = context.sessionManager.getSessionFile(); if (!parentFile) return;
    const parent = realpathOrResolve(parentFile); const parentSessionId = context.sessionManager.getSessionId();
    const launches = [...pending.values()].filter((item) => item.parentSessionFile === parent && item.parentSessionId === parentSessionId);
    for (const item of launches) { pending.delete(item.runId); await startPreparedRun(context, item); }
  });
  api.on("message_end", (event, context) => {
    const deliveryId = (event.message as any)?.details?.deliveryId;
    if (typeof deliveryId !== "string" || !deliveryId.startsWith("worker-run:")) return;
    const parent = context.sessionManager.getSessionFile(); if (!parent) return;
    try { markWorkerDeliveryDelivered(getRegistry(), deliveryId, runtimeGeneration, now().toISOString()); } catch {}
  });
  api.on("session_shutdown", () => {
    currentContext = undefined;
    if (deliveryTimer) clearInterval(deliveryTimer); deliveryTimer = undefined;
    if (active.size === 0) { registry?.close(); registry = undefined; }
  });

  api.registerMessageRenderer("worker-run", (message, _options, theme) => {
    const d = message.details as any; const outcome = String(d?.outcome ?? "completed").replaceAll("_", " "); const role = d?.role ?? "work";
    const counts = `${Number(d?.repositoryCount ?? 0)} repos · ${Number(d?.artifactCount ?? 0)} artifacts`;
    return new Text(theme.fg(d?.outcome === "failed" ? "error" : d?.outcome === "cancelled" ? "warning" : "success", `${outcome} · ${role} · ${String(d?.workerId ?? "worker").slice(-8)} · ${counts}`), 0, 0);
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
    renderCall: (args: unknown, theme: any) => compactCall(theme, runCallHint(args as WorkerRunInputV2)),
    renderResult: (result: AgentToolResult<any>, _options: unknown, theme: any) => compactResult(theme, result, "worker run"),
    execute: async (_callId: string, params: WorkerRunInputV2, signal: AbortSignal, onUpdate: any, context: ExtensionContext): Promise<AgentToolResult<any>> => {
      throwIfAborted(signal);
      const parentSessionFile = requireParentSession(context);
      const planned = preflightBatch(params, context, parentSessionFile);
      const timestamp = now().toISOString();
      try {
        for (const plan of planned) if (plan.role === "integration" && plan.consumedPrepared && plan.runRuntime.contextFile) assertIntegrationTargetsCurrent(plan.runRuntime.contextFile);
        const items: WorkerBatchCreateItem[] = planned.map((plan) => {
          const session = sessionIdentity(plan.paths);
          const hostLogDir = path.join(path.resolve(context.cwd), ".pi", "async-shell", "jobs", plan.jobId);
          const run: WorkerRunRecord = { runId: plan.runId, workerId: plan.workerId, status: "queued", taskIds: plan.taskIds, modelSelection: plan.modelSelection,
            completionDelivery: plan.request.completionDelivery ?? "steer", ...(plan.binding ? { binding: plan.binding } : {}), jobId: plan.jobId,
            stdoutLog: path.join(hostLogDir, "stdout.log"), stderrLog: path.join(hostLogDir, "stderr.log"), sessionStartLine: countLines(session.sessionFile) + 1,
            repositories: [], artifacts: [], errors: [], runtime: plan.runRuntime, createdAt: timestamp };
          if (plan.newWorker) return { kind: "new", worker: { workerId: plan.workerId, parentSessionFile, role: plan.role, status: "queued", activeRunId: plan.runId,
            taskIds: plan.taskIds, modelSelection: plan.modelSelection, sessionId: session.sessionId, sessionFile: session.sessionFile,
            workspaceRoot: plan.paths.workspaceRoot, runtime: plan.workerRuntime, createdAt: timestamp, updatedAt: timestamp }, run };
          return { kind: "resume", workerId: plan.workerId, expectedVersion: plan.expectedVersion!, taskIds: plan.taskIds, runtime: plan.workerRuntime, run };
        });
        createWorkerRunBatch(getRegistry(), {
          items,
          reviewLeases: planned.filter((plan) => plan.role === "review").flatMap((plan) => { const subjectWorkerId = (plan.binding as any).reviewedWorkerId as string; const subject = getWorker(getRegistry(), subjectWorkerId); return subject?.reviewedByWorkerId ? [] : [{ subjectWorkerId, reviewerWorkerId: plan.workerId, reviewedRunId: plan.reviewedRunId! }]; }),
          consumedPrepared: planned.filter((plan) => plan.consumedPrepared).map((plan) => ({ preparedId: plan.preparedId!, parentSessionFile })),
          now: timestamp
        });
      } catch (error) { rollbackPlans(planned, parentSessionFile); throw error; }
      for (const plan of planned) pending.set(plan.runId, { workerId: plan.workerId, runId: plan.runId, parentSessionFile, parentSessionId: context.sessionManager.getSessionId(), runtime: plan.runRuntime });
      const details = { runs: planned.map((plan) => ({ action: plan.request.action, role: plan.role, workerId: plan.workerId, runId: plan.runId, status: "queued", taskIds: plan.taskIds,
        completionDelivery: plan.request.completionDelivery ?? "steer", modelSelection: plan.modelSelection, ...(plan.reviewedRunId ? { reviewedRunId: plan.reviewedRunId } : {}), ...(plan.preparedId ? { preparedId: plan.preparedId } : {}) })) };
      const text = details.runs.map((item) => `queued · ${item.role} · ${item.workerId.slice(-8)}`).join("\n");
      onUpdate?.({ content: [{ type: "text", text }], details }); return resultText(text, details);
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
    renderCall: (args: unknown, theme: any) => compactCall(theme, `worker ${String((args as any).action ?? "control")}`),
    renderResult: (result: AgentToolResult<any>, _options: unknown, theme: any) => compactResult(theme, result, "worker control"),
    execute: async (_callId: string, params: WorkerControlInputV2, signal: AbortSignal, _update: any, context: ExtensionContext): Promise<AgentToolResult<any>> => {
      throwIfAborted(signal); return control(params, context);
    }
  });
  api.registerTool(workerControlTool as any);

  api.registerTool(defineTool({
    name: "worker_merge_test", label: "Test Repository Merges",
    description: "Test one or more repository candidates against explicit target branches without modifying them. The host revalidates candidate and target identity, constructs the requested merges or squashes in disposable views, detects conflicts and cross-repository overlap, and returns exact prepared results for validation or integration. This tool does not run project tests or promote target refs.",
    promptSnippet: "Test repository candidates against target branches and prepare exact disposable merge results without promotion.",
    promptGuidelines: [inputJsonSchemaGuideline("worker_merge_test", WorkerMergeTestParams), outputJsonSchemaGuideline("worker_merge_test", RetainedToolOutputSchemas.worker_merge_test), "worker_merge_test use: Prepare exact merges, validate every prepared view separately, and apply only through an explicit worker_merge_apply call.", "worker_merge_test constraints: Only result content is provider-visible; details remain internal."],
    parameters: WorkerMergeTestParams, executionMode: "sequential",
    renderCall: (args, theme) => compactCall(theme, mergeHint("testing", (args as any).repositories)), renderResult: (result, _options, theme) => compactResult(theme, result as any, "merge test"),
    async execute(_id, params, signal, _update, context) {
      throwIfAborted(signal); const parent = requireParentSession(context);
      const resolved = params.repositories.map((request) => {
        const candidate = resolveCandidate(request.candidateId, parent);
        return { id: request.candidateId, candidateRepo: candidate.repo, candidateRef: candidate.commit, targetRepo: request.targetRepo, targetRef: request.targetRef, method: request.method, commitMessage: request.commitMessage, dependsOn: request.dependsOn };
      });
      const set = prepareWorkerMerges(parent, resolved, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, sourceForCandidate: managedCandidateWarnings() });
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
    promptGuidelines: [inputJsonSchemaGuideline("worker_merge_apply", WorkerMergeApplyParams), outputJsonSchemaGuideline("worker_merge_apply", RetainedToolOutputSchemas.worker_merge_apply), "worker_merge_apply use: Apply only after parent inspection and validation of every exact prepared repository.", "worker_merge_apply constraints: Only result content is provider-visible; details remain internal."],
    parameters: WorkerMergeApplyParams, executionMode: "sequential",
    renderCall: (args, theme) => compactCall(theme, `applying · ${(args as any).preparedId?.slice(-8)}`), renderResult: (result, _options, theme) => compactResult(theme, result as any, "merge apply"),
    async execute(_id, params, signal, _update, context) { throwIfAborted(signal); const parent = requireParentSession(context); const result = applyPreparedWorkerMerges(parent, params.preparedId, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot, sourceForCandidate: managedCandidateWarnings() }); updatePreparedSetStatus(getRegistry(), params.preparedId, parent, result.status, now().toISOString()); return resultText(`${result.status} · ${result.repositories.filter((item) => item.status === "applied").length} applied`, result); }
  }));

  registerCommands();

  function createOverlaySafely(input: Parameters<typeof createReviewOverlay>[0]): ReviewOverlayRecord {
    try { return createOverlay(input); }
    catch (error) { rmSync(input.contextFile, { force: true }); throw error; }
  }

  function cleanupSupersededPreparedSets(current: ReturnType<typeof prepareWorkerMerges>): void {
    const root = path.resolve(overrides.preparedRoot ?? defaultPreparedMergeRoot()); const currentTargets = current.repositories.map((item) => `${item.targetRepo}\0${item.targetRef}`).sort().join("\n");
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === current.preparedId || !/^prepared_[0-9a-f]{24}$/.test(entry.name)) continue;
      const directory = path.join(root, entry.name); try { const prior = JSON.parse(readFileSync(path.join(directory, "prepared.json"), "utf8")) as any; const targets = prior.repositories.map((item: any) => `${item.targetRepo}\0${item.targetRef}`).sort().join("\n"); if (path.resolve(prior.parentSessionFile) !== path.resolve(current.parentSessionFile) || targets !== currentTargets) continue; rmSync(directory, { recursive: true, force: true }); try { updatePreparedSetStatus(getRegistry(), prior.preparedId, current.parentSessionFile, "superseded", now().toISOString()); } catch {} } catch {}
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
          if (!worker.sessionId || !worker.sessionFile) throw new Error(`Worker ${worker.workerId} has no retained session.`);
          verifyRetainedSession(worker);
          const latest = worker.latestRunId ? getWorkerRun(getRegistry(), worker.workerId, worker.latestRunId) : undefined;
          const binding = latest?.binding; const paths = workerPaths(roots, worker.workerId); provisionWorkerPaths(paths);
          const role = worker.role; const inputs = validateAdditionalInputs({ values: request.additionalInputs, existing: runtimeInputs(worker), role, workspaceRoot: paths.workspaceRoot, runtimeRoot });
          let overlay: ReviewOverlayRecord | undefined; let contextFile: string | undefined; let reviewedRunId: string | undefined; let preparedId: string | undefined;
          const mounts = inputMounts(inputs);
          if (role === "review") {
            if (!binding || !("reviewedRunId" in binding)) throw new Error(`Review worker ${worker.workerId} lost its reviewed-run binding.`);
            const subject = reviewSubject(binding.reviewedRunId, parentSessionFile, worker.workerId); reviewedRunId = binding.reviewedRunId;
            contextFile = writeReviewContext(paths, request.workerId, createWorkerRunId(now(), random()), subject.worker, subject.run, inputs);
            overlay = createOverlaySafely({ dockerPath: docker(), workerId: worker.workerId, runId: path.basename(contextFile, ".json"), subjectWorkspace: subject.worker.workspaceRoot, reviewerWorkspace: paths.workspaceRoot, contextFile, reviewedSessionFile: subject.worker.sessionFile!, additionalInputs: inputs.map((item) => ({ source: item.source, target: item.target })) });
            mounts.splice(0, mounts.length, ...overlay.mounts);
          } else if (role === "integration") {
            if (!binding || !("preparedId" in binding)) throw new Error(`Integration worker ${worker.workerId} lost its prepared-set binding.`); preparedId = binding.preparedId;
            contextFile = writeIntegrationContext(paths, preparedId, inputs, true); mounts.push({ kind: "bind", source: paths.workspaceRoot, target: "/workspace" }, { kind: "bind", source: contextFile, target: "/integration/context.json", readOnly: true });
          }
          const plan = finishPlanSafely({ request, role, workerId: worker.workerId, paths, taskIds: unique([...worker.taskIds, ...(request.additionalTaskIds ?? [])]), modelSelection: worker.modelSelection!, binding, workerRuntime: { version: 2, inputs, ...baselineRuntime(worker) }, newWorker: false, expectedVersion: worker.version, overlay, contextFile, reviewedRunId, preparedId, mounts, parentSessionFile, context });
          plans.push(plan); continue;
        }
        const role = request.role;
        const modelSelection = resolveModel(role, role === "work" ? request.modelSelection : undefined, context);
        const workerId = createWorkerId(now(), random()); const paths = workerPaths(roots, workerId);
        const taskIds = role === "review" ? [] : unique(request.taskIds);
        let subject: ReturnType<typeof reviewSubject> | undefined;
        let repositoryBaselines: Array<{ path: string; resolvedCommit: string }> | undefined;
        let inputs: RetainedInput[] = [];
        if (role === "work") repositoryBaselines = (request.repositoryBaselines ?? []).map((item) => { const repo = canonicalRepository(item.path); return { path: repo, resolvedCommit: trustedGit(repo, ["rev-parse", `${item.revision ?? "HEAD"}^{commit}`]).trim() }; });
        else if (role === "review") { subject = reviewSubject(request.reviewedRunId, parentSessionFile); inputs = validateAdditionalInputs({ values: request.additionalInputs, role, workspaceRoot: paths.workspaceRoot, runtimeRoot }); }
        else { readPreparedMergeSet(parentSessionFile, request.preparedId, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot }); inputs = validateAdditionalInputs({ values: request.additionalInputs, role, workspaceRoot: paths.workspaceRoot, runtimeRoot }); }
        provisionWorkerPaths(paths);
        let binding: WorkerRunRecord["binding"]; let reviewedRunId: string | undefined; let preparedId: string | undefined; let consumedPrepared = false;
        let overlay: ReviewOverlayRecord | undefined; let contextFile: string | undefined; let mounts: any[] = [];
        try {
          if (role === "work") {
            forkWorkerSession({ parentSessionFile, workspaceRoot: paths.workspaceRoot, sessionDir: paths.sessionDir, sessionId: randomUUID() });
          } else if (role === "review") {
            reviewedRunId = request.reviewedRunId; binding = { reviewedWorkerId: subject!.worker.workerId, reviewedRunId };
            createWorkerSession({ workspaceRoot: paths.workspaceRoot, sessionDir: paths.sessionDir, sessionId: randomUUID() });
            contextFile = writeReviewContext(paths, workerId, createWorkerRunId(now(), random()), subject!.worker, subject!.run, inputs);
            overlay = createOverlaySafely({ dockerPath: docker(), workerId, runId: path.basename(contextFile, ".json"), subjectWorkspace: subject!.worker.workspaceRoot, reviewerWorkspace: paths.workspaceRoot, contextFile, reviewedSessionFile: subject!.worker.sessionFile!, additionalInputs: inputs.map((item) => ({ source: item.source, target: item.target })) }); mounts = overlay.mounts;
          } else if (role === "integration") {
            preparedId = request.preparedId; const moved = consumePreparedMergeSet(parentSessionFile, preparedId, workerId, paths.workspaceRoot, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot }); consumedPrepared = true; binding = { preparedId };
            createWorkerSession({ workspaceRoot: paths.workspaceRoot, sessionDir: paths.sessionDir, sessionId: randomUUID() });
            contextFile = writeIntegrationContext(paths, preparedId, inputs, false, moved); mounts = [...inputMounts(inputs), { kind: "bind", source: paths.workspaceRoot, target: "/workspace" }, { kind: "bind", source: contextFile, target: "/integration/context.json", readOnly: true }];
          }
          const plan = finishPlan({ request, role, workerId, paths, taskIds: role === "review" ? subject!.run.taskIds : taskIds, modelSelection, binding,
            workerRuntime: { version: 2, inputs, ...(repositoryBaselines ? { repositoryBaselines } : {}) }, newWorker: true, overlay, contextFile, reviewedRunId, preparedId, consumedPrepared, mounts, parentSessionFile, context });
          plans.push(plan);
        } catch (error) {
          if (overlay) { try { cleanupOverlay(docker(), overlay); } catch {} }
          if (consumedPrepared && preparedId) { try { restoreConsumedPreparedMergeSet(parentSessionFile, preparedId, paths.workspaceRoot, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot }); } catch {} }
          rmSync(paths.stateDir, { recursive: true, force: true });
          throw error;
        }
      }
      return plans;
    } catch (error) { rollbackPlans(plans, parentSessionFile); throw error; }
  }

  function finishPlanSafely(input: Omit<PlannedRun, "runId" | "jobId" | "runRuntime"> & { overlay?: ReviewOverlayRecord; contextFile?: string; mounts: any[]; parentSessionFile: string; context: ExtensionContext }): PlannedRun {
    try { return finishPlan(input); } catch (error) {
      if (input.overlay) { try { cleanupOverlay(docker(), input.overlay); } catch {} }
      if (input.consumedPrepared && input.preparedId) { try { restoreConsumedPreparedMergeSet(input.parentSessionFile, input.preparedId, input.paths.workspaceRoot, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot }); } catch {} }
      if (input.newWorker) rmSync(input.paths.stateDir, { recursive: true, force: true }); else if (input.contextFile) rmSync(input.contextFile, { force: true });
      throw error;
    }
  }

  function finishPlan(input: Omit<PlannedRun, "runId" | "jobId" | "runRuntime"> & { overlay?: ReviewOverlayRecord; contextFile?: string; mounts: any[]; parentSessionFile: string; context: ExtensionContext }): PlannedRun {
    const runId = createWorkerRunId(now(), random()); const jobId = createAsyncJobId(now(), random());
    const runDir = path.join(input.paths.stateDir, "runs", runId); mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const nonce = randomUUID();
    const codeRoot = overrides.codeRoot ?? (testLaunch ? input.context.cwd : path.join(homedir(), "Code"));
    const reference = planWorkerContainer({ workerId: input.workerId, runId, nonce, workspaceRoot: input.paths.workspaceRoot, codeRoot, mounts: input.mounts });
    const container = createContainer(docker(), reference);
    const roleInstructions = roleInstructionsFor(input.role);
    const request = input.request;
    const prompt = renderWorkerRuntimePrompt(input.role, { workerId: input.workerId, runId, workspaceRoot: input.role === "review" || input.role === "integration" ? "/workspace" : input.paths.workspaceRoot,
      codeRoot, taskIds: input.taskIds, roleInstructions,
      instructions: request.instructions, repositoryBaselines: input.workerRuntime.repositoryBaselines, additionalInputs: contextInputs(input.workerRuntime.inputs),
      reviewSubjectPath: "/review/subject", reviewContextPath: "/review/context.json", integrationContextPath: "/integration/context.json", resumed: !input.newWorker,
      cancelledPreviously: !input.newWorker && getWorkerRun(getRegistry(), input.workerId, getWorker(getRegistry(), input.workerId)?.latestRunId ?? "")?.outcome === "cancelled" });
    const runRuntime: RunRuntime = { version: 2, prompt, runDir, resultFile: path.join(runDir, "result.json"), settledFile: path.join(runDir, "settled.json"), processFile: path.join(runDir, "host-process.json"), processNonce: nonce,
      container, ...(input.overlay ? { overlay: input.overlay } : {}), ...(input.contextFile ? { contextFile: input.contextFile } : {}), inputs: input.workerRuntime.inputs,
      repositoryBefore: snapshotWorkerRepositories(input.paths.workspaceRoot) };
    return { request, role: input.role, workerId: input.workerId, runId, jobId, paths: input.paths, taskIds: input.taskIds, modelSelection: input.modelSelection, ...(input.binding ? { binding: input.binding } : {}), workerRuntime: input.workerRuntime, runRuntime,
      newWorker: input.newWorker, ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }), ...(input.reviewedRunId ? { reviewedRunId: input.reviewedRunId } : {}), ...(input.preparedId ? { preparedId: input.preparedId } : {}), ...(input.consumedPrepared ? { consumedPrepared: true } : {}) };
  }

  function rollbackPlans(plans: PlannedRun[], parentSessionFile: string): void {
    for (const plan of [...plans].reverse()) {
      try { removeContainer(docker(), plan.runRuntime.container); } catch {}
      if (plan.runRuntime.overlay) { try { cleanupOverlay(docker(), plan.runRuntime.overlay); } catch {} }
      if (plan.consumedPrepared && plan.preparedId) { try { restoreConsumedPreparedMergeSet(parentSessionFile, plan.preparedId, plan.paths.workspaceRoot, { preparedRoot: overrides.preparedRoot, targetRoot: overrides.targetRoot }); } catch {} }
      if (plan.newWorker) rmSync(plan.paths.stateDir, { recursive: true, force: true });
      else { rmSync(plan.runRuntime.runDir, { recursive: true, force: true }); if (plan.runRuntime.contextFile) rmSync(plan.runRuntime.contextFile, { force: true }); }
    }
  }

  async function startPreparedRun(context: ExtensionContext, item: PendingRun): Promise<void> {
    const nonce = randomUUID(); if (!claimWorkerRun(getRegistry(), item.workerId, item.runId, "launch", nonce, ["queued"])) return;
    let handle: ManagedAsyncJobHandle | undefined;
    try {
      const worker = getWorker(getRegistry(), item.workerId)!; const run = getWorkerRun(getRegistry(), item.workerId, item.runId)!; const paths = workerPaths(roots, item.workerId);
      const sessionId = worker.sessionId; const sessionFile = worker.sessionFile;
      if (!sessionId || !sessionFile) throw new Error(`Worker ${worker.workerId} session provisioning failed.`);
      if (worker.role === "work") verifyWorkerSession({ sessionFile, sessionId, workspaceRoot: worker.workspaceRoot, parentSessionFile: worker.parentSessionFile });
      const sessionStartLine = countLines(sessionFile) + 1;
      const record: WorkerLaunchRecord = { workerId: worker.workerId, runId: run.runId, jobId: run.jobId!, sessionId, sessionFile, workspaceRoot: worker.workspaceRoot, taskIds: run.taskIds, role: worker.role, modelSelection: worker.modelSelection! };
      handle = launch(context, record, item.runtime); const snapshot = handle.snapshot();
      finalizeWorkerRunLaunch(getRegistry(), { workerId: worker.workerId, runId: run.runId, claimNonce: nonce, modelSelection: worker.modelSelection!, sessionId, sessionFile, sessionStartLine, jobId: snapshot.jobId,
        stdoutLog: snapshot.stdoutLog, stderrLog: snapshot.stderrLog, runtime: item.runtime, startedAt: now().toISOString() });
      active.set(worker.workerId, { runId: run.runId, handle });
      void handle.completion.then((job) => settleCompletedRun(worker.workerId, run.runId, job)).catch((error) => recordRecovery(worker.workerId, run.runId, error)).finally(() => { if (active.get(worker.workerId)?.runId === run.runId) active.delete(worker.workerId); });
    } catch (error) {
      if (handle) { try { handle.cancel("SIGTERM"); } catch {} }
      await failClaimedRun(item.workerId, item.runId, "launch", nonce, error);
    }
  }

  async function settleCompletedRun(workerId: string, runId: string, job: Pick<JobMeta, "status" | "exitCode" | "error">): Promise<void> {
    const nonce = randomUUID(); if (!claimWorkerRun(getRegistry(), workerId, runId, "settlement", nonce, ["running"])) return;
    const worker = getWorker(getRegistry(), workerId)!; const run = getWorkerRun(getRegistry(), workerId, runId)!; const runtime = run.runtime as RunRuntime;
    let outcome: any = "failed"; let outcomeSource: "worker" | "system" = "system"; let summary = "Worker run failed before accepting a result."; let question: string | undefined;
    let reported: string[] = []; let artifacts: string[] = []; const errors: Array<{ scope: "run" | "repositories" | "artifacts"; message: string }> = [];
    try {
      if (job.status === "exited" && job.exitCode === 0) {
        const settled = readWorkerHostSettlement(runtime.settledFile); if (settled.workerId !== workerId || settled.runId !== runId || settled.sessionId !== worker.sessionId || path.resolve(settled.resultFile) !== path.resolve(runtime.resultFile)) throw new Error("Worker host settlement identity mismatch.");
        const accepted = readWorkerRuntimeResult(runtime.resultFile); if (accepted.workerId !== workerId || accepted.runId !== runId) throw new Error("Worker result identity mismatch.");
        outcome = accepted.result.outcome; outcomeSource = "worker"; summary = accepted.result.summary; question = accepted.result.question; reported = accepted.result.repositories ?? []; artifacts = accepted.result.artifacts ?? [];
      } else errors.push({ scope: "run", message: sanitizeError(job.error ?? `Worker host exited with status ${job.status}${job.exitCode === undefined ? "" : ` (${job.exitCode})`}.`) });
      removeContainer(docker(), runtime.container);
      if (runtime.overlay) cleanupOverlay(docker(), runtime.overlay);
      const inventory = inventoryWorkerRepositories({ workspaceRoot: worker.workspaceRoot, workerId, runId, reported, before: runtime.repositoryBefore });
      errors.push(...inventory.errors.map((message) => ({ scope: "repositories" as const, message: sanitizeError(message) })));
      finalizeClaimedWorkerRun(getRegistry(), { parentSessionFile: worker.parentSessionFile, workerId, runId, claimKind: "settlement", claimNonce: nonce, outcome, outcomeSource, summary: summary.slice(0, 2048), ...(question ? { question } : {}), repositories: inventory.repositories, artifacts, errors, sessionEndLine: worker.sessionFile ? countLines(worker.sessionFile) : undefined, settledAt: now().toISOString() });
      if (currentContext?.sessionManager.getSessionFile() && realpathOrResolve(currentContext.sessionManager.getSessionFile()!) === worker.parentSessionFile) deliverPendingCompletions(api, getRegistry(), worker.parentSessionFile, runtimeGeneration);
    } catch (error) { recordRecovery(workerId, runId, error); }
  }

  async function failClaimedRun(workerId: string, runId: string, claimKind: "launch" | "settlement", claimNonce: string, error: unknown): Promise<void> {
    const worker = getWorker(getRegistry(), workerId); const run = worker && getWorkerRun(getRegistry(), workerId, runId); if (!worker || !run || run.claimKind !== claimKind || run.claimNonce !== claimNonce) return; const runtime = run.runtime as RunRuntime;
    try { removeContainer(docker(), runtime.container); if (runtime.overlay) cleanupOverlay(docker(), runtime.overlay);
      finalizeClaimedWorkerRun(getRegistry(), { parentSessionFile: worker.parentSessionFile, workerId, runId, claimKind, claimNonce, outcome: "failed", outcomeSource: "system", summary: "Worker run failed before accepting a result.", errors: [{ scope: "run", message: sanitizeError(error) }], sessionEndLine: worker.sessionFile ? countLines(worker.sessionFile) : undefined, settledAt: now().toISOString() });
    } catch (cleanupError) { recordRecovery(workerId, runId, cleanupError); }
  }

  async function cancelWorker(worker: WorkerRegistryRecord): Promise<"cancelled" | "not_active"> {
    if (!worker.activeRunId) return "not_active"; const runId = worker.activeRunId; const nonce = randomUUID();
    if (!claimWorkerCancellation(getRegistry(), worker.workerId, runId, nonce, now().toISOString())) return "not_active";
    pending.delete(runId); const run = getWorkerRun(getRegistry(), worker.workerId, runId)!; const runtime = run.runtime as RunRuntime;
    try {
      rmSync(path.join(runtime.runDir, "host-authorization.json"), { force: true });
      const attached = active.get(worker.workerId); if (attached?.runId === runId) { attached.handle.cancel("SIGTERM"); }
      else if (existsSync(runtime.processFile)) { const process = readWorkerHostProcess(runtime.processFile); if (process.workerId !== worker.workerId || process.runId !== runId || process.nonce !== runtime.processNonce) throw new Error("Worker host process identity mismatch during cancellation."); if (isAsyncJobProcessGroupAlive(process.pid)) signalAsyncJobProcessGroup(process.pid, "SIGTERM"); }
      removeContainer(docker(), runtime.container);
      if (attached?.runId === runId) await Promise.race([attached.handle.completion, delay(5_000)]);
      if (runtime.overlay) cleanupOverlay(docker(), runtime.overlay);
      const survivors = unsettledPersistedAsyncShellJobsForOwner(path.join(workerPaths(roots, worker.workerId).stateDir, "async-shell"), { kind: "worker-run", workerId: worker.workerId, runId }).filter((job) => job.status === "running" || job.status === "unknown");
      if (survivors.length) throw new Error(`Worker-owned process records remain active after container removal: ${survivors.map((job) => job.jobId).join(", ")}.`);
      finalizeClaimedWorkerRun(getRegistry(), { parentSessionFile: worker.parentSessionFile, workerId: worker.workerId, runId, claimKind: "cancellation", claimNonce: nonce, outcome: "cancelled", outcomeSource: "system", summary: "Worker run was cancelled by its parent.", sessionEndLine: worker.sessionFile ? countLines(worker.sessionFile) : undefined, settledAt: now().toISOString() });
      active.delete(worker.workerId); deliverPendingCompletions(api, getRegistry(), worker.parentSessionFile, runtimeGeneration); return "cancelled";
    } catch (error) { recordRecovery(worker.workerId, runId, error); return "not_active"; }
  }

  async function discardWorker(worker: WorkerRegistryRecord): Promise<void> {
    const nonce = randomUUID(); claimWorkerDiscard(getRegistry(), worker.workerId, worker.version, nonce, now().toISOString());
    const paths = workerPaths(roots, worker.workerId); const stateTrash = `${paths.stateDir}.discard-${nonce}`; const separateWorkspace = path.resolve(paths.workspaceRoot).startsWith(`${path.resolve(paths.stateDir)}${path.sep}`) ? undefined : `${paths.workspaceRoot}.discard-${nonce}`;
    try {
      if (existsSync(paths.stateDir)) renameSync(paths.stateDir, stateTrash); if (separateWorkspace && existsSync(paths.workspaceRoot)) renameSync(paths.workspaceRoot, separateWorkspace);
      finalizeWorkerDiscard(getRegistry(), worker.workerId, nonce); rmSync(stateTrash, { recursive: true, force: true }); if (separateWorkspace) rmSync(separateWorkspace, { recursive: true, force: true });
    } catch (error) {
      try { if (existsSync(stateTrash) && !existsSync(paths.stateDir)) renameSync(stateTrash, paths.stateDir); if (separateWorkspace && existsSync(separateWorkspace) && !existsSync(paths.workspaceRoot)) renameSync(separateWorkspace, paths.workspaceRoot); } catch {}
      abandonWorkerDiscard(getRegistry(), worker.workerId, nonce, sanitizeError(error), now().toISOString()); throw error;
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

  async function reconcileActiveRuns(context: ExtensionContext, parentSessionFile: string): Promise<void> {
    for (const { worker, run } of activeRunsForParent(getRegistry(), parentSessionFile)) {
      if (worker.recoveryError) { deliverRecovery(worker, run, worker.recoveryError); continue; }
      const runtime = run.runtime as RunRuntime; if (!runtime || runtime.version !== 2 || run.claimKind) continue;
      if (run.status === "queued") {
        if (!pending.has(run.runId)) { const item = { workerId: worker.workerId, runId: run.runId, parentSessionFile, parentSessionId: context.sessionManager.getSessionId(), runtime }; pending.set(run.runId, item); pending.delete(run.runId); await startPreparedRun(context, item); }
        continue;
      }
      if (active.get(worker.workerId)?.runId === run.runId) continue;
      if (existsSync(runtime.settledFile) && existsSync(runtime.resultFile)) { await settleCompletedRun(worker.workerId, run.runId, { status: "exited", exitCode: 0 }); continue; }
      if (existsSync(runtime.processFile)) { try { const process = readWorkerHostProcess(runtime.processFile); if (process.workerId === worker.workerId && process.runId === run.runId && process.nonce === runtime.processNonce && isAsyncJobProcessGroupAlive(process.pid)) continue; } catch {} }
      const nonce = randomUUID(); if (claimWorkerRun(getRegistry(), worker.workerId, run.runId, "settlement", nonce, ["running"])) await failClaimedRun(worker.workerId, run.runId, "settlement", nonce, new Error("Worker supervisor exited without a verified result settlement."));
    }
  }

  function registerCommands(): void {
    api.registerCommand("worker:list", { description: "List retained workers; optional status and role filters", handler: async (args, context) => { const [status, role] = args.trim().split(/\s+/).filter(Boolean); const result = await control({ action: "list", ...(status ? { status: status as any } : {}), ...(role ? { role: role as any } : {}) }, context); context.ui.notify(result.content[0]?.type === "text" ? result.content[0].text : "No workers.", "info"); } });
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
  function resolveCandidate(candidateId: string, parent: string): { repo: string; commit: string } {
    const rows = getRegistry().database.prepare("SELECT r.worker_id,r.run_id,r.repositories_json,w.workspace_root,w.parent_session_file FROM runs r JOIN workers w ON w.worker_id=r.worker_id WHERE r.status='settled'").all() as Array<any>;
    for (const row of rows) { if (row.parent_session_file !== parent) continue; const item = (JSON.parse(row.repositories_json) as WorkerRepositoryResult[]).find((candidate) => candidate.candidateId === candidateId); if (!item) continue; if (!item.eligible) throw new Error(`Candidate ${candidateId} is not eligible for merge testing.`); const repo = canonicalPathWithin(row.workspace_root, path.join(row.workspace_root, item.path)); if (trustedGit(repo, ["rev-parse", "HEAD"]).trim() !== item.commit) throw new Error(`Candidate ${candidateId} changed after settlement.`); return { repo, commit: item.commit }; }
    throw new Error(`Unknown candidate ${candidateId} for this parent session.`);
  }
  function managedCandidateWarnings() { return (candidateRepo: string, candidateCommit: string) => {
    const rows = getRegistry().database.prepare("SELECT r.run_id,r.repositories_json,w.worker_id,w.latest_run_id,w.status,w.workspace_root FROM runs r JOIN workers w ON w.worker_id=r.worker_id WHERE r.status='settled'").all() as Array<any>;
    for (const row of rows) { const item = (JSON.parse(row.repositories_json) as WorkerRepositoryResult[]).find((candidate) => path.resolve(row.workspace_root, candidate.path) === path.resolve(candidateRepo) && candidate.commit === candidateCommit); if (!item) continue; const latest = row.run_id === row.latest_run_id; const warnings = [...(!latest ? [`Candidate belongs to historical run ${row.run_id}; latest is ${row.latest_run_id}.`] : []), ...(row.status !== "idle" ? ["Source worker has a newer active run that may supersede this candidate."] : [])]; return { source: { workerId: row.worker_id, runId: row.run_id, latest }, ...(warnings.length ? { warnings } : {}) }; } return {}; } }
  function deliverRecovery(worker: WorkerRegistryRecord, run: WorkerRunRecord, error: string): void { const key = `${runtimeGeneration}:${run.runId}`; if (deliveredRecovery.has(key) || !currentContext?.sessionManager.getSessionFile() || realpathOrResolve(currentContext.sessionManager.getSessionFile()!) !== worker.parentSessionFile) return; deliveredRecovery.add(key); const event = { event: "worker_recovery_required", workerId: worker.workerId, runId: run.runId, role: worker.role, status: run.status === "settled" ? "running" : run.status, error: sanitizeError(error) }; api.sendMessage({ customType: "worker-run", content: JSON.stringify(event), display: true, details: event }, { triggerTurn: true, deliverAs: "steer" }); }
  function recordRecovery(workerId: string, runId: string, error: unknown): void { try { const message = sanitizeError(error); setWorkerRecoveryError(getRegistry(), workerId, runId, message, now().toISOString()); const worker = getWorker(getRegistry(), workerId); const run = worker && getWorkerRun(getRegistry(), workerId, runId); if (worker && run) deliverRecovery(worker, run, message); } catch {} }
}

function writeReviewContext(paths: WorkerPaths, reviewerWorkerId: string, contextId: string, subjectWorker: WorkerRegistryRecord, subjectRun: WorkerRunRecord, inputs: RetainedInput[]): string {
  const directory = path.join(paths.stateDir, "contexts"); mkdirSync(directory, { recursive: true, mode: 0o700 }); const file = path.join(directory, `review-${contextId}.json`);
  const value = { version: 2, reviewerWorkerId, reviewedWorkerId: subjectWorker.workerId, reviewedRunId: subjectRun.runId, subjectWorkspace: "/review/subject", session: { path: "/review/session.jsonl", range: { startLine: subjectRun.sessionStartLine, endLine: subjectRun.sessionEndLine } }, repositories: subjectRun.repositories, artifacts: subjectRun.artifacts, candidates: subjectRun.repositories.map(({ candidateId, path, reported, changed, dirty, eligible, issues }) => ({ candidateId, path, reported, changed, dirty, eligible, ...(issues ? { issues } : {}) })), additionalInputs: contextInputs(inputs) };
  writeReadonlyJson(file, value); return file;
}
function assertIntegrationTargetsCurrent(contextFile: string): void { const context = JSON.parse(readFileSync(contextFile, "utf8")) as any; for (const repository of context.repositories ?? []) { const current = trustedGit(repository.target.repo, ["rev-parse", repository.target.ref]).trim(); if (current !== repository.target.commit) throw new Error(`Target ${repository.id} moved from ${repository.target.commit} to ${current}; run worker_merge_test again before integration.`); } }
function writeIntegrationContext(paths: WorkerPaths, preparedId: string, inputs: RetainedInput[], resumed: boolean, supplied?: ReturnType<typeof readPreparedMergeSet>): string {
  const directory = path.join(paths.stateDir, "contexts"); mkdirSync(directory, { recursive: true, mode: 0o700 }); const file = path.join(directory, `integration-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  let set = supplied; if (!set) { const local = path.join(paths.workspaceRoot, "prepared", preparedId, "prepared.json"); set = JSON.parse(readFileSync(local, "utf8")); }
  const value = { version: 2, preparedId, status: set!.status, order: set!.order, resumed, repositories: set!.repositories.map((item: any) => ({ id: item.id, path: path.relative(paths.workspaceRoot, item.preparedPath).split(path.sep).join("/"), method: item.method, status: item.status, dependsOn: item.dependsOn, target: { repo: item.targetRepo, ref: item.targetRef, commit: item.expectedCommit, privateRef: item.targetPrivateRef }, candidate: { repo: item.candidateRepo, commit: item.candidateCommit, privateRef: item.candidatePrivateRef }, mergeBase: item.mergeBase, conflicts: item.conflicts ?? [], mergeMessages: item.mergeMessages ?? [], overlapCount: item.overlapCount })), additionalInputs: contextInputs(inputs) };
  writeReadonlyJson(file, value); return file;
}
function writeReadonlyJson(file: string, value: unknown): void { if (existsSync(file)) chmodSync(file, 0o600); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); chmodSync(file, 0o400); }
function sessionIdentity(paths: WorkerPaths): { sessionId: string; sessionFile: string } { const files = existsSync(paths.sessionDir) ? readdirSync(paths.sessionDir).filter((name) => name.endsWith(".jsonl")) : []; if (files.length !== 1) throw new Error(`Expected one fresh worker session in ${paths.sessionDir}.`); const sessionFile = realpathSync(path.join(paths.sessionDir, files[0]!)); const first = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]!); return { sessionId: first.id, sessionFile }; }
function verifyRetainedSession(worker: WorkerRegistryRecord): void { if (worker.role === "work") verifyWorkerSession({ sessionFile: worker.sessionFile!, sessionId: worker.sessionId!, workspaceRoot: worker.workspaceRoot, parentSessionFile: worker.parentSessionFile }); else { const first = JSON.parse(readFileSync(worker.sessionFile!, "utf8").split("\n")[0]!); if (first.id !== worker.sessionId || path.resolve(first.cwd) !== path.resolve(worker.workspaceRoot) || first.parentSession) throw new Error(`Worker ${worker.workerId} retained independent session is invalid.`); } }
function runtimeInputs(worker: WorkerRegistryRecord): RetainedInput[] { const value = worker.runtime?.inputs; return Array.isArray(value) ? value as RetainedInput[] : []; }
function baselineRuntime(worker: WorkerRegistryRecord): Partial<WorkerRuntime> { const value = worker.runtime?.repositoryBaselines; return Array.isArray(value) ? { repositoryBaselines: value as any } : {}; }
function roleInstructionsFor(role: WorkerRole): string { return readFileSync(fileURLToPath(new URL(`../../worker-roles/${role}.md`, import.meta.url)), "utf8").trimEnd(); }
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
function resultText(text: string, details: any): AgentToolResult<any> { return { content: [{ type: "text", text }], details }; }
function slimRun(run: WorkerRunRecord) { return { runId: run.runId, status: run.status, ...(run.outcome ? { outcome: run.outcome, outcomeSource: run.outcomeSource } : {}), createdAt: run.createdAt, ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.settledAt ? { settledAt: run.settledAt } : {}) }; }
function workerListItem(worker: WorkerRegistryRecord) { return { workerId: worker.workerId, role: worker.role, status: worker.status, ...(worker.activeRunId ? { activeRunId: worker.activeRunId } : {}), taskIds: worker.taskIds, ...(worker.modelSelection ? { modelSelection: worker.modelSelection } : {}), ...(worker.recoveryError ? { recoveryRequired: true } : {}), lastActivityAt: worker.updatedAt }; }
function exactRun(worker: WorkerRegistryRecord, run: WorkerRunRecord) { return { workerId: worker.workerId, role: worker.role, runId: run.runId, status: run.status, taskIds: run.taskIds, ...(run.modelSelection ? { modelSelection: run.modelSelection } : {}), createdAt: run.createdAt, ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.settledAt ? { settledAt: run.settledAt } : {}), ...(run.jobId ? { jobId: run.jobId } : {}), ...(run.stdoutLog ? { stdoutLog: run.stdoutLog } : {}), ...(run.stderrLog ? { stderrLog: run.stderrLog } : {}), ...(worker.sessionId ? { sessionId: worker.sessionId } : {}), ...(worker.sessionFile ? { sessionFile: worker.sessionFile } : {}), sessionRange: { ...(run.sessionStartLine === undefined ? {} : { startLine: run.sessionStartLine }), ...(run.sessionEndLine === undefined ? {} : { endLine: run.sessionEndLine }) }, workspaceRoot: worker.workspaceRoot, ...(run.binding ? { binding: run.binding } : {}), ...(worker.recoveryError ? { recoveryError: worker.recoveryError } : {}), ...(run.status === "settled" ? { outcome: run.outcome, outcomeSource: run.outcomeSource, ...(run.summary ? { summary: run.summary } : {}), ...(run.question ? { question: run.question } : {}), repositories: run.repositories.map(({ commit: _commit, ...repository }) => repository), artifacts: run.artifacts, errors: run.errors } : {}) }; }
function formatExactRun(value: any): string { return `${value.outcome ?? value.status} · ${value.role} · ${value.workerId}\nrun ${value.runId}\n${value.taskIds?.length ?? 0} tasks · ${value.repositories?.length ?? 0} repositories · ${value.artifacts?.length ?? 0} artifacts${value.recoveryError ? `\nrecovery: ${value.recoveryError}` : ""}`; }
function compactCall(theme: any, text: string): Text { return new Text(theme.fg("toolTitle", theme.bold(text.slice(0, 80))), 0, 0); }
function compactResult(theme: any, result: AgentToolResult<any>, fallback: string): Text { const item = result.content?.find((candidate) => candidate.type === "text"); return new Text(theme.fg("success", item?.type === "text" ? item.text.split("\n")[0]!.slice(0, 120) : fallback), 0, 0); }
function runCallHint(input: WorkerRunInputV2): string { const first = input.runs[0]; if (!first) return "Run Workers"; const hint = first.action === "resume" ? first.workerId.slice(-8) : first.role === "work" ? first.taskIds[0] : first.role === "review" ? `run ${first.reviewedRunId.slice(-8)}` : first.preparedId.slice(-8); const label = first.action === "start" && first.role === "review" ? "Review Worker Output" : first.action === "start" && first.role === "integration" ? "Resolve Repository Conflicts" : "Run Workers"; return `${label} · ${hint}${input.runs.length > 1 ? ` +${input.runs.length - 1}` : ""}`; }
function mergeHint(action: string, repositories: any[]): string { const first = repositories?.[0]; return first ? `${action} · ${String(first.candidateId).slice(-8)} → ${String(first.targetRef).replace("refs/heads/", "")} · ${first.method}${repositories.length > 1 ? ` +${repositories.length - 1}` : ""}` : `${action} merge`; }
function publicPreparedSet(set: any) { return { preparedId: set.preparedId, status: set.status, order: set.order, repositories: set.repositories.map((item: any) => ({ id: item.id, candidateRepo: item.candidateRepo, candidateCommit: item.candidateCommit, targetRepo: item.targetRepo, targetRef: item.targetRef, method: item.method, status: item.status, expectedCommit: item.expectedCommit, ...(item.desiredCommit ? { desiredCommit: item.desiredCommit } : {}), preparedPath: item.preparedPath, overlapCount: item.overlapCount, dependsOn: item.dependsOn, ...(item.source ? { source: item.source } : {}), ...(item.warnings ? { warnings: item.warnings } : {}) })), ...(set.resolutionCases ? { resolutionCases: set.resolutionCases } : {}) }; }
function sessionDeliveryIds(context: ExtensionContext): string[] { const ids = new Set<string>(); const visit = (value: unknown): void => { if (!value || typeof value !== "object") return; const record = value as Record<string, unknown>; if (typeof record.deliveryId === "string" && record.deliveryId.startsWith("worker-run:")) ids.add(record.deliveryId); for (const child of Object.values(record)) Array.isArray(child) ? child.forEach(visit) : visit(child); }; try { for (const entry of context.sessionManager.getEntries()) visit(entry); } catch {} return [...ids]; }
function deliverPendingCompletions(api: ExtensionAPI, registry: WorkerRegistry, parent: string, generation: number): void { for (const delivery of pendingWorkerDeliveries(registry, parent)) { if (!claimWorkerDelivery(registry, delivery.deliveryId, parent, generation)) continue; const worker = getWorker(registry, delivery.workerId); const run = getWorkerRun(registry, delivery.workerId, delivery.runId); if (!worker || !run?.outcome || !run.outcomeSource) { releaseWorkerDeliveryClaim(registry, delivery.deliveryId, generation); continue; } const event = { event: "worker_settled", workerId: worker.workerId, runId: run.runId, role: worker.role, outcome: run.outcome, outcomeSource: run.outcomeSource, ...(run.summary ? { summary: run.summary } : {}), ...(run.question ? { question: run.question } : {}), repositoryCount: run.repositories.length, artifactCount: run.artifacts.length, ...(run.errors.length ? { errors: run.errors } : {}) }; try { api.sendMessage({ customType: "worker-run", content: JSON.stringify(event), display: true, details: { ...event, deliveryId: delivery.deliveryId } }, { triggerTurn: true, deliverAs: delivery.completionDelivery }); } catch { releaseWorkerDeliveryClaim(registry, delivery.deliveryId, generation); } } }
