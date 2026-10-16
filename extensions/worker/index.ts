import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Text } from "@earendil-works/pi-tui";
import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { throwIfAborted } from "../_shared/cancellation.js";
import { handleAsyncShellViewerCommand } from "../async-shell/index.js";
import { resolveDockerPath, settleWorkerContainer } from "../_shared/worker-container.js";
import { inputJsonSchemaGuideline, outputJsonSchemaGuideline } from "../_shared/tool-prompt.js";
import { RetainedToolOutputSchemas } from "../_shared/tool-output.js";
import { WorkerControlParamsV2, WorkerMergeApplyParams, WorkerMergeTestParams, WorkerRunParamsV2, type WorkerControlInputV2, type WorkerRunInputV2 } from "./contract.js";
import { applyPreparedWorkerMerges, consumePreparedMergeSet, prepareWorkerMerges, readPreparedMergeSet } from "./merge.js";
import { claimWorkerDelivery, createWorkerAndRun, discardWorkerRegistryRecord, getWorker, getWorkerRun, insertWorkerRun, leaseWorkerForReview, listWorkerRuns, listWorkers, markWorkerDeliveryDelivered, markWorkerRunRunning, openWorkerRegistry, pendingWorkerDeliveries, reconcileWorkerDeliveries, registerParentRuntime, releaseWorkerDeliveryClaim, releaseWorkerReviewLease, settleWorkerRun, storePreparedSet, updatePreparedSetStatus, updateWorkerRunSessionRange, updateWorkerRuntimeMetadata, workerRegistryDataVersion, type WorkerRegistry, type WorkerRole, type WorkerRunRecord } from "./registry.js";
import { readWorkerRuntimeResult } from "./runtime.js";
import { cleanupReviewOverlay, createReviewOverlay } from "./review-workspace.js";
import { preferredWorkerModel } from "./settings.js";
import { defaultWorkerRoots, readWorkerRecord, subscribeWorkerRecordChanges, workerPaths, writeWorkerRecord, type WorkerRecord } from "./state.js";
import { registerWorkerExtension as registerLegacyWorkerExtension, resolveWorkerRoute as resolveLegacyModel } from "./legacy.js";

export { WORKER_ACTIVITY_STATUS_KEY, activeWorkerCountForContext, buildIntegrationAnalysisPrompt, buildIntegrationResolutionPrompt, buildNewWorkerPrompt, buildResumeWorkerPrompt, renderWorkerActivityStatus, resolveWorkerReviewRoute, resolveWorkerReviewRoutes, resolveWorkerRoute } from "./legacy.js";
export { WorkerRunParamsV2 as WorkerRunParams, WorkerControlParamsV2 as WorkerControlParams, WorkerMergeTestParams, WorkerMergeApplyParams };
export type WorkerRunInput = WorkerRunInputV2;
export type WorkerControlInput = WorkerControlInputV2;

type LegacyTool = { execute: (toolCallId: string, params: any, signal: AbortSignal, onUpdate: ((value: any) => void) | undefined, context: ExtensionContext) => Promise<any> };
type WorkerFacadeDependencies = { runtimeRoot?: string; legacy?: Record<string, unknown> };

export default function workerExtension(api: ExtensionAPI): void { registerWorkerExtension(api); }

export function registerWorkerExtension(api: ExtensionAPI, overrides: WorkerFacadeDependencies = {}): void {
  const tools = new Map<string, LegacyTool>();
  let registry: WorkerRegistry | undefined;
  let runtimeGeneration = 0;
  let deliveryTimer: NodeJS.Timeout | undefined;
  let observedDataVersion = 0;
  let unsubscribeRecords: (() => void) | undefined;
  const roots = ((overrides.legacy as any)?.roots ?? defaultWorkerRoots()) as ReturnType<typeof defaultWorkerRoots>;
  const runtimeRoot = overrides.runtimeRoot ?? path.dirname(roots.stateRoot);
  const getRegistry = () => registry ??= openWorkerRegistry(runtimeRoot);

  const proxy = new Proxy(api as any, {
    get(target, property) {
      if (property === "registerTool") return (definition: LegacyTool & { name: string }) => { tools.set(definition.name, definition); };
      if (property === "registerCommand") return (name: string, definition: unknown) => { if (!name.startsWith("worker:")) return target.registerCommand(name, definition); };
      if (property === "sendMessage") return (message: any, options: any) => {
        const transformed = transformCompletion(message, getRegistry());
        const deliveryId = transformed?.details?.event === "worker_settled" ? `worker-run:${transformed.details.workerId}:${transformed.details.runId}` : undefined;
        if (!deliveryId) return target.sendMessage(transformed, options);
        if (!runtimeGeneration || !claimWorkerDelivery(getRegistry(), deliveryId, transformed.details.record.parentSessionFile, runtimeGeneration)) return;
        return target.sendMessage({ ...transformed, details: { ...transformed.details, deliveryId } }, options);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  registerLegacyWorkerExtension(proxy as ExtensionAPI, overrides.legacy as any);
  const mirrorRecord = (recordFile: string) => {
    try {
      const record = readWorkerRecord(recordFile);
      updateWorkerRuntimeMetadata(getRegistry(), record.workerId, { sessionId: record.sessionId, sessionFile: record.sessionFile, modelSelection: `${record.route.provider}/${record.route.model}:${record.route.thinkingLevel}`, updatedAt: record.updatedAt });
      if (record.status !== "running" || !record.activeRun) return;
      const run = getWorkerRun(getRegistry(), record.workerId, record.activeRun.runId);
      if (record.sessionFile && run?.sessionStartLine === undefined) updateWorkerRunSessionRange(getRegistry(), record.workerId, record.activeRun.runId, countLines(record.sessionFile));
      if (run?.status !== "queued") return;
      markWorkerRunRunning(getRegistry(), record.workerId, record.activeRun.runId, {
        modelSelection: `${record.route.provider}/${record.route.model}:${record.route.thinkingLevel}`,
        jobId: record.activeRun.jobId,
        stdoutLog: record.activeRun.stdoutLog ?? path.join(record.activeRun.logDir ?? path.join(path.dirname(recordFile), "runs", record.activeRun.runId), "stdout.log"),
        stderrLog: record.activeRun.stderrLog ?? path.join(record.activeRun.logDir ?? path.join(path.dirname(recordFile), "runs", record.activeRun.runId), "stderr.log"),
        startedAt: record.updatedAt
      });
    } catch {}
  };
  unsubscribeRecords = subscribeWorkerRecordChanges(mirrorRecord);

  api.on("session_start", (_event, context) => {
    if (!unsubscribeRecords) unsubscribeRecords = subscribeWorkerRecordChanges(mirrorRecord);
    const parent = context.sessionManager.getSessionFile();
    if (!parent) return;
    const exactParent = path.resolve(parent);
    reconcileWorkerDeliveries(getRegistry(), exactParent, sessionDeliveryIds(context));
    runtimeGeneration = registerParentRuntime(getRegistry(), exactParent, randomUUID(), new Date().toISOString());
    observedDataVersion = workerRegistryDataVersion(getRegistry());
    deliverPendingCompletions(api, getRegistry(), exactParent, runtimeGeneration);
    if (deliveryTimer) clearInterval(deliveryTimer);
    deliveryTimer = setInterval(() => {
      const current = workerRegistryDataVersion(getRegistry());
      if (current === observedDataVersion) return;
      observedDataVersion = current;
      deliverPendingCompletions(api, getRegistry(), exactParent, runtimeGeneration);
    }, 1_000);
    deliveryTimer.unref();
  });
  api.on("message_end", (event, context) => {
    const details = (event.message as any)?.details; const deliveryId = details?.deliveryId;
    if (typeof deliveryId !== "string" || !deliveryId.startsWith("worker-run:")) return;
    const parent = context.sessionManager.getSessionFile(); if (!parent) return;
    try { markWorkerDeliveryDelivered(getRegistry(), deliveryId, runtimeGeneration, new Date().toISOString()); } catch {}
  });
  api.on("session_shutdown", () => { unsubscribeRecords?.(); unsubscribeRecords = undefined; if (deliveryTimer) clearInterval(deliveryTimer); deliveryTimer = undefined; registry?.close(); registry = undefined; });

  registerCommands(api, getRegistry, tools);
  api.registerMessageRenderer("worker-run", (message, _options, theme) => {
    const d = message.details as any;
    const role = d?.role ?? "work";
    const outcome = d?.outcome ?? "completed";
    const id = typeof d?.workerId === "string" ? d.workerId.slice(-8) : "worker";
    return new Text(theme.fg(outcome === "failed" ? "error" : outcome === "cancelled" ? "warning" : "success", `${outcome.replaceAll("_", " ")} · ${role} · ${id}`), 0, 0);
  });

  api.registerTool(defineTool({
    name: "worker_run", label: "Run Workers",
    description: "Start durable work, review, or integration workers, or resume previous workers. The runs execute asynchronously and preserve their exact role, workspace, session, tasks, and selected model across resumes.",
    promptSnippet: "Start work, review, or integration workers, or resume previous workers.",
    promptGuidelines: [
      "worker_run use: Delegate substantial self-contained work, independently review every completed work/integration result, start integration for prepared conflicts, and resume the same worker for answers or corrections. Batch only independent runs.",
      inputJsonSchemaGuideline("worker_run", WorkerRunParamsV2),
      outputJsonSchemaGuideline("worker_run", RetainedToolOutputSchemas.worker_run),
      "worker_run constraints: Parent authority covers acceptance, validation, merge application, publication, and task closure. Review subjects must be the latest completed idle run. Model selection is fixed after startup; no Fable or max thinking. Only result content is provider-visible; details remain internal."
    ],
    parameters: WorkerRunParamsV2, renderCall: (args, theme) => compactCall(theme, runCallHint(args as WorkerRunInputV2)), renderResult: (result, _options, theme) => compactResult(theme, result as AgentToolResult<any>, "worker run"), executionMode: "sequential",
    async execute(callId, params, signal, onUpdate, context): Promise<AgentToolResult<any>> {
      throwIfAborted(signal);
      const parentSessionFile = requireParentSession(context);
      const legacy = requiredLegacy(tools, "worker_run");
      const legacyRuns: any[] = [];
      const plans: Array<{ role: WorkerRole; source?: { workerId: string; runId: string }; preparedId?: string; additionalInputs?: string[]; resumed?: boolean }> = [];
      for (const request of params.runs) {
        if (request.action === "resume") {
          const worker = getWorker(getRegistry(), request.workerId);
          if (!worker || worker.parentSessionFile !== parentSessionFile) throw new Error(`Unknown worker ${request.workerId} for this parent session.`);
          if (worker.reviewedByWorkerId) throw new Error(`Worker ${request.workerId} is leased to active reviewer ${worker.reviewedByWorkerId}.`);
          acknowledgeLegacyDelivery(request.workerId);
          legacyRuns.push({ kind: "resume", workerId: request.workerId, message: request.instructions, addTaskIds: request.additionalTaskIds, completionDelivery: request.completionDelivery });
          const binding = workerRoleBinding(readWorkerRecord(workerPaths(roots, request.workerId).recordFile));
          plans.push({ role: worker.role, ...(binding && "reviewedRunId" in binding ? { source: { workerId: binding.reviewedWorkerId, runId: binding.reviewedRunId } } : {}), ...(binding && "preparedId" in binding ? { preparedId: binding.preparedId } : {}), additionalInputs: request.additionalInputs, resumed: true });
          continue;
        }
        const role = request.role;
        const modelSelection = chooseModelSelection(role, role === "work" ? request.modelSelection : undefined, context);
        if (role === "work") {
          legacyRuns.push({ kind: "new", role, taskIds: request.taskIds, guidance: request.instructions, route: modelSelection, completionDelivery: request.completionDelivery, initialRepos: request.repositoryBaselines?.map((item) => ({ source: item.path, revision: item.revision })) });
          plans.push({ role });
        } else if (role === "review") {
          const subject = findRun(getRegistry(), request.reviewedRunId, parentSessionFile);
          if (subject.run.status !== "settled" || subject.worker.latestRunId !== subject.run.runId || subject.worker.status !== "idle") throw new Error(`Review requires the latest completed idle run; ${request.reviewedRunId} is not reviewable.`);
          const guidance = reviewPrompt(request.reviewedRunId, request.instructions);
          legacyRuns.push({ kind: "new", role, taskIds: subject.run.taskIds, guidance, route: modelSelection, completionDelivery: request.completionDelivery });
          plans.push({ role, source: { workerId: subject.worker.workerId, runId: subject.run.runId }, additionalInputs: request.additionalInputs });
        } else {
          const prepared = readPreparedMergeSet(parentSessionFile, request.preparedId);
          if (prepared.status !== "resolution_required") throw new Error(`Integration requires a resolution_required prepared set.`);
          legacyRuns.push({ kind: "new", role, taskIds: request.taskIds, guidance: integrationPrompt(request.preparedId, request.instructions), route: modelSelection, completionDelivery: request.completionDelivery });
          plans.push({ role, preparedId: request.preparedId, additionalInputs: request.additionalInputs });
        }
      }
      const result = await legacy.execute(callId, { runs: legacyRuns }, signal!, undefined, context);
      const receipts = result.details?.runs as any[];
      if (!Array.isArray(receipts) || receipts.length !== plans.length) throw new Error("Worker launcher returned an invalid receipt set.");
      const now = new Date().toISOString();
      for (let index = 0; index < receipts.length; index += 1) {
        const receipt = receipts[index]!; const plan = plans[index]!; const request = params.runs[index]!;
        const legacyRecord = readWorkerRecord(workerPaths(roots, receipt.workerId).recordFile);
        const binding = plan.source ? { reviewedWorkerId: plan.source.workerId, reviewedRunId: plan.source.runId } : plan.preparedId ? { preparedId: plan.preparedId } : undefined;
        if (request.action === "resume" && plan.additionalInputs?.length && legacyRecord.container) settleWorkerContainer(resolveDockerPath(), legacyRecord.container);
        writeWorkerRecord(workerPaths(roots, receipt.workerId).recordFile, { ...legacyRecord, ...(request.action === "resume" && plan.additionalInputs?.length ? { container: undefined } : {}), role: plan.role, ...(binding ? { binding } : {}), additionalInputs: plan.additionalInputs, ...(plan.role === "review" ? {} : { additionalInputMounts: externalInputMounts(plan.additionalInputs) }) });
        if (request.action === "start") {
          createWorkerAndRun(getRegistry(), {
            workerId: receipt.workerId, parentSessionFile, role: plan.role, status: receipt.state, activeRunId: receipt.runId,
            taskIds: receipt.taskIds, modelSelection: `${receipt.provider}/${receipt.model}:${receipt.thinkingLevel}`, sessionId: receipt.sessionId,
            sessionFile: receipt.sessionFile, workspaceRoot: receipt.workspaceRoot, createdAt: now, updatedAt: now
          }, registryRun(receipt, binding, now));
        } else {
          const worker = getWorker(getRegistry(), receipt.workerId)!;
          insertWorkerRun(getRegistry(), worker.workerId, worker.version, registryRun(receipt, workerRoleBinding(legacyRecord), now), now);
        }
        if (plan.role === "review" && plan.source) { const subject = getWorker(getRegistry(), plan.source.workerId)!; if (subject.reviewedByWorkerId && subject.reviewedByWorkerId !== receipt.workerId) throw new Error(`Reviewed worker is leased to ${subject.reviewedByWorkerId}.`); if (!subject.reviewedByWorkerId) leaseWorkerForReview(getRegistry(), plan.source.workerId, receipt.workerId, new Date().toISOString()); provisionReviewWorkspace(receipt.workerId, receipt.workspaceRoot, subject, getWorkerRun(getRegistry(), plan.source.workerId, plan.source.runId)!, plan.additionalInputs); }
        if (plan.role === "integration" && plan.preparedId && !plan.resumed) { provisionIntegrationWorkspace(parentSessionFile, plan.preparedId, receipt.workerId, receipt.workspaceRoot, plan.additionalInputs); updatePreparedSetStatus(getRegistry(), plan.preparedId, parentSessionFile, "consumed", new Date().toISOString()); }
        else if (plan.role === "integration" && plan.resumed) updateIntegrationContext(receipt.workspaceRoot, plan.additionalInputs);

      }
      const details = { runs: receipts.map((receipt, index) => ({ action: params.runs[index]!.action, role: plans[index]!.role, workerId: receipt.workerId, runId: receipt.runId, status: receipt.state, taskIds: receipt.taskIds, completionDelivery: receipt.completionDelivery, modelSelection: `${receipt.provider}/${receipt.model}:${receipt.thinkingLevel}`, ...(plans[index]!.source ? { reviewedRunId: plans[index]!.source!.runId } : {}), ...(plans[index]!.preparedId ? { preparedId: plans[index]!.preparedId } : {}) })) };
      const text = details.runs.map((item) => `${item.status} · ${item.role} · ${item.workerId.slice(-8)}`).join("\n");
      onUpdate?.({ content: [{ type: "text", text }], details });
      return { content: [{ type: "text", text }], details };
    }
  }));

  api.registerTool(defineTool({
    name: "worker_control", label: "Worker Control",
    description: "List retained workers, list one worker's immutable runs, inspect one exact run, cancel active work while preserving evidence, or permanently discard one idle worker.",
    promptSnippet: "Inspect or manage durable workers with one exact worker_control action.",
    promptGuidelines: ["worker_control use: Use list for slim inventory, runs for history, get for exact evidence, cancel for active cleanup, and discard only when retained evidence is no longer useful.", inputJsonSchemaGuideline("worker_control", WorkerControlParamsV2), outputJsonSchemaGuideline("worker_control", RetainedToolOutputSchemas.worker_control), "worker_control constraints: Actions are restricted to this exact parent session. Cancellation preserves state; discard is idle-only and permanent. Delivery bookkeeping is never model-facing. Only result content is provider-visible; details remain internal."],
    parameters: WorkerControlParamsV2, renderCall: (args, theme) => compactCall(theme, `control · ${(args as WorkerControlInputV2).action}`), renderResult: (result, _options, theme) => compactResult(theme, result as AgentToolResult<any>, "worker control"), executionMode: "sequential",
    async execute(callId, params, signal, _update, context): Promise<AgentToolResult<any>> {
      throwIfAborted(signal); validateWorkerControlShape(params); const parent = requireParentSession(context); const db = getRegistry();
      if (params.action === "list") {
        const page = listWorkers(db, { parentSessionFile: parent, status: params.status, role: params.role, limit: params.limit, offset: params.offset });
        const workers = page.workers.map((worker) => ({ workerId: worker.workerId, role: worker.role, status: worker.status, activeRunId: worker.activeRunId, latestResult: latestResult(db, worker.workerId, worker.latestRunId), taskIds: worker.taskIds, modelSelection: worker.modelSelection, ...(worker.recoveryError ? { recoveryRequired: true } : {}), lastActivityAt: worker.updatedAt }));
        const counts = { idle: workers.filter((w) => w.status === "idle").length, queued: workers.filter((w) => w.status === "queued").length, running: workers.filter((w) => w.status === "running").length };
        return resultText(`${workers.length} workers · ${counts.running} running, ${counts.queued} queued, ${counts.idle} idle`, { action: "list", workers, total: page.total, counts, nextOffset: page.nextOffset });
      }
      const worker = getWorker(db, params.workerId!); if (!worker || worker.parentSessionFile !== parent) throw new Error(`Unknown worker ${params.workerId} for this parent session.`);
      if (params.action === "runs") { const page = listWorkerRuns(db, worker.workerId, params.limit, params.offset); return resultText(`${page.runs.length} retained runs`, { action: "runs", workerId: worker.workerId, runs: page.runs.map(slimRun), total: page.total, nextOffset: page.nextOffset }); }
      if (params.action === "get") { const run = getWorkerRun(db, worker.workerId, params.runId!); if (!run) throw new Error(`Unknown run ${params.runId} for worker ${worker.workerId}.`); return resultText(`${run.outcome ?? run.status} · ${worker.role} · ${worker.workerId.slice(-8)}`, { action: "get", workerId: worker.workerId, role: worker.role, workspaceRoot: worker.workspaceRoot, sessionId: worker.sessionId, sessionFile: worker.sessionFile, run }); }
      const legacy = requiredLegacy(tools, "worker_control");
      if (params.action === "discard" && worker.reviewedByWorkerId) throw new Error(`Worker ${worker.workerId} is leased to reviewer ${worker.reviewedByWorkerId}.`);
      if (params.action === "cancel") { const value = await legacy.execute(callId, { action: "cancel", workerId: worker.workerId }, signal!, undefined, context); return resultText(value.details?.outcome === "not_active" ? `not active · ${worker.workerId.slice(-8)}` : `cancelled · ${worker.role} · ${worker.workerId.slice(-8)}`, { action: "cancel", cancellation: value.details?.outcome === "not_active" ? "not_active" : "cancelled", worker: getWorker(db, worker.workerId) ?? worker }); }
      const legacyRecord = readWorkerRecord(workerPaths(roots, worker.workerId).recordFile);
      await legacy.execute(callId, { action: "discard", workerId: worker.workerId, confirm: true }, signal!, undefined, context);
      if (legacyRecord.binding && "reviewedWorkerId" in legacyRecord.binding) releaseWorkerReviewLease(db, legacyRecord.binding.reviewedWorkerId, worker.workerId, new Date().toISOString());
      discardWorkerRegistryRecord(db, worker.workerId, getWorker(db, worker.workerId)?.version ?? worker.version);
      return resultText(`discarded · ${worker.role} · ${worker.workerId.slice(-8)}`, { action: "discard", workerId: worker.workerId, discarded: true });
    }
  }));

  api.registerTool(defineTool({
    name: "worker_merge_test", label: "Test Repository Merges",
    description: "Prepare one exact isolated Git merge or squash set without changing authoritative targets. Conflicts remain as ordinary Git conflict state for parent or integration-worker resolution.",
    promptSnippet: "Create a fresh exact prepared repository set for merge testing.",
    promptGuidelines: ["worker_merge_test use: Supply explicit candidate repositories/revisions, target repositories/refs, methods, commit messages, and same-request dependencies. Every call creates a fresh preparedId.", inputJsonSchemaGuideline("worker_merge_test", WorkerMergeTestParams), outputJsonSchemaGuideline("worker_merge_test", RetainedToolOutputSchemas.worker_merge_test), "worker_merge_test constraints: It never mutates target refs/worktrees. Parent review and validation remain separate; historical managed-worker provenance produces warnings, not rejection. Only result content is provider-visible; details remain internal."],
    parameters: WorkerMergeTestParams, renderCall: (args, theme) => compactCall(theme, mergeHint("testing", (args as any).repositories)), renderResult: (result, _options, theme) => compactResult(theme, result as AgentToolResult<any>, "merge test"), executionMode: "sequential",
    async execute(_id, params, signal, _update, context) { throwIfAborted(signal); const parent = requireParentSession(context); const set = prepareWorkerMerges(parent, params.repositories, { sourceForCandidate: managedCandidateWarnings(getRegistry()) }); storePreparedSet(getRegistry(), { preparedId: set.preparedId, parentSessionFile: parent, status: set.status, order: set.order, repositories: set.repositories, createdAt: set.createdAt }); return resultText(`${set.status === "ready" ? "ready" : "resolution required"} · ${set.repositories.length} repositories`, set); }
  }));
  api.registerTool(defineTool({
    name: "worker_merge_apply", label: "Apply Prepared Repository Merges",
    description: "Apply one ready prepared repository set to exact local target refs after a set-wide preflight. Application is dependency-ordered and retry-safe but is not atomic across repositories.",
    promptSnippet: "Apply one parent-validated ready prepared set to exact local targets.",
    promptGuidelines: ["worker_merge_apply use: Call only after inspecting every prepared diff and running all required tests. Retry the same preparedId only after partial operational failure; target drift requires a new merge test.", inputJsonSchemaGuideline("worker_merge_apply", WorkerMergeApplyParams), outputJsonSchemaGuideline("worker_merge_apply", RetainedToolOutputSchemas.worker_merge_apply), "worker_merge_apply constraints: It never validates, resolves conflicts, pushes, publishes, or closes tasks. Only result content is provider-visible; details remain internal."],
    parameters: WorkerMergeApplyParams, renderCall: (args, theme) => compactCall(theme, `applying · ${(args as any).preparedId?.slice(-8) ?? "prepared set"}`), renderResult: (result, _options, theme) => compactResult(theme, result as AgentToolResult<any>, "merge apply"), executionMode: "sequential",
    async execute(_id, params, signal, _update, context) { throwIfAborted(signal); const parent = requireParentSession(context); const applied = applyPreparedWorkerMerges(parent, params.preparedId, { sourceForCandidate: managedCandidateWarnings(getRegistry()) }); updatePreparedSetStatus(getRegistry(), params.preparedId, parent, applied.status, new Date().toISOString()); return resultText(`${applied.status} · ${applied.repositories.filter((item) => item.status === "applied").length} applied`, applied); }
  }));
}

function sessionDeliveryIds(context: ExtensionContext): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown): void => { if (!value || typeof value !== "object") return; const record = value as Record<string, unknown>; if (typeof record.deliveryId === "string" && record.deliveryId.startsWith("worker-run:")) ids.add(record.deliveryId); for (const child of Object.values(record)) { if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === "object") visit(child); } };
  try { for (const entry of context.sessionManager.getEntries()) visit(entry); } catch {}
  return [...ids];
}
function compactCall(theme: any, text: string): Text { return new Text(theme.fg("toolTitle", theme.bold(text.slice(0, 80))), 0, 0); }
function compactResult(theme: any, result: AgentToolResult<any>, fallback: string): Text { const item = result.content?.find((candidate) => candidate.type === "text"); const text = item?.type === "text" ? item.text.split("\n")[0] : fallback; return new Text(theme.fg("success", String(text).slice(0, 120)), 0, 0); }
function runCallHint(input: WorkerRunInputV2): string { const first = input.runs[0]; if (!first) return "no runs"; const hint = first.action === "resume" ? first.workerId.slice(-8) : first.role === "work" ? first.taskIds[0] : first.role === "review" ? `run ${first.reviewedRunId.slice(-8)}` : first.preparedId.slice(-8); return `${first.action} ${first.action === "start" ? first.role : "worker"} · ${hint}${input.runs.length > 1 ? ` +${input.runs.length - 1}` : ""}`.slice(0, 80); }
function mergeHint(action: string, repositories: any[]): string { const first = repositories?.[0]; if (!first) return `${action} merge`; const branch = String(first.targetRef ?? "").replace("refs/heads/", ""); return `${action} · ${path.basename(first.targetRepo ?? first.id)} → ${branch} · ${first.method}${repositories.length > 1 ? ` +${repositories.length - 1}` : ""}`.slice(0, 80); }

function deliverPendingCompletions(api: ExtensionAPI, registry: WorkerRegistry, parentSessionFile: string, generation: number): void {
  for (const delivery of pendingWorkerDeliveries(registry, parentSessionFile)) {
    if (!claimWorkerDelivery(registry, delivery.deliveryId, parentSessionFile, generation)) continue;
    const worker = getWorker(registry, delivery.workerId);
    const run = getWorkerRun(registry, delivery.workerId, delivery.runId);
    if (!worker || !run?.outcome || !run.outcomeSource) { releaseWorkerDeliveryClaim(registry, delivery.deliveryId, generation); continue; }
    const event = { event: "worker_settled", workerId: worker.workerId, runId: run.runId, role: worker.role, outcome: run.outcome, outcomeSource: run.outcomeSource, ...(run.summary ? { summary: run.summary } : {}), ...(run.question ? { question: run.question } : {}), repositoryCount: run.repositories.length, artifactCount: run.artifacts.length };
    try {
      api.sendMessage({ customType: "worker-run", content: JSON.stringify(event), display: true, details: { ...event, deliveryId: delivery.deliveryId } }, { triggerTurn: true, deliverAs: delivery.completionDelivery });
    } catch { releaseWorkerDeliveryClaim(registry, delivery.deliveryId, generation); }
  }
}

function validateWorkerControlShape(params: WorkerControlInputV2): void {
  const keys = Object.keys(params); const allowed = params.action === "list" ? ["action","status","role","limit","offset"] : params.action === "runs" ? ["action","workerId","limit","offset"] : params.action === "get" ? ["action","workerId","runId"] : ["action","workerId"];
  if (!keys.every((key) => allowed.includes(key))) throw new Error(`worker_control ${params.action} received unsupported fields.`);
  if (params.action !== "list" && !params.workerId) throw new Error(`worker_control ${params.action} requires workerId.`);
  if (params.action === "get" && !params.runId) throw new Error("worker_control get requires runId.");
}

function registerCommands(api: ExtensionAPI, registry: () => WorkerRegistry, tools: Map<string, LegacyTool>): void {
  api.registerCommand("worker:list", { description: "List retained workers; optional status and role filters", handler: async (args, context) => { const [status, role] = args.trim().split(/\s+/).filter(Boolean); const page = listWorkers(registry(), { parentSessionFile: requireParentSession(context), status: status as any, role: role as any }); context.ui.notify(`${page.total} retained worker${page.total === 1 ? "" : "s"}.`, "info"); } });
  api.registerCommand("worker:show", { description: "Show an active/latest or exact retained worker run", handler: async (args, context) => { const [workerId, runId] = args.trim().split(/\s+/); if (!workerId) return context.ui.notify("Usage: /worker:show <workerId> [runId]", "info"); const worker = getWorker(registry(), workerId); if (!worker || worker.parentSessionFile !== requireParentSession(context)) throw new Error(`Unknown worker ${workerId}.`); const exact = runId ?? worker.activeRunId ?? worker.latestRunId; context.ui.notify(exact ? JSON.stringify(getWorkerRun(registry(), workerId, exact), null, 2) : `Worker ${workerId} has no runs.`, "info"); } });
  api.registerCommand("worker:logs", { description: "Open logs for an active/latest or exact retained worker run", handler: async (args, context) => { const [workerId, possibleRunId, ...viewer] = args.trim().split(/\s+/).filter(Boolean); if (!workerId) return context.ui.notify("Usage: /worker:logs <workerId> [runId] [viewer options]", "info"); const worker = getWorker(registry(), workerId); const hasRun = possibleRunId?.startsWith("run_"); const exact = (hasRun ? possibleRunId : undefined) ?? worker?.activeRunId ?? worker?.latestRunId; const run = worker && exact ? getWorkerRun(registry(), workerId, exact) : undefined; if (!run?.jobId) return context.ui.notify("No retained run logs.", "info"); await handleAsyncShellViewerCommand(context, [run.jobId, ...(hasRun ? viewer : [possibleRunId, ...viewer].filter(Boolean))].join(" ")); } });
  api.registerCommand("worker:cancel", { description: "Cancel active work while preserving retained state", handler: async (args, context) => { const workerId = args.trim(); if (!workerId) return context.ui.notify("Usage: /worker:cancel <workerId>", "info"); const worker = getWorker(registry(), workerId); if (!worker || worker.parentSessionFile !== requireParentSession(context)) throw new Error(`Unknown worker ${workerId}.`); const legacy = requiredLegacy(tools, "worker_control"); const result = await legacy.execute("command-cancel", { action: "cancel", workerId }, new AbortController().signal, undefined, context); context.ui.notify(result.details?.outcome === "not_active" ? "Worker is not active." : `Cancelled ${workerId}.`, "info"); } });
  api.registerCommand("worker:discard", { description: "Permanently discard one idle worker; requires --confirm", handler: async (args, context) => { const [workerId, confirm, ...extra] = args.trim().split(/\s+/).filter(Boolean); if (!workerId || confirm !== "--confirm" || extra.length) return context.ui.notify("Usage: /worker:discard <workerId> --confirm", "info"); const worker = getWorker(registry(), workerId); if (!worker || worker.parentSessionFile !== requireParentSession(context)) throw new Error(`Unknown worker ${workerId}.`); if (worker.reviewedByWorkerId) throw new Error(`Worker ${workerId} is leased to reviewer ${worker.reviewedByWorkerId}.`); await requiredLegacy(tools, "worker_control").execute("command-discard", { action: "discard", workerId, confirm: true }, new AbortController().signal, undefined, context); discardWorkerRegistryRecord(registry(), workerId, worker.version); context.ui.notify(`Discarded ${workerId}.`, "info"); } });
}

function transformCompletion(message: any, registry: WorkerRegistry): any {
  if (message?.customType === "worker-run-recovery") {
    const details = message.details ?? {}; const record = details.record as WorkerRecord | undefined;
    const event = { event: "worker_recovery_required", workerId: details.workerId ?? record?.workerId, runId: details.runId ?? record?.activeRun?.runId, role: record?.role ?? "work", status: record?.activeRun?.status ?? "running", error: String(details.error ?? "Worker cleanup could not be verified.").slice(0, 2048) };
    return { ...message, content: JSON.stringify(event), details: event };
  }
  if (message?.customType !== "worker-run" || !message?.details?.record) return message;
  const record = message.details.record as WorkerRecord; const runId = message.details.runId ?? record.lastRun?.runId;
  if (!runId) return message;
  let outcome: any = record.lastRun?.status === "cancelled" ? "cancelled" : "failed"; let source: "worker" | "system" = "system"; let summary = message.details.error as string | undefined; let question: string | undefined; let repositories: string[] = []; let artifacts: string[] = [];
  try { const accepted = readWorkerRuntimeResult(record.lastRun?.resultFile ?? message.details.handoff?.resultFile); outcome = accepted.result.outcome; source = "worker"; summary = accepted.result.summary; question = accepted.result.question; repositories = accepted.result.repositories ?? []; artifacts = accepted.result.artifacts ?? []; } catch {}
  try { settleWorkerRun(registry, { parentSessionFile: record.parentSessionFile, workerId: record.workerId, runId, outcome, outcomeSource: source, summary, question, repositories: repositories.map((repositoryPath) => repositoryResult(record.workspaceRoot, repositoryPath)), artifacts, ...(record.sessionFile ? { sessionEndLine: countLines(record.sessionFile) } : {}), settledAt: new Date().toISOString() }); } catch {}
  if (record.reviewOverlay) { try { const docker = resolveDockerPath(); if (record.container) settleWorkerContainer(docker, record.container); cleanupReviewOverlay(docker, record.reviewOverlay); writeWorkerRecord(workerPaths(defaultWorkerRoots(), record.workerId).recordFile, { ...record, container: undefined, reviewOverlay: undefined }); } catch {} }
  if (record.binding && "reviewedWorkerId" in record.binding && outcome !== "needs_input") { try { releaseWorkerReviewLease(registry, record.binding.reviewedWorkerId, record.workerId, new Date().toISOString()); } catch {} }
  const event = { event: "worker_settled", workerId: record.workerId, runId, role: record.role ?? "work", outcome, outcomeSource: source, ...(summary ? { summary } : {}), ...(question ? { question } : {}), repositoryCount: repositories.length, artifactCount: artifacts.length };
  return { ...message, content: JSON.stringify(event), details: { ...message.details, ...event } };
}

function countLines(file: string): number { try { const text = readFileSync(file, "utf8"); return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0); } catch { return 0; } }
function repositoryResult(workspaceRoot: string, repositoryPath: string) { const absolute = path.resolve(workspaceRoot, repositoryPath); let commit = "unknown"; let dirty = true; try { commit = execFileSync("git", ["-C", absolute, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); dirty = execFileSync("git", ["-C", absolute, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" }).trim() !== ""; } catch {} return { repositoryPath, commit, reported: true, changed: true, dirty, eligible: commit !== "unknown" && !dirty, ...(commit === "unknown" ? { issues: ["repository inspection failed"] } : {}) }; }
function registryRun(receipt: any, binding: any, now: string): WorkerRunRecord { return { runId: receipt.runId, workerId: receipt.workerId, status: receipt.state, taskIds: receipt.taskIds, modelSelection: `${receipt.provider}/${receipt.model}:${receipt.thinkingLevel}`, completionDelivery: receipt.completionDelivery, ...(binding ? { binding } : {}), jobId: receipt.jobId, repositories: [], artifacts: [], errors: [], createdAt: now, ...(receipt.state === "running" ? { startedAt: now } : {}) }; }
function workerRoleBinding(record: WorkerRecord): any { return record.binding; }
function requiredLegacy(tools: Map<string, LegacyTool>, name: string): LegacyTool { const tool = tools.get(name); if (!tool) throw new Error(`Internal worker lifecycle tool ${name} is unavailable.`); return tool; }
function requireParentSession(context: ExtensionContext): string { const file = context.sessionManager.getSessionFile(); if (!file) throw new Error("Managed workers require a persisted parent session."); return path.resolve(file); }
function resultText(text: string, details: any): AgentToolResult<any> { return { content: [{ type: "text", text }], details }; }
function slimRun(run: WorkerRunRecord) { return { runId: run.runId, status: run.status, outcome: run.outcome, outcomeSource: run.outcomeSource, createdAt: run.createdAt, startedAt: run.startedAt, settledAt: run.settledAt }; }
function latestResult(registry: WorkerRegistry, workerId: string, runId?: string) { if (!runId) return undefined; const run = getWorkerRun(registry, workerId, runId); return run?.outcome ? { runId, outcome: run.outcome, outcomeSource: run.outcomeSource } : undefined; }
function findRun(registry: WorkerRegistry, runId: string, parentSessionFile: string) { const row = registry.database.prepare("SELECT worker_id FROM runs WHERE run_id=?").get(runId) as { worker_id: string } | undefined; if (!row) throw new Error(`Unknown reviewed run ${runId}.`); const worker = getWorker(registry, row.worker_id)!; if (worker.parentSessionFile !== parentSessionFile) throw new Error(`Reviewed run ${runId} belongs to another parent session.`); return { worker, run: getWorkerRun(registry, worker.workerId, runId)! }; }
function acknowledgeLegacyDelivery(workerId: string): void { const roots = defaultWorkerRoots(); const paths = workerPaths(roots, workerId); const record = readWorkerRecord(paths.recordFile); if (record.lastRun?.delivery === "pending") writeWorkerRecord(paths.recordFile, { ...record, lastRun: { ...record.lastRun, delivery: "delivered" } }); }

function chooseModelSelection(role: WorkerRole, explicit: string | undefined, context: ExtensionContext): string {
  const failures: string[] = [];
  for (const selection of preferredWorkerModel(role, explicit)) {
    try { const resolved = resolveLegacyModel(selection, context); return `${resolved.provider}/${resolved.model}:${resolved.thinkingLevel}`; }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  throw new Error(`No configured ${role} model selection is available before launch.${failures.length ? ` ${failures.join(" ")}` : ""}`);
}
function reviewPrompt(runId: string, instructions?: string): string { return `Review exact managed-worker run ${runId}. Read review/context.json, independently inspect and test the disposable subject, store a detailed report under artifacts/, and use worker_result_submit with approve or request_changes. Do not implement fixes.${instructions ? `\n\nParent instructions:\n${instructions}` : ""}`; }
function integrationPrompt(preparedId: string, instructions?: string): string { return `Resolve the complete prepared set ${preparedId}. Read integration/context.json, preserve target/candidate histories, resolve every conflict, commit clean results, test them, and report all repositories with worker_result_submit. Do not mutate authoritative targets.${instructions ? `\n\nParent instructions:\n${instructions}` : ""}`; }
function provisionReviewWorkspace(workerId: string, workspace: string, sourceWorker: any, sourceRun: WorkerRunRecord, inputs?: string[]): void {
  const reviewRoot = path.join(workspace, "review"); mkdirSync(reviewRoot, { recursive: true });
  const contextFile = path.join(reviewRoot, "context.json");
  const mappedInputs = (inputs ?? []).map((source, index) => ({ source: realpathSync(path.resolve(source)), path: `/review/inputs/${String(index + 1).padStart(2, "0")}-${path.basename(source)}` }));
  const context = { version: 1, reviewedWorkerId: sourceWorker.workerId, reviewedRunId: sourceRun.runId, role: sourceWorker.role, subjectPath: "/review/subject", session: { path: sourceWorker.sessionFile, startLine: sourceRun.sessionStartLine, endLine: sourceRun.sessionEndLine }, repositories: sourceRun.repositories, artifacts: sourceRun.artifacts, additionalInputs: mappedInputs };
  writeFileSync(contextFile, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400 });
  const overlay = createReviewOverlay({ dockerPath: resolveDockerPath(), workerId, subjectWorkspace: sourceWorker.workspaceRoot, reviewerWorkspace: workspace, contextFile, additionalInputs: inputs });
  const paths = workerPaths(defaultWorkerRoots(), workerId); const record = readWorkerRecord(paths.recordFile); writeWorkerRecord(paths.recordFile, { ...record, reviewOverlay: overlay });
}
function provisionIntegrationWorkspace(parent: string, preparedId: string, workerId: string, workspace: string, inputs?: string[]): void { const set = consumePreparedMergeSet(parent, preparedId, workerId, workspace); const context = { version: 1, preparedId, status: set.status, order: set.order, repositories: set.repositories, additionalInputs: externalInputMappings(inputs) }; const integrationRoot = path.join(workspace, "integration"); mkdirSync(integrationRoot, { recursive: true }); const contextFile = path.join(integrationRoot, "context.json"); writeFileSync(contextFile, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o400 }); const paths = workerPaths(defaultWorkerRoots(), workerId); const record = readWorkerRecord(paths.recordFile); writeWorkerRecord(paths.recordFile, { ...record, additionalInputMounts: [...(record.additionalInputMounts ?? []), { kind: "bind", source: workspace, target: "/workspace" }, { kind: "bind", source: contextFile, target: "/integration/context.json", readOnly: true }] }); }
function updateIntegrationContext(workspace: string, inputs?: string[]): void {
  const file = path.join(workspace, "integration", "context.json");
  const context = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  context.additionalInputs = externalInputMappings(inputs);
  chmodSync(file, 0o600); writeFileSync(file, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 }); chmodSync(file, 0o400);
}
function externalInputMappings(inputs?: string[]): Array<{ source: string; path: string }> { return (inputs ?? []).map((value) => { const exact = realpathSync(path.resolve(value)); const metadata = lstatSync(exact); if (!metadata.isFile() && !metadata.isDirectory()) throw new Error(`Additional input must be a regular file or directory: ${value}`); return { source: exact, path: exact }; }); }
function externalInputMounts(inputs?: string[]) { return externalInputMappings(inputs).map((item) => ({ kind: "bind" as const, source: item.source, target: item.path, readOnly: true })); }
function managedCandidateWarnings(registry: WorkerRegistry) { return (candidateRepo: string, candidateCommit: string) => { const workers = registry.database.prepare("SELECT worker_id,workspace_root,latest_run_id,status FROM workers").all() as Array<{ worker_id: string; workspace_root: string; latest_run_id: string | null; status: string }>; const source = workers.find((worker) => { const relative = path.relative(worker.workspace_root, candidateRepo); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`); }); if (!source) return {}; const runs = registry.database.prepare("SELECT run_id,repositories_json FROM runs WHERE worker_id=? AND status='settled'").all(source.worker_id) as Array<{ run_id: string; repositories_json: string }>; const matched = runs.find((run) => (JSON.parse(run.repositories_json) as any[]).some((repo) => repo.commit === candidateCommit)); const latest = matched?.run_id === source.latest_run_id; const warnings = [...(!matched ? ["Candidate is inside a managed-worker workspace but was not reported by a completed run."] : !latest ? [`Candidate belongs to historical run ${matched.run_id}; latest is ${source.latest_run_id}.`] : []), ...(source.status !== "idle" ? ["Source worker has a newer active run that may supersede this candidate."] : [])]; return { source: { workerId: source.worker_id, ...(matched ? { runId: matched.run_id } : {}), latest }, ...(warnings.length ? { warnings } : {}) }; }; }
