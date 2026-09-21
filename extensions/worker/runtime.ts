import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type, validateToolArguments, type Static, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { unsettledAsyncShellJobsForOwner, type AsyncShellJobOwner } from "../async-shell/index.js";
import { inputJsonSchemaGuideline, outputJsonSchemaGuideline } from "../_shared/tool-prompt.js";
import {
  WorkerHandoffParams,
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

type WorkerHandoffDetails =
  | { accepted: true; resultFile: string }
  | { accepted: false; activeJobIds: string[] };

export default function workerRuntimeExtension(api: ExtensionAPI): void {
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
      execFileSync(runtime.bdPath, args, {
        cwd: runtime.workspaceRoot,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      return {
        content: [{ type: "text", text: `Recorded a durable worker note on ${params.taskId}${params.status ? ` and set status ${params.status}` : ""}.` }],
        details: { taskId: params.taskId, status: params.status, recorded: true }
      };
    }
  }));

  api.registerTool(defineTool({
    name: "worker_handoff",
    label: "Worker Handoff",
    description: "Submit the typed semantic handoff for the current managed worker run. The handoff is accepted only when every async-shell job owned by this worker run has settled. Use ready_for_review or assignment_complete for completed work; use needs_input, blocked, checkpoint, failed, or cancelled accurately when work should return to the parent without claiming completion.",
    promptSnippet: "Finish a managed worker run with one typed, quiescent worker_handoff containing task updates, repository intent, checks, and any question or blocker.",
    promptGuidelines: [
      "worker_handoff use: Call worker_handoff exactly once when returning control to the parent; do not claim completion while shell jobs or other side effects remain active.",
      inputJsonSchemaGuideline("worker_handoff", WorkerHandoffParams),
      outputJsonSchemaGuideline("worker_handoff", workerHandoffOutputSchema()),
      "worker_handoff constraints: The runtime rejects handoff while owned async-shell jobs remain active and returns their job IDs. Wait, inspect, or cancel them, then retry. The trusted runtime writes the accepted handoff; do not write worker result files directly."
    ],
    parameters: WorkerHandoffParams,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<AgentToolResult<WorkerHandoffDetails>> {
      const identity = workerRuntimeIdentity();
      validateWorkerHandoff(params, identity.workerId, identity.workspaceRoot, assignedTaskIds());
      const activeJobs = unsettledAsyncShellJobsForOwner(identity.owner);
      if (activeJobs.length > 0) {
        const activeJobIds = activeJobs.map((job) => job.jobId);
        return {
          content: [{ type: "text", text: `Worker handoff was not accepted because ${activeJobIds.length} owned async-shell job${activeJobIds.length === 1 ? " is" : "s are"} still running: ${activeJobIds.join(", ")}. Wait for completion or cancel the jobs, then call worker_handoff again.` }],
          details: { accepted: false, activeJobIds }
        };
      }
      if (existsSync(identity.resultFile)) {
        throw new Error(`Worker handoff was already accepted for ${identity.workerId}/${identity.runId}.`);
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
  if (!Array.isArray(rawTaskIds) || rawTaskIds.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error("Worker runtime requires PI_WORKER_TASK_IDS to contain a JSON string array.");
  }
  return new Set(rawTaskIds);
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
    assertWorkspaceRelativePath("repository", repository.workspaceRepo, workspaceRoot);
  }
  for (const check of handoff.checks ?? []) {
    assertWorkspaceRelativePath("check cwd", check.cwd, workspaceRoot);
    if (check.logPath) assertWorkspaceRelativePath("check log", check.logPath, workspaceRoot);
  }
}

function assertWorkspaceRelativePath(label: string, value: string, workspaceRoot: string): void {
  if (path.isAbsolute(value)) throw new Error(`Worker handoff ${label} path must be workspace-relative: ${value}`);
  const root = realpathSync(workspaceRoot);
  const resolved = path.resolve(root, value);
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

function verifyPersonalBeadsRoute(runtime: ReturnType<typeof workerTaskRuntime>): void {
  const output = execFileSync(runtime.bdPath, ["where", "--json"], {
    cwd: runtime.workspaceRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const route = JSON.parse(output) as { prefix?: unknown; path?: unknown; database_path?: unknown };
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
    throw new Error("Worker Beads mutation requires the unchanged ambient central BEADS_DIR route.");
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
  owner: AsyncShellJobOwner;
} {
  const workerId = requiredEnvironment("PI_WORKER_ID");
  const runId = requiredEnvironment("PI_WORKER_RUN_ID");
  return {
    workerId,
    runId,
    resultFile: path.resolve(requiredEnvironment("PI_WORKER_RESULT_FILE")),
    workspaceRoot: path.resolve(requiredEnvironment("PI_WORKER_WORKSPACE_ROOT")),
    owner: { kind: "worker-run", workerId, runId }
  };
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
