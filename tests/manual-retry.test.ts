import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Message, Model, UserMessage } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAICodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as streamPiMessages } from "@earendil-works/pi-ai/api/pi-messages";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
  SessionManager,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionBeforeCompactEvent
} from "@earendil-works/pi-coding-agent";
import manualRetryExtension, {
  filterManualRetryMessages,
  getManualRetryEligibility,
  MANUAL_RETRY_COMMAND_NAME,
  MANUAL_RETRY_MESSAGE_TYPE,
  type ManualRetryMarkerDetails
} from "../extensions/manual-retry/index.js";

type EventHandler = (event: unknown, context: unknown) => unknown | Promise<unknown>;
type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;
type SentMessage = {
  message: {
    customType: string;
    content: unknown;
    display: boolean;
    details?: unknown;
  };
  options?: {
    triggerTurn?: boolean;
    deliverAs?: "steer" | "followUp" | "nextTurn";
  };
};

type FakeApi = {
  api: ExtensionAPI;
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, CommandHandler>;
  sentMessages: SentMessage[];
};

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

function assistant(options: {
  stopReason: AssistantMessage["stopReason"];
  errorMessage?: string;
  timestamp?: number;
  provider?: string;
  model?: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: options.provider ?? "anthropic",
    model: options.model ?? "claude-sonnet-4-5",
    usage,
    stopReason: options.stopReason,
    errorMessage: options.errorMessage,
    timestamp: options.timestamp ?? Date.now()
  };
}

function user(text = "Original request", timestamp = Date.now() - 1): UserMessage {
  return { role: "user", content: text, timestamp };
}

function marker(attempt = 1, timestamp = Date.now()): AgentMessage {
  return {
    role: "custom",
    customType: MANUAL_RETRY_MESSAGE_TYPE,
    content: [],
    display: false,
    details: { version: 1, attempt },
    timestamp
  };
}

function fakeModel(provider = "anthropic", id = "claude-sonnet-4-5", api = "anthropic-messages"): Model<any> {
  return { api, provider, id } as Model<any>;
}

function createFakeApi(onSend?: (message: SentMessage["message"]) => void): FakeApi {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const sentMessages: SentMessage[] = [];
  const api = {
    on(event: string, handler: EventHandler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: CommandHandler }): void {
      commands.set(name, options.handler);
    },
    sendMessage(message: SentMessage["message"], options?: SentMessage["options"]): void {
      sentMessages.push({ message, options });
      onSend?.(message);
    }
  } as unknown as ExtensionAPI;
  return { api, handlers, commands, sentMessages };
}

function commandContext(options: {
  sessionManager: SessionManager;
  idle?: boolean;
  pending?: boolean;
  model?: Model<any>;
  mode?: "tui" | "rpc" | "json" | "print";
}) {
  const notifications: Array<{ message: string; type: string }> = [];
  const context = {
    mode: options.mode ?? "tui",
    hasUI: true,
    cwd: options.sessionManager.getCwd(),
    sessionManager: options.sessionManager,
    model: options.model ?? fakeModel(),
    isIdle: () => options.idle ?? true,
    hasPendingMessages: () => options.pending ?? false,
    ui: {
      notify(message: string, type: string): void {
        notifications.push({ message, type });
      }
    }
  } as unknown as ExtensionCommandContext;
  return { context, notifications };
}

async function withSession(run: (sessionManager: SessionManager, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "manual-retry-"));
  try {
    await run(SessionManager.create("/retry-test", directory), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function emit(fake: FakeApi, event: string, data: unknown, context: unknown): Promise<unknown> {
  let result: unknown;
  for (const handler of fake.handlers.get(event) ?? []) {
    result = await handler(data, context);
  }
  return result;
}

async function captureAnthropicPayload(context: Context): Promise<unknown> {
  const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  let payload: unknown;
  const controller = new AbortController();
  const stream = streamAnthropic(model, context, {
    apiKey: "fixture-api-key",
    signal: controller.signal,
    maxRetries: 0,
    onPayload(candidate) {
      payload = candidate;
      controller.abort();
    }
  });
  for await (const _event of stream) {
    // onPayload aborts before network I/O; consume the terminal event.
  }
  assert.ok(payload);
  return payload;
}

async function capturePiMessagesPayload(context: Context): Promise<unknown> {
  const model: Model<"pi-messages"> = {
    id: "retry-fixture",
    name: "Retry fixture",
    api: "pi-messages",
    provider: "retry-fixture",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 1_000
  };
  let payload: unknown;
  const controller = new AbortController();
  const stream = streamPiMessages(model, context, {
    apiKey: "fixture-api-key",
    signal: controller.signal,
    maxRetries: 0,
    onPayload(candidate) {
      payload = candidate;
      controller.abort();
    }
  });
  for await (const _event of stream) {
    // onPayload aborts before network I/O; consume the terminal event.
  }
  assert.ok(payload);
  return payload;
}

async function captureOpenAIPayload(context: Context): Promise<unknown> {
  const model = getBuiltinModel("openai-codex", "gpt-5.5");
  assert.ok(model);
  const fakeJwt = [
    "e30",
    Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" } })).toString("base64url"),
    "fixture-signature"
  ].join(".");
  let payload: unknown;
  const controller = new AbortController();
  const stream = streamOpenAICodexResponses(model, context, {
    apiKey: fakeJwt,
    signal: controller.signal,
    maxRetries: 0,
    transport: "sse",
    onPayload(candidate) {
      payload = candidate;
      controller.abort();
    }
  });
  for await (const _event of stream) {
    // onPayload aborts before network I/O; consume the terminal event.
  }
  assert.ok(payload);
  return payload;
}

test("manual retry context filtering removes markers and failed attempts without mutating history", () => {
  const original = [
    user(),
    assistant({ stopReason: "error", errorMessage: "503 service unavailable" }),
    marker(),
    assistant({ stopReason: "aborted" }),
    assistant({ stopReason: "stop" })
  ];

  const filtered = filterManualRetryMessages(original);
  assert.deepEqual(filtered, [original[0], original[4]]);
  assert.equal(original.length, 5);
});

test("filtered provider context reaches Anthropic, OpenAI, and pi-messages payloads without retry state", async () => {
  const originalRequest = "ORIGINAL_RETRY_REQUEST_SENTINEL";
  const failedAttempt = "FAILED_PROVIDER_ATTEMPT_SENTINEL";
  const messages = [
    user(originalRequest, 1),
    assistant({ stopReason: "error", errorMessage: `503 ${failedAttempt}`, timestamp: 2 }),
    marker(1, 3)
  ];
  const filtered = filterManualRetryMessages(messages);
  assert.deepEqual(filtered, [messages[0]], "pi-messages and custom providers receive this filtered context directly");
  const providerContext: Context = {
    systemPrompt: "You are a provider payload fixture.",
    messages: filtered as Message[],
    tools: []
  };

  const [anthropicPayload, openAIPayload, piMessagesPayload] = await Promise.all([
    captureAnthropicPayload(providerContext),
    captureOpenAIPayload(providerContext),
    capturePiMessagesPayload(providerContext)
  ]);
  for (const payload of [anthropicPayload, openAIPayload, piMessagesPayload]) {
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.match(new RegExp(originalRequest, "g"))?.length, 1);
    assert.doesNotMatch(serialized, new RegExp(failedAttempt));
    assert.doesNotMatch(serialized, new RegExp(MANUAL_RETRY_MESSAGE_TYPE));
  }
});

test("/retry persists one empty hidden marker and starts a fresh follow-up turn", async () => {
  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    const failureId = sessionManager.appendMessage(assistant({
      stopReason: "error",
      errorMessage: "Provider overloaded with HTTP 503",
      timestamp: 100
    }));

    // The fake mirrors AgentSession's message_end persistence listener; this test
    // verifies the marker emitted through that runtime-owned persistence path.
    const fake = createFakeApi((message) => {
      sessionManager.appendCustomMessageEntry(message.customType, message.content as [], message.display, message.details);
    });
    manualRetryExtension(fake.api);
    const { context, notifications } = commandContext({ sessionManager });
    const command = fake.commands.get(MANUAL_RETRY_COMMAND_NAME);
    assert.ok(command);

    await command("", context);

    assert.equal(fake.sentMessages.length, 1);
    const sent = fake.sentMessages[0];
    assert.deepEqual(sent.options, { triggerTurn: true, deliverAs: "followUp" });
    assert.equal(sent.message.customType, MANUAL_RETRY_MESSAGE_TYPE);
    assert.deepEqual(sent.message.content, []);
    assert.equal(sent.message.display, false);
    const details = sent.message.details as ManualRetryMarkerDetails;
    assert.deepEqual(
      { version: details.version, attempt: details.attempt, failedAssistantEntryId: details.failedAssistantEntryId, api: details.api, provider: details.provider, model: details.model, failedAt: details.failedAt },
      { version: 1, attempt: 1, failedAssistantEntryId: failureId, api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5", failedAt: 100 }
    );
    assert.match(details.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(sessionManager.getBranch().at(-1)?.type, "custom_message");
    assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
    assert.match(notifications.at(-1)?.message ?? "", /Manual retry attempt 1 requested/);
  });
});

test("/retry rejects print and JSON modes because their hosts cannot await sendMessage", async () => {
  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "503 service unavailable" }));
    const fake = createFakeApi();
    manualRetryExtension(fake.api);
    const command = fake.commands.get(MANUAL_RETRY_COMMAND_NAME);
    assert.ok(command);

    for (const mode of ["print", "json"] as const) {
      const { context } = commandContext({ sessionManager, mode });
      assert.match((getManualRetryEligibility(context) as { reason: string }).reason, /only in TUI and RPC/);
      await assert.rejects(command("", context), /cannot await ExtensionAPI.sendMessage/);
    }
    assert.equal(fake.sentMessages.length, 0);
  });
});

test("/retry does not persist or dispatch when queues appear or sendMessage throws synchronously", async () => {
  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "503 service unavailable" }));
    const branchLength = sessionManager.getBranch().length;

    const queued = createFakeApi();
    manualRetryExtension(queued.api);
    const queuedCommand = queued.commands.get(MANUAL_RETRY_COMMAND_NAME);
    assert.ok(queuedCommand);
    const queuedContext = commandContext({ sessionManager, pending: true });
    await queuedCommand("", queuedContext.context);
    assert.equal(queued.sentMessages.length, 0);
    assert.equal(sessionManager.getBranch().length, branchLength);

    const failing = createFakeApi();
    (failing.api as unknown as { sendMessage(): void }).sendMessage = () => {
      throw new Error("fixture injection failure");
    };
    manualRetryExtension(failing.api);
    const failingCommand = failing.commands.get(MANUAL_RETRY_COMMAND_NAME);
    assert.ok(failingCommand);
    const failingContext = commandContext({ sessionManager });
    await failingCommand("", failingContext.context);
    assert.equal(sessionManager.getBranch().length, branchLength);
    assert.match(failingContext.notifications.at(-1)?.message ?? "", /fixture injection failure/);
  });
});

test("repeated retry remains eligible only after a new retryable failure completes", async () => {
  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "503 service unavailable", timestamp: 10 }));
    sessionManager.appendCustomMessageEntry(MANUAL_RETRY_MESSAGE_TYPE, [], false, { version: 1, attempt: 1 });

    const dangling = commandContext({ sessionManager });
    assert.deepEqual(getManualRetryEligibility(dangling.context), {
      eligible: false,
      reason: "a previous retry marker has no completed assistant attempt"
    });

    const secondFailureId = sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "connection lost", timestamp: 20 }));
    const eligibility = getManualRetryEligibility(commandContext({ sessionManager }).context);
    assert.equal(eligibility.eligible, true);
    if (!eligibility.eligible) return;
    assert.equal(eligibility.attempt, 2);
    assert.equal(eligibility.failedAssistantEntryId, secondFailureId);
  });
});

test("/retry fails closed for active, queued, in-memory, cancelled, non-retryable, and model-changed states", async () => {
  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "503 service unavailable" }));

    assert.match((getManualRetryEligibility(commandContext({ sessionManager, idle: false }).context) as { reason: string }).reason, /still active/);
    assert.match((getManualRetryEligibility(commandContext({ sessionManager, pending: true }).context) as { reason: string }).reason, /pending/);
    assert.match((getManualRetryEligibility(commandContext({ sessionManager, model: fakeModel("anthropic", "different") }).context) as { reason: string }).reason, /provider, API, or model changed/);
    assert.match((getManualRetryEligibility(commandContext({ sessionManager, model: fakeModel("anthropic", "claude-sonnet-4-5", "pi-messages") }).context) as { reason: string }).reason, /provider, API, or model changed/);

    sessionManager.appendThinkingLevelChange("high");
    assert.match((getManualRetryEligibility(commandContext({ sessionManager }).context) as { reason: string }).reason, /thinking level changed/);
  });

  const inMemory = SessionManager.inMemory("/retry-test");
  inMemory.appendMessage(user());
  inMemory.appendMessage(assistant({ stopReason: "error", errorMessage: "503 service unavailable" }));
  assert.match((getManualRetryEligibility(commandContext({ sessionManager: inMemory }).context) as { reason: string }).reason, /not persisted/);

  await withSession(async (cancelled) => {
    cancelled.appendMessage(user());
    cancelled.appendMessage(assistant({ stopReason: "aborted" }));
    assert.match((getManualRetryEligibility(commandContext({ sessionManager: cancelled }).context) as { reason: string }).reason, /cancelled/);
  });

  await withSession(async (quota) => {
    quota.appendMessage(user());
    quota.appendMessage(assistant({ stopReason: "error", errorMessage: "insufficient_quota billing limit" }));
    assert.match((getManualRetryEligibility(commandContext({ sessionManager: quota }).context) as { reason: string }).reason, /not classified/);
  });

  await withSession(async (modelChanged) => {
    modelChanged.appendMessage(user());
    modelChanged.appendMessage(assistant({ stopReason: "error", errorMessage: "503 service unavailable" }));
    modelChanged.appendModelChange("anthropic", "different-model");
    assert.match((getManualRetryEligibility(commandContext({ sessionManager: modelChanged }).context) as { reason: string }).reason, /selected model changed/);
  });

  await withSession(async (compacted) => {
    compacted.appendMessage(user());
    const failureId = compacted.appendMessage(assistant({ stopReason: "error", errorMessage: "503 service unavailable" }));
    compacted.appendCompaction("Compacted summary", failureId, 1_000);
    assert.match((getManualRetryEligibility(commandContext({ sessionManager: compacted }).context) as { reason: string }).reason, /session was compacted/);
  });
});

test("context and compaction handlers apply the same provider-safe filtering", async () => {
  const fake = createFakeApi();
  manualRetryExtension(fake.api);
  const failure = assistant({ stopReason: "error", errorMessage: "503 service unavailable" });
  const cancelled = assistant({ stopReason: "aborted" });
  const messages = [user(), failure, marker(), cancelled];

  const contextResult = await emit(fake, "context", { type: "context", messages }, {});
  assert.deepEqual(contextResult, { messages: [messages[0]] });

  const preparation = {
    messagesToSummarize: [...messages],
    turnPrefixMessages: [failure, marker()],
    firstKeptEntryId: "entry",
    isSplitTurn: true,
    tokensBefore: 100,
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 }
  };
  await emit(fake, "session_before_compact", { type: "session_before_compact", preparation } as SessionBeforeCompactEvent, {});
  assert.deepEqual(preparation.messagesToSummarize, [messages[0]]);
  assert.deepEqual(preparation.turnPrefixMessages, []);
  assert.equal(preparation.firstKeptEntryId, "entry");
});

test("persisted retry markers remain filterable after session reload", async () => {
  await withSession(async (sessionManager, directory) => {
    sessionManager.appendMessage(user());
    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "503 service unavailable" }));
    sessionManager.appendCustomMessageEntry(MANUAL_RETRY_MESSAGE_TYPE, [], false, { version: 1, attempt: 1 });
    const sessionFile = sessionManager.getSessionFile();
    assert.ok(sessionFile);

    const reopened = SessionManager.open(sessionFile, directory);
    const messages = reopened.buildContextEntries().flatMap(sessionEntryToContextMessages);
    assert.deepEqual(filterManualRetryMessages(messages), [messages[0]]);

    const resumedFailureId = reopened.appendMessage(assistant({ stopReason: "error", errorMessage: "connection lost", timestamp: 200 }));
    const eligibility = getManualRetryEligibility(commandContext({ sessionManager: reopened }).context);
    assert.equal(eligibility.eligible, true);
    if (!eligibility.eligible) return;
    assert.equal(eligibility.attempt, 2);
    assert.equal(eligibility.failedAssistantEntryId, resumedFailureId);
  });
});
