import { execFileSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { asyncJobOutputBytes, createAsyncJobId, isAsyncJobProcessAlive, isAsyncJobProcessGroupAlive, signalAsyncJobProcessGroup } from "../_shared/async-job.js";
import {
  createWorkerContainer,
  parkWorkerContainer,
  planWorkerContainer,
  resolveDockerPath,
  settleWorkerContainer,
  type WorkerContainerReference
} from "../_shared/worker-container.js";
import { throwIfAborted } from "../_shared/cancellation.js";
import {
  CompletionDeliverySchema,
  resolveCompletionDelivery
} from "../_shared/completion-delivery.js";
import { resolveExecutable } from "../_shared/executable.js";
import { formatModelName, resolveExtensionModel } from "../_shared/model-spec.js";
import { MAX_WORKER_TASK_IDS } from "../_shared/worker-contract.js";
import { isWorkerId, WORKER_ID_PATTERN } from "../_shared/worker-id.js";
import { RetainedToolOutputSchemas } from "../_shared/tool-output.js";
import { runIndependentReview, type IndependentReviewInput, type ReviewDetails, type ReviewGitContext } from "../review-subagent/index.js";
import { inputJsonSchemaGuideline, outputJsonSchemaGuideline } from "../_shared/tool-prompt.js";
import { managedWorkerRoleSkillText } from "../_shared/role-skills.js";
import { cancelPersistedAsyncShellJobsForOwner, handleAsyncShellViewerCommand, type JobMeta, type ManagedAsyncJobHandle } from "../async-shell/index.js";
import {
  defaultWorkerFoldsRoot,
  prepareRepositoryChangeSet,
  readPreparedWorkerFold,
  type PreparedRepositoryFold,
  type PreparedWorkerFoldSummary,
  type RepositoryChangeSet
} from "./folds.js";
import {
  assertIntegrationPristine,
  assertIntegrationRecordLayout,
  assertPreparedTargetCurrent,
  normalizeIntegrationContext,
  persistIntegrationEnvelope,
  provisionIntegrationRepository,
  validateIntegrationHandoffShape,
  validateStoppedIntegrationHandoff,
  verifyIntegrationArtifact,
  INTEGRATION_CONTEXT_KEYS,
  type IntegrationContextBundle,
  type NormalizedIntegrationContextBundle
} from "./integration.js";
import { launchWorkerHost, readWorkerHostProcess, readWorkerHostSettlement } from "./runner.js";
import { readWorkerRuntimeHandoff, type AcceptedWorkerHandoff } from "./runtime.js";
import {
  createGitRunner,
  deriveRepositoryInventory,
  gitText,
  persistRepositoryInventory,
  pinInitialRepositories,
  readRepositoryInventory,
  repositoryDirty,
  repositoryPolicyIssues,
  type InitialRepositoryPin,
  type RepositoryIntegrationLineage,
  type RepositoryInventory,
  type RepositoryInventorySummary
} from "./repositories.js";
import { forkWorkerSession, verifyWorkerSession } from "./session.js";
import { readWorkerSettings } from "./settings.js";
import {
  WORKER_RECORD_VERSION,
  acquireWorkerLease,
  acquireWorkerOperationLock,
  createWorkerId,
  createWorkerRunId,
  defaultWorkerRoots,
  provisionWorkerPaths,
  readWorkerLease,
  readWorkerRecord,
  releaseWorkerLease,
  releaseWorkerOperationLock,
  workerPaths,
  writeWorkerRecord,
  type WorkerIntegrationRecord,
  type WorkerLease,
  type WorkerPaths,
  type WorkerRecord,
  type WorkerRoots,
  type WorkerRoute
} from "./state.js";

const WORKER_OPERATIONAL_GUIDANCE = "Keep all writes inside the private workspace. Clone or create every Git repository under the workspace repos/ directory, report it as repos/<name>, use --no-hardlinks for local clones, and do not push remotes. Use worker_task_read to search or read bounded context across central Beads; returned records mark your assigned IDs. Use worker_task_update rather than shell access for notes or status changes, and update only assigned IDs. Shell commands run inside one private Docker container with all of ~/Code read-only and this workspace read-write. Process groups provide normal per-command cancellation; whole-container removal is the final run cleanup boundary. Use normal async-shell tools. Before worker_handoff, inspect every owned job: wait for work that should finish or cancel work that should stop, then verify terminal status with shell_status or shell_read. Finish with exactly one accepted worker_handoff only after every owned job is settled.";

const InitialRepoSchema = Type.Object({
  source: Type.String({ minLength: 1, maxLength: 2048 }),
  revision: Type.Optional(Type.String({ minLength: 1, maxLength: 256 }))
}, { additionalProperties: false });

const NewWorkerRunSchema = Type.Object({
  kind: Type.Literal("new"),
  taskIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: MAX_WORKER_TASK_IDS }),
  guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 12_000 })),
  route: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 512,
    description: "Override the configured default provider/model/thinking route for this new worker."
  })),
  completionDelivery: Type.Optional(CompletionDeliverySchema),
  initialRepos: Type.Optional(Type.Array(InitialRepoSchema, { maxItems: 16 }))
}, { additionalProperties: false });

const ResumeWorkerRunSchema = Type.Object({
  kind: Type.Literal("resume"),
  workerId: Type.String({ minLength: 1, maxLength: 128 }),
  message: Type.String({ minLength: 1, maxLength: 12_000 }),
  addTaskIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: MAX_WORKER_TASK_IDS })),
  completionDelivery: Type.Optional(CompletionDeliverySchema)
}, { additionalProperties: false });

export const WorkerRunParams = Type.Object({
  runs: Type.Array(Type.Union([NewWorkerRunSchema, ResumeWorkerRunSchema]), {
    minItems: 1,
    maxItems: 8
  })
}, { additionalProperties: false });

const WorkerIdSchema = Type.String({
  minLength: 30,
  maxLength: 128,
  pattern: WORKER_ID_PATTERN
});

const IntegrationStringListSchema = Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 32 });
const IntegrationContextSchema = Type.Object({ ...Object.fromEntries(INTEGRATION_CONTEXT_KEYS.filter((key) => key !== "evidencePaths").map((key) => [key, IntegrationStringListSchema])), evidencePaths: Type.Optional(IntegrationStringListSchema) }, { additionalProperties: false });
const WorkerFoldResolveStartSchema = Type.Object({
  kind: Type.Literal("start"), preparedId: Type.String({ pattern: "^prepared_[0-9a-f]{24}$" }), manifestSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }), candidateId: Type.String({ pattern: "^candidate_[0-9a-f]{24}$" }),
  taskIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: MAX_WORKER_TASK_IDS }), context: IntegrationContextSchema,
  route: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), completionDelivery: Type.Optional(CompletionDeliverySchema)
}, { additionalProperties: false });
const WorkerFoldResolveResumeSchema = Type.Object({
  kind: Type.Literal("resume"), workerId: WorkerIdSchema, message: Type.String({ minLength: 1, maxLength: 12000 }),
  settledDecisions: Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { minItems: 1, maxItems: 32 }), completionDelivery: Type.Optional(CompletionDeliverySchema)
}, { additionalProperties: false });
export const WorkerFoldResolveParams = Type.Object({ request: Type.Union([WorkerFoldResolveStartSchema, WorkerFoldResolveResumeSchema]) }, { additionalProperties: false });

export const WorkerControlParams = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("result"),
    Type.Literal("cancel"),
    Type.Literal("discard")
  ]),
  workerId: Type.Optional(WorkerIdSchema),
  confirm: Type.Optional(Type.Literal(true))
}, { additionalProperties: false });

export const WorkerReviewParams = Type.Object({
  workerId: WorkerIdSchema,
  runId: Type.String({ minLength: 1, maxLength: 128, pattern: "^run_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" }),
  workspaceRepo: Type.String({ minLength: 7, maxLength: 1024, pattern: "^repos/[A-Za-z0-9._/-]+$" }),
  focus: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 }))
}, { additionalProperties: false });

const RepositoryChangeSetEntrySchema = Type.Object({
  candidateId: Type.String({ minLength: 34, maxLength: 34, pattern: "^candidate_[0-9a-f]{24}$" }),
  targetRepo: Type.String({ minLength: 1, maxLength: 1024, description: "Absolute existing local target repository below the accepted local target root (~/Code by default)." }),
  targetRef: Type.String({ minLength: 12, maxLength: 251, pattern: "^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$" }),
  purpose: Type.String({ minLength: 1, maxLength: 2000 }),
  method: Type.Union([Type.Literal("merge"), Type.Literal("squash")]),
  dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 34, maxLength: 34, pattern: "^candidate_[0-9a-f]{24}$" }), { maxItems: 16 }))
}, { additionalProperties: false });

export const WorkerFoldPrepareParams = Type.Object({
  repositories: Type.Array(RepositoryChangeSetEntrySchema, { minItems: 1, maxItems: 16 })
}, { additionalProperties: false });

export type WorkerRunInput = Static<typeof WorkerRunParams>;
export type WorkerControlInput = Static<typeof WorkerControlParams>;
export type WorkerReviewInput = Static<typeof WorkerReviewParams>;
export type WorkerFoldPrepareInput = Static<typeof WorkerFoldPrepareParams>;
export type WorkerFoldResolveRequest =
  | { kind: "start"; preparedId: string; manifestSha256: string; candidateId: string; taskIds: string[]; context: IntegrationContextBundle; route?: string; completionDelivery?: "steer" | "followUp" }
  | { kind: "resume"; workerId: string; message: string; settledDecisions: string[]; completionDelivery?: "steer" | "followUp" };
export type WorkerFoldResolveInput = { request: WorkerFoldResolveRequest };
export type WorkerRunReceipt = {
  workerId: string;
  runId: string;
  jobId: string;
  sessionId: string;
  sessionFile?: string;
  workspaceRoot: string;
  taskIds: string[];
  provider: string;
  model: string;
  thinkingLevel: string;
  completionDelivery: "steer" | "followUp";
  state: "queued" | "running";
};

type WorkerRunDetails = { runs: WorkerRunReceipt[] };
type WorkerReviewDetails = {
  workerId: string;
  runId: string;
  candidateId: string;
  workspaceRepo: string;
  headCommit: string;
  headTree: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  toolCallCount: number;
  critique: string;
};
type WorkerFoldResolveDetails = WorkerRunReceipt & {
  phase: "analysis" | "resolution";
  method: "merge" | "squash";
  preparedId: string;
  manifestSha256: string;
  candidateId: string;
  contextSha256: string;
  decisionsSha256?: string;
};

type WorkerControlSummary = {
  workerId: string;
  status: WorkerRecord["status"];
  sessionId: string;
  sessionFile?: string;
  workspaceRoot: string;
  taskIds: string[];
  route: WorkerRoute;
  integration?: { phase: "analysis" | "resolution"; method: "merge" | "squash"; preparedId: string; manifestSha256: string; candidateId: string; sourceCandidateIds: string[]; workspaceRepo: string; targetRepo: string; targetRef: string; targetExpectedCommit: string; candidateHeadCommit: string; contextSha256: string; analysisRunId: string; decisionsSha256?: string; resolutionRunId?: string };
  container?: { name: string; containerId?: string; runId: string };
  activeRun?: {
    runId: string;
    jobId: string;
    status: "queued" | "running";
    completionDelivery: "steer" | "followUp";
    recoveryError?: string;
    stdoutLog?: string;
    stderrLog?: string;
  };
  lastRun?: {
    runId: string;
    jobId: string;
    status: "handed_off" | "failed" | "cancelled";
    delivery?: "pending" | "delivered";
    completionDelivery: "steer" | "followUp";
    resultFile?: string;
    stdoutLog?: string;
    stderrLog?: string;
    error?: string;
    repositoryInventory?: RepositoryInventorySummary;
    repositoryError?: string;
  };
  updatedAt: string;
};

type WorkerControlDetails =
  | { action: "status"; workers: WorkerControlSummary[] }
  | {
      action: "result";
      workerId: string;
      runId: string;
      jobId: string;
      status: "handed_off" | "failed" | "cancelled";
      delivery?: "pending" | "delivered";
      completionDelivery: "steer" | "followUp";
      sessionId: string;
      workspaceRoot: string;
      taskIds: string[];
      route: WorkerRoute;
      integration?: WorkerControlSummary["integration"];
      resultFile?: string;
      stdoutLog?: string;
      stderrLog?: string;
      error?: string;
      handoff?: AcceptedWorkerHandoff;
      repositories?: RepositoryInventory;
      repositoryError?: string;
      acknowledgedDelivery: boolean;
    }
  | {
      action: "cancel";
      workerId: string;
      outcome: "cancelled" | "not_active";
      status: WorkerRecord["status"];
      runId?: string;
      jobId?: string;
    }
  | { action: "discard"; workerId: string; discarded: true };

type PlannedWorkerRun =
  | {
      kind: "new";
      input: Static<typeof NewWorkerRunSchema>;
      parentSessionFile: string;
      route: WorkerRoute;
      taskIds: string[];
      integrationStart?: { preparedId: string; manifestSha256: string; candidateId: string; context: NormalizedIntegrationContextBundle; repository: PreparedRepositoryFold };
    }
  | {
      kind: "resume";
      input: Static<typeof ResumeWorkerRunSchema>;
      parentSessionFile: string;
      paths: WorkerPaths;
      existing: WorkerRecord;
      integrationResume?: { decisions: string[] };
    };

type WorkerLaunchRequest = {
  record: WorkerRecord;
  paths: WorkerPaths;
  prompt: string;
  resultFile: string;
  runDir: string;
  parentContextSnapshot?: string;
  processFile: string;
  processNonce: string;
  jobId: string;
  container?: WorkerContainerReference;
};

type ManagedWorkerHandle = ManagedAsyncJobHandle & { container?: WorkerContainerReference };

class WorkerContainerCleanupError extends AggregateError {}

type WorkerExtensionDependencies = {
  roots: WorkerRoots;
  now(): Date;
  random(): string;
  pinRepositories(requested: readonly { source: string; revision?: string }[], trustedStateRoot: string): InitialRepositoryPin[];
  foldsRoot: string;
  targetRoot: string;
  prepareFold: typeof prepareRepositoryChangeSet;
  reviewWorker(api: Pick<ExtensionAPI, "exec" | "getAllTools">, context: ExtensionContext, input: IndependentReviewInput): Promise<ReviewDetails>;
  planContainer?(record: WorkerRecord, runId: string, nonce: string): WorkerContainerReference;
  parkContainer?(container: WorkerContainerReference): void;
  removeContainer(container: WorkerContainerReference): void;
  launch(api: ExtensionAPI, context: ExtensionContext, request: WorkerLaunchRequest): ManagedWorkerHandle;
};

type PendingWorkerRun = {
  runId: string;
  parentSessionId: string;
  parentSessionFile: string;
  recordFile: string;
  paths: WorkerPaths;
  prompt: string;
  resultFile: string;
  runDir: string;
  parentContextSnapshot?: string;
  processFile: string;
  processNonce: string;
  kind: "new" | "resume";
};

export default function workerExtension(api: ExtensionAPI): void {
  registerWorkerExtension(api);
}

export function registerWorkerExtension(
  api: ExtensionAPI,
  overrides: Partial<WorkerExtensionDependencies> = {}
): void {
  const defaults = defaultDependencies();
  const dependencies: WorkerExtensionDependencies = { ...defaults, ...overrides };
  if (overrides.roots && !overrides.foldsRoot) dependencies.foldsRoot = defaultWorkerFoldsRoot(overrides.roots.stateRoot);
  if (overrides.launch && !overrides.planContainer) dependencies.planContainer = undefined;
  const pending = new Map<string, PendingWorkerRun>();
  const active = new Map<string, { runId: string; handle: ManagedWorkerHandle }>();
  const monitors = new Map<string, NodeJS.Timeout>();

  api.on("session_start", async (_event, context) => {
    await adoptWorkerRuns(api, context, dependencies, active, monitors);
  });
  api.on("session_shutdown", () => {
    for (const monitor of monitors.values()) clearInterval(monitor);
    monitors.clear();
  });

  api.registerCommand("worker:list", {
    description: "List active managed workers owned by the current chat; pass --all to include settled workers",
    handler: async (args, context) => {
      const option = args.trim();
      if (option !== "" && option !== "--all") {
        context.ui.notify("Usage: /worker:list [--all]", "info");
        return;
      }
      const records = listParentWorkerRecords(dependencies.roots, context);
      const showAll = option === "--all";
      const selected = showAll ? records : records.filter(isActiveWorkerRecord);
      context.ui.notify(formatWorkerList(selected, { showAll, totalCount: records.length }), "info");
    }
  });

  api.registerCommand("worker:status", {
    description: "Show one managed worker's exact session, workspace, route, tasks, and active/last run state",
    handler: async (args, context) => {
      const workerId = args.trim();
      if (!workerId) {
        context.ui.notify("Usage: /worker:status <worker-id>", "info");
        return;
      }
      const record = readParentWorkerRecord(dependencies.roots, workerId, context);
      context.ui.notify(formatWorkerRecord(record), "info");
    }
  });

  api.registerCommand("worker:view", {
    description: "Open the bounded provider-free async log viewer for one managed worker's active or last run",
    handler: async (args, context) => {
      const [workerId, ...viewerArgs] = args.trim().split(/\s+/).filter(Boolean);
      if (!workerId) {
        context.ui.notify("Usage: /worker:view <worker-id> [--stream both|stdout|stderr] [--tail 1..500] [--follow]", "info");
        return;
      }
      const record = readWorkerRecord(workerPaths(dependencies.roots, workerId).recordFile);
      assertWorkerParentSession(record, context);
      const jobId = record.activeRun?.jobId ?? record.lastRun?.jobId;
      if (!jobId) {
        context.ui.notify(`Worker ${workerId} has no run logs.`, "info");
        return;
      }
      await handleAsyncShellViewerCommand(context, [jobId, ...viewerArgs].join(" "));
    }
  });

  api.registerCommand("worker:ack", {
    description: "Explicitly acknowledge one settled worker completion whose automatic same-session delivery remained uncertain",
    handler: async (args, context) => {
      const workerId = args.trim();
      if (!workerId) {
        context.ui.notify("Usage: /worker:ack <worker-id>", "info");
        return;
      }
      const paths = workerPaths(dependencies.roots, workerId);
      const record = readWorkerRecord(paths.recordFile);
      assertWorkerParentSession(record, context);
      const runId = record.lastRun?.runId;
      if (!runId || record.lastRun?.delivery !== "pending") {
        context.ui.notify(`Worker ${workerId} has no pending completion delivery.`, "info");
        return;
      }
      markWorkerCompletionDelivered(paths, runId, dependencies);
      context.ui.notify(`Acknowledged worker completion ${workerId}/${runId}.`, "info");
    }
  });

  api.registerCommand("worker:discard", {
    description: "Permanently remove one settled managed worker's private workspace and durable runtime record",
    handler: async (args, context) => {
      const [workerId, confirmation, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (!workerId || confirmation !== "--confirm" || extra.length > 0) {
        context.ui.notify("Usage: /worker:discard <worker-id> --confirm", "info");
        return;
      }
      const discarded = discardParentWorker(workerId, context, dependencies);
      context.ui.notify(
        discarded ? `Discarded settled worker ${workerId}.` : `Worker ${workerId} became active before discard; cancel it first.`,
        discarded ? "info" : "warning"
      );
    }
  });

  api.registerCommand("worker:cancel", {
    description: "Cancel one exact active managed worker run and its owned async-shell process groups",
    handler: async (args, context) => {
      const workerId = args.trim();
      if (!workerId) {
        context.ui.notify("Usage: /worker:cancel <worker-id>", "info");
        return;
      }
      const outcome = await cancelParentWorker(api, workerId, context, dependencies, pending, active, true);
      context.ui.notify(
        outcome === "not_active" ? `Worker ${workerId} has no active run.` : `Cancelled ${outcome} worker ${workerId}.`,
        "info"
      );
    }
  });

  api.registerTool(defineTool({
    name: "worker_control",
    label: "Worker Control",
    description: "Inspect and manage durable workers owned by this exact parent session. Status can list session workers or inspect one worker. Result returns the validated typed last handoff plus any hash-bound repository candidate inventory and acknowledges pending completion delivery only after both validate. Cancel performs authoritative run cleanup. Discard permanently removes one settled worker after explicit confirmation.",
    promptSnippet: "Inspect exact-session workers, read and acknowledge typed results, cancel active runs, or discard settled workers with one worker_control action.",
    promptGuidelines: [
      "worker_control use: Use status to list or inspect exact-session workers and repository candidate summaries; result to retrieve a settled typed handoff plus exact candidate inventory and acknowledge pending delivery; cancel for authoritative active-run cleanup; discard only for an intentionally retired settled worker.",
      inputJsonSchemaGuideline("worker_control", WorkerControlParams),
      outputJsonSchemaGuideline("worker_control", RetainedToolOutputSchemas.worker_control),
      "worker_control constraints: Every action is restricted to the exact parent session. Result retrieval validates worker/run identity and any durable repository inventory before acknowledging delivery. Cancel and discard reuse trusted lifecycle operations; cleanup uncertainty fails closed. Discard requires confirm:true and is permanent. Use shell_read with a returned job ID for logs. Only result content is provider-visible; details are internal."
    ],
    parameters: WorkerControlParams,
    renderCall(args, theme) {
      return renderWorkerControlCall(args as WorkerControlInput, theme);
    },
    renderResult(result, options, theme, context) {
      return renderWorkerControlResult(result as AgentToolResult<WorkerControlDetails>, options, theme, context);
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, context): Promise<AgentToolResult<WorkerControlDetails>> {
      throwIfAborted(signal);
      if (params.action !== "discard" && params.confirm !== undefined) {
        throw new Error(`worker_control ${params.action} does not accept confirm.`);
      }
      if (params.action === "status") {
        const records = params.workerId
          ? [readParentWorkerRecord(dependencies.roots, params.workerId, context)]
          : listParentWorkerRecords(dependencies.roots, context);
        if (records.length > 100) {
          throw new Error(`This parent session owns ${records.length} workers; worker_control status is limited to 100. Inspect one workerId at a time.`);
        }
        const workers = records.map(workerControlSummary);
        return {
          content: [{
            type: "text",
            text: workers.length > 0
              ? params.workerId
                ? formatWorkerRecord(records[0]!)
                : formatWorkerList(records, { showAll: true, totalCount: records.length })
              : "No managed workers belong to this parent session."
          }],
          details: { action: "status", workers }
        };
      }
      const workerId = params.workerId;
      if (!workerId) throw new Error(`worker_control ${params.action} requires workerId.`);
      if (params.action === "result") {
        const result = readParentWorkerResult(workerId, context, dependencies);
        const lastRun = result.record.lastRun;
        if (!lastRun) throw new Error(`Worker ${params.workerId} has no settled result.`);
        return {
          content: [{ type: "text", text: formatWorkerControlResult(result.record, result.handoff) }],
          details: {
            action: "result",
            workerId: result.record.workerId,
            runId: lastRun.runId,
            jobId: lastRun.jobId,
            status: lastRun.status,
            delivery: lastRun.delivery,
            completionDelivery: resolveCompletionDelivery(lastRun.completionDelivery),
            sessionId: result.record.sessionId,
            workspaceRoot: result.record.workspaceRoot,
            taskIds: [...result.record.taskIds],
            route: { ...result.record.route },
            integration: integrationSummary(result.record.integration),
            resultFile: lastRun.resultFile,
            stdoutLog: lastRun.stdoutLog,
            stderrLog: lastRun.stderrLog,
            error: lastRun.error,
            handoff: result.handoff,
            repositories: result.repositories,
            repositoryError: lastRun.repositoryError,
            acknowledgedDelivery: result.acknowledgedDelivery
          }
        };
      }
      if (params.action === "cancel") {
        const outcome = await cancelParentWorker(api, workerId, context, dependencies, pending, active, false);
        const record = readParentWorkerRecord(dependencies.roots, workerId, context);
        return {
          content: [{ type: "text", text: outcome === "not_active" ? `Worker ${workerId} has no active run.\n\n${formatWorkerRecord(record)}` : `Cancelled ${outcome} worker ${workerId}.\n\n${formatWorkerRecord(record)}` }],
          details: {
            action: "cancel",
            workerId: record.workerId,
            outcome: outcome === "not_active" ? "not_active" : "cancelled",
            status: record.status,
            runId: record.activeRun?.runId ?? record.lastRun?.runId,
            jobId: record.activeRun?.jobId ?? record.lastRun?.jobId
          }
        };
      }
      if (params.confirm !== true) throw new Error("worker_control discard requires confirm:true.");
      const discarded = discardParentWorker(workerId, context, dependencies);
      if (!discarded) throw new Error(`Worker ${workerId} became active before discard; cancel it first.`);
      return {
        content: [{ type: "text", text: `Discarded settled worker ${workerId}.` }],
        details: { action: "discard", workerId, discarded: true }
      };
    }
  }));


  api.registerTool(defineTool({
    name: "worker_review",
    label: "Worker Review",
    description: "Review one clean, settled managed-worker repository in its exact parked workspace with an independent read-only agent. Use after an implementation or correction handoff. Do not use while the worker is active, to change code, or as promotion authority.",
    promptSnippet: "Independently review one exact clean repository from a settled managed worker; never modifies or promotes it.",
    promptGuidelines: [
      "worker_review use: Call after worker_control result for the exact worker/run/repository; if review requests changes, resume the implementation worker and review the new settled run again.",
      inputJsonSchemaGuideline("worker_review", WorkerReviewParams),
      outputJsonSchemaGuideline("worker_review", RetainedToolOutputSchemas.worker_review),
      "worker_review constraints: Requires an exact-parent-owned handed-off run, valid handoff/inventory, parked container, and clean foldable candidate. The worker operation lock stays held throughout review. The reviewer has read-only tools and no human prompt, implementation, attestation, validation authority, promotion, or push capability. Repository HEAD/tree/clean policy are rechecked after review; drift fails visibly. Only result content is provider-visible; details are internal."
    ],
    parameters: WorkerReviewParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, context): Promise<AgentToolResult<WorkerReviewDetails>> {
      throwIfAborted(signal);
      const details = await reviewSettledWorker(api, context, params as WorkerReviewInput, signal, dependencies);
      return {
        content: [{ type: "text", text: formatWorkerReviewResult(details) }],
        details
      };
    }
  }));

  api.registerTool(defineTool({
    name: "worker_fold_prepare",
    label: "Worker Fold Prepare",
    description: "Prepare an exact multi-repository worker changeset outside authoritative repositories. Select durable repository candidate IDs and map each to one explicit existing local target repository/ref, purpose, merge or squash method, and candidate dependencies. The trusted host locks selected workers, revalidates exact candidate and target identities, computes deterministic desired commits or bounded resolution cases, materializes disposable views plus immutable exact-object artifacts, and persists one hash-bound manifest without updating authoritative refs, indexes, worktrees, or files.",
    promptSnippet: "Prepare selected durable worker repository candidates as an exact external multi-repository changeset without modifying authoritative targets.",
    promptGuidelines: [
      "worker_fold_prepare use: Call only after inspecting worker_control result/status evidence and deciding the semantic candidate-to-target mapping, method, purpose, and dependency DAG. Use fully qualified existing refs/heads/... targets.",
      inputJsonSchemaGuideline("worker_fold_prepare", WorkerFoldPrepareParams),
      outputJsonSchemaGuideline("worker_fold_prepare", RetainedToolOutputSchemas.worker_fold_prepare),
      "worker_fold_prepare constraints: Preparation is deterministic and model-free. It holds selected worker lifecycle locks and rejects active runs/leases; revalidates hash-bound candidate inventories, exact commit trees, target cleanliness and policy, and dependency order; creates only external owner-private exact-object bundles, disposable views, and manifests; synchronous Git work is not interruptible after it starts; never updates target refs, indexes, worktrees, remotes, or files. Conflicts become resolution_required cases. Promotion, review, validation, pushing, release, and conflict resolution are separate parent-owned operations. Only result content is provider-visible; details are internal."
    ],
    parameters: WorkerFoldPrepareParams,
    renderCall(args, theme) {
      return renderWorkerFoldPrepareCall(args as WorkerFoldPrepareInput, theme);
    },
    renderResult(result, options, theme, context) {
      return renderWorkerFoldPrepareResult(result as AgentToolResult<PreparedWorkerFoldSummary>, options, theme, context);
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, context): Promise<AgentToolResult<PreparedWorkerFoldSummary>> {
      throwIfAborted(signal);
      const parentSessionFile = context.sessionManager.getSessionFile();
      if (!parentSessionFile) throw new Error("worker_fold_prepare requires a persisted parent session.");
      const changeSet: RepositoryChangeSet = {
        repositories: params.repositories.map((item) => ({
          candidateId: item.candidateId,
          targetRepo: item.targetRepo,
          targetRef: item.targetRef,
          purpose: item.purpose,
          method: item.method,
          dependsOn: [...(item.dependsOn ?? [])]
        }))
      };
      const { summary } = withLockedParentFoldCandidates(changeSet, context, dependencies, (candidates) => {
        throwIfAborted(signal);
        return dependencies.prepareFold({
          changeSet,
          candidates,
          parentSessionFile,
          foldsRoot: dependencies.foldsRoot,
          targetRoot: dependencies.targetRoot,
          createdAt: dependencies.now().toISOString()
        });
      });
      return {
        content: [{ type: "text", text: formatWorkerFoldPrepareSummary(summary) }],
        details: summary
      };
    }
  }));

  api.registerTool(defineTool({
    name: "worker_fold_resolve",
    label: "Worker Fold Resolve",
    description: "Start or resume an explicit two-phase managed integration worker for one exact resolution_required prepared repository. Start persists a parent-curated immutable IntegrationContextBundle and provisions exact target/candidate inputs for analysis-only checkpointing. Resume keeps the exact session/workspace/route, adds immutable settled decisions, and permits committed resolution work. No hidden model call, promotion, review, validation, or authoritative target mutation occurs.",
    promptSnippet: "Start an analysis-only integration worker for one exact prepared conflict, or resume that exact worker with settled parent decisions.",
    promptGuidelines: [
      "worker_fold_resolve use: start binds preparedId/hash/candidateId, assigned task IDs, route, and a complete bounded parent-curated context; resume the returned worker only after reading its checkpoint or needs_input handoff and settling decisions.",
      inputJsonSchemaGuideline("worker_fold_resolve", WorkerFoldResolveParams),
      outputJsonSchemaGuideline("worker_fold_resolve", RetainedToolOutputSchemas.worker_fold_resolve),
      "worker_fold_resolve constraints: Analysis is immutable and may hand off only checkpoint or needs_input. Resolution is an exact-session resume with immutable decisions and may hand off only completed states. Moved targets, tampered prepared/context state, repository mutation during analysis, generic resume, credentials, push, implicit rebase, review, validation, and promotion fail closed. Only result content is provider-visible; details are internal."
    ],
    parameters: WorkerFoldResolveParams,
    renderCall(args, theme) { return renderWorkerFoldResolveCall(args as WorkerFoldResolveInput, theme); },
    renderResult(result, options, theme, context) { return renderWorkerFoldResolveResult(result as AgentToolResult<WorkerFoldResolveDetails>, options, theme, context); },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, context): Promise<AgentToolResult<WorkerFoldResolveDetails>> {
      throwIfAborted(signal);
      assertWorkerFoldResolveInput(params);
      const request = params.request as WorkerFoldResolveRequest;
      const parentSessionFile = context.sessionManager.getSessionFile();
      if (!parentSessionFile) throw new Error("worker_fold_resolve requires a persisted parent session.");
      let plan: PlannedWorkerRun;
      if (request.kind === "start") {
        validatePersonalTaskIds(request.taskIds);
        const manifest = readPreparedWorkerFold(dependencies.foldsRoot, request.preparedId, parentSessionFile);
        if (manifest.manifestSha256 !== request.manifestSha256) throw new Error("Prepared integration manifest hash mismatch.");
        const repository = manifest.repositories.find((item) => item.candidateId === request.candidateId);
        if (!repository || repository.status !== "resolution_required") throw new Error("worker_fold_resolve start requires one resolution_required prepared repository.");
        plan = {
          kind: "new",
          input: { kind: "new", taskIds: [...request.taskIds], route: request.route, completionDelivery: request.completionDelivery },
          parentSessionFile: path.resolve(parentSessionFile),
          route: resolveWorkerRoute(request.route, context),
          taskIds: uniqueStrings(request.taskIds),
          integrationStart: {
            preparedId: manifest.preparedId,
            manifestSha256: manifest.manifestSha256,
            candidateId: request.candidateId,
            context: normalizeIntegrationContext(request.context, dependencies.targetRoot),
            repository
          }
        };
      } else {
        const paths = workerPaths(dependencies.roots, request.workerId);
        const existing = readWorkerRecord(paths.recordFile);
        assertWorkerParentSession(existing, context);
        if (!existing.integration || existing.integration.phase !== "analysis") throw new Error("worker_fold_resolve resume requires a settled analysis integration worker.");
        if (existing.status !== "handed_off" || existing.lastRun?.status !== "handed_off" || existing.lastRun.runId !== existing.integration.analysisRunId) throw new Error("worker_fold_resolve resume requires the exact successful analysis handoff.");
        if (existing.activeRun || existing.lastRun?.delivery === "pending") throw new Error("Integration analysis result must be settled and acknowledged before resume.");
        if (!existing.sessionFile) throw new Error("Integration worker has no exact session to resume.");
        const handoff = existing.lastRun?.resultFile ? readMatchingWorkerHandoff(existing.lastRun.resultFile, existing.workerId, existing.lastRun.runId) : undefined;
        if (!handoff || (handoff.handoff.state !== "checkpoint" && handoff.handoff.state !== "needs_input")) throw new Error("Integration analysis did not produce a checkpoint or needs_input handoff.");
        verifyWorkerSession({ sessionFile: existing.sessionFile, sessionId: existing.sessionId, workspaceRoot: existing.workspaceRoot, parentSessionFile: existing.parentSessionFile });
        plan = {
          kind: "resume",
          input: { kind: "resume", workerId: request.workerId, message: request.message, completionDelivery: request.completionDelivery },
          parentSessionFile: path.resolve(parentSessionFile),
          paths,
          existing,
          integrationResume: { decisions: normalizeSettledDecisions(request.settledDecisions) }
        };
      }
      const receipt = prepareWorkerPlans([plan], context, dependencies, pending)[0]!;
      const record = readWorkerRecord(workerPaths(dependencies.roots, receipt.workerId).recordFile);
      const integration = record.integration!;
      const details: WorkerFoldResolveDetails = {
        ...receipt,
        phase: integration.phase,
        method: integration.method,
        preparedId: integration.preparedId,
        manifestSha256: integration.manifestSha256,
        candidateId: integration.candidateId,
        contextSha256: integration.contextSha256,
        decisionsSha256: integration.decisionsSha256
      };
      const text = formatWorkerFoldResolveReceipt(details);
      onUpdate?.({ content: [{ type: "text", text }], details });
      return { content: [{ type: "text", text }], details };
    }
  }));

  api.registerTool(defineTool({
    name: "worker_run",
    label: "Worker Run",
    description: "Start one or more durable engineering workers or resume exact existing workers. New workers use the configured worker-settings.json default route unless the caller supplies route, receive stable worker/run/job/session/workspace/task identities immediately, then fork the completed parent session after the current turn is durable. Resume always reuses the exact recorded worker session, workspace, provider, model, and thinking route. Worker processes run asynchronously through the shared async-shell job machinery and return typed semantic handoffs when settled.",
    promptSnippet: "Start or resume durable context-rich workers with runs:[...]; returns stable queued receipts immediately and typed asynchronous completion handoffs later.",
    promptGuidelines: [
      "worker_run use: Use worker_run for substantive engineering that benefits from an independent durable agent session and private workspace; use kind=new with assigned Beads and kind=resume for the exact same worker after feedback or a checkpoint. New workers use the worker-settings.json default route unless route explicitly overrides it.",
      inputJsonSchemaGuideline("worker_run", WorkerRunParams),
      outputJsonSchemaGuideline("worker_run", RetainedToolOutputSchemas.worker_run),
      "worker_run constraints: The parent owns grounding, task acceptance, integration, and promotion. A new worker forks the completed current parent turn; a resume cannot change session/workspace/provider/model. Receipts are immediate, process exit is not semantic completion, and cancellation must settle all shell jobs owned by the worker. Only result content is provider-visible; details are internal."
    ],
    parameters: WorkerRunParams,
    renderCall(args, theme) {
      return renderWorkerRunCall(args as WorkerRunInput, theme);
    },
    renderResult(result, options, theme, context) {
      return renderWorkerRunResult(result as AgentToolResult<WorkerRunDetails>, options, theme, context);
    },
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, context): Promise<AgentToolResult<WorkerRunDetails>> {
      throwIfAborted(signal);
      const plans = planWorkerRuns(params.runs, context, dependencies);
      const receipts = prepareWorkerPlans(plans, context, dependencies, pending);
      const formattedReceipts = receipts.map(formatWorkerRunReceipt).join("\n\n");
      onUpdate?.({ content: [{ type: "text", text: formattedReceipts }], details: { runs: receipts } });
      return {
        content: [{ type: "text", text: formattedReceipts }],
        details: { runs: receipts }
      };
    }
  }));

  api.on("turn_end", async (_event, context) => {
    const parentSessionId = context.sessionManager.getSessionId();
    const launches = Array.from(pending.entries()).filter(([, value]) => value.parentSessionId === parentSessionId);
    for (const [runId, value] of launches) {
      pending.delete(runId);
      await startPendingWorker(api, context, value, dependencies, active);
    }
  });

  api.on("message_end", (event, context) => {
    acknowledgeWorkerCompletionMessage(event.message, context, dependencies);
  });
}

function readParentWorkerRecord(
  roots: WorkerRoots,
  workerId: string,
  context: ExtensionContext
): WorkerRecord {
  const record = readWorkerRecord(workerPaths(roots, workerId).recordFile);
  assertWorkerParentSession(record, context);
  return record;
}

async function reviewSettledWorker(
  api: ExtensionAPI,
  context: ExtensionContext,
  input: WorkerReviewInput,
  signal: AbortSignal | undefined,
  dependencies: WorkerExtensionDependencies
): Promise<WorkerReviewDetails> {
  const paths = workerPaths(dependencies.roots, input.workerId);
  const lock = acquireWorkerOperationLock(paths.operationLockFile);
  try {
    throwIfAborted(signal);
    const record = readWorkerRecord(paths.recordFile);
    assertWorkerParentSession(record, context);
    if (record.activeRun || readWorkerLease(paths.leaseFile)) throw new Error(`Worker ${input.workerId} became active before review.`);
    const lastRun = record.lastRun;
    if (record.status !== "handed_off" || !lastRun || lastRun.status !== "handed_off" || lastRun.runId !== input.runId) {
      throw new Error(`worker_review requires exact handed-off run ${input.runId} for worker ${input.workerId}.`);
    }
    const observed = readParentWorkerResult(input.workerId, context, dependencies, true);
    if (observed.record.lastRun?.runId !== input.runId || !observed.handoff || !observed.repositories) {
      throw new Error("worker_review requires a validated typed handoff and repository inventory for the exact run.");
    }
    if (observed.handoff.handoff.state !== "ready_for_review" && observed.handoff.handoff.state !== "assignment_complete") {
      throw new Error(`worker_review requires a completed handoff, not ${observed.handoff.handoff.state}.`);
    }
    if (!record.container || record.container.runId !== input.runId || !dependencies.parkContainer) {
      throw new Error(`worker_review requires worker ${input.workerId}/${input.runId}'s exact verified parked container.`);
    }
    dependencies.parkContainer(record.container);
    const candidate = observed.repositories.candidates.find((item) => item.workspaceRepo === input.workspaceRepo);
    if (!candidate || candidate.runId !== input.runId || candidate.workerId !== input.workerId) {
      throw new Error(`worker_review repository is not an exact candidate from ${input.workerId}/${input.runId}: ${input.workspaceRepo}`);
    }
    if (!candidate.foldable || candidate.dirty || !candidate.baseCommit || !candidate.headCommit || !candidate.headTree || candidate.policyIssues.length > 0) {
      throw new Error("worker_review requires a clean foldable committed repository candidate; resume the implementation worker to clean or commit it first.");
    }
    const repository = canonicalWorkerReviewRepository(paths.workspaceRoot, candidate.workspaceRepo);
    verifyWorkerReviewRepository(repository, candidate, paths.stateDir);
    const reviewContext = formatWorkerReviewContext(record, observed.handoff, candidate);
    const review = await dependencies.reviewWorker(api, context, {
      cwd: repository,
      context: reviewContext,
      focus: input.focus,
      tools: ["search_many", "read_many"],
      gitContext: buildWorkerReviewGitContext(repository, candidate, paths.stateDir),
      isolateWorkspaceResources: true,
      signal
    });
    throwIfAborted(signal);
    const current = readWorkerRecord(paths.recordFile);
    assertWorkerParentSession(current, context);
    if (current.activeRun || readWorkerLease(paths.leaseFile) || current.status !== "handed_off" || current.lastRun?.runId !== input.runId) {
      throw new Error("Managed worker changed lifecycle state during review.");
    }
    verifyWorkerReviewRepository(repository, candidate, paths.stateDir);
    if (review.status !== "completed" || !review.critique.trim()) {
      throw new Error(`Managed-worker review did not complete: ${review.error ?? review.status}`);
    }
    if (path.resolve(review.cwd) !== repository) {
      throw new Error("Managed-worker reviewer returned a different repository identity.");
    }
    return {
      workerId: input.workerId,
      runId: input.runId,
      candidateId: candidate.candidateId,
      workspaceRepo: candidate.workspaceRepo,
      headCommit: candidate.headCommit,
      headTree: candidate.headTree,
      model: review.model,
      thinkingLevel: review.thinkingLevel,
      startedAt: review.startedAt,
      completedAt: review.completedAt,
      durationMs: review.durationMs,
      toolCallCount: review.toolCallCount,
      critique: review.critique
    };
  } finally {
    releaseWorkerOperationLock(lock);
  }
}

function canonicalWorkerReviewRepository(workspaceRootValue: string, workspaceRepo: string): string {
  const workspaceRoot = realpathSync(workspaceRootValue);
  const requested = path.resolve(workspaceRoot, workspaceRepo);
  const relative = path.relative(workspaceRoot, requested);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !workspaceRepo.startsWith("repos/")) {
    throw new Error("worker_review repository path escapes the managed workspace.");
  }
  const repository = realpathSync(requested);
  const canonicalRelative = path.relative(workspaceRoot, repository);
  if (!canonicalRelative || canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative) || canonicalRelative !== workspaceRepo) {
    throw new Error("worker_review repository path is not the exact canonical workspace repository.");
  }
  return repository;
}

function verifyWorkerReviewRepository(
  repository: string,
  candidate: RepositoryInventory["candidates"][number],
  trustedStateRoot: string
): void {
  const runner = createGitRunner(resolveExecutable("git"), path.join(trustedStateRoot, "review-git"));
  const headCommit = gitText(runner, repository, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const headTree = gitText(runner, repository, ["rev-parse", "--verify", `${headCommit}^{tree}`]).trim();
  const issues = repositoryPolicyIssues(repository, runner, headCommit);
  if (headCommit !== candidate.headCommit || headTree !== candidate.headTree || repositoryDirty(repository, runner) || issues.length > 0) {
    throw new Error("Managed-worker repository changed or violated clean policy before review completed; resume and review the new settled result.");
  }
}

function buildWorkerReviewGitContext(
  repository: string,
  candidate: RepositoryInventory["candidates"][number],
  trustedStateRoot: string
): ReviewGitContext {
  const runner = createGitRunner(resolveExecutable("git"), path.join(trustedStateRoot, "review-context-git"));
  const errors: string[] = [];
  let diffStat = "Exact committed candidate delta: unavailable.";
  let committedDiff = "(unavailable; inspect the exact current files with read-only tools)";
  try {
    diffStat = gitText(runner, repository, ["diff", "--no-ext-diff", "--stat", candidate.baseCommit!, candidate.headCommit!, "--"]).trim()
      || "Exact committed candidate delta: (no stat output)";
  } catch (error) {
    errors.push(`exact committed diff stat: ${reviewContextError(error)}`);
  }
  try {
    const output = gitText(runner, repository, ["diff", "--no-ext-diff", "--minimal", "--unified=40", candidate.baseCommit!, candidate.headCommit!, "--"]).trim();
    committedDiff = boundReviewContext(output || "(none)", 50_000);
  } catch (error) {
    errors.push(`exact committed diff: ${reviewContextError(error)}`);
  }
  return {
    isRepository: true,
    root: repository,
    status: `(clean; exact candidate HEAD ${candidate.headCommit})`,
    diffStat: boundReviewContext(diffStat, 20_000),
    stagedDiff: committedDiff,
    stagedDiffLabel: "Exact committed candidate delta excerpt",
    unstagedDiff: "(none)",
    unstagedDiffLabel: "Unstaged diff excerpt (must remain empty)",
    untrackedFiles: "(none)",
    errors
  };
}

function boundReviewContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n... [truncated ${value.length - maxChars} characters; inspect exact files with read-only tools]`;
}

function reviewContextError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundReviewContext(message.replace(/\s+/g, " ").trim() || "unknown error", 500);
}

function formatWorkerReviewContext(
  record: WorkerRecord,
  handoff: AcceptedWorkerHandoff,
  candidate: RepositoryInventory["candidates"][number]
): string {
  return [
    `Review exact managed-worker result ${record.workerId}/${candidate.runId}.`,
    `Assigned tasks: ${record.taskIds.join(", ")}.`,
    `Repository: ${candidate.workspaceRepo}.`,
    `Candidate: ${candidate.candidateId}.`,
    `Exact base..HEAD: ${candidate.baseCommit}..${candidate.headCommit}.`,
    `Exact HEAD tree: ${candidate.headTree}.`,
    `Worker handoff (${handoff.handoff.state}): ${handoff.handoff.summary}`,
    handoff.handoff.checks?.length
      ? `Worker-reported checks:
${handoff.handoff.checks.map((check) => `- ${check.outcome}: ${check.command} (${check.cwd})`).join("\n")}`
      : "Worker-reported checks: none.",
    "Review this implementation independently. Do not modify it. Return actionable findings; this critique is advice to the parent, not promotion authority."
  ].join("\n");
}

function formatWorkerReviewResult(details: WorkerReviewDetails): string {
  return [
    `Managed-worker review completed for ${details.workerId}/${details.runId}.`,
    `Repository: ${details.workspaceRepo} (${details.candidateId})`,
    `Exact HEAD/tree: ${details.headCommit}/${details.headTree}`,
    `Reviewer: ${details.model}:${details.thinkingLevel} · ${details.toolCallCount} tool call${details.toolCallCount === 1 ? "" : "s"} · ${details.durationMs} ms (${details.startedAt} → ${details.completedAt})`,
    "",
    details.critique
  ].join("\n");
}

function listParentWorkerRecords(roots: WorkerRoots, context: ExtensionContext): WorkerRecord[] {
  const parentSessionFile = context.sessionManager.getSessionFile();
  if (!parentSessionFile) throw new Error("worker_control requires a persisted parent session.");
  if (!existsSync(roots.stateRoot)) return [];
  const records = readdirSync(roots.stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isWorkerId(entry.name))
    .map((entry) => workerPaths(roots, entry.name))
    .filter((paths) => existsSync(paths.recordFile))
    .map((paths) => readWorkerRecord(paths.recordFile))
    .filter((record) => path.resolve(record.parentSessionFile) === path.resolve(parentSessionFile))
    .sort((left, right) => left.workerId.localeCompare(right.workerId));
  return records;
}

function withLockedParentFoldCandidates<T>(
  changeSet: RepositoryChangeSet,
  context: ExtensionContext,
  dependencies: WorkerExtensionDependencies,
  operation: (candidates: ReturnType<typeof resolveParentFoldCandidates>) => T
): T {
  const requested = new Set(changeSet.repositories.map((item) => item.candidateId));
  const owners = new Map<string, string>();
  for (const record of listParentWorkerRecords(dependencies.roots, context)) {
    for (const summary of record.lastRun?.repositoryInventory?.candidates ?? []) {
      if (!requested.has(summary.candidateId)) continue;
      if (owners.has(summary.candidateId)) throw new Error(`Worker repository candidate identity is ambiguous: ${summary.candidateId}`);
      owners.set(summary.candidateId, record.workerId);
    }
  }
  for (const candidateId of requested) {
    if (!owners.has(candidateId)) throw new Error(`Worker repository candidate is not available to this parent session: ${candidateId}`);
  }
  const workerIds = [...new Set(owners.values())].sort();
  const locks: ReturnType<typeof acquireWorkerOperationLock>[] = [];
  try {
    for (const workerId of workerIds) locks.push(acquireWorkerOperationLock(workerPaths(dependencies.roots, workerId).operationLockFile));
    return operation(resolveParentFoldCandidates(changeSet, context, dependencies, owners));
  } finally {
    for (const lock of locks.reverse()) releaseWorkerOperationLock(lock);
  }
}

function resolveParentFoldCandidates(
  changeSet: RepositoryChangeSet,
  context: ExtensionContext,
  dependencies: WorkerExtensionDependencies,
  expectedOwners: ReadonlyMap<string, string>
): Array<{ candidate: RepositoryInventory["candidates"][number]; workspaceRoot: string; inventory: { inventoryFile: string; inventorySha256: string; reportedIssues: RepositoryInventory["reportedIssues"]; scanCoverage: RepositoryInventory["scanCoverage"] } }> {
  const requested = new Set(changeSet.repositories.map((item) => item.candidateId));
  const resolved = new Map<string, { candidate: RepositoryInventory["candidates"][number]; workspaceRoot: string; inventory: { inventoryFile: string; inventorySha256: string; reportedIssues: RepositoryInventory["reportedIssues"]; scanCoverage: RepositoryInventory["scanCoverage"] } }>();
  for (const record of listParentWorkerRecords(dependencies.roots, context)) {
    const paths = workerPaths(dependencies.roots, record.workerId);
    if (record.activeRun || readWorkerLease(paths.leaseFile)) {
      if (record.lastRun?.repositoryInventory?.candidates.some((item) => requested.has(item.candidateId))) {
        throw new Error(`Worker repository candidate is unavailable while worker ${record.workerId} has an active run or lease.`);
      }
      continue;
    }
    const run = record.lastRun;
    const summary = run?.repositoryInventory;
    if (!run || run.status !== "handed_off" || !summary || !summary.candidates.some((item) => requested.has(item.candidateId))) continue;
    const inventory = readRepositoryInventory(summary.inventoryFile, {
      workerId: record.workerId,
      runId: run.runId,
      workspaceRoot: record.workspaceRoot,
      sha256: summary.inventorySha256
    });
    for (const candidate of inventory.candidates) {
      if (!requested.has(candidate.candidateId)) continue;
      const expectedOwner = expectedOwners.get(candidate.candidateId);
      if (!expectedOwner || candidate.workerId !== expectedOwner || record.workerId !== expectedOwner) throw new Error(`Worker repository candidate owner mismatch: ${candidate.candidateId}`);
      if (resolved.has(candidate.candidateId)) throw new Error(`Worker repository candidate identity is ambiguous: ${candidate.candidateId}`);
      resolved.set(candidate.candidateId, {
        candidate,
        workspaceRoot: record.workspaceRoot,
        inventory: {
          inventoryFile: summary.inventoryFile,
          inventorySha256: summary.inventorySha256,
          reportedIssues: inventory.reportedIssues.map((item) => ({ ...item })),
          scanCoverage: { complete: inventory.scanCoverage.complete, limitations: [...inventory.scanCoverage.limitations] }
        }
      });
    }
  }
  return changeSet.repositories.map((item) => {
    const candidate = resolved.get(item.candidateId);
    if (!candidate) throw new Error(`Worker repository candidate is not available to this parent session: ${item.candidateId}`);
    return candidate;
  });
}

function readParentWorkerResult(
  workerId: string,
  context: ExtensionContext,
  dependencies: WorkerExtensionDependencies,
  operationLocked = false
): { record: WorkerRecord; handoff?: AcceptedWorkerHandoff; repositories?: RepositoryInventory; acknowledgedDelivery: boolean } {
  const paths = workerPaths(dependencies.roots, workerId);
  const record = readWorkerRecord(paths.recordFile);
  assertWorkerParentSession(record, context);
  if (record.activeRun) throw new Error(`Worker ${workerId} still has active run ${record.activeRun.runId}; wait for settlement or cancel it.`);
  const lastRun = record.lastRun;
  if (!lastRun) throw new Error(`Worker ${workerId} has no settled result.`);
  let handoff: AcceptedWorkerHandoff | undefined;
  if (lastRun.resultFile) {
    handoff = readMatchingWorkerHandoff(lastRun.resultFile, workerId, lastRun.runId);
  } else if (lastRun.status === "handed_off") {
    throw new Error(`Worker ${workerId}/${lastRun.runId} is marked handed_off without a result file.`);
  }
  const repositories = lastRun.repositoryInventory
    ? readRepositoryInventory(lastRun.repositoryInventory.inventoryFile, {
        workerId,
        runId: lastRun.runId,
        workspaceRoot: record.workspaceRoot,
        sha256: lastRun.repositoryInventory.inventorySha256
      })
    : undefined;

  const observe = () => {
    const current = readWorkerRecord(paths.recordFile);
    assertWorkerParentSession(current, context);
    if (current.activeRun || current.lastRun?.runId !== lastRun.runId) {
      throw new Error(`Worker ${workerId} changed runs while its result was being observed; retry worker_control result.`);
    }
    if (current.lastRun.delivery !== "pending") return { record: current, acknowledgedDelivery: false };
    const next: WorkerRecord = {
      ...current,
      lastRun: { ...current.lastRun, delivery: "delivered" },
      updatedAt: dependencies.now().toISOString()
    };
    writeWorkerRecord(paths.recordFile, next);
    return { record: next, acknowledgedDelivery: true };
  };
  const observed = operationLocked ? observe() : withWorkerOperationLock(paths, observe);
  return { record: observed.record, handoff, repositories, acknowledgedDelivery: observed.acknowledgedDelivery };
}

function discardParentWorker(
  workerId: string,
  context: ExtensionContext,
  dependencies: WorkerExtensionDependencies
): boolean {
  const paths = workerPaths(dependencies.roots, workerId);
  return withWorkerOperationLock(paths, () => {
    const record = readWorkerRecord(paths.recordFile);
    assertWorkerParentSession(record, context);
    if (record.activeRun || readWorkerLease(paths.leaseFile)) return false;
    if (record.container) dependencies.removeContainer(record.container);
    rmSync(paths.workspaceRoot, { recursive: true, force: true });
    rmSync(paths.stateDir, { recursive: true, force: true });
    return true;
  });
}

async function cancelParentWorker(
  api: ExtensionAPI,
  workerId: string,
  context: ExtensionContext,
  dependencies: WorkerExtensionDependencies,
  pending: Map<string, PendingWorkerRun>,
  active: Map<string, { runId: string; handle: ManagedWorkerHandle }>,
  deliverCompletion: boolean
): Promise<"not_active" | "queued" | "running" | "recovered" | "detached"> {
  const paths = workerPaths(dependencies.roots, workerId);
  const record = readWorkerRecord(paths.recordFile);
  assertWorkerParentSession(record, context);
  if (!record.activeRun) return "not_active";
  const runId = record.activeRun.runId;
  if (record.activeRun.status === "queued") {
    const cancellation = withWorkerOperationLock(paths, () => {
      const current = readWorkerRecord(paths.recordFile);
      const lease = readWorkerLease(paths.leaseFile);
      if (current.activeRun?.runId !== runId || current.activeRun.status !== "queued") {
        throw new Error(`Worker ${workerId}/${runId} changed state before queued cancellation; retry the operation.`);
      }
      if (!lease || lease.workerId !== workerId || lease.runId !== runId || lease.parentPid !== process.pid) {
        throw new Error(`Worker ${workerId}/${runId} is queued under another live parent and cannot be cancelled from this session.`);
      }
      pending.delete(runId);
      if (current.container) {
        try {
          dependencies.removeContainer(current.container);
        } catch (cause) {
          writeWorkerRecord(paths.recordFile, {
            ...current,
            status: "running",
            activeRun: {
              ...current.activeRun,
              status: "running",
              hostProcessSettled: true,
              recoveryError: cause instanceof Error ? cause.message : String(cause)
            },
            updatedAt: dependencies.now().toISOString()
          });
          throw cause;
        }
      }
      const next = cancelledWorkerRecord(current, dependencies.now(), deliverCompletion);
      writeWorkerRecord(paths.recordFile, next);
      releaseWorkerLease(paths.leaseFile, workerId, runId);
      return { previous: current, next };
    });
    if (deliverCompletion) {
      sendWorkerCompletion(api, cancellation.next, queuedCancellationJob(paths, cancellation.previous, cancellation.next), undefined, undefined);
    }
    return "queued";
  }
  const attached = active.get(workerId);
  if (attached?.runId === runId) {
    const cleanupOwner = claimWorkerCancellationOwnership(paths, record, runId, dependencies);
    if (!cleanupOwner) throw new Error(`Worker ${workerId}/${runId} cleanup is owned by another live parent.`);
    try {
      await cancelAttachedWorker(attached.handle, readWorkerRecord(paths.recordFile), paths, dependencies);
      if (!finalizeRecoveredWorkerCancellation(api, paths, readWorkerRecord(paths.recordFile), runId, dependencies, true, cleanupOwner, deliverCompletion)) {
        throw new Error(`Worker ${workerId}/${runId} changed state before cancellation finalization.`);
      }
    } catch (cause) {
      const status = attached.handle.snapshot().status;
      persistWorkerCleanupUncertainty(
        paths,
        runId,
        cause instanceof Error ? cause.message : String(cause),
        ["exited", "failed", "cancelled", "unknown"].includes(status),
        dependencies
      );
      releaseWorkerCancellationOwnership(paths, runId, cleanupOwner, dependencies);
      throw cause;
    }
    return "running";
  }
  if (record.activeRun.hostProcessSettled && record.activeRun.recoveryError) {
    if (!ensureWorkerRecoveryLease(paths, record, runId, dependencies)) {
      throw new Error(`Worker ${workerId}/${runId} cleanup is owned by another live parent.`);
    }
    const cleanupOwner = claimWorkerCancellationOwnership(paths, record, runId, dependencies);
    if (!cleanupOwner) throw new Error(`Worker ${workerId}/${runId} cleanup is owned by another live parent.`);
    try {
      await settlePersistedWorkerShells(paths, workerId, runId, dependencies);
    } catch (error) {
      persistWorkerCleanupUncertainty(
        paths,
        runId,
        error instanceof Error ? error.message : String(error),
        true,
        dependencies
      );
      releaseWorkerCancellationOwnership(paths, runId, cleanupOwner, dependencies);
      throw error;
    }
    if (!finalizeRecoveredWorkerCancellation(api, paths, readWorkerRecord(paths.recordFile), runId, dependencies, true, cleanupOwner, deliverCompletion)) {
      throw new Error(`Worker ${workerId}/${runId} changed state before cancellation finalization.`);
    }
    return "recovered";
  }
  const cleanupOwner = claimWorkerCancellationOwnership(paths, record, runId, dependencies);
  if (!cleanupOwner) throw new Error(`Worker ${workerId}/${runId} cleanup is owned by another live parent.`);
  try {
    const current = readWorkerRecord(paths.recordFile);
    if (isWorkerHostProcessSettled(current)) {
      await settlePersistedWorkerShells(paths, workerId, runId, dependencies);
    } else {
      await cancelDetachedWorker(current, paths, dependencies);
    }
    if (!finalizeRecoveredWorkerCancellation(api, paths, readWorkerRecord(paths.recordFile), runId, dependencies, true, cleanupOwner, deliverCompletion)) {
      throw new Error(`Worker ${workerId}/${runId} changed state before cancellation finalization.`);
    }
  } catch (cause) {
    const current = readWorkerRecord(paths.recordFile);
    persistWorkerCleanupUncertainty(
      paths,
      runId,
      cause instanceof Error ? cause.message : String(cause),
      isWorkerHostProcessSettled(current),
      dependencies
    );
    releaseWorkerCancellationOwnership(paths, runId, cleanupOwner, dependencies);
    throw cause;
  }
  return "detached";
}

function planWorkerRuns(
  inputs: WorkerRunInput["runs"],
  context: ExtensionContext,
  dependencies: WorkerExtensionDependencies
): PlannedWorkerRun[] {
  const currentParentSessionFile = context.sessionManager.getSessionFile();
  if (!currentParentSessionFile) throw new Error("worker_run requires a persisted parent session before it can fork or resume a worker.");
  const parentSessionFile = path.resolve(currentParentSessionFile);
  const resumed = new Set<string>();
  return inputs.map((input): PlannedWorkerRun => {
    if (input.kind === "new") {
      const taskIds = uniqueStrings(input.taskIds);
      if (taskIds.length === 0) throw new Error("A new worker requires at least one non-blank task ID.");
      validatePersonalTaskIds(taskIds);
      return {
        kind: "new",
        input,
        parentSessionFile,
        route: resolveWorkerRoute(input.route, context),
        taskIds
      };
    }
    if (resumed.has(input.workerId)) throw new Error(`Worker ${input.workerId} cannot be resumed twice in one worker_run call.`);
    resumed.add(input.workerId);
    const paths = workerPaths(dependencies.roots, input.workerId);
    const existing = readWorkerRecord(paths.recordFile);
    if (parentSessionFile !== path.resolve(existing.parentSessionFile)) {
      throw new Error(`Worker ${existing.workerId} can only resume from its exact parent session ${existing.parentSessionFile}.`);
    }
    if (existing.activeRun) throw new Error(`Worker ${existing.workerId} already has active run ${existing.activeRun.runId}.`);
    if (existing.integration) throw new Error(`Integration worker ${existing.workerId} must resume through worker_fold_resolve.`);
    if (existing.lastRun?.delivery === "pending") {
      throw new Error(`Worker ${existing.workerId} completion delivery is still pending; inspect it with worker_control result or use /worker:ack before resuming.`);
    }
    validatePersonalTaskIds(uniqueStrings([...existing.taskIds, ...(input.addTaskIds ?? [])]));
    if (!existing.sessionFile) throw new Error(`Worker ${existing.workerId} has no forked session to resume.`);
    verifyWorkerSession({
      sessionFile: existing.sessionFile,
      sessionId: existing.sessionId,
      workspaceRoot: existing.workspaceRoot,
      parentSessionFile: existing.parentSessionFile
    });
    return { kind: "resume", input, parentSessionFile, paths, existing };
  });
}

function prepareWorkerPlans(
  plans: PlannedWorkerRun[],
  context: ExtensionContext,
  dependencies: WorkerExtensionDependencies,
  pending: Map<string, PendingWorkerRun>
): WorkerRunReceipt[] {
  const prepared: Array<{ plan: PlannedWorkerRun; receipt: WorkerRunReceipt }> = [];
  try {
    for (const plan of plans) {
      const receipt = plan.kind === "new"
        ? prepareNewWorker(plan, context, dependencies, pending)
        : prepareResumedWorker(plan, context, dependencies, pending);
      prepared.push({ plan, receipt });
    }
    return prepared.map(({ receipt }) => receipt);
  } catch (error) {
    for (const { plan, receipt } of prepared.reverse()) {
      pending.delete(receipt.runId);
      const paths = workerPaths(dependencies.roots, receipt.workerId);
      if (plan.kind === "resume") writeWorkerRecord(paths.recordFile, plan.existing);
      releaseWorkerLease(paths.leaseFile, receipt.workerId, receipt.runId);
      if (plan.kind === "new") {
        rmSync(paths.workspaceRoot, { recursive: true, force: true });
        rmSync(paths.stateDir, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

function prepareNewWorker(
  plan: Extract<PlannedWorkerRun, { kind: "new" }>,
  context: ExtensionContext,
  dependencies: WorkerExtensionDependencies,
  pending: Map<string, PendingWorkerRun>
): WorkerRunReceipt {
  const now = dependencies.now();
  const workerId = createWorkerId(now, dependencies.random());
  const runId = createWorkerRunId(now, dependencies.random());
  const jobId = createAsyncJobId(now, dependencies.random());
  const sessionId = dependencies.random();
  const paths = workerPaths(dependencies.roots, workerId);
  if (existsSync(paths.stateDir) || existsSync(paths.workspaceRoot)) {
    throw new Error(`Generated worker identity already exists: ${workerId}.`);
  }
  provisionWorkerPaths(paths);
  let leaseAcquired = false;
  try {
    let integration: WorkerIntegrationRecord | undefined;
    let integrationInitialRepository: InitialRepositoryPin | undefined;
    if (plan.integrationStart) {
    const manifest = readPreparedWorkerFold(dependencies.foldsRoot, plan.integrationStart.preparedId, plan.parentSessionFile);
    if (manifest.manifestSha256 !== plan.integrationStart.manifestSha256) throw new Error("Prepared integration manifest changed before worker provisioning.");
    const repository = manifest.repositories.find((item) => item.candidateId === plan.integrationStart!.candidateId);
    if (!repository || repository.status !== "resolution_required") throw new Error("Prepared integration resolution case is unavailable.");
    assertPreparedTargetCurrent(repository, path.join(paths.stateDir, "integration-target-inspection"));
    const workspaceRepo = `repos/integration-${repository.candidateId.slice("candidate_".length)}`;
    const provisioned = provisionIntegrationRepository({
      selection: { manifest, repository, preparedDirectory: path.join(dependencies.foldsRoot, manifest.preparedId) },
      repositoryPath: path.join(paths.workspaceRoot, workspaceRepo),
      trustedStateRoot: path.join(paths.stateDir, "integration-git"),
      context: plan.integrationStart.context,
      artifactsDir: paths.artifactsDir
    });
    const contextArtifact = persistIntegrationEnvelope({
      destination: path.join(paths.stateDir, "integration", "context.json"),
      workspaceCopy: path.join(paths.artifactsDir, "integration-context.json"),
      value: {
        version: 1, preparedId: manifest.preparedId, manifestSha256: manifest.manifestSha256, candidateId: repository.candidateId, method: repository.method,
        target: { repo: repository.targetRepo, ref: repository.targetRef, commit: repository.targetExpectedCommit, tree: repository.targetExpectedTree },
        candidate: { commit: repository.candidateHeadCommit, tree: repository.candidateHeadTree, baseCommit: repository.candidateBaseCommit, baseTree: repository.candidateBaseTree },
        context: { ...plan.integrationStart.context, evidencePaths: provisioned.evidence.map((item) => item.path), evidence: provisioned.evidence }
      }
    });
    integrationInitialRepository = provisioned.initialRepository;
    integration = {
      phase: "analysis",
      preparedId: manifest.preparedId,
      manifestSha256: manifest.manifestSha256,
      candidateId: repository.candidateId,
      method: repository.method,
      sourceCandidateIds: [repository.candidateId],
      targetRepo: repository.targetRepo,
      targetRef: repository.targetRef,
      targetExpectedCommit: repository.targetExpectedCommit,
      targetExpectedTree: repository.targetExpectedTree,
      candidateHeadCommit: repository.candidateHeadCommit,
      candidateHeadTree: repository.candidateHeadTree,
      preparedArtifactFile: provisioned.artifactFile,
      analysisIndexFile: provisioned.analysisIndexFile,
      analysisIndexSha256: provisioned.analysisIndexSha256,
      evidence: provisioned.evidence.map((item) => ({ ...item })),
      workspaceRepo,
      contextFile: contextArtifact.file,
      workspaceContextFile: contextArtifact.workspaceFile,
      contextSha256: contextArtifact.sha256,
      analysisRunId: runId,
      analysisSnapshot: provisioned.snapshot
    };
    }
    const record: WorkerRecord = {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId,
      parentSessionFile: plan.parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: plan.taskIds,
      route: plan.route,
      initialRepositories: integrationInitialRepository ? [integrationInitialRepository] : plan.input.initialRepos?.length
        ? dependencies.pinRepositories(plan.input.initialRepos, path.join(paths.stateDir, "repository-inspection"))
        : undefined,
      integration,
      status: "queued",
      activeRun: {
        runId,
        jobId,
        status: "queued",
        completionDelivery: resolveCompletionDelivery(plan.input.completionDelivery)
      },
      updatedAt: now.toISOString()
    };
    acquireWorkerRunLease(paths, record.workerId, runId, now);
    leaseAcquired = true;
    writeWorkerRecord(paths.recordFile, record);
    const runDir = path.join(paths.stateDir, "runs", runId);
    const resultFile = path.join(runDir, "result.json");
    pending.set(runId, {
      runId,
      parentSessionId: context.sessionManager.getSessionId(),
      parentSessionFile: plan.parentSessionFile,
      recordFile: paths.recordFile,
      paths,
      prompt: integration ? buildIntegrationAnalysisPrompt(record) : buildNewWorkerPrompt(record, plan.input.guidance, plan.input.initialRepos),
      resultFile,
      runDir,
      processFile: path.join(runDir, "host-process.json"),
      processNonce: randomUUID(),
      kind: "new"
    });
    return receipt(record);
  } catch (error) {
    pending.delete(runId);
    if (leaseAcquired && existsSync(paths.leaseFile)) {
      releaseWorkerLease(paths.leaseFile, workerId, runId);
    }
    rmSync(paths.workspaceRoot, { recursive: true, force: true });
    rmSync(paths.stateDir, { recursive: true, force: true });
    throw error;
  }
}

function prepareResumedWorker(
  plan: Extract<PlannedWorkerRun, { kind: "resume" }>,
  context: ExtensionContext,
  dependencies: WorkerExtensionDependencies,
  pending: Map<string, PendingWorkerRun>
): WorkerRunReceipt {
  const { paths } = plan;
  const input = plan.input;
  const now = dependencies.now();
  const runId = createWorkerRunId(now, dependencies.random());
  const jobId = createAsyncJobId(now, dependencies.random());
  return withWorkerOperationLock(paths, () => {
    const existing = readWorkerRecord(paths.recordFile);
    if (existing.activeRun) throw new Error(`Worker ${existing.workerId} became active before resume preparation.`);
    if (existing.lastRun?.delivery === "pending") {
      throw new Error(`Worker ${existing.workerId} completion delivery became pending before resume preparation; inspect it with worker_control result or use /worker:ack.`);
    }
    if (path.resolve(existing.parentSessionFile) !== plan.parentSessionFile) {
      throw new Error(`Worker ${existing.workerId} parent session changed before resume preparation.`);
    }
    plan.existing = existing;
    const taskIds = uniqueStrings([...existing.taskIds, ...(input.addTaskIds ?? [])]);
    validatePersonalTaskIds(taskIds);
    let integration = existing.integration;
    let decisionArtifact: { file: string; workspaceFile: string; sha256: string } | undefined;
    if (plan.integrationResume) {
      if (!integration || integration.phase !== "analysis") throw new Error("Integration resolution resume requires analysis phase state.");
      assertIntegrationRecordLayout(integration, paths.workspaceRoot, paths.stateDir);
      assertIntegrationPristine(integration, paths.workspaceRoot, path.join(paths.stateDir, "integration-git"));
      const analysisHandoff = existing.lastRun?.resultFile ? readMatchingWorkerHandoff(existing.lastRun.resultFile, existing.workerId, integration.analysisRunId) : undefined;
      if (!analysisHandoff) throw new Error("Integration analysis handoff is unavailable before resolution resume.");
      assertAnalysisRepositoryInventory(existing, analysisHandoff, paths, dependencies);
      const manifest = readPreparedWorkerFold(dependencies.foldsRoot, integration.preparedId, plan.parentSessionFile);
      if (manifest.manifestSha256 !== integration.manifestSha256) throw new Error("Prepared integration manifest changed before resolution resume.");
      const repository = manifest.repositories.find((item) => item.candidateId === integration!.candidateId);
      if (!repository || repository.status !== "resolution_required") throw new Error("Prepared integration resolution case is unavailable.");
      assertPreparedIntegrationBinding(integration, repository, dependencies.foldsRoot, "resolution resume");
      assertPreparedTargetCurrent(repository, path.join(paths.stateDir, "integration-target-inspection"));
      verifyIntegrationArtifact(integration.contextFile, integration.contextSha256);
      verifyIntegrationArtifact(integration.workspaceContextFile, integration.contextSha256);
      assertCanonicalWorkerArtifacts(paths);
      decisionArtifact = persistIntegrationEnvelope({
        destination: path.join(paths.stateDir, "integration", `decisions-${runId}.json`),
        workspaceCopy: path.join(paths.artifactsDir, `integration-decisions-${runId}.json`),
        value: { version: 1, preparedId: integration.preparedId, manifestSha256: integration.manifestSha256, candidateId: integration.candidateId, contextSha256: integration.contextSha256, analysisRunId: integration.analysisRunId, resolutionRunId: runId, decisions: plan.integrationResume.decisions.map((item) => item.trim()) }
      });
      integration = {
        ...integration,
        phase: "resolution",
        decisionsFile: decisionArtifact.file,
        workspaceDecisionsFile: decisionArtifact.workspaceFile,
        decisionsSha256: decisionArtifact.sha256,
        resolutionRunId: runId
      };
    } else if (integration) {
      throw new Error(`Integration worker ${existing.workerId} must resume through worker_fold_resolve.`);
    }
    const record: WorkerRecord = {
      ...existing,
      taskIds,
      integration,
      status: "queued",
      activeRun: {
        runId,
        jobId,
        status: "queued",
        completionDelivery: resolveCompletionDelivery(input.completionDelivery)
      },
      updatedAt: now.toISOString()
    };
    let leaseAcquired = false;
    try {
      acquireWorkerRunLease(paths, record.workerId, runId, now);
      leaseAcquired = true;
      writeWorkerRecord(paths.recordFile, record);
      const runDir = path.join(paths.stateDir, "runs", runId);
      const resultFile = path.join(runDir, "result.json");
      const parentContextSnapshot = path.join(paths.artifactsDir, `parent-context-${runId}.jsonl`);
      pending.set(runId, {
        runId,
        parentSessionId: context.sessionManager.getSessionId(),
        parentSessionFile: plan.parentSessionFile,
        recordFile: paths.recordFile,
        paths,
        prompt: integration?.phase === "resolution" ? buildIntegrationResolutionPrompt(record, input.message, parentContextSnapshot) : buildResumeWorkerPrompt(record, input.message, parentContextSnapshot),
        resultFile,
        runDir,
        parentContextSnapshot,
        processFile: path.join(runDir, "host-process.json"),
        processNonce: randomUUID(),
        kind: "resume"
      });
    } catch (error) {
      if (leaseAcquired) {
        writeWorkerRecord(paths.recordFile, existing);
        releaseWorkerLease(paths.leaseFile, record.workerId, runId);
      }
      if (decisionArtifact) {
        rmSync(decisionArtifact.file, { force: true });
        rmSync(decisionArtifact.workspaceFile, { force: true });
      }
      throw error;
    }
    return receipt(record);
  });
}

function assertCanonicalWorkerArtifacts(paths: WorkerPaths): void {
  const workspaceRoot = realpathSync(paths.workspaceRoot);
  const metadata = lstatSync(paths.artifactsDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(paths.artifactsDir) !== path.join(workspaceRoot, "artifacts")) {
    throw new Error(`Worker artifacts path is not the canonical workspace artifacts directory: ${paths.artifactsDir}`);
  }
}

function writeParentContextSnapshot(paths: WorkerPaths, sourceFile: string, destinationFile: string): void {
  assertCanonicalWorkerArtifacts(paths);
  const workspaceRoot = realpathSync(paths.workspaceRoot);
  const artifactsRoot = realpathSync(paths.artifactsDir);
  const expectedArtifactsRoot = path.join(workspaceRoot, "artifacts");
  if (artifactsRoot !== expectedArtifactsRoot || realpathSync(path.dirname(path.resolve(destinationFile))) !== artifactsRoot) {
    throw new Error(`Worker parent-context snapshot destination escapes the canonical artifacts directory: ${destinationFile}`);
  }
  copyFileSync(path.resolve(sourceFile), path.resolve(destinationFile), constants.COPYFILE_EXCL);
  const snapshot = lstatSync(destinationFile);
  if (!snapshot.isFile() || snapshot.isSymbolicLink()) {
    throw new Error(`Worker parent-context snapshot is not a regular file: ${destinationFile}`);
  }
  chmodSync(destinationFile, 0o400);
}

function withWorkerOperationLock<T>(paths: WorkerPaths, operation: () => T): T {
  const lock = acquireWorkerOperationLock(paths.operationLockFile);
  try {
    return operation();
  } finally {
    releaseWorkerOperationLock(lock);
  }
}

function acquireWorkerRunLease(paths: WorkerPaths, workerId: string, runId: string, now: Date): void {
  const lease: WorkerLease = { version: 1, workerId, runId, parentPid: process.pid, acquiredAt: now.toISOString() };
  acquireWorkerLease(paths.leaseFile, lease);
}

async function startPendingWorker(
  api: ExtensionAPI,
  context: ExtensionContext,
  pending: PendingWorkerRun,
  dependencies: WorkerExtensionDependencies,
  active: Map<string, { runId: string; handle: ManagedWorkerHandle }>
): Promise<void> {
  let record = readWorkerRecord(pending.recordFile);
  let launchedHandle: ManagedWorkerHandle | undefined;
  let launchAttempted = false;
  try {
    const currentParentSessionFile = context.sessionManager.getSessionFile();
    if (!currentParentSessionFile || path.resolve(currentParentSessionFile) !== pending.parentSessionFile) {
      throw new Error(`Worker ${record.workerId} launch parent session changed before the queued run became durable.`);
    }
    mkdirSync(pending.runDir, { recursive: true, mode: 0o700 });
    if (pending.kind === "new") {
      const forked = forkWorkerSession({
        parentSessionFile: pending.parentSessionFile,
        workspaceRoot: pending.paths.workspaceRoot,
        sessionDir: pending.paths.sessionDir,
        sessionId: record.sessionId
      });
      record = { ...record, sessionFile: forked.sessionFile };
    } else if (record.sessionFile) {
      if (!pending.parentContextSnapshot) throw new Error(`Worker ${record.workerId} resume lost its parent-context snapshot path.`);
      writeParentContextSnapshot(pending.paths, pending.parentSessionFile, pending.parentContextSnapshot);
      verifyWorkerSession({
        sessionFile: record.sessionFile,
        sessionId: record.sessionId,
        workspaceRoot: record.workspaceRoot,
        parentSessionFile: record.parentSessionFile
      });
    }
    const preparedSessionFile = record.sessionFile;
    let activeRun!: NonNullable<WorkerRecord["activeRun"]>;
    let handle!: ManagedWorkerHandle;
    withWorkerOperationLock(pending.paths, () => {
      record = { ...readWorkerRecord(pending.recordFile), sessionFile: preparedSessionFile };
      const lease = readWorkerLease(pending.paths.leaseFile);
      if (!record.activeRun || record.activeRun.status !== "queued" || record.activeRun.runId !== pending.runId) {
        throw new Error(`Worker ${record.workerId} lost the exact queued run ${pending.runId} before launch.`);
      }
      if (!lease || lease.workerId !== record.workerId || lease.runId !== pending.runId || lease.parentPid !== process.pid) {
        throw new Error(`Worker ${record.workerId}/${pending.runId} lost its exact launch lease.`);
      }
      const plannedContainer = record.container ?? dependencies.planContainer?.(record, pending.runId, pending.processNonce);
      activeRun = {
        ...record.activeRun,
        status: "running",
        resultFile: pending.resultFile,
        settledFile: path.join(pending.runDir, "settled.json"),
        hostConfigFile: path.join(pending.runDir, "host.json"),
        processFile: pending.processFile,
        processNonce: pending.processNonce,
        container: plannedContainer
      };
      record = {
        ...record,
        status: "running",
        container: plannedContainer,
        activeRun,
        updatedAt: dependencies.now().toISOString()
      };
      writeWorkerRecord(pending.recordFile, record);
      launchAttempted = true;
      handle = dependencies.launch(api, context, {
        record,
        paths: pending.paths,
        prompt: pending.prompt,
        resultFile: pending.resultFile,
        runDir: pending.runDir,
        parentContextSnapshot: pending.parentContextSnapshot,
        processFile: pending.processFile,
        processNonce: pending.processNonce,
        jobId: activeRun.jobId,
        container: activeRun.container
      });
      launchedHandle = handle;
      const processMeta = handle.snapshot();
      const container = handle.container ?? activeRun.container;
      record = {
        ...record,
        container,
        activeRun: {
          ...activeRun,
          pid: processMeta.pid,
          logDir: processMeta.logDir,
          stdoutLog: processMeta.stdoutLog,
          stderrLog: processMeta.stderrLog,
          container
        },
        updatedAt: dependencies.now().toISOString()
      };
      writeWorkerRecord(pending.recordFile, record);
    });
    active.set(record.workerId, { runId: activeRun.runId, handle });
    void handle.completion
      .then(async (job) => {
        await settlePersistedWorkerShells(pending.paths, record.workerId, activeRun.runId, dependencies, false);
        await completeWorkerRun(api, pending, job, dependencies);
      })
      .catch((error) => {
        try {
          markWorkerCleanupUncertain(api, pending, error, true, dependencies);
        } catch (reportError) {
          process.stderr.write(`Worker ${record.workerId} cleanup recovery recording failed: ${reportError instanceof Error ? reportError.message : String(reportError)}\n`);
        }
      })
      .finally(() => {
        if (active.get(record.workerId)?.runId === activeRun.runId) active.delete(record.workerId);
      });
  } catch (error) {
    if (!launchAttempted) {
      const restored = rollbackDeferredResolutionLaunch(pending, dependencies);
      if (restored) {
        sendWorkerResolutionRollback(api, restored, pending.runId, "Resolution resume was rolled back before worker execution because deferred launch did not begin.");
        return;
      }
    }
    if (launchedHandle) {
      try {
        await cancelAttachedWorker(launchedHandle, record, pending.paths, dependencies);
      } catch (cancellationError) {
        markWorkerCleanupUncertain(
          api,
          pending,
          new AggregateError([error, cancellationError], `Worker ${record.workerId} launch failed and cancellation did not settle cleanly.`),
          false,
          dependencies
        );
        return;
      }
    } else if (record.container) {
      try {
        dependencies.removeContainer(record.container);
      } catch (cleanupError) {
        markWorkerCleanupUncertain(
          api,
          pending,
          new AggregateError([error, cleanupError], `Worker ${record.workerId} failed before host launch and its persistent container could not be removed.`),
          true,
          dependencies
        );
        return;
      }
    } else if (error instanceof WorkerContainerCleanupError) {
      markWorkerCleanupUncertain(api, pending, error, true, dependencies);
      return;
    }
    failWorkerLaunch(api, pending, record, error, dependencies);
  }
}

async function completeWorkerRun(
  api: ExtensionAPI,
  pending: PendingWorkerRun,
  job: JobMeta,
  dependencies: WorkerExtensionDependencies
): Promise<void> {
  const current = readWorkerRecord(pending.recordFile);
  const activeRun = current.activeRun;
  if (!activeRun || activeRun.jobId !== job.jobId || activeRun.runId !== pending.runId || activeRun.cleanupOwner) return;
  const runId = activeRun.runId;
  let handoff: AcceptedWorkerHandoff | undefined;
  let status: "handed_off" | "failed" | "cancelled" = job.status === "cancelled" ? "cancelled" : "failed";
  let error: string | undefined;
  let integrationInventory: RepositoryInventorySummary | undefined;
  if (job.status === "exited" && job.exitCode === 0 && existsSync(pending.resultFile)) {
    try {
      readMatchingHostSettlement(path.join(pending.runDir, "settled.json"), current, runId, pending.resultFile);
      handoff = readMatchingWorkerHandoff(pending.resultFile, current.workerId, runId);
      validateIntegrationHandoffShape(handoff.handoff, current.integration);
      status = integrationHandoffFailed(current.integration, handoff) ? "failed" : "handed_off";
      if (status === "failed") error = `Integration worker ended with ${handoff.handoff.state}: ${handoff.handoff.summary}`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  } else if (job.status !== "cancelled") {
    error = job.error ?? `Worker host exited with status ${job.status}${job.exitCode === undefined ? "" : ` (${job.exitCode})`}.`;
  }
  revokeWorkerHostAuthorization(pending.paths, runId);
  if (handoff && current.container) {
    if (!dependencies.parkContainer) throw new Error(`Worker ${current.workerId}/${runId} has no trusted container parking implementation.`);
    dependencies.parkContainer(current.container);
  } else if (handoff && current.integration) {
    throw new Error(`Integration worker ${current.workerId}/${runId} has no exact container to stop before validation.`);
  } else if (!handoff) {
    await settlePersistedWorkerShells(pending.paths, current.workerId, runId, dependencies, false);
  }
  if (handoff && status === "handed_off") {
    try {
      integrationInventory = validateStoppedIntegration(current, handoff, pending.paths, dependencies);
    } catch (cause) {
      status = "failed";
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  if (status !== "handed_off" && current.container) dependencies.removeContainer(current.container);
  finalizeWorkerRunRecord({
    api,
    paths: pending.paths,
    recordFile: pending.recordFile,
    record: current,
    runId,
    job,
    status,
    handoff,
    error,
    resultFile: pending.resultFile,
    repositoryInventory: integrationInventory,
    integrationInventoryHandled: Boolean(current.integration),
    dependencies
  });
}

function integrationHandoffFailed(integration: WorkerIntegrationRecord | undefined, handoff: AcceptedWorkerHandoff): boolean {
  return Boolean(integration && (handoff.handoff.state === "blocked" || handoff.handoff.state === "failed"));
}

function assertPreparedIntegrationBinding(integration: WorkerIntegrationRecord, repository: PreparedRepositoryFold, foldsRoot: string, phase: string): void {
  const artifactFile = path.resolve(foldsRoot, integration.preparedId, repository.artifact.file);
  const valid = repository.candidateId === integration.candidateId && repository.method === integration.method &&
    repository.targetRepo === integration.targetRepo && repository.targetRef === integration.targetRef &&
    repository.targetExpectedCommit === integration.targetExpectedCommit && repository.targetExpectedTree === integration.targetExpectedTree &&
    repository.candidateHeadCommit === integration.candidateHeadCommit && repository.candidateHeadTree === integration.candidateHeadTree &&
    integration.sourceCandidateIds.length === 1 && integration.sourceCandidateIds[0] === repository.candidateId && artifactFile === integration.preparedArtifactFile;
  if (!valid) throw new Error(`Prepared integration identities changed before ${phase}.`);
}

function validateStoppedIntegration(record: WorkerRecord, handoff: AcceptedWorkerHandoff, paths: WorkerPaths, dependencies: WorkerExtensionDependencies): RepositoryInventorySummary | undefined {
  const integration = record.integration;
  if (!integration) return undefined;
  assertIntegrationRecordLayout(integration, record.workspaceRoot, paths.stateDir);
  const expectedRunId = integration.phase === "analysis" ? integration.analysisRunId : integration.resolutionRunId;
  if (!expectedRunId || record.activeRun?.runId !== expectedRunId) throw new Error("Integration phase/run identity changed before settlement.");
  validateStoppedIntegrationHandoff(handoff.handoff, integration, record.workspaceRoot, path.join(paths.stateDir, "integration-runtime"));
  const manifest = readPreparedWorkerFold(dependencies.foldsRoot, integration.preparedId, record.parentSessionFile);
  if (manifest.manifestSha256 !== integration.manifestSha256) throw new Error("Integration prepared manifest changed before settlement.");
  const repository = manifest.repositories.find((item) => item.candidateId === integration.candidateId);
  if (!repository || repository.status !== "resolution_required") throw new Error("Integration resolution case is unavailable at settlement.");
  assertPreparedIntegrationBinding(integration, repository, dependencies.foldsRoot, "settlement");
  assertPreparedTargetCurrent(repository, path.join(paths.stateDir, "integration-target-inspection"));
  if (integration.phase === "resolution") {
    const lineage = integrationLineage(integration, record.workerId);
    const inventory = deriveRepositoryInventory({
      workerId: record.workerId,
      runId: integration.resolutionRunId!,
      workspaceRoot: record.workspaceRoot,
      reposRoot: paths.reposDir,
      handoff,
      initialRepositories: record.initialRepositories,
      generatedAt: dependencies.now().toISOString(),
      trustedStateRoot: path.join(paths.stateDir, "integration-settlement-inventory"),
      integrationLineage: { workspaceRepo: integration.workspaceRepo, lineage }
    });
    const candidate = inventory.candidates[0];
    if (!inventory.scanCoverage.complete || inventory.candidates.length !== 1 || inventory.reportedIssues.length !== 0 || !candidate || candidate.workspaceRepo !== integration.workspaceRepo || !candidate.reported || !candidate.foldable || !candidate.lineage) {
      throw new Error("Integration resolution must settle as exactly one complete foldable lineage-bearing candidate.");
    }
    return persistRepositoryInventory(path.join(paths.stateDir, "runs", integration.resolutionRunId!, "repository-candidates.json"), inventory);
  }
  assertAnalysisRepositoryInventory(record, handoff, paths, dependencies);
  return undefined;
}

function assertAnalysisRepositoryInventory(record: WorkerRecord, handoff: AcceptedWorkerHandoff, paths: WorkerPaths, dependencies: WorkerExtensionDependencies): void {
  const integration = record.integration;
  if (!integration || integration.phase !== "analysis") throw new Error("Integration analysis inventory requires analysis phase state.");
  const inventory = deriveRepositoryInventory({
    workerId: record.workerId,
    runId: integration.analysisRunId,
    workspaceRoot: record.workspaceRoot,
    reposRoot: paths.reposDir,
    handoff,
    initialRepositories: record.initialRepositories,
    generatedAt: dependencies.now().toISOString(),
    trustedStateRoot: path.join(paths.stateDir, "integration-analysis-inventory")
  });
  const repository = inventory.candidates[0];
  if (!inventory.scanCoverage.complete || inventory.reportedIssues.length !== 0 || inventory.candidates.length !== 1 || !repository || repository.workspaceRepo !== integration.workspaceRepo || repository.committedChanged) {
    throw new Error("Integration analysis must retain exactly one unchanged repository and no additional repositories.");
  }
}

function integrationLineage(integration: WorkerIntegrationRecord, workerId: string): RepositoryIntegrationLineage {
  if (integration.phase !== "resolution" || !integration.decisionsSha256 || !integration.resolutionRunId) throw new Error("Integration resolution lineage is incomplete.");
  return {
    kind: "integration_resolution",
    preparedId: integration.preparedId,
    manifestSha256: integration.manifestSha256,
    sourceCandidateIds: [...integration.sourceCandidateIds],
    contextSha256: integration.contextSha256,
    decisionsSha256: integration.decisionsSha256,
    analysisRunId: integration.analysisRunId,
    resolutionWorkerId: workerId,
    resolutionRunId: integration.resolutionRunId,
    workspaceRepo: integration.workspaceRepo,
    targetExpectedCommit: integration.targetExpectedCommit,
    targetExpectedTree: integration.targetExpectedTree
  };
}

function finalizeWorkerRunRecord(input: {
  api: ExtensionAPI;
  paths: WorkerPaths;
  recordFile: string;
  record: WorkerRecord;
  runId: string;
  job: JobMeta;
  status: "handed_off" | "failed" | "cancelled";
  handoff?: AcceptedWorkerHandoff;
  error?: string;
  resultFile: string;
  preserveContainer?: boolean;
  repositoryInventory?: RepositoryInventorySummary;
  integrationInventoryHandled?: boolean;
  dependencies: WorkerExtensionDependencies;
}): void {
  const updated = withWorkerOperationLock(input.paths, () => {
    const current = readWorkerRecord(input.recordFile);
    const lease = readWorkerLease(input.paths.leaseFile);
    if (
      current.activeRun?.runId !== input.runId ||
      !lease ||
      lease.workerId !== current.workerId ||
      lease.runId !== input.runId ||
      lease.parentPid !== process.pid
    ) return undefined;
    let repositoryInventory: RepositoryInventorySummary | undefined = input.repositoryInventory;
    let repositoryError: string | undefined;
    if (input.status === "handed_off" && input.handoff && !input.integrationInventoryHandled) {
      try {
        const inventory = deriveRepositoryInventory({
          workerId: current.workerId,
          runId: input.runId,
          workspaceRoot: current.workspaceRoot,
          reposRoot: input.paths.reposDir,
          handoff: input.handoff,
          initialRepositories: current.initialRepositories,
          generatedAt: input.dependencies.now().toISOString(),
          trustedStateRoot: path.join(path.dirname(input.resultFile), "repository-inspection"),
          integrationLineage: current.integration?.phase === "resolution" ? {
            workspaceRepo: current.integration.workspaceRepo,
            lineage: integrationLineage(current.integration, current.workerId)
          } : undefined
        });
        repositoryInventory = persistRepositoryInventory(
          path.join(path.dirname(input.resultFile), "repository-candidates.json"),
          inventory
        );
      } catch (cause) {
        repositoryError = truncateOneLine(cause instanceof Error ? cause.message : "Repository candidate inspection failed.", 512);
      }
    }
    const next: WorkerRecord = {
      ...current,
      status: input.status,
      container: input.status === "handed_off" && input.preserveContainer !== false ? current.container : undefined,
      activeRun: undefined,
      lastRun: {
        runId: input.runId,
        jobId: input.job.jobId,
        status: input.status,
        resultFile: input.handoff ? input.resultFile : undefined,
        delivery: "pending",
        completionDelivery: resolveCompletionDelivery(current.activeRun.completionDelivery),
        processStatus: input.job.status,
        exitCode: input.job.exitCode,
        pid: input.job.pid,
        logDir: input.job.logDir,
        stdoutLog: input.job.stdoutLog,
        stderrLog: input.job.stderrLog,
        error: input.error,
        repositoryInventory,
        repositoryError
      },
      updatedAt: input.dependencies.now().toISOString()
    };
    writeWorkerRecord(input.recordFile, next);
    releaseWorkerLease(input.paths.leaseFile, next.workerId, input.runId);
    return next;
  });
  if (!updated) return;
  sendWorkerCompletion(input.api, updated, input.job, input.handoff, input.error);
}

function markWorkerCleanupUncertain(
  api: ExtensionAPI,
  pending: PendingWorkerRun,
  cause: unknown,
  hostProcessSettled: boolean,
  dependencies: WorkerExtensionDependencies
): void {
  const error = cause instanceof Error ? cause.message : String(cause);
  const updated = persistWorkerCleanupUncertainty(
    pending.paths,
    pending.runId,
    error,
    hostProcessSettled,
    dependencies
  );
  if (!updated) return;
  api.sendMessage({
    customType: "worker-run-recovery",
    content: `worker cleanup requires recovery: ${updated.workerId}/${pending.runId}\nerror: ${error}\nUse /worker:status and retry /worker:cancel; the run remains active and leased.`,
    display: true,
    details: { workerId: updated.workerId, runId: pending.runId, error }
  }, { triggerTurn: true, deliverAs: "steer" });
}

function persistWorkerCleanupUncertainty(
  paths: WorkerPaths,
  runId: string,
  error: string,
  hostProcessSettled: boolean,
  dependencies: WorkerExtensionDependencies
): WorkerRecord | undefined {
  return withWorkerOperationLock(paths, () => {
    const record = readWorkerRecord(paths.recordFile);
    const lease = readWorkerLease(paths.leaseFile);
    if (
      !record.activeRun ||
      record.activeRun.runId !== runId ||
      !lease ||
      lease.workerId !== record.workerId ||
      lease.runId !== runId ||
      lease.parentPid !== process.pid
    ) return undefined;
    const next: WorkerRecord = {
      ...record,
      status: "running",
      activeRun: { ...record.activeRun, status: "running", recoveryError: error, hostProcessSettled },
      updatedAt: dependencies.now().toISOString()
    };
    writeWorkerRecord(paths.recordFile, next);
    return next;
  });
}

function rollbackDeferredResolutionLaunch(pending: PendingWorkerRun, dependencies: WorkerExtensionDependencies): WorkerRecord | undefined {
  return withWorkerOperationLock(pending.paths, () => {
    const latest = readWorkerRecord(pending.recordFile);
    const integration = latest.integration;
    if (pending.kind !== "resume" || integration?.phase !== "resolution" || integration.resolutionRunId !== pending.runId || !latest.activeRun || !["queued", "running"].includes(latest.activeRun.status) || latest.activeRun.runId !== pending.runId) return undefined;
    const lease = readWorkerLease(pending.paths.leaseFile);
    if (!lease || lease.workerId !== latest.workerId || lease.runId !== pending.runId || lease.parentPid !== process.pid) return undefined;
    if (integration.decisionsFile) rmSync(integration.decisionsFile, { force: true });
    if (integration.workspaceDecisionsFile) rmSync(integration.workspaceDecisionsFile, { force: true });
    const restored: WorkerRecord = {
      ...latest,
      status: "handed_off",
      activeRun: undefined,
      integration: { ...integration, phase: "analysis", decisionsFile: undefined, workspaceDecisionsFile: undefined, decisionsSha256: undefined, resolutionRunId: undefined },
      updatedAt: dependencies.now().toISOString()
    };
    // Release first: a crash here leaves an adoptable queued run, never a completed record with a resolution-run lease.
    releaseWorkerLease(pending.paths.leaseFile, restored.workerId, pending.runId);
    writeWorkerRecord(pending.recordFile, restored);
    return restored;
  });
}

function rollbackQueuedResolutionRecovery(paths: WorkerPaths, workerId: string, runId: string, dependencies: WorkerExtensionDependencies): WorkerRecord | undefined {
  return withWorkerOperationLock(paths, () => {
    const latest = readWorkerRecord(paths.recordFile);
    const integration = latest.integration;
    const lease = readWorkerLease(paths.leaseFile);
    if (latest.workerId !== workerId || latest.activeRun?.runId !== runId || latest.activeRun.status !== "queued" || integration?.phase !== "resolution" || integration.resolutionRunId !== runId) return undefined;
    if (!lease || lease.workerId !== workerId || lease.runId !== runId || lease.parentPid !== process.pid) return undefined;
    assertIntegrationRecordLayout(integration, latest.workspaceRoot, paths.stateDir);
    if (integration.decisionsFile) rmSync(integration.decisionsFile, { force: true });
    if (integration.workspaceDecisionsFile) rmSync(integration.workspaceDecisionsFile, { force: true });
    const restored: WorkerRecord = {
      ...latest,
      status: "handed_off",
      activeRun: undefined,
      integration: { ...integration, phase: "analysis", decisionsFile: undefined, workspaceDecisionsFile: undefined, decisionsSha256: undefined, resolutionRunId: undefined },
      updatedAt: dependencies.now().toISOString()
    };
    // Preserve the same crash invariant during restart-driven rollback.
    releaseWorkerLease(paths.leaseFile, workerId, runId);
    writeWorkerRecord(paths.recordFile, restored);
    return restored;
  });
}

function sendWorkerResolutionRollback(api: ExtensionAPI, record: WorkerRecord, rolledBackRunId: string, reason: string): void {
  api.sendMessage({
    customType: "worker-run",
    content: [
      `worker resolution rollback: ${record.workerId}/${rolledBackRunId}`,
      reason,
      `restored: analysis checkpoint ${record.integration?.analysisRunId ?? "unknown"}`,
      `route: ${record.route.provider}/${record.route.model}:${record.route.thinkingLevel}`,
      `workspace: ${record.workspaceRoot}`
    ].join("\n"),
    display: true,
    details: { deliveryId: `worker-rollback:${record.workerId}:${rolledBackRunId}`, workerId: record.workerId, runId: rolledBackRunId, record, reason }
  }, { triggerTurn: true, deliverAs: "steer" });
}

function failWorkerLaunch(
  api: ExtensionAPI,
  pending: PendingWorkerRun,
  record: WorkerRecord,
  cause: unknown,
  dependencies: WorkerExtensionDependencies
): void {
  const error = cause instanceof Error ? cause.message : String(cause);
  let runId = pending.runId;
  let jobId = "unknown";
  const updated = withWorkerOperationLock(pending.paths, () => {
    const latest = readWorkerRecord(pending.recordFile);
    const activeRun = latest.activeRun;
    const lease = readWorkerLease(pending.paths.leaseFile);
    if (
      !activeRun ||
      activeRun.runId !== pending.runId ||
      !lease ||
      lease.workerId !== latest.workerId ||
      lease.runId !== pending.runId ||
      lease.parentPid !== process.pid
    ) return undefined;
    record = latest;
    runId = activeRun.runId;
    jobId = activeRun.jobId;
    const next: WorkerRecord = {
      ...record,
      status: "failed",
      container: undefined,
      activeRun: undefined,
      lastRun: {
        runId,
        jobId,
        status: "failed",
        delivery: "pending",
        completionDelivery: resolveCompletionDelivery(activeRun.completionDelivery),
        processStatus: "failed",
        logDir: pending.runDir,
        stdoutLog: path.join(pending.runDir, "stdout.log"),
        stderrLog: path.join(pending.runDir, "stderr.log"),
        error
      },
      updatedAt: dependencies.now().toISOString()
    };
    writeWorkerRecord(pending.recordFile, next);
    releaseWorkerLease(pending.paths.leaseFile, next.workerId, runId);
    return next;
  });
  if (!updated) return;
  const job: JobMeta = {
    jobId,
    job_name: `worker ${updated.workerId}`,
    command: `Failed worker launch ${updated.workerId}/${runId}`,
    cwd: updated.workspaceRoot,
    shell: process.execPath,
    status: "failed",
    startedAt: updated.updatedAt,
    endedAt: updated.updatedAt,
    notifyOnExit: false,
    completionNotified: true,
    logDir: pending.runDir,
    stdoutLog: path.join(pending.runDir, "stdout.log"),
    stderrLog: path.join(pending.runDir, "stderr.log"),
    outputBytes: { stdout: 0, stderr: 0 }
  };
  sendWorkerCompletion(api, updated, job, undefined, error);
}

function sendWorkerCompletion(
  api: ExtensionAPI,
  record: WorkerRecord,
  job: JobMeta,
  handoff: AcceptedWorkerHandoff | undefined,
  error: string | undefined
): boolean {
  const runId = record.lastRun?.runId ?? "unknown";
  const lines = [
    `worker result: ${record.workerId}/${runId}`,
    `process: ${job.status}${job.exitCode === undefined ? "" : ` exit=${job.exitCode}`}`,
    `semantic: ${record.status}`,
    `route: ${record.route.provider}/${record.route.model}:${record.route.thinkingLevel}`,
    ...formatRepositoryInventorySummary(record.lastRun?.repositoryInventory),
    record.lastRun?.repositoryError ? `repository_error: ${record.lastRun.repositoryError}` : undefined,
    record.integration ? `integration: ${JSON.stringify(integrationSummary(record.integration))}` : undefined,
    handoff ? `handoff: ${handoff.handoff.state} — ${handoff.handoff.summary}` : undefined,
    handoff ? `handoff_json: ${JSON.stringify(handoff.handoff)}` : undefined,
    error ? `error: ${error}` : undefined,
    `workspace: ${record.workspaceRoot}`,
    `session: ${record.sessionId}`,
    `stdout_log: ${job.stdoutLog}`,
    `stderr_log: ${job.stderrLog}`
  ].filter((line): line is string => line !== undefined);
  try {
    api.sendMessage({
      customType: "worker-run",
      content: lines.join("\n"),
      display: true,
      details: {
        deliveryId: workerCompletionDeliveryId(record.workerId, runId),
        workerId: record.workerId,
        runId,
        record,
        job,
        handoff,
        error
      }
    }, {
      triggerTurn: true,
      deliverAs: resolveCompletionDelivery(record.lastRun?.completionDelivery)
    });
    return true;
  } catch {
    return false;
  }
}

function workerCompletionDeliveryId(workerId: string, runId: string): string {
  return `worker-run:${workerId}:${runId}`;
}

function acknowledgeWorkerCompletionMessage(
  message: unknown,
  context: ExtensionContext,
  dependencies: WorkerExtensionDependencies
): void {
  if (!isRecord(message) || message.role !== "custom" || message.customType !== "worker-run") return;
  const details = message.details;
  if (
    !isRecord(details) ||
    typeof details.deliveryId !== "string" ||
    typeof details.workerId !== "string" ||
    typeof details.runId !== "string"
  ) return;
  if (details.deliveryId !== workerCompletionDeliveryId(details.workerId, details.runId)) return;
  if (!isWorkerId(details.workerId)) return;

  const paths = workerPaths(dependencies.roots, details.workerId);
  if (!existsSync(paths.recordFile)) return;
  const record = readWorkerRecord(paths.recordFile);
  const parentSessionFile = context.sessionManager.getSessionFile();
  if (!parentSessionFile || path.resolve(parentSessionFile) !== path.resolve(record.parentSessionFile)) return;
  if (record.lastRun?.runId !== details.runId || record.lastRun.delivery !== "pending") return;
  markWorkerCompletionDelivered(paths, details.runId, dependencies);
}

function markWorkerCompletionDelivered(
  paths: WorkerPaths,
  runId: string,
  dependencies: WorkerExtensionDependencies
): void {
  withWorkerOperationLock(paths, () => {
    if (!existsSync(paths.recordFile)) return;
    const record = readWorkerRecord(paths.recordFile);
    if (record.lastRun?.runId !== runId || record.lastRun.delivery !== "pending") return;
    writeWorkerRecord(paths.recordFile, {
      ...record,
      lastRun: { ...record.lastRun, delivery: "delivered" },
      updatedAt: dependencies.now().toISOString()
    });
  });
}

async function adoptWorkerRuns(
  api: ExtensionAPI,
  context: ExtensionContext,
  dependencies: WorkerExtensionDependencies,
  active: Map<string, { runId: string; handle: ManagedWorkerHandle }>,
  monitors: Map<string, NodeJS.Timeout>
): Promise<void> {
  const parentSessionFile = context.sessionManager.getSessionFile();
  if (!parentSessionFile || !existsSync(dependencies.roots.stateRoot)) return;
  for (const entry of readdirSync(dependencies.roots.stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("worker_")) continue;
    try {
      const paths = workerPaths(dependencies.roots, entry.name);
      if (!existsSync(paths.recordFile)) {
        recoverOrphanedWorkerPreparation(paths);
        continue;
      }
      const record = readWorkerRecord(paths.recordFile);
      if (path.resolve(record.parentSessionFile) !== path.resolve(parentSessionFile)) continue;
      if (!record.activeRun) {
        releaseStaleCompletedLease(paths);
        continue;
      }
      if (active.has(record.workerId)) continue;
      if (await reconcileRecoveredWorkerRun(api, paths, record, dependencies)) continue;
      let reconciling = false;
      const monitor = setInterval(async () => {
        if (reconciling) return;
        reconciling = true;
        try {
          const current = readWorkerRecord(paths.recordFile);
          if (!current.activeRun) {
            releaseStaleCompletedLease(paths);
            clearInterval(monitor);
            monitors.delete(record.workerId);
            return;
          }
          if (await reconcileRecoveredWorkerRun(api, paths, current, dependencies)) {
            clearInterval(monitor);
            monitors.delete(record.workerId);
          }
        } catch {
          clearInterval(monitor);
          monitors.delete(record.workerId);
        } finally {
          reconciling = false;
        }
      }, 500);
      monitor.unref();
      monitors.set(record.workerId, monitor);
    } catch (error) {
      context.ui.notify(`Unable to adopt managed worker ${entry.name}: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }
}

function releaseStaleCompletedLease(paths: WorkerPaths): void {
  withWorkerOperationLock(paths, () => {
    if (!existsSync(paths.recordFile)) return;
    const record = readWorkerRecord(paths.recordFile);
    const lease = readWorkerLease(paths.leaseFile);
    if (record.activeRun || !record.lastRun || !lease) return;
    if (lease.workerId !== record.workerId || lease.runId !== record.lastRun.runId) {
      throw new Error(`Worker ${record.workerId} has a mismatched completed-run lease.`);
    }
    if (isAsyncJobProcessAlive(lease.parentPid)) return;
    releaseWorkerLease(paths.leaseFile, lease.workerId, lease.runId);
  });
}

function recoverOrphanedWorkerPreparation(paths: WorkerPaths): void {
  withWorkerOperationLock(paths, () => {
    if (existsSync(paths.recordFile)) return;
    const lease = readWorkerLease(paths.leaseFile);
    if (!lease || isAsyncJobProcessAlive(lease.parentPid)) return;
    releaseWorkerLease(paths.leaseFile, lease.workerId, lease.runId);
    rmSync(paths.workspaceRoot, { recursive: true, force: true });
    rmSync(paths.stateDir, { recursive: true, force: true });
  });
}

async function reconcileRecoveredWorkerRun(
  api: ExtensionAPI,
  paths: WorkerPaths,
  record: WorkerRecord,
  dependencies: WorkerExtensionDependencies
): Promise<boolean> {
  const run = record.activeRun;
  if (!run) return true;
  if (run.status === "running") {
    const recoveredPid = verifiedWorkerHostPid(record);
    if (recoveredPid !== undefined) {
      if (run.pid !== recoveredPid) {
        withWorkerOperationLock(paths, () => {
          const current = readWorkerRecord(paths.recordFile);
          const lease = readWorkerLease(paths.leaseFile);
          if (current.activeRun?.runId !== run.runId || current.activeRun.status !== "running") return;
          if (lease && (lease.workerId !== current.workerId || lease.runId !== run.runId)) {
            throw new Error(`Worker ${current.workerId}/${run.runId} has a mismatched recovery lease.`);
          }
          if (lease && lease.parentPid !== process.pid && isAsyncJobProcessAlive(lease.parentPid)) return;
          writeWorkerRecord(paths.recordFile, {
            ...current,
            activeRun: { ...current.activeRun, pid: recoveredPid },
            updatedAt: dependencies.now().toISOString()
          });
        });
      }
      return false;
    }
    if (run.pid !== undefined && isAsyncJobProcessGroupAlive(run.pid)) return false;
    if (dependencies.now().getTime() - Date.parse(record.updatedAt) < 5_000) return false;
    if (!isWorkerHostProcessSettled(record)) {
      revokeWorkerHostAuthorization(paths, run.runId);
      return false;
    }
  }

  if (!claimWorkerRecoveryLease(paths, record, run.runId, dependencies)) return false;
  if (run.status === "queued" && record.integration?.phase === "resolution" && record.integration.resolutionRunId === run.runId) {
    if (!record.container || !dependencies.parkContainer) {
      persistWorkerCleanupUncertainty(paths, run.runId, "Queued integration resolution lost its exact parked container before rollback.", true, dependencies);
      return false;
    }
    try { dependencies.parkContainer(record.container); }
    catch (cause) {
      persistWorkerCleanupUncertainty(paths, run.runId, cause instanceof Error ? cause.message : String(cause), true, dependencies);
      return false;
    }
    const restored = rollbackQueuedResolutionRecovery(paths, record.workerId, run.runId, dependencies);
    if (!restored) return false;
    sendWorkerResolutionRollback(api, restored, run.runId, "Queued resolution resume was rolled back after parent restart before worker execution began.");
    return true;
  }
  try {
    await settlePersistedWorkerShells(paths, record.workerId, run.runId, dependencies, false);
  } catch (cause) {
    persistWorkerCleanupUncertainty(
      paths,
      run.runId,
      cause instanceof Error ? cause.message : String(cause),
      isWorkerHostProcessSettled(readWorkerRecord(paths.recordFile)),
      dependencies
    );
    return false;
  }
  const resultFile = run.resultFile ?? path.join(paths.stateDir, "runs", run.runId, "result.json");
  const settledFile = run.settledFile ?? path.join(paths.stateDir, "runs", run.runId, "settled.json");
  let handoff: AcceptedWorkerHandoff | undefined;
  let status: "handed_off" | "failed" = "failed";
  let error: string | undefined;
  let integrationInventory: RepositoryInventorySummary | undefined;
  if (existsSync(resultFile) && existsSync(settledFile)) {
    try {
      readMatchingHostSettlement(settledFile, record, run.runId, resultFile);
      handoff = readMatchingWorkerHandoff(resultFile, record.workerId, run.runId);
      validateIntegrationHandoffShape(handoff.handoff, record.integration);
      status = integrationHandoffFailed(record.integration, handoff) ? "failed" : "handed_off";
      if (status === "failed") error = `Integration worker ended with ${handoff.handoff.state}: ${handoff.handoff.summary}`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  } else {
    error = run.status === "queued"
      ? `Parent exited before queued worker ${record.workerId}/${run.runId} launched.`
      : existsSync(resultFile)
        ? `Worker ${record.workerId}/${run.runId} exited before the host verified final session identity and quiescence.`
        : `Worker ${record.workerId}/${run.runId} exited without a typed handoff.`;
  }
  revokeWorkerHostAuthorization(paths, run.runId);
  if (record.container) {
    try {
      if (status === "handed_off") {
        if (!dependencies.parkContainer) throw new Error("Worker container parking is unavailable during recovery.");
        dependencies.parkContainer(record.container);
      } else dependencies.removeContainer(record.container);
    } catch (cause) {
      persistWorkerCleanupUncertainty(paths, run.runId, cause instanceof Error ? cause.message : String(cause), true, dependencies);
      return false;
    }
  } else if (handoff && record.integration) {
    persistWorkerCleanupUncertainty(paths, run.runId, "Recovered integration run has no exact container to stop before validation.", true, dependencies);
    return false;
  }
  if (handoff && status === "handed_off") {
    try { integrationInventory = validateStoppedIntegration(record, handoff, paths, dependencies); }
    catch (cause) {
      status = "failed";
      error = cause instanceof Error ? cause.message : String(cause);
      if (record.container) {
        try { dependencies.removeContainer(record.container); }
        catch (cleanupCause) {
          persistWorkerCleanupUncertainty(paths, run.runId, cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause), true, dependencies);
          return false;
        }
      }
    }
  }
  const logDir = run.logDir ?? path.join(paths.stateDir, "runs", run.runId);
  const stdoutLog = run.stdoutLog ?? path.join(logDir, "stdout.log");
  const stderrLog = run.stderrLog ?? path.join(logDir, "stderr.log");
  const recoveredJob: JobMeta = {
    jobId: run.jobId,
    job_name: `worker ${record.workerId}`,
    command: `Recovered worker ${record.workerId}/${run.runId}`,
    cwd: record.workspaceRoot,
    shell: process.execPath,
    status: handoff ? "exited" : "unknown",
    pid: run.pid,
    startedAt: record.updatedAt,
    endedAt: dependencies.now().toISOString(),
    notifyOnExit: false,
    completionNotified: true,
    logDir,
    stdoutLog,
    stderrLog,
    outputBytes: asyncJobOutputBytes(stdoutLog, stderrLog)
  };
  finalizeWorkerRunRecord({
    api,
    paths,
    recordFile: paths.recordFile,
    record,
    runId: run.runId,
    job: recoveredJob,
    status,
    handoff,
    error,
    resultFile,
    preserveContainer: status === "handed_off",
    repositoryInventory: integrationInventory,
    integrationInventoryHandled: Boolean(record.integration),
    dependencies
  });
  return true;
}

function claimWorkerRecoveryLease(
  paths: WorkerPaths,
  record: WorkerRecord,
  runId: string,
  dependencies: WorkerExtensionDependencies
): boolean {
  try {
    return withWorkerOperationLock(paths, () => {
      const current = readWorkerRecord(paths.recordFile);
      if (current.activeRun?.runId !== runId) return false;
      const lease = readWorkerLease(paths.leaseFile);
      if (lease) {
        if (lease.workerId !== record.workerId || lease.runId !== runId) {
          throw new Error(`Worker ${record.workerId}/${runId} has a mismatched recovery lease.`);
        }
        if (lease.parentPid === process.pid) return true;
        if (isAsyncJobProcessAlive(lease.parentPid)) return false;
        releaseWorkerLease(paths.leaseFile, record.workerId, runId);
      }
      acquireWorkerRunLease(paths, record.workerId, runId, dependencies.now());
      if (current.activeRun?.cleanupOwner) {
        writeWorkerRecord(paths.recordFile, {
          ...current,
          activeRun: { ...current.activeRun, cleanupOwner: undefined },
          updatedAt: dependencies.now().toISOString()
        });
      }
      return true;
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("lifecycle operation is already active")) return false;
    throw error;
  }
}

function readMatchingHostSettlement(
  settledFile: string,
  record: WorkerRecord,
  runId: string,
  resultFile: string
): void {
  const settlement = readWorkerHostSettlement(settledFile);
  if (
    settlement.workerId !== record.workerId ||
    settlement.runId !== runId ||
    settlement.sessionId !== record.sessionId ||
    path.resolve(settlement.resultFile) !== path.resolve(resultFile)
  ) {
    throw new Error(`Worker host settlement identity mismatch for ${record.workerId}/${runId}.`);
  }
}

function readMatchingWorkerHandoff(
  resultFile: string,
  workerId: string,
  runId: string
): AcceptedWorkerHandoff {
  const handoff = readWorkerRuntimeHandoff(resultFile);
  if (handoff.workerId !== workerId || handoff.runId !== runId) {
    throw new Error(`Worker handoff identity mismatch for ${workerId}/${runId}.`);
  }
  return handoff;
}

function cancelledWorkerRecord(record: WorkerRecord, now: Date, deliverCompletion: boolean): WorkerRecord {
  if (!record.activeRun) return record;
  return {
    ...record,
    status: "cancelled",
    container: undefined,
    activeRun: undefined,
    lastRun: {
      runId: record.activeRun.runId,
      jobId: record.activeRun.jobId,
      status: "cancelled",
      delivery: deliverCompletion ? "pending" : "delivered",
      completionDelivery: resolveCompletionDelivery(record.activeRun.completionDelivery),
      processStatus: "cancelled"
    },
    updatedAt: now.toISOString()
  };
}

function queuedCancellationJob(paths: WorkerPaths, previous: WorkerRecord, cancelled: WorkerRecord): JobMeta {
  const run = previous.activeRun;
  if (!run) throw new Error(`Worker ${previous.workerId} has no queued run to report as cancelled.`);
  const logDir = run.logDir ?? path.join(paths.stateDir, "runs", run.runId);
  return {
    jobId: run.jobId,
    job_name: `worker ${previous.workerId}`,
    command: `Cancelled queued worker ${previous.workerId}/${run.runId}`,
    cwd: previous.workspaceRoot,
    shell: process.execPath,
    status: "cancelled",
    startedAt: previous.updatedAt,
    endedAt: cancelled.updatedAt,
    notifyOnExit: false,
    completionNotified: true,
    logDir,
    stdoutLog: run.stdoutLog ?? path.join(logDir, "stdout.log"),
    stderrLog: run.stderrLog ?? path.join(logDir, "stderr.log"),
    outputBytes: { stdout: 0, stderr: 0 }
  };
}

function ensureWorkerRecoveryLease(
  paths: WorkerPaths,
  record: WorkerRecord,
  runId: string,
  dependencies: WorkerExtensionDependencies
): boolean {
  const lease = readWorkerLease(paths.leaseFile);
  if (lease?.workerId === record.workerId && lease.runId === runId && lease.parentPid === process.pid) return true;
  return claimWorkerRecoveryLease(paths, record, runId, dependencies);
}

function finalizeRecoveredWorkerCancellation(
  api: ExtensionAPI,
  paths: WorkerPaths,
  record: WorkerRecord,
  runId: string,
  dependencies: WorkerExtensionDependencies,
  requireCurrentLeaseOwner = true,
  cleanupOwner?: string,
  deliverCompletion = true
): boolean {
  const run = record.activeRun;
  if (!run || run.runId !== runId) return false;
  const logDir = run.logDir ?? path.join(paths.stateDir, "runs", runId);
  const stdoutLog = run.stdoutLog ?? path.join(logDir, "stdout.log");
  const stderrLog = run.stderrLog ?? path.join(logDir, "stderr.log");
  const endedAt = dependencies.now().toISOString();
  const job: JobMeta = {
    jobId: run.jobId,
    job_name: `worker ${record.workerId}`,
    command: `Recovered cancellation ${record.workerId}/${runId}`,
    cwd: record.workspaceRoot,
    shell: process.execPath,
    status: "cancelled",
    pid: run.pid,
    startedAt: record.updatedAt,
    endedAt,
    notifyOnExit: false,
    completionNotified: true,
    logDir,
    stdoutLog,
    stderrLog,
    outputBytes: asyncJobOutputBytes(stdoutLog, stderrLog)
  };
  const updated = withWorkerOperationLock(paths, () => {
    const current = readWorkerRecord(paths.recordFile);
    const lease = readWorkerLease(paths.leaseFile);
    if (current.activeRun?.runId !== runId || !lease || lease.workerId !== current.workerId || lease.runId !== runId) {
      return undefined;
    }
    if (requireCurrentLeaseOwner && lease.parentPid !== process.pid) return undefined;
    if (cleanupOwner && current.activeRun.cleanupOwner !== cleanupOwner) return undefined;
    const next: WorkerRecord = {
      ...current,
      status: "cancelled",
      container: undefined,
      activeRun: undefined,
      lastRun: {
        runId,
        jobId: job.jobId,
        status: "cancelled",
        delivery: deliverCompletion ? "pending" : "delivered",
        completionDelivery: resolveCompletionDelivery(current.activeRun.completionDelivery),
        processStatus: "cancelled",
        pid: job.pid,
        logDir,
        stdoutLog,
        stderrLog,
        error: run.recoveryError
      },
      updatedAt: endedAt
    };
    writeWorkerRecord(paths.recordFile, next);
    releaseWorkerLease(paths.leaseFile, current.workerId, runId);
    return next;
  });
  if (updated && deliverCompletion) sendWorkerCompletion(api, updated, job, undefined, run.recoveryError);
  return updated !== undefined;
}

function claimWorkerCancellationOwnership(
  paths: WorkerPaths,
  record: WorkerRecord,
  runId: string,
  dependencies: WorkerExtensionDependencies
): string | undefined {
  if (!ensureWorkerRecoveryLease(paths, record, runId, dependencies)) return undefined;
  return withWorkerOperationLock(paths, () => {
    const current = readWorkerRecord(paths.recordFile);
    const lease = readWorkerLease(paths.leaseFile);
    if (
      current.activeRun?.runId !== runId ||
      current.activeRun.cleanupOwner ||
      !lease ||
      lease.workerId !== current.workerId ||
      lease.runId !== runId ||
      lease.parentPid !== process.pid
    ) return undefined;
    const cleanupOwner = randomUUID();
    writeWorkerRecord(paths.recordFile, {
      ...current,
      activeRun: { ...current.activeRun, cleanupOwner },
      updatedAt: dependencies.now().toISOString()
    });
    return cleanupOwner;
  });
}

function releaseWorkerCancellationOwnership(
  paths: WorkerPaths,
  runId: string,
  cleanupOwner: string,
  dependencies: WorkerExtensionDependencies
): void {
  withWorkerOperationLock(paths, () => {
    const current = readWorkerRecord(paths.recordFile);
    if (current.activeRun?.runId !== runId || current.activeRun.cleanupOwner !== cleanupOwner) return;
    writeWorkerRecord(paths.recordFile, {
      ...current,
      activeRun: { ...current.activeRun, cleanupOwner: undefined },
      updatedAt: dependencies.now().toISOString()
    });
  });
}

async function cancelAttachedWorker(
  handle: ManagedWorkerHandle,
  record: WorkerRecord,
  paths: WorkerPaths,
  dependencies: WorkerExtensionDependencies
): Promise<void> {
  const pid = handle.snapshot().pid;
  if (pid === undefined) handle.cancel("SIGTERM");
  else await terminateWorkerProcessGroup(pid, (signal) => handle.cancel(signal), record);
  const settled = await handle.completion;
  await settlePersistedWorkerShells(paths, record.workerId, record.activeRun?.runId ?? "unknown", dependencies);
  if (settled.status !== "cancelled" && settled.status !== "exited") {
    throw new Error(`Worker ${record.workerId}/${record.activeRun?.runId ?? "unknown"} did not settle after cancellation: ${settled.status}.`);
  }
}

async function cancelDetachedWorker(
  record: WorkerRecord,
  paths: WorkerPaths,
  dependencies: WorkerExtensionDependencies
): Promise<void> {
  const pid = verifiedWorkerHostPid(record);
  if (pid === undefined) {
    throw new Error(`Worker ${record.workerId}/${record.activeRun?.runId ?? "unknown"} is not attached and has no verified host process.`);
  }
  await terminateWorkerProcessGroup(pid, (signal) => signalRecordedProcess(pid, signal), record);
  await settlePersistedWorkerShells(paths, record.workerId, record.activeRun?.runId ?? "unknown", dependencies);
}

async function settlePersistedWorkerShells(
  paths: WorkerPaths,
  workerId: string,
  runId: string,
  dependencies: WorkerExtensionDependencies,
  removeContainer = true
): Promise<void> {
  revokeWorkerHostAuthorization(paths, runId);
  const owner = { kind: "worker-run" as const, workerId, runId };
  let shellError: unknown;
  try {
    await cancelPersistedAsyncShellJobsForOwner(path.join(paths.stateDir, "async-shell"), owner);
  } catch (error) {
    shellError = error;
  }

  let containerError: unknown;
  const current = readWorkerRecord(paths.recordFile);
  const container = current.activeRun?.runId === runId ? current.activeRun.container ?? current.container : undefined;
  if (removeContainer && container) {
    try {
      dependencies.removeContainer(container);
    } catch (error) {
      containerError = error;
    }
  }

  if (shellError && !containerError) {
    try {
      await cancelPersistedAsyncShellJobsForOwner(path.join(paths.stateDir, "async-shell"), owner);
      shellError = undefined;
    } catch (error) {
      shellError = error;
    }
  }
  if (removeContainer && container && !containerError) {
    withWorkerOperationLock(paths, () => {
      const latest = readWorkerRecord(paths.recordFile);
      if (latest.activeRun?.runId !== runId) return;
      const recorded = latest.activeRun.container ?? latest.container;
      if (!recorded || !sameWorkerContainer(recorded, container)) return;
      writeWorkerRecord(paths.recordFile, {
        ...latest,
        container: undefined,
        activeRun: { ...latest.activeRun, container: undefined }
      });
    });
  }
  if (shellError || containerError) {
    const errors = [shellError, containerError].filter((error) => error !== undefined);
    const reasons = errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
    throw new AggregateError(
      errors,
      `Worker ${workerId}/${runId} shell or container cleanup could not be verified: ${reasons}`
    );
  }
}

function revokeWorkerHostAuthorization(paths: WorkerPaths, runId: string): void {
  rmSync(path.join(paths.stateDir, "runs", runId, "host-authorization.json"), { force: true });
}

function sameWorkerContainer(left: WorkerContainerReference, right: WorkerContainerReference): boolean {
  return left.workerId === right.workerId &&
    left.runId === right.runId &&
    left.name === right.name &&
    left.nonce === right.nonce &&
    left.containerId === right.containerId;
}

async function terminateWorkerProcessGroup(
  pid: number,
  signal: (signal: NodeJS.Signals) => void,
  record: WorkerRecord
): Promise<void> {
  signal("SIGTERM");
  if (await waitForRecordedProcessExit(pid, 4_000)) return;
  signal("SIGKILL");
  if (!(await waitForRecordedProcessExit(pid, 2_000))) {
    throw new Error(`Worker ${record.workerId}/${record.activeRun?.runId ?? "unknown"} survived SIGKILL.`);
  }
}

function signalRecordedProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    signalAsyncJobProcessGroup(pid, signal);
  } catch (error) {
    if (isAsyncJobProcessGroupAlive(pid)) throw error;
  }
}

function verifiedWorkerHostPid(record: WorkerRecord): number | undefined {
  const run = record.activeRun;
  if (!run?.processFile || !run.processNonce || !run.hostConfigFile) return undefined;
  if (!existsSync(run.processFile)) {
    if (run.pid !== undefined && isAsyncJobProcessGroupAlive(run.pid) && recordedWorkerHostCommandMatches(run.pid, run.hostConfigFile)) {
      return run.pid;
    }
    return undefined;
  }
  let marker: ReturnType<typeof readWorkerHostProcess>;
  try {
    marker = readWorkerHostProcess(run.processFile);
  } catch {
    return undefined;
  }
  if (
    marker.workerId !== record.workerId ||
    marker.runId !== run.runId ||
    marker.nonce !== run.processNonce ||
    path.resolve(marker.hostConfigFile) !== path.resolve(run.hostConfigFile) ||
    (run.pid !== undefined && run.pid !== marker.pid) ||
    !isAsyncJobProcessGroupAlive(marker.pid)
  ) return undefined;
  if (isAsyncJobProcessAlive(marker.pid) && !recordedWorkerHostCommandMatches(marker.pid, run.hostConfigFile)) return undefined;
  return marker.pid;
}

function recordedWorkerHostCommandMatches(pid: number, hostConfigFile: string): boolean {
  try {
    const command = execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return command.includes(path.resolve(hostConfigFile));
  } catch {
    return false;
  }
}

function isWorkerHostProcessSettled(record: WorkerRecord): boolean {
  const run = record.activeRun;
  if (!run) return true;
  const pids = new Set<number>();
  if (run.pid !== undefined) pids.add(run.pid);
  if (run.processFile && existsSync(run.processFile)) {
    try {
      const marker = readWorkerHostProcess(run.processFile);
      if (marker.workerId === record.workerId && marker.runId === run.runId) pids.add(marker.pid);
    } catch {
      if (pids.size === 0) return false;
    }
  }
  return pids.size > 0 && Array.from(pids).every((pid) => !isAsyncJobProcessGroupAlive(pid));
}

async function waitForRecordedProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAsyncJobProcessGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAsyncJobProcessGroupAlive(pid);
}

function assertWorkerParentSession(record: WorkerRecord, context: ExtensionContext): void {
  const sessionFile = context.sessionManager.getSessionFile();
  if (!sessionFile || path.resolve(sessionFile) !== path.resolve(record.parentSessionFile)) {
    throw new Error(`Worker ${record.workerId} belongs to a different parent session.`);
  }
}

export function resolveWorkerRoute(requested: string | undefined, context: ExtensionContext): WorkerRoute {
  const fallbackThinkingLevel = (context.thinkingLevel ?? "xhigh") as ThinkingLevel;
  const route = requested?.trim() || readWorkerSettings().defaultRoute;
  const resolved = resolveExtensionModel({
    registry: context.modelRegistry,
    requested: route,
    fallbackThinkingLevel,
    label: "Worker",
    noModelMessage: "No worker route is configured. Set worker-settings.json defaultRoute or pass route."
  });
  return {
    provider: resolved.model.provider,
    model: resolved.model.id,
    thinkingLevel: resolved.thinkingLevel
  };
}

function receipt(record: WorkerRecord): WorkerRunReceipt {
  if (!record.activeRun) throw new Error(`Worker ${record.workerId} has no active run receipt.`);
  return {
    workerId: record.workerId,
    runId: record.activeRun.runId,
    jobId: record.activeRun.jobId,
    sessionId: record.sessionId,
    sessionFile: record.sessionFile,
    workspaceRoot: record.workspaceRoot,
    taskIds: [...record.taskIds],
    provider: record.route.provider,
    model: record.route.model,
    thinkingLevel: record.route.thinkingLevel,
    completionDelivery: resolveCompletionDelivery(record.activeRun.completionDelivery),
    state: record.activeRun.status
  };
}

export function buildNewWorkerPrompt(
  record: WorkerRecord,
  guidance: string | undefined,
  initialRepos: Array<{ source: string; revision?: string }> | undefined
): string {
  return [
    `You are managed worker ${record.workerId} in workspace ${record.workspaceRoot}.`,
    `Assigned Beads: ${record.taskIds.join(", ")}.`,
    "The parent session was forked into this exact worker session. Work only on the assigned scope.",
    `Trusted implementation role skill:
${managedWorkerRoleSkillText("implementation")}`,
    WORKER_OPERATIONAL_GUIDANCE,
    initialRepos?.length ? `Initial repositories requested:\n${initialRepos.map((repo) => `- ${repo.source}${repo.revision ? ` @ ${repo.revision}` : ""}`).join("\n")}` : undefined,
    guidance?.trim() ? `Parent guidance:\n${guidance.trim()}` : undefined
  ].filter((part): part is string => part !== undefined).join("\n\n");
}

export function buildIntegrationAnalysisPrompt(record: WorkerRecord): string {
  const integration = record.integration!;
  return [
    `You are integration worker ${record.workerId} in ANALYSIS-ONLY phase for prepared fold ${integration.preparedId}.`,
    `Read the immutable parent-curated context at ${integration.workspaceContextFile}.`,
    `Inspect ${integration.workspaceRepo} for prepared ${integration.method} integration at exact target ${integration.targetExpectedCommit} and exact candidate ref refs/heads/integration-candidate (${integration.candidateHeadCommit}).`,
    "Do not modify repository HEAD, refs, index, worktree, ignored/untracked files, or config. Unreferenced Git objects are benign, but experiments and clones belong only below workspace scratch, never below repos/. Analyze the conflict, report no repositories, propose an exact plan, identify questions and assumptions, and finish resumably only with worker_handoff state checkpoint or needs_input; use blocked or failed only for an honest terminal failure. Any repository mutation or completion claim is rejected.",
    `Trusted integration role skill:\n${managedWorkerRoleSkillText("integration")}`,
    WORKER_OPERATIONAL_GUIDANCE
  ].join("\n\n");
}

export function buildIntegrationResolutionPrompt(record: WorkerRecord, message: string, parentContextSnapshot: string): string {
  const integration = record.integration!;
  return [
    `Resume integration worker ${record.workerId} in RESOLUTION phase for prepared fold ${integration.preparedId}.`,
    `The original immutable context is ${integration.workspaceContextFile}; settled parent decisions are ${integration.workspaceDecisionsFile}.`,
    `Resolve only ${integration.workspaceRepo} using prepared method ${integration.method}. Start from exact target ${integration.targetExpectedCommit}; integrate exact candidate ${integration.candidateHeadCommit} from refs/heads/integration-candidate according to settled decisions. Commit the result locally, do not push, and report ${integration.workspaceRepo} in worker_handoff.`,
    `Fresh parent context snapshot: ${parentContextSnapshot}`,
    `Parent resume message: ${message}`,
    `Trusted integration role skill:\n${managedWorkerRoleSkillText("integration")}`,
    WORKER_OPERATIONAL_GUIDANCE
  ].join("\n\n");
}

function formatWorkerFoldResolveReceipt(details: WorkerFoldResolveDetails): string {
  return [
    `integration_worker: ${details.workerId}`,
    `run: ${details.runId}`,
    `phase: ${details.phase}`,
    `method: ${details.method}`,
    `prepared_fold: ${details.preparedId}`,
    `manifest_sha256: ${details.manifestSha256}`,
    `candidate: ${details.candidateId}`,
    `context_sha256: ${details.contextSha256}`,
    details.decisionsSha256 ? `decisions_sha256: ${details.decisionsSha256}` : undefined,
    `session: ${details.sessionId}`,
    `workspace: ${details.workspaceRoot}`,
    `route: ${details.provider}/${details.model}:${details.thinkingLevel}`,
    `state: ${details.state}`
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function buildResumeWorkerPrompt(record: WorkerRecord, message: string, parentContextSnapshot: string): string {
  return [
    `Resume managed worker ${record.workerId} in the exact existing session and workspace.`,
    `Assigned Beads: ${record.taskIds.join(", ")}.`,
    `A fresh mode-0400 snapshot of the completed parent session for this resume is available at ${parentContextSnapshot}.`,
    `Trusted implementation role skill:\n${managedWorkerRoleSkillText("implementation")}`,
    WORKER_OPERATIONAL_GUIDANCE,
    `Parent update:\n${message.trim()}`
  ].join("\n\n");
}

type WorkerRenderTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type WorkerRenderOptions = {
  expanded: boolean;
  isPartial?: boolean;
};

type WorkerRenderContext = {
  isError?: boolean;
};

function renderWorkerRunCall(args: WorkerRunInput, theme: WorkerRenderTheme): Text {
  const runs = isRecord(args) && Array.isArray(args.runs) ? args.runs.filter(isRecord) : [];
  const summaries = runs.map((run) => {
    if (run.kind === "resume") return `resume ${typeof run.workerId === "string" ? shortWorkerId(run.workerId) : "worker"}`;
    const tasks = Array.isArray(run.taskIds) ? run.taskIds.length : 0;
    const route = typeof run.route === "string" ? ` · ${truncateOneLine(run.route, 32)}` : "";
    return `new · ${tasks} ${tasks === 1 ? "task" : "tasks"}${route}`;
  });
  const summary = runs.length === 0
    ? "no runs"
    : runs.length === 1
      ? summaries[0]!
      : `${runs.length} runs · ${summaries.slice(0, 2).join(", ")}${runs.length > 2 ? `, +${runs.length - 2}` : ""}`;
  return new Text(workerToolCall("Worker", summary, theme), 0, 0);
}

function renderWorkerRunResult(
  result: AgentToolResult<WorkerRunDetails>,
  options: WorkerRenderOptions,
  theme: WorkerRenderTheme,
  context?: WorkerRenderContext
): Text {
  const error = renderWorkerToolError(result, theme, context);
  if (error !== undefined) return error;
  if (options.isPartial) return new Text(workerToolResult("starting workers", "warning", theme), 0, 0);

  const runs = result.details?.runs ?? [];
  if (runs.length === 0) return new Text(workerToolResult("no workers", "muted", theme), 0, 0);
  const stateCounts = countWorkerStates(runs.map((run) => run.state));
  const summary = runs.length === 1
    ? formatWorkerRunState(runs[0]!)
    : `${runs.length} workers · ${formatWorkerStateCounts(stateCounts)}`;
  const lines = [workerToolResult(summary, workerStateColor(runs.map((run) => run.state)), theme)];
  if (options.expanded) {
    appendBoundedWorkerRows(lines, runs.map(formatWorkerRunDetail));
  }
  return new Text(lines.join("\n"), 0, 0);
}

function renderWorkerFoldPrepareCall(args: WorkerFoldPrepareInput, theme: WorkerRenderTheme): Text {
  const count = isRecord(args) && Array.isArray(args.repositories) ? args.repositories.length : 0;
  return new Text(workerToolCall("Worker Fold", `${count} ${count === 1 ? "repository" : "repositories"}`, theme), 0, 0);
}

function renderWorkerFoldPrepareResult(
  result: AgentToolResult<PreparedWorkerFoldSummary>,
  options: WorkerRenderOptions,
  theme: WorkerRenderTheme,
  context?: WorkerRenderContext
): Text {
  const error = renderWorkerToolError(result, theme, context);
  if (error !== undefined) return error;
  if (options.isPartial) return new Text(workerToolResult("preparing repositories", "warning", theme), 0, 0);
  const details = result.details;
  if (!details) return new Text(workerToolResult("fold preparation complete", "muted", theme), 0, 0);
  const summary = `${details.status} · ${shortWorkerId(details.preparedId)} · ${details.repositoryCount} ${details.repositoryCount === 1 ? "repository" : "repositories"}${details.resolutionCaseCount > 0 ? ` · ${details.resolutionCaseCount} resolution ${details.resolutionCaseCount === 1 ? "case" : "cases"}` : ""}${details.overlapCount > 0 ? ` · ${details.overlapCount} ${details.overlapCount === 1 ? "overlap" : "overlaps"}` : ""}`;
  const lines = [workerToolResult(summary, details.status === "ready" ? "success" : "warning", theme)];
  if (options.expanded) appendBoundedWorkerRows(lines, details.repositories.map((item) => `${shortWorkerId(item.candidateId)} · ${item.method} · ${item.status} · ${truncateOneLine(item.targetRef, 80)}`));
  return new Text(lines.join("\n"), 0, 0);
}

function renderWorkerFoldResolveCall(args: unknown, theme: WorkerRenderTheme): Text {
  const request = isRecord(args) && isRecord(args.request) ? args.request : undefined;
  const kind = request?.kind === "resume" ? "resume" : request?.kind === "start" ? "start" : undefined;
  const phase = kind === "resume" ? "resume resolution" : kind === "start" ? "start analysis" : "integration";
  const rawIdentity = kind === "resume" ? request?.workerId : kind === "start" ? request?.candidateId : undefined;
  const identity = typeof rawIdentity === "string" && rawIdentity ? shortWorkerId(rawIdentity) : "pending input";
  return new Text(workerToolCall("Worker Resolve", `${phase} · ${identity}`, theme), 0, 0);
}

function renderWorkerFoldResolveResult(result: AgentToolResult<WorkerFoldResolveDetails>, options: WorkerRenderOptions, theme: WorkerRenderTheme, context?: WorkerRenderContext): Text {
  const error = renderWorkerToolError(result, theme, context);
  if (error !== undefined) return error;
  if (options.isPartial) return new Text(workerToolResult("starting integration worker", "warning", theme), 0, 0);
  const details = result.details;
  if (!details) return new Text(workerToolResult("integration worker queued", "muted", theme), 0, 0);
  const lines = [workerToolResult(`${details.phase}/${details.method} · ${shortWorkerId(details.workerId)} · ${shortWorkerId(details.preparedId)} · ${details.state}`, "warning", theme)];
  if (options.expanded) appendBoundedWorkerRows(lines, [`${details.provider}/${details.model}:${details.thinkingLevel}`, `context ${details.contextSha256}${details.decisionsSha256 ? ` · decisions ${details.decisionsSha256}` : ""}`]);
  return new Text(lines.join("\n"), 0, 0);
}

function renderWorkerControlCall(args: WorkerControlInput, theme: WorkerRenderTheme): Text {
  const action = isRecord(args) && typeof args.action === "string" ? truncateOneLine(args.action, 24) : "status";
  const workerId = isRecord(args) && typeof args.workerId === "string" ? args.workerId : undefined;
  const target = workerId ? shortWorkerId(workerId) : action === "status" ? "all" : "worker";
  return new Text(workerToolCall("Worker", `${action} · ${target}`, theme), 0, 0);
}

function renderWorkerControlResult(
  result: AgentToolResult<WorkerControlDetails>,
  options: WorkerRenderOptions,
  theme: WorkerRenderTheme,
  context?: WorkerRenderContext
): Text {
  const error = renderWorkerToolError(result, theme, context);
  if (error !== undefined) return error;
  if (options.isPartial) return new Text(workerToolResult("checking workers", "warning", theme), 0, 0);

  const details = result.details;
  if (details === undefined) return new Text(workerToolResult("worker control complete", "muted", theme), 0, 0);
  const lines = [workerToolResult(formatWorkerControlSummary(details), workerControlColor(details), theme)];
  if (options.expanded) appendWorkerControlDetails(lines, details);
  return new Text(lines.join("\n"), 0, 0);
}

function renderWorkerToolError(
  result: AgentToolResult<unknown>,
  theme: WorkerRenderTheme,
  context?: WorkerRenderContext
): Text | undefined {
  if (context?.isError !== true) return undefined;
  const text = result.content.map((item) => item.type === "text" ? item.text : "").join("\n").trim();
  return new Text(workerToolResult(`error: ${truncateOneLine(text || "Tool failed.", 160)}`, "error", theme), 0, 0);
}

const MAX_RENDERED_WORKER_ROWS = 8;

function formatWorkerRunState(run: WorkerRunReceipt): string {
  return `${run.state} · ${shortWorkerId(run.workerId)} · ${run.taskIds.length} ${run.taskIds.length === 1 ? "task" : "tasks"} · ${run.completionDelivery}`;
}

function formatWorkerRunDetail(run: WorkerRunReceipt): string {
  return `${shortWorkerId(run.workerId)} · ${run.state} · ${formatWorkerRoute(run)} · ${run.completionDelivery} · ${formatWorkerTasks(run.taskIds)} · run ${shortWorkerId(run.runId)} · job ${shortWorkerId(run.jobId)}`;
}

function appendWorkerControlDetails(lines: string[], details: WorkerControlDetails): void {
  switch (details.action) {
    case "status":
      appendBoundedWorkerRows(lines, details.workers.map(formatWorkerControlDetail));
      return;
    case "result":
      lines.push(`  run ${shortWorkerId(details.runId)} · job ${shortWorkerId(details.jobId)} · ${details.delivery ?? "delivery unknown"} · ${details.completionDelivery} · ${formatWorkerTasks(details.taskIds)}`);
      if (details.handoff) lines.push(`  ${details.handoff.handoff.state}: ${truncateOneLine(details.handoff.handoff.summary, 160)}`);
      if (details.repositories) {
        appendBoundedWorkerRows(lines, details.repositories.candidates.map((candidate) =>
          `${shortWorkerId(candidate.candidateId)} · ${truncateOneLine(candidate.workspaceRepo, 100)} · ${candidate.foldable ? "foldable" : candidate.committedChanged ? "committed, blocked" : "no committed delta"}${candidate.dirty ? " · dirty" : " · clean"}${candidate.reported ? "" : " · unreported"}`
        ));
        if (details.repositories.reportedIssues.length > 0) lines.push(`  ${details.repositories.reportedIssues.length} reported repository ${details.repositories.reportedIssues.length === 1 ? "issue" : "issues"}`);
        if (!details.repositories.scanCoverage.complete) lines.push(`  scan incomplete: ${details.repositories.scanCoverage.limitations.join(", ")}`);
      }
      if (details.repositoryError) lines.push(`  repository error: ${truncateOneLine(details.repositoryError, 160)}`);
      return;
    case "cancel":
      if (details.runId || details.jobId) lines.push(`  ${details.runId ? `run ${shortWorkerId(details.runId)}` : "run unknown"} · ${details.jobId ? `job ${shortWorkerId(details.jobId)}` : "job unknown"}`);
      return;
    case "discard":
      return;
  }
}

function formatWorkerControlDetail(worker: WorkerControlSummary): string {
  const run = worker.activeRun
    ? `active ${shortWorkerId(worker.activeRun.runId)} · job ${shortWorkerId(worker.activeRun.jobId)}`
    : worker.lastRun
      ? `last ${worker.lastRun.status} · ${shortWorkerId(worker.lastRun.runId)}`
      : "no runs";
  const repositories = worker.lastRun?.repositoryInventory
    ? ` · ${worker.lastRun.repositoryInventory.candidateCount} ${worker.lastRun.repositoryInventory.candidateCount === 1 ? "candidate" : "candidates"}`
    : "";
  return `${shortWorkerId(worker.workerId)} · ${worker.status} · ${formatWorkerRoute(worker.route)} · ${formatWorkerTasks(worker.taskIds)} · ${run}${repositories}`;
}

function appendBoundedWorkerRows(lines: string[], rows: string[]): void {
  for (const row of rows.slice(0, MAX_RENDERED_WORKER_ROWS)) lines.push(`  ${row}`);
  const hidden = rows.length - Math.min(rows.length, MAX_RENDERED_WORKER_ROWS);
  if (hidden > 0) lines.push(`  +${hidden} more`);
}

function formatWorkerRoute(route: { provider: string; model: string; thinkingLevel: string }): string {
  return `${route.provider}/${route.model}:${route.thinkingLevel}`;
}

function formatWorkerTasks(taskIds: string[]): string {
  const visible = taskIds.slice(0, 2).join(", ");
  const hidden = taskIds.length - Math.min(taskIds.length, 2);
  return taskIds.length === 0 ? "no tasks" : hidden > 0 ? `${visible}, +${hidden}` : visible;
}

function formatWorkerControlSummary(details: WorkerControlDetails): string {
  switch (details.action) {
    case "status": {
      if (details.workers.length === 0) return "no workers";
      return `${details.workers.length} ${details.workers.length === 1 ? "worker" : "workers"} · ${formatWorkerStateCounts(countWorkerStates(details.workers.map((worker) => worker.status)))}`;
    }
    case "result":
      return `result · ${details.status} · ${shortWorkerId(details.workerId)}${details.handoff ? ` · ${details.handoff.handoff.state}` : ""}${details.repositories ? ` · ${details.repositories.candidates.length} ${details.repositories.candidates.length === 1 ? "candidate" : "candidates"}` : ""}`;
    case "cancel":
      return `${details.outcome === "not_active" ? "not active" : "cancelled"} · ${shortWorkerId(details.workerId)} · ${details.status}`;
    case "discard":
      return `discarded · ${shortWorkerId(details.workerId)}`;
  }
}

function countWorkerStates(states: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  return counts;
}

function formatWorkerStateCounts(counts: Map<string, number>): string {
  return Array.from(counts.entries()).map(([state, count]) => `${count} ${state}`).join(", ");
}

function workerStateColor(states: readonly string[]): string {
  return states.some((state) => state === "failed" || state === "cancelled") ? "warning" : states.every((state) => state === "queued") ? "warning" : "success";
}

function workerControlColor(details: WorkerControlDetails): string {
  if (details.action === "cancel") return details.outcome === "cancelled" ? "warning" : "muted";
  if (details.action === "result") return details.status === "failed" || details.status === "cancelled" ? "warning" : "success";
  return "success";
}

function shortWorkerId(value: string): string {
  const oneLine = truncateOneLine(value, 128);
  return oneLine.length <= 20 ? oneLine : `${oneLine.slice(0, 10)}…${oneLine.slice(-7)}`;
}

function truncateOneLine(value: string, maxLength: number): string {
  const oneLine = value.replace(/[\r\n]+/g, " ").trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

function workerToolCall(name: string, summary: string, theme: WorkerRenderTheme): string {
  return theme.fg("toolTitle", `⏺ ${theme.bold(name)}(`) + theme.fg("accent", summary) + theme.fg("toolTitle", ")…");
}

function workerToolResult(summary: string, color: string, theme: WorkerRenderTheme): string {
  return theme.fg("muted", "⎿ ") + theme.fg(color, summary);
}

function formatWorkerRunReceipt(value: WorkerRunReceipt): string {
  return [
    `worker_id: ${value.workerId}`,
    `run_id: ${value.runId}`,
    `job_id: ${value.jobId}`,
    `session_id: ${value.sessionId}`,
    value.sessionFile ? `session_file: ${value.sessionFile}` : "session_file: pending exact post-turn fork",
    `workspace_root: ${value.workspaceRoot}`,
    `task_ids: ${value.taskIds.join(", ")}`,
    `route: ${value.provider}/${value.model}:${value.thinkingLevel}`,
    `completion_delivery: ${value.completionDelivery}`,
    `state: ${value.state}`
  ].join("\n");
}

function integrationSummary(integration: WorkerIntegrationRecord | undefined): WorkerControlSummary["integration"] {
  return integration ? {
    phase: integration.phase,
    method: integration.method,
    preparedId: integration.preparedId,
    manifestSha256: integration.manifestSha256,
    candidateId: integration.candidateId,
    sourceCandidateIds: [...integration.sourceCandidateIds],
    workspaceRepo: integration.workspaceRepo,
    targetRepo: integration.targetRepo,
    targetRef: integration.targetRef,
    targetExpectedCommit: integration.targetExpectedCommit,
    candidateHeadCommit: integration.candidateHeadCommit,
    contextSha256: integration.contextSha256,
    analysisRunId: integration.analysisRunId,
    decisionsSha256: integration.decisionsSha256,
    resolutionRunId: integration.resolutionRunId
  } : undefined;
}

function workerControlSummary(record: WorkerRecord): WorkerControlSummary {
  return {
    workerId: record.workerId,
    status: record.status,
    sessionId: record.sessionId,
    sessionFile: record.sessionFile,
    workspaceRoot: record.workspaceRoot,
    taskIds: [...record.taskIds],
    route: { ...record.route },
    integration: integrationSummary(record.integration),
    container: record.container ? {
      name: record.container.name,
      containerId: record.container.containerId,
      runId: record.container.runId
    } : undefined,
    activeRun: record.activeRun ? {
      runId: record.activeRun.runId,
      jobId: record.activeRun.jobId,
      status: record.activeRun.status,
      completionDelivery: resolveCompletionDelivery(record.activeRun.completionDelivery),
      recoveryError: record.activeRun.recoveryError,
      stdoutLog: record.activeRun.stdoutLog,
      stderrLog: record.activeRun.stderrLog
    } : undefined,
    lastRun: record.lastRun ? {
      runId: record.lastRun.runId,
      jobId: record.lastRun.jobId,
      status: record.lastRun.status,
      delivery: record.lastRun.delivery,
      completionDelivery: resolveCompletionDelivery(record.lastRun.completionDelivery),
      resultFile: record.lastRun.resultFile,
      stdoutLog: record.lastRun.stdoutLog,
      stderrLog: record.lastRun.stderrLog,
      error: record.lastRun.error,
      repositoryInventory: record.lastRun.repositoryInventory ? {
        ...record.lastRun.repositoryInventory,
        candidates: record.lastRun.repositoryInventory.candidates.map((candidate) => ({ ...candidate, policyIssues: [...candidate.policyIssues], lineage: candidate.lineage ? { ...candidate.lineage, sourceCandidateIds: [...candidate.lineage.sourceCandidateIds] } : undefined })),
        reportedIssues: record.lastRun.repositoryInventory.reportedIssues.map((item) => ({ ...item })),
        scanCoverage: {
          complete: record.lastRun.repositoryInventory.scanCoverage.complete,
          limitations: [...record.lastRun.repositoryInventory.scanCoverage.limitations]
        }
      } : undefined,
      repositoryError: record.lastRun.repositoryError
    } : undefined,
    updatedAt: record.updatedAt
  };
}

function formatWorkerControlResult(record: WorkerRecord, handoff: AcceptedWorkerHandoff | undefined): string {
  const lastRun = record.lastRun;
  if (!lastRun) throw new Error(`Worker ${record.workerId} has no settled result.`);
  return [
    `worker result: ${record.workerId}/${lastRun.runId}`,
    `job: ${lastRun.jobId}`,
    `semantic: ${lastRun.status}`,
    `delivery: ${lastRun.delivery ?? "not required"} · ${resolveCompletionDelivery(lastRun.completionDelivery)}`,
    `tasks: ${record.taskIds.join(", ")}`,
    `route: ${record.route.provider}/${record.route.model}:${record.route.thinkingLevel}`,
    record.integration ? `integration: ${JSON.stringify(integrationSummary(record.integration))}` : undefined,
    handoff ? `handoff: ${handoff.handoff.state} — ${handoff.handoff.summary}` : undefined,
    handoff ? `handoff_json: ${JSON.stringify(handoff.handoff)}` : undefined,
    ...formatRepositoryInventorySummary(lastRun.repositoryInventory),
    lastRun.repositoryError ? `repository_error: ${lastRun.repositoryError}` : undefined,
    lastRun.error ? `error: ${lastRun.error}` : undefined,
    `workspace: ${record.workspaceRoot}`,
    `session: ${record.sessionId}`,
    lastRun.resultFile ? `result_file: ${lastRun.resultFile}` : undefined,
    lastRun.stdoutLog ? `stdout_log: ${lastRun.stdoutLog}` : undefined,
    lastRun.stderrLog ? `stderr_log: ${lastRun.stderrLog}` : undefined
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatWorkerFoldPrepareSummary(summary: PreparedWorkerFoldSummary): string {
  return [
    `prepared_fold: ${summary.preparedId}`,
    `status: ${summary.status}`,
    `repositories: ${summary.repositoryCount}`,
    `resolution_cases: ${summary.resolutionCaseCount}`,
    `overlaps: ${summary.overlapCount}`,
    ...summary.repositories.map((item) => `repository: ${item.candidateId} · ${item.method} · ${item.status} · ${item.targetRepo}#${item.targetRef} · expected ${item.expectedCommit}${item.desiredCommit ? ` · desired ${item.desiredCommit}` : ""} · artifact ${item.artifactFile} · view ${item.viewPath}`),
    `manifest: ${summary.manifestFile}`,
    `manifest_sha256: ${summary.manifestSha256}`
  ].join("\n");
}

function formatRepositoryInventorySummary(summary: RepositoryInventorySummary | undefined): string[] {
  if (!summary) return [];
  const candidates = summary.candidates.slice(0, 8).map((candidate) =>
    `candidate: ${candidate.candidateId} · ${truncateOneLine(candidate.workspaceRepo, 120)} · ${candidate.foldable ? "foldable" : candidate.committedChanged ? "committed, blocked" : "no committed delta"}${candidate.dirty ? " · dirty" : " · clean"}${candidate.reported ? " · reported" : " · unreported"}${candidate.policyIssues.length > 0 ? ` · ${candidate.policyIssues.slice(0, 3).join(",")}` : ""}`
  );
  const reportedIssues = summary.reportedIssues.map((item) =>
    `reported_repository_issue: ${item.kind} · ${truncateOneLine(item.workspaceRepo, 120)}`
  );
  return [
    `repositories: ${summary.candidateCount} ${summary.candidateCount === 1 ? "candidate" : "candidates"} · ${summary.foldableCount} foldable · ${summary.reportedIssueCount} reported path issues · scan ${summary.scanCoverage.complete ? "complete" : `incomplete (${summary.scanCoverage.limitations.join(",")})`}`,
    ...candidates,
    summary.candidates.length > candidates.length ? `repository_candidates_omitted: ${summary.candidates.length - candidates.length}` : undefined,
    ...reportedIssues,
    `repository_inventory: ${summary.inventoryFile}`
  ].filter((line): line is string => line !== undefined);
}

function isActiveWorkerRecord(record: WorkerRecord): boolean {
  return record.status === "queued" || record.status === "running";
}

function formatWorkerList(
  records: WorkerRecord[],
  options: { showAll: boolean; totalCount: number }
): string {
  if (records.length === 0) {
    if (options.totalCount === 0) return "No managed workers belong to this chat.";
    return `No active managed workers belong to this chat. Use /worker:list --all to include ${options.totalCount} settled ${options.totalCount === 1 ? "worker" : "workers"}.`;
  }
  const states = formatWorkerStateCounts(countWorkerStates(records.map((record) => record.status)));
  const visibleRecords = records.slice(0, 100);
  const hidden = records.length - visibleRecords.length;
  const scope = options.showAll ? "managed" : "active managed";
  return [
    `${records.length} ${scope} ${records.length === 1 ? "worker" : "workers"} in this chat · ${states}`,
    ...visibleRecords.map((record) => {
      const run = record.activeRun
        ? `active ${record.activeRun.status} · ${record.activeRun.runId}`
        : record.lastRun
          ? `last ${record.lastRun.status} · ${record.lastRun.runId}`
          : "no runs";
      return `- ${record.workerId} · ${record.route.provider}/${record.route.model}:${record.route.thinkingLevel} · ${formatWorkerTasks(record.taskIds)} · ${run}`;
    }),
    hidden > 0 ? `+${hidden} more workers; use /worker:status <worker-id> for any known worker.` : undefined,
    !options.showAll && options.totalCount > records.length
      ? `Use /worker:list --all to include ${options.totalCount - records.length} settled ${options.totalCount - records.length === 1 ? "worker" : "workers"}.`
      : undefined,
    "Use /worker:status <worker-id> for full details."
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatWorkerRecord(record: WorkerRecord): string {
  return [
    `Worker ${record.workerId}: ${record.status}`,
    `Session: ${record.sessionId}${record.sessionFile ? ` · ${record.sessionFile}` : " · fork pending"}`,
    `Workspace: ${record.workspaceRoot}`,
    `Route: ${formatModelName({ provider: record.route.provider, id: record.route.model })}:${record.route.thinkingLevel}`,
    record.integration ? `Integration: ${JSON.stringify(integrationSummary(record.integration))}` : undefined,
    `Tasks: ${record.taskIds.join(", ")}`,
    record.container ? `Container: ${record.container.name} · ${record.container.containerId?.slice(0, 12) ?? "planned"} · created for ${record.container.runId}` : "Container: not created",
    record.activeRun ? `Active run: ${record.activeRun.runId} · ${record.activeRun.jobId} · ${record.activeRun.status}` : undefined,
    record.activeRun?.recoveryError ? `Recovery required: ${record.activeRun.recoveryError}` : undefined,
    record.lastRun ? `Last run: ${record.lastRun.runId} · ${record.lastRun.status} · delivery ${record.lastRun.delivery ?? "not required"} · ${resolveCompletionDelivery(record.lastRun.completionDelivery)}` : undefined,
    ...formatRepositoryInventorySummary(record.lastRun?.repositoryInventory),
    record.lastRun?.repositoryError ? `Repository inspection: ${record.lastRun.repositoryError}` : undefined
  ].filter((line): line is string => line !== undefined).join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertWorkerFoldResolveInput(value: unknown): asserts value is WorkerFoldResolveInput {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.request)) throw new Error("worker_fold_resolve requires one exact request envelope.");
  const request = value.request;
  if (request.kind === "start") {
    const allowed = new Set(["kind", "preparedId", "manifestSha256", "candidateId", "taskIds", "context", "route", "completionDelivery"]);
    if (Object.keys(request).some((key) => !allowed.has(key))) throw new Error("worker_fold_resolve start requires only start-phase fields.");
    if (typeof request.preparedId !== "string" || typeof request.manifestSha256 !== "string" || typeof request.candidateId !== "string" || !Array.isArray(request.taskIds) || !isRecord(request.context)) throw new Error("worker_fold_resolve start is missing required start-phase fields.");
    return;
  }
  if (request.kind === "resume") {
    const allowed = new Set(["kind", "workerId", "message", "settledDecisions", "completionDelivery"]);
    if (Object.keys(request).some((key) => !allowed.has(key))) throw new Error("worker_fold_resolve resume requires only resume-phase fields.");
    if (typeof request.workerId !== "string" || typeof request.message !== "string" || !Array.isArray(request.settledDecisions)) throw new Error("worker_fold_resolve resume is missing required resume-phase fields.");
    return;
  }
  throw new Error("worker_fold_resolve request kind must be start or resume.");
}

function normalizeSettledDecisions(values: readonly string[]): string[] {
  const normalized = values.map((value) => value.trim());
  if (normalized.length < 1 || normalized.some((value) => !value) || Buffer.byteLength(JSON.stringify(normalized), "utf8") > 128 * 1024) {
    throw new Error("worker_fold_resolve settledDecisions must contain bounded non-empty decisions.");
  }
  return normalized;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function validatePersonalTaskIds(taskIds: readonly string[]): void {
  if (taskIds.length > MAX_WORKER_TASK_IDS) {
    throw new Error(`Managed workers support at most ${MAX_WORKER_TASK_IDS} assigned task IDs.`);
  }
  const invalid = taskIds.find((taskId) => !/^personal-[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*$/.test(taskId.trim()));
  if (invalid) throw new Error(`Managed worker task IDs must use the central personal prefix: ${invalid}`);
}

function defaultDependencies(): WorkerExtensionDependencies {
  const roots = defaultWorkerRoots();
  return {
    roots,
    now: () => new Date(),
    random: () => randomUUID(),
    pinRepositories: (requested, trustedStateRoot) => pinInitialRepositories(requested, trustedStateRoot),
    foldsRoot: defaultWorkerFoldsRoot(roots.stateRoot),
    targetRoot: path.join(homedir(), "Code"),
    prepareFold: prepareRepositoryChangeSet,
    reviewWorker: runIndependentReview,
    planContainer: (record, runId, nonce) => planWorkerContainer({
      workerId: record.workerId,
      runId,
      nonce,
      workspaceRoot: record.workspaceRoot
    }),
    parkContainer: (container) => parkWorkerContainer(resolveDockerPath(), container),
    removeContainer: (container) => settleWorkerContainer(resolveDockerPath(), container),
    launch: (api, context, request) => {
      if (!request.container) throw new Error(`Worker ${request.record.workerId}/${request.record.activeRun?.runId ?? "unknown"} lost its planned Docker identity.`);
      const dockerPath = resolveDockerPath();
      let container = request.container;
      try {
        container = createWorkerContainer(dockerPath, request.container);
        const launched = launchWorkerHost(api, context, {
          ...request,
          shellExecution: { kind: "docker", dockerPath, container }
        });
        return Object.assign(launched.handle, { container });
      } catch (cause) {
        rmSync(path.join(request.runDir, "host-authorization.json"), { force: true });
        try {
          settleWorkerContainer(dockerPath, container);
        } catch (cleanupError) {
          throw new WorkerContainerCleanupError(
            [cause, cleanupError],
            `Worker ${request.record.workerId} host launch failed and its Docker container could not be removed.`
          );
        }
        throw cause;
      }
    }
  };
}
