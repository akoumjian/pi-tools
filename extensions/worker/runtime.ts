import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type, validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { unsettledAsyncShellJobsForOwner, unsettledPersistedAsyncShellJobsForOwner, type AsyncShellJobOwner } from "../async-shell/index.js";
import { createWorkerCacheLineageRuntime, registerWorkerCacheLineageRuntimeHooks, validateWorkerCacheLineageRecord, type WorkerCacheLineageRecord } from "./cache-lineage.js";
import { WorkerBeadsTasksParams, WorkerResultSubmitParams, normalizeWorkspaceResultPaths, validateWorkerResultInput, type WorkerResultSubmitInput } from "./contract.js";
import type { WorkerRole } from "./registry.js";
import type { WorkerIntegrationRecord } from "./state.js";
import { inputJsonSchemaGuideline, outputJsonSchemaGuideline } from "../_shared/tool-prompt.js";
import { MAX_WORKER_TASK_IDS, workerHandoffAdmissionPath, type AcceptedWorkerHandoff as LegacyAcceptedWorkerHandoff } from "../_shared/worker-contract.js";

export type AcceptedWorkerResult = { version: 2; workerId: string; runId: string; acceptedAt: string; result: WorkerResultSubmitInput & { repositories?: string[]; artifacts?: string[] } };
export type WorkerTaskUpdate = { taskId: string; note: string; status?: "in_progress" | "blocked" };
export type WorkerTaskRead = { taskIds?: string[]; query?: string; offset?: number; limit?: number };
type WorkerTaskReadDetails = { scope: "assigned" | "requested" | "search"; offset?: number; limit: number; totalAssigned: number; returned: number; nextOffset?: number; contentBytes: number; truncated: boolean };
type WorkerTaskRelationView = { id: string; assigned: boolean; title: string; status: string; priority: number; issueType: string; dependencyType?: string; truncatedFields: string[] };
type WorkerTaskView = { id: string; assigned: boolean; title: string; status: string; priority: number; issueType: string; assignee?: string; parent?: { id: string; assigned: boolean }; description?: string; notes?: string; acceptanceCriteria?: string; dependencyCount: number; dependentCount: number; dependencies: WorkerTaskRelationView[]; dependents: WorkerTaskRelationView[]; truncatedFields: string[] };
type WorkerResultDetails = { accepted: true; resultFile: string } | { accepted: false; activeJobIds: string[] };
const MAX_WORKER_TASK_READ_LIMIT = 32;
const MAX_WORKER_TASK_RELATIONS = 4;
const MAX_WORKER_BEADS_OUTPUT_BYTES = 512 * 1024;
const MAX_WORKER_TASK_READ_CONTENT_BYTES = 64 * 1024;
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
    name: "worker_beads_tasks", label: "Worker Beads Tasks",
    description: "Read assigned or relevant central Beads tasks, search bounded task metadata, or append progress to one assigned task. Only work and integration workers may update tasks; closure and dependency changes remain parent-owned.",
    promptSnippet: "Read/search Beads tasks or update one assigned task with worker_beads_tasks.",
    promptGuidelines: [
      "worker_beads_tasks use: Use assigned for this worker's task page, get for exact task IDs, search for bounded discovery, and update only for meaningful progress or blockers on one assigned task.",
      inputJsonSchemaGuideline("worker_beads_tasks", WorkerBeadsTasksParams),
      "worker_beads_tasks constraints: Reads are bounded. Updates append notes and may set only in_progress or blocked; review workers cannot update. The adapter never exposes the database, routing, or arbitrary commands."
    ],
    parameters: WorkerBeadsTasksParams, executionMode: "sequential",
    async execute(_id, params): Promise<AgentToolResult<unknown>> {
      assertRuntimeOpen("worker_beads_tasks");
      validateBeadsAction(params);
      if (params.action === "update") return executeTaskUpdate({ taskId: params.taskId!, note: params.note!, status: params.status });
      const read: WorkerTaskRead = params.action === "assigned"
        ? { offset: params.offset, limit: params.limit }
        : params.action === "get" ? { taskIds: params.taskIds! } : { query: params.query!, limit: params.limit };
      return executeTaskRead(read);
    }
  }));
  api.registerTool(defineTool({
    name: "worker_result_submit", label: "Submit Worker Result",
    description: "Submit the final typed result for the current managed-worker run after every owned asynchronous shell job is durably terminal. Outcomes and allowed repository reporting depend on the worker role.",
    promptSnippet: "Settle every shell job, then submit one final worker result.",
    promptGuidelines: [
      "worker_result_submit use: Call exactly once when the run should return to the parent. Use completed/approve/request_changes only with concise evidence; needs_input requires one focused question.",
      inputJsonSchemaGuideline("worker_result_submit", WorkerResultSubmitParams),
      "worker_result_submit constraints: The runtime rejects active shell jobs, invalid role outcomes, paths outside the workspace, non-repository repository paths, duplicate paths, and review decisions without a report artifact."
    ],
    parameters: WorkerResultSubmitParams, executionMode: "sequential",
    async execute(_id, params): Promise<AgentToolResult<WorkerResultDetails>> {
      const identity = workerRuntimeIdentity();
      if (existsSync(identity.resultFile)) throw new Error(`Worker result was already accepted for ${identity.workerId}/${identity.runId}.`);
      const role = workerRuntimeRole();
      validateWorkerResultInput(role, params);
      const repositories = normalizeWorkspaceResultPaths(identity.workspaceRoot, params.repositories ?? [], "repository", resultPathMetadata);
      const artifacts = normalizeWorkspaceResultPaths(identity.workspaceRoot, params.artifacts ?? [], "artifact", resultPathMetadata);
      const admissionFile = beginWorkerHandoffAdmission(identity);
      try {
        const unsettledJobs = [...unsettledAsyncShellJobsForOwner(identity.owner), ...unsettledPersistedAsyncShellJobsForOwner(identity.asyncJobRoot, identity.owner)];
        const activeJobIds = [...new Set(unsettledJobs.map((job) => job.jobId))].sort();
        if (activeJobIds.length > 0) return { content: [{ type: "text", text: `Worker result was not accepted because ${activeJobIds.length} owned async-shell job${activeJobIds.length === 1 ? " is" : "s are"} still active: ${activeJobIds.join(", ")}.` }], details: { accepted: false, activeJobIds } };
        const accepted: AcceptedWorkerResult = { version: 2, workerId: identity.workerId, runId: identity.runId, acceptedAt: new Date().toISOString(), result: { ...params, ...(repositories.length ? { repositories } : {}), ...(artifacts.length ? { artifacts } : {}) } };
        writeAtomicJson(identity.resultFile, accepted);
        return { content: [{ type: "text", text: `Worker result accepted for ${identity.workerId}/${identity.runId}.` }], details: { accepted: true, resultFile: identity.resultFile } };
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


/** Internal compatibility envelope for the existing durable host settlement machinery. */
export type AcceptedWorkerHandoff = LegacyAcceptedWorkerHandoff;
export function readWorkerRuntimeHandoff(resultFile: string): AcceptedWorkerHandoff {
  const accepted = readWorkerRuntimeResult(resultFile);
  const outcome = accepted.result.outcome;
  const state: AcceptedWorkerHandoff["handoff"]["state"] = outcome === "completed" || outcome === "approve" || outcome === "request_changes" ? "assignment_complete" : outcome;
  return { version: 1, workerId: accepted.workerId, runId: accepted.runId, acceptedAt: accepted.acceptedAt, handoff: {
    state, summary: accepted.result.summary, taskUpdates: [],
    ...(accepted.result.repositories?.length ? { repositories: accepted.result.repositories.map((workspaceRepo) => ({ workspaceRepo, purpose: "Reported worker repository" })) } : {}),
    checks: [], ...(accepted.result.question ? { question: accepted.result.question } : {})
  } };
}

function validateBeadsAction(params: any): void {
  const keys = Object.keys(params); const allowed = params.action === "assigned" ? ["action","offset","limit"] : params.action === "get" ? ["action","taskIds"] : params.action === "search" ? ["action","query","limit"] : ["action","taskId","note","status"];
  if (!keys.every((key) => allowed.includes(key))) throw new Error(`worker_beads_tasks ${params.action} received unsupported fields.`);
  if (params.action === "get" && !params.taskIds?.length) throw new Error("worker_beads_tasks get requires taskIds.");
  if (params.action === "search" && !params.query?.trim()) throw new Error("worker_beads_tasks search requires query.");
  if (params.action === "update" && (!params.taskId || !params.note?.trim())) throw new Error("worker_beads_tasks update requires taskId and note.");
}

function assertRuntimeOpen(tool: string): void { if (existsSync(workerRuntimeIdentity().resultFile)) throw new Error(`${tool} is sealed after worker_result_submit acceptance.`); }
function workerRuntimeRole(): WorkerRole { const value = requiredEnvironment("PI_WORKER_ROLE"); if (value !== "work" && value !== "review" && value !== "integration") throw new Error(`Invalid PI_WORKER_ROLE: ${value}.`); return value; }
function resultPathMetadata(value: string): { exists: boolean; directory: boolean; file: boolean; repository: boolean } {
  if (!existsSync(value)) return { exists: false, directory: false, file: false, repository: false };
  const metadata = lstatSync(value);
  let repository = false;
  if (metadata.isDirectory()) { try { execFileSync("git", ["-C", value, "rev-parse", "--git-dir"], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }); repository = true; } catch {} }
  return { exists: true, directory: metadata.isDirectory(), file: metadata.isFile(), repository };
}

async function executeTaskRead(params: WorkerTaskRead): Promise<AgentToolResult<WorkerTaskReadDetails>> {
  validateWorkerTaskReadMode(params);
  const runtime = workerTaskRuntime(); verifyPersonalBeadsRoute(runtime);
  const assigned = [...runtime.taskIds]; const explicitTaskIds = params.taskIds; const query = params.query;
  const scope = query !== undefined ? "search" : explicitTaskIds !== undefined ? "requested" : "assigned";
  const offset = scope === "assigned" ? params.offset ?? 0 : undefined;
  const limit = explicitTaskIds === undefined ? params.limit ?? Math.min(MAX_WORKER_TASK_READ_LIMIT, 4) : explicitTaskIds.length;
  if (scope === "assigned" && offset! >= assigned.length) throw new Error(`worker_beads_tasks offset ${offset} exceeds ${assigned.length} assigned task IDs.`);
  const taskIds = query !== undefined ? searchWorkerTaskIds(runtime, query, limit) : explicitTaskIds !== undefined ? requestedWorkerTaskIds(explicitTaskIds) : assigned.slice(offset, offset! + limit);
  const output = taskIds.length === 0 ? "[]" : readBeadsTaskPage(runtime, taskIds);
  const tasks = workerTaskViews(output, taskIds, runtime.taskIds);
  const truncated = tasks.some((task) => task.truncatedFields.length > 0 || [...task.dependencies, ...task.dependents].some((relation) => relation.truncatedFields.length > 0));
  const nextOffset = scope === "assigned" && offset! + taskIds.length < assigned.length ? offset! + taskIds.length : undefined;
  const text = JSON.stringify({ scope, assignedTaskIds: assigned, tasks, ...(nextOffset === undefined ? {} : { nextOffset }) }, null, 2);
  const contentBytes = Buffer.byteLength(text, "utf8");
  if (contentBytes > MAX_WORKER_TASK_READ_CONTENT_BYTES) throw new Error(`worker_beads_tasks output exceeded ${MAX_WORKER_TASK_READ_CONTENT_BYTES} bytes.`);
  return { content: [{ type: "text", text }], details: { scope, ...(offset === undefined ? {} : { offset }), limit, totalAssigned: assigned.length, returned: tasks.length, ...(nextOffset === undefined ? {} : { nextOffset }), contentBytes, truncated } };
}

async function executeTaskUpdate(params: WorkerTaskUpdate): Promise<AgentToolResult<{ taskId: string; status?: string; recorded: true }>> {
  if (workerRuntimeRole() === "review") throw new Error("Review workers cannot update Beads tasks.");
  const runtime = workerTaskRuntime(); if (!runtime.taskIds.has(params.taskId)) throw new Error(`Worker ${runtime.workerId} is not authorized to mutate Beads task ${params.taskId}.`);
  verifyPersonalBeadsRoute(runtime);
  const args = ["update", params.taskId, `--append-notes=${params.note.trim()}`]; if (params.status) args.push("--status", params.status); args.push("--actor", `worker:${runtime.workerId}`, "--json");
  try { execFileSync(runtime.bdPath, args, { cwd: runtime.workspaceRoot, env: process.env, encoding: "utf8", maxBuffer: MAX_WORKER_BEADS_OUTPUT_BYTES, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { throw new Error(`worker_beads_tasks could not record an update for ${params.taskId}.`); }
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

function readBeadsTaskPage(runtime: ReturnType<typeof workerTaskRuntime>, taskIds: readonly string[]): string {
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

function verifyPersonalBeadsRoute(runtime: ReturnType<typeof workerTaskRuntime>): void {
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
  owner: AsyncShellJobOwner;
  integration?: WorkerIntegrationRecord;
} {
  const workerId = requiredEnvironment("PI_WORKER_ID");
  const runId = requiredEnvironment("PI_WORKER_RUN_ID");
  const integrationValue = process.env.PI_WORKER_INTEGRATION?.trim();
  const integration = integrationValue ? JSON.parse(integrationValue) as WorkerIntegrationRecord : undefined;
  return {
    workerId,
    runId,
    resultFile: path.resolve(requiredEnvironment("PI_WORKER_RESULT_FILE")),
    workspaceRoot: path.resolve(requiredEnvironment("PI_WORKER_WORKSPACE_ROOT")),
    asyncJobRoot: path.resolve(requiredEnvironment("PI_WORKER_ASYNC_JOB_ROOT")),
    integration,
    owner: { kind: "worker-run", workerId, runId }
  };
}

function beginWorkerHandoffAdmission(identity: ReturnType<typeof workerRuntimeIdentity>): string {
  mkdirSync(path.dirname(identity.resultFile), { recursive: true, mode: 0o700 });
  const admissionFile = workerHandoffAdmissionPath(identity.resultFile);
  try {
    writeFileSync(admissionFile, `${JSON.stringify({
      version: 1,
      workerId: identity.workerId,
      runId: identity.runId,
      pid: process.pid,
      startedAt: new Date().toISOString()
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Worker handoff admission is already active for ${identity.workerId}/${identity.runId}.`);
    }
    throw cause;
  }
  return admissionFile;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Worker runtime requires ${name}.`);
  return value;
}

function writeAtomicJson(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function workerTaskViews(
  output: string,
  expectedTaskIds: readonly string[],
  assignedTaskIds: ReadonlySet<string>
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
  return expectedTaskIds.map((taskId) => workerTaskView(byId.get(taskId)!, assignedTaskIds));
}

function workerTaskView(value: Record<string, unknown>, assignedTaskIds: ReadonlySet<string>): WorkerTaskView {
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

function workerTaskReadOutputSchema() {
  const textContent = Type.Object({ type: Type.Literal("text"), text: Type.String() }, { additionalProperties: false });
  return Type.Object({
    content: Type.Array(textContent, { minItems: 1, maxItems: 1 }),
    details: Type.Object({
      scope: Type.Union([Type.Literal("assigned"), Type.Literal("requested"), Type.Literal("search")]),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WORKER_TASK_IDS - 1 })),
      limit: Type.Integer({ minimum: 1, maximum: MAX_WORKER_TASK_READ_LIMIT }),
      totalAssigned: Type.Integer({ minimum: 1, maximum: MAX_WORKER_TASK_IDS }),
      returned: Type.Integer({ minimum: 0, maximum: MAX_WORKER_TASK_READ_LIMIT }),
      nextOffset: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKER_TASK_IDS - 1 })),
      contentBytes: Type.Integer({ minimum: 1, maximum: MAX_WORKER_TASK_READ_CONTENT_BYTES }),
      truncated: Type.Boolean()
    }, { additionalProperties: false })
  }, { additionalProperties: false });
}

function workerTaskUpdateOutputSchema() {
  const textContent = Type.Object({ type: Type.Literal("text"), text: Type.String() }, { additionalProperties: false });
  return Type.Object({
    content: Type.Array(textContent, { minItems: 1, maxItems: 1 }),
    details: Type.Object({
      taskId: Type.String({ minLength: 1 }),
      status: Type.Optional(Type.String({ minLength: 1 })),
      recorded: Type.Literal(true)
    }, { additionalProperties: false })
  }, { additionalProperties: false });
}

function workerHandoffOutputSchema() {
  const textContent = Type.Object({ type: Type.Literal("text"), text: Type.String() }, { additionalProperties: false });
  return Type.Object({
    content: Type.Array(textContent, { minItems: 1, maxItems: 1 }),
    details: Type.Union([
      Type.Object({ accepted: Type.Literal(true), resultFile: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      Type.Object({ accepted: Type.Literal(false), activeJobIds: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false })
    ])
  }, { additionalProperties: false });
}
