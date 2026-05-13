import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Message, Model, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  getMarkdownTheme,
  SessionManager,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionError,
  type ExtensionFactory,
  type LoadExtensionsResult
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
  formatModelName,
  normalizeThinkingLevel,
  resolveExtensionModel,
  type ExtensionModelRegistry,
  type ResolvedExtensionModel
} from "../_shared/model-spec.js";
import { formatConfigPath, readPiToolsJsonConfigSource, readPiToolsReferencedTextConfig, writeAgentExtensionConfig, type PiToolsJsonConfig } from "../_shared/config.js";
import { registerCommandWithAliases } from "../_shared/deprecated-command.js";
import { guidedModelSetupUsage, parseGuidedModelSetupArgs, readSetupGuidance } from "../_shared/setup-command.js";

const REVIEW_MESSAGE_TYPE = "review-subagent";
const REVIEW_STATUS_KEY = "review-subagent";
const REVIEW_EXTENSION_PATH_PATTERN = /(?:^|[/\\])extensions[/\\]review-subagent[/\\]index\.(?:ts|js)$/;
const REVIEW_CONFIG_FILE = "review-subagent-settings.json";

const DEFAULT_REVIEW_TOOLS = [
  "search_many",
  "read_many",
  "searxng_search",
  "web_fetch_many",
  "document_parse",
  "shell_start",
  "shell_status",
  "shell_tail",
  "shell_cancel"
];

const reviewerSystemPrompt = `You are a skeptical Pi review subagent.

Your job is to review the recent work from the parent Pi session. You are not the implementer. You are an independent reviewer with your own tool access and fresh context.

Rules:
- Verify claims with tools when possible. Do not rely only on the parent handoff.
- Do not modify files. Do not call write/edit tools even if available.
- Prefer search_many and read_many for repository code inspection. Use searxng_search for web discovery, web_fetch_many for public source retrieval, and document_parse for downloaded/local documents when external docs or artifacts materially help the review.
- Use shell_start only for read-only inspection or validation commands such as tests, type checks, linters, git status/diff/log/show, rg, grep, find, ls, cat, head, tail, sed, wc, sort, or package-manager test commands that do not install or mutate dependencies.
- When using shell_start for validation, keep commands bounded and expected to finish within shell_start's fixed short wait. Use command objects that include cwd and notifyOnExit:false, and do not leave long-running background jobs from the review subagent.
- Do not install dependencies, deploy, push, commit, rewrite git history, access credentials, browse private data unrelated to the task, or contact production/shared infrastructure.
- If tool-safety blocks a command or human approval is unavailable, continue with safer alternatives and explicitly note the validation gap.
- Focus on correctness, missed requirements, edge cases, tests, safety, maintainability, and unnecessary complexity.
- Be concrete. Cite files, line ranges, commands, or transcript details whenever possible.
- Avoid nitpicks unless they materially affect quality.

Final answer format:
## Review Summary
One short paragraph with the overall verdict.

## Findings
List findings in priority order. Use severity labels: Critical, High, Medium, Low. For each finding include evidence and a concrete recommendation. If there are no findings, say so clearly.

## Validation Performed
List the tool-based checks you ran and the result.

## Open Questions / Gaps
List anything important you could not verify.

## Suggested Next Steps
Brief actionable next steps for the parent agent.`;

type ReviewSettings = {
  defaultModel?: string;
  guidance?: string;
  guidanceFile?: string;
  thinkingLevel: ThinkingLevel;
  maxRecentMessages: number;
  maxTranscriptChars: number;
  maxDiffChars: number;
  maxOutputTokens: number;
  commandTimeoutMs: number;
  tools: string[];
  configSource: string;
};

export type ReviewCommandArgs = {
  model?: string;
  focus?: string;
  send: boolean;
  noSend: boolean;
  help: boolean;
};

type GitContext = {
  isRepository: boolean;
  root?: string;
  status: string;
  diffStat: string;
  unstagedDiff: string;
  stagedDiff: string;
  untrackedFiles: string;
  errors: string[];
};

type ReviewEventRecord = {
  type: "tool_start" | "tool_end" | "assistant" | "error";
  timestamp: number;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  text?: string;
};

export type ReviewDetails = {
  status: "completed" | "failed" | "cancelled";
  cwd: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  focus?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  critique: string;
  sentBack: boolean;
  events: ReviewEventRecord[];
  toolCallCount: number;
  error?: string;
};

type ReviewRunResult = {
  details: ReviewDetails;
  finalMessages: AgentMessage[];
};

type ExecCapableApi = Pick<ExtensionAPI, "exec">;

export type ReviewPhase = "idle" | "running" | "awaiting-display" | "awaiting-confirm";

export type ReviewActiveRun = {
  id: number;
  cwd: string;
  focus?: string;
  startedAt: string;
  cancelRequested: boolean;
  cancelPromise: Promise<void>;
  resolveCancel: () => void;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  toolCallCount: number;
  abortChild?: () => Promise<void>;
};

export type ReviewState = {
  phase: ReviewPhase;
  activeRun?: ReviewActiveRun;
  lastReview?: ReviewDetails;
};

const reviewStates = new Map<string, ReviewState>();

export default function reviewSubagentExtension(api: ExtensionAPI): void {
  api.registerMessageRenderer<ReviewDetails>(REVIEW_MESSAGE_TYPE, (message, options, theme) => {
    return renderReviewMessage(message.details, options.expanded, theme);
  });

  registerCommandWithAliases(
    api,
    "review",
    {
      description: "Run a tool-using review subagent on recent work (usage: /review [--model provider/model] [--send|--no-send] [focus])",
      handler: async (args, context) => {
        await handleReviewWork(api, context, args);
      }
    },
    []
  );

  registerCommandWithAliases(
    api,
    "review:setup",
    {
      description: "Persist the review-subagent reviewer model for this machine (usage: /review:setup provider/model[:thinking])",
      handler: async (args, context) => {
        handleReviewSetupCommand(args, context);
      }
    },
    []
  );

  registerCommandWithAliases(
    api,
    "review:status",
    {
      description: "Show current review-subagent status",
      handler: async (_args, context) => {
        context.ui.notify(buildReviewStatusText(getReviewState(context), readReviewSettings()), "info");
      }
    },
    []
  );

  registerCommandWithAliases(
    api,
    "review:cancel",
    {
      description: "Cancel the active review-subagent run or pending send confirmation",
      handler: async (args, context) => {
        if (args.trim()) {
          context.ui.notify("Usage: /review:cancel", "error");
          return;
        }
        await cancelReviewState(getReviewState(context), context);
      }
    },
    []
  );

  registerCommandWithAliases(
    api,
    "review:send-last",
    {
      description: "Send the latest completed review-subagent critique back to the main agent",
      handler: async (_args, context) => {
        const state = getReviewState(context);
        if (!state.lastReview || state.lastReview.status !== "completed" || !state.lastReview.critique.trim()) {
          context.ui.notify("No completed review-subagent critique is available to send.", "warning");
          return;
        }
        api.sendUserMessage(buildSendBackMessage(state.lastReview));
        state.lastReview.sentBack = true;
      }
    },
    []
  );

  api.on("session_shutdown", async (_event, context) => {
    const key = getReviewStateKey(context);
    const state = reviewStates.get(key);
    if (state) {
      if (state.phase !== "idle") {
        await cancelReviewState(state, context, "Review subagent cancelled because the session is shutting down.");
      }
      reviewStates.delete(key);
    }
  });
}

async function handleReviewWork(api: ExtensionAPI, context: ExtensionCommandContext, rawArgs: string): Promise<void> {
  const state = getReviewState(context);
  if (state.phase !== "idle") {
    context.ui.notify(`A review subagent is already ${formatReviewPhase(state.phase)} for this session. Use /review:status or /review:cancel.`, "warning");
    return;
  }

  let commandArgs: ReviewCommandArgs;
  try {
    commandArgs = parseReviewCommandArgs(rawArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.ui.notify(`${message}\n\n${reviewCommandHelp()}`, "error");
    return;
  }

  if (commandArgs.help) {
    context.ui.notify(reviewCommandHelp(), "info");
    return;
  }

  let settings: ReviewSettings;
  try {
    settings = readReviewSettings();
    validateReviewToolAllowlist(api, settings.tools, settings.configSource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.ui.notify(message, "error");
    return;
  }

  if (!settings.defaultModel) {
    context.ui.notify("Review subagent is not configured. Run /review:setup provider/model[:thinking] before using /review.", "warning");
    return;
  }

  const activeRun = createReviewActiveRun(context.cwd, commandArgs.focus);
  state.phase = "running";
  state.activeRun = activeRun;
  setReviewStatus(context, "review starting");
  notifyReviewStarted(context);

  const cwd = context.cwd;
  const task = runReviewWorkInBackground(api, context, state, activeRun, commandArgs, cwd, settings);
  await settleReviewWorkLaunch(task, context);
}

async function runReviewWorkInBackground(
  api: ExtensionAPI,
  context: ExtensionCommandContext,
  state: ReviewState,
  activeRun: ReviewActiveRun,
  commandArgs: ReviewCommandArgs,
  cwd: string,
  settings: ReviewSettings
): Promise<void> {
  let details: ReviewDetails;

  try {
    const parentContext = buildParentContext(context, settings);
    const gitContext = await collectGitContext(api, cwd, settings);
    const result = await runReviewSubagent(context, activeRun, commandArgs, settings, parentContext, gitContext);
    details = activeRun.cancelRequested
      ? buildCancelledReviewDetails(cwd, commandArgs.focus, "Review subagent cancelled before publishing the critique.", result.details)
      : result.details;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    details = activeRun.cancelRequested
      ? buildCancelledReviewDetails(cwd, commandArgs.focus, "Review subagent cancelled by user.")
      : buildFailedReviewDetails(cwd, commandArgs.focus, message);
  }

  state.lastReview = details;

  try {
    if (details.status === "cancelled") {
      notifyReview(context, details.error ?? "Review subagent cancelled. No critique was displayed or sent back.", "info");
      return;
    }
    await publishReviewDetails(api, context, state, activeRun, commandArgs, details);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notifyReview(context, `Review subagent finished, but the report could not be displayed: ${message}`, "error");
  } finally {
    if (state.activeRun?.id === activeRun.id) {
      state.phase = "idle";
      state.activeRun = undefined;
    }
    setReviewStatus(context, undefined);
  }
}

export async function publishReviewDetails(
  api: ExtensionAPI,
  context: ExtensionCommandContext,
  state: ReviewState,
  activeRun: ReviewActiveRun,
  commandArgs: ReviewCommandArgs,
  details: ReviewDetails
): Promise<void> {
  if (activeRun.cancelRequested) {
    markReviewCancelled(state, "Review subagent cancelled before display.", details);
    return;
  }

  state.phase = "awaiting-display";
  await waitForReviewReportDisplayIdle(context, activeRun);
  if (activeRun.cancelRequested) {
    markReviewCancelled(state, "Review subagent cancelled before display.", details);
    notifyReview(context, "Review subagent cancelled before the critique was displayed.", "info");
    return;
  }

  api.sendMessage(
    {
      customType: REVIEW_MESSAGE_TYPE,
      content: buildReviewMessageContent(details),
      display: true,
      details
    },
    { deliverAs: "followUp" }
  );

  if (details.status === "failed") {
    notifyReview(context, "Review subagent failed. See transcript message for details.", "error");
    return;
  }

  if (!commandArgs.send && !commandArgs.noSend && context.hasUI) {
    state.phase = "awaiting-confirm";
    setReviewStatus(context, "review awaiting send approval");
  }

  const shouldSend = await shouldSendReviewBack(context, commandArgs, details);
  if (activeRun.cancelRequested) {
    markReviewCancelled(state, "Review subagent send-back cancelled by user.", details);
    notifyReview(context, "Review subagent send-back cancelled. The critique was not sent to the main agent.", "info");
    return;
  }
  if (!shouldSend) {
    return;
  }

  details.sentBack = true;
  api.sendUserMessage(buildSendBackMessage(details), { deliverAs: "followUp" });
}

export async function settleReviewWorkLaunch(task: Promise<void>, context: Pick<ExtensionContext, "hasUI">): Promise<void> {
  if (context.hasUI) {
    void task;
    return;
  }

  await task;
}

export async function waitForReviewReportDisplayIdle(context: Pick<ExtensionCommandContext, "isIdle" | "waitForIdle" | "ui">, activeRun?: Pick<ReviewActiveRun, "cancelPromise" | "cancelRequested">): Promise<boolean> {
  if (context.isIdle()) {
    return false;
  }

  setReviewStatus(context, "review ready · waiting for main agent idle");
  if (!activeRun) {
    await context.waitForIdle();
    return true;
  }

  const idle = context.waitForIdle()
    .then(() => "idle" as const)
    .catch((error: unknown) => {
      if (activeRun.cancelRequested) {
        return "cancelled" as const;
      }
      throw error;
    });
  const cancelled = activeRun.cancelPromise.then(() => "cancelled" as const);
  return await Promise.race([idle, cancelled]) === "idle";
}

function notifyReviewStarted(context: Pick<ExtensionContext, "hasUI" | "ui">): void {
  notifyReview(
    context,
    "Review subagent started in the background. You can keep chatting; the report will appear when the main agent is idle.",
    "info"
  );
}

function setReviewStatus(context: Pick<ExtensionContext, "ui">, text: string | undefined): void {
  try {
    context.ui.setStatus(REVIEW_STATUS_KEY, text);
  } catch {
    // The parent session may have been replaced while a background review was finishing.
  }
}

function notifyReview(context: Pick<ExtensionContext, "hasUI" | "ui">, message: string, type: "info" | "warning" | "error"): void {
  try {
    if (context.hasUI) {
      context.ui.notify(message, type);
    }
  } catch {
    // The parent session may have been replaced while a background review was finishing.
  }
}

async function runReviewSubagent(
  context: ExtensionCommandContext,
  activeRun: ReviewActiveRun,
  commandArgs: ReviewCommandArgs,
  settings: ReviewSettings,
  parentContext: string,
  gitContext: GitContext
): Promise<ReviewRunResult> {
  const startedAt = new Date();
  const events: ReviewEventRecord[] = [];
  let toolCallCount = 0;

  const services = await createAgentSessionServices({
    cwd: context.cwd,
    agentDir: getAgentDir(),
    modelRegistry: context.modelRegistry,
    resourceLoaderOptions: {
      appendSystemPromptOverride: (base) => [...base, reviewerSystemPrompt],
      extensionFactories: [createReviewToolAllowlistExtension(settings.tools)],
      extensionsOverride: omitReviewSubagentExtension
    }
  });

  reportServiceDiagnostics(context, services.diagnostics);

  const { model, thinkingLevel } = selectReviewModel(services.modelRegistry, commandArgs.model ?? settings.defaultModel, context.model, settings.thinkingLevel);
  activeRun.model = formatModelName(model);
  activeRun.thinkingLevel = thinkingLevel;

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(context.cwd),
    model,
    thinkingLevel,
    tools: settings.tools
  });
  activeRun.abortChild = async () => {
    await session.abort();
  };

  const unsubscribe = session.subscribe((event) => {
    recordReviewEvent(events, event);
    if (activeRun.cancelRequested) {
      return;
    }
    if (event.type === "tool_execution_start") {
      toolCallCount += 1;
      activeRun.toolCallCount = toolCallCount;
      context.ui.setStatus(REVIEW_STATUS_KEY, `review running · ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"} · ${event.toolName}`);
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      context.ui.setStatus(REVIEW_STATUS_KEY, `review writing · ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}`);
    }
  });

  await session.bindExtensions({
    uiContext: context.ui,
    shutdownHandler: () => {
      void session.abort();
    },
    onError: (error) => {
      events.push({
        type: "error",
        timestamp: Date.now(),
        text: formatExtensionError(error)
      });
      context.ui.notify(`Review subagent extension error: ${error.error}`, "warning");
    }
  });

  try {
    if (activeRun.cancelRequested) {
      throw new Error("Review cancelled before reviewer prompt started.");
    }

    context.ui.setStatus(REVIEW_STATUS_KEY, `review running · ${formatModelName(model)}`);
    await session.prompt(buildReviewTask(parentContext, gitContext, commandArgs.focus, settings), { source: "extension" });
    if (activeRun.cancelRequested) {
      throw new Error("Review cancelled while reviewer was running.");
    }
    const finalMessages = session.messages;
    const critique = getFinalAssistantText(finalMessages).trim();
    const finalAssistant = getFinalAssistant(finalMessages);
    const completedAt = new Date();
    const isError = finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted";
    if (isError) {
      throw new Error(finalAssistant?.errorMessage ?? `Reviewer stopped with ${finalAssistant?.stopReason}`);
    }
    if (!critique) {
      throw new Error("Reviewer finished without a text critique.");
    }

    return {
      finalMessages,
      details: {
        status: "completed",
        cwd: context.cwd,
        model: formatModelName(model),
        thinkingLevel,
        focus: commandArgs.focus,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        critique,
        sentBack: false,
        events,
        toolCallCount
      }
    };
  } finally {
    activeRun.abortChild = undefined;
    unsubscribe();
    session.dispose();
  }
}

export function getReviewStateKey(context: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
  return `${context.cwd}\0${context.sessionManager.getSessionId()}`;
}

export function getReviewState(context: ExtensionContext): ReviewState {
  const key = getReviewStateKey(context);
  const existing = reviewStates.get(key);
  if (existing) {
    return existing;
  }

  const state: ReviewState = createReviewState();
  reviewStates.set(key, state);
  return state;
}

export function clearReviewState(context: Pick<ExtensionContext, "cwd" | "sessionManager">): void {
  reviewStates.delete(getReviewStateKey(context));
}

export function createReviewState(): ReviewState {
  return { phase: "idle" };
}

export function createReviewActiveRun(cwd: string, focus: string | undefined, id = Date.now()): ReviewActiveRun {
  let resolveCancel!: () => void;
  const cancelPromise = new Promise<void>((resolve) => {
    resolveCancel = resolve;
  });
  return {
    id,
    cwd,
    focus,
    startedAt: new Date().toISOString(),
    cancelRequested: false,
    cancelPromise,
    resolveCancel,
    toolCallCount: 0
  };
}

function handleReviewSetupCommand(rawArgs: string, context: ExtensionContext): void {
  let args: ReturnType<typeof parseGuidedModelSetupArgs>;
  try {
    args = parseGuidedModelSetupArgs(rawArgs, "/review:setup");
  } catch (error) {
    context.ui.notify(`${errorMessage(error)}\n${reviewSetupUsage()}`, "error");
    return;
  }

  if (args.help || !args.modelSpec) {
    context.ui.notify(`${reviewSetupUsage()}\n\n${buildReviewStatusText(getReviewState(context), readReviewSettings())}`, "info");
    return;
  }

  const settings = readReviewSettings();
  try {
    const guidance = readSetupGuidance(args, context.cwd);
    const clearGuidance = args.clearGuidance === true;
    const { model, thinkingLevel } = selectReviewModel(context.modelRegistry, args.modelSpec, context.model, settings.thinkingLevel);
    const configPath = writeAgentExtensionConfig(REVIEW_CONFIG_FILE, serializeReviewSettings(settings, formatModelName(model), thinkingLevel, guidance, clearGuidance));
    context.ui.notify([
      `Review-subagent setup saved ${formatModelName(model)} with ${thinkingLevel} thinking.`,
      `Config: ${configPath}`,
      ...(clearGuidance ? ["Reviewer guidance: cleared"] : guidance === undefined ? [] : ["Reviewer guidance: saved"])
    ].join("\n"), "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.ui.notify(`Review-subagent setup did not write config: ${message}`, "error");
  }
}

function reviewSetupUsage(): string {
  return guidedModelSetupUsage("/review:setup");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildReviewStatusText(state: ReviewState, settings: ReviewSettings = readReviewSettings()): string {
  const activeRun = state.activeRun;
  const active = activeRun?.cancelRequested ? "Review cancellation requested" : `Review phase: ${formatReviewPhase(state.phase)}`;
  const toolStatus = `Reviewer tools: ${settings.tools.join(", ")} (${settings.configSource})`;
  const setupStatus = settings.defaultModel ? `Configured model: ${settings.defaultModel} · thinking ${settings.thinkingLevel}` : "Configuration: missing default model; run /review:setup provider/model[:thinking]";
  const guidanceStatus = `Reviewer guidance: ${settings.guidance ? "configured" : "none"}`;
  if (activeRun && state.phase !== "idle") {
    const activeStatus = [
      `Active review: ${formatReviewPhase(state.phase)}`,
      `model ${activeRun.model ?? "pending"}`,
      `thinking ${activeRun.thinkingLevel ?? "pending"}`,
      `started ${activeRun.startedAt}`,
      `${activeRun.toolCallCount} tool call${activeRun.toolCallCount === 1 ? "" : "s"}`
    ].join(" · ");
    return state.lastReview ? `${active}\n${activeStatus}\n${formatLastReviewStatus(state.lastReview)}\n${setupStatus}\n${guidanceStatus}\n${toolStatus}` : `${active}\n${activeStatus}\n${setupStatus}\n${guidanceStatus}\n${toolStatus}`;
  }

  if (!state.lastReview) {
    return `No review subagent activity for this session.\n${setupStatus}\n${guidanceStatus}\n${toolStatus}`;
  }
  return `${active}\n${formatLastReviewStatus(state.lastReview)}\n${setupStatus}\n${guidanceStatus}\n${toolStatus}`;
}

function formatLastReviewStatus(last: ReviewDetails): string {
  return [
    `Last review: ${last.status}`,
    `model ${last.model}`,
    `thinking ${last.thinkingLevel}`,
    `started ${last.startedAt}`,
    `${last.toolCallCount} tool call${last.toolCallCount === 1 ? "" : "s"}`,
    last.sentBack ? "sent back" : "not sent back"
  ].join(" · ");
}

export async function cancelReviewState(
  state: ReviewState,
  context: Pick<ExtensionContext, "hasUI" | "ui">,
  reason = "Review subagent cancelled by user."
): Promise<boolean> {
  const activeRun = state.activeRun;
  if (state.phase === "idle" || !activeRun) {
    notifyReview(context, "No active review subagent run is available to cancel.", "warning");
    return false;
  }

  activeRun.cancelRequested = true;
  activeRun.resolveCancel();
  setReviewStatus(context, "review cancelling");
  markReviewCancelled(state, reason);

  try {
    await activeRun.abortChild?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notifyReview(context, `Review subagent cancellation requested, but abort failed: ${message}`, "warning");
  }

  return true;
}

function markReviewCancelled(state: ReviewState, reason: string, base?: ReviewDetails): ReviewDetails {
  const activeRun = state.activeRun;
  const details = buildCancelledReviewDetails(
    activeRun?.cwd ?? base?.cwd ?? "unknown",
    activeRun?.focus ?? base?.focus,
    reason,
    base,
    activeRun
  );
  state.lastReview = details;
  return details;
}

function formatReviewPhase(phase: ReviewPhase): string {
  if (phase === "idle") {
    return "idle";
  }
  if (phase === "running") {
    return "running";
  }
  if (phase === "awaiting-display") {
    return "awaiting display";
  }
  return "awaiting send confirmation";
}

export function createReviewToolAllowlistExtension(toolNames: string[]): ExtensionFactory {
  const allowedToolNames = uniqueStrings(toolNames);
  return (api: ExtensionAPI) => {
    const enforceAllowlist = () => {
      api.setActiveTools(allowedToolNames);
    };

    api.on("session_start", enforceAllowlist);
    api.on("session_tree", enforceAllowlist);
    api.on("before_agent_start", enforceAllowlist);
  };
}

export function validateReviewToolAllowlist(api: Pick<ExtensionAPI, "getAllTools">, toolNames: string[], configSource = "review-subagent settings"): void {
  const available = new Set(api.getAllTools().map((tool) => tool.name));
  const missing = uniqueStrings(toolNames).filter((toolName) => !available.has(toolName));
  if (missing.length === 0) {
    return;
  }

  throw new Error([
    `Review-subagent configured tools are unavailable: ${missing.join(", ")}.`,
    `Config source: ${configSource}.`,
    "Adjust review-subagent-settings.json, package filters, or loaded extensions, then run /reload."
  ].join(" "));
}

function reportServiceDiagnostics(context: ExtensionCommandContext, diagnostics: Array<{ type: "info" | "warning" | "error"; message: string }>): void {
  const errors = diagnostics.filter((diagnostic) => diagnostic.type === "error");
  if (errors.length > 0) {
    throw new Error(`Review child session failed to load resources: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`);
  }

  for (const warning of diagnostics.filter((diagnostic) => diagnostic.type === "warning")) {
    context.ui.notify(`Review child session warning: ${warning.message}`, "warning");
  }
}

function omitReviewSubagentExtension(result: LoadExtensionsResult): LoadExtensionsResult {
  return {
    ...result,
    extensions: result.extensions.filter((extension) => !REVIEW_EXTENSION_PATH_PATTERN.test(extension.resolvedPath))
  };
}

export function parseReviewCommandArgs(args: string): ReviewCommandArgs {
  const result: ReviewCommandArgs = { send: false, noSend: false, help: false };
  let index = 0;

  while (index < args.length) {
    index = skipWhitespace(args, index);
    if (index >= args.length) {
      break;
    }

    const rawTokenEnd = findRawTokenEnd(args, index);
    const rawToken = args.slice(index, rawTokenEnd);

    if (rawToken === "--") {
      result.focus = args.slice(rawTokenEnd).trim() || undefined;
      return validateReviewCommandArgs(result);
    }

    if (rawToken === "--help" || rawToken === "-h") {
      result.help = true;
      index = rawTokenEnd;
      continue;
    }

    if (rawToken === "--send" || rawToken === "--yes") {
      result.send = true;
      index = rawTokenEnd;
      continue;
    }

    if (rawToken === "--no-send") {
      result.noSend = true;
      index = rawTokenEnd;
      continue;
    }

    if (rawToken === "--model" || rawToken === "-m") {
      const valueStart = skipWhitespace(args, rawTokenEnd);
      if (valueStart >= args.length) {
        throw new Error(`${rawToken} requires a provider/model value.`);
      }
      const value = readCommandToken(args, valueStart);
      if (!value.text) {
        throw new Error(`${rawToken} requires a provider/model value.`);
      }
      result.model = value.text;
      index = value.nextIndex;
      continue;
    }

    if (rawToken.startsWith("--model=")) {
      const value = normalizeInlineOptionValue(rawToken.slice("--model=".length));
      if (!value) {
        throw new Error("--model requires a provider/model value.");
      }
      result.model = value;
      index = rawTokenEnd;
      continue;
    }

    if (rawToken.startsWith("--")) {
      throw new Error(`Unknown /review option: ${rawToken}`);
    }

    result.focus = args.slice(index).trim() || undefined;
    return validateReviewCommandArgs(result);
  }

  return validateReviewCommandArgs(result);
}

function validateReviewCommandArgs(result: ReviewCommandArgs): ReviewCommandArgs {
  if (result.send && result.noSend) {
    throw new Error("Use only one of --send or --no-send.");
  }

  return result;
}

function skipWhitespace(input: string, start: number): number {
  let index = start;
  while (index < input.length && /\s/.test(input[index])) {
    index += 1;
  }
  return index;
}

function findRawTokenEnd(input: string, start: number): number {
  let index = start;
  while (index < input.length && !/\s/.test(input[index])) {
    index += 1;
  }
  return index;
}

function normalizeInlineOptionValue(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function readCommandToken(input: string, start: number): { text: string; nextIndex: number } {
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;
  let index = start;

  for (; index < input.length; index += 1) {
    const char = input[index];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      break;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Unterminated quoted argument.");
  }
  return { text: current, nextIndex: index };
}

export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Unterminated quoted argument.");
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

export function readReviewSettings(): ReviewSettings {
  const defaults: ReviewSettings = {
    defaultModel: undefined,
    guidance: undefined,
    thinkingLevel: "xhigh",
    maxRecentMessages: 30,
    maxTranscriptChars: 30000,
    maxDiffChars: 50000,
    maxOutputTokens: 6000,
    commandTimeoutMs: 10000,
    tools: [...DEFAULT_REVIEW_TOOLS],
    configSource: "built-in defaults"
  };

  const parsed = readPiToolsJsonConfigSource(REVIEW_CONFIG_FILE, import.meta.url);
  const configSource = parsed === undefined
    ? defaults.configSource
    : `${parsed.source}:${formatConfigPath(parsed.path)}`;
  const configData = parsed?.data ?? {};
  const guidance = readReviewGuidanceConfig(configData, parsed);
  return normalizeReviewSettings({ ...defaults, ...configData, guidance, configSource } as ReviewSettings);
}

function readReviewGuidanceConfig(configData: Record<string, unknown>, config: PiToolsJsonConfig | undefined): string | undefined {
  const inlineGuidance = typeof configData.guidance === "string" && configData.guidance.trim() ? configData.guidance : undefined;
  const guidanceFile = typeof configData.guidanceFile === "string" && configData.guidanceFile.trim() ? configData.guidanceFile.trim() : undefined;
  if (inlineGuidance !== undefined && guidanceFile !== undefined) {
    const source = config ? formatConfigPath(config.path) : REVIEW_CONFIG_FILE;
    throw new Error(`${source} must set either guidance or guidanceFile, not both.`);
  }
  if (guidanceFile === undefined) {
    return inlineGuidance;
  }
  if (!config) {
    throw new Error(`${REVIEW_CONFIG_FILE} guidanceFile requires a settings file.`);
  }
  return readPiToolsReferencedTextConfig(guidanceFile, config.path, config.source).text;
}

function normalizeReviewSettings(settings: ReviewSettings): ReviewSettings {
  return {
    defaultModel: typeof settings.defaultModel === "string" && settings.defaultModel.trim() ? settings.defaultModel.trim() : undefined,
    guidance: typeof settings.guidance === "string" && settings.guidance.trim() ? settings.guidance.trim() : undefined,
    guidanceFile: typeof settings.guidanceFile === "string" && settings.guidanceFile.trim() ? settings.guidanceFile.trim() : undefined,
    thinkingLevel: normalizeThinkingLevel(settings.thinkingLevel, "xhigh"),
    maxRecentMessages: positiveInteger(settings.maxRecentMessages, 30),
    maxTranscriptChars: positiveInteger(settings.maxTranscriptChars, 30000),
    maxDiffChars: positiveInteger(settings.maxDiffChars, 50000),
    maxOutputTokens: positiveInteger(settings.maxOutputTokens, 6000),
    commandTimeoutMs: positiveInteger(settings.commandTimeoutMs, 10000),
    tools: Array.isArray(settings.tools) && settings.tools.every((tool) => typeof tool === "string") && settings.tools.length > 0
      ? Array.from(new Set(settings.tools.map((tool) => tool.trim()).filter(Boolean)))
      : [...DEFAULT_REVIEW_TOOLS],
    configSource: typeof settings.configSource === "string" && settings.configSource.trim() ? settings.configSource.trim() : "built-in defaults"
  };
}

function serializeReviewSettings(
  settings: ReviewSettings,
  defaultModel: string,
  thinkingLevel: ThinkingLevel,
  guidance: string | undefined,
  clearGuidance = false
): Record<string, unknown> {
  const effectiveGuidance = clearGuidance ? undefined : normalizeReviewGuidanceForConfig(guidance ?? settings.guidance);
  return {
    defaultModel,
    ...(effectiveGuidance ? { guidance: effectiveGuidance } : {}),
    thinkingLevel,
    maxRecentMessages: settings.maxRecentMessages,
    maxTranscriptChars: settings.maxTranscriptChars,
    maxDiffChars: settings.maxDiffChars,
    maxOutputTokens: settings.maxOutputTokens,
    commandTimeoutMs: settings.commandTimeoutMs,
    tools: settings.tools
  };
}

function normalizeReviewGuidanceForConfig(guidance: string | undefined): string | undefined {
  const trimmed = guidance?.trim();
  return trimmed ? `${trimmed}\n` : undefined;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function selectReviewModel(
  registry: ExtensionModelRegistry,
  requested: string | undefined,
  currentModel: Model<Api> | undefined,
  fallbackThinkingLevel: ThinkingLevel = "off"
): ResolvedExtensionModel {
  return resolveExtensionModel({
    registry,
    requested,
    currentModel,
    fallbackThinkingLevel,
    label: "Review",
    noModelMessage: "No review model configured. Run /review:setup provider/model[:thinking]."
  });
}

function buildParentContext(context: ExtensionContext, settings: ReviewSettings): string {
  const entries = context.sessionManager.getEntries();
  const leafId = context.sessionManager.getLeafId();
  const sessionContext = buildSessionContext(entries, leafId);
  const messages = convertToLlm(sessionContext.messages);
  return serializeRecentMessages(messages, settings.maxRecentMessages, settings.maxTranscriptChars);
}

export function serializeRecentMessages(messages: Message[], maxMessages: number, maxChars: number): string {
  const recent = messages.slice(-maxMessages);
  const serialized = recent.map((message, index) => serializeMessage(message, messages.length - recent.length + index + 1)).join("\n\n---\n\n");
  return truncateText(serialized || "(no recent transcript messages)", maxChars);
}

function serializeMessage(message: Message, index: number): string {
  if (message.role === "user") {
    return `#${index} USER\n${contentToText(message.content)}`;
  }

  if (message.role === "assistant") {
    const textParts = message.content
      .filter((item): item is TextContent => item.type === "text")
      .map((item) => item.text.trim())
      .filter(Boolean);
    const toolCalls = message.content
      .filter((item) => item.type === "toolCall")
      .map((item) => `- ${item.name} ${truncateOneLine(JSON.stringify(item.arguments), 500)}`);
    return [
      `#${index} ASSISTANT (${message.provider}/${message.model}, stop=${message.stopReason})`,
      textParts.join("\n\n") || "(no assistant text)",
      toolCalls.length > 0 ? `Tool calls:\n${toolCalls.join("\n")}` : undefined
    ].filter(Boolean).join("\n");
  }

  const toolResult = message as ToolResultMessage;
  return [
    `#${index} TOOL RESULT ${toolResult.toolName}${toolResult.isError ? " (error)" : ""}`,
    truncateText(contentToText(toolResult.content), 3000)
  ].join("\n");
}

function contentToText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") {
    return content;
  }

  return content.map((item) => item.type === "text" ? item.text : `[image: ${item.mimeType}]`).join("\n");
}

async function collectGitContext(api: ExecCapableApi, cwd: string, settings: ReviewSettings): Promise<GitContext> {
  const errors: string[] = [];
  const rootResult = await execGit(api, cwd, ["rev-parse", "--show-toplevel"], settings.commandTimeoutMs);
  if (rootResult.code !== 0) {
    return {
      isRepository: false,
      status: "(not a git repository)",
      diffStat: "",
      unstagedDiff: "",
      stagedDiff: "",
      untrackedFiles: "",
      errors: [rootResult.stderr.trim() || rootResult.stdout.trim() || "git rev-parse failed"]
    };
  }

  const root = rootResult.stdout.trim();
  const [status, unstagedStat, stagedStat, unstagedDiff, stagedDiff, untrackedFiles] = await Promise.all([
    execGit(api, cwd, ["status", "--short"], settings.commandTimeoutMs),
    execGit(api, cwd, ["diff", "--stat", "--"], settings.commandTimeoutMs),
    execGit(api, cwd, ["diff", "--cached", "--stat", "--"], settings.commandTimeoutMs),
    execGit(api, cwd, ["diff", "--no-ext-diff", "--minimal", "--unified=40", "--"], settings.commandTimeoutMs),
    execGit(api, cwd, ["diff", "--cached", "--no-ext-diff", "--minimal", "--unified=40", "--"], settings.commandTimeoutMs),
    execGit(api, cwd, ["ls-files", "--others", "--exclude-standard"], settings.commandTimeoutMs)
  ]);

  for (const [label, result] of [
    ["git status", status],
    ["git diff --stat", unstagedStat],
    ["git diff --cached --stat", stagedStat],
    ["git diff", unstagedDiff],
    ["git diff --cached", stagedDiff],
    ["git ls-files --others", untrackedFiles]
  ] as const) {
    if (result.code !== 0) {
      errors.push(`${label}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
    }
  }

  const perDiffCap = Math.max(1000, Math.floor(settings.maxDiffChars / 2));
  return {
    isRepository: true,
    root,
    status: status.stdout.trim() || "(clean)",
    diffStat: [
      unstagedStat.stdout.trim() ? `Unstaged:\n${unstagedStat.stdout.trim()}` : "Unstaged: (none)",
      stagedStat.stdout.trim() ? `Staged:\n${stagedStat.stdout.trim()}` : "Staged: (none)"
    ].join("\n\n"),
    unstagedDiff: truncateText(unstagedDiff.stdout.trim() || "(none)", perDiffCap),
    stagedDiff: truncateText(stagedDiff.stdout.trim() || "(none)", perDiffCap),
    untrackedFiles: truncateText(untrackedFiles.stdout.trim() || "(none)", 10000),
    errors
  };
}

async function execGit(api: ExecCapableApi, cwd: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await api.exec("git", args, { cwd, timeout });
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  } catch (error) {
    return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1 };
  }
}

export function buildReviewTask(parentContext: string, gitContext: GitContext, focus: string | undefined, settings: ReviewSettings): string {
  return [
    "Review the recent work from the parent Pi session.",
    focus ? `\nUser-requested review focus:\n${focus}` : undefined,
    ...formatReviewGuidance(settings.guidance),
    "\nYou have your own tool access. Inspect the repository and run safe validation commands when useful before writing the final critique.",
    "\nImportant live-worktree note: the parent conversation may continue while you review. Treat the transcript and git diff below as launch-time context, verify current files before citing them, and call out any apparent drift if it affects confidence.",
    "\nImportant shell_start instruction: keep validation commands bounded, use command objects that include cwd and notifyOnExit:false, and do not leave long-running background jobs from the review subagent.",
    `\nMaximum final answer target: ${settings.maxOutputTokens} tokens. Be thorough but prioritize actionable findings.`,
    "\n## Current working directory",
    gitContext.root ? `${gitContext.root}` : "Unknown / not a git repository",
    "\n## Parent session recent context",
    parentContext,
    "\n## Git status",
    gitContext.status,
    "\n## Git diff stat",
    gitContext.diffStat || "(none)",
    "\n## Untracked files",
    gitContext.untrackedFiles,
    "\n## Staged diff excerpt",
    fenced(gitContext.stagedDiff, "diff"),
    "\n## Unstaged diff excerpt",
    fenced(gitContext.unstagedDiff, "diff"),
    gitContext.errors.length > 0 ? `\n## Git context collection errors\n${gitContext.errors.map((error) => `- ${error}`).join("\n")}` : undefined,
    "\nNow perform your independent review. Use tools first if more evidence is needed, then provide the final answer in the required review format."
  ].filter(Boolean).join("\n");
}

function formatReviewGuidance(guidance: string | undefined): string[] {
  if (!guidance?.trim()) {
    return [];
  }
  return [
    "\n## Reviewer guidance",
    truncateText(guidance, 6000)
  ];
}

async function shouldSendReviewBack(context: ExtensionCommandContext, args: ReviewCommandArgs, details: ReviewDetails): Promise<boolean> {
  if (args.noSend) {
    return false;
  }
  if (args.send) {
    return true;
  }
  if (!context.hasUI) {
    return false;
  }
  return context.ui.confirm(
    "Send review back to main agent?",
    [
      `Reviewer model: ${details.model}`,
      `Tool calls: ${details.toolCallCount}`,
      "",
      "The critique is visible in the transcript. Send it as a user message so the main agent can address it now?"
    ].join("\n")
  );
}

function buildSendBackMessage(details: ReviewDetails): string {
  return [
    "A review subagent critiqued the recent work. Please assess the critique, fix issues that are valid, explain any points you reject, and run appropriate validation.",
    "",
    `Reviewer model: ${details.model}`,
    `Reviewer tool calls: ${details.toolCallCount}`,
    "",
    details.critique
  ].join("\n");
}

export function buildReviewMessageContent(details: ReviewDetails): string {
  if (details.status === "failed") {
    return `Review subagent failed: ${details.error ?? "unknown error"}`;
  }
  if (details.status === "cancelled") {
    return `Review subagent cancelled: ${details.error ?? "cancelled"}`;
  }
  return [
    "Review subagent completed.",
    "The critique is displayed in the main window renderer and is not sent back to the main agent unless approved.",
    details.sentBack ? "Status: critique was sent back to the main agent." : "Status: critique has not been sent back."
  ].join("\n");
}

export function buildCancelledReviewDetails(cwd: string, focus: string | undefined, reason: string, base?: ReviewDetails, activeRun?: ReviewActiveRun): ReviewDetails {
  const now = new Date();
  const startedAt = base?.startedAt ?? activeRun?.startedAt ?? now.toISOString();
  const startedMs = Date.parse(startedAt);
  return {
    status: "cancelled",
    cwd,
    model: base?.model ?? activeRun?.model ?? "unknown",
    thinkingLevel: base?.thinkingLevel ?? activeRun?.thinkingLevel ?? "off",
    focus,
    startedAt,
    completedAt: now.toISOString(),
    durationMs: Number.isFinite(startedMs) ? Math.max(0, now.getTime() - startedMs) : 0,
    critique: "",
    sentBack: false,
    events: base?.events ?? [],
    toolCallCount: base?.toolCallCount ?? activeRun?.toolCallCount ?? 0,
    error: reason
  };
}

function buildFailedReviewDetails(cwd: string, focus: string | undefined, error: string): ReviewDetails {
  const now = new Date().toISOString();
  return {
    status: "failed",
    cwd,
    model: "unknown",
    thinkingLevel: "off",
    focus,
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    critique: "",
    sentBack: false,
    events: [],
    toolCallCount: 0,
    error
  };
}

export function renderReviewMessage(details: ReviewDetails | undefined, expanded: boolean, theme: { fg: (color: any, text: string) => string; bold: (text: string) => string }) {
  if (!details) {
    return new Text("Review subagent result is missing details.", 0, 0);
  }

  const container = new Container();
  const icon = details.status === "completed" ? theme.fg("success", "✓") : details.status === "cancelled" ? theme.fg("warning", "⊘") : theme.fg("error", "✗");
  const title = theme.fg("toolTitle", theme.bold(" Review subagent"));
  container.addChild(new Text(`${icon}${title} ${theme.fg("muted", details.model)} ${theme.fg("dim", formatDuration(details.durationMs))}`, 0, 0));
  container.addChild(new Text(theme.fg("dim", `${details.toolCallCount} tool call${details.toolCallCount === 1 ? "" : "s"} · ${details.sentBack ? "sent back" : "not sent back"}`), 0, 0));

  if (details.focus) {
    container.addChild(new Text(theme.fg("muted", `Focus: ${details.focus}`), 0, 0));
  }

  if (details.status === "failed" || details.status === "cancelled") {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg(details.status === "cancelled" ? "warning" : "error", details.error ?? "Unknown review error"), 0, 0));
    return container;
  }

  container.addChild(new Spacer(1));
  const critique = expanded ? details.critique : truncateLines(details.critique, 90);
  container.addChild(new Markdown(critique, 0, 0, getMarkdownTheme()));

  if (!expanded && details.critique.split("\n").length > 90) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand full review)"), 0, 0));
  }

  if (expanded && details.events.length > 0) {
    const toolEvents = details.events
      .filter((event) => event.type === "tool_start" || event.type === "tool_end")
      .slice(-30)
      .map((event) => `${event.type === "tool_start" ? "→" : event.isError ? "✗" : "✓"} ${event.toolName ?? "tool"}${event.text ? ` ${event.text}` : ""}`);
    if (toolEvents.length > 0) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", "Recent reviewer tool activity:"), 0, 0));
      container.addChild(new Text(theme.fg("dim", toolEvents.join("\n")), 0, 0));
    }
  }

  return container;
}

function recordReviewEvent(events: ReviewEventRecord[], event: AgentSessionEvent): void {
  if (event.type === "tool_execution_start") {
    events.push({ type: "tool_start", timestamp: Date.now(), toolName: event.toolName, args: event.args });
    return;
  }

  if (event.type === "tool_execution_end") {
    events.push({
      type: "tool_end",
      timestamp: Date.now(),
      toolName: event.toolName,
      isError: event.isError,
      text: summarizeToolResult(event.result)
    });
    return;
  }

  if (event.type === "message_end" && event.message.role === "assistant") {
    const text = assistantText(event.message).trim();
    if (text) {
      events.push({ type: "assistant", timestamp: Date.now(), text: truncateOneLine(text, 500) });
    }
  }
}

function summarizeToolResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .filter((item): item is TextContent => Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text")
    .map((item) => item.text)
    .join(" ")
    .trim();
  return text ? truncateOneLine(text, 200) : undefined;
}

function getFinalAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

function getFinalAssistantText(messages: AgentMessage[]): string {
  const assistant = getFinalAssistant(messages);
  return assistant ? assistantText(assistant) : "";
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function formatExtensionError(error: ExtensionError): string {
  return `${error.extensionPath} ${error.event}: ${error.error}`;
}


function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n...[truncated ${omitted} chars]`;
}

function truncateOneLine(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars)}...`;
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : `${lines.slice(0, maxLines).join("\n")}\n\n...[truncated ${lines.length - maxLines} lines]`;
}

function fenced(text: string, language = ""): string {
  const fence = text.includes("```") ? "````" : "```";
  return `${fence}${language}\n${text}\n${fence}`;
}

function reviewCommandHelp(): string {
  return [
    "Usage: /review [--model provider/model] [--send|--no-send] [focus]",
    "",
    "Runs a real tool-using Pi reviewer in an isolated background child session, displays the critique when the main agent is idle, and optionally sends it back to the main agent."
  ].join("\n");
}
