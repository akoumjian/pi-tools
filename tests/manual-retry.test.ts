import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Message, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
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
  AUTOMATIC_RETRY_MAX_ATTEMPTS,
  filterManualRetryMessages,
  getManualRetryEligibility,
  MANUAL_RETRY_COMMAND_NAME,
  MANUAL_RETRY_MESSAGE_TYPE,
  matchesAutomaticRetryError,
  runAutomaticRetry,
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

const immediateSleep = async (): Promise<void> => undefined;

function assistant(options: {
  stopReason: AssistantMessage["stopReason"];
  errorMessage?: string;
  timestamp?: number;
  provider?: string;
  model?: string;
  content?: AssistantMessage["content"];
}): AssistantMessage {
  return {
    role: "assistant",
    content: options.content ?? [],
    api: "anthropic-messages",
    provider: options.provider ?? "anthropic",
    model: options.model ?? "claude-sonnet-4-5",
    usage,
    stopReason: options.stopReason,
    errorMessage: options.errorMessage,
    timestamp: options.timestamp ?? Date.now()
  };
}

function toolCallAssistant(toolCallId: string, stopReason: AssistantMessage["stopReason"] = "toolUse", timestamp?: number): AssistantMessage {
  return assistant({
    stopReason,
    timestamp,
    content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "file.txt" } }]
  });
}

function toolResult(toolCallId: string, text = "tool output", timestamp = Date.now()): ToolResultMessage {
  return { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp };
}

function user(text = "Original request", timestamp = Date.now() - 1): UserMessage {
  return { role: "user", content: text, timestamp };
}

function marker(attempt = 1, timestamp = Date.now(), trigger: "manual" | "automatic" = "manual"): AgentMessage {
  return {
    role: "custom",
    customType: MANUAL_RETRY_MESSAGE_TYPE,
    content: [],
    display: false,
    details: { version: 2, attempt, trigger },
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

/** Mirrors AgentSession's message_end persistence so emitted markers land in the session. */
function persistingFakeApi(sessionManager: SessionManager): FakeApi {
  return createFakeApi((message) => {
    sessionManager.appendCustomMessageEntry(message.customType, message.content as [], message.display, message.details);
  });
}

function commandContext(options: {
  sessionManager: SessionManager;
  idle?: boolean | (() => boolean);
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
    isIdle: () => (typeof options.idle === "function" ? options.idle() : options.idle ?? true),
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

function reason(eligibility: ReturnType<typeof getManualRetryEligibility>): string {
  assert.equal(eligibility.eligible, false);
  return eligibility.eligible ? "" : eligibility.reason;
}

function sentDetails(fake: FakeApi, index = 0): ManualRetryMarkerDetails {
  return fake.sentMessages[index].message.details as ManualRetryMarkerDetails;
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

test("retry context filtering removes markers, failed attempts, and their orphaned tool results without mutating history", () => {
  const original: AgentMessage[] = [
    user(),
    toolCallAssistant("call-ok", "toolUse"),
    toolResult("call-ok"),
    assistant({ stopReason: "error", errorMessage: "503 service unavailable" }),
    marker(),
    toolCallAssistant("call-aborted", "aborted"),
    toolResult("call-aborted", "Operation aborted"),
    assistant({ stopReason: "stop" })
  ];

  const filtered = filterManualRetryMessages(original);
  assert.deepEqual(filtered, [original[0], original[1], original[2], original[7]]);
  assert.equal(original.length, 8);
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

test("/retry after any settled error persists one empty hidden marker and starts a fresh follow-up turn", async () => {
  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    const failureId = sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "Not Found", timestamp: 100 }));

    const fake = persistingFakeApi(sessionManager);
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
    const { requestedAt, ...details } = sentDetails(fake);
    assert.deepEqual(details, {
      version: 2,
      attempt: 1,
      trigger: "manual",
      kind: "error",
      errorMessage: "Not Found",
      failedAssistantEntryId: failureId,
      failedAt: 100,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5"
    });
    assert.match(requestedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(sessionManager.getBranch().at(-1)?.type, "custom_message");
    assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
    assert.match(notifications.at(-1)?.message ?? "", /Retry attempt 1: resending the current context to anthropic\/claude-sonnet-4-5 after error "Not Found"/);
  });
});

test("/retry resends the context after a cancelled attempt and after cancelled tool execution", async () => {
  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    const abortedId = sessionManager.appendMessage(assistant({ stopReason: "aborted", timestamp: 50 }));
    const eligibility = getManualRetryEligibility(commandContext({ sessionManager }).context);
    assert.equal(eligibility.eligible, true);
    if (!eligibility.eligible) return;
    assert.equal(eligibility.kind, "aborted");
    assert.equal(eligibility.failedAssistantEntryId, abortedId);

    const fake = persistingFakeApi(sessionManager);
    manualRetryExtension(fake.api);
    const { context, notifications } = commandContext({ sessionManager });
    await fake.commands.get(MANUAL_RETRY_COMMAND_NAME)!("", context);
    assert.equal(sentDetails(fake).kind, "aborted");
    assert.match(notifications.at(-1)?.message ?? "", /after a cancelled attempt/);
  });

  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    sessionManager.appendMessage(toolCallAssistant("call-1"));
    sessionManager.appendMessage(toolResult("call-1", "Operation aborted"));
    const eligibility = getManualRetryEligibility(commandContext({ sessionManager }).context);
    assert.equal(eligibility.eligible, true);
    if (!eligibility.eligible) return;
    assert.equal(eligibility.kind, "continuation");
    assert.equal(eligibility.failedAssistantEntryId, undefined);
  });
});

test("/retry follows an explicit model or thinking switch and records the target model", async () => {
  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "Not Found", provider: "openai-codex", model: "gpt-5.6-sol" }));
    sessionManager.appendModelChange("anthropic", "claude-sonnet-4-5");
    sessionManager.appendThinkingLevelChange("high");

    const fake = persistingFakeApi(sessionManager);
    manualRetryExtension(fake.api);
    const { context } = commandContext({ sessionManager, model: fakeModel("anthropic", "claude-sonnet-4-5") });
    await fake.commands.get(MANUAL_RETRY_COMMAND_NAME)!("", context);

    assert.equal(fake.sentMessages.length, 1);
    const details = sentDetails(fake);
    assert.equal(details.provider, "anthropic");
    assert.equal(details.model, "claude-sonnet-4-5");
    assert.equal(details.errorMessage, "Not Found");
  });
});

test("repeated retries stay available and the attempt ordinal keeps counting persisted markers", async () => {
  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "503 service unavailable", timestamp: 10 }));
    sessionManager.appendCustomMessageEntry(MANUAL_RETRY_MESSAGE_TYPE, [], false, { version: 2, attempt: 1, trigger: "manual" });

    const dangling = getManualRetryEligibility(commandContext({ sessionManager }).context);
    assert.equal(dangling.eligible, true);
    if (!dangling.eligible) return;
    assert.equal(dangling.attempt, 2);
    assert.equal(dangling.kind, "error");

    const secondFailureId = sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "connection lost", timestamp: 20 }));
    const eligibility = getManualRetryEligibility(commandContext({ sessionManager }).context);
    assert.equal(eligibility.eligible, true);
    if (!eligibility.eligible) return;
    assert.equal(eligibility.attempt, 2);
    assert.equal(eligibility.failedAssistantEntryId, secondFailureId);
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
      assert.match(reason(getManualRetryEligibility(context)), /only in TUI and RPC/);
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
    await queued.commands.get(MANUAL_RETRY_COMMAND_NAME)!("", commandContext({ sessionManager, pending: true }).context);
    assert.equal(queued.sentMessages.length, 0);
    assert.equal(sessionManager.getBranch().length, branchLength);

    const failing = createFakeApi();
    (failing.api as unknown as { sendMessage(): void }).sendMessage = () => {
      throw new Error("fixture injection failure");
    };
    manualRetryExtension(failing.api);
    const failingContext = commandContext({ sessionManager });
    await failing.commands.get(MANUAL_RETRY_COMMAND_NAME)!("", failingContext.context);
    assert.equal(sessionManager.getBranch().length, branchLength);
    assert.match(failingContext.notifications.at(-1)?.message ?? "", /fixture injection failure/);
  });
});

test("/retry fails closed for active, queued, in-memory, completed, and unanswered-tool-call states", async () => {
  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "503 service unavailable" }));
    assert.match(reason(getManualRetryEligibility(commandContext({ sessionManager, idle: false }).context)), /still active/);
    assert.match(reason(getManualRetryEligibility(commandContext({ sessionManager, pending: true }).context)), /pending/);
  });

  const inMemory = SessionManager.inMemory("/retry-test");
  inMemory.appendMessage(user());
  inMemory.appendMessage(assistant({ stopReason: "error", errorMessage: "503 service unavailable" }));
  assert.match(reason(getManualRetryEligibility(commandContext({ sessionManager: inMemory }).context)), /not persisted/);

  await withSession(async (completed) => {
    completed.appendMessage(user());
    completed.appendMessage(assistant({ stopReason: "stop" }));
    assert.match(reason(getManualRetryEligibility(commandContext({ sessionManager: completed }).context)), /response completed/);
  });

  await withSession(async (unanswered) => {
    unanswered.appendMessage(user());
    unanswered.appendMessage(toolCallAssistant("call-1"));
    assert.match(reason(getManualRetryEligibility(commandContext({ sessionManager: unanswered }).context)), /tool calls without results/);
  });

  await withSession(async (empty) => {
    assert.match(reason(getManualRetryEligibility(commandContext({ sessionManager: empty }).context)), /nothing to send/);
  });
});

test("/retry stays available for quota errors and after compaction because the user chooses when to resend", async () => {
  await withSession(async (quota) => {
    quota.appendMessage(user());
    quota.appendMessage(assistant({ stopReason: "error", errorMessage: "insufficient_quota billing limit" }));
    assert.equal(getManualRetryEligibility(commandContext({ sessionManager: quota }).context).eligible, true);
  });

  await withSession(async (compacted) => {
    compacted.appendMessage(user());
    const failureId = compacted.appendMessage(assistant({ stopReason: "error", errorMessage: "503 service unavailable" }));
    compacted.appendCompaction("Compacted summary", failureId, 1_000);
    const eligibility = getManualRetryEligibility(commandContext({ sessionManager: compacted }).context);
    assert.equal(eligibility.eligible, true);
    if (!eligibility.eligible) return;
    assert.equal(eligibility.kind, "error");
    assert.equal(eligibility.failedAssistantEntryId, failureId);
  });
});

test("automatic retry patterns cover bare HTTP reason phrases core does not classify", () => {
  for (const message of ["Not Found", "not found", "Bad Gateway", "HTTP 404 Not Found", "502 Bad Gateway"]) {
    assert.equal(matchesAutomaticRetryError(message), true, message);
  }
  for (const message of [undefined, "", "Model not found: gpt-x", "Forbidden", "503 service unavailable", "insufficient_quota"]) {
    assert.equal(matchesAutomaticRetryError(message), false, String(message));
  }
});

test("automatic retry dispatches an automatic marker with exponential backoff for listed errors", async () => {
  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    const failureId = sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "Not Found", timestamp: 100 }));
    const fake = persistingFakeApi(sessionManager);
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
    };
    const { context, notifications } = commandContext({ sessionManager });

    const first = await runAutomaticRetry(fake.api, context, { sleep });
    assert.deepEqual(first, { status: "dispatched", attempt: 1, delayMs: 2_000 });
    assert.deepEqual(slept, [2_000]);
    const details = sentDetails(fake);
    assert.equal(details.trigger, "automatic");
    assert.equal(details.kind, "error");
    assert.equal(details.failedAssistantEntryId, failureId);
    assert.match(notifications.at(-1)?.message ?? "", /Automatic retry 1\/3 in 2s after error "Not Found"/);

    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "Not Found", timestamp: 200 }));
    const second = await runAutomaticRetry(fake.api, context, { sleep });
    assert.deepEqual(second, { status: "dispatched", attempt: 2, delayMs: 4_000 });

    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "Not Found", timestamp: 300 }));
    const third = await runAutomaticRetry(fake.api, context, { sleep });
    assert.deepEqual(third, { status: "dispatched", attempt: 3, delayMs: 8_000 });

    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "Not Found", timestamp: 400 }));
    const exhausted = await runAutomaticRetry(fake.api, context, { sleep });
    assert.deepEqual(exhausted, { status: "exhausted", attempts: AUTOMATIC_RETRY_MAX_ATTEMPTS });
    assert.equal(fake.sentMessages.length, 3);
    assert.match(notifications.at(-1)?.message ?? "", /Automatic retry stopped after 3 attempts/);
    assert.equal(notifications.at(-1)?.type, "warning");

    // An explicit /retry starts a fresh bounded chain.
    manualRetryExtension(fake.api, { sleep });
    await fake.commands.get(MANUAL_RETRY_COMMAND_NAME)!("", context);
    assert.equal(sentDetails(fake, 3).trigger, "manual");
    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "Not Found", timestamp: 500 }));
    const renewed = await runAutomaticRetry(fake.api, context, { sleep });
    assert.deepEqual(renewed, { status: "dispatched", attempt: 5, delayMs: 2_000 });
  });
});

test("automatic retry skips cancellations, core-retryable errors, unlisted errors, ineligible states, and non-TUI modes", async () => {
  await withSession(async (sessionManager) => {
    const fake = createFakeApi();
    sessionManager.appendMessage(user());

    sessionManager.appendMessage(assistant({ stopReason: "aborted" }));
    assert.deepEqual(await runAutomaticRetry(fake.api, commandContext({ sessionManager }).context, { sleep: immediateSleep }), {
      status: "skipped",
      reason: "only settled provider errors are retried automatically"
    });

    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "503 service unavailable" }));
    assert.deepEqual(await runAutomaticRetry(fake.api, commandContext({ sessionManager }).context, { sleep: immediateSleep }), {
      status: "skipped",
      reason: "Pi core classifies this error as transient and already retried it"
    });

    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "insufficient_quota billing limit" }));
    assert.deepEqual(await runAutomaticRetry(fake.api, commandContext({ sessionManager }).context, { sleep: immediateSleep }), {
      status: "skipped",
      reason: "the error is not in the automatic retry list"
    });

    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "Not Found" }));
    assert.equal((await runAutomaticRetry(fake.api, commandContext({ sessionManager, pending: true }).context, { sleep: immediateSleep })).status, "skipped");
    assert.equal((await runAutomaticRetry(fake.api, commandContext({ sessionManager, mode: "print" }).context, { sleep: immediateSleep })).status, "skipped");

    sessionManager.appendMessage(assistant({ stopReason: "stop" }));
    assert.equal((await runAutomaticRetry(fake.api, commandContext({ sessionManager }).context, { sleep: immediateSleep })).status, "skipped");
    assert.equal(fake.sentMessages.length, 0);
  });
});

test("automatic retry aborts without dispatching when the session changes during backoff", async () => {
  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "Not Found" }));
    const fake = createFakeApi();

    const newPromptDuringSleep = async (): Promise<void> => {
      sessionManager.appendMessage(user("A newer request"));
    };
    assert.deepEqual(await runAutomaticRetry(fake.api, commandContext({ sessionManager }).context, { sleep: newPromptDuringSleep }), { status: "stale" });

    let idle = true;
    const becomesActiveDuringSleep = async (): Promise<void> => {
      idle = false;
    };
    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "Not Found" }));
    assert.deepEqual(
      await runAutomaticRetry(fake.api, commandContext({ sessionManager, idle: () => idle }).context, { sleep: becomesActiveDuringSleep }),
      { status: "stale" }
    );
    assert.equal(fake.sentMessages.length, 0);
  });
});

test("agent_settled handler runs the automatic retry without blocking the event", async () => {
  await withSession(async (sessionManager) => {
    sessionManager.appendMessage(user());
    sessionManager.appendMessage(assistant({ stopReason: "error", errorMessage: "Not Found" }));
    const fake = persistingFakeApi(sessionManager);
    manualRetryExtension(fake.api, { sleep: immediateSleep });
    const { context } = commandContext({ sessionManager });

    const result = await emit(fake, "agent_settled", { type: "agent_settled" }, context);
    assert.equal(result, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.sentMessages.length, 1);
    assert.equal(sentDetails(fake).trigger, "automatic");
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
