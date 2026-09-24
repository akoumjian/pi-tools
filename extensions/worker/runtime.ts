import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type, validateToolArguments, type Static, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { unsettledAsyncShellJobsForOwner, unsettledPersistedAsyncShellJobsForOwner, type AsyncShellJobOwner } from "../async-shell/index.js";
import {
  createWorkerCacheLineageRuntime,
  validateWorkerCacheLineageRecord,
  type WorkerCacheLineageRecord
} from "./cache-lineage.js";
import { validateIntegrationHandoffShape } from "./integration.js";
import type { WorkerIntegrationRecord } from "./state.js";
import { inputJsonSchemaGuideline, outputJsonSchemaGuideline } from "../_shared/tool-prompt.js";
import {
  MAX_WORKER_TASK_IDS,
  WorkerHandoffParams,
  workerHandoffAdmissionPath,
  type AcceptedWorkerHandoff,
  type WorkerHandoff
} from "../_shared/worker-contract.js";

export { WorkerHandoffParams, type AcceptedWorkerHandoff, type WorkerHandoff } from "../_shared/worker-contract.js";

export const WorkerTaskUpdateParams = Type.Object({
  taskId: Type.String({ minLength: 1, maxLength: 128 }),
  note: Type.String({ minLength: 1, maxLength: 4000 }),
  status: Type.Optional(Type.Union([Type.Literal("in_progress"), Type.Literal("blocked")]))
}, { additionalProperties: false });

export type WorkerTaskUpdate = Static<typeof WorkerTaskUpdateParams>;

const MAX_WORKER_TASK_READ_LIMIT = 4;
const MAX_WORKER_TASK_RELATIONS = 4;
const MAX_WORKER_BEADS_OUTPUT_BYTES = 512 * 1024;
const MAX_WORKER_TASK_READ_CONTENT_BYTES = 64 * 1024;
const CENTRAL_TASK_ID_PATTERN = "^personal-[a-zA-Z0-9]+(?:\\.[a-zA-Z0-9]+)*$";

export const WorkerTaskReadParams = Type.Object({
  taskIds: Type.Optional(Type.Array(Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: CENTRAL_TASK_ID_PATTERN
  }), {
    minItems: 1,
    maxItems: MAX_WORKER_TASK_READ_LIMIT,
    description: `Central personal task IDs to read, whether assigned to this worker or not. At most ${MAX_WORKER_TASK_READ_LIMIT}; do not combine with query, offset, or limit.`
  })),
  query: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 256,
    description: "Title or ID query used to discover central personal tasks, including closed tasks; do not combine with taskIds or offset."
  })),
  offset: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: MAX_WORKER_TASK_IDS - 1,
    default: 0,
    description: "Zero-based offset into this worker's parent-assigned task IDs; use only without taskIds or query. Defaults to 0."
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_WORKER_TASK_READ_LIMIT,
    default: MAX_WORKER_TASK_READ_LIMIT,
    description: `Maximum assigned or search-matching tasks to return. Defaults to ${MAX_WORKER_TASK_READ_LIMIT}; omit with taskIds.`
  }))
}, { additionalProperties: false });

export type WorkerTaskRead = Static<typeof WorkerTaskReadParams>;

type WorkerTaskReadDetails = {
  scope: "assigned" | "requested" | "search";
  offset?: number;
  limit: number;
  totalAssigned: number;
  returned: number;
  nextOffset?: number;
  contentBytes: number;
  truncated: boolean;
};

type WorkerTaskRelationView = {
  id: string;
  assigned: boolean;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  dependencyType?: string;
  truncatedFields: string[];
};

type WorkerTaskView = {
  id: string;
  assigned: boolean;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  assignee?: string;
  parent?: { id: string; assigned: boolean };
  description?: string;
  notes?: string;
  acceptanceCriteria?: string;
  dependencyCount: number;
  dependentCount: number;
  dependencies: WorkerTaskRelationView[];
  dependents: WorkerTaskRelationView[];
  truncatedFields: string[];
};

type WorkerHandoffDetails =
  | { accepted: true; resultFile: string }
  | { accepted: false; activeJobIds: string[] };

export function readCacheLineageEnvironment(
  raw: string | undefined = process.env.PI_WORKER_CACHE_LINEAGE
): WorkerCacheLineageRecord | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid PI_WORKER_CACHE_LINEAGE JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validateWorkerCacheLineageRecord(parsed)) {
    throw new Error("Invalid PI_WORKER_CACHE_LINEAGE state.");
  }
  return parsed;
}

export default function workerRuntimeExtension(api: ExtensionAPI): void {
  const cacheLineage = createWorkerCacheLineageRuntime(readCacheLineageEnvironment());
  api.on("before_provider_request", (event, context) => cacheLineage.transformPayload(event.payload, context));
  api.on("before_provider_headers", (event, context) => cacheLineage.transformHeaders(event.headers, context));
  api.on("tool_call", (event) => cacheLineage.guardTool(event.toolName));
  api.on("session_shutdown", () => cacheLineage.restoreNetwork());

  api.registerTool(defineTool({
    name: "worker_task_read",
    label: "Worker Task Read",
    description: "Search central personal Beads tasks or read bounded context for assigned or explicitly requested task IDs, including direct dependencies and dependents. Every returned task and relationship says whether it is assigned to this worker. The trusted host adapter verifies the exact central route, invokes official bd read paths in --readonly mode, and returns bounded structured JSON without exposing the database, CLI, or BEADS_DIR inside Docker.",
    promptSnippet: "Search or read any central Beads task through the bounded worker_task_read adapter; returned records identify which tasks are assigned to this worker.",
    promptGuidelines: [
      "worker_task_read use: Call with offset/limit to page this worker's assigned tasks, with taskIds to read up to four arbitrary central personal tasks by ID, or with query/limit to discover tasks by title or ID across all statuses. Returned task and relationship records mark assigned IDs explicitly.",
      inputJsonSchemaGuideline("worker_task_read", WorkerTaskReadParams),
      outputJsonSchemaGuideline("worker_task_read", workerTaskReadOutputSchema()),
      `worker_task_read constraints: Searches or reads at most ${MAX_WORKER_TASK_READ_LIMIT} central personal task roots per call through official bd --readonly JSON semantics after exact route verification. Read access spans the central task store; worker_task_update remains restricted to parent-assigned IDs. Text fields, relationships, raw CLI output, and provider-visible content are bounded. The adapter cannot mutate Beads and does not expose bd, BEADS_DIR, database paths, or arbitrary command execution to worker shell processes.`
    ],
    parameters: WorkerTaskReadParams,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<AgentToolResult<WorkerTaskReadDetails>> {
      if (existsSync(workerRuntimeIdentity().resultFile)) {
        throw new Error("worker_task_read is sealed after worker_handoff acceptance.");
      }
      validateWorkerTaskReadMode(params);
      const runtime = workerTaskRuntime();
      verifyPersonalBeadsRoute(runtime);
      const assigned = [...runtime.taskIds];
      const explicitTaskIds = params.taskIds;
      const query = params.query;
      const requestedScope = explicitTaskIds !== undefined;
      const searchScope = query !== undefined;
      const scope = searchScope ? "search" : requestedScope ? "requested" : "assigned";
      const offset = scope === "assigned" ? params.offset ?? 0 : undefined;
      const limit = explicitTaskIds === undefined
        ? params.limit ?? MAX_WORKER_TASK_READ_LIMIT
        : explicitTaskIds.length;
      if (scope === "assigned" && offset! >= assigned.length) {
        throw new Error(`worker_task_read offset ${offset} exceeds ${assigned.length} assigned task IDs.`);
      }
      const taskIds = query !== undefined
        ? searchWorkerTaskIds(runtime, query, limit)
        : explicitTaskIds !== undefined
          ? requestedWorkerTaskIds(explicitTaskIds)
          : assigned.slice(offset, offset! + limit);
      const output = taskIds.length === 0 ? "[]" : readBeadsTaskPage(runtime, taskIds);
      const tasks = workerTaskViews(output, taskIds, runtime.taskIds);
      const truncated = tasks.some((task) =>
        task.truncatedFields.length > 0 ||
        [...task.dependencies, ...task.dependents].some((relation) => relation.truncatedFields.length > 0)
      );
      const nextOffset = scope === "assigned" && offset! + taskIds.length < assigned.length
        ? offset! + taskIds.length
        : undefined;
      const summary = scope === "search"
        ? `Found ${tasks.length} central Beads task${tasks.length === 1 ? "" : "s"}.`
        : scope === "requested"
          ? `Read ${tasks.length} requested central Beads task${tasks.length === 1 ? "" : "s"}.`
          : `Read ${tasks.length} of ${assigned.length} assigned Beads task${assigned.length === 1 ? "" : "s"}${nextOffset === undefined ? "." : `; continue with offset ${nextOffset}.`}`;
      const text = [
        summary,
        `Assigned to this worker: ${assigned.join(", ")}.`,
        "",
        JSON.stringify({ tasks }, null, 2)
      ].join("\n");
      const contentBytes = Buffer.byteLength(text, "utf8");
      if (contentBytes > MAX_WORKER_TASK_READ_CONTENT_BYTES) {
        throw new Error(`worker_task_read output exceeded ${MAX_WORKER_TASK_READ_CONTENT_BYTES} bytes after field bounds.`);
      }
      return {
        content: [{ type: "text", text }],
        details: {
          scope,
          ...(offset === undefined ? {} : { offset }),
          limit,
          totalAssigned: assigned.length,
          returned: tasks.length,
          ...(nextOffset === undefined ? {} : { nextOffset }),
          contentBytes,
          truncated
        }
      };
    }
  }));

  api.registerTool(defineTool({
    name: "worker_task_update",
    label: "Worker Task Update",
    description: "Append a durable progress note to one task explicitly assigned to this managed worker, optionally marking it in progress or blocked. The trusted adapter verifies the central personal Beads route before every mutation and cannot close tasks or mutate unassigned work.",
    promptSnippet: "Record durable progress on an assigned Beads task through the scoped worker_task_update adapter.",
    promptGuidelines: [
      "worker_task_update use: Record meaningful progress or a blocker on an assigned task before handoff; status may only remain in_progress or become blocked.",
      inputJsonSchemaGuideline("worker_task_update", WorkerTaskUpdateParams),
      outputJsonSchemaGuideline("worker_task_update", workerTaskUpdateOutputSchema()),
      "worker_task_update constraints: Only task IDs assigned by the parent are accepted. The adapter verifies the exact parent-recorded central personal route, appends rather than replaces notes, cannot close tasks, and never exposes Beads routing or credentials to worker shell processes."
    ],
    parameters: WorkerTaskUpdateParams,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<AgentToolResult<{ taskId: string; status?: string; recorded: true }>> {
      if (existsSync(workerRuntimeIdentity().resultFile)) {
        throw new Error("worker_task_update is sealed after worker_handoff acceptance.");
      }
      const runtime = workerTaskRuntime();
      if (!runtime.taskIds.has(params.taskId)) {
        throw new Error(`Worker ${runtime.workerId} is not authorized to mutate Beads task ${params.taskId}.`);
      }
      verifyPersonalBeadsRoute(runtime);
      const args = ["update", params.taskId, `--append-notes=${params.note.trim()}`];
      if (params.status) args.push("--status", params.status);
      args.push("--actor", `worker:${runtime.workerId}`, "--json");
      try {
        execFileSync(runtime.bdPath, args, {
          cwd: runtime.workspaceRoot,
          env: process.env,
          encoding: "utf8",
          maxBuffer: MAX_WORKER_BEADS_OUTPUT_BYTES,
          timeout: 10_000,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch {
        throw new Error(`worker_task_update could not record an update for ${params.taskId}.`);
      }
      return {
        content: [{ type: "text", text: `Recorded a durable worker note on ${params.taskId}${params.status ? ` and set status ${params.status}` : ""}.` }],
        details: { taskId: params.taskId, status: params.status, recorded: true }
      };
    }
  }));

  api.registerTool(defineTool({
    name: "worker_handoff",
    label: "Worker Handoff",
    description: "Submit the typed semantic handoff for the current managed worker run. Before calling it, inspect every owned async-shell job and decide to wait for it or cancel it; after cancellation, verify settlement. The handoff is accepted only when every owned job is durably terminal and its process group is independently gone. Use ready_for_review or assignment_complete for completed work; use needs_input, blocked, checkpoint, failed, or cancelled accurately when work should return to the parent without claiming completion.",
    promptSnippet: "Finish a managed worker run only after waiting for or cancelling every async-shell job and verifying quiescence, then submit one typed worker_handoff.",
    promptGuidelines: [
      "worker_handoff use: Before calling worker_handoff, inspect every shell job with shell_status or shell_read. Wait for active jobs that should finish, or call shell_cancel for jobs that should stop, then verify each job is terminal before returning control to the parent.",
      inputJsonSchemaGuideline("worker_handoff", WorkerHandoffParams),
      outputJsonSchemaGuideline("worker_handoff", workerHandoffOutputSchema()),
      "worker_handoff constraints: The runtime rejects handoff while owned async-shell jobs remain active and returns their job IDs. Wait, inspect, or cancel them, then retry. The trusted runtime writes the accepted handoff; do not write worker result files directly."
    ],
    parameters: WorkerHandoffParams,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<AgentToolResult<WorkerHandoffDetails>> {
      const identity = workerRuntimeIdentity();
      validateWorkerHandoff(params, identity.workerId, identity.workspaceRoot, assignedTaskIds());
      if (identity.integration) validateIntegrationHandoffShape(params, identity.integration);
      if (existsSync(identity.resultFile)) {
        throw new Error(`Worker handoff was already accepted for ${identity.workerId}/${identity.runId}.`);
      }
      const admissionFile = beginWorkerHandoffAdmission(identity);
      try {
        const unsettledJobs = [
          ...unsettledAsyncShellJobsForOwner(identity.owner),
          ...unsettledPersistedAsyncShellJobsForOwner(identity.asyncJobRoot, identity.owner)
        ];
        const activeJobIds = [...new Set(unsettledJobs.map((job) => job.jobId))].sort();
        if (activeJobIds.length > 0) {
          return {
            content: [{ type: "text", text: `Worker handoff was not accepted because ${activeJobIds.length} owned async-shell job${activeJobIds.length === 1 ? " is not" : "s are not"} verifiably settled: ${activeJobIds.join(", ")}. Wait for completion or cancel the jobs, verify terminal status, then call worker_handoff again.` }],
            details: { accepted: false, activeJobIds }
          };
        }
        const accepted: AcceptedWorkerHandoff = {
          version: 1,
          workerId: identity.workerId,
          runId: identity.runId,
          acceptedAt: new Date().toISOString(),
          handoff: params
        };
        writeAtomicJson(identity.resultFile, accepted);
        return {
          content: [{ type: "text", text: `Worker handoff accepted for ${identity.workerId}/${identity.runId}. The parent will receive the typed result after this tool result is persisted.` }],
          details: { accepted: true, resultFile: identity.resultFile }
        };
      } finally {
        rmSync(admissionFile, { force: true });
      }
    }
  }));
}

export function readWorkerRuntimeHandoff(resultFile: string): AcceptedWorkerHandoff {
  const value = JSON.parse(readFileSync(resultFile, "utf8")) as Partial<AcceptedWorkerHandoff>;
  if (
    value.version !== 1 ||
    typeof value.workerId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.acceptedAt !== "string" ||
    !value.handoff
  ) {
    throw new Error(`Invalid worker handoff result: ${resultFile}`);
  }
  const handoff = validateToolArguments(
    { name: "worker_handoff", description: "Validate a persisted worker handoff.", parameters: WorkerHandoffParams } as Tool,
    { type: "toolCall", id: "persisted-worker-handoff", name: "worker_handoff", arguments: value.handoff } as ToolCall
  ) as WorkerHandoff;
  return { version: 1, workerId: value.workerId, runId: value.runId, acceptedAt: value.acceptedAt, handoff };
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
    throw new Error("worker_task_read accepts either taskIds or query, not both.");
  }
  if (hasTaskIds && (params.offset !== undefined || params.limit !== undefined)) {
    throw new Error("worker_task_read taskIds cannot be combined with offset or limit.");
  }
  if (hasQuery && params.offset !== undefined) {
    throw new Error("worker_task_read query cannot be combined with offset.");
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
    throw new Error(`worker_task_read requires 1-${MAX_WORKER_TASK_READ_LIMIT} unique central personal task IDs.`);
  }
  return value as string[];
}

function isCentralTaskId(value: string): boolean {
  return new RegExp(CENTRAL_TASK_ID_PATTERN).test(value);
}

function validateWorkerHandoff(
  handoff: WorkerHandoff,
  workerId: string,
  workspaceRoot: string,
  taskIds: Set<string>
): void {
  for (const update of handoff.taskUpdates) {
    if (!taskIds.has(update.taskId)) {
      throw new Error(`Worker ${workerId} cannot hand off an update for unassigned task ${update.taskId}.`);
    }
  }
  for (const repository of handoff.repositories ?? []) {
    if (Buffer.byteLength(repository.workspaceRepo, "utf8") > 1024) {
      throw new Error(`Worker handoff repository path exceeds the bounded identity limit: ${repository.workspaceRepo}`);
    }
    assertWorkerRepositoryPath(repository.workspaceRepo, workspaceRoot);
  }
  for (const check of handoff.checks ?? []) {
    assertWorkspaceRelativePath("check cwd", check.cwd, workspaceRoot);
    if (check.logPath) assertWorkspaceRelativePath("check log", check.logPath, workspaceRoot);
  }
}

function assertWorkerRepositoryPath(value: string, workspaceRoot: string): void {
  const root = realpathSync(workspaceRoot);
  const repositoriesRoot = path.join(root, "repos");
  const resolved = path.resolve(root, value);
  if (resolved === repositoriesRoot || !resolved.startsWith(`${repositoriesRoot}${path.sep}`)) {
    throw new Error(`Worker handoff repository path must be below the workspace repos/ directory: ${value}`);
  }
  assertWorkspaceRelativePath("repository", value, workspaceRoot, false);
}

function assertWorkspaceRelativePath(label: string, value: string, workspaceRoot: string, allowRoot = true): void {
  if (path.isAbsolute(value)) throw new Error(`Worker handoff ${label} path must be workspace-relative: ${value}`);
  const root = realpathSync(workspaceRoot);
  const resolved = path.resolve(root, value);
  if (!allowRoot && resolved === root) {
    throw new Error(`Worker handoff ${label} path must identify a repository below the workspace root: ${value}`);
  }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Worker handoff ${label} path escapes the workspace: ${value}`);
  }
  let existing = resolved;
  while (!existsSync(existing) && existing !== root) existing = path.dirname(existing);
  const real = realpathSync(existing);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Worker handoff ${label} path resolves outside the workspace: ${value}`);
  }
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
    throw new Error("worker_task_read requires a non-empty bounded search query.");
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
    throw new Error("worker_task_read could not search central Beads tasks.");
  }
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new Error("worker_task_read received invalid JSON from Beads search.");
  }
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error("worker_task_read received an invalid bounded Beads search response.");
  }
  const taskIds = value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("worker_task_read received an invalid Beads search record.");
    const taskId = requiredTaskText(candidate, "id", 128);
    if (!isCentralTaskId(taskId)) throw new Error("worker_task_read received an invalid central task ID.");
    return taskId;
  });
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error("worker_task_read received duplicate Beads search records.");
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
    throw new Error("worker_task_read could not read the requested Beads task page.");
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
    throw new Error("worker_task_read received invalid JSON from Beads.");
  }
  if (!Array.isArray(value)) throw new Error("worker_task_read expected bd show to return a JSON array.");
  const byId = new Map<string, Record<string, unknown>>();
  for (const candidate of value) {
    if (!isRecord(candidate)) throw new Error("worker_task_read received an invalid Beads task record.");
    const taskId = requiredTaskText(candidate, "id", 128);
    if (byId.has(taskId)) throw new Error("worker_task_read received duplicate Beads task records.");
    byId.set(taskId, candidate);
  }
  if (byId.size !== expectedTaskIds.length || expectedTaskIds.some((taskId) => !byId.has(taskId))) {
    throw new Error("worker_task_read Beads response did not match the requested task IDs.");
  }
  return expectedTaskIds.map((taskId) => workerTaskView(byId.get(taskId)!, assignedTaskIds));
}

function workerTaskView(value: Record<string, unknown>, assignedTaskIds: ReadonlySet<string>): WorkerTaskView {
  const truncatedFields: string[] = [];
  const bounded = (field: string, maximumBytes: number): string | undefined => {
    const raw = value[field];
    if (raw === undefined || raw === null || raw === "") return undefined;
    if (typeof raw !== "string") throw new Error(`worker_task_read expected ${field} to be text.`);
    const result = boundedUtf8(raw, maximumBytes);
    if (!result.text) return undefined;
    if (result.truncated) truncatedFields.push(field);
    return result.text;
  };
  const title = bounded("title", 512);
  if (!title) throw new Error("worker_task_read expected non-empty title.");
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
  if (!Array.isArray(value)) throw new Error(`worker_task_read expected ${field} to be an array.`);
  if (value.length > MAX_WORKER_TASK_RELATIONS) truncatedFields.push(field);
  return value.slice(0, MAX_WORKER_TASK_RELATIONS).map((candidate) => {
    if (!isRecord(candidate)) throw new Error(`worker_task_read received an invalid ${field} record.`);
    const truncatedFields: string[] = [];
    const rawTitle = candidate.title;
    if (typeof rawTitle !== "string") throw new Error(`worker_task_read expected non-empty ${field} title.`);
    const title = boundedUtf8(rawTitle, 512);
    if (!title.text) throw new Error(`worker_task_read expected non-empty ${field} title.`);
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
  if (!isCentralTaskId(id)) throw new Error(`worker_task_read expected a central task ID in ${field}.`);
  return { id, assigned: assignedTaskIds.has(id) };
}

function requiredTaskText(value: Record<string, unknown>, field: string, maximumBytes: number): string {
  const raw = value[field];
  if (typeof raw !== "string") throw new Error(`worker_task_read expected non-empty ${field}.`);
  const result = boundedUtf8(raw, maximumBytes);
  if (!result.text) throw new Error(`worker_task_read expected non-empty ${field}.`);
  if (result.truncated) throw new Error(`worker_task_read ${field} exceeded ${maximumBytes} bytes.`);
  return result.text;
}

function requiredTaskInteger(value: Record<string, unknown>, field: string): number {
  const raw = value[field];
  if (!Number.isInteger(raw)) throw new Error(`worker_task_read expected integer ${field}.`);
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
