import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import { WORKER_ID_PATTERN } from "../_shared/worker-id.js";
import type { WorkerOutcome, WorkerRole } from "./registry.js";

const TaskId = Type.String({ minLength: 1, maxLength: 128, pattern: "^personal-[a-zA-Z0-9]+(?:\\.[a-zA-Z0-9]+)*$" });
const WorkerId = Type.String({ minLength: 30, maxLength: 128, pattern: WORKER_ID_PATTERN, description: "Worker identity returned by worker_run or worker_control list. It must belong to the current parent session." });
const RunId = Type.String({ minLength: 1, maxLength: 128, pattern: "^run_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", description: "Exact run identity returned by worker_run, worker_control runs, or a completion notification." });
const PreparedId = Type.String({ pattern: "^prepared_[0-9a-f]{24}$", description: "Prepared repository-set identity returned by worker_merge_test." });
const CompletionDelivery = Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")], { default: "steer", description: "When to deliver the asynchronous result. Use `steer` as soon as it is ready. Use `followUp` for lower-priority work that can wait until the current agent run would otherwise stop. Defaults to `steer`." }));
const RepositoryBaseline = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4096, description: "Absolute path to a local Git repository readable by the tool and worker Sandbox." }),
  revision: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Optional Git revision to pin as the exact baseline commit. Accepts a commit, branch, tag, or other valid revision; defaults to the repository’s current HEAD." }))
}, { additionalProperties: false });

export const StartWork = Type.Object({
  action: Type.Literal("start", { description: "Start a new worker in the specified role." }),
  role: Type.Literal("work", { description: "Perform a substantial implementation, research, analysis, testing, or other self-contained assignment." }),
  taskIds: Type.Array(TaskId, { minItems: 1, maxItems: 32, uniqueItems: true, description: "One or more Beads task IDs assigned to the worker. The worker may read broader task context but may update only its assigned tasks." }),
  instructions: Type.String({ minLength: 1, maxLength: 12 * 1024, description: "Focused instructions for the assignment. State the goal, scope, important decisions or non-goals, and expected checks or result without repeating the full parent transcript." }),
  repositoryBaselines: Type.Optional(Type.Array(RepositoryBaseline, { maxItems: 16, description: "Provenance-only local Git repositories for the parent to validate and pin at exact commits. Baseline paths are not mounted into or guaranteed reachable from the worker workspace; the worker performs any needed clones using `git clone --no-local --no-hardlinks`. Up to sixteen baselines may be supplied." })),
  modelSelection: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: "Optional exact provider/model:thinking override, for example openai-codex/gpt-5.6-sol:xhigh. Normally omit it to use the configured work-role selection. The override is honored exactly or the launch fails. Max thinking and Claude Fable selections are rejected." })),
  completionDelivery: CompletionDelivery
}, { additionalProperties: false });
export const StartReview = Type.Object({
  action: Type.Literal("start", { description: "Start a new worker in the specified role." }),
  role: Type.Literal("review", { description: "Independently review the latest completed run of a work or integration worker using a different configured provider; launch fails if no independent provider is available." }),
  reviewedRunId: Type.String({ minLength: 1, maxLength: 128, pattern: "^run_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", description: "Run to review. It must be the latest completed run of a work or integration worker. The review worker automatically receives its complete workspace, repository and artifact entry points, candidate inventories, and session." }),
  instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 12 * 1024, description: "Optional review guidance. Omit for a general review. Use to emphasize risks, ask questions, supply acceptance criteria, or guide a follow-up review. The reviewer still reports material issues outside the requested focus." })),
  additionalInputs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 16, uniqueItems: true, description: "Additional files or directories outside the reviewed workspace to mount read-only for the reviewer. Use for prior review reports, datasets, specifications, reference trees, or other relevant context." })),
  completionDelivery: CompletionDelivery
}, { additionalProperties: false });
export const StartIntegration = Type.Object({
  action: Type.Literal("start", { description: "Start a new worker in the specified role." }),
  role: Type.Literal("integration", { description: "Resolve all repository conflicts in one prepared set." }),
  preparedId: Type.String({ pattern: "^prepared_[0-9a-f]{24}$", description: "ID returned by worker_merge_test when one or more repository merges need conflict resolution. The integration worker automatically receives the exact candidate and target repositories, conflict details, and required ordering." }),
  taskIds: Type.Array(TaskId, { minItems: 1, maxItems: 32, uniqueItems: true, description: "One or more Beads task IDs the integration worker may read and update." }),
  instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 12 * 1024, description: "Optional guidance for resolving the conflicts. Use for decisions, priorities, constraints, or acceptance criteria the worker would not otherwise know." })),
  additionalInputs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 16, uniqueItems: true, description: "Additional files or directories to mount read-only for the integration worker. The prepared repositories and conflict details are included automatically." })),
  completionDelivery: CompletionDelivery
}, { additionalProperties: false });
export const ResumeWorker = Type.Object({
  action: Type.Literal("resume", { description: "Continue a previous worker in its retained role, workspace, session, and model selection." }),
  workerId: Type.String({ minLength: 30, maxLength: 128, pattern: WORKER_ID_PATTERN, description: "Previous worker to continue. It must belong to the current parent session and have no active run." }),
  instructions: Type.String({ minLength: 1, maxLength: 12 * 1024, description: "Instructions for continuing the worker. State the answer, feedback, settled decision, correction, or next action without repeating context retained in its session." }),
  additionalTaskIds: Type.Optional(Type.Array(TaskId, { minItems: 1, maxItems: 32, uniqueItems: true, description: "Optional additional Beads task IDs for a work or integration worker. Existing assignments remain available and cannot be removed through resume. Not allowed for review workers." })),
  additionalInputs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 16, uniqueItems: true, description: "Additional files or directories to mount read-only for the resumed run. Existing workspace contents and previously supplied context remain available automatically." })),
  completionDelivery: CompletionDelivery
}, { additionalProperties: false });
export const WorkerRunParamsV2 = Type.Object({ runs: Type.Array(Type.Union([StartWork, StartReview, StartIntegration, ResumeWorker]), { minItems: 1, maxItems: 8, description: "Workers to start or resume in this call. Include one to eight entries; batch only independent assignments that benefit from parallel execution." }) }, { additionalProperties: false });
export type WorkerRunInputV2 = Static<typeof WorkerRunParamsV2>;

const ListControl = Type.Object({
  action: Type.Literal("list", { description: "List retained workers, optionally filtered by current status or role." }),
  status: Type.Optional(Type.Union([Type.Literal("idle"), Type.Literal("queued"), Type.Literal("running")], { description: "Optional current-worker filter for list." })),
  role: Type.Optional(Type.Union([Type.Literal("work"), Type.Literal("review"), Type.Literal("integration")], { description: "Optional worker-role filter for list." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20, description: "Maximum number of records to return. Defaults to 20 and cannot exceed 100." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0, description: "Number of records to skip in the stable result order. Defaults to zero." }))
}, { additionalProperties: false });
const RunsControl = Type.Object({ action: Type.Literal("runs", { description: "List the execution runs belonging to one worker, newest first." }), workerId: WorkerId, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20, description: "Maximum number of records to return. Defaults to 20 and cannot exceed 100." })), offset: Type.Optional(Type.Integer({ minimum: 0, default: 0, description: "Number of records to skip in the stable result order. Defaults to zero." })) }, { additionalProperties: false });
const GetControl = Type.Object({ action: Type.Literal("get", { description: "Inspect one exact active or settled run, including operational access and any submitted result." }), workerId: WorkerId, runId: RunId }, { additionalProperties: false });
const CancelControl = Type.Object({ action: Type.Literal("cancel", { description: "Stop a worker's active run while preserving its worker, workspace, session, and retained evidence." }), workerId: WorkerId }, { additionalProperties: false });
const DiscardControl = Type.Object({ action: Type.Literal("discard", { description: "Permanently delete an idle worker and all of its retained workspace, session, run, and evidence data." }), workerId: WorkerId }, { additionalProperties: false });
const WorkerControlStrict = Type.Union([ListControl, RunsControl, GetControl, CancelControl, DiscardControl]);
export const WorkerControlParamsV2 = Type.Unsafe<Static<typeof WorkerControlStrict>>({
  ...WorkerControlStrict, type: "object", required: ["action"], additionalProperties: false,
  properties: {
    action: Type.Union([Type.Literal("list"), Type.Literal("runs"), Type.Literal("get"), Type.Literal("cancel"), Type.Literal("discard")]),
    workerId: Type.Optional(WorkerId), runId: Type.Optional(RunId),
    status: Type.Optional(Type.Union([Type.Literal("idle"), Type.Literal("queued"), Type.Literal("running")], { description: "Optional current-worker filter for list." })),
    role: Type.Optional(Type.Union([Type.Literal("work"), Type.Literal("review"), Type.Literal("integration")], { description: "Optional worker-role filter for list." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20, description: "Maximum number of records to return. Defaults to 20 and cannot exceed 100." })),
    offset: Type.Optional(Type.Integer({ minimum: 0, default: 0, description: "Number of records to skip in the stable result order. Defaults to zero." }))
  }
});
export type WorkerControlInputV2 = Static<typeof WorkerControlStrict>;

const MergeRepositoryId = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", description: "Request-local repository identity. Dependencies refer to these IDs." });
const MergeRepository = Type.Object({
  id: MergeRepositoryId,
  candidateRepo: Type.String({ minLength: 1, maxLength: 4096, description: "Absolute local Git repository containing the candidate revision. Managed, historical, prepared, and other local candidates are accepted after exact Git validation." }),
  candidateRef: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Candidate Git revision to resolve exactly; defaults to HEAD." })),
  targetRepo: Type.String({ minLength: 1, maxLength: 4096, description: "Absolute authoritative local Git repository." }),
  targetRef: Type.String({ pattern: "^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$", description: "Canonical target branch reference." }),
  method: Type.Union([Type.Literal("merge"), Type.Literal("squash")], { description: "Required preparation method." }),
  commitMessage: Type.String({ minLength: 1, maxLength: 16 * 1024, description: "Non-empty prepared commit message, at most 16 KiB UTF-8 and containing no NUL." }),
  dependsOn: Type.Optional(Type.Array(MergeRepositoryId, { maxItems: 15, uniqueItems: true, description: "Unique request-local repository IDs that must be prepared first." }))
}, { additionalProperties: false });
export const WorkerMergeTestParams = Type.Object({ repositories: Type.Array(MergeRepository, { minItems: 1, maxItems: 16, description: "Repository candidates and explicit targets to prepare as one logical set." }) }, { additionalProperties: false });
export const WorkerMergeApplyParams = Type.Object({ preparedId: PreparedId }, { additionalProperties: false });

const ResultSummary = Type.String({ minLength: 1, maxLength: 2048, description: "Concise account of the result, useful progress, remaining risk, or reason the work could not continue." });
const ResultQuestion = Type.Optional(Type.String({ minLength: 1, maxLength: 2048, description: "Specific question the parent must answer before work can continue. Required for needs_input and not allowed for other outcomes." }));
const ResultArtifacts = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 32, description: "Files or directories that are useful result entry points. Paths may be absolute within the worker workspace or relative to the workspace; the tool stores normalized relative paths." }));
export const WorkerWorkResultSubmitParams = Type.Object({
  outcome: Type.Union([Type.Literal("completed"), Type.Literal("needs_input"), Type.Literal("blocked")], { description: "Why this work or integration run is ending." }),
  summary: ResultSummary,
  question: ResultQuestion,
  repositories: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 16, description: "Git repository directories produced or changed by the worker. Paths may be absolute within the worker workspace or relative to the workspace; the tool stores normalized relative paths." })),
  artifacts: ResultArtifacts
}, { additionalProperties: false });
export const WorkerReviewResultSubmitParams = Type.Object({
  outcome: Type.Union([Type.Literal("approve"), Type.Literal("request_changes"), Type.Literal("needs_input"), Type.Literal("blocked")], { description: "Why this review run is ending." }),
  summary: ResultSummary,
  question: ResultQuestion,
  artifacts: ResultArtifacts
}, { additionalProperties: false });
export const WorkerResultSubmitParams = Type.Union([WorkerWorkResultSubmitParams, WorkerReviewResultSubmitParams]);
export type WorkerResultSubmitInput = Static<typeof WorkerResultSubmitParams>;

const BeadsAssigned = Type.Object({ action: Type.Literal("assigned", { description: "Read this worker’s assigned tasks." }), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 31, default: 0, description: "Zero-based offset into assigned task IDs." })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, default: 4, description: "Maximum tasks to return; defaults to four and cannot exceed four." })) }, { additionalProperties: false });
const BeadsGet = Type.Object({ action: Type.Literal("get", { description: "Read one to four exact central personal task IDs." }), taskIds: Type.Array(TaskId, { minItems: 1, maxItems: 4, description: "Exact central personal task IDs to read." }) }, { additionalProperties: false });
const BeadsSearch = Type.Object({ action: Type.Literal("search", { description: "Search task titles and IDs across statuses." }), query: Type.String({ minLength: 1, maxLength: 256, description: "Bounded title or task-ID query." }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, default: 4, description: "Maximum matches to return; defaults to four and cannot exceed four." })) }, { additionalProperties: false });
const DesignSha256 = Type.String({ pattern: "^[0-9a-f]{64}$", description: "Lowercase SHA-256 of the complete canonical UTF-8 design returned by offset zero." });
const BeadsDesignStart = Type.Object({
  action: Type.Literal("design", { description: "Read or continue one exact task's canonical design field." }),
  taskId: TaskId,
  offset: Type.Optional(Type.Literal(0, { default: 0, description: "Start at the beginning of the canonical design." })),
  limit: Type.Optional(Type.Integer({ minimum: 4, maximum: 48 * 1024, default: 32 * 1024, description: "Maximum raw UTF-8 design bytes to return before the global response budget is applied." })),
  expectedSha256: Type.Optional(DesignSha256)
}, { additionalProperties: false });
const BeadsDesignContinuation = Type.Object({
  action: Type.Literal("design", { description: "Continue one exact task's canonical design field." }),
  taskId: TaskId,
  offset: Type.Integer({ minimum: 1, maximum: 512 * 1024, description: "Exact UTF-8 byte offset returned by the prior design chunk." }),
  limit: Type.Optional(Type.Integer({ minimum: 4, maximum: 48 * 1024, default: 32 * 1024, description: "Maximum raw UTF-8 design bytes to return before the global response budget is applied." })),
  expectedSha256: DesignSha256
}, { additionalProperties: false });
const BeadsDesign = Type.Union([BeadsDesignStart, BeadsDesignContinuation]);
const BeadsUpdate = Type.Object({ action: Type.Literal("update", { description: "Append a meaningful progress or blocker note to one assigned task." }), taskId: Type.String({ minLength: 1, maxLength: 128, pattern: "^personal-[a-zA-Z0-9]+(?:\\.[a-zA-Z0-9]+)*$", description: "Assigned central personal task to update." }), note: Type.String({ minLength: 1, maxLength: 4000, description: "Progress or blocker note to append without replacing existing notes." }), status: Type.Optional(Type.Union([Type.Literal("in_progress"), Type.Literal("blocked")], { description: "Optional allowed status transition." })) }, { additionalProperties: false });
const WorkerBeadsTasksReadStrict = Type.Union([BeadsAssigned, BeadsGet, BeadsSearch, BeadsDesign]);
const WorkerBeadsTasksStrict = Type.Union([BeadsAssigned, BeadsGet, BeadsSearch, BeadsDesign, BeadsUpdate]);
const BeadsProviderProperties = {
  action: Type.Union([Type.Literal("assigned"), Type.Literal("get"), Type.Literal("search"), Type.Literal("design"), Type.Literal("update")]),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 512 * 1024, default: 0, description: "Assigned-page offset or design UTF-8 byte offset, depending on action." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 48 * 1024, description: "Bounded task count or raw design-byte limit, depending on action." })),
  taskIds: Type.Optional(Type.Array(TaskId, { minItems: 1, maxItems: 4, description: "Exact central personal task IDs to read." })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Bounded title or task-ID query." })),
  taskId: Type.Optional(TaskId), expectedSha256: Type.Optional(DesignSha256), note: Type.Optional(Type.String({ minLength: 1, maxLength: 4000, description: "Progress or blocker note to append without replacing existing notes." })),
  status: Type.Optional(Type.Union([Type.Literal("in_progress"), Type.Literal("blocked")], { description: "Optional allowed status transition." }))
};
export const WorkerBeadsTasksReadParams = Type.Unsafe<Static<typeof WorkerBeadsTasksReadStrict>>({ ...WorkerBeadsTasksReadStrict, type: "object", required: ["action"], additionalProperties: false, properties: { ...BeadsProviderProperties, action: Type.Union([Type.Literal("assigned"), Type.Literal("get"), Type.Literal("search"), Type.Literal("design")]) } });
export const WorkerBeadsTasksParams = Type.Unsafe<Static<typeof WorkerBeadsTasksStrict>>({ ...WorkerBeadsTasksStrict, type: "object", required: ["action"], additionalProperties: false, properties: BeadsProviderProperties });

export type ValidatedWorkerResult = { outcome: WorkerOutcome; summary: string; question?: string; repositories: string[]; artifacts: string[] };
export type ResultPathErrorCode = "invalid_outcome" | "invalid_summary" | "question_required" | "question_not_allowed" | "path_not_found" | "path_outside_workspace" | "unsupported_path_type" | "not_repository" | "duplicate_path" | "artifact_required" | "run_not_quiescent" | "authorization_revoked" | "operational_failure";
export class WorkerResultValidationError extends Error { constructor(readonly code: ResultPathErrorCode, readonly fieldPath: string, message: string) { super(message); } }

export function validateWorkerResultInput(role: WorkerRole, input: WorkerResultSubmitInput): Omit<ValidatedWorkerResult, "repositories" | "artifacts"> {
  const allowed: Record<WorkerRole, WorkerOutcome[]> = { work: ["completed", "needs_input", "blocked"], integration: ["completed", "needs_input", "blocked"], review: ["approve", "request_changes", "needs_input", "blocked"] };
  if (!allowed[role].includes(input.outcome)) throw new WorkerResultValidationError("invalid_outcome", "outcome", `Outcome ${input.outcome} is invalid for role ${role}.`);
  const summary = input.summary.trim();
  if (!summary || Buffer.byteLength(summary) > 2048) throw new WorkerResultValidationError("invalid_summary", "summary", "summary must be non-empty and at most 2048 UTF-8 bytes.");
  const question = input.question?.trim();
  if (question !== undefined && Buffer.byteLength(question) > 2048) throw new WorkerResultValidationError("question_required", "question", "question must be at most 2048 UTF-8 bytes.");
  if (input.outcome === "needs_input" && !question) throw new WorkerResultValidationError("question_required", "question", "needs_input requires one focused question.");
  if (input.outcome !== "needs_input" && question !== undefined) throw new WorkerResultValidationError("question_not_allowed", "question", "question is allowed only for needs_input.");
  if (role === "review" && "repositories" in input && input.repositories !== undefined) throw new WorkerResultValidationError("invalid_outcome", "repositories", "Review workers cannot report repositories.");
  if (role === "review" && (input.outcome === "approve" || input.outcome === "request_changes") && (input.artifacts?.length ?? 0) === 0) throw new WorkerResultValidationError("artifact_required", "artifacts", `${input.outcome} requires at least one detailed review artifact.`);
  return { outcome: input.outcome, summary, ...(question ? { question } : {}) };
}

export function normalizeWorkspaceResultPaths(workspaceRoot: string, values: string[], kind: "repository" | "artifact", stat: (value: string) => { exists: boolean; directory: boolean; file: boolean; repository: boolean }): string[] {
  if (Buffer.byteLength(values.join("\0")) > 32 * 1024) throw new WorkerResultValidationError("unsupported_path_type", kind === "repository" ? "repositories" : "artifacts", "Combined result paths exceed 32768 UTF-8 bytes.");
  const root = realpathSync(path.resolve(workspaceRoot));
  const seen = new Set<string>();
  return values.map((value, index) => {
    const fieldPath = `${kind === "repository" ? "repositories" : "artifacts"}[${index}]`;
    if (Buffer.byteLength(value) > 4096) throw new WorkerResultValidationError("unsupported_path_type", fieldPath, `Result path exceeds 4096 UTF-8 bytes: ${value}.`);
    const lexical = path.resolve(root, value);
    const lexicalRelative = path.relative(root, lexical);
    if (!strictlyWithin(root, lexical) || lexicalRelative === "") throw new WorkerResultValidationError("path_outside_workspace", fieldPath, `Result path is outside the workspace: ${value}.`);
    if (!existsSync(lexical)) throw new WorkerResultValidationError("path_not_found", fieldPath, `Result path does not exist: ${value}.`);
    let exact: string;
    try { exact = realpathSync(lexical); } catch { throw new WorkerResultValidationError("path_not_found", fieldPath, `Result path does not resolve: ${value}.`); }
    if (!strictlyWithin(root, exact)) throw new WorkerResultValidationError("path_outside_workspace", fieldPath, `Result path resolves outside the workspace: ${value}.`);
    if (lstatSync(lexical).isSymbolicLink()) throw new WorkerResultValidationError("unsupported_path_type", fieldPath, `Result path cannot be a symbolic link: ${value}.`);
    const normalized = path.relative(root, exact).split(path.sep).join("/");
    if (seen.has(normalized)) throw new WorkerResultValidationError("duplicate_path", fieldPath, `Duplicate result path: ${value}.`);
    seen.add(normalized);
    const metadata = stat(exact);
    if (!metadata.exists) throw new WorkerResultValidationError("path_not_found", fieldPath, `Result path does not exist: ${value}.`);
    if (kind === "repository" && (!metadata.directory || !metadata.repository)) throw new WorkerResultValidationError("not_repository", fieldPath, `Repository result is not a Git repository directory: ${value}.`);
    if (kind === "artifact" && !metadata.directory && !metadata.file) throw new WorkerResultValidationError("unsupported_path_type", fieldPath, `Artifact result must be a regular file or directory: ${value}.`);
    return normalized;
  });
}

function strictlyWithin(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
