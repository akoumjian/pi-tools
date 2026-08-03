import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
  type SessionMessageEntry
} from "@earendil-works/pi-coding-agent";

export const MANUAL_RETRY_COMMAND_NAME = "retry";
export const MANUAL_RETRY_MESSAGE_TYPE = "manual-provider-retry";

export type ManualRetryMarkerDetails = {
  version: 1;
  attempt: number;
  failedAssistantEntryId: string;
  api: string;
  provider: string;
  model: string;
  failedAt: number;
  requestedAt: string;
};

export type ManualRetryEligibility =
  | {
    eligible: true;
    failedAssistant: AssistantMessage;
    failedAssistantEntryId: string;
    attempt: number;
  }
  | {
    eligible: false;
    reason: string;
  };

type RetryFilterableCompactionPreparation = {
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
};

export default function manualRetryExtension(api: ExtensionAPI): void {
  api.on("context", (event) => {
    const messages = filterManualRetryMessages(event.messages);
    return messages.length === event.messages.length ? undefined : { messages };
  });

  // This extension must load before Compacter so every summarizer sees the same
  // provider-safe message set as the main request path.
  api.on("session_before_compact", (event) => {
    filterManualRetryCompactionPreparation(event.preparation);
  });

  api.registerCommand(MANUAL_RETRY_COMMAND_NAME, {
    description: "Retry the latest settled transient provider failure without adding another user message",
    handler: async (args, context) => {
      handleManualRetryCommand(api, args, context);
    }
  });
}

export function filterManualRetryMessages<T extends AgentMessage>(messages: readonly T[]): T[] {
  return messages.filter((message) => !isManualRetryMarker(message) && !isFailedAssistant(message));
}

export function filterManualRetryCompactionPreparation(preparation: RetryFilterableCompactionPreparation): void {
  preparation.messagesToSummarize = filterManualRetryMessages(preparation.messagesToSummarize);
  preparation.turnPrefixMessages = filterManualRetryMessages(preparation.turnPrefixMessages);
}

export function getManualRetryEligibility(context: ExtensionCommandContext): ManualRetryEligibility {
  if (!supportsManualRetry(context)) {
    return unavailable("manual retry is supported only in TUI and RPC modes");
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
  const contextMessages = contextEntries.flatMap(sessionEntryToContextMessages);
  const terminalMessage = contextMessages.filter((message) => !isManualRetryMarker(message)).at(-1);
  if (!terminalMessage || terminalMessage.role !== "assistant") {
    return unavailable("the active context does not end in an assistant failure");
  }
  if (terminalMessage.stopReason === "aborted") {
    return unavailable("the latest assistant attempt was cancelled, not a retryable provider failure");
  }
  if (!isRetryableAssistantError(terminalMessage)) {
    return unavailable("the latest assistant error is not classified as transient and retryable");
  }
  if (
    terminalMessage.api !== context.model.api ||
    terminalMessage.provider !== context.model.provider ||
    terminalMessage.model !== context.model.id
  ) {
    return unavailable("the selected provider, API, or model changed after the failed attempt");
  }

  const branch = context.sessionManager.getBranch();
  const failedEntryIndex = findAssistantEntryIndex(branch, terminalMessage);
  if (failedEntryIndex < 0) {
    return unavailable("the failed assistant entry is not recoverable from the active branch");
  }

  for (const entry of branch.slice(failedEntryIndex + 1)) {
    const changeReason = retryIdentityChangeReason(entry);
    if (changeReason) {
      return unavailable(changeReason);
    }
  }

  const failedEntry = branch[failedEntryIndex] as SessionMessageEntry;
  return {
    eligible: true,
    failedAssistant: terminalMessage,
    failedAssistantEntryId: failedEntry.id,
    attempt: countRetryMarkers(branch) + 1
  };
}

export function handleManualRetryCommand(api: ExtensionAPI, args: string, context: ExtensionCommandContext): void {
  if (!supportsManualRetry(context)) {
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

  const details: ManualRetryMarkerDetails = {
    version: 1,
    attempt: eligibility.attempt,
    failedAssistantEntryId: eligibility.failedAssistantEntryId,
    api: eligibility.failedAssistant.api,
    provider: eligibility.failedAssistant.provider,
    model: eligibility.failedAssistant.model,
    failedAt: eligibility.failedAssistant.timestamp,
    requestedAt: new Date().toISOString()
  };

  try {
    // ExtensionAPI.sendMessage is fire-and-forget. This catch covers synchronous
    // stale-runtime failures; later run failures use Pi's normal error lifecycle.
    api.sendMessage(
      {
        customType: MANUAL_RETRY_MESSAGE_TYPE,
        content: [],
        display: false,
        details
      },
      { triggerTurn: true, deliverAs: "followUp" }
    );
    context.ui.notify(`Manual retry attempt ${details.attempt} requested; the failed attempt remains in session history.`, "info");
  } catch (error) {
    context.ui.notify(`Retry failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function isManualRetryMarker(message: AgentMessage): boolean {
  return message.role === "custom" && message.customType === MANUAL_RETRY_MESSAGE_TYPE;
}

function isFailedAssistant(message: AgentMessage): boolean {
  return message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");
}

function findAssistantEntryIndex(entries: SessionEntry[], assistant: AssistantMessage): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    if (
      entry.message === assistant ||
      (
        entry.message.timestamp === assistant.timestamp &&
        entry.message.api === assistant.api &&
        entry.message.provider === assistant.provider &&
        entry.message.model === assistant.model &&
        entry.message.stopReason === assistant.stopReason &&
        entry.message.errorMessage === assistant.errorMessage
      )
    ) {
      return index;
    }
  }
  return -1;
}

function retryIdentityChangeReason(entry: SessionEntry): string | undefined {
  switch (entry.type) {
    case "model_change":
      return "the selected model changed after the failed attempt";
    case "thinking_level_change":
      return "the thinking level changed after the failed attempt";
    case "compaction":
      return "the session was compacted after the failed attempt";
    case "branch_summary":
      return "the active branch changed after the failed attempt";
    case "custom_message":
      return entry.customType === MANUAL_RETRY_MESSAGE_TYPE
        ? "a previous retry marker has no completed assistant attempt"
        : "new provider-visible context was added after the failed attempt";
    case "message":
      return "new provider-visible context was added after the failed attempt";
    case "custom":
    case "label":
    case "session_info":
      return undefined;
    default:
      return "unrecognized session state was added after the failed attempt";
  }
}

function countRetryMarkers(entries: SessionEntry[]): number {
  return entries.filter((entry) => entry.type === "custom_message" && entry.customType === MANUAL_RETRY_MESSAGE_TYPE).length;
}

function supportsManualRetry(context: ExtensionCommandContext): boolean {
  return context.mode === "tui" || context.mode === "rpc";
}

function unavailable(reason: string): ManualRetryEligibility {
  return { eligible: false, reason };
}
