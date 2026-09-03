import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry
} from "@earendil-works/pi-coding-agent";

export const MANUAL_RETRY_COMMAND_NAME = "retry";
export const MANUAL_RETRY_MESSAGE_TYPE = "manual-provider-retry";
export const AUTOMATIC_RETRY_MAX_ATTEMPTS = 3;
export const AUTOMATIC_RETRY_BASE_DELAY_MS = 2_000;

/**
 * Settled provider errors that Pi core's transient classifier does not retry but
 * that are outage symptoms in practice: bare HTTP reason phrases surfaced when a
 * provider edge answers an empty-body HTTP error (observed from the OpenAI Codex
 * SSE path throughout the 2026-09-03 OpenAI incident). Core already retries the
 * 429/5xx and connection classes, so this list stays deliberately short.
 */
export const AUTOMATIC_RETRY_ERROR_PATTERNS: readonly RegExp[] = [
  /^not found$/i,
  /^bad gateway$/i,
  /^(?:http )?(?:404|502)\b/i
];

export type RetryTrigger = "manual" | "automatic";
export type RetryKind = "error" | "aborted" | "continuation";

export type ManualRetryMarkerDetails = {
  version: 2;
  attempt: number;
  trigger: RetryTrigger;
  kind: RetryKind;
  errorMessage?: string;
  failedAssistantEntryId?: string;
  failedAt?: number;
  /** The model the current context is resent to. */
  api: string;
  provider: string;
  model: string;
  requestedAt: string;
};

export type ManualRetryEligibility =
  | {
    eligible: true;
    kind: RetryKind;
    attempt: number;
    errorMessage?: string;
    failedAssistant?: AssistantMessage;
    failedAssistantEntryId?: string;
    failedAt?: number;
  }
  | {
    eligible: false;
    reason: string;
  };

export type AutomaticRetryOutcome =
  | { status: "skipped"; reason: string }
  | { status: "exhausted"; attempts: number }
  | { status: "stale" }
  | { status: "dispatched"; attempt: number; delayMs: number };

export type ManualRetryDependencies = {
  sleep: (ms: number) => Promise<void>;
};

type RetryFilterableCompactionPreparation = {
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
};

const defaultDependencies: ManualRetryDependencies = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

export default function manualRetryExtension(api: ExtensionAPI, overrides: Partial<ManualRetryDependencies> = {}): void {
  const dependencies: ManualRetryDependencies = { ...defaultDependencies, ...overrides };

  api.on("context", (event) => {
    const messages = filterManualRetryMessages(event.messages);
    return messages.length === event.messages.length ? undefined : { messages };
  });

  // This extension must load before Compacter so every summarizer sees the same
  // provider-safe message set as the main request path.
  api.on("session_before_compact", (event) => {
    filterManualRetryCompactionPreparation(event.preparation);
  });

  // agent_settled is awaited by Pi, so the handler must not return the retry
  // promise: the backoff sleep would otherwise hold the session in a non-idle
  // state. Failures inside are reported through the normal run lifecycle.
  api.on("agent_settled", (_event, context) => {
    void runAutomaticRetry(api, context, dependencies).catch(() => undefined);
  });

  api.registerCommand(MANUAL_RETRY_COMMAND_NAME, {
    description: "Resend the current context to the selected model after a failed or cancelled attempt, without adding a user message",
    handler: async (args, context) => {
      handleManualRetryCommand(api, args, context);
    }
  });
}

/**
 * Remove retry markers, failed/aborted assistant attempts, and any tool results
 * that answered a removed attempt, so the provider receives the current context
 * exactly as it stood before the failed attempt.
 */
export function filterManualRetryMessages<T extends AgentMessage>(messages: readonly T[]): T[] {
  const removedToolCallIds = new Set<string>();
  const kept: T[] = [];
  for (const message of messages) {
    if (isManualRetryMarker(message)) {
      continue;
    }
    if (isFailedAssistant(message)) {
      for (const block of message.content) {
        if (block.type === "toolCall") {
          removedToolCallIds.add(block.id);
        }
      }
      continue;
    }
    if (message.role === "toolResult" && removedToolCallIds.has(message.toolCallId)) {
      continue;
    }
    kept.push(message);
  }
  return kept;
}

export function filterManualRetryCompactionPreparation(preparation: RetryFilterableCompactionPreparation): void {
  preparation.messagesToSummarize = filterManualRetryMessages(preparation.messagesToSummarize);
  preparation.turnPrefixMessages = filterManualRetryMessages(preparation.turnPrefixMessages);
}

export function matchesAutomaticRetryError(errorMessage: string | undefined): boolean {
  const trimmed = errorMessage?.trim();
  return !!trimmed && AUTOMATIC_RETRY_ERROR_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Retry is available from any settled, persisted, idle, queue-free state whose
 * provider-visible context (after retry filtering) still owes a model response.
 * The only refusals beyond those guards are a completed assistant response and
 * an assistant turn whose tool calls have no results.
 */
export function getManualRetryEligibility(context: ExtensionContext): ManualRetryEligibility {
  if (!supportsRetry(context)) {
    return unavailable("retry is supported only in TUI and RPC modes");
  }
  if (!context.isIdle()) {
    return unavailable("the agent is still active");
  }
  if (context.hasPendingMessages()) {
    return unavailable("steering or follow-up messages are pending");
  }
  if (!context.sessionManager.getSessionFile()) {
    return unavailable("the current session is not persisted");
  }
  if (!context.model) {
    return unavailable("no model is selected");
  }

  const contextEntries = context.sessionManager.buildContextEntries();
  const filteredTail = filterManualRetryMessages(contextEntries.flatMap(sessionEntryToContextMessages)).at(-1);
  if (!filteredTail) {
    return unavailable("the active context has nothing to send");
  }
  if (filteredTail.role === "assistant" && filteredTail.stopReason === "stop") {
    return unavailable("the latest assistant response completed; there is no failed or cancelled attempt to retry");
  }
  if (filteredTail.role === "assistant" && filteredTail.stopReason === "toolUse") {
    return unavailable("the latest assistant turn has tool calls without results");
  }

  const attempt = countRetryMarkers(context.sessionManager.getBranch()) + 1;
  const failed = findLatestContextEntry(contextEntries);
  if (failed?.type === "message" && failed.message.role === "assistant" && isFailedAssistant(failed.message)) {
    return {
      eligible: true,
      kind: failed.message.stopReason === "aborted" ? "aborted" : "error",
      attempt,
      errorMessage: failed.message.errorMessage,
      failedAssistant: failed.message,
      failedAssistantEntryId: failed.id,
      failedAt: failed.message.timestamp
    };
  }
  return { eligible: true, kind: "continuation", attempt };
}

export function handleManualRetryCommand(api: ExtensionAPI, args: string, context: ExtensionCommandContext): void {
  if (!supportsRetry(context)) {
    throw new Error("/retry is supported only in TUI and RPC modes; print and JSON commands cannot await ExtensionAPI.sendMessage");
  }
  if (args.trim()) {
    context.ui.notify("Usage: /retry", "warning");
    return;
  }

  const eligibility = getManualRetryEligibility(context);
  if (!eligibility.eligible) {
    context.ui.notify(`Retry unavailable: ${eligibility.reason}.`, "warning");
    return;
  }

  // Keep these final checks adjacent to sendMessage. There is no await between
  // them, so another task cannot enqueue work between validation and injection.
  if (!context.isIdle() || context.hasPendingMessages()) {
    context.ui.notify("Retry unavailable: the session stopped being idle or gained pending messages.", "warning");
    return;
  }

  try {
    // ExtensionAPI.sendMessage is fire-and-forget. This catch covers synchronous
    // stale-runtime failures; later run failures use Pi's normal error lifecycle.
    const details = dispatchRetryMarker(api, context, eligibility, "manual");
    context.ui.notify(
      `Retry attempt ${details.attempt}: resending the current context to ${details.provider}/${details.model} after ${describeRetryKind(details)}; the previous attempt remains in session history.`,
      "info"
    );
  } catch (error) {
    context.ui.notify(`Retry failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

/**
 * Bounded automatic retry for settled provider errors that Pi core did not
 * classify as transient but that match AUTOMATIC_RETRY_ERROR_PATTERNS. Runs
 * after agent_settled, so core's own auto-retry, compaction, and queued
 * continuations have already finished. Never retries cancellations.
 */
export async function runAutomaticRetry(
  api: ExtensionAPI,
  context: ExtensionContext,
  dependencies: ManualRetryDependencies = defaultDependencies
): Promise<AutomaticRetryOutcome> {
  const eligibility = getManualRetryEligibility(context);
  if (!eligibility.eligible) {
    return { status: "skipped", reason: eligibility.reason };
  }
  if (eligibility.kind !== "error" || !eligibility.failedAssistant) {
    return { status: "skipped", reason: "only settled provider errors are retried automatically" };
  }
  if (isRetryableAssistantError(eligibility.failedAssistant)) {
    return { status: "skipped", reason: "Pi core classifies this error as transient and already retried it" };
  }
  if (!matchesAutomaticRetryError(eligibility.errorMessage)) {
    return { status: "skipped", reason: "the error is not in the automatic retry list" };
  }

  const priorAttempts = countTrailingAutomaticRetries(context.sessionManager.buildContextEntries());
  if (priorAttempts >= AUTOMATIC_RETRY_MAX_ATTEMPTS) {
    context.ui.notify(
      `Automatic retry stopped after ${priorAttempts} attempts (last error: ${formatErrorMessage(eligibility.errorMessage)}). Use /retry to try again.`,
      "warning"
    );
    return { status: "exhausted", attempts: priorAttempts };
  }

  const delayMs = AUTOMATIC_RETRY_BASE_DELAY_MS * 2 ** priorAttempts;
  const leafBefore = context.sessionManager.getLeafId();
  context.ui.notify(
    `Automatic retry ${priorAttempts + 1}/${AUTOMATIC_RETRY_MAX_ATTEMPTS} in ${delayMs / 1000}s after error ${formatErrorMessage(eligibility.errorMessage)}.`,
    "info"
  );
  await dependencies.sleep(delayMs);

  if (!context.isIdle() || context.hasPendingMessages() || context.sessionManager.getLeafId() !== leafBefore) {
    return { status: "stale" };
  }
  const details = dispatchRetryMarker(api, context, eligibility, "automatic");
  return { status: "dispatched", attempt: details.attempt, delayMs };
}

function dispatchRetryMarker(
  api: ExtensionAPI,
  context: ExtensionContext,
  eligibility: Extract<ManualRetryEligibility, { eligible: true }>,
  trigger: RetryTrigger
): ManualRetryMarkerDetails {
  const model = context.model;
  if (!model) {
    throw new Error("no model is selected");
  }
  const details: ManualRetryMarkerDetails = {
    version: 2,
    attempt: eligibility.attempt,
    trigger,
    kind: eligibility.kind,
    errorMessage: eligibility.errorMessage,
    failedAssistantEntryId: eligibility.failedAssistantEntryId,
    failedAt: eligibility.failedAt,
    api: model.api,
    provider: model.provider,
    model: model.id,
    requestedAt: new Date().toISOString()
  };
  api.sendMessage(
    {
      customType: MANUAL_RETRY_MESSAGE_TYPE,
      content: [],
      display: false,
      details
    },
    { triggerTurn: true, deliverAs: "followUp" }
  );
  return details;
}

function describeRetryKind(details: ManualRetryMarkerDetails): string {
  switch (details.kind) {
    case "error":
      return `error ${formatErrorMessage(details.errorMessage)}`;
    case "aborted":
      return "a cancelled attempt";
    case "continuation":
      return "an unanswered context tail";
  }
}

function formatErrorMessage(errorMessage: string | undefined): string {
  return JSON.stringify(errorMessage ?? "unknown error");
}

function isManualRetryMarker(message: AgentMessage): boolean {
  return message.role === "custom" && message.customType === MANUAL_RETRY_MESSAGE_TYPE;
}

function isFailedAssistant(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");
}

function isMarkerEntry(entry: SessionEntry): boolean {
  return entry.type === "custom_message" && entry.customType === MANUAL_RETRY_MESSAGE_TYPE;
}

function isFailedAssistantEntry(entry: SessionEntry): boolean {
  return entry.type === "message" && entry.message.role === "assistant" && isFailedAssistant(entry.message);
}

/** The last entry that contributes provider-visible context, ignoring retry markers. */
function findLatestContextEntry(entries: SessionEntry[]): SessionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isMarkerEntry(entry)) {
      continue;
    }
    if (sessionEntryToContextMessages(entry).length > 0) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Count automatic retry markers in the trailing run of marker/failed-attempt
 * entries. Any other provider-visible entry or a manual marker ends the run, so
 * a new user message or an explicit /retry starts a fresh bounded chain.
 */
function countTrailingAutomaticRetries(entries: SessionEntry[]): number {
  let count = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (isMarkerEntry(entry)) {
      const details = entry.type === "custom_message" ? entry.details as Partial<ManualRetryMarkerDetails> | undefined : undefined;
      if (details?.trigger !== "automatic") {
        break;
      }
      count += 1;
      continue;
    }
    if (isFailedAssistantEntry(entry) || sessionEntryToContextMessages(entry).length === 0) {
      continue;
    }
    break;
  }
  return count;
}

function countRetryMarkers(entries: SessionEntry[]): number {
  return entries.filter(isMarkerEntry).length;
}

function supportsRetry(context: ExtensionContext): boolean {
  return context.mode === "tui" || context.mode === "rpc";
}

function unavailable(reason: string): ManualRetryEligibility {
  return { eligible: false, reason };
}
