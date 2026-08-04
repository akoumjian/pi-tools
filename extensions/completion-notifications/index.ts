import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import {
  type ConfigPath,
  formatConfigPath,
  readPiToolsJsonConfigSource,
  writeAgentExtensionConfig
} from "../_shared/config.js";
import { getAsyncShellCompletionBarrier } from "../async-shell/index.js";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputSource,
  MessageStartEvent
} from "@earendil-works/pi-coding-agent";

export const COMPLETION_NOTIFICATION_COMMAND_NAME = "notify";
export const COMPLETION_NOTIFICATION_MINIMUM_DURATION_MS = 30_000;
export const COMPLETION_NOTIFICATION_TITLE = "Pi";
export const COMPLETION_NOTIFICATION_BODY = "Ready for input";

const COMPLETION_NOTIFICATION_CONFIG_FILE = "completion-notifications-settings.json";

type CompletionNotificationCommand = "status" | "on" | "off" | "test" | "help" | "invalid";
type WriteText = (text: string) => void;
type WindowsRunner = (script: string) => SpawnSyncReturns<Buffer>;

export type CompletionNotificationSettings = {
  enabled: boolean;
  source: string;
};

export type CompletionNotificationTransport =
  | {
    supported: true;
    kind: "osc9" | "osc777" | "osc99" | "windows-toast";
    label: string;
  }
  | {
    supported: false;
    kind: "unsupported";
    label: string;
    reason: string;
  };

export type CompletionNotificationDelivery = {
  sent: boolean;
  transport: string;
  error?: string;
};

export type CompletionNotificationRuntimeStatus = {
  enabled: boolean;
  settingsSource: string;
  transport: CompletionNotificationTransport;
  activeRun: boolean;
  deferredJobCount: number;
  sentCount: number;
  lastOutcome: string;
};

type PendingInput = {
  source: InputSource;
  atMs: number;
};

type ActiveRun = {
  startedAtMs: number;
  userInitiated: boolean;
  finalStopReason?: StopReason;
  relatedCompletionJobIds: Set<string>;
};

type DeferredNotification = {
  startedAtMs: number;
  expectedJobIds: Set<string>;
  deliveredJobIds: Set<string>;
};

type RuntimeState = {
  settings: CompletionNotificationSettings;
  nextInput?: PendingInput;
  activeRun?: ActiveRun;
  deferred?: DeferredNotification;
  sentCount: number;
  lastOutcome: string;
};

export type CompletionNotificationDependencies = {
  now: () => number;
  readSettings: () => CompletionNotificationSettings;
  writeEnabled: (enabled: boolean) => CompletionNotificationSettings;
  detectTransport: () => CompletionNotificationTransport;
  deliver: (transport: CompletionNotificationTransport) => CompletionNotificationDelivery;
  getAsyncBarrier: (
    context: Pick<ExtensionContext, "cwd" | "sessionManager">,
    startedAtMs: number
  ) => { jobIds: string[] };
};

export default function completionNotificationsExtension(api: ExtensionAPI): void {
  registerCompletionNotifications(api);
}

export function registerCompletionNotifications(
  api: ExtensionAPI,
  overrides: Partial<CompletionNotificationDependencies> = {}
): CompletionNotificationRuntimeStatus {
  const dependencies = createDependencies(overrides);
  const state: RuntimeState = {
    settings: dependencies.readSettings(),
    sentCount: 0,
    lastOutcome: "No eligible run has settled in this extension lifetime."
  };

  api.on("session_start", () => resetTransientState(state));
  api.on("session_shutdown", () => resetTransientState(state));

  api.on("input", (event) => {
    const atMs = dependencies.now();
    if (event.source === "interactive") {
      state.deferred = undefined;
    }

    if (state.activeRun !== undefined) {
      if (event.source === "interactive" && !state.activeRun.userInitiated) {
        state.activeRun.userInitiated = true;
        state.activeRun.startedAtMs = atMs;
      }
      return;
    }

    state.nextInput = { source: event.source, atMs };
  });

  api.on("agent_start", () => {
    if (state.activeRun !== undefined) return;
    const input = state.nextInput;
    state.nextInput = undefined;
    state.activeRun = {
      startedAtMs: input?.atMs ?? dependencies.now(),
      userInitiated: input?.source === "interactive",
      relatedCompletionJobIds: new Set()
    };
  });

  api.on("message_start", (event) => {
    const jobIds = asyncShellCompletionJobIds(event);
    if (jobIds.length === 0 || state.activeRun === undefined) return;
    for (const jobId of jobIds) state.activeRun.relatedCompletionJobIds.add(jobId);
  });

  api.on("agent_end", (event) => {
    if (state.activeRun === undefined) return;
    state.activeRun.finalStopReason = lastAssistantStopReason(event);
  });

  api.on("agent_settled", (_event, context) => {
    handleAgentSettled(state, dependencies, context);
  });

  api.registerCommand(COMPLETION_NOTIFICATION_COMMAND_NAME, {
    description: "Manage privacy-safe settled-run terminal notifications (on|off|status|test)",
    handler: async (args, context) => {
      handleCompletionNotificationCommand(state, dependencies, args, context);
    }
  });

  return runtimeStatus(state, dependencies.detectTransport());
}

function handleCompletionNotificationCommand(
  state: RuntimeState,
  dependencies: CompletionNotificationDependencies,
  rawArgs: string,
  context: ExtensionCommandContext
): void {
  const command = parseCompletionNotificationCommand(rawArgs);
  if (command === "help") {
    context.ui.notify(buildCompletionNotificationUsage(), "info");
    return;
  }
  if (command === "invalid") {
    context.ui.notify(buildCompletionNotificationUsage(), "warning");
    return;
  }
  if (command === "status") {
    context.ui.notify(buildCompletionNotificationStatusText(runtimeStatus(state, dependencies.detectTransport())), "info");
    return;
  }
  if (context.mode !== "tui") {
    context.ui.notify(`/notify ${command} requires interactive Pi TUI mode.`, "warning");
    return;
  }

  if (command === "on" || command === "off") {
    const enabled = command === "on";
    state.settings = dependencies.writeEnabled(enabled);
    if (!enabled) state.deferred = undefined;
    state.lastOutcome = enabled
      ? "Notifications enabled; waiting for an eligible settled run."
      : "Notifications disabled by the user."
    context.ui.notify(
      `Completion notifications ${enabled ? "enabled" : "disabled"}. Settings: ${state.settings.source}`,
      "info"
    );
    return;
  }

  const transport = dependencies.detectTransport();
  const delivery = dependencies.deliver(transport);
  state.lastOutcome = delivery.sent
    ? `Test notification sent through ${delivery.transport}.`
    : `Test notification not sent: ${delivery.error ?? "unsupported transport"}.`;
  context.ui.notify(
    delivery.sent
      ? `Completion notification test sent through ${delivery.transport}.`
      : `Completion notification test unavailable: ${delivery.error ?? "unsupported transport"}.`,
    delivery.sent ? "info" : "warning"
  );
}

export function parseCompletionNotificationCommand(rawArgs: string): CompletionNotificationCommand {
  const value = rawArgs.trim().toLowerCase();
  if (value === "" || value === "status") return "status";
  if (value === "on" || value === "off" || value === "test") return value;
  if (value === "--help" || value === "-h" || value === "help") return "help";
  return "invalid";
}

export function buildCompletionNotificationUsage(): string {
  return [
    "Usage: /notify [on|off|status|test]",
    "",
    "Notifications are default-off, TUI-only, generic, and provider-free. Eligible runs must settle successfully after at least 30 seconds."
  ].join("\n");
}

export function buildCompletionNotificationStatusText(status: CompletionNotificationRuntimeStatus): string {
  const transport = status.transport.supported
    ? `${status.transport.label} (${status.transport.kind})`
    : `unsupported (${status.transport.reason})`;
  return [
    "Completion notification status",
    "",
    `Enabled: ${status.enabled ? "yes" : "no"}`,
    `Settings: ${status.settingsSource}`,
    `Transport: ${transport}`,
    `Minimum duration: ${COMPLETION_NOTIFICATION_MINIMUM_DURATION_MS / 1000} seconds`,
    `Active tracked run: ${status.activeRun ? "yes" : "no"}`,
    `Deferred async-shell jobs: ${status.deferredJobCount}`,
    `Notifications sent this lifetime: ${status.sentCount}`,
    `Last outcome: ${status.lastOutcome}`,
    "Content: generic title/body only; prompts, paths, session names, repositories, models, and assistant text are never included."
  ].join("\n");
}

export function readCompletionNotificationSettings(settingsPath?: ConfigPath): CompletionNotificationSettings {
  const parsed = settingsPath === undefined
    ? readPiToolsJsonConfigSource(COMPLETION_NOTIFICATION_CONFIG_FILE, import.meta.url)
    : {
        path: settingsPath,
        source: "explicit" as const,
        data: JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>
      };
  if (parsed === undefined) {
    return { enabled: false, source: "built-in default" };
  }
  if (parsed.data.enabled !== undefined && typeof parsed.data.enabled !== "boolean") {
    throw new Error(`${formatConfigPath(parsed.path)} enabled must be a boolean.`);
  }
  return {
    enabled: parsed.data.enabled === true,
    source: `${parsed.source}:${formatConfigPath(parsed.path)}`
  };
}

export function detectCompletionNotificationTransport(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  stdoutIsTTY = process.stdout.isTTY === true
): CompletionNotificationTransport {
  if (!stdoutIsTTY) return unsupportedTransport("stdout is not an interactive terminal");
  if (environment.TMUX) return unsupportedTransport("tmux passthrough is intentionally not assumed");
  if (environment.ZELLIJ || environment.ZELLIJ_SESSION_NAME) {
    return unsupportedTransport("Zellij passthrough is intentionally not assumed");
  }

  if (environment.WT_SESSION && (platform === "win32" || environment.WSL_DISTRO_NAME || environment.WSL_INTEROP)) {
    return { supported: true, kind: "windows-toast", label: "Windows Terminal toast" };
  }
  if (environment.KITTY_WINDOW_ID) {
    return { supported: true, kind: "osc99", label: "Kitty OSC 99" };
  }

  const terminalProgram = environment.TERM_PROGRAM?.toLowerCase();
  if (terminalProgram === "iterm.app") {
    return { supported: true, kind: "osc9", label: `${environment.TERM_PROGRAM} OSC 9` };
  }
  if (terminalProgram === "wezterm" || terminalProgram === "ghostty") {
    return { supported: true, kind: "osc777", label: `${environment.TERM_PROGRAM} OSC 777` };
  }
  if (/^(?:rxvt|urxvt)/i.test(environment.TERM ?? "")) {
    return { supported: true, kind: "osc777", label: "rxvt OSC 777" };
  }

  return unsupportedTransport(
    terminalProgram === "warpterminal"
      ? "Warp completion delivery is intentionally left to host integration"
      : "no tested terminal notification transport was detected"
  );
}

export function deliverCompletionNotification(
  transport: CompletionNotificationTransport,
  write: WriteText = (text) => { process.stdout.write(text); },
  runWindows: WindowsRunner = defaultWindowsRunner
): CompletionNotificationDelivery {
  if (!transport.supported) {
    return { sent: false, transport: transport.label, error: transport.reason };
  }

  try {
    if (transport.kind === "osc9") {
      write(`\x1b]9;${COMPLETION_NOTIFICATION_TITLE}: ${COMPLETION_NOTIFICATION_BODY}\x07`);
      return { sent: true, transport: transport.label };
    }
    if (transport.kind === "osc777") {
      write(`\x1b]777;notify;${COMPLETION_NOTIFICATION_TITLE};${COMPLETION_NOTIFICATION_BODY}\x07`);
      return { sent: true, transport: transport.label };
    }
    if (transport.kind === "osc99") {
      write(`\x1b]99;i=pi-complete:d=0;${COMPLETION_NOTIFICATION_TITLE}\x1b\\`);
      write(`\x1b]99;i=pi-complete:p=body;${COMPLETION_NOTIFICATION_BODY}\x1b\\`);
      return { sent: true, transport: transport.label };
    }

    const result = runWindows(windowsToastScript());
    if (result.error) {
      return { sent: false, transport: transport.label, error: result.error.message };
    }
    if (result.status !== 0) {
      return { sent: false, transport: transport.label, error: `powershell.exe exited ${result.status ?? "without status"}` };
    }
    return { sent: true, transport: transport.label };
  } catch (error) {
    return {
      sent: false,
      transport: transport.label,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function asyncShellCompletionJobIds(event: MessageStartEvent): string[] {
  const message = event.message;
  if (message.role !== "custom" || message.customType !== "async-shell") return [];
  const details = message.details;
  if (!isRecord(details)) return [];
  if (typeof details.jobId === "string") return [details.jobId];
  if (!Array.isArray(details.jobs)) return [];
  return details.jobs.flatMap((job) => isRecord(job) && typeof job.jobId === "string" ? [job.jobId] : []);
}

function handleAgentSettled(
  state: RuntimeState,
  dependencies: CompletionNotificationDependencies,
  context: ExtensionContext
): void {
  const run = state.activeRun;
  state.activeRun = undefined;
  state.nextInput = undefined;
  if (run === undefined) {
    state.lastOutcome = "Suppressed: agent_settled had no tracked run."
    return;
  }

  if (state.deferred !== undefined) {
    const currentBarrierIds = new Set(
      dependencies.getAsyncBarrier(context, state.deferred.startedAtMs).jobIds
    );
    for (const jobId of state.deferred.expectedJobIds) {
      if (!state.deferred.deliveredJobIds.has(jobId) && !currentBarrierIds.has(jobId)) {
        state.deferred.expectedJobIds.delete(jobId);
      }
    }

    const relatedIds = Array.from(run.relatedCompletionJobIds)
      .filter((jobId) => state.deferred?.expectedJobIds.has(jobId));
    if (relatedIds.length > 0) {
      if (run.finalStopReason !== "stop") {
        state.deferred = undefined;
        state.lastOutcome = `Suppressed: async-shell completion follow-up ended with ${run.finalStopReason ?? "no assistant stop"}.`;
        return;
      }
      for (const jobId of relatedIds) state.deferred.deliveredJobIds.add(jobId);
      if (setContainsAll(state.deferred.deliveredJobIds, state.deferred.expectedJobIds)) {
        const startedAtMs = state.deferred.startedAtMs;
        state.deferred = undefined;
        emitEligibleNotification(state, dependencies, context, startedAtMs);
      } else {
        state.lastOutcome = `Deferred: ${state.deferred.expectedJobIds.size - state.deferred.deliveredJobIds.size} async-shell completion follow-up(s) remain.`;
      }
      return;
    }

    if (setContainsAll(state.deferred.deliveredJobIds, state.deferred.expectedJobIds)) {
      const startedAtMs = state.deferred.startedAtMs;
      state.deferred = undefined;
      if (run.finalStopReason === "stop") {
        emitEligibleNotification(state, dependencies, context, startedAtMs);
      } else {
        state.lastOutcome = `Suppressed: the run that cleared the async-shell barrier ended with ${run.finalStopReason ?? "no assistant stop"}.`;
      }
      return;
    }
  }

  if (!run.userInitiated) {
    state.lastOutcome = "Suppressed: settled run was not initiated by interactive user input."
    return;
  }
  if (run.finalStopReason !== "stop") {
    state.lastOutcome = `Suppressed: final assistant stop was ${run.finalStopReason ?? "unavailable"}.`;
    return;
  }
  if (!preflightEligible(state, dependencies, context)) return;

  const deliveredInRun = run.relatedCompletionJobIds;
  const barrierJobIds = dependencies.getAsyncBarrier(context, run.startedAtMs).jobIds
    .filter((jobId) => !deliveredInRun.has(jobId));
  if (barrierJobIds.length > 0) {
    state.deferred = {
      startedAtMs: run.startedAtMs,
      expectedJobIds: new Set(barrierJobIds),
      deliveredJobIds: new Set()
    };
    state.lastOutcome = `Deferred: waiting for ${barrierJobIds.length} async-shell completion follow-up(s).`;
    return;
  }

  emitEligibleNotification(state, dependencies, context, run.startedAtMs);
}

function preflightEligible(
  state: RuntimeState,
  dependencies: CompletionNotificationDependencies,
  context: ExtensionContext
): boolean {
  if (!state.settings.enabled) {
    state.lastOutcome = "Suppressed: notifications are disabled."
    return false;
  }
  if (context.mode !== "tui") {
    state.lastOutcome = `Suppressed: ${context.mode} mode is not interactive TUI.`;
    return false;
  }
  if (!context.isIdle() || context.hasPendingMessages()) {
    state.lastOutcome = "Suppressed: the run is not fully idle or messages remain queued."
    return false;
  }
  const transport = dependencies.detectTransport();
  if (!transport.supported) {
    state.lastOutcome = `Suppressed: ${transport.reason}.`;
    return false;
  }
  return true;
}

function emitEligibleNotification(
  state: RuntimeState,
  dependencies: CompletionNotificationDependencies,
  context: ExtensionContext,
  startedAtMs: number
): void {
  if (!preflightEligible(state, dependencies, context)) return;
  const durationMs = dependencies.now() - startedAtMs;
  if (durationMs < COMPLETION_NOTIFICATION_MINIMUM_DURATION_MS) {
    state.lastOutcome = `Suppressed: settled after ${Math.max(0, durationMs)} ms, below the ${COMPLETION_NOTIFICATION_MINIMUM_DURATION_MS} ms threshold.`;
    return;
  }

  const delivery = dependencies.deliver(dependencies.detectTransport());
  if (!delivery.sent) {
    state.lastOutcome = `Suppressed: notification delivery failed (${delivery.error ?? "unknown error"}).`;
    return;
  }
  state.sentCount += 1;
  state.lastOutcome = `Sent through ${delivery.transport} after ${durationMs} ms.`;
}

function lastAssistantStopReason(event: AgentEndEvent): StopReason | undefined {
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index];
    if (message.role === "assistant") return (message as AssistantMessage).stopReason;
  }
  return undefined;
}

function runtimeStatus(
  state: RuntimeState,
  transport: CompletionNotificationTransport
): CompletionNotificationRuntimeStatus {
  return {
    enabled: state.settings.enabled,
    settingsSource: state.settings.source,
    transport,
    activeRun: state.activeRun !== undefined,
    deferredJobCount: state.deferred === undefined
      ? 0
      : state.deferred.expectedJobIds.size - state.deferred.deliveredJobIds.size,
    sentCount: state.sentCount,
    lastOutcome: state.lastOutcome
  };
}

function resetTransientState(state: RuntimeState): void {
  state.nextInput = undefined;
  state.activeRun = undefined;
  state.deferred = undefined;
}

function createDependencies(
  overrides: Partial<CompletionNotificationDependencies>
): CompletionNotificationDependencies {
  return {
    now: overrides.now ?? Date.now,
    readSettings: overrides.readSettings ?? (() => readCompletionNotificationSettings()),
    writeEnabled: overrides.writeEnabled ?? ((enabled) => {
      const configPath = writeAgentExtensionConfig(COMPLETION_NOTIFICATION_CONFIG_FILE, { enabled });
      return { enabled, source: `agent:${configPath}` };
    }),
    detectTransport: overrides.detectTransport ?? (() => detectCompletionNotificationTransport()),
    deliver: overrides.deliver ?? ((transport) => deliverCompletionNotification(transport)),
    getAsyncBarrier: overrides.getAsyncBarrier ?? getAsyncShellCompletionBarrier
  };
}

function setContainsAll(values: Set<string>, expected: Set<string>): boolean {
  for (const value of expected) {
    if (!values.has(value)) return false;
  }
  return true;
}

function unsupportedTransport(reason: string): CompletionNotificationTransport {
  return { supported: false, kind: "unsupported", label: "none", reason };
}

function windowsToastScript(): string {
  const type = "Windows.UI.Notifications";
  const manager = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  return [
    `${manager} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${COMPLETION_NOTIFICATION_BODY}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${COMPLETION_NOTIFICATION_TITLE}').Show(${toast})`
  ].join("; ");
}

function defaultWindowsRunner(script: string): SpawnSyncReturns<Buffer> {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "buffer",
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
