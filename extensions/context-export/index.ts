import type {
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  copyToClipboard,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ToolInfo
} from "@earendil-works/pi-coding-agent";
import { filterManualRetryMessages } from "../manual-retry/index.js";

export const CONTEXT_COPY_COMMAND_NAME = "context:copy";
export const CONTEXT_COPY_MAX_BYTES = 4 * 1024 * 1024;
export const CONTEXT_COPY_FORMAT_VERSION = 1;

const REDACTED = "[REDACTED]";
const CONTEXT_COPY_KIND = "pi-current-context";
const SECRET_KEY_PATTERN = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|passwd|private[_-]?key|secret|token)(?:$|[_-])/i;
const SECRET_ENV_KEY_PATTERN = /(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|CREDENTIAL|PASSWORD|PASSWD|PRIVATE_KEY|SECRET|TOKEN)(?:$|_)/i;

export type ContextCopyMode = "redacted" | "raw";

export type ContextCopySnapshot = {
  kind: typeof CONTEXT_COPY_KIND;
  version: typeof CONTEXT_COPY_FORMAT_VERSION;
  mode: ContextCopyMode;
  scope: "active-compaction-aware";
  notice: string;
  privacy: string;
  session: {
    id: string;
    cwd: string;
    compacted: boolean;
    messageCount: number;
  };
  model: {
    api: string;
    provider: string;
    id: string;
    thinkingLevel: string;
  };
  contextUsage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
  systemPrompt: string;
  tools: Array<{
    name: string;
    description: string;
    parameters: unknown;
  }>;
  messages: unknown[];
};

export type ContextCopyHandlerOptions = {
  copy?: (text: string) => Promise<void>;
  maxBytes?: number;
  environment?: NodeJS.ProcessEnv;
};

type ParsedContextCopyArgs =
  | { kind: "copy"; mode: ContextCopyMode }
  | { kind: "help" }
  | { kind: "invalid" };

export default function contextExportExtension(api: ExtensionAPI): void {
  api.registerCommand(CONTEXT_COPY_COMMAND_NAME, {
    description: "Copy a provider-free snapshot of the active compaction-aware model context to the system clipboard",
    handler: async (args, context) => {
      await handleContextCopyCommand(api, args, context);
    }
  });
}

export function parseContextCopyArgs(args: string): ParsedContextCopyArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: "copy", mode: "redacted" };
  if (tokens.length === 1 && tokens[0] === "--raw") return { kind: "copy", mode: "raw" };
  if (tokens.length === 1 && (tokens[0] === "--help" || tokens[0] === "-h")) return { kind: "help" };
  return { kind: "invalid" };
}

export function buildContextCopyUsage(): string {
  return "Usage: /context:copy [--raw]";
}

export async function handleContextCopyCommand(
  api: ExtensionAPI,
  args: string,
  context: ExtensionCommandContext,
  options: ContextCopyHandlerOptions = {}
): Promise<void> {
  if (context.mode !== "tui") {
    context.ui.notify("/context:copy requires interactive Pi TUI mode.", "warning");
    return;
  }

  const parsed = parseContextCopyArgs(args);
  if (parsed.kind === "help") {
    context.ui.notify(
      `${buildContextCopyUsage()}\n\nThe default snapshot applies best-effort secret redaction and omits thinking, image data, and opaque signatures. --raw includes them after confirmation.`,
      "info"
    );
    return;
  }
  if (parsed.kind === "invalid") {
    context.ui.notify(buildContextCopyUsage(), "warning");
    return;
  }
  if (!context.model) {
    context.ui.notify("Context copy unavailable: no model is selected.", "warning");
    return;
  }
  if (!context.isIdle() || context.hasPendingMessages()) {
    context.ui.notify("Context copy unavailable: wait for the active run and queued messages to settle.", "warning");
    return;
  }

  if (parsed.mode === "raw") {
    const leafIdBeforeConfirmation = context.sessionManager.getLeafId();
    let confirmed: boolean;
    try {
      confirmed = await context.ui.confirm(
        "Copy raw model context?",
        "Raw mode may include secrets, hidden thinking, image data, and opaque provider signatures. Clipboard managers may retain it. Continue?"
      );
    } catch {
      context.ui.notify("Raw context copy cancelled.", "info");
      return;
    }
    if (!confirmed) {
      context.ui.notify("Raw context copy cancelled.", "info");
      return;
    }
    if (
      !context.isIdle() ||
      context.hasPendingMessages() ||
      context.sessionManager.getLeafId() !== leafIdBeforeConfirmation
    ) {
      context.ui.notify("Context copy cancelled because the session changed while confirmation was open.", "warning");
      return;
    }
  }

  try {
    const snapshot = buildContextCopySnapshot(api, context, parsed.mode, options.environment);
    const payload = serializeContextCopySnapshot(snapshot);
    const bytes = Buffer.byteLength(payload, "utf8");
    const maxBytes = options.maxBytes ?? CONTEXT_COPY_MAX_BYTES;
    if (bytes > maxBytes) {
      context.ui.notify(
        `Context copy failed: ${formatBytes(bytes)} exceeds the ${formatBytes(maxBytes)} clipboard export limit; nothing was copied.`,
        "error"
      );
      return;
    }

    await (options.copy ?? copyToClipboard)(payload);
    const privacyNote = parsed.mode === "raw"
      ? "Raw content may be retained by clipboard managers."
      : "Redaction is best-effort; review before sharing.";
    context.ui.notify(
      `Copied ${parsed.mode} active context (${snapshot.session.messageCount} messages, ${formatBytes(bytes)}) to the clipboard. ${privacyNote}`,
      "info"
    );
  } catch (error) {
    context.ui.notify(`Context copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

export function buildContextCopySnapshot(
  api: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getThinkingLevel">,
  context: Pick<
    ExtensionCommandContext,
    "cwd" | "sessionManager" | "model" | "getContextUsage" | "getSystemPrompt"
  >,
  mode: ContextCopyMode,
  environment: NodeJS.ProcessEnv = process.env
): ContextCopySnapshot {
  if (!context.model) throw new Error("no model is selected");

  const contextEntries = context.sessionManager.buildContextEntries();
  const agentMessages = contextEntries.flatMap(sessionEntryToContextMessages);
  const filteredMessages = filterManualRetryMessages(agentMessages);
  const messages = convertToLlm(filteredMessages);
  const environmentSecrets = mode === "raw" ? [] : collectEnvironmentSecrets(environment);
  const tools = getActiveToolInfo(api).map((tool) => projectTool(tool, mode, environmentSecrets));
  const projectedMessages = messages.map((message) => projectMessage(message, mode, environmentSecrets));

  return {
    kind: CONTEXT_COPY_KIND,
    version: CONTEXT_COPY_FORMAT_VERSION,
    mode,
    scope: "active-compaction-aware",
    notice: "This is Pi's active, compaction-aware context before provider-specific serialization; it is not an exact provider HTTP request body. Provider adapters and other context extensions may transform it further.",
    privacy: mode === "raw"
      ? "Raw export: secrets, hidden thinking, image data, and opaque signatures may be present. Clipboard managers may retain this content."
      : "Best-effort redaction: likely secrets are masked; hidden thinking, image data, and opaque signatures are omitted. Review before sharing.",
    session: {
      id: context.sessionManager.getSessionId(),
      cwd: context.cwd,
      compacted: contextEntries.some((entry) => entry.type === "compaction"),
      messageCount: projectedMessages.length
    },
    model: projectModel(context.model, api.getThinkingLevel()),
    contextUsage: context.getContextUsage() ?? null,
    systemPrompt: mode === "raw" ? context.getSystemPrompt() : redactSensitiveText(context.getSystemPrompt(), environmentSecrets),
    tools,
    messages: projectedMessages
  };
}

export function serializeContextCopySnapshot(snapshot: ContextCopySnapshot): string {
  return `${JSON.stringify(toStableJson(snapshot), null, 2)}\n`;
}

export function redactSensitiveText(text: string, environmentSecrets: readonly string[] = []): string {
  let redacted = text;
  for (const secret of environmentSecrets) {
    if (secret.length >= 8) redacted = redacted.split(secret).join(REDACTED);
  }

  redacted = redacted.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    REDACTED
  );
  redacted = redacted.replace(/\b(Bearer|Basic)[ \t]+[A-Za-z0-9+/_=.-]{8,}/gi, "$1 [REDACTED]");
  redacted = redacted.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    REDACTED
  );
  redacted = redacted.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/]+:)[^\s@/]+@/gi, "$1[REDACTED]@");
  redacted = redacted.replace(
    /((?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|passwd|private[_-]?key|secret|token)["']?\s*[:=]\s*)(["'])([^\r\n]*?)\2/gi,
    "$1$2[REDACTED]$2"
  );
  redacted = redacted.replace(
    /((?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|passwd|private[_-]?key|secret|token)["']?\s*[:=]\s*)(?!Bearer\b|Basic\b)([^\s"',;}]+)/gi,
    "$1[REDACTED]"
  );
  return redacted;
}

function collectEnvironmentSecrets(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment)
    .filter(([key, value]) => SECRET_ENV_KEY_PATTERN.test(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function getActiveToolInfo(api: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">): ToolInfo[] {
  const byName = new Map(api.getAllTools().map((tool) => [tool.name, tool]));
  return api.getActiveTools().map((name) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`active tool metadata is unavailable for ${name}`);
    return tool;
  });
}

function projectTool(tool: ToolInfo, mode: ContextCopyMode, environmentSecrets: readonly string[]) {
  return {
    name: tool.name,
    description: mode === "raw" ? tool.description : redactSensitiveText(tool.description, environmentSecrets),
    parameters: tool.parameters
  };
}

function projectModel(model: Model<any>, thinkingLevel: string) {
  return {
    api: model.api,
    provider: model.provider,
    id: model.id,
    thinkingLevel
  };
}

function projectMessage(message: Message, mode: ContextCopyMode, environmentSecrets: readonly string[]): unknown {
  switch (message.role) {
    case "user":
      return projectUserMessage(message, mode, environmentSecrets);
    case "assistant":
      return projectAssistantMessage(message, mode, environmentSecrets);
    case "toolResult":
      return projectToolResultMessage(message, mode, environmentSecrets);
    default: {
      const unsupported: never = message;
      throw new Error(`unsupported context message role: ${String((unsupported as { role?: unknown }).role)}`);
    }
  }
}

function projectUserMessage(message: UserMessage, mode: ContextCopyMode, environmentSecrets: readonly string[]) {
  return {
    role: message.role,
    content: projectUserContent(message.content, mode, environmentSecrets),
    timestamp: message.timestamp
  };
}

function projectAssistantMessage(
  message: AssistantMessage,
  mode: ContextCopyMode,
  environmentSecrets: readonly string[]
) {
  const result: Record<string, unknown> = {
    role: message.role,
    content: message.content.map((content) => projectAssistantContent(content, mode, environmentSecrets)),
    api: message.api,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    timestamp: message.timestamp
  };
  if (message.responseModel !== undefined) result.responseModel = message.responseModel;
  if (message.responseId !== undefined) result.responseId = mode === "raw" ? message.responseId : REDACTED;
  if (message.errorMessage !== undefined) {
    result.errorMessage = mode === "raw" ? message.errorMessage : redactSensitiveText(message.errorMessage, environmentSecrets);
  }
  return result;
}

function projectToolResultMessage(
  message: ToolResultMessage,
  mode: ContextCopyMode,
  environmentSecrets: readonly string[]
) {
  const result: Record<string, unknown> = {
    role: message.role,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content.map((content) => projectTextOrImage(content, mode, environmentSecrets)),
    isError: message.isError,
    timestamp: message.timestamp
  };
  if (message.addedToolNames !== undefined) result.addedToolNames = message.addedToolNames;
  return result;
}

function projectUserContent(
  content: UserMessage["content"],
  mode: ContextCopyMode,
  environmentSecrets: readonly string[]
): unknown {
  if (typeof content === "string") {
    return mode === "raw" ? content : redactSensitiveText(content, environmentSecrets);
  }
  return content.map((item) => projectTextOrImage(item, mode, environmentSecrets));
}

function projectAssistantContent(
  content: TextContent | ThinkingContent | ToolCall,
  mode: ContextCopyMode,
  environmentSecrets: readonly string[]
): unknown {
  if (content.type === "text") return projectText(content, mode, environmentSecrets);
  if (content.type === "thinking") {
    if (mode === "raw") return content;
    return {
      type: "thinking",
      omitted: true,
      characters: content.thinking.length,
      redactedByProvider: content.redacted === true
    };
  }

  const result: Record<string, unknown> = {
    type: "toolCall",
    id: content.id,
    name: content.name,
    arguments: mode === "raw" ? content.arguments : redactUnknown(content.arguments, environmentSecrets)
  };
  if (content.thoughtSignature !== undefined) {
    result.thoughtSignature = mode === "raw" ? content.thoughtSignature : REDACTED;
  }
  return result;
}

function projectTextOrImage(
  content: TextContent | ImageContent,
  mode: ContextCopyMode,
  environmentSecrets: readonly string[]
): unknown {
  return content.type === "text"
    ? projectText(content, mode, environmentSecrets)
    : projectImage(content, mode);
}

function projectText(content: TextContent, mode: ContextCopyMode, environmentSecrets: readonly string[]) {
  const result: Record<string, unknown> = {
    type: "text",
    text: mode === "raw" ? content.text : redactSensitiveText(content.text, environmentSecrets)
  };
  if (content.textSignature !== undefined) {
    result.textSignature = mode === "raw" ? content.textSignature : REDACTED;
  }
  return result;
}

function projectImage(content: ImageContent, mode: ContextCopyMode) {
  if (mode === "raw") return content;
  return {
    type: "image",
    mimeType: content.mimeType,
    omitted: true,
    base64Characters: content.data.length
  };
}

function redactUnknown(value: unknown, environmentSecrets: readonly string[], key?: string): unknown {
  if (key && SECRET_KEY_PATTERN.test(key)) return REDACTED;
  if (typeof value === "string") return redactSensitiveText(value, environmentSecrets);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, environmentSecrets));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactUnknown(entryValue, environmentSecrets, entryKey)])
  );
}

function toStableJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) throw new Error("context snapshot contains a circular value");

  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => toStableJson(item, seen));
    seen.delete(value);
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const projected = toStableJson((value as Record<string, unknown>)[key], seen);
    if (projected !== undefined) result[key] = projected;
  }
  seen.delete(value);
  return result;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
