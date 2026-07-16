import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { readSetupGuidance } from "../_shared/setup-command.js";
import { validateChildToolAllowlist } from "../_shared/child-agent-session.js";
import { formatModelName, resolveExtensionModel } from "../_shared/model-spec.js";
import { writeAgentExtensionConfig } from "../_shared/config.js";
import {
  canonicalModelSpec,
  resolveTaskModel,
  selectDistinctReviewer,
  type OrchestratorTaskRole
} from "./models.js";
import {
  ORCHESTRATOR_CONFIG_FILE,
  orchestratorSetupUsage,
  parseOrchestratorSetupArgs,
  readOrchestratorSettings,
  serializeOrchestratorSettings,
  type OrchestratorModelSettings,
  type OrchestratorSettings
} from "./settings.js";
import { buildMergeGateMessage, runReconcile, type ReconcileReport } from "./integrate.js";
import { reviewWriterBranch, type WriterReviewReport } from "./review.js";
import { spawnOrchestratedAgent, type SpawnOrchestratedAgentResult } from "./spawn.js";
import { runWriterTask, type WriterWorktreeReport } from "./writer.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const TaskParams = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, description: "Stable task id used in result labels." })),
  task: Type.String({ minLength: 1, description: "Focused task delegated to an isolated child session." }),
  role: Type.Optional(Type.Union([Type.Literal("reader"), Type.Literal("planner"), Type.Literal("writer")], {
    default: "reader",
    description: "Reader gathers evidence; planner returns a dependency/validation-aware plan; writer edits inside a confined managed worktree (requires writesEnabled and dryRun=false)."
  })),
  model: Type.Optional(Type.String({ minLength: 1, description: "Optional provider/model override chosen by the orchestrator." })),
  thinkingLevel: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)), {
    description: "Optional thinking override for this task."
  }))
}, { additionalProperties: false });

const OrchestrateParams = Type.Object({
  tasks: Type.Array(TaskParams, { minItems: 1, maxItems: 8, description: "Independent tasks to execute; reads run with bounded concurrency, writers run serialized in listed order." })
}, { additionalProperties: false });

const ReconcileParams = Type.Object({
  branches: Type.Array(Type.String({ minLength: 1, pattern: "^orch/" }), {
    minItems: 1,
    maxItems: 8,
    description: "Kept orchestrator writer branches (orch/*) from prior orchestrate results to fold into one integration branch."
  })
}, { additionalProperties: false });

type OrchestratedTaskRoleInput = "reader" | "planner" | "writer";

type OrchestratedTask = {
  id?: string;
  task: string;
  role?: OrchestratedTaskRoleInput;
  model?: string;
  thinkingLevel?: ThinkingLevel;
};

type OrchestratedTaskResult = SpawnOrchestratedAgentResult & {
  id: string;
  role: OrchestratedTaskRoleInput;
  status: "completed" | "failed";
  error?: string;
  worktree?: WriterWorktreeReport;
  commit?: string;
  changedFiles?: string[];
  review?: WriterReviewReport;
};

type OrchestrateDetails = {
  mode: "read-only" | "read-write";
  configSource: string;
  results: OrchestratedTaskResult[];
};

export default function orchestratorExtension(api: ExtensionAPI): void {
  api.registerCommand("orchestrator:setup", {
    description: "Configure orchestrator worker/reader/planner models and independent reviewer pool",
    handler: async (args, context) => handleSetup(args, context)
  });
  api.registerCommand("orchestrator:status", {
    description: "Show orchestrator models, safety mode, tools, and config source",
    handler: async (_args, context) => context.ui.notify(buildOrchestratorStatusText(readOrchestratorSettings()), "info")
  });

  api.registerTool(defineTool({
    name: "orchestrate",
    label: "Orchestrate",
    description: [
      "Run focused reader/planner/writer subagents in isolated in-process sessions.",
      "The orchestrating agent may choose provider/model and thinkingLevel per task; configured role defaults apply otherwise.",
      "Readers/planners are read-only by instruction and run with bounded parallelism; all children may use async-shell commands governed by the tool-safety policy, with escalations denied fail-closed.",
      "Writers require writesEnabled=true and dryRun=false, run serialized, and edit only inside a per-task managed git worktree branch that is committed by the harness and removed automatically when nothing was written.",
      "Every kept writer branch is independently reviewed by a configured different-provider model whose VERDICT is attached to the result; no merge or integration happens automatically."
    ].join(" "),
    parameters: OrchestrateParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, context): Promise<AgentToolResult<OrchestrateDetails>> {
      const settings = readOrchestratorSettings();
      const tasks = params.tasks as OrchestratedTask[];
      if (tasks.length > settings.maxTasksPerRun) {
        throw new Error(`Orchestrator task count ${tasks.length} exceeds configured maxTasksPerRun ${settings.maxTasksPerRun}.`);
      }
      const writerIndexes = tasks.flatMap((task, index) => (task.role === "writer" ? [index] : []));
      const readIndexes = tasks.flatMap((task, index) => (task.role === "writer" ? [] : [index]));
      const mode: OrchestrateDetails["mode"] = writerIndexes.length > 0 ? "read-write" : "read-only";
      if (writerIndexes.length > 0) {
        if (!settings.writesEnabled) {
          throw new Error("Orchestrator writer tasks are refused: writes are disabled (writesEnabled=false). Review the writer rollout, then enable writesEnabled in orchestrator settings.");
        }
        if (settings.dryRun) {
          throw new Error("Orchestrator writer tasks are refused while dryRun is enabled. Set dryRun=false in orchestrator settings to execute confined writers.");
        }
      }
      const writerTools = [...settings.readOnlyTools, ...settings.writeTools];
      validateChildToolAllowlist(
        api.getAllTools(),
        [...(writerIndexes.length > 0 ? writerTools : settings.readOnlyTools), ...settings.shellTools],
        "Orchestrator",
        settings.configSource
      );

      const runId = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
      const results = new Array<OrchestratedTaskResult>(tasks.length);
      let completed = 0;
      const reportProgress = () => {
        completed += 1;
        onUpdate?.({
          content: [{ type: "text", text: `Orchestrate: ${completed}/${tasks.length} tasks finished (${writerIndexes.length} writer${writerIndexes.length === 1 ? "" : "s"} serialized).` }],
          details: { mode, configSource: settings.configSource, results: [] }
        });
      };
      const runTask = async (index: number): Promise<void> => {
        const task = tasks[index];
        const id = task.id ?? `task-${index + 1}`;
        const role = task.role ?? "reader";
        try {
          const resolved = resolveTaskModel(context.modelRegistry, settings, {
            role,
            model: task.model,
            thinkingLevel: task.thinkingLevel
          }, context.model);
          if (role === "writer") {
            // Fail before spending writer tokens when no independent-provider
            // reviewer exists for this writer's resolved model.
            selectDistinctReviewer(context.modelRegistry, settings.models.reviewers, resolved.model);
            const outcome = await runWriterTask(context, {
              parentCwd: context.cwd,
              runId,
              taskId: id,
              task: task.task,
              model: resolved.model,
              thinkingLevel: resolved.thinkingLevel,
              tools: writerTools,
              shellTools: settings.shellTools,
              guidance: settings.guidance,
              maxOutputChars: settings.maxOutputCharsPerTask,
              signal
            });
            const review = outcome.worktree.action === "kept"
              ? await reviewWriterBranch(context, {
                  worktreePath: outcome.worktree.path,
                  branch: outcome.worktree.branch,
                  baseCommit: outcome.worktree.baseCommit,
                  task: task.task,
                  writerOutput: outcome.output,
                  writerModel: resolved.model,
                  reviewerSpecs: settings.models.reviewers,
                  tools: settings.readOnlyTools,
                  shellTools: settings.shellTools,
                  guidance: settings.guidance,
                  maxOutputChars: settings.maxOutputCharsPerTask,
                  signal
                })
              : undefined;
            results[index] = { id, role, status: "completed", ...outcome, ...(review ? { review } : {}) };
          } else {
            const result = await spawnOrchestratedAgent(context, {
              cwd: context.cwd,
              task: task.task,
              role,
              model: resolved.model,
              thinkingLevel: resolved.thinkingLevel,
              tools: [...settings.readOnlyTools, ...settings.shellTools],
              guidance: settings.guidance,
              maxOutputChars: settings.maxOutputCharsPerTask,
              signal
            });
            results[index] = { id, role, status: "completed", ...result };
          }
        } catch (error) {
          results[index] = {
            id,
            role,
            status: "failed",
            error: errorMessage(error),
            output: "",
            model: task.model ?? "unresolved",
            thinkingLevel: task.thinkingLevel ?? (role === "reader" ? "medium" : "xhigh"),
            toolCallCount: 0,
            durationMs: 0,
            deniedCalls: []
          };
        }
        reportProgress();
      };

      await mapWithConcurrencyLimit(readIndexes, settings.maxConcurrency, async (index) => runTask(index));
      for (const index of writerIndexes) {
        await runTask(index);
      }

      const text = results.map(formatTaskResult).join("\n\n---\n\n");
      const failed = results.filter((result) => result.status === "failed").length;
      return {
        content: [{ type: "text", text: `Orchestrate: ${results.length - failed}/${results.length} tasks succeeded\n\n${text}` }],
        details: { mode, configSource: settings.configSource, results },
        ...(failed === results.length ? { isError: true } : {})
      };
    }
  }));

  api.registerTool(defineTool({
    name: "reconcile",
    label: "Reconcile",
    description: [
      "Deterministically fold kept orchestrator writer branches (orch/*) into one integration branch:",
      "changed-file overlap report, stable fewest-files-first order, commit-pinned merge-tree probes, per-fold validation with rollback.",
      "Conflicting or failing branches are skipped and reported, never force-merged.",
      "Ends with one human confirmation showing folds, skips, overlaps, and validation status; only on approval does the integration branch merge into the current branch, after which folded writer branches/worktrees are removed.",
      "Declining keeps the integration branch for manual review. Requires writesEnabled=true, dryRun=false, and a clean parent checkout."
    ].join(" "),
    parameters: ReconcileParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, context): Promise<AgentToolResult<ReconcileReport>> {
      const settings = readOrchestratorSettings();
      const report = await runReconcile({
        parentCwd: context.cwd,
        branches: params.branches as string[],
        settings,
        confirm: (title, message) => context.ui.confirm(title, message)
      });
      return {
        content: [{ type: "text", text: formatReconcileReport(report) }],
        details: report,
        ...(report.status === "nothing_merged" && report.folded.length === 0 && report.skipped.length > 0 ? { isError: true } : {})
      };
    }
  }));
}

function formatReconcileReport(report: ReconcileReport): string {
  const header = report.status === "merged"
    ? `Reconcile: merged ${report.folded.length} branch${report.folded.length === 1 ? "" : "es"} into the current branch (merge commit ${report.mergeCommit?.slice(0, 12)}); cleaned ${report.cleanedBranches.join(", ") || "nothing"}.`
    : report.status === "declined"
      ? `Reconcile: user declined the merge gate; integration branch ${report.integrationBranch} kept at ${report.integrationPath} for manual review.`
      : "Reconcile: nothing merged.";
  return `${header}\n\n${buildMergeGateMessage(report.integrationBranch ?? "(no integration branch)", report.folded, report.skipped, report.overlaps, report.validation === "passed-per-fold")}`;
}

async function handleSetup(rawArgs: string, context: ExtensionContext): Promise<void> {
  let args;
  try {
    args = parseOrchestratorSetupArgs(rawArgs);
  } catch (error) {
    context.ui.notify(`${errorMessage(error)}\n${orchestratorSetupUsage()}`, "error");
    return;
  }
  const settings = readOrchestratorSettings();
  if (args.help) {
    context.ui.notify(`${orchestratorSetupUsage()}\n\n${buildOrchestratorStatusText(settings)}`, "info");
    return;
  }

  try {
    const worker = resolveSetupRoute(context, args.worker ?? settings.models.worker, "worker", "xhigh");
    if (!worker) throw new Error("First setup requires --worker provider/model[:thinking].");
    const reader = resolveSetupRoute(context, args.reader ?? settings.models.reader ?? canonicalModelSpec(worker), "reader", "medium")!;
    const planner = resolveSetupRoute(context, args.planner ?? settings.models.planner, "planner", "xhigh");
    const requestedReviewers = args.reviewers.length > 0 ? args.reviewers : settings.models.reviewers;
    if (requestedReviewers.length === 0) throw new Error("First setup requires at least one --reviewer provider/model[:thinking].");
    const reviewers = requestedReviewers.map((spec) => resolveSetupRoute(context, spec, "reviewer", "xhigh")!);
    selectDistinctReviewer(context.modelRegistry, reviewers.map(canonicalModelSpec), worker.model);
    for (const reviewer of reviewers) {
      if (reviewer.model.provider.toLowerCase() === worker.model.provider.toLowerCase()) {
        throw new Error(`Reviewer ${formatModelName(reviewer.model)} must use a different provider from worker provider ${worker.model.provider}.`);
      }
    }
    const guidance = readSetupGuidance(args, context.cwd);
    const models: OrchestratorModelSettings = {
      worker: canonicalModelSpec(worker),
      reader: canonicalModelSpec(reader),
      ...(planner ? { planner: canonicalModelSpec(planner) } : {}),
      reviewers: reviewers.map(canonicalModelSpec)
    };
    const configPath = writeAgentExtensionConfig(
      ORCHESTRATOR_CONFIG_FILE,
      serializeOrchestratorSettings(settings, models, guidance, args.clearGuidance)
    );
    context.ui.notify([
      `Orchestrator setup saved worker ${models.worker}.`,
      `Reader: ${models.reader}`,
      `Planner: ${models.planner ?? "current orchestrator model"}`,
      `Reviewers: ${models.reviewers.join(", ")}`,
      `Config: ${configPath}`,
      "Writes remain disabled and dry-run remains enabled."
    ].join("\n"), "info");
  } catch (error) {
    context.ui.notify(`Orchestrator setup did not write config: ${errorMessage(error)}`, "error");
  }
}

function resolveSetupRoute(
  context: ExtensionContext,
  requested: string | undefined,
  label: string,
  fallbackThinkingLevel: ThinkingLevel
) {
  if (!requested) return undefined;
  return resolveExtensionModel({
    registry: context.modelRegistry,
    requested,
    currentModel: context.model,
    fallbackThinkingLevel,
    label: `Orchestrator ${label}`,
    noModelMessage: `Orchestrator ${label} model is required.`
  });
}

export function buildOrchestratorStatusText(settings: OrchestratorSettings): string {
  return [
    "Orchestrator status",
    `Config: ${settings.configSource}`,
    `Worker: ${settings.models.worker ?? "missing (run /orchestrator:setup)"}`,
    `Reader: ${settings.models.reader ?? settings.models.worker ?? "current session model"}`,
    `Planner: ${settings.models.planner ?? "current session model"}`,
    `Reviewers: ${settings.models.reviewers.join(", ") || "missing (run /orchestrator:setup)"}`,
    `Mode: writes ${settings.writesEnabled ? "enabled" : "disabled"} · dry-run ${settings.dryRun ? "on" : "off"} · writers ${settings.writesEnabled && !settings.dryRun ? "available (confined worktrees, serialized)" : "unavailable until writesEnabled=true and dryRun=false"}`,
    `Caps: ${settings.maxConcurrency} concurrent · ${settings.maxTasksPerRun} tasks/run · ${settings.maxOutputCharsPerTask} chars/task`,
    `Read-only tools: ${settings.readOnlyTools.join(", ")}`,
    `Write tools (writer role only): ${settings.writeTools.join(", ")}`,
    `Shell tools (all roles, tool-safety governed): ${settings.shellTools.join(", ") || "disabled"}`,
    `Validation command: ${settings.validation ? [settings.validation.command, ...settings.validation.args].join(" ") : "not configured"} (reserved for reconcile fold validation)`,
    `Guidance: ${settings.guidance ? "configured" : "built-in only"}`,
    "AGENTS.md dependency: none; explicit extension system prompts enforce invariants."
  ].join("\n");
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  run: (item: TIn, index: number) => Promise<TOut>,
  onSettled?: (completed: number, total: number) => void
): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  let nextIndex = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await run(items[index], index);
      completed += 1;
      onSettled?.(completed, items.length);
    }
  });
  await Promise.all(workers);
  return results;
}

function formatTaskResult(result: OrchestratedTaskResult): string {
  if (result.status === "failed") return `### ${result.id} (${result.role}) failed\n${result.error ?? "Unknown failure"}`;
  const header = `### ${result.id} (${result.role}) · ${result.model}:${result.thinkingLevel} · ${result.toolCallCount} tool calls · ${result.durationMs}ms`;
  return `${header}${formatWorktreeReport(result)}${formatDeniedCalls(result)}\n\n${result.output}${formatReviewReport(result)}`;
}

function formatReviewReport(result: OrchestratedTaskResult): string {
  const review = result.review;
  if (!review) return "";
  if (review.status === "failed") {
    return `\n\n#### Independent review failed${review.model ? ` (${review.model})` : ""}\n${review.error ?? "Unknown review failure"}`;
  }
  const verdict = review.status === "approve" ? "APPROVE" : review.status === "request_changes" ? "REQUEST_CHANGES" : "NO PARSEABLE VERDICT";
  const denied = review.deniedCalls && review.deniedCalls.length > 0
    ? `\nReview denied calls (${review.deniedCalls.length}): ${review.deniedCalls.join("; ")}`
    : "";
  return `\n\n#### Independent review: ${verdict} · ${review.model}:${review.thinkingLevel} · ${review.durationMs}ms${denied}\n\n${review.output ?? ""}`;
}

function formatDeniedCalls(result: OrchestratedTaskResult): string {
  if (result.deniedCalls.length === 0) return "";
  return `\nDenied calls (${result.deniedCalls.length}, harness-recorded):\n${result.deniedCalls.map((reason) => `- ${reason}`).join("\n")}`;
}

function formatWorktreeReport(result: OrchestratedTaskResult): string {
  if (!result.worktree) return "";
  if (result.worktree.action === "removed") return `\nWorktree: no writes · removed ${result.worktree.branch}`;
  const commit = result.commit ? ` · commit ${result.commit.slice(0, 12)}` : "";
  const files = result.changedFiles && result.changedFiles.length > 0 ? ` · files: ${result.changedFiles.join(", ")}` : "";
  return `\nWorktree: kept ${result.worktree.branch} at ${result.worktree.path}${commit}${files}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
