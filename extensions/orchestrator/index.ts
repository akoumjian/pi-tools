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
  resolveTaskModelCandidates,
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
import {
  allowsReadOnlyProviderFallback,
  classifyProviderFailure,
  spawnOrchestratedAgent,
  type ProviderFailureKind,
  type SpawnOrchestratedAgentResult
} from "./spawn.js";
import { createSerialTaskGate, runWriterTask, type WriterWorktreeReport } from "./writer.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const TaskParams = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1, description: "Stable task id used in result labels." })),
  task: Type.String({ minLength: 1, description: "Focused task delegated to an isolated child session." }),
  role: Type.Optional(Type.Union([Type.Literal("reader"), Type.Literal("planner"), Type.Literal("writer")], {
    default: "reader",
    description: "Reader gathers evidence; planner returns a dependency/validation-aware plan; writer edits inside a confined managed worktree."
  })),
  model: Type.Optional(Type.String({ minLength: 1, description: "Optional primary provider/model override chosen by the orchestrator." })),
  fallbackModels: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    maxItems: 4,
    description: "Explicit ordered fallback provider/model routes. Read-only roles use them only after preflight unavailability or provider auth/rate-limit/transient failure; writers may switch only before their worktree session starts."
  })),
  thinkingLevel: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)), {
    description: "Optional thinking override for this task."
  }))
}, { additionalProperties: false });

const OrchestrateParams = Type.Object({
  tasks: Type.Array(TaskParams, { minItems: 1, maxItems: 8, description: "Independent tasks to execute; reads and writers use separate bounded concurrency, while writer git setup and reconciliation remain serialized." })
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
  fallbackModels?: string[];
  thinkingLevel?: ThinkingLevel;
};

type RouteAttempt = {
  model: string;
  status: "rejected" | "failed" | "completed";
  failureKind?: ProviderFailureKind | "reviewer_unavailable";
  error?: string;
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
  routeAttempts: RouteAttempt[];
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
    description: "Show orchestrator model routes, concurrency/fallback policy, safety mode, tools, and config source",
    handler: async (_args, context) => context.ui.notify(buildOrchestratorStatusText(readOrchestratorSettings()), "info")
  });

  api.registerTool(defineTool({
    name: "orchestrate",
    label: "Orchestrate",
    description: [
      "Run focused reader/planner/writer subagents in isolated in-process sessions.",
      "The orchestrating agent may choose a primary provider/model, explicit ordered fallbackModels, and thinkingLevel per task; configured role defaults apply otherwise.",
      "Readers/planners are read-only by instruction and run with bounded parallelism; all children may use async-shell commands governed by the tool-safety policy, with escalations denied fail-closed.",
      "Writers use separately bounded, provider-aware concurrency and edit only inside per-task managed git worktrees; git setup and reconciliation stay serialized, and no writer runtime-fallback occurs after a worktree session starts.",
      "Every kept writer branch is independently reviewed by the configured different-provider pool, advancing to another explicit reviewer after failure or an unparseable verdict; no merge or integration happens automatically."
    ].join(" "),
    promptSnippet: "Delegate independent reader, planner, or isolated writer tasks through tasks:[...], with explicit fallbackModels when needed; returns route attempts, output/errors, worktree/commit, and independent review attempts.",
    promptGuidelines: [
      "orchestrate use: Use orchestrate for substantive work that decomposes into focused independent reader/planner tasks or isolated writer tasks; keep trivial or tightly sequential work in the parent session.",
      "orchestrate input: Pass { tasks: [{ id?, task, role?, model?, fallbackModels?, thinkingLevel? }] }. State a narrow deliverable per task, batch independent tasks in one call, use reader for evidence, planner for implementation plans, and writer only for confined code changes. Fallbacks must be explicit and ordered.",
      "orchestrate output: Each model-visible result identifies task id/role/status, every rejected/failed/completed model route, resolved model/thinking, duration/tool calls, output or actionable error, and for writers the worktree branch/commit/changed files plus every independent review attempt and verdict; no branch is merged automatically.",
      "orchestrate constraints: Before delegation, the parent reads canonical grounding and passes the relevant evidence; afterward it synthesizes results and updates external decisions/journal itself. Children are read-only or worktree-confined and must not be tasked with external grounding writes. Automatic fallback is limited to explicit fallbackModels and provider availability failures for read-only roles; writer runtime failures retain/remove their worktree safely and fail closed. Use /orchestrator:status for configured caps/routes and reconcile only for kept orch/* writer branches after review."
    ],
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
      const writerTools = [...settings.readOnlyTools, ...settings.writeTools];
      validateChildToolAllowlist(
        api.getAllTools(),
        [...(writerIndexes.length > 0 ? writerTools : settings.readOnlyTools), ...settings.shellTools],
        "Orchestrator",
        settings.configSource
      );

      const runId = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
      const results = new Array<OrchestratedTaskResult>(tasks.length);
      const writerSetupGate = createSerialTaskGate();
      const writerRoutes = new Map<number, {
        resolved?: ReturnType<typeof resolveTaskModelCandidates>["candidates"][number];
        attempts: RouteAttempt[];
        error?: string;
      }>();
      const getWriterRoute = (index: number) => {
        const cached = writerRoutes.get(index);
        if (cached) return cached;
        const task = tasks[index];
        const attempts: RouteAttempt[] = [];
        let route;
        try {
          const plan = resolveTaskModelCandidates(context.modelRegistry, settings, {
            role: "writer",
            model: task.model,
            fallbackModels: task.fallbackModels,
            thinkingLevel: task.thinkingLevel
          }, context.model);
          attempts.push(...plan.rejected.map((failure) => ({ model: failure.requested, status: "rejected" as const, error: failure.error })));
          for (const candidate of plan.candidates) {
            try {
              selectDistinctReviewer(context.modelRegistry, settings.models.reviewers, candidate.model);
              route = { resolved: candidate, attempts };
              break;
            } catch (error) {
              attempts.push({
                model: canonicalModelSpec(candidate),
                status: "rejected",
                failureKind: "reviewer_unavailable",
                error: errorMessage(error)
              });
            }
          }
          route ??= { attempts, error: `No usable writer route has an independent reviewer. ${attempts.map((attempt) => `${attempt.model}: ${attempt.error}`).join("; ")}` };
        } catch (error) {
          route = { attempts, error: errorMessage(error) };
        }
        writerRoutes.set(index, route);
        return route;
      };

      let completed = 0;
      const reportProgress = () => {
        completed += 1;
        onUpdate?.({
          content: [{
            type: "text",
            text: `Orchestrate: ${completed}/${tasks.length} tasks finished (${writerIndexes.length} writer${writerIndexes.length === 1 ? "" : "s"}; max ${settings.maxWriterConcurrency} concurrent, ${settings.maxWriterConcurrencyPerProvider}/provider; git setup serialized).`
          }],
          details: { mode, configSource: settings.configSource, results: results.filter(Boolean) }
        });
      };
      const runTask = async (index: number): Promise<void> => {
        const task = tasks[index];
        const id = task.id ?? `task-${index + 1}`;
        const role = task.role ?? "reader";
        const routeAttempts: RouteAttempt[] = [];
        let activeModel = task.model ?? "unresolved";
        try {
          if (role === "writer") {
            const route = getWriterRoute(index);
            routeAttempts.push(...route.attempts);
            if (!route.resolved) throw new Error(route.error ?? "No usable writer model route is available.");
            const resolved = route.resolved;
            activeModel = canonicalModelSpec(resolved);
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
              setupGate: writerSetupGate,
              signal
            });
            routeAttempts.push({ model: activeModel, status: "completed" });
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
            results[index] = { id, role, status: "completed", routeAttempts, ...outcome, ...(review ? { review } : {}) };
          } else {
            const plan = resolveTaskModelCandidates(context.modelRegistry, settings, {
              role,
              model: task.model,
              fallbackModels: task.fallbackModels,
              thinkingLevel: task.thinkingLevel
            }, context.model);
            routeAttempts.push(...plan.rejected.map((failure) => ({ model: failure.requested, status: "rejected" as const, error: failure.error })));
            for (let routeIndex = 0; routeIndex < plan.candidates.length; routeIndex += 1) {
              const resolved = plan.candidates[routeIndex];
              activeModel = canonicalModelSpec(resolved);
              try {
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
                routeAttempts.push({ model: activeModel, status: "completed" });
                results[index] = { id, role, status: "completed", routeAttempts, ...result };
                break;
              } catch (error) {
                const failureKind = classifyProviderFailure(error);
                routeAttempts.push({ model: activeModel, status: "failed", failureKind, error: errorMessage(error) });
                const hasFallback = routeIndex + 1 < plan.candidates.length;
                if (hasFallback && allowsReadOnlyProviderFallback(error)) continue;
                const policy = hasFallback
                  ? ` Explicit fallback was not attempted because the failure was classified ${failureKind}, not provider availability.`
                  : " No additional usable explicit fallback route remained.";
                throw new Error(`${errorMessage(error)}${policy}`);
              }
            }
            if (!results[index]) throw new Error("All usable explicit read-only model routes failed.");
          }
        } catch (error) {
          if (role === "writer" && activeModel !== "unresolved" && !routeAttempts.some((attempt) => attempt.model === activeModel && attempt.status === "failed")) {
            routeAttempts.push({ model: activeModel, status: "failed", failureKind: classifyProviderFailure(error), error: errorMessage(error) });
          }
          results[index] = {
            id,
            role,
            status: "failed",
            error: errorMessage(error),
            output: "",
            model: activeModel,
            thinkingLevel: task.thinkingLevel ?? (role === "reader" ? "medium" : "xhigh"),
            toolCallCount: 0,
            durationMs: 0,
            deniedCalls: [],
            routeAttempts
          };
        } finally {
          reportProgress();
        }
      };

      await mapWithConcurrencyLimit(readIndexes, settings.maxConcurrency, async (index) => runTask(index));
      await mapWithKeyConcurrencyLimit(
        writerIndexes,
        settings.maxWriterConcurrency,
        settings.maxWriterConcurrencyPerProvider,
        (index) => getWriterRoute(index).resolved?.model.provider.toLowerCase() ?? `unresolved-${index}`,
        async (index) => runTask(index)
      );

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
      "Declining keeps the integration branch for manual review. Requires a clean parent checkout."
    ].join(" "),
    promptSnippet: "Safely fold reviewed kept orch/* writer branches into a validated integration branch, then ask once before merging it into the clean parent checkout.",
    promptGuidelines: [
      "reconcile use: Use reconcile only after orchestrate returns kept reviewed writer branches that should be combined; pass all intended branches together for deterministic overlap and validation handling.",
      "reconcile input: Pass { branches: [\"orch/...\"] } with 1-8 existing kept orchestrator branches. The parent checkout must be clean and every branch must remain commit-pinned.",
      "reconcile output: The model-visible report identifies integration status/path/branch, folded and skipped branches with reasons, changed-file overlaps, validation results, optional merge commit, and cleanup; declining keeps the integration branch for manual review.",
      "reconcile constraints: Never force-merge conflicts or validation failures. Reconciliation and the final human gate remain serial; only approved validated integration is merged into the parent, after which folded branches/worktrees are removed."
    ],
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
      `Config: ${configPath}`
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
    "Mode: writers run in confined worktrees with bounded provider-aware concurrency; git setup and reconcile remain serial, and merges happen only through the reconcile confirmation gate.",
    `Caps: ${settings.maxConcurrency} concurrent readers/planners · ${settings.maxWriterConcurrency} concurrent writers · ${settings.maxWriterConcurrencyPerProvider} writer/provider · ${settings.maxTasksPerRun} tasks/run · ${settings.maxOutputCharsPerTask} chars/task`,
    "Fallback: only explicit per-task fallbackModels; read-only tasks advance on auth/rate-limit/transient provider failures, writers may change route only before a worktree session starts, and reviewer pools advance after failure/unparseable verdict.",
    `Read-only tools: ${settings.readOnlyTools.join(", ")}`,
    `Write tools (writer role only): ${settings.writeTools.join(", ")}`,
    `Shell tools (all roles, tool-safety governed): ${settings.shellTools.join(", ") || "disabled"}`,
    `Validation command: ${settings.validation ? [settings.validation.command, ...settings.validation.args].join(" ") : "not configured"} (reserved for reconcile fold validation)`,
    `Guidance: ${settings.guidance ? "configured" : "built-in only"}`,
    "AGENTS.md dependency: none; explicit extension system prompts enforce invariants."
  ].join("\n");
}

export async function mapWithKeyConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  perKeyConcurrency: number,
  keyOf: (item: TIn, index: number) => string,
  run: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const globalLimit = Math.max(1, concurrency);
  const keyLimit = Math.max(1, perKeyConcurrency);
  const results = new Array<TOut>(items.length);
  const pending = items.map((_item, index) => index);
  const activeByKey = new Map<string, number>();
  let active = 0;
  let completed = 0;

  return new Promise<TOut[]>((resolve, reject) => {
    let rejected = false;
    const launch = () => {
      if (rejected) return;
      while (active < globalLimit && pending.length > 0) {
        const pendingPosition = pending.findIndex((index) => (activeByKey.get(keyOf(items[index], index)) ?? 0) < keyLimit);
        if (pendingPosition === -1) break;
        const [index] = pending.splice(pendingPosition, 1);
        const key = keyOf(items[index], index);
        active += 1;
        activeByKey.set(key, (activeByKey.get(key) ?? 0) + 1);
        void run(items[index], index).then((value) => {
          results[index] = value;
        }, (error) => {
          rejected = true;
          reject(error);
        }).finally(() => {
          active -= 1;
          completed += 1;
          const remaining = (activeByKey.get(key) ?? 1) - 1;
          if (remaining > 0) activeByKey.set(key, remaining);
          else activeByKey.delete(key);
          if (!rejected && completed === items.length) resolve(results);
          else launch();
        });
      }
    };
    launch();
  });
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
  const routes = formatRouteAttempts(result.routeAttempts);
  if (result.status === "failed") return `### ${result.id} (${result.role}) failed${routes}\n${result.error ?? "Unknown failure"}`;
  const header = `### ${result.id} (${result.role}) · ${result.model}:${result.thinkingLevel} · ${result.toolCallCount} tool calls · ${result.durationMs}ms`;
  return `${header}${routes}${formatWorktreeReport(result)}${formatDeniedCalls(result)}\n\n${result.output}${formatReviewReport(result)}`;
}

function formatReviewReport(result: OrchestratedTaskResult): string {
  const review = result.review;
  if (!review) return "";
  const attempts = review.attempts.length > 0
    ? `\nReview routes:\n${review.attempts.map((attempt) => `- ${attempt.model}: ${attempt.status}${attempt.error ? ` — ${attempt.error}` : ""}`).join("\n")}`
    : "";
  if (review.status === "failed") {
    return `\n\n#### Independent review failed${review.model ? ` (${review.model})` : ""}${attempts}\n${review.error ?? "Unknown review failure"}`;
  }
  const verdict = review.status === "approve" ? "APPROVE" : review.status === "request_changes" ? "REQUEST_CHANGES" : "NO PARSEABLE VERDICT";
  const denied = review.deniedCalls && review.deniedCalls.length > 0
    ? `\nReview denied calls (${review.deniedCalls.length}): ${review.deniedCalls.join("; ")}`
    : "";
  return `\n\n#### Independent review: ${verdict} · ${review.model}:${review.thinkingLevel} · ${review.durationMs}ms${attempts}${denied}\n\n${review.output ?? ""}${review.error ? `\n\n${review.error}` : ""}`;
}

function formatRouteAttempts(attempts: RouteAttempt[]): string {
  if (attempts.length === 0) return "";
  return `\nModel routes:\n${attempts.map((attempt) => `- ${attempt.model}: ${attempt.status}${attempt.failureKind ? ` (${attempt.failureKind})` : ""}${attempt.error ? ` — ${attempt.error}` : ""}`).join("\n")}`;
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
