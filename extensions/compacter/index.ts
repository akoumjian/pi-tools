import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, type Model, type Provider, type ProviderHeaders, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  estimateTokens,
  serializeConversation,
  type CompactionResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionEntry
} from "@earendil-works/pi-coding-agent";
import { formatModelName, resolveExtensionModel } from "../_shared/model-spec.js";

const COMMAND_NAME = "compacter";
const STATUS_KEY = "compacter";
const DETAILS_VERSION = 1;
const MAX_CHUNK_INPUT_TOKENS = 40_000;
const MIN_CHUNK_INPUT_TOKENS = 1_000;
const PROMPT_OVERHEAD_TOKENS = 2_000;
const MAX_REDUCTION_PASSES = 8;

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed tasks]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const CHUNK_SUMMARIZATION_PROMPT = `The content above is one slice of a larger conversation being compacted.

Summarize only this slice for a later merge step. Keep durable facts, decisions, constraints, exact file paths, commands, function names, error messages, and current state. Do not invent progress from outside this slice. Be concise but complete enough that this slice can be merged with other slice summaries.`;

const INTERMEDIATE_MERGE_PROMPT = `The content above contains partial summaries from adjacent slices of one larger conversation.

Merge them into one concise intermediate summary. Preserve durable facts, decisions, constraints, exact file paths, commands, function names, error messages, current state, and unresolved next steps. Do not use XML file-operation tags; those are appended separately.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export type CompacterCommandArgs =
  | { action: "run"; model?: string; instructions?: string }
  | { action: "status" | "on" | "off" | "toggle" | "help" };

type ManualCompacterRun = {
  model?: string;
};

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];

type SummarizationBudget = {
  chunkInputTokens: number;
  finalMaxTokens: number;
  intermediateMaxTokens: number;
};

type SummarizationStats = {
  chunks: number;
  modelCalls: number;
  reductionPasses: number;
};

type CompacterDetails = {
  compacter: {
    version: typeof DETAILS_VERSION;
    model: string;
    chunks: number;
    modelCalls: number;
    reductionPasses: number;
  };
  readFiles: string[];
  modifiedFiles: string[];
};

type TextChunk = {
  text: string;
  tokens: number;
};

type CompletionOptions = {
  model: Model<Api>;
  provider: Provider;
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
  signal: AbortSignal;
  thinkingLevel: ThinkingLevel;
  budget: SummarizationBudget;
};

let runtimeEnabled = true;
let manualRun: ManualCompacterRun | undefined;

export default function compacterExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, context) => {
    if (!runtimeEnabled && !manualRun) {
      return undefined;
    }

    context.ui.setStatus(STATUS_KEY, "compacter preparing");
    try {
      const result = await runCompacter(event.preparation, event.branchEntries, event.customInstructions, event.signal, context, api);
      context.ui.setStatus(STATUS_KEY, undefined);
      return { compaction: result };
    } catch (error) {
      context.ui.setStatus(STATUS_KEY, undefined);
      throw error;
    }
  });

  api.registerCommand(COMMAND_NAME, {
    description: "Run robust chunked compaction, or manage the Compacter hook (usage: /compacter [--model provider/model] [instructions] | status|on|off|toggle)",
    handler: async (args, context) => {
      await handleCompacterCommand(args, context);
    }
  });
}

async function handleCompacterCommand(rawArgs: string, context: ExtensionCommandContext): Promise<void> {
  let args: CompacterCommandArgs;
  try {
    args = parseCompacterCommandArgs(rawArgs);
  } catch (error) {
    context.ui.notify(`${errorMessage(error)}\n\n${compacterUsage()}`, "error");
    return;
  }

  switch (args.action) {
    case "help":
      context.ui.notify(compacterUsage(), "info");
      return;
    case "status":
      context.ui.notify(buildCompacterStatusText(context), "info");
      return;
    case "on":
      runtimeEnabled = true;
      context.ui.notify(buildCompacterStatusText(context), "info");
      return;
    case "off":
      runtimeEnabled = false;
      context.ui.notify(buildCompacterStatusText(context), "warning");
      return;
    case "toggle":
      runtimeEnabled = !runtimeEnabled;
      context.ui.notify(buildCompacterStatusText(context), runtimeEnabled ? "info" : "warning");
      return;
    case "run":
      await runManualCompacterCommand(args, context);
      return;
  }
}

async function runManualCompacterCommand(args: Extract<CompacterCommandArgs, { action: "run" }>, context: ExtensionCommandContext): Promise<void> {
  if (manualRun) {
    context.ui.notify("A /compacter run is already pending.", "warning");
    return;
  }

  await context.waitForIdle();
  const request: ManualCompacterRun = { model: args.model };
  manualRun = request;
  const modelSuffix = args.model ? ` with ${args.model}` : "";
  context.ui.notify(`Starting chunked compaction${modelSuffix}...`, "info");

  try {
    const result = await new Promise<CompactionResult>((resolve, reject) => {
      context.compact({
        customInstructions: args.instructions,
        onComplete: resolve,
        onError: reject
      });
    });
    const details = isCompacterDetails(result.details) ? result.details.compacter : undefined;
    const detailSuffix = details ? ` using ${details.model} across ${details.chunks} chunk${details.chunks === 1 ? "" : "s"}` : "";
    context.ui.notify(`Compacter finished${detailSuffix}.`, "info");
  } catch (error) {
    context.ui.notify(`Compacter failed: ${errorMessage(error)}`, "error");
  } finally {
    if (manualRun === request) {
      manualRun = undefined;
    }
    context.ui.setStatus(STATUS_KEY, undefined);
  }
}

async function runCompacter(
  preparation: CompactionPreparation,
  branchEntries: SessionEntry[],
  customInstructions: string | undefined,
  signal: AbortSignal,
  context: ExtensionContext,
  api: ExtensionAPI
): Promise<CompactionResult<CompacterDetails>> {
  const resolved = resolveExtensionModel({
    registry: context.modelRegistry,
    requested: manualRun?.model,
    currentModel: context.model,
    fallbackThinkingLevel: api.getThinkingLevel(),
    label: "Compacter",
    noModelMessage: "No current model is selected. Select a model or pass /compacter --model provider/model."
  });
  const auth = await context.modelRegistry.getApiKeyAndHeaders(resolved.model);
  if (!auth.ok) {
    throw new Error(auth.error);
  }
  const providerAuth = await context.modelRegistry.getProviderAuth(resolved.model.provider);
  if (!providerAuth) {
    throw new Error(`No resolved provider auth for ${formatModelName(resolved.model)}`);
  }
  const provider = context.modelRegistry.getProvider(resolved.model.provider);
  if (!provider) {
    throw new Error(`No runtime provider for ${formatModelName(resolved.model)}`);
  }

  const requestModel = providerAuth.auth.baseUrl
    ? { ...resolved.model, baseUrl: providerAuth.auth.baseUrl }
    : resolved.model;
  const budget = createSummarizationBudget(requestModel, preparation.settings.reserveTokens);
  const completionOptions: CompletionOptions = {
    model: requestModel,
    provider,
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env ?? providerAuth.env,
    signal,
    thinkingLevel: resolved.thinkingLevel,
    budget
  };
  const stats: SummarizationStats = { chunks: 0, modelCalls: 0, reductionPasses: 0 };

  context.ui.setStatus(STATUS_KEY, `compacter summarizing with ${formatModelName(resolved.model)}`);
  let summary = await summarizeHistory(preparation, customInstructions, completionOptions, stats, context);
  if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
    context.ui.setStatus(STATUS_KEY, "compacter summarizing split turn prefix");
    const turnPrefixSummary = await summarizeTurnPrefix(preparation.turnPrefixMessages, completionOptions, stats);
    summary = `${summary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixSummary}`;
  }

  const { readFiles, modifiedFiles } = computeCumulativeFileLists(preparation, branchEntries);
  summary += formatFileOperations(readFiles, modifiedFiles);

  return {
    summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: {
      compacter: {
        version: DETAILS_VERSION,
        model: formatModelName(resolved.model),
        chunks: stats.chunks,
        modelCalls: stats.modelCalls,
        reductionPasses: stats.reductionPasses
      },
      readFiles,
      modifiedFiles
    }
  };
}

async function summarizeHistory(
  preparation: CompactionPreparation,
  customInstructions: string | undefined,
  options: CompletionOptions,
  stats: SummarizationStats,
  context: ExtensionContext
): Promise<string> {
  if (preparation.messagesToSummarize.length === 0) {
    return preparation.previousSummary ?? "No prior history.";
  }

  const finalPrompt = buildFinalHistoryPrompt(preparation.previousSummary, customInstructions);
  const chunks = buildConversationChunks(preparation.messagesToSummarize, options.budget.chunkInputTokens);
  stats.chunks += chunks.length;
  context.ui.setStatus(STATUS_KEY, `compacter summarizing ${chunks.length} history chunk${chunks.length === 1 ? "" : "s"}`);

  if (!preparation.previousSummary && chunks.length === 1) {
    return completeSummary(chunks[0].text, finalPrompt, options, options.budget.finalMaxTokens, stats);
  }

  const partials = await summarizeChunks(chunks, CHUNK_SUMMARIZATION_PROMPT, customInstructions, options, stats);
  return reducePartialSummaries(partials, finalPrompt, options, stats);
}

async function summarizeTurnPrefix(messages: AgentMessage[], options: CompletionOptions, stats: SummarizationStats): Promise<string> {
  const chunks = buildConversationChunks(messages, options.budget.chunkInputTokens);
  stats.chunks += chunks.length;
  if (chunks.length === 1) {
    return completeSummary(chunks[0].text, TURN_PREFIX_SUMMARIZATION_PROMPT, options, options.budget.intermediateMaxTokens, stats);
  }

  const partials = await summarizeChunks(chunks, CHUNK_SUMMARIZATION_PROMPT, TURN_PREFIX_SUMMARIZATION_PROMPT, options, stats);
  return reducePartialSummaries(partials, TURN_PREFIX_SUMMARIZATION_PROMPT, options, stats);
}

async function summarizeChunks(
  chunks: TextChunk[],
  prompt: string,
  customInstructions: string | undefined,
  options: CompletionOptions,
  stats: SummarizationStats
): Promise<string[]> {
  const results: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const instructionSuffix = customInstructions ? `\n\nAdditional focus: ${customInstructions}` : "";
    const promptText = `<conversation-chunk index="${index + 1}" total="${chunks.length}">\n${chunk.text}\n</conversation-chunk>\n\n${prompt}${instructionSuffix}`;
    results.push(await completePrompt(promptText, options, options.budget.intermediateMaxTokens, stats));
  }
  return results;
}

async function reducePartialSummaries(
  summaries: string[],
  finalPrompt: string,
  options: CompletionOptions,
  stats: SummarizationStats
): Promise<string> {
  let current = summaries;
  for (let pass = 0; pass <= MAX_REDUCTION_PASSES; pass += 1) {
    const chunks = chunkTexts(current, options.budget.chunkInputTokens, "partial-summary");
    if (chunks.length === 1) {
      const promptText = `<partial-summaries>\n${chunks[0].text}\n</partial-summaries>\n\n${finalPrompt}`;
      return completePrompt(promptText, options, options.budget.finalMaxTokens, stats);
    }

    stats.reductionPasses += 1;
    const next: string[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const promptText = `<partial-summary-bundle index="${index + 1}" total="${chunks.length}">\n${chunks[index].text}\n</partial-summary-bundle>\n\n${INTERMEDIATE_MERGE_PROMPT}`;
      next.push(await completePrompt(promptText, options, options.budget.intermediateMaxTokens, stats));
    }
    current = next;
  }

  throw new Error(`Compacter could not reduce summaries after ${MAX_REDUCTION_PASSES} passes.`);
}

function buildFinalHistoryPrompt(previousSummary: string | undefined, customInstructions: string | undefined): string {
  let prompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    prompt = `${prompt}\n\nAdditional focus: ${customInstructions}`;
  }
  if (!previousSummary) {
    return prompt;
  }
  return `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${prompt}`;
}

async function completeSummary(
  conversationText: string,
  prompt: string,
  options: CompletionOptions,
  maxTokens: number,
  stats: SummarizationStats
): Promise<string> {
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${prompt}`;
  return completePrompt(promptText, options, maxTokens, stats);
}

async function completePrompt(promptText: string, options: CompletionOptions, maxTokens: number, stats: SummarizationStats): Promise<string> {
  const completionOptions: SimpleStreamOptions = {
    maxTokens,
    signal: options.signal,
    apiKey: options.apiKey,
    headers: options.headers,
    env: options.env,
    maxRetries: 0
  };
  if (options.model.reasoning && options.thinkingLevel !== "off") {
    completionOptions.reasoning = options.thinkingLevel;
  }

  stats.modelCalls += 1;
  const response = await options.provider.streamSimple(options.model, {
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }]
  }, completionOptions).result();

  if (response.stopReason === "error") {
    throw new Error(formatSummarizationFailure(response, options.model));
  }

  const text = response.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error(`Compacter summarization returned no text from ${formatModelName(options.model)}.`);
  }
  return text;
}

export function createSummarizationBudget(model: Pick<Model<Api>, "contextWindow" | "maxTokens">, reserveTokens: number): SummarizationBudget {
  const modelMaxTokens = Math.max(1, model.maxTokens || reserveTokens);
  const finalMaxTokens = Math.min(modelMaxTokens, Math.max(1_024, Math.floor(0.8 * reserveTokens)));
  const intermediateMaxTokens = Math.min(modelMaxTokens, Math.max(1_024, Math.min(4_096, Math.floor(0.5 * reserveTokens))));
  const availableInputTokens = model.contextWindow - Math.max(finalMaxTokens, intermediateMaxTokens) - PROMPT_OVERHEAD_TOKENS;
  if (availableInputTokens < MIN_CHUNK_INPUT_TOKENS) {
    throw new Error(`Compacter cannot safely summarize with this model: context window ${model.contextWindow} leaves only ${availableInputTokens} input tokens after response/prompt reserve.`);
  }

  return {
    chunkInputTokens: Math.max(MIN_CHUNK_INPUT_TOKENS, Math.min(MAX_CHUNK_INPUT_TOKENS, Math.floor(availableInputTokens * 0.8))),
    finalMaxTokens,
    intermediateMaxTokens
  };
}

export function buildConversationChunks(messages: AgentMessage[], maxTokens: number): TextChunk[] {
  const serialized = messages
    .map((message) => serializeConversation(convertToLlm([message])).trim())
    .filter((text) => text.length > 0);
  return chunkTexts(serialized, maxTokens, "message");
}

export function chunkTexts(texts: string[], maxTokens: number, label: string): TextChunk[] {
  const maxChars = Math.max(1, maxTokens * 4);
  const chunks: TextChunk[] = [];
  let current: string[] = [];
  let currentChars = 0;

  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    const labeledText = `<${label} index="${index + 1}">\n${text}\n</${label}>`;
    if (labeledText.length > maxChars) {
      if (current.length > 0) {
        chunks.push(textChunk(current.join("\n\n")));
        current = [];
        currentChars = 0;
      }
      chunks.push(...splitOversizedText(labeledText, maxChars, `${label}-part`));
      continue;
    }

    const separatorChars = current.length === 0 ? 0 : 2;
    if (current.length > 0 && currentChars + separatorChars + labeledText.length > maxChars) {
      chunks.push(textChunk(current.join("\n\n")));
      current = [];
      currentChars = 0;
    }
    current.push(labeledText);
    currentChars += separatorChars + labeledText.length;
  }

  if (current.length > 0) {
    chunks.push(textChunk(current.join("\n\n")));
  }
  return chunks;
}

function splitOversizedText(text: string, maxChars: number, label: string): TextChunk[] {
  const partBudget = Math.max(1, maxChars - 128);
  const chunks: TextChunk[] = [];
  for (let start = 0, part = 1; start < text.length; start += partBudget, part += 1) {
    const slice = text.slice(start, start + partBudget);
    chunks.push(textChunk(`<${label} index="${part}">\n${slice}\n</${label}>`));
  }
  return chunks;
}

function textChunk(text: string): TextChunk {
  return { text, tokens: estimateTextTokens(text) };
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function computeCumulativeFileLists(preparation: CompactionPreparation, branchEntries: SessionEntry[]): { readFiles: string[]; modifiedFiles: string[] } {
  const read = new Set<string>(preparation.fileOps.read);
  const modified = new Set<string>([...preparation.fileOps.written, ...preparation.fileOps.edited]);

  const previous = latestCompactionDetails(branchEntries);
  for (const file of previous?.readFiles ?? []) {
    read.add(file);
  }
  for (const file of previous?.modifiedFiles ?? []) {
    modified.add(file);
  }

  for (const file of modified) {
    read.delete(file);
  }
  return {
    readFiles: [...read].sort(),
    modifiedFiles: [...modified].sort()
  };
}

function latestCompactionDetails(branchEntries: SessionEntry[]): { readFiles: string[]; modifiedFiles: string[] } | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (entry.type !== "compaction") {
      continue;
    }
    if (isFileOperationDetails(entry.details)) {
      return entry.details;
    }
  }
  return undefined;
}

function isFileOperationDetails(value: unknown): value is { readFiles: string[]; modifiedFiles: string[] } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const details = value as { readFiles?: unknown; modifiedFiles?: unknown };
  return isStringArray(details.readFiles) && isStringArray(details.modifiedFiles);
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

export function parseCompacterCommandArgs(rawArgs: string): CompacterCommandArgs {
  const args = rawArgs.trim();
  if (!args) {
    return { action: "run" };
  }

  const first = readCommandToken(args, 0);
  const subcommand = first.text.toLowerCase();
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return { action: "help" };
  }
  if (subcommand === "status" || subcommand === "on" || subcommand === "off" || subcommand === "toggle") {
    const rest = args.slice(first.nextIndex).trim();
    if (rest) {
      throw new Error(`/${COMMAND_NAME} ${subcommand} does not accept extra arguments.`);
    }
    return { action: subcommand };
  }

  return parseRunArgs(args);
}

function parseRunArgs(args: string): Extract<CompacterCommandArgs, { action: "run" }> {
  const result: Extract<CompacterCommandArgs, { action: "run" }> = { action: "run" };
  let index = 0;

  while (index < args.length) {
    index = skipWhitespace(args, index);
    if (index >= args.length) {
      break;
    }

    const rawTokenEnd = findRawTokenEnd(args, index);
    const rawToken = args.slice(index, rawTokenEnd);
    if (rawToken === "--") {
      result.instructions = args.slice(rawTokenEnd).trim() || undefined;
      return result;
    }
    if (rawToken === "--help" || rawToken === "-h") {
      return { action: "run", instructions: args.slice(rawTokenEnd).trim() || undefined };
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
      throw new Error(`Unknown /${COMMAND_NAME} option: ${rawToken}`);
    }

    result.instructions = args.slice(index).trim() || undefined;
    return result;
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

function buildCompacterStatusText(context: Pick<ExtensionContext, "model">): string {
  const state = runtimeEnabled ? "enabled" : "disabled";
  const currentModel = context.model ? formatModelName(context.model) : "none";
  return [
    `Compacter is ${state}.`,
    `Current model: ${currentModel}.`,
    runtimeEnabled
      ? "Auto-compaction and built-in /compact will use chunked summarization."
      : "Auto-compaction and built-in /compact use Pi's built-in summarizer while Compacter is disabled.",
    "/compacter [--model provider/model] [instructions] always runs one manual chunked compaction."
  ].join("\n");
}

function compacterUsage(): string {
  return [
    "Usage:",
    "  /compacter [--model provider/model] [instructions]",
    "  /compacter status|on|off|toggle",
    "",
    "With no subcommand, runs one manual chunked compaction. --model is a one-run summarizer override; otherwise Compacter uses the current active model."
  ].join("\n");
}

function formatSummarizationFailure(response: AssistantMessage, model: Model<Api>): string {
  const message = response.errorMessage || "Unknown error";
  return `${providerFailurePrefix(model, message)}${message}`;
}

function providerFailurePrefix(model: Model<Api>, message: string): string {
  if (model.api === "anthropic-messages" || model.provider === "anthropic") {
    const classification = classifyAnthropicFailure(message);
    return classification ? `${classification}: ` : "";
  }
  return "";
}

export function classifyAnthropicFailure(message: string): string | undefined {
  if (/529|overloaded_error|overloaded/i.test(message)) {
    return "Anthropic temporary overload (normally HTTP 529)";
  }
  if (!/(429|rate.?limit|too many requests|rate_limit_error|RateLimitError)/i.test(message)) {
    return undefined;
  }
  if (/(usage|quota|credit|balance|monthly|weekly|daily|subscription|billing|acceleration|hard limit|limit reached|exceeded)/i.test(message)) {
    return "Anthropic usage or quota limit (HTTP 429, not a server-busy 529)";
  }
  return "Anthropic rate limit (HTTP 429; server-busy overload is usually HTTP 529)";
}

function isCompacterDetails(value: unknown): value is CompacterDetails {
  if (!value || typeof value !== "object") {
    return false;
  }
  const details = value as { compacter?: { version?: unknown } };
  return details.compacter?.version === DETAILS_VERSION;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function estimateMessagesForTesting(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}
