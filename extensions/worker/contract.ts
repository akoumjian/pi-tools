import path from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import { CompletionDeliverySchema } from "../_shared/completion-delivery.js";
import { WORKER_ID_PATTERN } from "../_shared/worker-id.js";
import type { WorkerOutcome, WorkerRole } from "./registry.js";

const TaskId = Type.String({ minLength: 1, maxLength: 128, pattern: "^personal-[a-zA-Z0-9]+(?:\\.[a-zA-Z0-9]+)*$" });
const WorkerId = Type.String({ minLength: 30, maxLength: 128, pattern: WORKER_ID_PATTERN });
const RunId = Type.String({ minLength: 1, maxLength: 128, pattern: "^run_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" });
const Instructions = Type.String({ minLength: 1, maxLength: 12_000 });
const AdditionalInputs = Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 16 });
const RepositoryBaseline = Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }), revision: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }, { additionalProperties: false });

export const StartWork = Type.Object({
  action: Type.Literal("start"), role: Type.Literal("work"),
  taskIds: Type.Array(TaskId, { minItems: 1, maxItems: 32 }), instructions: Instructions,
  repositoryBaselines: Type.Optional(Type.Array(RepositoryBaseline, { maxItems: 16 })),
  modelSelection: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), completionDelivery: Type.Optional(CompletionDeliverySchema)
}, { additionalProperties: false });
export const StartReview = Type.Object({
  action: Type.Literal("start"), role: Type.Literal("review"), reviewedRunId: RunId,
  instructions: Type.Optional(Instructions), additionalInputs: Type.Optional(AdditionalInputs), completionDelivery: Type.Optional(CompletionDeliverySchema)
}, { additionalProperties: false });
export const StartIntegration = Type.Object({
  action: Type.Literal("start"), role: Type.Literal("integration"), preparedId: Type.String({ pattern: "^prepared_[0-9a-f]{24}$" }),
  taskIds: Type.Array(TaskId, { minItems: 1, maxItems: 32 }), instructions: Type.Optional(Instructions),
  additionalInputs: Type.Optional(AdditionalInputs), completionDelivery: Type.Optional(CompletionDeliverySchema)
}, { additionalProperties: false });
export const ResumeWorker = Type.Object({
  action: Type.Literal("resume"), workerId: WorkerId, instructions: Instructions,
  additionalTaskIds: Type.Optional(Type.Array(TaskId, { maxItems: 32 })), additionalInputs: Type.Optional(AdditionalInputs), completionDelivery: Type.Optional(CompletionDeliverySchema)
}, { additionalProperties: false });
export const WorkerRunParamsV2 = Type.Object({ runs: Type.Array(Type.Union([StartWork, StartReview, StartIntegration, ResumeWorker]), { minItems: 1, maxItems: 8 }) }, { additionalProperties: false });
export type WorkerRunInputV2 = Static<typeof WorkerRunParamsV2>;

export const WorkerControlParamsV2 = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("runs"), Type.Literal("get"), Type.Literal("cancel"), Type.Literal("discard")]),
  workerId: Type.Optional(WorkerId), runId: Type.Optional(RunId),
  status: Type.Optional(Type.Union([Type.Literal("idle"), Type.Literal("queued"), Type.Literal("running")])),
  role: Type.Optional(Type.Union([Type.Literal("work"), Type.Literal("review"), Type.Literal("integration")])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), offset: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
export type WorkerControlInputV2 = Static<typeof WorkerControlParamsV2>;

const MergeRepository = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }),
  candidateRepo: Type.String({ minLength: 1, maxLength: 4096 }), candidateRef: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  targetRepo: Type.String({ minLength: 1, maxLength: 4096 }), targetRef: Type.String({ pattern: "^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$" }),
  method: Type.Union([Type.Literal("merge"), Type.Literal("squash")]), commitMessage: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
  dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 15 }))
}, { additionalProperties: false });
export const WorkerMergeTestParams = Type.Object({ repositories: Type.Array(MergeRepository, { minItems: 1, maxItems: 16 }) }, { additionalProperties: false });
export const WorkerMergeApplyParams = Type.Object({ preparedId: Type.String({ pattern: "^prepared_[0-9a-f]{24}$" }) }, { additionalProperties: false });

export const WorkerResultSubmitParams = Type.Object({
  outcome: Type.Union([Type.Literal("completed"), Type.Literal("needs_input"), Type.Literal("blocked"), Type.Literal("approve"), Type.Literal("request_changes")]),
  summary: Type.String({ minLength: 1, maxLength: 2048 }), question: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  repositories: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 16 })),
  artifacts: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 32 }))
}, { additionalProperties: false });
export type WorkerResultSubmitInput = Static<typeof WorkerResultSubmitParams>;

export const WorkerBeadsTasksParams = Type.Object({
  action: Type.Union([Type.Literal("assigned"), Type.Literal("get"), Type.Literal("search"), Type.Literal("update")]),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 31 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
  taskIds: Type.Optional(Type.Array(TaskId, { minItems: 1, maxItems: 32 })), query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  taskId: Type.Optional(TaskId), note: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  status: Type.Optional(Type.Union([Type.Literal("in_progress"), Type.Literal("blocked")]))
}, { additionalProperties: false });

export type ValidatedWorkerResult = { outcome: WorkerOutcome; summary: string; question?: string; repositories: string[]; artifacts: string[] };
export type ResultPathErrorCode = "invalid_outcome" | "invalid_summary" | "question_required" | "question_not_allowed" | "path_not_found" | "path_outside_workspace" | "unsupported_path_type" | "not_repository" | "duplicate_path" | "artifact_required";
export class WorkerResultValidationError extends Error { constructor(readonly code: ResultPathErrorCode, message: string) { super(message); } }

export function validateWorkerResultInput(role: WorkerRole, input: WorkerResultSubmitInput): Omit<ValidatedWorkerResult, "repositories" | "artifacts"> {
  const allowed: Record<WorkerRole, WorkerOutcome[]> = {
    work: ["completed", "needs_input", "blocked"], integration: ["completed", "needs_input", "blocked"], review: ["approve", "request_changes", "needs_input", "blocked"]
  };
  if (!allowed[role].includes(input.outcome)) throw new WorkerResultValidationError("invalid_outcome", `Outcome ${input.outcome} is invalid for role ${role}.`);
  const summary = input.summary.trim();
  if (!summary || Buffer.byteLength(summary) > 2048) throw new WorkerResultValidationError("invalid_summary", "summary must be non-empty and at most 2048 UTF-8 bytes.");
  const question = input.question?.trim();
  if (input.outcome === "needs_input" && !question) throw new WorkerResultValidationError("question_required", "needs_input requires one focused question.");
  if (input.outcome !== "needs_input" && question !== undefined) throw new WorkerResultValidationError("question_not_allowed", "question is allowed only for needs_input.");
  if (role === "review" && input.repositories !== undefined) throw new WorkerResultValidationError("invalid_outcome", "Review workers cannot report repositories.");
  if (role === "review" && (input.outcome === "approve" || input.outcome === "request_changes") && (input.artifacts?.length ?? 0) === 0) throw new WorkerResultValidationError("artifact_required", `${input.outcome} requires at least one detailed review artifact.`);
  return { outcome: input.outcome, summary, ...(question ? { question } : {}) };
}

export function normalizeWorkspaceResultPaths(workspaceRoot: string, values: string[], kind: "repository" | "artifact", stat: (value: string) => { exists: boolean; directory: boolean; file: boolean; repository: boolean }): string[] {
  if (Buffer.byteLength(values.join("\0")) > 32 * 1024) throw new WorkerResultValidationError("unsupported_path_type", "Combined result paths exceed 32768 UTF-8 bytes.");
  const root = path.resolve(workspaceRoot);
  const seen = new Set<string>();
  return values.map((value) => {
    const workspaceAlias = value === "/workspace" ? root : value.startsWith("/workspace/") ? path.join(root, value.slice("/workspace/".length)) : undefined;
    const exact = workspaceAlias ?? path.resolve(root, value);
    const relative = path.relative(root, exact);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new WorkerResultValidationError("path_outside_workspace", `Result path is outside the workspace: ${value}.`);
    const normalized = relative.split(path.sep).join("/");
    if (seen.has(normalized)) throw new WorkerResultValidationError("duplicate_path", `Duplicate result path: ${value}.`);
    seen.add(normalized);
    const metadata = stat(exact);
    if (!metadata.exists) throw new WorkerResultValidationError("path_not_found", `Result path does not exist: ${value}.`);
    if (kind === "repository" && (!metadata.directory || !metadata.repository)) throw new WorkerResultValidationError("not_repository", `Repository result is not a Git repository directory: ${value}.`);
    if (kind === "artifact" && !metadata.directory && !metadata.file) throw new WorkerResultValidationError("unsupported_path_type", `Artifact result must be a regular file or directory: ${value}.`);
    return normalized;
  });
}
