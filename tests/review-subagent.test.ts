import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Api, Message, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { enforceDefaultTools } from "../extensions/native-tools/index.js";
import reviewSubagentExtension, {
  buildCancelledReviewDetails,
  buildReviewMessageContent,
  buildReviewStatusText,
  buildReviewTask,
  cancelReviewState,
  clearReviewState,
  createReviewActiveRun,
  createReviewState,
  createReviewToolAllowlistExtension,
  getReviewState,
  getReviewStateKey,
  parseReviewCommandArgs,
  publishReviewDetails,
  readReviewSettings,
  renderReviewMessage,
  selectReviewModel,
  serializeRecentMessages,
  settleReviewWorkLaunch,
  tokenizeArgs,
  validateReviewToolAllowlist,
  waitForReviewReportDisplayIdle,
  type ReviewDetails,
  type ReviewState
} from "../extensions/review-subagent/index.js";

function fakeModel(provider: string, id: string, reasoning = true): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: "https://example.invalid",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000
  } as Model<Api>;
}

type FakeToolListApi = ExtensionAPI & {
  activeTools: string[];
  handlers: Map<string, Function[]>;
};

function fakeRegistry(models: Model<Api>[], authed: Set<string> = new Set(models.map((model) => `${model.provider}/${model.id}`))) {
  return {
    hasConfiguredAuth(model: Model<Api>): boolean {
      return authed.has(`${model.provider}/${model.id}`);
    },
    getAll(): Model<Api>[] {
      return models;
    }
  };
}

function createToolListApi(activeTools: string[], allTools: string[]): FakeToolListApi {
  const api = {
    activeTools: [...activeTools],
    handlers: new Map<string, Function[]>(),
    getActiveTools(): string[] {
      return [...this.activeTools];
    },
    getAllTools(): Array<{ name: string }> {
      return allTools.map((name) => ({ name }));
    },
    setActiveTools(toolNames: string[]): void {
      this.activeTools = [...toolNames];
    },
    on(event: string, handler: Function): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }
  };
  return api as unknown as FakeToolListApi;
}

const renderTheme = {
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text
};

function sampleReviewDetails(overrides: Partial<ReviewDetails> = {}): ReviewDetails {
  return {
    status: "completed",
    cwd: "/repo",
    model: "anthropic/claude-opus-4-7",
    thinkingLevel: "xhigh",
    startedAt: "2026-05-03T00:00:00.000Z",
    completedAt: "2026-05-03T00:00:02.000Z",
    durationMs: 2000,
    critique: "## Review Summary\nLooks good.",
    sentBack: false,
    events: [],
    toolCallCount: 2,
    ...overrides
  };
}

async function withEnv(name: string, value: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

function fakeReviewCommandContext(options: { idle?: boolean; confirm?: () => Promise<boolean> | boolean; onWaitForIdle?: () => void; waitForIdle?: () => Promise<void> } = {}) {
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; type: string }> = [];
  return {
    statuses,
    notifications,
    context: {
      hasUI: true,
      isIdle(): boolean {
        return options.idle ?? true;
      },
      async waitForIdle(): Promise<void> {
        options.onWaitForIdle?.();
        if (options.waitForIdle) {
          await options.waitForIdle();
        }
      },
      ui: {
        setStatus(_key: string, text: string | undefined): void {
          statuses.push(text);
        },
        notify(message: string, type: string): void {
          notifications.push({ message, type });
        },
        async confirm(): Promise<boolean> {
          return options.confirm ? options.confirm() : false;
        }
      }
    }
  };
}

function fakeReviewApi() {
  const messages: unknown[] = [];
  const userMessages: string[] = [];
  return {
    messages,
    userMessages,
    api: {
      sendMessage(message: unknown): void {
        messages.push(message);
      },
      sendUserMessage(message: string): void {
        userMessages.push(message);
      }
    }
  };
}

type FakeReviewExtensionApi = ExtensionAPI & {
  commands: Map<string, (args: string, context: unknown) => Promise<void> | void>;
  handlers: Map<string, Function[]>;
  userMessages: string[];
};

function createReviewExtensionApi(): FakeReviewExtensionApi {
  const commands = new Map<string, (args: string, context: unknown) => Promise<void> | void>();
  const handlers = new Map<string, Function[]>();
  const userMessages: string[] = [];
  return {
    commands,
    handlers,
    userMessages,
    registerCommand(name: string, options: { handler: (args: string, context: unknown) => Promise<void> | void }): void {
      commands.set(name, options.handler);
    },
    registerMessageRenderer(): void {},
    on(event: string, handler: Function): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendUserMessage(message: string): void {
      userMessages.push(message);
    }
  } as unknown as FakeReviewExtensionApi;
}

function fakeReviewExtensionContext(sessionId: string) {
  const base = fakeReviewCommandContext();
  return {
    ...base,
    context: {
      ...base.context,
      cwd: "/repo",
      sessionManager: {
        getSessionId(): string {
          return sessionId;
        }
      }
    }
  };
}

function fakeExtensionContext(cwd: string, sessionId: string): Pick<ExtensionContext, "cwd" | "sessionManager"> {
  return {
    cwd,
    sessionManager: {
      getSessionId(): string {
        return sessionId;
      }
    }
  } as Pick<ExtensionContext, "cwd" | "sessionManager">;
}

test("tokenizeArgs supports shell-like quoting", () => {
  assert.deepEqual(tokenizeArgs("--model openai-codex/gpt 'focus on tests' \"and safety\""), [
    "--model",
    "openai-codex/gpt",
    "focus on tests",
    "and safety"
  ]);
  assert.throws(() => tokenizeArgs("'unterminated"), /Unterminated/);
});

test("parseReviewCommandArgs parses flags and keeps focus as raw remaining text", () => {
  assert.deepEqual(parseReviewCommandArgs("--model openai-codex/gpt-5.3-codex --send focus on edge cases"), {
    model: "openai-codex/gpt-5.3-codex",
    send: true,
    noSend: false,
    help: false,
    focus: "focus on edge cases"
  });

  assert.deepEqual(parseReviewCommandArgs("--model=openai-codex/gpt --no-send 'look at safety'"), {
    model: "openai-codex/gpt",
    send: false,
    noSend: true,
    help: false,
    focus: "'look at safety'"
  });

  assert.deepEqual(parseReviewCommandArgs("--no-send Don't strip apostrophes or unmatched \"quotes."), {
    send: false,
    noSend: true,
    help: false,
    focus: "Don't strip apostrophes or unmatched \"quotes."
  });

  assert.deepEqual(parseReviewCommandArgs("-- --starts-with-dash and isn't an option"), {
    send: false,
    noSend: false,
    help: false,
    focus: "--starts-with-dash and isn't an option"
  });
});

test("parseReviewCommandArgs rejects ambiguous or unknown options", () => {
  assert.throws(() => parseReviewCommandArgs("--model"), /requires/);
  assert.throws(() => parseReviewCommandArgs("--send --no-send"), /only one/);
  assert.throws(() => parseReviewCommandArgs("--danger"), /Unknown/);
});

test("selectReviewModel resolves requested model and enforces configured auth", () => {
  const gpt = fakeModel("openai-codex", "gpt-5.3-codex");
  const spark = fakeModel("openai-codex", "gpt-5.3-codex-spark");
  const registry = fakeRegistry([gpt, spark], new Set(["openai-codex/gpt-5.3-codex"]));

  assert.deepEqual(selectReviewModel(registry, "openai-codex/gpt-5.3-codex", spark, "high"), { model: gpt, thinkingLevel: "high" });
  assert.throws(() => selectReviewModel(registry, "openai-codex/gpt-5.3-codex-spark", gpt), /no configured auth/);
  assert.throws(() => selectReviewModel(registry, "openai-codex/missing", gpt), /not found/);
  assert.throws(() => selectReviewModel(registry, "missing-format", gpt), /not found/);
});

test("selectReviewModel uses the current model when no default is requested", () => {
  const current = fakeModel("openai-codex", "gpt-5.3-codex");
  const registry = fakeRegistry([current]);
  assert.deepEqual(selectReviewModel(registry, undefined, current, "xhigh"), { model: current, thinkingLevel: "xhigh" });
});

test("review tool allowlist stays restricted after native default tools are re-added", async () => {
  const reviewTools = ["read_many", "search_many", "searxng_search", "web_fetch_many", "document_parse"];
  const api = createToolListApi(["read_many", "search_many"], [
    "read_many",
    "search_many",
    "searxng_search",
    "web_fetch_many",
    "document_parse",
    "write_many",
    "edit_many",
    "shell_start"
  ]);

  enforceDefaultTools(api);
  assert.deepEqual(api.activeTools, ["read_many", "search_many", "write_many", "edit_many", "web_fetch_many", "shell_start"]);

  await createReviewToolAllowlistExtension(reviewTools)(api);
  const beforeAgentStart = api.handlers.get("before_agent_start")?.[0];
  assert.ok(beforeAgentStart);
  beforeAgentStart();

  assert.deepEqual(api.activeTools, reviewTools);
});

test("review tool allowlist validation fails loudly for missing configured tools", () => {
  const api = createToolListApi([], ["read_many", "search_many"]);

  assert.throws(
    () => validateReviewToolAllowlist(api, ["read_many", "web_fetch_many"], "profile:/config/review-subagent-settings.json"),
    /Review-subagent configured tools are unavailable: web_fetch_many.*profile:\/config\/review-subagent-settings\.json/
  );
});

test("review state keys are scoped by cwd and session", () => {
  assert.equal(getReviewStateKey(fakeExtensionContext("/repo", "session-a")), getReviewStateKey(fakeExtensionContext("/repo", "session-a")));
  assert.notEqual(getReviewStateKey(fakeExtensionContext("/repo", "session-a")), getReviewStateKey(fakeExtensionContext("/repo", "session-b")));
  assert.notEqual(getReviewStateKey(fakeExtensionContext("/repo", "session-a")), getReviewStateKey(fakeExtensionContext("/other", "session-a")));
});

test("review work launch only awaits the background task without UI", async () => {
  let resolveUiTask!: () => void;
  let uiTaskFinished = false;
  const uiTask = new Promise<void>((resolve) => {
    resolveUiTask = () => {
      uiTaskFinished = true;
      resolve();
    };
  });

  await settleReviewWorkLaunch(uiTask, { hasUI: true });
  assert.equal(uiTaskFinished, false);
  resolveUiTask();
  await uiTask;

  let resolvePrintTask!: () => void;
  let printLaunchFinished = false;
  const printTask = new Promise<void>((resolve) => {
    resolvePrintTask = resolve;
  });
  const printLaunch = settleReviewWorkLaunch(printTask, { hasUI: false }).then(() => {
    printLaunchFinished = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(printLaunchFinished, false);
  resolvePrintTask();
  await printLaunch;
  assert.equal(printLaunchFinished, true);
});

test("review report display waits for main agent idle", async () => {
  const statuses: Array<string | undefined> = [];
  let idle = false;
  let waited = false;
  const context = {
    isIdle(): boolean {
      return idle;
    },
    async waitForIdle(): Promise<void> {
      waited = true;
      idle = true;
    },
    ui: {
      setStatus(_key: string, text: string | undefined): void {
        statuses.push(text);
      }
    }
  };

  const reviewContext = context as unknown as Parameters<typeof waitForReviewReportDisplayIdle>[0];

  assert.equal(await waitForReviewReportDisplayIdle(reviewContext), true);
  assert.equal(waited, true);
  assert.deepEqual(statuses, ["review ready · waiting for main agent idle"]);

  assert.equal(await waitForReviewReportDisplayIdle(reviewContext), false);
  assert.deepEqual(statuses, ["review ready · waiting for main agent idle"]);
});

test("review extension registers review setup and lifecycle commands", () => {
  const api = createReviewExtensionApi();
  reviewSubagentExtension(api);
  assert.ok(api.commands.has("review"));
  assert.ok(api.commands.has("review:setup"));
  assert.ok(api.commands.has("review:status"));
  assert.ok(api.commands.has("review:cancel"));
  assert.ok(api.commands.has("review:send-last"));
});

test("review setup writes reviewer model config and guidance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-setup-"));
  const agentDir = path.join(root, "agent");
  const api = createReviewExtensionApi();
  reviewSubagentExtension(api);
  const { context, notifications } = fakeReviewExtensionContext("setup-guidance");
  const model = fakeModel("anthropic", "claude-opus-4-7");
  const setupCommand = api.commands.get("review:setup");
  const statusCommand = api.commands.get("review:status");
  assert.ok(setupCommand);
  assert.ok(statusCommand);

  const commandContext = {
    ...context,
    model,
    modelRegistry: fakeRegistry([model])
  } as unknown as ExtensionContext;

  try {
    await withEnv("PI_CODING_AGENT_DIR", agentDir, async () => {
      await withEnv("PI_TOOLS_CONFIG_DIR", undefined, async () => {
        await setupCommand("anthropic/claude-opus-4-7:high --guidance Focus on boundary drift and validation gaps.", commandContext);
        let config = JSON.parse(await readFile(path.join(agentDir, "extensions", "akoumjian-tools", "review-subagent-settings.json"), "utf8")) as Record<string, unknown>;
        assert.equal(config.guidance, "Focus on boundary drift and validation gaps.\n");

        await setupCommand("anthropic/claude-opus-4-7:medium", commandContext);
        config = JSON.parse(await readFile(path.join(agentDir, "extensions", "akoumjian-tools", "review-subagent-settings.json"), "utf8")) as Record<string, unknown>;
        assert.equal(config.guidance, "Focus on boundary drift and validation gaps.\n");

        await setupCommand("anthropic/claude-opus-4-7:high --clear-guidance", commandContext);
        await statusCommand("", commandContext);
      });
    });

    const configPath = path.join(agentDir, "extensions", "akoumjian-tools", "review-subagent-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(config.defaultModel, "anthropic/claude-opus-4-7");
    assert.equal(config.thinkingLevel, "high");
    assert.equal(config.guidance, undefined);
    assert.match(notifications[0].message, /Reviewer guidance: saved/);
    assert.doesNotMatch(notifications[1].message, /Reviewer guidance: saved/);
    assert.match(notifications[2].message, /Reviewer guidance: cleared/);
    assert.match(notifications[3].message, /Reviewer guidance: none/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review settings load reviewer guidance from markdown files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-guidance-"));
  try {
    const configDir = path.join(root, "config");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "review-subagent-settings.json"), JSON.stringify({ guidanceFile: "guidance.md", thinkingLevel: "xhigh" }), "utf8");
    await writeFile(path.join(configDir, "guidance.md"), "# Review Guidance\n\nFocus on missed requirements.\n", "utf8");

    await withEnv("PI_TOOLS_CONFIG_DIR", configDir, async () => {
      const settings = readReviewSettings();
      assert.match(settings.guidance ?? "", /Focus on missed requirements/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review-work command rejects re-entry while a review phase is active", async () => {
  const api = createReviewExtensionApi();
  reviewSubagentExtension(api);
  const { context, notifications } = fakeReviewExtensionContext("reentry");
  const state = getReviewState(context as never);
  state.phase = "running";
  state.activeRun = createReviewActiveRun("/repo", undefined, 1);

  try {
    const handler = api.commands.get("review");
    assert.ok(handler);
    await handler("", context);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /already running/);
    assert.equal(notifications[0].type, "warning");
  } finally {
    clearReviewState(context as never);
  }
});

test("review-cancel command rejects unexpected arguments", async () => {
  const api = createReviewExtensionApi();
  reviewSubagentExtension(api);
  const { context, notifications } = fakeReviewExtensionContext("cancel-args");

  try {
    const handler = api.commands.get("review:cancel");
    assert.ok(handler);
    await handler("extra", context);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /Usage: \/review:cancel/);
    assert.equal(notifications[0].type, "error");
  } finally {
    clearReviewState(context as never);
  }
});

test("review-send-last command refuses cancelled and failed reviews", async () => {
  const api = createReviewExtensionApi();
  reviewSubagentExtension(api);
  const { context, notifications } = fakeReviewExtensionContext("send-last-refuse");
  const state = getReviewState(context as never);
  const handler = api.commands.get("review:send-last");
  assert.ok(handler);

  try {
    state.lastReview = buildCancelledReviewDetails("/repo", undefined, "cancelled");
    await handler("", context);
    state.lastReview = sampleReviewDetails({ status: "failed", critique: "failed critique", error: "failed" });
    await handler("", context);

    assert.equal(api.userMessages.length, 0);
    assert.equal(notifications.length, 2);
    assert.match(notifications[0].message, /No completed/);
    assert.match(notifications[1].message, /No completed/);
  } finally {
    clearReviewState(context as never);
  }
});

test("review-subagent session shutdown cancels active runs and clears state", async () => {
  const api = createReviewExtensionApi();
  reviewSubagentExtension(api);
  const { context } = fakeReviewExtensionContext("shutdown-cleanup");
  const state = getReviewState(context as never);
  const activeRun = createReviewActiveRun("/repo", undefined, 1);
  let aborted = false;
  activeRun.abortChild = async () => {
    aborted = true;
  };
  state.phase = "running";
  state.activeRun = activeRun;

  const handler = api.handlers.get("session_shutdown")?.[0];
  assert.ok(handler);
  await handler({ reason: "quit" }, context);

  const newState = getReviewState(context as never);
  try {
    assert.equal(aborted, true);
    assert.notEqual(newState, state);
    assert.equal(newState.phase, "idle");
  } finally {
    clearReviewState(context as never);
  }
});

test("review cancellation marks active running state and aborts child sessions", async () => {
  const state = createReviewState();
  const activeRun = createReviewActiveRun("/repo", undefined, 1);
  let aborted = false;
  activeRun.abortChild = async () => {
    aborted = true;
  };
  state.phase = "running";
  state.activeRun = activeRun;
  const { context, statuses, notifications } = fakeReviewCommandContext();

  assert.equal(await cancelReviewState(state, context as never), true);
  assert.equal(activeRun.cancelRequested, true);
  assert.equal(aborted, true);
  assert.deepEqual(statuses, ["review cancelling"]);
  assert.equal(notifications.length, 0);
  assert.equal(state.lastReview?.status, "cancelled");
});

test("review status reports active run details before falling back to last review", () => {
  const state = createReviewState();
  const activeRun = createReviewActiveRun("/repo", undefined, 1);
  activeRun.model = "anthropic/claude-opus-4-7";
  activeRun.thinkingLevel = "xhigh";
  activeRun.toolCallCount = 3;
  state.phase = "awaiting-display";
  state.activeRun = activeRun;
  state.lastReview = sampleReviewDetails();

  const status = buildReviewStatusText(state, {
    defaultModel: "anthropic/claude-opus-4-7",
    guidance: "Focus on validation gaps.\n",
    thinkingLevel: "xhigh",
    maxRecentMessages: 30,
    maxTranscriptChars: 30000,
    maxDiffChars: 50000,
    maxOutputTokens: 6000,
    commandTimeoutMs: 10000,
    tools: ["read_many", "search_many"],
    configSource: "profile:/config/review-subagent-settings.json"
  });
  assert.match(status, /awaiting display/);
  assert.match(status, /Active review: awaiting display/);
  assert.match(status, /3 tool calls/);
  assert.match(status, /Last review: completed/);
  assert.match(status, /2 tool calls/);
  assert.match(status, /Reviewer guidance: configured/);
  assert.match(status, /Reviewer tools: read_many, search_many/);
});

test("buildReviewTask injects configured reviewer guidance", () => {
  const task = buildReviewTask("recent transcript", {
    isRepository: true,
    root: "/repo",
    status: "M file.ts",
    diffStat: "file.ts | 1 +",
    unstagedDiff: "+change",
    stagedDiff: "(none)",
    untrackedFiles: "(none)",
    errors: []
  }, undefined, {
    defaultModel: "anthropic/claude-opus-4-7",
    guidance: "Prioritize package/profile boundary regressions.\n",
    thinkingLevel: "xhigh",
    maxRecentMessages: 30,
    maxTranscriptChars: 30000,
    maxDiffChars: 50000,
    maxOutputTokens: 6000,
    commandTimeoutMs: 10000,
    tools: ["read_many", "search_many"],
    configSource: "profile:/config/review-subagent-settings.json"
  });

  assert.match(task, /## Reviewer guidance/);
  assert.match(task, /Prioritize package\/profile boundary regressions\./);
});

test("review publish skips stale display after deferred-display cancellation", async () => {
  const run = createReviewActiveRun("/repo", undefined, 1);
  const state: ReviewState = { phase: "running", activeRun: run };
  const details = sampleReviewDetails();
  const { api, messages, userMessages } = fakeReviewApi();
  const { context } = fakeReviewCommandContext({
    idle: false,
    onWaitForIdle: () => {
      run.cancelRequested = true;
      run.resolveCancel();
    }
  });

  await publishReviewDetails(api as never, context as never, state, run, { send: false, noSend: false, help: false }, details);

  assert.equal(messages.length, 0);
  assert.equal(userMessages.length, 0);
  assert.equal(state.lastReview?.status, "cancelled");
});

test("review publish deferred-display cancellation does not wait for main idle", async () => {
  const run = createReviewActiveRun("/repo", undefined, 1);
  const state: ReviewState = { phase: "running", activeRun: run };
  const details = sampleReviewDetails();
  const { api, messages, userMessages } = fakeReviewApi();
  let waitForIdleResolved = false;
  const { context } = fakeReviewCommandContext({
    idle: false,
    waitForIdle: async () => {
      await new Promise<void>(() => undefined);
      waitForIdleResolved = true;
    }
  });

  const publish = publishReviewDetails(api as never, context as never, state, run, { send: false, noSend: false, help: false }, details);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await cancelReviewState(state, context as never), true);
  await publish;

  assert.equal(waitForIdleResolved, false);
  assert.equal(messages.length, 0);
  assert.equal(userMessages.length, 0);
  assert.equal(state.lastReview?.status, "cancelled");
});

test("review publish does not send back after awaiting-confirm cancellation", async () => {
  const run = createReviewActiveRun("/repo", undefined, 1);
  const state: ReviewState = { phase: "running", activeRun: run };
  const details = sampleReviewDetails();
  const { api, messages, userMessages } = fakeReviewApi();
  const { context } = fakeReviewCommandContext({
    confirm: () => {
      run.cancelRequested = true;
      run.resolveCancel();
      return true;
    }
  });

  await publishReviewDetails(api as never, context as never, state, run, { send: false, noSend: false, help: false }, details);

  assert.equal(messages.length, 1);
  assert.equal(userMessages.length, 0);
  assert.equal(state.phase, "awaiting-confirm");
  assert.equal(state.lastReview?.status, "cancelled");
});

test("cancelled review details render as cancelled and cannot masquerade as sendable", () => {
  const cancelled = buildCancelledReviewDetails("/repo", "focus", "Review cancelled.", sampleReviewDetails());
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.critique, "");
  assert.match(buildReviewMessageContent(cancelled), /cancelled/);

  const rendered = renderReviewMessage(cancelled, false, renderTheme as never).render(200).join("\n");
  assert.match(rendered, /Review subagent/);
  assert.match(rendered, /Review cancelled/);
});

test("serializeRecentMessages includes assistant tool calls and caps output", () => {
  const messages = [
    { role: "user", content: "please implement review subagent", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect files." },
        { type: "toolCall", id: "call-1", name: "read_many", arguments: { files: [{ path: "package.json" }] } }
      ],
      api: "openai-responses",
      provider: "openai-codex",
      model: "gpt-5.3-codex",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 2
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read_many",
      content: [{ type: "text", text: "package content" }],
      isError: false,
      timestamp: 3
    }
  ] as Message[];

  const serialized = serializeRecentMessages(messages, 3, 10_000);
  assert.match(serialized, /USER/);
  assert.match(serialized, /ASSISTANT/);
  assert.match(serialized, /Tool calls:/);
  assert.match(serialized, /read_many/);
  assert.match(serialized, /TOOL RESULT read_many/);

  const capped = serializeRecentMessages(messages, 3, 80);
  assert.match(capped, /truncated/);
  assert.ok(capped.length < serialized.length);
});
