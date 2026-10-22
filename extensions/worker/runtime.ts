import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeAsyncShellJobsForOwner, cancelAsyncShellJobsForOwner, cancelPersistedAsyncShellJobsForOwner, unsettledPersistedAsyncShellJobsForOwner, type AsyncShellJobOwner } from "../async-shell/index.js";
import { createWorkerCacheLineageRuntime, registerWorkerCacheLineageRuntimeHooks, validateWorkerCacheLineageRecord, type WorkerCacheLineageRecord } from "./cache-lineage.js";
import { WorkerBeadsTasksParams, WorkerBeadsTasksReadParams, WorkerResultSubmitParams, WorkerReviewResultSubmitParams, WorkerWorkResultSubmitParams, WorkerResultValidationError, normalizeWorkspaceResultPaths, validateWorkerResultInput, type WorkerResultSubmitInput } from "./contract.js";
import type { WorkerRole } from "./registry.js";
import { inputJsonSchemaGuideline } from "../_shared/tool-prompt.js";
import { trustedGit } from "./trusted-git.js";
import { MAX_WORKER_TASK_IDS, workerMutationAdmissionPath, workerResultAdmissionPath } from "../_shared/worker-contract.js";
import { asyncJobProcessStartToken } from "../_shared/async-job.js";
import { writeAtomicJson } from "../_shared/atomic-json.js";

export type AcceptedWorkerResult = { version: 2; workerId: string; runId: string; acceptedAt: string; result: WorkerResultSubmitInput & { repositories?: string[]; artifacts?: string[] } };
export type WorkerTaskUpdate = { taskId: string; note: string; status?: "in_progress" | "blocked" };
export type WorkerTaskRead = { taskIds?: string[]; query?: string; offset?: number; limit?: number };
type WorkerTaskReadDetails = { scope: "assigned" | "requested" | "search" | "design"; offset?: number; limit: number; totalAssigned: number; returned: number; nextOffset?: number; contentBytes: number; truncated: boolean };
type WorkerTaskDesignView = { content: string; offset: number; returnedBytes: number; totalBytes: number; sha256: string; truncated: boolean; nextOffset?: number };
type WorkerTaskRelationView = { id: string; assigned: boolean; title: string; status: string; priority: number; issueType: string; dependencyType?: string; truncatedFields: string[] };
type WorkerTaskView = { id: string; assigned: boolean; title: string; status: string; priority: number; issueType: string; assignee?: string; parent?: { id: string; assigned: boolean }; description?: string; design?: WorkerTaskDesignView; notes?: string; acceptanceCriteria?: string; dependencyCount: number; dependentCount: number; dependencies: WorkerTaskRelationView[]; dependents: WorkerTaskRelationView[]; truncatedFields: string[] };
type WorkerResultError = { code: string; path: string; message: string };
type WorkerResultDetails = { status: "accepted"; outcome: string } | { status: "rejected"; errors: WorkerResultError[] };
const MAX_WORKER_TASK_READ_LIMIT = 4;
const MAX_WORKER_TASK_RELATIONS = 4;
const MAX_WORKER_BEADS_OUTPUT_BYTES = 512 * 1024;
const MAX_WORKER_TASK_READ_CONTENT_BYTES = 64 * 1024;
const MAX_WORKER_TASK_INLINE_DESIGN_BYTES = 16 * 1024;
const DEFAULT_WORKER_TASK_DESIGN_BYTES = 32 * 1024;
const MAX_WORKER_TASK_DESIGN_BYTES = 48 * 1024;
const CENTRAL_TASK_ID_PATTERN = "^personal-[a-zA-Z0-9]+(?:\\.[a-zA-Z0-9]+)*$";

export function readCacheLineageEnvironment(raw: string | undefined = process.env.PI_WORKER_CACHE_LINEAGE): WorkerCacheLineageRecord | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`Invalid PI_WORKER_CACHE_LINEAGE JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!validateWorkerCacheLineageRecord(parsed)) throw new Error("Invalid PI_WORKER_CACHE_LINEAGE state.");
  return parsed;
}

export default function workerRuntimeExtension(api: ExtensionAPI): void {
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
      assertRuntimeOpen("worker_beads_tasks");
      validateBeadsAction(params);
      if (params.action === "update") return executeTaskUpdate({ taskId: params.taskId!, note: params.note!, status: params.status });
      if (params.action === "design") return executeTaskDesignRead(params.taskId!, params.offset, params.limit, params.expectedSha256);
      const read: WorkerTaskRead = params.action === "assigned"
        ? { offset: params.offset, limit: params.limit }
        : params.action === "get" ? { taskIds: params.taskIds! } : { query: params.query!, limit: params.limit };
      return executeTaskRead(read);
    }
  }));
  api.registerTool(defineTool({
    name: "worker_result_submit", label: "Submit Worker Result",
    description: "End the current worker run by submitting a structured result. Use it for completed work, requests for guidance, blockers, and review verdicts. The tool records the outcome, summary, optional question, and reported repository and artifact paths, then seals the run and returns control to the parent. It does not approve work, apply repositories, close tasks, or discard the worker.",
    promptSnippet: "Submit the current run’s completed work, request for guidance, blocker, or review verdict.",
    promptGuidelines: [
      "Use `worker_result_submit` when the current run should return control to the parent. Use `completed` only when the assigned work is finished, `needs_input` for parent-answerable questions required to continue, and `blocked` when an unavailable prerequisite or required intervention prevents progress. Review workers use `approve` or `request_changes` for completed reviews. Summarize the result and report useful repository and artifact entry points.",
      inputJsonSchemaGuideline("worker_result_submit", workerRuntimeRole() === "review" ? WorkerReviewResultSubmitParams : WorkerWorkResultSubmitParams),
      "worker_result_submit constraints: Rejected semantic results return stable coded field errors and do not seal the run. The runtime canonicalizes every reported path and internally reconciles owned work before acceptance."
    ],
    parameters: workerRuntimeRole() === "review" ? WorkerReviewResultSubmitParams : WorkerWorkResultSubmitParams, executionMode: "sequential",
    async execute(_id, params): Promise<AgentToolResult<WorkerResultDetails>> {
      const identity = workerRuntimeIdentity();
      assertRuntimeAuthorization(identity, "worker_result_submit");
      if (existsSync(identity.resultFile)) throw new Error(`Worker result was already accepted for ${identity.workerId}/${identity.runId}.`);
      const errors: WorkerResultError[] = [];
      let repositories: string[] = []; let artifacts: string[] = [];
      try {
        validateWorkerResultInput(workerRuntimeRole(), params);
        repositories = normalizeWorkspaceResultPaths(identity.workspaceRoot, ("repositories" in params ? params.repositories : undefined) ?? [], "repository", resultPathMetadata);
        artifacts = normalizeWorkspaceResultPaths(identity.workspaceRoot, params.artifacts ?? [], "artifact", resultPathMetadata);
      } catch (error) {
        const semantic = error instanceof WorkerResultValidationError ? error : undefined;
        errors.push({ code: semantic?.code ?? "unsupported_path_type", path: semantic?.fieldPath ?? "result", message: error instanceof Error ? error.message : String(error) });
      }
      if (errors.length) return rejectedResult(errors);
      const admissionFile = beginWorkerResultAdmission(identity);
      try {
        await cancelAsyncShellJobsForOwner(identity.owner, "SIGTERM", 2_000);
        await cancelPersistedAsyncShellJobsForOwner(identity.asyncJobRoot, identity.owner, 2_000);
        const active = [...activeAsyncShellJobsForOwner(identity.owner), ...unsettledPersistedAsyncShellJobsForOwner(identity.asyncJobRoot, identity.owner)].filter((job) => job.status === "running" || job.status === "unknown");
        if (active.length) return rejectedResult([{ code: "run_not_quiescent", path: "run", message: `Owned asynchronous work could not be reconciled: ${[...new Set(active.map((job) => job.jobId))].sort().join(", ")}.` }]);
        assertRuntimeAuthorization(identity, "worker_result_submit");
        const accepted: AcceptedWorkerResult = { version: 2, workerId: identity.workerId, runId: identity.runId, acceptedAt: new Date().toISOString(), result: { ...params, ...(repositories.length ? { repositories } : {}), ...(artifacts.length ? { artifacts } : {}) } };
        writeAtomicJson(identity.resultFile, accepted);
        const details = { status: "accepted" as const, outcome: params.outcome };
        return { content: [{ type: "text", text: `Worker result accepted for ${identity.workerId}/${identity.runId}.` }], details };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return rejectedResult([{ code: /revoked/.test(message) ? "authorization_revoked" : "operational_failure", path: "run", message }]);
      } finally { rmSync(admissionFile, { force: true }); }
    }
  }));
}

export function readWorkerRuntimeResult(resultFile: string): AcceptedWorkerResult {
  const value = JSON.parse(readFileSync(resultFile, "utf8")) as Partial<AcceptedWorkerResult>;
  if (value.version !== 2 || typeof value.workerId !== "string" || typeof value.runId !== "string" || typeof value.acceptedAt !== "string" || !value.result) throw new Error(`Invalid worker result: ${resultFile}`);
  const result = validateToolArguments(
    { name: "worker_result_submit", description: "Validate a persisted worker result.", parameters: WorkerResultSubmitParams } as Tool,
    { type: "toolCall", id: "persisted-worker-result", name: "worker_result_submit", arguments: value.result } as ToolCall
  ) as WorkerResultSubmitInput;
  return { version: 2, workerId: value.workerId, runId: value.runId, acceptedAt: value.acceptedAt, result };
}


function rejectedResult(errors: WorkerResultError[]): AgentToolResult<WorkerResultDetails> {
  return { content: [{ type: "text", text: `Worker result rejected: ${errors.map((error) => `${error.code} at ${error.path}: ${error.message}`).join("; ")}` }], details: { status: "rejected", errors } };
}

function validateBeadsAction(params: any): void {
  const keys = Object.keys(params); const allowed = params.action === "assigned" ? ["action","offset","limit"] : params.action === "get" ? ["action","taskIds"] : params.action === "search" ? ["action","query","limit"] : params.action === "design" ? ["action","taskId","offset","limit","expectedSha256"] : ["action","taskId","note","status"];
  if (!keys.every((key) => allowed.includes(key))) throw new Error(`worker_beads_tasks ${params.action} received unsupported fields.`);
  if (params.action === "get" && !params.taskIds?.length) throw new Error("worker_beads_tasks get requires taskIds.");
  if (params.action === "search" && !params.query?.trim()) throw new Error("worker_beads_tasks search requires query.");
  if (params.action === "design" && !params.taskId) throw new Error("worker_beads_tasks design requires taskId.");
  if (params.action === "design" && params.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(params.expectedSha256)) throw new Error("worker_beads_tasks expectedSha256 must be 64 lowercase hexadecimal characters.");
  if (params.action === "design" && (params.offset ?? 0) > 0 && params.expectedSha256 === undefined) throw new Error("worker_beads_tasks design continuation requires expectedSha256 from offset 0.");
  if (params.action === "update" && (!params.taskId || !params.note?.trim())) throw new Error("worker_beads_tasks update requires taskId and note.");
}

function assertRuntimeOpen(tool: string): void { const identity = workerRuntimeIdentity(); assertRuntimeAuthorization(identity, tool); if (existsSync(identity.resultFile)) throw new Error(`${tool} is sealed after worker_result_submit acceptance.`); }
function workerRuntimeRole(): WorkerRole { const value = requiredEnvironment("PI_WORKER_ROLE"); if (value !== "work" && value !== "review" && value !== "integration") throw new Error(`Invalid PI_WORKER_ROLE: ${value}.`); return value; }
function resultPathMetadata(value: string): { exists: boolean; directory: boolean; file: boolean; repository: boolean } {
  if (!existsSync(value)) return { exists: false, directory: false, file: false, repository: false };
  const metadata = lstatSync(value);
  let repository = false;
  if (metadata.isDirectory()) { try { trustedGit(value, ["rev-parse", "--git-dir"]); repository = true; } catch {} }
  return { exists: true, directory: metadata.isDirectory(), file: metadata.isFile(), repository };
}

async function executeTaskRead(params: WorkerTaskRead): Promise<AgentToolResult<WorkerTaskReadDetails>> {
  validateWorkerTaskReadMode(params);
  const runtime = workerTaskRuntime();
  const assigned = [...runtime.taskIds]; const explicitTaskIds = params.taskIds; const query = params.query;
  const scope: "search" | "requested" | "assigned" = query !== undefined ? "search" : explicitTaskIds !== undefined ? "requested" : "assigned";
  const offset = scope === "assigned" ? params.offset ?? 0 : undefined;
  const limit = explicitTaskIds === undefined ? params.limit ?? Math.min(MAX_WORKER_TASK_READ_LIMIT, 4) : explicitTaskIds.length;
  if (scope === "assigned" && offset! >= assigned.length) throw new Error(`worker_beads_tasks offset ${offset} exceeds ${assigned.length} assigned task IDs.`);
  const taskIds = query !== undefined ? searchWorkerTaskIds(runtime, query, limit) : explicitTaskIds !== undefined ? requestedWorkerTaskIds(explicitTaskIds) : assigned.slice(offset, offset! + limit);
  const output = taskIds.length === 0 ? "[]" : readTrustedBeadsTaskPage(runtime, taskIds);
  const tasks = workerTaskViews(output, taskIds, runtime.taskIds, scope !== "search");
  const truncated = tasks.some((task) => task.truncatedFields.length > 0 || [...task.dependencies, ...task.dependents].some((relation) => relation.truncatedFields.length > 0));
  const nextOffset = scope === "assigned" && offset! + taskIds.length < assigned.length ? offset! + taskIds.length : undefined;
  const page = { scope, assignedTaskIds: assigned, tasks, ...(nextOffset === undefined ? {} : { nextOffset }) };
  const { text, contentBytes } = fitTaskPageToBudget(page);
  const pageTruncated = truncated || tasks.some((task) => task.design?.truncated);
  return { content: [{ type: "text", text }], details: { scope, ...(offset === undefined ? {} : { offset }), limit, totalAssigned: assigned.length, returned: tasks.length, ...(nextOffset === undefined ? {} : { nextOffset }), contentBytes, truncated: pageTruncated } };
}

async function executeTaskDesignRead(taskId: string, offsetInput?: number, limitInput?: number, expectedSha256?: string): Promise<AgentToolResult<WorkerTaskReadDetails>> {
  const runtime = workerTaskRuntime();
  requestedWorkerTaskIds([taskId]);
  const offset = offsetInput ?? 0;
  const limit = limitInput ?? DEFAULT_WORKER_TASK_DESIGN_BYTES;
  if (!Number.isInteger(offset) || offset < 0 || offset > 512 * 1024) throw new Error("worker_beads_tasks design offset is invalid.");
  if (!Number.isInteger(limit) || limit < 4 || limit > MAX_WORKER_TASK_DESIGN_BYTES) throw new Error("worker_beads_tasks design limit is invalid.");
  if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error("worker_beads_tasks expectedSha256 must be 64 lowercase hexadecimal characters.");
  if (offset > 0 && expectedSha256 === undefined) throw new Error("worker_beads_tasks design continuation requires expectedSha256 from offset 0.");
  const output = readTrustedBeadsTaskPage(runtime, [taskId]);
  const design = workerTaskDesign(output, taskId);
  const sha256 = designSha256(design);
  if (expectedSha256 !== undefined && expectedSha256 !== sha256) throw new Error("worker_beads_tasks design changed; restart at offset 0.");
  const response = fitDesignReadToBudget({
    scope: "design" as const,
    assignedTaskIds: [...runtime.taskIds],
    taskId,
    assigned: runtime.taskIds.has(taskId),
    design,
    sha256
  }, offset, limit);
  return {
    content: [{ type: "text", text: response.text }],
    details: {
      scope: "design",
      offset,
      limit,
      totalAssigned: runtime.taskIds.size,
      returned: 1,
      ...(response.design.nextOffset === undefined ? {} : { nextOffset: response.design.nextOffset }),
      contentBytes: response.contentBytes,
      truncated: response.design.truncated
    }
  };
}

async function executeTaskUpdate(params: WorkerTaskUpdate): Promise<AgentToolResult<{ taskId: string; status?: string; recorded: true }>> {
  if (workerRuntimeRole() === "review") throw new Error("Review workers cannot update Beads tasks.");
  const runtime = workerTaskRuntime(); if (!runtime.taskIds.has(params.taskId)) throw new Error(`Worker ${runtime.workerId} is not authorized to mutate Beads task ${params.taskId}.`);
  verifyPersonalBeadsRoute(runtime);
  const args = ["update", params.taskId, `--append-notes=${params.note.trim()}`]; if (params.status) args.push("--status", params.status); args.push("--actor", `worker:${runtime.workerId}`, "--json");
  const identity = workerRuntimeIdentity(); const admissionFile = beginWorkerMutationAdmission(identity);
  try { assertRuntimeAuthorization(identity, "worker_beads_tasks"); execFileSync(runtime.bdPath, args, { cwd: runtime.workspaceRoot, env: process.env, encoding: "utf8", maxBuffer: MAX_WORKER_BEADS_OUTPUT_BYTES, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { if (error instanceof Error && error.message.includes("revoked")) throw error; throw new Error(`worker_beads_tasks could not record an update for ${params.taskId}.`); }
  finally { rmSync(admissionFile, { force: true }); }
  return { content: [{ type: "text", text: `Recorded a durable worker note on ${params.taskId}${params.status ? ` and set status ${params.status}` : ""}.` }], details: { taskId: params.taskId, status: params.status, recorded: true } };
}

function assignedTaskIds(): Set<string> {
  const rawTaskIds = JSON.parse(requiredEnvironment("PI_WORKER_TASK_IDS")) as unknown;
  if (
    !Array.isArray(rawTaskIds) ||
    rawTaskIds.length === 0 ||
    rawTaskIds.length > MAX_WORKER_TASK_IDS ||
    rawTaskIds.some((value) => typeof value !== "string" || !isCentralTaskId(value.trim()))
  ) {
    throw new Error(`Worker runtime requires PI_WORKER_TASK_IDS to contain 1-${MAX_WORKER_TASK_IDS} central personal task IDs.`);
  }
  return new Set(rawTaskIds.map((value) => value.trim()));
}

function validateWorkerTaskReadMode(params: WorkerTaskRead): void {
  const hasTaskIds = params.taskIds !== undefined;
  const hasQuery = params.query !== undefined;
  if (hasTaskIds && hasQuery) {
    throw new Error("worker_beads_tasks accepts either taskIds or query, not both.");
  }
  if (hasTaskIds && (params.offset !== undefined || params.limit !== undefined)) {
    throw new Error("worker_beads_tasks taskIds cannot be combined with offset or limit.");
  }
  if (hasQuery && params.offset !== undefined) {
    throw new Error("worker_beads_tasks query cannot be combined with offset.");
  }
}

function requestedWorkerTaskIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_WORKER_TASK_READ_LIMIT ||
    value.some((taskId) => typeof taskId !== "string" || !isCentralTaskId(taskId)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`worker_beads_tasks requires 1-${MAX_WORKER_TASK_READ_LIMIT} unique central personal task IDs.`);
  }
  return value as string[];
}

function isCentralTaskId(value: string): boolean {
  return new RegExp(CENTRAL_TASK_ID_PATTERN).test(value);
}

function workerTaskRuntime(): {
  workerId: string;
  workspaceRoot: string;
  bdPath: string;
  taskIds: Set<string>;
  beadsRoute: { prefix: "personal"; path: string; databasePath: string };
} {
  const workerId = requiredEnvironment("PI_WORKER_ID");
  return {
    workerId,
    workspaceRoot: path.resolve(requiredEnvironment("PI_WORKER_WORKSPACE_ROOT")),
    bdPath: path.resolve(requiredEnvironment("PI_WORKER_BD_PATH")),
    taskIds: assignedTaskIds(),
    beadsRoute: expectedBeadsRoute()
  };
}

function searchWorkerTaskIds(
  runtime: ReturnType<typeof workerTaskRuntime>,
  query: string,
  limit: number
): string[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery || Buffer.byteLength(normalizedQuery, "utf8") > 1_024) {
    throw new Error("worker_beads_tasks requires a non-empty bounded search query.");
  }
  let output: string;
  try {
    output = execFileSync(runtime.bdPath, [
      "--readonly",
      "search",
      `--query=${normalizedQuery}`,
      "--status=all",
      `--limit=${limit}`,
      "--sort=id",
      "--json"
    ], {
      cwd: runtime.workspaceRoot,
      env: process.env,
      encoding: "utf8",
      maxBuffer: MAX_WORKER_BEADS_OUTPUT_BYTES,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    throw new Error("worker_beads_tasks could not search central Beads tasks.");
  }
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new Error("worker_beads_tasks received invalid JSON from Beads search.");
  }
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error("worker_beads_tasks received an invalid bounded Beads search response.");
  }
  const taskIds = value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("worker_beads_tasks received an invalid Beads search record.");
    const taskId = requiredTaskText(candidate, "id", 128);
    if (!isCentralTaskId(taskId)) throw new Error("worker_beads_tasks received an invalid central task ID.");
    return taskId;
  });
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error("worker_beads_tasks received duplicate Beads search records.");
  }
  return taskIds;
}

export type TrustedBeadsReadRuntime = Pick<ReturnType<typeof workerTaskRuntime>, "workspaceRoot" | "bdPath" | "beadsRoute">;

export function readTrustedBeadsTaskPage(runtime: TrustedBeadsReadRuntime, taskIds: readonly string[]): string {
  verifyPersonalBeadsRoute(runtime);
  try {
    return execFileSync(runtime.bdPath, [
      "--readonly",
      "show",
      "--include-dependents",
      ...taskIds.map((taskId) => `--id=${taskId}`),
      "--json"
    ], {
      cwd: runtime.workspaceRoot,
      env: process.env,
      encoding: "utf8",
      maxBuffer: MAX_WORKER_BEADS_OUTPUT_BYTES,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    throw new Error("worker_beads_tasks could not read the requested Beads task page.");
  }
}

function verifyPersonalBeadsRoute(runtime: TrustedBeadsReadRuntime): void {
  let route: { prefix?: unknown; path?: unknown; database_path?: unknown };
  try {
    const output = execFileSync(runtime.bdPath, ["where", "--json"], {
      cwd: runtime.workspaceRoot,
      env: process.env,
      encoding: "utf8",
      maxBuffer: MAX_WORKER_BEADS_OUTPUT_BYTES,
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    route = JSON.parse(output) as typeof route;
  } catch {
    throw new Error("Worker Beads route verification failed.");
  }
  const actual = {
    prefix: route.prefix,
    path: typeof route.path === "string" ? path.resolve(route.path) : undefined,
    databasePath: typeof route.database_path === "string" ? path.resolve(route.database_path) : undefined
  };
  if (
    actual.prefix !== runtime.beadsRoute.prefix ||
    actual.path !== runtime.beadsRoute.path ||
    actual.databasePath !== runtime.beadsRoute.databasePath
  ) {
    throw new Error(`Worker Beads route does not match the parent-recorded central personal route.`);
  }
  const ambientPath = process.env.BEADS_DIR?.trim();
  if (!ambientPath || path.resolve(ambientPath) !== runtime.beadsRoute.path) {
    throw new Error("Worker Beads access requires the unchanged ambient central BEADS_DIR route.");
  }
}

function expectedBeadsRoute(): { prefix: "personal"; path: string; databasePath: string } {
  const value = JSON.parse(requiredEnvironment("PI_WORKER_BEADS_ROUTE")) as {
    prefix?: unknown;
    path?: unknown;
    databasePath?: unknown;
  };
  if (value.prefix !== "personal" || typeof value.path !== "string" || typeof value.databasePath !== "string") {
    throw new Error("Worker runtime requires a valid parent-recorded central personal Beads route.");
  }
  return { prefix: "personal", path: path.resolve(value.path), databasePath: path.resolve(value.databasePath) };
}

function workerRuntimeIdentity(): {
  workerId: string;
  runId: string;
  resultFile: string;
  workspaceRoot: string;
  asyncJobRoot: string;
  authorizationFile: string;
  processNonce: string;
  owner: AsyncShellJobOwner;
} {
  const workerId = requiredEnvironment("PI_WORKER_ID");
  const runId = requiredEnvironment("PI_WORKER_RUN_ID");
  const stateRoot = realpathSync(path.resolve(requiredEnvironment("PI_WORKER_STATE_ROOT")));
  const workspaceRoot = realpathSync(path.resolve(requiredEnvironment("PI_WORKER_WORKSPACE_ROOT")));
  const asyncJobRoot = realpathSync(path.resolve(requiredEnvironment("PI_WORKER_ASYNC_JOB_ROOT")));
  const requestedResult = path.resolve(requiredEnvironment("PI_WORKER_RESULT_FILE"));
  const requestedAuthorization = path.resolve(requiredEnvironment("PI_WORKER_AUTHORIZATION_FILE"));
  if (existsSync(requestedAuthorization) && lstatSync(requestedAuthorization).isSymbolicLink()) throw new Error("PI_WORKER_AUTHORIZATION_FILE may not be a symbolic link.");
  const authorizationFile = path.join(realpathSync(path.dirname(requestedAuthorization)), path.basename(requestedAuthorization));
  const processNonce = requiredEnvironment("PI_WORKER_PROCESS_NONCE");
  if (existsSync(requestedResult) && lstatSync(requestedResult).isSymbolicLink()) throw new Error("PI_WORKER_RESULT_FILE may not be a symbolic link.");
  const resultFile = path.join(realpathSync(path.dirname(requestedResult)), path.basename(requestedResult));
  if (!pathWithin(stateRoot, resultFile) || !pathWithin(stateRoot, asyncJobRoot)) throw new Error("Worker runtime state paths must remain beneath PI_WORKER_STATE_ROOT.");
  if (!pathWithin(stateRoot, authorizationFile)) throw new Error("Worker runtime authorization identity is invalid.");
  return { workerId, runId, resultFile, workspaceRoot, asyncJobRoot, authorizationFile, processNonce, owner: { kind: "worker-run", workerId, runId } };
}

function assertRuntimeAuthorization(identity: ReturnType<typeof workerRuntimeIdentity>, tool: string): void {
  let value: any;
  try { value = JSON.parse(readFileSync(identity.authorizationFile, "utf8")); } catch { throw new Error(`${tool} is revoked for ${identity.workerId}/${identity.runId}.`); }
  if (value?.version !== 1 || value.workerId !== identity.workerId || value.runId !== identity.runId || value.processNonce !== identity.processNonce) throw new Error(`${tool} is revoked for ${identity.workerId}/${identity.runId}.`);
}

function beginWorkerMutationAdmission(identity: ReturnType<typeof workerRuntimeIdentity>): string {
  const file = workerMutationAdmissionPath(identity.authorizationFile);
  try { writeFileSync(file, `${JSON.stringify({ version: 2, workerId: identity.workerId, runId: identity.runId, pid: process.pid, processStartToken: asyncJobProcessStartToken(process.pid), startedAt: new Date().toISOString() })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Worker mutation admission is already active for ${identity.workerId}/${identity.runId}.`); throw cause; }
  return file;
}

function beginWorkerResultAdmission(identity: ReturnType<typeof workerRuntimeIdentity>): string {
  mkdirSync(path.dirname(identity.resultFile), { recursive: true, mode: 0o700 });
  const admissionFile = workerResultAdmissionPath(identity.resultFile);
  try {
    writeFileSync(admissionFile, `${JSON.stringify({
      version: 2,
      workerId: identity.workerId,
      runId: identity.runId,
      pid: process.pid,
      processStartToken: asyncJobProcessStartToken(process.pid),
      startedAt: new Date().toISOString()
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Worker result admission is already active for ${identity.workerId}/${identity.runId}.`);
    }
    throw cause;
  }
  return admissionFile;
}

function pathWithin(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Worker runtime requires ${name}.`);
  return value;
}

function workerTaskViews(
  output: string,
  expectedTaskIds: readonly string[],
  assignedTaskIds: ReadonlySet<string>,
  includeDesign: boolean
): WorkerTaskView[] {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new Error("worker_beads_tasks received invalid JSON from Beads.");
  }
  if (!Array.isArray(value)) throw new Error("worker_beads_tasks expected bd show to return a JSON array.");
  const byId = new Map<string, Record<string, unknown>>();
  for (const candidate of value) {
    if (!isRecord(candidate)) throw new Error("worker_beads_tasks received an invalid Beads task record.");
    const taskId = requiredTaskText(candidate, "id", 128);
    if (byId.has(taskId)) throw new Error("worker_beads_tasks received duplicate Beads task records.");
    byId.set(taskId, candidate);
  }
  if (byId.size !== expectedTaskIds.length || expectedTaskIds.some((taskId) => !byId.has(taskId))) {
    throw new Error("worker_beads_tasks Beads response did not match the requested task IDs.");
  }
  return expectedTaskIds.map((taskId) => workerTaskView(byId.get(taskId)!, assignedTaskIds, includeDesign));
}

function workerTaskView(value: Record<string, unknown>, assignedTaskIds: ReadonlySet<string>, includeDesign: boolean): WorkerTaskView {
  const truncatedFields: string[] = [];
  const bounded = (field: string, maximumBytes: number): string | undefined => {
    const raw = value[field];
    if (raw === undefined || raw === null || raw === "") return undefined;
    if (typeof raw !== "string") throw new Error(`worker_beads_tasks expected ${field} to be text.`);
    const result = boundedUtf8(raw, maximumBytes);
    if (!result.text) return undefined;
    if (result.truncated) truncatedFields.push(field);
    return result.text;
  };
  const title = bounded("title", 512);
  if (!title) throw new Error("worker_beads_tasks expected non-empty title.");
  const dependencies = boundedRelations(value.dependencies, "dependencies", truncatedFields, assignedTaskIds);
  const dependents = boundedRelations(value.dependents, "dependents", truncatedFields, assignedTaskIds);
  const id = requiredTaskText(value, "id", 128);
  const design = includeDesign ? optionalTaskDesign(value) : undefined;
  if (design?.truncated) truncatedFields.push("design");
  return {
    id,
    assigned: assignedTaskIds.has(id),
    title,
    status: requiredTaskText(value, "status", 64),
    priority: requiredTaskInteger(value, "priority"),
    issueType: requiredTaskText(value, "issue_type", 64),
    assignee: bounded("assignee", 256),
    parent: optionalTaskReference(value, "parent", assignedTaskIds),
    description: bounded("description", 2_048),
    ...(design === undefined ? {} : { design }),
    notes: bounded("notes", 2_048),
    acceptanceCriteria: bounded("acceptance_criteria", 1_024),
    dependencyCount: optionalTaskInteger(
      value,
      "dependency_count",
      Array.isArray(value.dependencies) ? value.dependencies.length : dependencies.length
    ),
    dependentCount: optionalTaskInteger(
      value,
      "dependent_count",
      Array.isArray(value.dependents) ? value.dependents.length : dependents.length
    ),
    dependencies,
    dependents,
    truncatedFields
  };
}

function workerTaskDesign(output: string, expectedTaskId: string): string {
  let value: unknown;
  try { value = JSON.parse(output) as unknown; }
  catch { throw new Error("worker_beads_tasks received invalid JSON from Beads."); }
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) throw new Error("worker_beads_tasks expected one Beads design record.");
  const id = requiredTaskText(value[0], "id", 128);
  if (id !== expectedTaskId) throw new Error("worker_beads_tasks Beads design response did not match the requested task ID.");
  const raw = value[0].design;
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") throw new Error("worker_beads_tasks expected design to be text.");
  return raw;
}

function optionalTaskDesign(value: Record<string, unknown>): WorkerTaskDesignView | undefined {
  const raw = value.design;
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new Error("worker_beads_tasks expected design to be text.");
  return designWindow(raw, 0, MAX_WORKER_TASK_INLINE_DESIGN_BYTES, designSha256(raw));
}

function designSha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function designWindow(value: string, offset: number, maximumBytes: number, sha256: string): WorkerTaskDesignView {
  const buffer = Buffer.from(value, "utf8");
  if (offset > buffer.length) throw new Error(`worker_beads_tasks design offset ${offset} exceeds ${buffer.length} UTF-8 bytes.`);
  if (offset > 0 && offset < buffer.length && (buffer[offset]! & 0xc0) === 0x80) throw new Error("worker_beads_tasks design offset must be a UTF-8 character boundary.");
  let end = Math.min(buffer.length, offset + maximumBytes);
  while (end > offset && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  const returnedBytes = end - offset;
  const truncated = end < buffer.length;
  return {
    content: buffer.subarray(offset, end).toString("utf8"),
    offset,
    returnedBytes,
    totalBytes: buffer.length,
    sha256,
    truncated,
    ...(truncated ? { nextOffset: end } : {})
  };
}

type WorkerTaskPage = { scope: "assigned" | "requested" | "search"; assignedTaskIds: string[]; tasks: WorkerTaskView[]; nextOffset?: number };

function fitTaskPageToBudget(page: WorkerTaskPage): { text: string; contentBytes: number } {
  let text = JSON.stringify(page, null, 2);
  let contentBytes = Buffer.byteLength(text, "utf8");
  while (contentBytes > MAX_WORKER_TASK_READ_CONTENT_BYTES) {
    const candidates = page.tasks.filter((task) => (task.design?.returnedBytes ?? 0) > 0)
      .sort((left, right) => right.design!.returnedBytes - left.design!.returnedBytes);
    const task = candidates[0];
    if (!task?.design) throw new Error(`worker_beads_tasks output exceeded ${MAX_WORKER_TASK_READ_CONTENT_BYTES} bytes.`);
    const targetBytes = Math.floor(task.design.returnedBytes / 2);
    task.design = shrinkDesignView(task.design, targetBytes);
    if (!task.truncatedFields.includes("design")) task.truncatedFields.push("design");
    text = JSON.stringify(page, null, 2);
    contentBytes = Buffer.byteLength(text, "utf8");
  }
  return { text, contentBytes };
}

function shrinkDesignView(design: WorkerTaskDesignView, maximumBytes: number): WorkerTaskDesignView {
  const content = Buffer.from(design.content, "utf8");
  let end = Math.min(content.length, maximumBytes);
  while (end > 0 && end < content.length && (content[end]! & 0xc0) === 0x80) end -= 1;
  const returnedBytes = end;
  const nextOffset = design.offset + returnedBytes;
  const truncated = nextOffset < design.totalBytes;
  return {
    content: content.subarray(0, end).toString("utf8"),
    offset: design.offset,
    returnedBytes,
    totalBytes: design.totalBytes,
    sha256: design.sha256,
    truncated,
    ...(truncated ? { nextOffset } : {})
  };
}

function fitDesignReadToBudget(
  base: { scope: "design"; assignedTaskIds: string[]; taskId: string; assigned: boolean; design: string; sha256: string },
  offset: number,
  limit: number
): { text: string; contentBytes: number; design: WorkerTaskDesignView } {
  const totalBytes = Buffer.byteLength(base.design, "utf8");
  if (offset > totalBytes) throw new Error(`worker_beads_tasks design offset ${offset} exceeds ${totalBytes} UTF-8 bytes.`);
  const available = Math.min(limit, totalBytes - offset);
  let low = 0;
  let high = available;
  let best: { text: string; contentBytes: number; design: WorkerTaskDesignView } | undefined;
  while (low <= high) {
    const requested = Math.floor((low + high) / 2);
    const design = designWindow(base.design, offset, requested, base.sha256);
    const text = JSON.stringify({ scope: base.scope, assignedTaskIds: base.assignedTaskIds, taskId: base.taskId, assigned: base.assigned, design }, null, 2);
    const contentBytes = Buffer.byteLength(text, "utf8");
    if (contentBytes <= MAX_WORKER_TASK_READ_CONTENT_BYTES) {
      if (!best || design.returnedBytes >= best.design.returnedBytes) best = { text, contentBytes, design };
      low = requested + 1;
    } else {
      high = requested - 1;
    }
  }
  if (!best || (offset < totalBytes && best.design.returnedBytes === 0)) throw new Error(`worker_beads_tasks output exceeded ${MAX_WORKER_TASK_READ_CONTENT_BYTES} bytes.`);
  return best;
}

function boundedRelations(
  value: unknown,
  field: string,
  truncatedFields: string[],
  assignedTaskIds: ReadonlySet<string>
): WorkerTaskRelationView[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`worker_beads_tasks expected ${field} to be an array.`);
  if (value.length > MAX_WORKER_TASK_RELATIONS) truncatedFields.push(field);
  return value.slice(0, MAX_WORKER_TASK_RELATIONS).map((candidate) => {
    if (!isRecord(candidate)) throw new Error(`worker_beads_tasks received an invalid ${field} record.`);
    const truncatedFields: string[] = [];
    const rawTitle = candidate.title;
    if (typeof rawTitle !== "string") throw new Error(`worker_beads_tasks expected non-empty ${field} title.`);
    const title = boundedUtf8(rawTitle, 512);
    if (!title.text) throw new Error(`worker_beads_tasks expected non-empty ${field} title.`);
    if (title.truncated) truncatedFields.push("title");
    const id = requiredTaskText(candidate, "id", 128);
    return {
      id,
      assigned: assignedTaskIds.has(id),
      title: title.text,
      status: requiredTaskText(candidate, "status", 64),
      priority: requiredTaskInteger(candidate, "priority"),
      issueType: requiredTaskText(candidate, "issue_type", 64),
      ...(candidate.dependency_type === undefined || candidate.dependency_type === null
        ? {}
        : { dependencyType: requiredTaskText(candidate, "dependency_type", 64) }),
      truncatedFields
    };
  });
}

function optionalTaskReference(
  value: Record<string, unknown>,
  field: string,
  assignedTaskIds: ReadonlySet<string>
): { id: string; assigned: boolean } | undefined {
  const raw = value[field];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const id = requiredTaskText(value, field, 128);
  if (!isCentralTaskId(id)) throw new Error(`worker_beads_tasks expected a central task ID in ${field}.`);
  return { id, assigned: assignedTaskIds.has(id) };
}

function requiredTaskText(value: Record<string, unknown>, field: string, maximumBytes: number): string {
  const raw = value[field];
  if (typeof raw !== "string") throw new Error(`worker_beads_tasks expected non-empty ${field}.`);
  const result = boundedUtf8(raw, maximumBytes);
  if (!result.text) throw new Error(`worker_beads_tasks expected non-empty ${field}.`);
  if (result.truncated) throw new Error(`worker_beads_tasks ${field} exceeded ${maximumBytes} bytes.`);
  return result.text;
}

function requiredTaskInteger(value: Record<string, unknown>, field: string): number {
  const raw = value[field];
  if (!Number.isInteger(raw)) throw new Error(`worker_beads_tasks expected integer ${field}.`);
  return raw as number;
}

function optionalTaskInteger(value: Record<string, unknown>, field: string, fallback: number): number {
  const raw = value[field];
  return Number.isInteger(raw) && (raw as number) >= 0 ? raw as number : fallback;
}

function boundedUtf8(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value.trim(), "utf8");
  if (buffer.length <= maximumBytes) return { text: buffer.toString("utf8"), truncated: false };
  const suffix = Buffer.from("…", "utf8");
  let end = maximumBytes - suffix.length;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: `${buffer.subarray(0, end).toString("utf8")}…`, truncated: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
