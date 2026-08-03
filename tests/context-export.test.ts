import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ToolInfo
} from "@earendil-works/pi-coding-agent";
import contextExportExtension, {
  buildContextCopySnapshot,
  CONTEXT_COPY_COMMAND_NAME,
  handleContextCopyCommand,
  parseContextCopyArgs,
  redactSensitiveText,
  serializeContextCopySnapshot
} from "../extensions/context-export/index.js";

type Notification = { message: string; type: string | undefined };
type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;

type FakeApi = {
  api: ExtensionAPI;
  commands: Map<string, CommandHandler>;
};

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

function model(): Model<any> {
  return {
    id: "claude-test",
    name: "Claude test",
    api: "anthropic-messages",
    provider: "anthropic",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192
  } as Model<any>;
}

function tool(name = "read_many"): ToolInfo {
  return {
    name,
    description: `Use ${name}`,
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "A schema field named token" },
        path: { type: "string" }
      },
      required: ["path"]
    },
    sourceInfo: { path: `/extensions/${name}.ts`, kind: "extension" }
  } as unknown as ToolInfo;
}

function createFakeApi(tools: ToolInfo[] = [tool()]): FakeApi {
  const commands = new Map<string, CommandHandler>();
  const api = {
    registerCommand(name: string, options: { handler: CommandHandler }): void {
      commands.set(name, options.handler);
    },
    getActiveTools(): string[] {
      return tools.map((item) => item.name);
    },
    getAllTools(): ToolInfo[] {
      return tools;
    },
    getThinkingLevel(): "high" {
      return "high";
    }
  } as unknown as ExtensionAPI;
  return { api, commands };
}

function createContext(options: {
  sessionManager?: SessionManager;
  mode?: "tui" | "rpc" | "json" | "print";
  idle?: () => boolean;
  pending?: () => boolean;
  confirm?: () => Promise<boolean>;
  systemPrompt?: string;
  selectedModel?: Model<any> | null;
} = {}) {
  const sessionManager = options.sessionManager ?? SessionManager.inMemory("/context-copy-test");
  const notifications: Notification[] = [];
  const context = {
    mode: options.mode ?? "tui",
    hasUI: options.mode === undefined || options.mode === "tui" || options.mode === "rpc",
    cwd: sessionManager.getCwd(),
    sessionManager,
    model: options.selectedModel === null ? undefined : options.selectedModel ?? model(),
    isIdle: options.idle ?? (() => true),
    hasPendingMessages: options.pending ?? (() => false),
    getContextUsage: () => ({ tokens: 123, contextWindow: 200_000, percent: 0.0615 }),
    getSystemPrompt: () => options.systemPrompt ?? "System prompt",
    ui: {
      notify(message: string, type?: string): void {
        notifications.push({ message, type });
      },
      confirm: options.confirm ?? (async () => true)
    }
  } as unknown as ExtensionCommandContext;
  return { context, notifications, sessionManager };
}

function assistant(options: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage,
    stopReason: "stop",
    timestamp: 2,
    ...options
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

test("context export registers /context:copy and parses its intentionally small surface", () => {
  const fake = createFakeApi();
  contextExportExtension(fake.api);

  assert.ok(fake.commands.has(CONTEXT_COPY_COMMAND_NAME));
  assert.deepEqual(parseContextCopyArgs(""), { kind: "copy", mode: "redacted" });
  assert.deepEqual(parseContextCopyArgs(" --raw "), { kind: "copy", mode: "raw" });
  assert.deepEqual(parseContextCopyArgs("--help"), { kind: "help" });
  assert.deepEqual(parseContextCopyArgs("--raw extra"), { kind: "invalid" });
});

test("redacted snapshot includes active prompt, tools, messages, and safe placeholders without mutating schemas", () => {
  const sessionManager = SessionManager.inMemory("/context-copy-test");
  const secret = "environment-secret-value";
  const user: UserMessage = {
    role: "user",
    content: [
      { type: "text", text: `Please use api_key=${secret}` },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" }
    ],
    timestamp: 1
  };
  sessionManager.appendMessage(user);
  sessionManager.appendMessage(assistant({
    responseId: "opaque-response-id",
    content: [
      { type: "text", text: `Observed ${secret}`, textSignature: "text-signature" },
      { type: "thinking", thinking: "private reasoning", thinkingSignature: "thinking-signature" },
      {
        type: "toolCall",
        id: "call-1",
        name: "read_many",
        arguments: { path: "/tmp/file", api_key: secret, nested: { password: "hunter-secret" } },
        thoughtSignature: "thought-signature"
      }
    ]
  }));
  const toolResult: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read_many",
    content: [{ type: "text", text: "Authorization: Bearer abcdefghijklmnop" }],
    details: { internalSecret: secret },
    isError: false,
    timestamp: 3
  };
  sessionManager.appendMessage(toolResult);

  const fake = createFakeApi();
  const { context } = createContext({ sessionManager, systemPrompt: `System ${secret}` });
  const snapshot = buildContextCopySnapshot(fake.api, context, "redacted", { TEST_API_KEY: secret });

  assert.equal(snapshot.scope, "active-compaction-aware");
  assert.equal(snapshot.systemPrompt, "System [REDACTED]");
  assert.equal(snapshot.model.thinkingLevel, "high");
  assert.equal(snapshot.session.messageCount, 3);
  assert.equal(snapshot.session.compacted, false);
  assert.match(snapshot.notice, /not an exact provider HTTP request body/);

  const schema = asRecord(snapshot.tools[0]?.parameters);
  assert.ok(asRecord(asRecord(schema.properties).token), "tool schema keys must not be secret-redacted");

  const projectedUser = asRecord(snapshot.messages[0]);
  const userContent = asArray(projectedUser.content);
  assert.match(String(asRecord(userContent[0]).text), /\[REDACTED\]/);
  assert.deepEqual(asRecord(userContent[1]), {
    type: "image",
    mimeType: "image/png",
    omitted: true,
    base64Characters: 8
  });

  const projectedAssistant = asRecord(snapshot.messages[1]);
  assert.equal(projectedAssistant.responseId, "[REDACTED]");
  const assistantContent = asArray(projectedAssistant.content);
  assert.equal(asRecord(assistantContent[0]).textSignature, "[REDACTED]");
  assert.deepEqual(asRecord(assistantContent[1]), {
    type: "thinking",
    omitted: true,
    characters: 17,
    redactedByProvider: false
  });
  const projectedCall = asRecord(assistantContent[2]);
  assert.equal(projectedCall.thoughtSignature, "[REDACTED]");
  const arguments_ = asRecord(projectedCall.arguments);
  assert.equal(arguments_.api_key, "[REDACTED]");
  assert.equal(asRecord(arguments_.nested).password, "[REDACTED]");

  const projectedResult = asRecord(snapshot.messages[2]);
  assert.equal(projectedResult.details, undefined, "internal-only tool details must not enter the snapshot");
  assert.match(String(asRecord(asArray(projectedResult.content)[0]).text), /Bearer \[REDACTED\]/);
});

test("raw snapshot preserves thinking, images, signatures, and text after explicit mode selection", () => {
  const sessionManager = SessionManager.inMemory("/context-copy-test");
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "image", mimeType: "image/png", data: "raw-image-data" }],
    timestamp: 1
  });
  sessionManager.appendMessage(assistant({
    responseId: "raw-response-id",
    content: [{ type: "thinking", thinking: "raw thinking", thinkingSignature: "raw-signature" }]
  }));
  const fake = createFakeApi();
  const { context } = createContext({ sessionManager, systemPrompt: "api_key=raw-secret" });

  const snapshot = buildContextCopySnapshot(fake.api, context, "raw", { TEST_API_KEY: "raw-secret" });
  assert.equal(snapshot.systemPrompt, "api_key=raw-secret");
  assert.equal(asRecord(snapshot.messages[1]).responseId, "raw-response-id");
  assert.equal(asRecord(asArray(asRecord(snapshot.messages[0]).content)[0]).data, "raw-image-data");
  assert.equal(asRecord(asArray(asRecord(snapshot.messages[1]).content)[0]).thinking, "raw thinking");
});

test("snapshot uses the active compaction-aware branch and filters manual retry artifacts", () => {
  const sessionManager = SessionManager.inMemory("/context-copy-test");
  sessionManager.appendMessage({ role: "user", content: "old user", timestamp: 1 });
  sessionManager.appendMessage(assistant({ content: [{ type: "text", text: "old assistant" }] }));
  const firstKeptEntryId = sessionManager.appendMessage({ role: "user", content: "kept user", timestamp: 3 });
  sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "temporary failure", timestamp: 4 }));
  sessionManager.appendCustomMessageEntry("manual-provider-retry", [], false, { version: 1 });
  sessionManager.appendCustomMessageEntry("visible-custom-context", "custom context", false);
  sessionManager.appendCompaction("durable compacted summary", firstKeptEntryId, 10_000);

  const fake = createFakeApi([]);
  const { context } = createContext({ sessionManager });
  const snapshot = buildContextCopySnapshot(fake.api, context, "redacted", {});
  const serialized = serializeContextCopySnapshot(snapshot);

  assert.equal(snapshot.session.compacted, true);
  assert.equal(snapshot.session.messageCount, 3);
  assert.match(serialized, /durable compacted summary/);
  assert.match(serialized, /kept user/);
  assert.match(serialized, /custom context/);
  assert.doesNotMatch(serialized, /old user|old assistant|temporary failure|manual-provider-retry/);
});

test("snapshot serialization is stable and newline-terminated", () => {
  const fake = createFakeApi([tool("z_tool"), tool("a_tool")]);
  const { context } = createContext();
  const snapshot = buildContextCopySnapshot(fake.api, context, "redacted", {});

  const first = serializeContextCopySnapshot(snapshot);
  const second = serializeContextCopySnapshot(snapshot);
  assert.equal(first, second);
  assert.ok(first.endsWith("\n"));
  assert.deepEqual((JSON.parse(first) as { tools: Array<{ name: string }> }).tools.map((item) => item.name), ["z_tool", "a_tool"]);
});

test("redaction covers environment values, private keys, credentials, and common token forms", () => {
  const input = [
    "secret-from-env",
    "Authorization: Bearer abcdefghijklmnop",
    "authorization: bare-authorization-secret",
    "auth=another-authorization-secret",
    "Bearer\nshould-not-be-consumed",
    "https://user:password-value@example.com/path",
    "github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "password=hunter-secret",
    "api_key=\"secret value with spaces\"",
    "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----"
  ].join("\n");
  const redacted = redactSensitiveText(input, ["secret-from-env"]);

  assert.doesNotMatch(redacted, /secret-from-env|abcdefghijklmnop|bare-authorization-secret|another-authorization-secret|password-value|abcdefghijklmnopqrstuvwxyz123456|hunter-secret|secret value with spaces|private-material/);
  assert.match(redacted, /Bearer\nshould-not-be-consumed/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("command is TUI-only, idle-only, and queue-free without touching session state", async () => {
  for (const options of [
    { mode: "rpc" as const },
    { idle: () => false },
    { pending: () => true },
    { selectedModel: null }
  ]) {
    const fake = createFakeApi();
    const { context, notifications, sessionManager } = createContext(options);
    const entriesBefore = sessionManager.getEntries();
    let copied = false;

    await handleContextCopyCommand(fake.api, "", context, { copy: async () => { copied = true; } });

    assert.equal(copied, false);
    assert.deepEqual(sessionManager.getEntries(), entriesBefore);
    assert.equal(notifications.at(-1)?.type, "warning");
  }
});

test("empty-session redacted copy succeeds without provider or session injection", async () => {
  const fake = createFakeApi([]);
  const { context, notifications, sessionManager } = createContext();
  let clipboard = "";

  await handleContextCopyCommand(fake.api, "", context, { copy: async (text) => { clipboard = text; } });

  assert.equal(sessionManager.getEntries().length, 0);
  assert.equal((JSON.parse(clipboard) as { session: { messageCount: number } }).session.messageCount, 0);
  assert.match(notifications.at(-1)?.message ?? "", /Copied redacted active context/);
});

test("raw confirmation cancellation and a state change during confirmation copy nothing", async () => {
  const fake = createFakeApi();
  let copied = false;
  const cancelled = createContext({ confirm: async () => false });
  await handleContextCopyCommand(fake.api, "--raw", cancelled.context, { copy: async () => { copied = true; } });
  assert.equal(copied, false);
  assert.match(cancelled.notifications.at(-1)?.message ?? "", /cancelled/);

  const interrupted = createContext({ confirm: async () => { throw new Error("dialog interrupted"); } });
  await handleContextCopyCommand(fake.api, "--raw", interrupted.context, { copy: async () => { copied = true; } });
  assert.equal(copied, false);
  assert.match(interrupted.notifications.at(-1)?.message ?? "", /cancelled/);

  let pending = false;
  const changed = createContext({
    pending: () => pending,
    confirm: async () => {
      pending = true;
      return true;
    }
  });
  await handleContextCopyCommand(fake.api, "--raw", changed.context, { copy: async () => { copied = true; } });
  assert.equal(copied, false);
  assert.match(changed.notifications.at(-1)?.message ?? "", /session changed/);

  const completedTurnSession = SessionManager.inMemory("/context-copy-confirmation-test");
  const completedTurn = createContext({
    sessionManager: completedTurnSession,
    confirm: async () => {
      completedTurnSession.appendMessage({ role: "user", content: "arrived while confirming", timestamp: 10 });
      return true;
    }
  });
  await handleContextCopyCommand(fake.api, "--raw", completedTurn.context, { copy: async () => { copied = true; } });
  assert.equal(copied, false);
  assert.match(completedTurn.notifications.at(-1)?.message ?? "", /session changed/);
});

test("oversized and clipboard-failure paths fail loudly without claiming success", async () => {
  const fake = createFakeApi();
  const oversized = createContext({ systemPrompt: "large prompt" });
  let copied = false;
  await handleContextCopyCommand(fake.api, "", oversized.context, {
    maxBytes: 1,
    copy: async () => { copied = true; }
  });
  assert.equal(copied, false);
  assert.match(oversized.notifications.at(-1)?.message ?? "", /exceeds.*nothing was copied/);
  assert.equal(oversized.notifications.at(-1)?.type, "error");

  const failed = createContext();
  await handleContextCopyCommand(fake.api, "", failed.context, {
    copy: async () => { throw new Error("clipboard unavailable"); }
  });
  assert.match(failed.notifications.at(-1)?.message ?? "", /clipboard unavailable/);
  assert.equal(failed.notifications.at(-1)?.type, "error");
});
