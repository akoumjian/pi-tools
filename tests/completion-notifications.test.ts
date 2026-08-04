import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputSource,
  MessageStartEvent
} from "@earendil-works/pi-coding-agent";
import {
  COMPLETION_NOTIFICATION_BODY,
  COMPLETION_NOTIFICATION_COMMAND_NAME,
  COMPLETION_NOTIFICATION_MINIMUM_DURATION_MS,
  COMPLETION_NOTIFICATION_TITLE,
  buildCompletionNotificationStatusText,
  deliverCompletionNotification,
  detectCompletionNotificationTransport,
  parseCompletionNotificationCommand,
  readCompletionNotificationSettings,
  registerCompletionNotifications,
  type CompletionNotificationDependencies,
  type CompletionNotificationDelivery,
  type CompletionNotificationSettings,
  type CompletionNotificationTransport
} from "../extensions/completion-notifications/index.js";
import { isAsyncShellCompletionBarrierTarget } from "../extensions/async-shell/index.js";

type Handler = (event: any, context: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, context: ExtensionCommandContext) => unknown | Promise<unknown>;

type FakeApi = {
  api: ExtensionAPI;
  handlers: Map<string, Handler[]>;
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

function assistant(stopReason: StopReason = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage,
    stopReason,
    timestamp: 1
  };
}

function createFakeApi(): FakeApi {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandHandler>();
  const api = {
    on(event: string, handler: Handler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: CommandHandler }): void {
      commands.set(name, options.handler);
    }
  } as unknown as ExtensionAPI;
  return { api, handlers, commands };
}

function createContext(options: {
  mode?: "tui" | "rpc" | "json" | "print";
  idle?: () => boolean;
  pending?: () => boolean;
} = {}) {
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const context = {
    mode: options.mode ?? "tui",
    hasUI: options.mode === undefined || options.mode === "tui" || options.mode === "rpc",
    cwd: "/completion-notification-test",
    sessionManager: {
      getSessionId: () => "session-test"
    },
    isIdle: options.idle ?? (() => true),
    hasPendingMessages: options.pending ?? (() => false),
    ui: {
      notify(message: string, type?: string): void {
        notifications.push({ message, type });
      }
    }
  } as unknown as ExtensionCommandContext;
  return { context, notifications };
}

function createHarness(options: {
  enabled?: boolean;
  barrier?: () => string[];
  transport?: CompletionNotificationTransport;
} = {}) {
  const fake = createFakeApi();
  let nowMs = 0;
  let enabled = options.enabled ?? true;
  let settingsSource = "test:memory";
  const deliveries: CompletionNotificationDelivery[] = [];
  const transport = options.transport ?? {
    supported: true as const,
    kind: "osc777" as const,
    label: "test OSC 777"
  };
  const dependencies: Partial<CompletionNotificationDependencies> = {
    now: () => nowMs,
    readSettings: () => ({ enabled, source: settingsSource }),
    writeEnabled: (nextEnabled) => {
      enabled = nextEnabled;
      settingsSource = "agent:/test/completion-notifications-settings.json";
      return { enabled, source: settingsSource };
    },
    detectTransport: () => transport,
    deliver: (selectedTransport) => {
      const delivery = selectedTransport.supported
        ? { sent: true, transport: selectedTransport.label }
        : { sent: false, transport: selectedTransport.label, error: selectedTransport.reason };
      deliveries.push(delivery);
      return delivery;
    },
    getAsyncBarrier: () => ({ jobIds: options.barrier?.() ?? [] })
  };
  registerCompletionNotifications(fake.api, dependencies);
  return {
    fake,
    deliveries,
    setNow(value: number): void {
      nowMs = value;
    },
    advance(value: number): void {
      nowMs += value;
    }
  };
}

async function emit(fake: FakeApi, name: string, event: unknown, context: ExtensionContext): Promise<void> {
  for (const handler of fake.handlers.get(name) ?? []) {
    await handler(event, context);
  }
}

async function startRun(
  harness: ReturnType<typeof createHarness>,
  context: ExtensionContext,
  source: InputSource = "interactive"
): Promise<void> {
  await emit(harness.fake, "input", { type: "input", text: "private prompt", source }, context);
  await emit(harness.fake, "agent_start", { type: "agent_start" }, context);
}

async function endAndSettle(
  harness: ReturnType<typeof createHarness>,
  context: ExtensionContext,
  stopReason: StopReason = "stop"
): Promise<void> {
  const event: AgentEndEvent = { type: "agent_end", messages: [assistant(stopReason)] };
  await emit(harness.fake, "agent_end", event, context);
  await emit(harness.fake, "agent_settled", { type: "agent_settled" }, context);
}

async function deliverAsyncShellFollowUp(
  harness: ReturnType<typeof createHarness>,
  context: ExtensionContext,
  jobIds: string[],
  stopReason: StopReason = "stop"
): Promise<void> {
  await startRun(harness, context, "extension");
  const details = jobIds.length === 1
    ? { jobId: jobIds[0] }
    : { jobs: jobIds.map((jobId) => ({ jobId })) };
  const message: AgentMessage = {
    role: "custom",
    customType: "async-shell",
    content: "completion",
    display: true,
    details,
    timestamp: 2
  };
  const event: MessageStartEvent = { type: "message_start", message };
  await emit(harness.fake, "message_start", event, context);
  await endAndSettle(harness, context, stopReason);
}

test("completion notifier registers one command with a small explicit command surface", () => {
  const harness = createHarness();
  assert.ok(harness.fake.commands.has(COMPLETION_NOTIFICATION_COMMAND_NAME));
  assert.equal(parseCompletionNotificationCommand(""), "status");
  assert.equal(parseCompletionNotificationCommand("status"), "status");
  assert.equal(parseCompletionNotificationCommand("ON"), "on");
  assert.equal(parseCompletionNotificationCommand("off"), "off");
  assert.equal(parseCompletionNotificationCommand("test"), "test");
  assert.equal(parseCompletionNotificationCommand("--help"), "help");
  assert.equal(parseCompletionNotificationCommand("later"), "invalid");
});

test("successful interactive TUI run notifies once only after the fixed duration and full settlement", async () => {
  const harness = createHarness();
  const { context } = createContext();
  await startRun(harness, context);
  harness.advance(COMPLETION_NOTIFICATION_MINIMUM_DURATION_MS);
  await endAndSettle(harness, context);
  await emit(harness.fake, "agent_settled", { type: "agent_settled" }, context);

  assert.equal(harness.deliveries.length, 1);
  assert.equal(harness.deliveries[0]?.sent, true);
});

test("default-off, short, headless, noninteractive, queued, and non-stop runs are suppressed", async () => {
  const cases: Array<{
    name: string;
    harness: ReturnType<typeof createHarness>;
    context: ExtensionCommandContext;
    source?: InputSource;
    stopReason?: StopReason;
    duration?: number;
  }> = [
    { name: "disabled", harness: createHarness({ enabled: false }), context: createContext().context },
    { name: "short", harness: createHarness(), context: createContext().context, duration: 29_999 },
    { name: "headless", harness: createHarness(), context: createContext({ mode: "json" }).context },
    { name: "rpc source", harness: createHarness(), context: createContext().context, source: "rpc" },
    { name: "extension source", harness: createHarness(), context: createContext().context, source: "extension" },
    { name: "queued", harness: createHarness(), context: createContext({ pending: () => true }).context },
    { name: "aborted", harness: createHarness(), context: createContext().context, stopReason: "aborted" },
    { name: "error", harness: createHarness(), context: createContext().context, stopReason: "error" },
    { name: "length", harness: createHarness(), context: createContext().context, stopReason: "length" },
    { name: "tool use", harness: createHarness(), context: createContext().context, stopReason: "toolUse" }
  ];

  for (const item of cases) {
    await startRun(item.harness, item.context, item.source ?? "interactive");
    item.harness.advance(item.duration ?? COMPLETION_NOTIFICATION_MINIMUM_DURATION_MS);
    await endAndSettle(item.harness, item.context, item.stopReason ?? "stop");
    assert.equal(item.harness.deliveries.length, 0, item.name);
  }
});

test("automatic retry and queued continuations retain one user run and notify only at agent_settled", async () => {
  const harness = createHarness();
  const { context } = createContext();
  await startRun(harness, context);
  harness.advance(15_000);
  await emit(harness.fake, "agent_end", { type: "agent_end", messages: [assistant("error")] }, context);
  await emit(harness.fake, "agent_start", { type: "agent_start" }, context);
  harness.advance(15_000);
  await emit(harness.fake, "agent_end", { type: "agent_end", messages: [assistant("stop")] }, context);
  assert.equal(harness.deliveries.length, 0);
  await emit(harness.fake, "agent_settled", { type: "agent_settled" }, context);
  assert.equal(harness.deliveries.length, 1);
});

test("related async-shell notify-on-exit jobs defer one toast until all completion follow-ups settle", async () => {
  const barrier = ["job-one", "job-two"];
  const harness = createHarness({ barrier: () => barrier });
  const { context } = createContext();
  await startRun(harness, context);
  harness.advance(5_000);
  await endAndSettle(harness, context);
  assert.equal(harness.deliveries.length, 0);

  harness.advance(30_000);
  await deliverAsyncShellFollowUp(harness, context, ["job-one"]);
  assert.equal(harness.deliveries.length, 0);

  harness.advance(1_000);
  await deliverAsyncShellFollowUp(harness, context, ["job-two"]);
  assert.equal(harness.deliveries.length, 1);

  await deliverAsyncShellFollowUp(harness, context, ["job-two"]);
  assert.equal(harness.deliveries.length, 1, "duplicate completion delivery must not duplicate the toast");
});

test("async-shell completions delivered inside the original run do not defer the toast", async () => {
  const harness = createHarness({ barrier: () => ["job-one"] });
  const { context } = createContext();
  await startRun(harness, context);
  const message: AgentMessage = {
    role: "custom",
    customType: "async-shell",
    content: "completion",
    display: true,
    details: { jobId: "job-one" },
    timestamp: 2
  };
  await emit(harness.fake, "message_start", { type: "message_start", message }, context);
  harness.advance(COMPLETION_NOTIFICATION_MINIMUM_DURATION_MS);
  await endAndSettle(harness, context);
  assert.equal(harness.deliveries.length, 1);
});

test("cancelled or observed async-shell jobs stop blocking on the next successful settlement", async () => {
  let barrier = ["job-one"];
  const harness = createHarness({ barrier: () => barrier });
  const { context } = createContext();
  await startRun(harness, context);
  harness.advance(5_000);
  await endAndSettle(harness, context);
  assert.equal(harness.deliveries.length, 0);

  barrier = [];
  harness.advance(30_000);
  await startRun(harness, context, "extension");
  await endAndSettle(harness, context);
  assert.equal(harness.deliveries.length, 1);
});

test("delivered jobs plus a later cancelled job resolve one multi-job barrier", async () => {
  let barrier = ["job-one", "job-two"];
  const harness = createHarness({ barrier: () => barrier });
  const { context } = createContext();
  await startRun(harness, context);
  harness.advance(5_000);
  await endAndSettle(harness, context);

  harness.advance(25_000);
  await deliverAsyncShellFollowUp(harness, context, ["job-one"]);
  assert.equal(harness.deliveries.length, 0);

  barrier = ["job-one"];
  await startRun(harness, context, "extension");
  await endAndSettle(harness, context);
  assert.equal(harness.deliveries.length, 1);
});

test("failed async-shell completion follow-up and new interactive work cancel the deferred toast", async () => {
  let barrier = ["job-one"];
  const failed = createHarness({ barrier: () => barrier });
  const failedContext = createContext().context;
  await startRun(failed, failedContext);
  failed.advance(COMPLETION_NOTIFICATION_MINIMUM_DURATION_MS);
  await endAndSettle(failed, failedContext);
  await deliverAsyncShellFollowUp(failed, failedContext, ["job-one"], "error");
  assert.equal(failed.deliveries.length, 0);

  const replaced = createHarness({ barrier: () => barrier });
  const replacedContext = createContext().context;
  await startRun(replaced, replacedContext);
  replaced.advance(5_000);
  await endAndSettle(replaced, replacedContext);
  barrier = [];
  await startRun(replaced, replacedContext, "interactive");
  replaced.advance(COMPLETION_NOTIFICATION_MINIMUM_DURATION_MS);
  await endAndSettle(replaced, replacedContext);
  assert.equal(replaced.deliveries.length, 1, "only the replacement interactive run should notify");
});

test("async-shell barrier includes only notify-on-exit work that still owes a follow-up", () => {
  assert.equal(isAsyncShellCompletionBarrierTarget({
    status: "running",
    notifyOnExit: true,
    completionNotified: false,
    completionFollowUpQueued: false
  }), true);
  assert.equal(isAsyncShellCompletionBarrierTarget({
    status: "running",
    notifyOnExit: false,
    completionNotified: false,
    completionFollowUpQueued: false
  }), false);
  assert.equal(isAsyncShellCompletionBarrierTarget({
    status: "exited",
    notifyOnExit: true,
    completionNotified: false,
    completionFollowUpQueued: false
  }), true, "terminal completion must block during the zero-delay scheduling window");
  assert.equal(isAsyncShellCompletionBarrierTarget({
    status: "exited",
    notifyOnExit: true,
    completionNotified: true,
    completionFollowUpQueued: false
  }), false, "in-band or explicitly observed completion must not block");
  assert.equal(isAsyncShellCompletionBarrierTarget({
    status: "exited",
    notifyOnExit: true,
    completionNotified: true,
    completionFollowUpQueued: true
  }), true, "queued completion follow-up must block until its run settles");
});

test("transport detection is conservative and chooses exactly one tested path", () => {
  assert.deepEqual(detectCompletionNotificationTransport({ TERM_PROGRAM: "iTerm.app" }, "darwin", true), {
    supported: true,
    kind: "osc9",
    label: "iTerm.app OSC 9"
  });
  assert.equal(detectCompletionNotificationTransport({ TERM_PROGRAM: "WezTerm" }, "linux", true).kind, "osc777");
  assert.equal(detectCompletionNotificationTransport({ TERM_PROGRAM: "ghostty" }, "darwin", true).kind, "osc777");
  assert.equal(detectCompletionNotificationTransport({ KITTY_WINDOW_ID: "1" }, "linux", true).kind, "osc99");
  assert.equal(detectCompletionNotificationTransport({ WT_SESSION: "1", WSL_DISTRO_NAME: "Ubuntu" }, "linux", true).kind, "windows-toast");
  assert.equal(detectCompletionNotificationTransport({ TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux" }, "darwin", true).supported, false);
  assert.equal(detectCompletionNotificationTransport({ ZELLIJ: "0" }, "linux", true).supported, false);
  assert.equal(detectCompletionNotificationTransport({ TERM_PROGRAM: "WarpTerminal" }, "darwin", true).supported, false);
  assert.equal(detectCompletionNotificationTransport({ TERM_PROGRAM: "iTerm.app" }, "darwin", false).supported, false);
});

test("delivery emits fixed generic OSC payloads and reports transport failures", () => {
  const output: string[] = [];
  const osc9 = deliverCompletionNotification(
    { supported: true, kind: "osc9", label: "test iTerm2" },
    (text) => output.push(text)
  );
  assert.equal(osc9.sent, true);
  assert.equal(output.join(""), `\x1b]9;${COMPLETION_NOTIFICATION_TITLE}: ${COMPLETION_NOTIFICATION_BODY}\x07`);
  assert.doesNotMatch(output.join(""), /private prompt|repository|session/i);

  output.length = 0;
  const osc777 = deliverCompletionNotification(
    { supported: true, kind: "osc777", label: "test 777" },
    (text) => output.push(text)
  );
  assert.equal(osc777.sent, true);
  assert.equal(output.join(""), `\x1b]777;notify;${COMPLETION_NOTIFICATION_TITLE};${COMPLETION_NOTIFICATION_BODY}\x07`);
  assert.doesNotMatch(output.join(""), /private prompt|repository|session/i);

  output.length = 0;
  const osc99 = deliverCompletionNotification(
    { supported: true, kind: "osc99", label: "test 99" },
    (text) => output.push(text)
  );
  assert.equal(osc99.sent, true);
  assert.equal(output.length, 2);
  assert.match(output.join(""), /pi-complete/);

  const unsupported = deliverCompletionNotification({
    supported: false,
    kind: "unsupported",
    label: "none",
    reason: "unsupported terminal"
  });
  assert.deepEqual(unsupported, { sent: false, transport: "none", error: "unsupported terminal" });

  const writeFailure = deliverCompletionNotification(
    { supported: true, kind: "osc777", label: "test 777" },
    () => { throw new Error("write failed"); }
  );
  assert.equal(writeFailure.sent, false);
  assert.match(writeFailure.error ?? "", /write failed/);

  let windowsScript = "";
  const windowsSuccess = deliverCompletionNotification(
    { supported: true, kind: "windows-toast", label: "test Windows" },
    () => { throw new Error("OSC writer must not be used for Windows"); },
    (script) => {
      windowsScript = script;
      return { status: 0, signal: null, output: [], pid: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } as never;
    }
  );
  assert.equal(windowsSuccess.sent, true);
  assert.match(windowsScript, /Ready for input/);
  assert.doesNotMatch(windowsScript, /private prompt|repository|session/i);

  const windowsFailure = deliverCompletionNotification(
    { supported: true, kind: "windows-toast", label: "test Windows" },
    () => {},
    () => ({ status: 1, signal: null, output: [], pid: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }) as never
  );
  assert.equal(windowsFailure.sent, false);
  assert.match(windowsFailure.error ?? "", /exited 1/);
});

test("settings default off, reject invalid values, and expose their source", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "completion-notifications-"));
  try {
    const enabledPath = path.join(directory, "enabled.json");
    await writeFile(enabledPath, '{"enabled":true}\n');
    const enabled = readCompletionNotificationSettings(enabledPath);
    assert.equal(enabled.enabled, true);
    assert.match(enabled.source, /explicit:/);

    const defaultPath = path.join(directory, "default.json");
    await writeFile(defaultPath, '{}\n');
    assert.equal(readCompletionNotificationSettings(defaultPath).enabled, false);

    const invalidPath = path.join(directory, "invalid.json");
    await writeFile(invalidPath, '{"enabled":"yes"}\n');
    assert.throws(() => readCompletionNotificationSettings(invalidPath), /enabled must be a boolean/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one user-only command persists on/off, reports status, and tests even while disabled", async () => {
  const harness = createHarness({ enabled: false });
  const { context, notifications } = createContext();
  const command = harness.fake.commands.get(COMPLETION_NOTIFICATION_COMMAND_NAME);
  assert.ok(command);

  await command("status", context);
  assert.match(notifications.at(-1)?.message ?? "", /Enabled: no/);
  await command("on", context);
  assert.match(notifications.at(-1)?.message ?? "", /enabled/);
  await command("off", context);
  assert.match(notifications.at(-1)?.message ?? "", /disabled/);
  await command("test", context);
  assert.equal(harness.deliveries.length, 1);
  assert.match(notifications.at(-1)?.message ?? "", /test sent/);

  const headless = createContext({ mode: "print" });
  await command("on", headless.context);
  assert.match(headless.notifications.at(-1)?.message ?? "", /requires interactive Pi TUI mode/);
});

test("status text discloses generic content, fixed threshold, and unsupported no-op", () => {
  const settings: CompletionNotificationSettings = { enabled: true, source: "test" };
  const text = buildCompletionNotificationStatusText({
    enabled: settings.enabled,
    settingsSource: settings.source,
    transport: {
      supported: false,
      kind: "unsupported",
      label: "none",
      reason: "no tested transport"
    },
    activeRun: false,
    deferredJobCount: 0,
    sentCount: 0,
    lastOutcome: "none"
  });
  assert.match(text, /Minimum duration: 30 seconds/);
  assert.match(text, /generic title\/body only/);
  assert.match(text, /unsupported \(no tested transport\)/);
});
