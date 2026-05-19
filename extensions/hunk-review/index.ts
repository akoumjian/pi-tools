import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@earendil-works/pi-ai";
import {
  defineTool,
  getAgentDir,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatConfigPath, readPiToolsJsonConfigSource, readPiToolsTextConfig, writeAgentExtensionConfig, type ConfigPath } from "../_shared/config.js";
import { registerCommandWithAliases } from "../_shared/deprecated-command.js";
import { resolveNativeToolPath } from "../native-tools/index.js";

export type DiffScope = "repo" | "touched";
export type DiffLauncherId = "auto" | "iterm" | "manual" | "external" | "ghostty" | "kitty" | "wezterm" | "tmux";
export type HunkReviewMode = "open" | "repo" | "touched" | "review";

export type HunkReviewSettings = {
  hunkBin?: string;
  defaultLauncher: DiffLauncherId;
  followDebounceMs: number;
  maxTouchedFiles: number;
  allowAgentLaunch: boolean;
  configSource: string;
};

export type HunkReviewSessionRef = {
  repo: string;
  launcher: DiffLauncherId;
  command: string;
  mode: HunkReviewMode;
  scope: DiffScope;
  startedAt: string;
  sessionId?: string;
  dryRun?: boolean;
};

export type HunkReviewStateSnapshot = {
  version: 1;
  updatedAt: string;
  followEnabled?: boolean;
  followDebounceMs?: number;
  activeRepo?: string;
  activeRepoPinned?: boolean;
  lastMode: HunkReviewMode;
  lastScope: DiffScope;
  lastLauncher?: DiffLauncherId;
  touchedFilesByRepo: Record<string, string[]>;
  sessionsByRepo: Record<string, HunkReviewSessionRef>;
};

export type HunkReviewState = {
  updatedAt: string;
  followEnabled: boolean;
  followDebounceMs: number;
  activeRepo?: string;
  activeRepoPinned: boolean;
  lastMode: HunkReviewMode;
  lastScope: DiffScope;
  lastLauncher?: DiffLauncherId;
  touchedFilesByRepo: Map<string, Set<string>>;
  sessionsByRepo: Map<string, HunkReviewSessionRef>;
};

export type HunkBinaryStatus = {
  requested?: string;
  resolved?: string;
  available: boolean;
  version?: string;
  error?: string;
};

export type LauncherDetection = {
  id: DiffLauncherId;
  available: boolean;
  reason: string;
};

export type HunkReviewStatusDetails = {
  followEnabled: boolean;
  followDebounceMs: number;
  activeRepo?: string;
  activeRepoPinned: boolean;
  lastMode: HunkReviewMode;
  lastScope: DiffScope;
  lastLauncher?: DiffLauncherId;
  settings: HunkReviewSettings;
  hunk: HunkBinaryStatus;
  launchers: LauncherDetection[];
  touchedRepos: Array<{ repo: string; files: string[] }>;
  sessions: HunkReviewSessionRef[];
  hunkSessions?: unknown;
  hunkSessionsError?: string;
};

type TrackedFile = {
  repo: string;
  repoPath: string;
  resolvedPath: string;
};

export type MutationTarget = {
  path: string;
  line?: number;
};

type FollowTarget = TrackedFile & {
  line?: number;
};

type HunkCommandResult = {
  command: string;
  args: string[];
  cwd?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type HunkSessionInfo = {
  sessionId: string;
  repoRoot?: string;
  cwd?: string;
  launchedAt?: string;
  title?: string;
};

type LaunchSpec = {
  repo: string;
  hunkBin: string;
  hunkArgs: string[];
  launcher: DiffLauncherId;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
};

type LaunchResult = {
  launcher: DiffLauncherId;
  resolvedLauncher: DiffLauncherId;
  launched: boolean;
  reused: boolean;
  reloaded: boolean;
  sessionId?: string;
  command: string;
  reloadCommand?: string;
  appleScript?: string;
  message: string;
};

type OpenArgs = {
  help: boolean;
  repo?: string;
  launcher?: DiffLauncherId;
  dryRun: boolean;
};

type FocusArgs = {
  help: boolean;
  repo?: string;
  file?: string;
  line?: number;
  hunk?: number;
  oldLine?: number;
  newLine?: number;
};

type HunkFocusSelector = { label: "hunk" | "old-line" | "new-line"; value: number };

type HunkFocusParams = {
  file?: string;
  hunk?: number;
  oldLine?: number;
  newLine?: number;
};

type ResolvedHunkFocus = {
  file: string;
  selector: HunkFocusSelector;
};

type SetupArgs = {
  help: boolean;
  hunkBin?: string;
  launcher?: DiffLauncherId;
  followDebounceMs?: number;
  allowAgentLaunch?: boolean;
};

type FollowArgs = {
  help: boolean;
  action: "on" | "off" | "status";
  delayMs?: number;
};

type GuidanceArgs = {
  help: boolean;
  action: "status" | "print" | "install" | "remove";
  dryRun: boolean;
};

type HunkAgentGuidanceState = "missing" | "installed" | "modified" | "present-unmarked";

type HunkAgentGuidanceInspection = {
  state: HunkAgentGuidanceState;
  targetPath: string;
};

type HunkAgentGuidanceTextUpdate = {
  content: string;
  changed: boolean;
  state: HunkAgentGuidanceState;
};

type HunkAgentGuidanceBlockRange = {
  start: number;
  end: number;
};

type SwitchArgs = {
  help: boolean;
  auto: boolean;
  repo?: string;
};

type CloseArgs = {
  help: boolean;
  repo?: string;
};

const HunkSessionParams = Type.Object({
  repo: Type.Optional(Type.String({ minLength: 1, description: "Optional repository path. Defaults to the active/touched/current repo." })),
  launcher: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("iterm"), Type.Literal("manual")], { description: "Launcher to use if a Hunk session must be created. auto prefers iTerm2 when Pi is running there." })),
  file: Type.Optional(Type.String({ minLength: 1, description: "Optional file to focus after the repo-wide Hunk session is ready. Relative paths are resolved inside the selected repo." })),
  newLine: Type.Optional(Type.Number({ minimum: 1, description: "Optional new-side line to focus when file is provided. Defaults to 1 when file is provided without a selector." })),
  oldLine: Type.Optional(Type.Number({ minimum: 1, description: "Optional old-side line to focus when file is provided. Use only one of newLine, oldLine, or hunk." })),
  hunk: Type.Optional(Type.Number({ minimum: 1, description: "Optional hunk number to focus when file is provided. Use only one of hunk, newLine, or oldLine." }))
}, { additionalProperties: false });

type HunkSessionInput = Static<typeof HunkSessionParams>;

type HunkOpenDetails = {
  repo: string;
  launcher: DiffLauncherId;
  resolvedLauncher: DiffLauncherId;
  launched: boolean;
  reused: boolean;
  reloaded: boolean;
  sessionId?: string;
  dryRun: boolean;
  command: string;
  reloadCommand?: string;
  pathspecs: string[];
  focused: boolean;
  focusCommand?: string;
  message: string;
};

type RenderTheme = {
  fg(name: string, text: string): string;
  bold(text: string): string;
};

const HUNK_REVIEW_CONFIG_FILE = "hunk-review-settings.json";
const HUNK_REVIEW_AGENT_GUIDANCE_FILE = "hunk-review-guidance.md";
const HUNK_AGENT_GUIDANCE_START = "<!-- akoumjian-pi-tools:hunk-code-review-guidance:start -->";
const HUNK_AGENT_GUIDANCE_END = "<!-- akoumjian-pi-tools:hunk-code-review-guidance:end -->";
const HUNK_REVIEW_STATE_ENTRY_TYPE = "hunk-review-state";
const STATUS_KEY = "hunk-review";
const DEFAULT_MAX_TOUCHED_FILES = 80;
const MAX_TOUCHED_FILES_LIMIT = 500;
const DEFAULT_FOLLOW_DEBOUNCE_MS = 1200;
const MIN_FOLLOW_DEBOUNCE_MS = 100;
const MAX_FOLLOW_DEBOUNCE_MS = 10000;
const HUNK_COMMAND_TIMEOUT_MS = 5000;
const HUNK_SESSION_LIST_TIMEOUT_MS = 2500;
const HUNK_SESSION_DISCOVERY_TIMEOUT_MS = 2500;
const HUNK_SESSION_DISCOVERY_INTERVAL_MS = 100;
let runtimeState = createInitialState();
let followTimer: NodeJS.Timeout | undefined;
let pendingFollowTarget: FollowTarget | undefined;
const warnedMissingFollowSessionRepos = new Set<string>();

export default function hunkReviewExtension(api: ExtensionAPI): void {
  registerDiffTools(api);
  registerDiffCommands(api);

  api.on("session_start", (_event, context) => {
    restoreRuntimeState(context);
    updateHunkReviewStatus(context);
  });

  api.on("session_tree", (_event, context) => {
    restoreRuntimeState(context);
    updateHunkReviewStatus(context);
  });

  api.on("tool_result", (event, context) => {
    trackSuccessfulMutationResult(api, event, context);
  });

  api.on("session_shutdown", () => {
    clearFollowTimer();
    warnedMissingFollowSessionRepos.clear();
  });
}

function registerDiffTools(api: ExtensionAPI): void {
  api.registerTool(defineTool({
    name: "hunk_session",
    label: "Hunk Session",
    description: [
      "Get or create this Pi session's repo-wide Hunk session for the active repository and return its sessionId.",
      "Use this to show the user Hunk diffs or before driving Hunk with direct `hunk session ...` CLI commands from the hunk-review skill; pass the returned sessionId positionally to avoid repo ambiguity.",
      "If this Pi session has no remembered active Hunk session for the repo, Pi creates one with the configured local `hunk diff --watch` window workflow, which may open the visible Hunk window. Optional file/newLine/oldLine/hunk params focus the repo-wide session after it is ready. Result details shape: { repo, launcher, resolvedLauncher, launched, reused, reloaded, sessionId, dryRun, command, reloadCommand, pathspecs, focused, focusCommand, message }."
    ].join(" "),
    promptSnippet: "Get or create this Pi session's Hunk session for user-visible review and direct CLI control.",
    promptGuidelines: [
      "Use hunk_session to show the user meaningful code-change checkpoints or to get this Pi session's sessionId for direct `hunk session navigate|context|review|comment ...` commands from the hunk-review skill. Skip it for trivial edits.",
      "When focusing a specific file, pass file plus newLine/oldLine/hunk so Pi keeps the Hunk source repo-wide and focuses via navigation. After it returns, use the returned sessionId positionally in Hunk CLI commands; avoid --repo if multiple Hunk sessions may exist for a repo.",
      "Do not run /hunk:* slash commands yourself; they are user-facing controls. Keep chat as the primary explanation channel; add Hunk comments only for sparse persistent notes."
    ],
    parameters: HunkSessionParams,
    executionMode: "sequential",
    renderShell: "self",
    async execute(_toolCallId, params, _signal, _onUpdate, context): Promise<AgentToolResult<HunkOpenDetails>> {
      return hunkSessionTool(api, context, params);
    },
    renderCall(args, theme) {
      return new Text(claudeToolCall("Hunk Session", `${args.repo ?? "active repo"} · ${args.launcher ?? "auto"}`, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return renderHunkToolResult(result, options, theme, context, "Hunk session ready");
    }
  }));
}

function registerDiffCommands(api: ExtensionAPI): void {
  registerCommandWithAliases(api, "hunk:setup", {
    description: "Persist Hunk defaults for this machine (usage: /hunk:setup --hunk-bin <path> --launcher auto|iterm|manual).",
    handler: async (args, context) => handleSetupCommand(args, context)
  }, []);

  registerCommandWithAliases(api, "hunk:doctor", {
    description: "Diagnose Hunk binary availability, launcher detection, skill registration hints, and Hunk review state.",
    handler: async (_args, context) => {
      context.ui.notify(buildDoctorText(context), "info");
    }
  }, []);

  registerCommandWithAliases(api, "hunk:status", {
    description: "Show Hunk review status.",
    handler: async (_args, context) => {
      context.ui.notify(buildHunkReviewStatusText(buildHunkReviewStatusDetails(context, { includeHunkSessions: false })), "info");
    }
  }, []);

  registerCommandWithAliases(api, "hunk:switch", {
    description: "Switch the active repo for Hunk commands (usage: /hunk:switch <repo>|--auto).",
    handler: async (args, context) => handleSwitchCommand(api, args, context)
  }, []);

  registerCommandWithAliases(api, "hunk:open", {
    description: "Open Hunk live diff for the active repo (usage: /hunk:open [--repo <path>] [--launcher auto|iterm|manual] [--dry-run]).",
    handler: async (args, context) => handleOpenCommand(api, args, context)
  }, []);

  registerCommandWithAliases(api, "hunk:close", {
    description: "Close Pi's remembered Hunk view for a repo; close the terminal pane manually if needed.",
    handler: async (args, context) => handleCloseCommand(api, args, context)
  }, []);

  registerCommandWithAliases(api, "hunk:follow", {
    description: "Follow tool edits in an open Hunk view (usage: /hunk:follow on|off|status [--delay-ms <ms>]).",
    handler: async (args, context) => handleFollowCommand(api, args, context)
  }, []);

  registerCommandWithAliases(api, "hunk:guidance", {
    description: "Print or install optional Hunk Code Review Guidance in the global AGENTS.md (usage: /hunk:guidance status|print|install|remove [--dry-run]).",
    handler: async (args, context) => handleGuidanceCommand(args, context)
  }, []);

  registerCommandWithAliases(api, "hunk:focus", {
    description: "Focus Hunk on a file, line, or hunk (usage: /hunk:focus <file[:line]> [--repo <path>] [--hunk <n>|--old-line <n>|--new-line <n>]).",
    handler: async (args, context) => handleFocusCommand(api, args, context)
  }, []);
}

export function readHunkReviewSettings(settingsPath?: ConfigPath): HunkReviewSettings {
  const parsed = settingsPath === undefined
    ? readPiToolsJsonConfigSource(HUNK_REVIEW_CONFIG_FILE, import.meta.url)
    : { path: settingsPath, source: "explicit" as const, data: JSON.parse(readConfigText(settingsPath)) as Record<string, unknown> };

  if (parsed === undefined) {
    return defaultHunkReviewSettings("built-in defaults");
  }

  if (!isRecord(parsed.data)) {
    throw new Error(`${formatConfigPath(parsed.path)} must contain a JSON object.`);
  }

  const settings = defaultHunkReviewSettings(`${parsed.source}:${formatConfigPath(parsed.path)}`);
  const hunkBin = readOptionalString(parsed.data.hunkBin, parsed.path, "hunkBin");
  const defaultLauncher = readOptionalLauncher(parsed.data.defaultLauncher, parsed.path) ?? settings.defaultLauncher;
  const followDebounceMs = readOptionalFollowDebounceMs(parsed.data.followDebounceMs, parsed.path) ?? settings.followDebounceMs;
  const allowAgentLaunch = readOptionalBoolean(parsed.data.allowAgentLaunch, parsed.path, "allowAgentLaunch") ?? settings.allowAgentLaunch;
  const maxTouchedFiles = readOptionalMaxTouchedFiles(parsed.data.maxTouchedFiles, parsed.path) ?? settings.maxTouchedFiles;

  return {
    hunkBin,
    defaultLauncher,
    followDebounceMs,
    allowAgentLaunch,
    maxTouchedFiles,
    configSource: settings.configSource
  };
}

function defaultHunkReviewSettings(configSource: string): HunkReviewSettings {
  return {
    defaultLauncher: "auto",
    followDebounceMs: DEFAULT_FOLLOW_DEBOUNCE_MS,
    maxTouchedFiles: DEFAULT_MAX_TOUCHED_FILES,
    allowAgentLaunch: true,
    configSource
  };
}

function handleSetupCommand(rawArgs: string, context: ExtensionCommandContext): void {
  let args: SetupArgs;
  try {
    args = parseSetupArgs(rawArgs);
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
    return;
  }

  if (args.help) {
    context.ui.notify(buildSetupUsage(), "info");
    return;
  }

  const current = readHunkReviewSettings();
  const value: Record<string, unknown> = {
    defaultLauncher: args.launcher ?? current.defaultLauncher,
    followDebounceMs: args.followDebounceMs ?? current.followDebounceMs,
    maxTouchedFiles: current.maxTouchedFiles,
    allowAgentLaunch: args.allowAgentLaunch ?? current.allowAgentLaunch
  };
  if (args.hunkBin ?? current.hunkBin) {
    value.hunkBin = args.hunkBin ?? current.hunkBin;
  }

  const written = writeAgentExtensionConfig(HUNK_REVIEW_CONFIG_FILE, value);
  context.ui.notify(`Wrote Hunk settings to ${written}. Run /hunk:doctor to verify.`, "info");
}

function handleSwitchCommand(api: ExtensionAPI, rawArgs: string, context: ExtensionCommandContext): void {
  let args: SwitchArgs;
  try {
    args = parseSwitchArgs(rawArgs);
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
    return;
  }

  if (args.help) {
    context.ui.notify(buildSwitchUsage(), "info");
    return;
  }

  if (args.auto) {
    runtimeState.activeRepoPinned = false;
    runtimeState.activeRepo = undefined;
    runtimeState.updatedAt = new Date().toISOString();
    persistRuntimeState(api);
    updateHunkReviewStatus(context);
    context.ui.notify("Hunk repo switching is automatic again.", "info");
    return;
  }

  if (args.repo === undefined) {
    context.ui.notify(buildSwitchStatusText(), "info");
    return;
  }

  try {
    const repo = resolveRepoArgument(context.cwd, args.repo);
    runtimeState.activeRepo = repo;
    runtimeState.activeRepoPinned = true;
    runtimeState.updatedAt = new Date().toISOString();
    persistRuntimeState(api);
    updateHunkReviewStatus(context);
    context.ui.notify(`Active Hunk repo: ${repo}. Use /hunk:switch --auto to resume automatic switching.`, "info");
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
  }
}

function handleFollowCommand(api: ExtensionAPI, rawArgs: string, context: ExtensionCommandContext): void {
  let args: FollowArgs;
  try {
    args = parseFollowArgs(rawArgs);
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
    return;
  }

  if (args.help) {
    context.ui.notify(buildFollowUsage(), "info");
    return;
  }

  if (args.delayMs !== undefined) {
    runtimeState.followDebounceMs = args.delayMs;
  }

  if (args.action === "status") {
    context.ui.notify(`Follow mode is ${runtimeState.followEnabled ? "on" : "off"}. Delay: ${runtimeState.followDebounceMs}ms.`, "info");
    return;
  }

  runtimeState.followEnabled = args.action === "on";
  if (!runtimeState.followEnabled) {
    clearFollowTimer();
    warnedMissingFollowSessionRepos.clear();
  }
  runtimeState.updatedAt = new Date().toISOString();
  persistRuntimeState(api);
  updateHunkReviewStatus(context);
  const hasHunkView = hasNavigableHunkSession(runtimeState);
  context.ui.notify(
    buildFollowModeMessage(runtimeState.followEnabled, runtimeState.followDebounceMs, hasHunkView),
    runtimeState.followEnabled && !hasHunkView ? "warning" : "info"
  );
}

function handleGuidanceCommand(rawArgs: string, context: ExtensionCommandContext): void {
  let args: GuidanceArgs;
  try {
    args = parseGuidanceArgs(rawArgs);
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
    return;
  }

  if (args.help) {
    context.ui.notify(buildGuidanceUsage(), "info");
    return;
  }

  try {
    const snippet = readHunkAgentGuidanceSnippet();
    const targetPath = hunkAgentGuidanceTargetPath();
    const currentContent = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";

    if (args.action === "print") {
      context.ui.notify(snippet.trimEnd(), "info");
      return;
    }

    if (args.action === "status") {
      const inspection = inspectHunkAgentGuidanceText(currentContent, targetPath, snippet);
      context.ui.notify(buildHunkAgentGuidanceStatusText(inspection), inspection.state === "modified" ? "warning" : "info");
      return;
    }

    if (args.action === "remove") {
      const update = removeHunkAgentGuidanceText(currentContent);
      if (!update.changed) {
        context.ui.notify(`No marked Hunk Code Review Guidance block is installed in ${targetPath}.`, "info");
        return;
      }
      if (args.dryRun) {
        context.ui.notify(`Would remove the marked Hunk Code Review Guidance block from ${targetPath}.`, "info");
        return;
      }
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, update.content, "utf8");
      context.ui.notify(`Removed the marked Hunk Code Review Guidance block from ${targetPath}. Run /reload or restart Pi to unload AGENTS.md changes.`, "info");
      return;
    }

    const update = upsertHunkAgentGuidanceText(currentContent, snippet);
    if (!update.changed) {
      const extra = update.state === "present-unmarked" ? " It is present without package markers, so Pi left it unchanged." : "";
      context.ui.notify(`Hunk Code Review Guidance is already ${describeHunkAgentGuidanceState(update.state)} in ${targetPath}.${extra}`, update.state === "present-unmarked" ? "warning" : "info");
      return;
    }
    if (args.dryRun) {
      context.ui.notify(`Would install/update this marked block in ${targetPath}:\n\n${buildHunkAgentGuidanceBlock(snippet).trimEnd()}`, "info");
      return;
    }
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, update.content, "utf8");
    context.ui.notify(`Installed Hunk Code Review Guidance in ${targetPath}. Run /reload or restart Pi to load AGENTS.md changes.`, "info");
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
  }
}

export function readHunkAgentGuidanceSnippet(): string {
  const text = readPiToolsTextConfig(HUNK_REVIEW_AGENT_GUIDANCE_FILE, import.meta.url);
  if (text === undefined) {
    throw new Error(`Missing Hunk Code Review Guidance file: ${HUNK_REVIEW_AGENT_GUIDANCE_FILE}.`);
  }
  return `${text.trim()}\n`;
}

export function buildHunkAgentGuidanceBlock(snippet = readHunkAgentGuidanceSnippet()): string {
  return `${HUNK_AGENT_GUIDANCE_START}\n${snippet.trimEnd()}\n${HUNK_AGENT_GUIDANCE_END}\n`;
}

export function inspectHunkAgentGuidanceText(content: string, targetPath: string, snippet = readHunkAgentGuidanceSnippet()): HunkAgentGuidanceInspection {
  const range = hunkAgentGuidanceBlockRange(content);
  if (range === undefined) {
    return {
      state: containsHunkAgentGuidanceSnippet(content, snippet) ? "present-unmarked" : "missing",
      targetPath
    };
  }

  const inner = content.slice(range.start + HUNK_AGENT_GUIDANCE_START.length, range.end - HUNK_AGENT_GUIDANCE_END.length);
  return {
    state: normalizeGuidanceText(inner) === normalizeGuidanceText(snippet) ? "installed" : "modified",
    targetPath
  };
}

export function upsertHunkAgentGuidanceText(content: string, snippet = readHunkAgentGuidanceSnippet()): HunkAgentGuidanceTextUpdate {
  const range = hunkAgentGuidanceBlockRange(content);
  if (range === undefined) {
    if (containsHunkAgentGuidanceSnippet(content, snippet)) {
      return { content, changed: false, state: "present-unmarked" };
    }
    return { content: appendGuidanceBlock(content, buildHunkAgentGuidanceBlock(snippet)), changed: true, state: "installed" };
  }

  const updated = replaceGuidanceRange(content, range, buildHunkAgentGuidanceBlock(snippet));
  return { content: updated, changed: updated !== content, state: "installed" };
}

export function removeHunkAgentGuidanceText(content: string): HunkAgentGuidanceTextUpdate {
  const range = hunkAgentGuidanceBlockRange(content);
  if (range === undefined) {
    return { content, changed: false, state: "missing" };
  }

  const updated = replaceGuidanceRange(content, range, "");
  return { content: updated, changed: updated !== content, state: "missing" };
}

function hunkAgentGuidanceTargetPath(): string {
  return path.join(getAgentDir(), "AGENTS.md");
}

function hunkAgentGuidanceBlockRange(content: string): HunkAgentGuidanceBlockRange | undefined {
  const start = content.indexOf(HUNK_AGENT_GUIDANCE_START);
  const endMarker = content.indexOf(HUNK_AGENT_GUIDANCE_END);
  if (start === -1 && endMarker === -1) {
    return undefined;
  }
  if (start === -1 || endMarker === -1 || endMarker < start) {
    throw new Error("AGENTS.md contains an incomplete Hunk Code Review Guidance marker block.");
  }
  return { start, end: endMarker + HUNK_AGENT_GUIDANCE_END.length };
}

function containsHunkAgentGuidanceSnippet(content: string, snippet: string): boolean {
  return normalizeGuidanceText(content).includes(normalizeGuidanceText(snippet));
}

function normalizeGuidanceText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function appendGuidanceBlock(content: string, block: string): string {
  const prefix = content.trimEnd();
  if (!prefix) {
    return block;
  }
  return `${prefix}\n\n${block}`;
}

function replaceGuidanceRange(content: string, range: HunkAgentGuidanceBlockRange, replacement: string): string {
  const before = content.slice(0, range.start).trimEnd();
  const after = content.slice(range.end).trimStart();
  const parts = [before, replacement.trimEnd(), after].filter((part) => part.length > 0);
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
}

function buildHunkAgentGuidanceStatusText(inspection: HunkAgentGuidanceInspection): string {
  return [
    `Hunk Code Review Guidance is ${describeHunkAgentGuidanceState(inspection.state)}.`,
    `Target: ${inspection.targetPath}`,
    inspection.state === "missing" ? "Run /hunk:guidance install to append the package-managed block." : undefined,
    inspection.state === "modified" ? "Run /hunk:guidance install to replace the package-managed block, or edit AGENTS.md manually if the local changes are intentional." : undefined,
    inspection.state === "present-unmarked" ? "The snippet is present without package markers; Pi will not rewrite it automatically." : undefined
  ].filter((line): line is string => line !== undefined).join("\n");
}

function describeHunkAgentGuidanceState(state: HunkAgentGuidanceState): string {
  switch (state) {
    case "missing":
      return "not installed";
    case "installed":
      return "installed";
    case "modified":
      return "installed with local edits";
    case "present-unmarked":
      return "present without package markers";
  }
}

function hunkSessionTool(api: ExtensionAPI, context: ExtensionContext, input: HunkSessionInput): AgentToolResult<HunkOpenDetails> {
  const result = openHunkView(api, context, {
    repo: input.repo,
    launcher: input.launcher,
    dryRun: false,
    requireAgentLaunchPermission: true,
    requireSessionId: true,
    focus: {
      file: input.file,
      hunk: input.hunk,
      oldLine: input.oldLine,
      newLine: input.newLine
    }
  });
  return {
    content: [{ type: "text", text: result.message }],
    details: result
  };
}

function renderHunkToolResult(
  result: AgentToolResult<HunkOpenDetails>,
  options: { isPartial: boolean },
  theme: RenderTheme,
  context: { isError?: boolean } | undefined,
  fallback: string
): Text {
  if (context?.isError === true) {
    return new Text(claudeToolResult(`error: ${toolResultText(result)}`, "error", theme), 0, 0);
  }
  if (options.isPartial) {
    return new Text(claudeToolResult("opening Hunk", "warning", theme), 0, 0);
  }
  const details = result.details;
  if (details === undefined) {
    return new Text(claudeToolResult(fallback, "muted", theme), 0, 0);
  }
  const status = details.reloaded ? "refreshed" : details.reused ? "reused" : details.launched ? "opened" : details.dryRun ? "dry run" : "manual command";
  const kind = details.launched || details.reused ? "success" : "warning";
  const session = details.sessionId ? ` · #${shortSessionId(details.sessionId)}` : "";
  return new Text(claudeToolResult(`${status} · ${formatRepoLabel(details.repo)} · ${details.resolvedLauncher}${session}`, kind, theme), 0, 0);
}

function openHunkView(
  api: ExtensionAPI,
  context: ExtensionContext,
  options: {
    repo?: string;
    launcher?: DiffLauncherId;
    dryRun: boolean;
    requireAgentLaunchPermission: boolean;
    requireSessionId?: boolean;
    focus?: HunkFocusParams;
  }
): HunkOpenDetails {
  const settings = readHunkReviewSettings();
  const repo = resolveRepoForCommand(context, options.repo);
  const scope: DiffScope = "repo";
  const pathspecs: string[] = [];
  const focus = resolveOptionalHunkFocus(repo, options.focus);

  const hunkBin = hunkBinaryOrThrow(settings, options.dryRun);
  const hunkArgs = buildHunkDiffArgs({ watch: true, pathspecs });
  const launchSpec = {
    repo,
    hunkBin,
    hunkArgs,
    launcher: options.launcher ?? settings.defaultLauncher,
    dryRun: options.dryRun,
    env: process.env,
    platform: process.platform
  };
  const existingSessions = options.dryRun ? [] : listHunkSessions(hunkBin, repo);
  const rememberedSessionId = runtimeState.sessionsByRepo.get(repo)?.sessionId?.trim();
  const reusableSession = selectRememberedHunkSession(existingSessions, repo, rememberedSessionId);
  const staleRememberedSessionId = !options.dryRun && rememberedSessionId !== undefined && reusableSession === undefined
    ? rememberedSessionId
    : undefined;
  if (staleRememberedSessionId !== undefined) {
    forgetRememberedHunkSession(api, context, repo);
  }
  if (reusableSession === undefined && options.requireAgentLaunchPermission && !options.dryRun && !settings.allowAgentLaunch) {
    throw new Error(staleRememberedSessionId === undefined
      ? `No Hunk session is remembered for ${repo} in this Pi session, and agent Hunk launches are disabled. Run /hunk:open yourself or /hunk:setup --allow-agent-launch on.`
      : `Remembered Hunk session ${staleRememberedSessionId} is no longer active for ${repo}, and agent Hunk launches are disabled. Run /hunk:open yourself or /hunk:setup --allow-agent-launch on.`);
  }
  let launch = reusableSession === undefined ? launchHunk(launchSpec) : reuseHunkSession(launchSpec, reusableSession);
  if (launch.launched && launch.sessionId === undefined) {
    const discoveredSession = findNewHunkSession(hunkBin, repo, existingSessions.map((session) => session.sessionId));
    if (discoveredSession !== undefined) {
      launch = attachSessionToLaunch(launch, discoveredSession);
    }
  }
  if (options.requireSessionId === true && !options.dryRun && launch.sessionId === undefined) {
    throw new Error(`Hunk session was not available for ${repo}. Run /hunk:open from an environment that can launch Hunk, or configure /hunk:setup --launcher iterm.`);
  }

  let effectiveLaunch = launch;
  let focused = false;
  let focusCommand: string | undefined;
  if (focus !== undefined && !options.dryRun && launch.sessionId !== undefined) {
    const navigation = navigateHunkSessionWithRepoReload(hunkBin, repo, launch.sessionId, focus.file, focus.selector, "Hunk focus");
    focused = true;
    focusCommand = formatHunkCommand(hunkBin, navigation.args, repo);
    const focusMessage = `${navigation.reloaded ? "Refreshed repo-wide Hunk source and focused" : "Focused"} Hunk on ${focus.file} ${focus.selector.label} ${focus.selector.value}.`;
    effectiveLaunch = {
      ...launch,
      reloaded: launch.reloaded || navigation.reloaded,
      reloadCommand: launch.reloadCommand ?? navigation.reloadCommand,
      message: `${launch.message} ${focusMessage}`
    };
  }

  rememberLaunchedSession(api, context, repo, effectiveLaunch, "open", scope, options.dryRun);
  return {
    repo,
    launcher: effectiveLaunch.launcher,
    resolvedLauncher: effectiveLaunch.resolvedLauncher,
    launched: effectiveLaunch.launched,
    reused: effectiveLaunch.reused,
    reloaded: effectiveLaunch.reloaded,
    sessionId: effectiveLaunch.sessionId,
    dryRun: options.dryRun,
    command: effectiveLaunch.command,
    reloadCommand: effectiveLaunch.reloadCommand,
    pathspecs,
    focused,
    focusCommand,
    message: effectiveLaunch.message
  };
}

async function handleOpenCommand(api: ExtensionAPI, rawArgs: string, context: ExtensionCommandContext): Promise<void> {
  let args: OpenArgs;
  try {
    args = parseOpenArgs(rawArgs);
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
    return;
  }

  if (args.help) {
    context.ui.notify(buildOpenUsage(), "info");
    return;
  }

  try {
    const result = openHunkView(api, context, {
      repo: args.repo,
      launcher: args.launcher,
      dryRun: args.dryRun,
      requireAgentLaunchPermission: false
    });
    context.ui.notify(result.message, result.launched || result.reused ? "info" : "warning");
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
  }
}

async function handleFocusCommand(api: ExtensionAPI, rawArgs: string, context: ExtensionCommandContext): Promise<void> {
  let args: FocusArgs;
  try {
    args = parseFocusArgs(rawArgs);
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
    return;
  }

  if (args.help) {
    context.ui.notify(buildFocusUsage(), "info");
    return;
  }

  if (!args.file) {
    context.ui.notify(buildFocusUsage(), "error");
    return;
  }

  try {
    const result = focusHunkSession(context, {
      repo: args.repo,
      file: args.file,
      line: args.line,
      hunk: args.hunk,
      side: args.oldLine !== undefined ? "old" : "new"
    });
    persistRuntimeState(api);
    updateHunkReviewStatus(context);
    context.ui.notify(result.message, "info");
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
  }
}

function handleCloseCommand(api: ExtensionAPI, rawArgs: string, context: ExtensionCommandContext): void {
  let args: CloseArgs;
  try {
    args = parseCloseArgs(rawArgs);
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
    return;
  }

  if (args.help) {
    context.ui.notify(buildCloseUsage(), "info");
    return;
  }

  try {
    const repo = args.repo ? resolveRepoForCommand(context, args.repo) : runtimeState.activeRepo;
    if (repo === undefined) {
      context.ui.notify("No active Hunk repo is remembered.", "warning");
      return;
    }
    const hadSession = runtimeState.sessionsByRepo.delete(repo);
    warnedMissingFollowSessionRepos.delete(repo);
    if (pendingFollowTarget?.repo === repo) {
      clearFollowTimer();
    }
    if (runtimeState.activeRepo === repo) {
      runtimeState.activeRepo = undefined;
      runtimeState.activeRepoPinned = false;
    }
    runtimeState.updatedAt = new Date().toISOString();
    persistRuntimeState(api);
    updateHunkReviewStatus(context);
    context.ui.notify(hadSession
      ? `Closed the Hunk review extension's remembered Hunk view for ${repo}. Close the Hunk terminal pane manually if it is still open.`
      : `No remembered Hunk view for ${repo}.`, "info");
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
  }
}

type HunkFocusInput = {
  repo?: string;
  file: string;
  line?: number;
  hunk?: number;
  side?: "old" | "new";
};

type HunkSessionActionResult = {
  message: string;
  repo: string;
  command: string;
  result: HunkCommandResult;
};

function focusHunkSession(context: ExtensionContext, params: HunkFocusInput): HunkSessionActionResult {
  const settings = readHunkReviewSettings();
  const repo = resolveRepoForCommand(context, params.repo);
  const file = normalizeHunkFilePath(repo, params.file);
  const selector = resolveFocusSelector(params);
  const hunkBin = hunkBinaryOrThrow(settings, false);
  const session = runtimeState.sessionsByRepo.get(repo);
  const sessionId = resolveHunkNavigationSessionId(hunkBin, repo, session?.sessionId);
  const navigation = navigateHunkSessionWithRepoReload(hunkBin, repo, sessionId, file, selector, "Hunk focus");
  const navigatedSessionId = navigation.sessionId ?? sessionId;
  if (navigatedSessionId !== undefined && session?.sessionId !== navigatedSessionId) {
    rememberDiscoveredHunkSession(repo, hunkBin, navigatedSessionId);
  }
  if (navigation.reloaded) {
    rememberRepoWideSourceCommand(repo, hunkBin);
  }
  runtimeState.activeRepo = repo;
  runtimeState.updatedAt = new Date().toISOString();
  const prefix = navigation.reloaded ? "Refreshed repo-wide Hunk source and focused" : "Focused";
  return {
    message: `${prefix} Hunk on ${file} ${selector.label} ${selector.value}. Use the Hunk skill for review guidance or ask for feedback in chat.`,
    repo,
    command: formatHunkCommand(hunkBin, navigation.args, repo),
    result: navigation.result
  };
}

function trackSuccessfulMutationResult(api: ExtensionAPI, event: ToolResultEvent, context: ExtensionContext): void {
  if (event.isError) {
    return;
  }

  const targets = extractMutationTargetsFromToolResult(event);
  if (targets.length === 0) {
    return;
  }

  const settings = readHunkReviewSettings();
  const tracked = recordTouchedFiles(runtimeState, context.cwd, targets.map((target) => target.path), settings.maxTouchedFiles);
  if (tracked.length === 0) {
    return;
  }

  persistRuntimeState(api);
  updateHunkReviewStatus(context);
  scheduleFollowTarget(api, context, targets);
}

export function extractTouchedPathsFromToolCall(event: Pick<ToolCallEvent, "toolName" | "input">): string[] {
  return extractMutationTargetsFromToolNameAndInput(event.toolName, event.input).map((target) => target.path);
}

export function extractTouchedPathsFromToolResult(event: Pick<ToolResultEvent, "toolName" | "input" | "details">): string[] {
  return extractMutationTargetsFromToolResult(event).map((target) => target.path);
}

export function extractMutationTargetsFromToolResult(event: Pick<ToolResultEvent, "toolName" | "input" | "details">): MutationTarget[] {
  const detailTargets = extractMutationTargetsFromToolDetails(event.toolName, event.details);
  if (detailTargets.length > 0) {
    return detailTargets;
  }
  return extractMutationTargetsFromToolNameAndInput(event.toolName, event.input);
}

function extractMutationTargetsFromToolNameAndInput(toolName: string, input: unknown): MutationTarget[] {
  if (!isRecord(input)) {
    return [];
  }

  if (toolName === "write_many" && Array.isArray(input.writes)) {
    return input.writes.flatMap((item) => isRecord(item) && typeof item.path === "string" ? [{ path: item.path, line: 1 }] : []);
  }

  if (toolName === "edit_many" && Array.isArray(input.files)) {
    return input.files.flatMap((item) => isRecord(item) && typeof item.path === "string" ? [{ path: item.path }] : []);
  }

  if (toolName === "write" && typeof input.path === "string") {
    return [{ path: input.path, line: 1 }];
  }

  if (toolName === "edit" && typeof input.path === "string") {
    return [{ path: input.path }];
  }

  return [];
}

function extractMutationTargetsFromToolDetails(toolName: string, details: unknown): MutationTarget[] {
  if (!isRecord(details)) {
    return [];
  }

  if ((toolName === "write_many" || toolName === "edit_many" || toolName === "apply_reviewed_mutation") && Array.isArray(details.files)) {
    return details.files.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }
      const targetPath = typeof item.resolvedPath === "string" ? item.resolvedPath : typeof item.path === "string" ? item.path : undefined;
      if (targetPath === undefined) {
        return [];
      }
      return [{ path: targetPath, line: mutationTargetLine(toolName, item) }];
    });
  }

  return [];
}

function mutationTargetLine(toolName: string, item: Record<string, unknown>): number | undefined {
  const ranges = item.ranges;
  if (Array.isArray(ranges)) {
    const firstRange = ranges.find(isLineRange);
    if (firstRange !== undefined) {
      return firstRange.startLine;
    }
  }
  return toolName === "write_many" ? 1 : undefined;
}

export function recordTouchedFiles(state: HunkReviewState, cwd: string, rawPaths: readonly string[], maxFiles: number): TrackedFile[] {
  const tracked = resolveTrackedFiles(cwd, rawPaths);
  const cap = clampMaxTouchedFiles(maxFiles);
  let changed = false;

  for (const file of tracked) {
    const files = state.touchedFilesByRepo.get(file.repo) ?? new Set<string>();
    if (!state.touchedFilesByRepo.has(file.repo)) {
      state.touchedFilesByRepo.set(file.repo, files);
    }
    if (!files.has(file.repoPath) && files.size < cap) {
      files.add(file.repoPath);
      changed = true;
    }
    if (!state.activeRepoPinned) {
      state.activeRepo = file.repo;
    }
  }

  if (changed) {
    state.updatedAt = new Date().toISOString();
  }

  return tracked;
}

export function resolveTrackedFiles(cwd: string, rawPaths: readonly string[]): TrackedFile[] {
  return resolveTrackedTargets(cwd, rawPaths.map((path) => ({ path })));
}

export function resolveTrackedTargets(cwd: string, targets: readonly MutationTarget[]): FollowTarget[] {
  const seen = new Set<string>();
  const tracked: FollowTarget[] = [];

  for (const target of targets) {
    const resolvedPath = resolveNativeToolPath(cwd, target.path);
    if (seen.has(resolvedPath)) {
      continue;
    }
    seen.add(resolvedPath);

    const repo = findNearestRepoRoot(resolvedPath);
    if (repo === undefined) {
      continue;
    }
    const repoPath = repoRelativePath(repo, resolvedPath);
    if (repoPath === undefined) {
      continue;
    }
    tracked.push({ repo, repoPath, resolvedPath, line: target.line });
  }

  return tracked;
}

export function selectFollowTarget(state: HunkReviewState, cwd: string, targets: readonly MutationTarget[]): FollowTarget | undefined {
  const tracked = resolveTrackedTargets(cwd, targets);
  if (tracked.length === 0) {
    return undefined;
  }
  if (state.activeRepoPinned && state.activeRepo !== undefined) {
    return tracked.filter((target) => target.repo === state.activeRepo).at(-1);
  }
  return tracked.at(-1);
}

function scheduleFollowTarget(api: ExtensionAPI, context: ExtensionContext, targets: readonly MutationTarget[]): void {
  if (!runtimeState.followEnabled) {
    return;
  }

  const target = selectFollowTarget(runtimeState, context.cwd, targets);
  if (target === undefined) {
    return;
  }
  clearFollowTimer();
  pendingFollowTarget = target;
  followTimer = setTimeout(() => {
    flushFollowTarget(api, context);
  }, runtimeState.followDebounceMs);
  followTimer.unref?.();
  updateHunkReviewStatus(context);
}

function flushFollowTarget(api: ExtensionAPI, context: ExtensionContext): void {
  const target = pendingFollowTarget;
  pendingFollowTarget = undefined;
  followTimer = undefined;
  if (target === undefined || !runtimeState.followEnabled) {
    return;
  }

  const session = runtimeState.sessionsByRepo.get(target.repo);
  if (session === undefined || session.dryRun) {
    warnMissingFollowSession(context, target.repo);
    return;
  }

  try {
    const settings = readHunkReviewSettings();
    const hunkBin = hunkBinaryOrThrow(settings, false);
    const selector = { label: "new-line" as const, value: target.line ?? 1 };
    const navigation = navigateHunkSessionWithRepoReload(hunkBin, target.repo, session.sessionId, target.repoPath, selector, "Hunk follow");
    if (navigation.reloaded) {
      rememberRepoWideSourceCommand(target.repo, hunkBin);
    }
    if (!runtimeState.activeRepoPinned) {
      runtimeState.activeRepo = target.repo;
    }
    runtimeState.updatedAt = new Date().toISOString();
    persistRuntimeState(api);
    updateHunkReviewStatus(context);
  } catch (error) {
    context.ui.notify(`Hunk follow failed: ${errorMessage(error)}`, "warning");
  }
}

function clearFollowTimer(): void {
  if (followTimer !== undefined) {
    clearTimeout(followTimer);
    followTimer = undefined;
  }
  pendingFollowTarget = undefined;
}

function hasNavigableHunkSession(state: HunkReviewState): boolean {
  return Array.from(state.sessionsByRepo.values()).some((session) => !session.dryRun);
}

export function buildFollowModeMessage(followEnabled: boolean, followDebounceMs: number, hasHunkView: boolean): string {
  if (!followEnabled) {
    return "Follow mode is off.";
  }

  const base = `Follow mode is on. Hunk will move to tool-edited files after ${followDebounceMs}ms of quiet time.`;
  if (hasHunkView) {
    return base;
  }
  return `${base} No launched Hunk view is remembered yet; run /hunk:open before expecting navigation.`;
}

function warnMissingFollowSession(context: ExtensionContext, repo: string): void {
  if (warnedMissingFollowSessionRepos.has(repo)) {
    return;
  }
  warnedMissingFollowSessionRepos.add(repo);
  context.ui.notify(`Follow mode is on, but no launched Hunk view is remembered for ${repo}. Run /hunk:open before expecting navigation.`, "warning");
}

export function findNearestRepoRoot(startPath: string): string | undefined {
  let dir = existingDirectoryOrParent(path.resolve(startPath));

  while (true) {
    if (existsSync(path.join(dir, ".jj"))) {
      return realpathMaybe(dir);
    }
    if (existsSync(path.join(dir, ".git"))) {
      return realpathMaybe(dir);
    }
    if (existsSync(path.join(dir, ".hg"))) {
      return realpathMaybe(dir);
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function repoRelativePath(repo: string, resolvedPath: string): string | undefined {
  const relative = path.relative(realpathMaybe(repo), realpathMaybe(resolvedPath));
  if (relative === "") {
    return undefined;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return toPosixPath(relative);
}

export function snapshotState(state: HunkReviewState = runtimeState): HunkReviewStateSnapshot {
  return {
    version: 1,
    updatedAt: state.updatedAt,
    followEnabled: state.followEnabled,
    followDebounceMs: state.followDebounceMs,
    activeRepo: state.activeRepo,
    activeRepoPinned: state.activeRepoPinned,
    lastMode: state.lastMode,
    lastScope: state.lastScope,
    lastLauncher: state.lastLauncher,
    touchedFilesByRepo: Object.fromEntries(Array.from(state.touchedFilesByRepo.entries()).map(([repo, files]) => [repo, Array.from(files).sort()])),
    sessionsByRepo: Object.fromEntries(Array.from(state.sessionsByRepo.entries()))
  };
}

export function restoreStateFromEntries(entries: readonly unknown[], fallbackScope: DiffScope = "repo", fallbackFollowDebounceMs: number = DEFAULT_FOLLOW_DEBOUNCE_MS): HunkReviewState {
  const snapshot = latestStateSnapshot(entries);
  return snapshot === undefined ? createInitialState(fallbackScope, fallbackFollowDebounceMs) : stateFromSnapshot(snapshot, fallbackScope, fallbackFollowDebounceMs);
}

function restoreRuntimeState(context: ExtensionContext): void {
  const settings = readHunkReviewSettings();
  runtimeState = restoreStateFromEntries(context.sessionManager.getBranch(), "repo", settings.followDebounceMs);
}

function persistRuntimeState(api: Pick<ExtensionAPI, "appendEntry">): void {
  api.appendEntry(HUNK_REVIEW_STATE_ENTRY_TYPE, snapshotState(runtimeState));
}

function latestStateSnapshot(entries: readonly unknown[]): HunkReviewStateSnapshot | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== HUNK_REVIEW_STATE_ENTRY_TYPE) {
      continue;
    }
    if (isHunkReviewStateSnapshot(entry.data)) {
      return entry.data;
    }
  }
  return undefined;
}

function stateFromSnapshot(snapshot: HunkReviewStateSnapshot, fallbackScope: DiffScope, fallbackFollowDebounceMs: number): HunkReviewState {
  return {
    updatedAt: snapshot.updatedAt,
    followEnabled: snapshot.followEnabled ?? false,
    followDebounceMs: snapshot.followDebounceMs ?? fallbackFollowDebounceMs,
    activeRepo: snapshot.activeRepo,
    activeRepoPinned: snapshot.activeRepoPinned ?? false,
    lastMode: snapshot.lastMode,
    lastScope: snapshot.lastScope ?? fallbackScope,
    lastLauncher: snapshot.lastLauncher,
    touchedFilesByRepo: new Map(Object.entries(snapshot.touchedFilesByRepo).map(([repo, files]) => [repo, new Set(files)])),
    sessionsByRepo: new Map(Object.entries(snapshot.sessionsByRepo))
  };
}

function createInitialState(lastScope: DiffScope = "repo", followDebounceMs: number = DEFAULT_FOLLOW_DEBOUNCE_MS): HunkReviewState {
  return {
    updatedAt: new Date().toISOString(),
    followEnabled: false,
    followDebounceMs,
    activeRepoPinned: false,
    lastMode: lastScope,
    lastScope,
    touchedFilesByRepo: new Map(),
    sessionsByRepo: new Map()
  };
}

export function buildHunkDiffArgs(options: { base?: string; watch?: boolean; pathspecs?: readonly string[] }): string[] {
  const args = ["diff"];
  if (options.watch === true) {
    args.push("--watch");
  }
  if (options.base !== undefined) {
    args.push(options.base);
  }
  if ((options.pathspecs?.length ?? 0) > 0) {
    args.push("--", ...(options.pathspecs ?? []));
  }
  return args;
}

export function buildHunkSessionNavigateArgs(options: {
  repo: string;
  sessionId?: string;
  file: string;
  selector: { label: "hunk" | "old-line" | "new-line"; value: number };
}): string[] {
  const selectorFlag = options.selector.label === "hunk" ? "--hunk" : options.selector.label === "old-line" ? "--old-line" : "--new-line";
  const targetArgs = options.sessionId?.trim() ? [options.sessionId.trim()] : ["--repo", options.repo];
  return ["session", "navigate", ...targetArgs, "--file", options.file, selectorFlag, String(options.selector.value), "--json"];
}

export function buildHunkSessionReloadArgs(options: { repo: string; sessionId?: string; pathspecs?: readonly string[] }): string[] {
  const targetArgs = options.sessionId?.trim() ? [options.sessionId.trim()] : ["--repo", options.repo];
  const diffArgs = (options.pathspecs?.length ?? 0) > 0 ? ["diff", "--", ...(options.pathspecs ?? [])] : ["diff"];
  return ["session", "reload", ...targetArgs, "--source", options.repo, "--", ...diffArgs];
}

export function itermSessionIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const rawSessionId = firstNonEmpty(env.ITERM_SESSION_ID, env.TERM_SESSION_ID);
  const sessionId = rawSessionId?.match(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/)?.[0];
  return sessionId?.toUpperCase();
}

export function buildItermSplitAppleScript(shellCommand: string, targetSessionId?: string): string {
  if (targetSessionId === undefined) {
    return [
      "tell application \"iTerm2\"",
      "  activate",
      "  tell current window",
      "    tell current session",
      "      set newSession to (split vertically with default profile)",
      "    end tell",
      "    tell newSession",
      `      write text ${appleScriptString(shellCommand)}`,
      "    end tell",
      "  end tell",
      "end tell"
    ].join("\n");
  }

  return [
    "tell application \"iTerm2\"",
    "  set targetSession to missing value",
    "  repeat with aWindow in windows",
    "    repeat with aTab in tabs of aWindow",
    "      repeat with aSession in sessions of aTab",
    `        if id of aSession is ${appleScriptString(targetSessionId)} then`,
    "          set targetSession to aSession",
    "          exit repeat",
    "        end if",
    "      end repeat",
    "      if targetSession is not missing value then exit repeat",
    "    end repeat",
    "    if targetSession is not missing value then exit repeat",
    "  end repeat",
    "  if targetSession is missing value then error \"iTerm2 originating session was not found.\"",
    "  tell targetSession",
    "    set newSession to (split vertically with default profile)",
    "  end tell",
    "  tell newSession",
    `    write text ${appleScriptString(shellCommand)}`,
    "  end tell",
    "end tell"
  ].join("\n");
}

export function detectLaunchers(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): LauncherDetection[] {
  const isMac = platform === "darwin";
  return [
    {
      id: "iterm",
      available: isMac && typeof env.ITERM_SESSION_ID === "string" && env.ITERM_SESSION_ID.length > 0,
      reason: isMac
        ? (env.ITERM_SESSION_ID ? "ITERM_SESSION_ID is present" : "ITERM_SESSION_ID is not set")
        : "iTerm2 AppleScript launcher requires macOS"
    },
    { id: "manual", available: true, reason: "prints a command for the user to run in another pane/window" },
    { id: "external", available: false, reason: "not implemented yet; use iterm or manual" },
    { id: "ghostty", available: false, reason: "not implemented yet" },
    { id: "kitty", available: false, reason: "not implemented yet" },
    { id: "wezterm", available: false, reason: "not implemented yet" },
    { id: "tmux", available: false, reason: "not implemented yet; this workflow must not assume tmux" }
  ];
}

export function buildHunkBinaryStatus(settings: HunkReviewSettings, env: NodeJS.ProcessEnv = process.env): HunkBinaryStatus {
  const requested = firstNonEmpty(env.HUNK_BIN, settings.hunkBin);
  const resolved = resolveHunkExecutable(requested, env);
  if (resolved === undefined) {
    return {
      requested,
      available: false,
      error: requested
        ? `Configured Hunk binary was not found: ${requested}`
        : "Neither hunk nor hunkdiff was found on PATH. Install with `npm i -g hunkdiff` or `brew install modem-dev/tap/hunk`."
    };
  }

  const versionResult = spawnSync(resolved, ["--version"], { encoding: "utf8", env, timeout: HUNK_SESSION_LIST_TIMEOUT_MS });
  if (versionResult.error) {
    return {
      requested,
      resolved,
      available: false,
      error: versionResult.error.message
    };
  }

  return {
    requested,
    resolved,
    available: versionResult.status === 0,
    version: compactOneLine(versionResult.stdout || versionResult.stderr),
    error: versionResult.status === 0 ? undefined : compactOneLine(versionResult.stderr || versionResult.stdout)
  };
}

function resolveHunkExecutable(requested: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (requested !== undefined) {
    return resolveExecutable(requested, env);
  }
  return resolveExecutable("hunk", env) ?? resolveExecutable("hunkdiff", env);
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const expanded = expandHome(command.trim());
  if (expanded.length === 0) {
    return undefined;
  }
  if (expanded.includes("/") || path.isAbsolute(expanded)) {
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
    return existsSync(absolute) ? absolute : undefined;
  }

  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(expanded)}`], { encoding: "utf8", env, timeout: HUNK_SESSION_LIST_TIMEOUT_MS });
  if (result.status !== 0) {
    return undefined;
  }
  const found = result.stdout.trim().split(/\r?\n/)[0];
  return found.length > 0 ? found : undefined;
}

function listHunkSessions(hunkBin: string, repo: string): HunkSessionInfo[] {
  const result = runHunkCommand(hunkBin, ["session", "list", "--json"], repo, HUNK_SESSION_LIST_TIMEOUT_MS);
  assertHunkCommandOk(result, "Hunk session list");
  return parseHunkSessionList(parseJsonOrText(result.stdout));
}

export function parseHunkSessionList(value: unknown): HunkSessionInfo[] {
  const rawSessions = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.sessions) ? value.sessions : [];
  return rawSessions
    .map(readHunkSessionInfo)
    .filter((session): session is HunkSessionInfo => session !== undefined);
}

export function selectReusableHunkSession(sessions: readonly HunkSessionInfo[], repo: string): HunkSessionInfo | undefined {
  return selectNewestHunkSessionForRepo(sessions, repo);
}

export function selectRememberedHunkSession(sessions: readonly HunkSessionInfo[], repo: string, rememberedSessionId: string | undefined): HunkSessionInfo | undefined {
  const sessionId = rememberedSessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  const repoRoot = realpathMaybe(repo);
  return sessions.find((session) => session.sessionId === sessionId && hunkSessionRepoRoot(session) === repoRoot);
}

export function selectNewHunkSession(sessions: readonly HunkSessionInfo[], repo: string, existingSessionIds: readonly string[]): HunkSessionInfo | undefined {
  const existing = new Set(existingSessionIds);
  return selectNewestHunkSessionForRepo(sessions.filter((session) => !existing.has(session.sessionId)), repo);
}

function selectNewestHunkSessionForRepo(sessions: readonly HunkSessionInfo[], repo: string): HunkSessionInfo | undefined {
  const repoRoot = realpathMaybe(repo);
  return sessions
    .filter((session) => hunkSessionRepoRoot(session) === repoRoot)
    .sort((left, right) => hunkSessionTime(right) - hunkSessionTime(left))[0];
}

function readHunkSessionInfo(value: unknown): HunkSessionInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sessionId = readStringField(value, "sessionId");
  if (sessionId === undefined) {
    return undefined;
  }
  return {
    sessionId,
    repoRoot: readStringField(value, "repoRoot"),
    cwd: readStringField(value, "cwd"),
    launchedAt: readStringField(value, "launchedAt"),
    title: readStringField(value, "title")
  };
}

function readStringField(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function hunkSessionRepoRoot(session: HunkSessionInfo): string | undefined {
  const repoRoot = session.repoRoot ?? (session.cwd === undefined ? undefined : findNearestRepoRoot(session.cwd));
  return repoRoot === undefined ? undefined : realpathMaybe(repoRoot);
}

function hunkSessionTime(session: HunkSessionInfo): number {
  const parsed = Date.parse(session.launchedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function findNewHunkSession(hunkBin: string, repo: string, existingSessionIds: readonly string[]): HunkSessionInfo | undefined {
  const deadline = Date.now() + HUNK_SESSION_DISCOVERY_TIMEOUT_MS;
  do {
    const session = selectNewHunkSession(listHunkSessions(hunkBin, repo), repo, existingSessionIds);
    if (session !== undefined) {
      return session;
    }
    sleepSync(HUNK_SESSION_DISCOVERY_INTERVAL_MS);
  } while (Date.now() < deadline);
  return undefined;
}

function reuseHunkSession(spec: LaunchSpec, session: HunkSessionInfo): LaunchResult {
  const shellCommand = formatShellInvocation(spec.hunkBin, spec.hunkArgs, spec.repo);
  const resolvedLauncher = resolveLauncher(spec.launcher, spec.env, spec.platform);
  const reloadCommand = reloadHunkSessionToRepo(spec.hunkBin, spec.repo, session.sessionId, "Hunk session refresh");
  return {
    launcher: spec.launcher,
    resolvedLauncher,
    launched: false,
    reused: true,
    reloaded: true,
    sessionId: session.sessionId,
    command: shellCommand,
    reloadCommand,
    message: `Refreshed active Hunk session ${session.sessionId} for ${spec.repo}; no new pane opened.`
  };
}

export function attachSessionToLaunch(launch: LaunchResult, session: HunkSessionInfo): LaunchResult {
  return {
    ...launch,
    sessionId: session.sessionId,
    message: `${launch.message} Session: ${session.sessionId}.`
  };
}

export function launchHunk(spec: LaunchSpec): LaunchResult {
  const shellCommand = formatShellInvocation(spec.hunkBin, spec.hunkArgs, spec.repo);
  const resolvedLauncher = resolveLauncher(spec.launcher, spec.env, spec.platform);

  if (spec.dryRun || resolvedLauncher === "manual") {
    return {
      launcher: spec.launcher,
      resolvedLauncher,
      launched: false,
      reused: false,
      reloaded: false,
      command: shellCommand,
      message: [`Hunk command ${spec.dryRun ? "dry run" : "manual fallback"}:`, shellCommand].join("\n")
    };
  }

  if (resolvedLauncher !== "iterm") {
    throw new Error(`Launcher ${resolvedLauncher} is not implemented yet. Use --launcher iterm from iTerm2 or --launcher manual.`);
  }

  const appleScript = buildItermSplitAppleScript(shellCommand, itermSessionIdFromEnv(spec.env));
  const result = spawnSync("osascript", ["-e", appleScript], { encoding: "utf8", timeout: HUNK_COMMAND_TIMEOUT_MS });
  if (result.error || result.status !== 0) {
    throw new Error(`iTerm2 launcher failed: ${result.error?.message ?? compactOneLine(result.stderr || result.stdout)}`);
  }

  return {
    launcher: spec.launcher,
    resolvedLauncher,
    launched: true,
    reused: false,
    reloaded: false,
    command: shellCommand,
    appleScript,
    message: `Opened Hunk in an iTerm2 split for ${spec.repo}. Pi remains usable in this pane.`
  };
}

function resolveLauncher(launcher: DiffLauncherId, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): DiffLauncherId {
  if (launcher !== "auto") {
    return launcher;
  }
  return detectLaunchers(env, platform).some((item) => item.id === "iterm" && item.available) ? "iterm" : "manual";
}

export function formatHunkCommand(hunkBin: string, args: readonly string[], cwd?: string): string {
  return cwd === undefined ? [hunkBin, ...args].map(shellQuote).join(" ") : formatShellInvocation(hunkBin, args, cwd);
}

function formatShellInvocation(hunkBin: string, args: readonly string[], cwd: string): string {
  return `cd ${shellQuote(cwd)} && exec ${[hunkBin, ...args].map(shellQuote).join(" ")}`;
}

function runHunkCommand(hunkBin: string, args: readonly string[], cwd: string | undefined, timeout: number): HunkCommandResult {
  const result = spawnSync(hunkBin, [...args], { cwd, encoding: "utf8", timeout });
  return {
    command: hunkBin,
    args: [...args],
    cwd,
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message
  };
}

function assertHunkCommandOk(result: HunkCommandResult, action: string): void {
  if (result.exitCode === 0 && result.error === undefined) {
    return;
  }
  const detail = result.error ?? (compactOneLine(result.stderr || result.stdout) || `exit ${String(result.exitCode)}`);
  throw new Error(`${action} failed: ${detail}`);
}

function navigateHunkSessionWithRepoReload(
  hunkBin: string,
  repo: string,
  sessionId: string | undefined,
  file: string,
  selector: { label: "hunk" | "old-line" | "new-line"; value: number },
  action: string
): { args: string[]; result: HunkCommandResult; reloaded: boolean; reloadCommand?: string; sessionId?: string } {
  let effectiveSessionId = sessionId;
  let args = buildHunkSessionNavigateArgs({ repo, sessionId: effectiveSessionId, file, selector });
  let result = runHunkCommand(hunkBin, args, repo, HUNK_COMMAND_TIMEOUT_MS);
  const shouldRefresh = shouldRefreshHunkSourceForNavigate(result);
  const shouldDiscoverSession = effectiveSessionId === undefined && shouldDiscoverHunkSessionForNavigate(result);
  if (!shouldRefresh && !shouldDiscoverSession) {
    assertHunkCommandOk(result, action);
    return { args, result, reloaded: false, sessionId: effectiveSessionId };
  }

  if (effectiveSessionId === undefined) {
    effectiveSessionId = selectReusableHunkSession(listHunkSessions(hunkBin, repo), repo)?.sessionId;
    if (effectiveSessionId === undefined) {
      assertHunkCommandOk(result, action);
      return { args, result, reloaded: false };
    }
    args = buildHunkSessionNavigateArgs({ repo, sessionId: effectiveSessionId, file, selector });
  }

  const reloadCommand = reloadHunkSessionToRepo(hunkBin, repo, effectiveSessionId, `${action} repo refresh`);
  result = runHunkCommand(hunkBin, args, repo, HUNK_COMMAND_TIMEOUT_MS);
  assertHunkCommandOk(result, action);
  return { args, result, reloaded: true, reloadCommand, sessionId: effectiveSessionId };
}

function shouldRefreshHunkSourceForNavigate(result: HunkCommandResult): boolean {
  return /No diff file matches/.test(result.stderr) || /No diff file matches/.test(result.stdout);
}

function shouldDiscoverHunkSessionForNavigate(result: HunkCommandResult): boolean {
  return shouldRefreshHunkSourceForNavigate(result) || /No active session matches/.test(result.stderr) || /No active session matches/.test(result.stdout);
}

function resolveHunkNavigationSessionId(hunkBin: string, repo: string, rememberedSessionId: string | undefined): string | undefined {
  const trimmed = rememberedSessionId?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    return trimmed;
  }
  return selectReusableHunkSession(listHunkSessions(hunkBin, repo), repo)?.sessionId;
}

function forgetRememberedHunkSession(api: ExtensionAPI, context: ExtensionContext, repo: string): void {
  if (!runtimeState.sessionsByRepo.delete(repo)) {
    return;
  }
  warnedMissingFollowSessionRepos.delete(repo);
  runtimeState.updatedAt = new Date().toISOString();
  persistRuntimeState(api);
  updateHunkReviewStatus(context);
}

function rememberDiscoveredHunkSession(repo: string, hunkBin: string, sessionId: string): void {
  const existing = runtimeState.sessionsByRepo.get(repo);
  runtimeState.sessionsByRepo.set(repo, {
    repo,
    launcher: existing?.launcher ?? "manual",
    command: existing?.command ?? formatShellInvocation(hunkBin, buildHunkDiffArgs({ watch: true }), repo),
    mode: existing?.mode ?? "open",
    scope: "repo",
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    sessionId,
    dryRun: false
  });
}

function reloadHunkSessionToRepo(hunkBin: string, repo: string, sessionId: string, action: string): string {
  const args = buildHunkSessionReloadArgs({ repo, sessionId });
  const result = runHunkCommand(hunkBin, args, repo, HUNK_COMMAND_TIMEOUT_MS);
  assertHunkCommandOk(result, action);
  return formatHunkCommand(hunkBin, args, repo);
}

function rememberRepoWideSourceCommand(repo: string, hunkBin: string): void {
  const session = runtimeState.sessionsByRepo.get(repo);
  if (session === undefined) {
    return;
  }
  session.command = formatShellInvocation(hunkBin, buildHunkDiffArgs({ watch: true }), repo);
  session.scope = "repo";
}

function hunkBinaryOrThrow(settings: HunkReviewSettings, dryRun: boolean): string {
  const status = buildHunkBinaryStatus(settings);
  if (status.available && status.resolved) {
    return status.resolved;
  }
  if (dryRun) {
    return firstNonEmpty(status.requested, settings.hunkBin, "hunk") ?? "hunk";
  }
  throw new Error(status.error ?? "Hunk is not available. Install hunk or configure /hunk:setup --hunk-bin <path>.");
}

function buildHunkReviewStatusDetails(context: ExtensionContext, options: { includeHunkSessions: boolean }): HunkReviewStatusDetails {
  const settings = readHunkReviewSettings();
  const hunk = buildHunkBinaryStatus(settings);
  const details: HunkReviewStatusDetails = {
    followEnabled: runtimeState.followEnabled,
    followDebounceMs: runtimeState.followDebounceMs,
    activeRepo: runtimeState.activeRepo,
    activeRepoPinned: runtimeState.activeRepoPinned,
    lastMode: runtimeState.lastMode,
    lastScope: runtimeState.lastScope,
    lastLauncher: runtimeState.lastLauncher,
    settings,
    hunk,
    launchers: detectLaunchers(),
    touchedRepos: touchedReposDetails(),
    sessions: Array.from(runtimeState.sessionsByRepo.values())
  };

  if (options.includeHunkSessions && hunk.available && hunk.resolved) {
    const result = runHunkCommand(hunk.resolved, ["session", "list", "--json"], context.cwd, HUNK_SESSION_LIST_TIMEOUT_MS);
    if (result.exitCode === 0) {
      details.hunkSessions = parseJsonOrText(result.stdout);
    } else {
      details.hunkSessionsError = compactOneLine(result.stderr || result.stdout) || result.error;
    }
  }

  return details;
}

export function buildHunkReviewStatusText(details: HunkReviewStatusDetails): string {
  const touched = details.touchedRepos.length === 0
    ? ["Touched repos: none"]
    : ["Touched repos:", ...details.touchedRepos.map((repo) => `- ${repo.repo}: ${repo.files.length} file${repo.files.length === 1 ? "" : "s"}${repo.files.length > 0 ? ` (${repo.files.slice(0, 5).join(", ")}${repo.files.length > 5 ? ", ..." : ""})` : ""}`)];
  const sessions = details.sessions.length === 0
    ? ["Remembered Hunk sessions: none"]
    : ["Remembered Hunk sessions:", ...details.sessions.map((session) => `- ${session.repo}: ${session.mode} via ${session.launcher}${session.sessionId ? ` sessionId=${session.sessionId}` : ""}${session.dryRun ? " (dry-run/manual)" : ""}`)];
  const launchers = details.launchers.map((launcher) => `- ${launcher.id}: ${launcher.available ? "available" : "unavailable"} (${launcher.reason})`);
  return [
    "Hunk status",
    "",
    `Hunk view: ${details.sessions.length === 0 ? "closed/not remembered" : "open"}`,
    `Follow mode: ${details.followEnabled ? `on (${details.followDebounceMs}ms)` : "off"}`,
    `Active repo: ${details.activeRepo ?? "none"}${details.activeRepoPinned ? " (pinned)" : ""}`,
    `Last mode: ${details.lastMode}`,
    `Last launcher: ${details.lastLauncher ?? "none"}`,
    `Settings: ${details.settings.configSource}`,
    `Hunk: ${details.hunk.available ? `ok ${details.hunk.version ?? ""}`.trim() : `missing (${details.hunk.error ?? "not available"})`}`,
    "",
    "Launchers:",
    ...launchers,
    "",
    ...touched,
    "",
    ...sessions,
    details.hunkSessionsError ? `\nHunk session list error: ${details.hunkSessionsError}` : ""
  ].filter((line) => line !== "").join("\n");
}

function buildDoctorText(context: ExtensionContext): string {
  const details = buildHunkReviewStatusDetails(context, { includeHunkSessions: true });
  const skillPath = fileURLToPath(new URL("../../skills/hunk-review/SKILL.md", import.meta.url));
  return [
    buildHunkReviewStatusText(details),
    "",
    "Doctor checks",
    `- Hunk skill file: ${existsSync(skillPath) ? skillPath : `missing at ${skillPath}`}`,
    `- Hunk install hint: npm i -g hunkdiff  OR  brew install modem-dev/tap/hunk`,
    `- iTerm2 launcher: ${details.launchers.find((launcher) => launcher.id === "iterm")?.reason ?? "unknown"}`,
    `- Session API: ${details.hunkSessionsError ? `not reachable (${details.hunkSessionsError})` : details.hunkSessions !== undefined ? "reachable" : "not checked"}`,
    "- Pi-native multiplexing: not implemented yet; tracked as future work."
  ].join("\n");
}

function updateHunkReviewStatus(context: ExtensionContext): void {
  const repo = runtimeState.activeRepo === undefined ? "none" : formatRepoLabel(runtimeState.activeRepo);
  const hasOpenView = runtimeState.sessionsByRepo.size > 0;
  if (!runtimeState.followEnabled && !hasOpenView && runtimeState.activeRepo === undefined) {
    context.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const mode = runtimeState.followEnabled ? "follow" : hasOpenView ? "open" : "tracking";
  context.ui.setStatus(STATUS_KEY, `hunk ${mode} · ${repo}${runtimeState.activeRepoPinned ? " pinned" : ""}`);
}

function rememberLaunchedSession(
  api: ExtensionAPI,
  context: ExtensionContext,
  repo: string,
  launch: LaunchResult,
  mode: HunkReviewMode,
  scope: DiffScope,
  dryRun: boolean
): void {
  runtimeState.activeRepo = repo;
  runtimeState.lastLauncher = launch.resolvedLauncher;
  runtimeState.lastMode = mode;
  runtimeState.lastScope = scope;
  runtimeState.updatedAt = new Date().toISOString();
  runtimeState.sessionsByRepo.set(repo, {
    repo,
    launcher: launch.resolvedLauncher,
    command: launch.command,
    mode,
    scope,
    startedAt: runtimeState.updatedAt,
    sessionId: launch.sessionId,
    dryRun: dryRun || (!launch.launched && !launch.reused)
  });
  if ((launch.launched || launch.reused) && !dryRun) {
    warnedMissingFollowSessionRepos.delete(repo);
  }
  persistRuntimeState(api);
  updateHunkReviewStatus(context);
}

function resolveRepoForCommand(context: ExtensionContext, rawRepo: string | undefined): string {
  return rawRepo === undefined ? resolveActiveRepo(context.cwd) : resolveRepoArgument(context.cwd, rawRepo);
}

function resolveRepoArgument(cwd: string, rawRepo: string): string {
  const resolved = resolveNativeToolPath(cwd, rawRepo);
  const repo = findNearestRepoRoot(resolved);
  if (repo === undefined) {
    throw new Error(`No .jj, .git, or .hg repository root found at or above ${resolved}.`);
  }
  return repo;
}

function resolveActiveRepo(cwd: string): string {
  if (runtimeState.activeRepo !== undefined) {
    return runtimeState.activeRepo;
  }

  const trackedRepos = Array.from(runtimeState.touchedFilesByRepo.keys());
  if (trackedRepos.length === 1) {
    runtimeState.activeRepo = trackedRepos[0];
    return trackedRepos[0];
  }

  const cwdRepo = findNearestRepoRoot(cwd);
  if (cwdRepo !== undefined) {
    runtimeState.activeRepo = cwdRepo;
    return cwdRepo;
  }

  if (trackedRepos.length > 1) {
    throw new Error(`Multiple touched repos are tracked (${trackedRepos.join(", ")}). Pass --repo <path>.`);
  }

  throw new Error("No active repo is known. Edit files in a repo first or pass --repo <path>.");
}

function touchedReposDetails(): Array<{ repo: string; files: string[] }> {
  return Array.from(runtimeState.touchedFilesByRepo.entries())
    .map(([repo, files]) => ({ repo, files: Array.from(files).sort() }))
    .sort((left, right) => left.repo.localeCompare(right.repo));
}

function resolveFocusSelector(params: { hunk?: number; line?: number; side?: "old" | "new" }): HunkFocusSelector {
  const selectors = [params.hunk !== undefined, params.line !== undefined].filter(Boolean).length;
  if (selectors > 1) {
    throw new Error("Specify either hunk or line, not both.");
  }
  if (params.hunk !== undefined) {
    return { label: "hunk", value: params.hunk };
  }
  const line = params.line ?? 1;
  return { label: params.side === "old" ? "old-line" : "new-line", value: line };
}

function resolveOptionalHunkFocus(repo: string, params: HunkFocusParams | undefined): ResolvedHunkFocus | undefined {
  const hasSelector = params?.hunk !== undefined || params?.oldLine !== undefined || params?.newLine !== undefined;
  if (params?.file === undefined) {
    if (hasSelector) {
      throw new Error("Provide file when using hunk, oldLine, or newLine focus parameters.");
    }
    return undefined;
  }

  assertOptionalPositiveInteger(params.hunk, "hunk");
  assertOptionalPositiveInteger(params.oldLine, "oldLine");
  assertOptionalPositiveInteger(params.newLine, "newLine");

  const selectors: HunkFocusSelector[] = [];
  if (params.hunk !== undefined) {
    selectors.push({ label: "hunk", value: params.hunk });
  }
  if (params.oldLine !== undefined) {
    selectors.push({ label: "old-line", value: params.oldLine });
  }
  if (params.newLine !== undefined) {
    selectors.push({ label: "new-line", value: params.newLine });
  }
  if (selectors.length > 1) {
    throw new Error("Use only one focus selector: hunk, oldLine, or newLine.");
  }

  return {
    file: normalizeHunkFilePath(repo, params.file),
    selector: selectors[0] ?? { label: "new-line", value: 1 }
  };
}

function assertOptionalPositiveInteger(value: number | undefined, name: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function normalizeHunkFilePath(repo: string, requestedFile: string): string {
  if (!path.isAbsolute(requestedFile)) {
    return toPosixPath(requestedFile);
  }
  return repoRelativePath(repo, requestedFile) ?? requestedFile;
}

function parseSetupArgs(rawArgs: string): SetupArgs {
  const tokens = splitCommandArgs(rawArgs);
  const args: SetupArgs = { help: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") {
      return { help: true };
    }
    if (token === "--hunk-bin") {
      args.hunkBin = readOptionValue(tokens, ++index, token);
      continue;
    }
    if (token === "--launcher") {
      args.launcher = parseLauncher(readOptionValue(tokens, ++index, token));
      continue;
    }
    if (token === "--follow-delay-ms") {
      args.followDebounceMs = parseFollowDebounceMs(readOptionValue(tokens, ++index, token), token);
      continue;
    }
    if (token === "--allow-agent-launch") {
      args.allowAgentLaunch = parseOnOff(readOptionValue(tokens, ++index, token));
      continue;
    }
    throw new Error(`${buildSetupUsage()}\n\nUnknown option: ${token}`);
  }
  return args;
}

function parseSwitchArgs(rawArgs: string): SwitchArgs {
  const tokens = splitCommandArgs(rawArgs);
  const args: SwitchArgs = { help: false, auto: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") {
      return { help: true, auto: false };
    }
    if (token === "--auto") {
      args.auto = true;
      continue;
    }
    if (token === "--repo") {
      args.repo = readOptionValue(tokens, ++index, token);
      continue;
    }
    if (token.startsWith("-")) {
      throw new Error(`${buildSwitchUsage()}\n\nUnknown option: ${token}`);
    }
    if (args.repo !== undefined) {
      throw new Error(`${buildSwitchUsage()}\n\nOnly one repo may be provided.`);
    }
    args.repo = token;
  }
  if (args.auto && args.repo !== undefined) {
    throw new Error(`${buildSwitchUsage()}\n\nUse either --auto or a repo, not both.`);
  }
  return args;
}

function parseFollowArgs(rawArgs: string): FollowArgs {
  const tokens = splitCommandArgs(rawArgs);
  const args: FollowArgs = { help: false, action: "status" };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") {
      return { help: true, action: "status" };
    }
    if (token === "on" || token === "off" || token === "status") {
      args.action = token;
      continue;
    }
    if (token === "--delay-ms") {
      args.delayMs = parseFollowDebounceMs(readOptionValue(tokens, ++index, token), token);
      continue;
    }
    throw new Error(`${buildFollowUsage()}\n\nUnknown option: ${token}`);
  }
  return args;
}

function parseGuidanceArgs(rawArgs: string): GuidanceArgs {
  const tokens = splitCommandArgs(rawArgs);
  const args: GuidanceArgs = { help: false, action: "status", dryRun: false };
  let actionSeen = false;
  for (const token of tokens) {
    if (token === "--help" || token === "-h") {
      return { help: true, action: "status", dryRun: false };
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token === "status" || token === "print" || token === "install" || token === "remove") {
      if (actionSeen) {
        throw new Error(`${buildGuidanceUsage()}\n\nOnly one guidance action may be provided.`);
      }
      args.action = token;
      actionSeen = true;
      continue;
    }
    throw new Error(`${buildGuidanceUsage()}\n\nUnknown option: ${token}`);
  }
  return args;
}

function parseOpenArgs(rawArgs: string): OpenArgs {
  const tokens = splitCommandArgs(rawArgs);
  const args: OpenArgs = { help: false, dryRun: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") {
      return { help: true, dryRun: false };
    }
    if (token === "--repo") {
      args.repo = readOptionValue(tokens, ++index, token);
      continue;
    }
    if (token === "--launcher") {
      args.launcher = parseLauncher(readOptionValue(tokens, ++index, token));
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    throw new Error(`${buildOpenUsage()}\n\nUnknown option: ${token}`);
  }
  return args;
}

function parseFocusArgs(rawArgs: string): FocusArgs {
  const tokens = splitCommandArgs(rawArgs);
  const args: FocusArgs = { help: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") {
      return { help: true };
    }
    if (token === "--repo") {
      args.repo = readOptionValue(tokens, ++index, token);
      continue;
    }
    if (token === "--hunk") {
      args.hunk = parsePositiveInteger(readOptionValue(tokens, ++index, token), token);
      continue;
    }
    if (token === "--old-line") {
      args.oldLine = parsePositiveInteger(readOptionValue(tokens, ++index, token), token);
      continue;
    }
    if (token === "--new-line") {
      args.newLine = parsePositiveInteger(readOptionValue(tokens, ++index, token), token);
      continue;
    }
    if (token.startsWith("-")) {
      throw new Error(`${buildFocusUsage()}\n\nUnknown option: ${token}`);
    }
    if (args.file !== undefined) {
      throw new Error(`${buildFocusUsage()}\n\nOnly one file target may be provided.`);
    }
    const parsed = parseFileLineTarget(token);
    args.file = parsed.file;
    args.line = parsed.line;
  }

  const selectorCount = [args.hunk, args.oldLine, args.newLine, args.line].filter((value) => value !== undefined).length;
  if (selectorCount > 1) {
    throw new Error("Specify exactly one focus selector: file:line, --hunk, --old-line, or --new-line.");
  }
  if (args.oldLine !== undefined) {
    args.line = args.oldLine;
  }
  if (args.newLine !== undefined) {
    args.line = args.newLine;
  }
  return args;
}

function parseCloseArgs(rawArgs: string): CloseArgs {
  const tokens = splitCommandArgs(rawArgs);
  const args: CloseArgs = { help: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") {
      return { help: true };
    }
    if (token === "--repo") {
      args.repo = readOptionValue(tokens, ++index, token);
      continue;
    }
    throw new Error(`${buildCloseUsage()}\n\nUnknown option: ${token}`);
  }
  return args;
}

export function splitCommandArgs(rawArgs: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:\\"|[^"])*)"|'((?:\\'|[^'])*)'|(\S+)/g;
  for (const match of rawArgs.matchAll(pattern)) {
    const doubleQuoted = match[1];
    const singleQuoted = match[2];
    const bare = match[3];
    tokens.push((doubleQuoted ?? singleQuoted ?? bare).replace(/\\(["'])/g, "$1"));
  }
  return tokens;
}

function parseFileLineTarget(target: string): { file: string; line?: number } {
  const match = target.match(/^(.*):(\d+)$/);
  if (!match) {
    return { file: target };
  }
  return { file: match[1], line: Number.parseInt(match[2], 10) };
}

function buildSetupUsage(): string {
  return [
    "Usage: /hunk:setup [--hunk-bin <path>] [--launcher auto|iterm|manual] [--follow-delay-ms <ms>] [--allow-agent-launch on|off]",
    "",
    "Writes per-machine Hunk defaults. This does not install Hunk or change the active Pi profile package."
  ].join("\n");
}

function buildSwitchUsage(): string {
  return "Usage: /hunk:switch [<repo>|--repo <path>|--auto]";
}

function buildFollowUsage(): string {
  return "Usage: /hunk:follow on|off|status [--delay-ms <ms>]";
}

function buildGuidanceUsage(): string {
  return [
    "Usage: /hunk:guidance status|print|install|remove [--dry-run]",
    "",
    "Manages the optional # Code Review Guidance snippet in the global Pi AGENTS.md for the current PI_CODING_AGENT_DIR.",
    "install appends or updates a marked block; remove deletes only that marked block. Run /reload or restart Pi after changes."
  ].join("\n");
}

function buildOpenUsage(): string {
  return "Usage: /hunk:open [--repo <path>] [--launcher auto|iterm|manual] [--dry-run]";
}

function buildFocusUsage(): string {
  return "Usage: /hunk:focus <file[:line]> [--repo <path>] [--hunk <n>|--old-line <n>|--new-line <n>]";
}

function buildCloseUsage(): string {
  return "Usage: /hunk:close [--repo <path>]";
}

function buildSwitchStatusText(): string {
  const touched = touchedReposDetails();
  if (touched.length === 0) {
    return `${buildSwitchUsage()}\n\nNo touched repos are tracked yet.`;
  }
  return [
    buildSwitchUsage(),
    "",
    `Active repo: ${runtimeState.activeRepo ?? "none"}${runtimeState.activeRepoPinned ? " (pinned)" : ""}`,
    "Touched repos:",
    ...touched.map((repo) => `- ${repo.repo}: ${repo.files.length} file${repo.files.length === 1 ? "" : "s"}`)
  ].join("\n");
}

function readOptionValue(tokens: string[], index: number, flag: string): string {
  const value = tokens[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseLauncher(value: string): DiffLauncherId {
  if (isDiffLauncherId(value)) {
    return value;
  }
  throw new Error(`Invalid launcher ${value}. Use auto, iterm, or manual for this prototype.`);
}

function parseOnOff(value: string): boolean {
  if (value === "on" || value === "true") {
    return true;
  }
  if (value === "off" || value === "false") {
    return false;
  }
  throw new Error(`Expected on/off, got ${value}.`);
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return parsed;
}

function parseFollowDebounceMs(value: string, field: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < MIN_FOLLOW_DEBOUNCE_MS || parsed > MAX_FOLLOW_DEBOUNCE_MS) {
    throw new Error(`${field} must be an integer from ${MIN_FOLLOW_DEBOUNCE_MS} to ${MAX_FOLLOW_DEBOUNCE_MS}.`);
  }
  return parsed;
}

function existingDirectoryOrParent(startPath: string): string {
  if (existsSync(startPath)) {
    return statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);
  }

  let dir = path.dirname(startPath);
  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.dirname(startPath);
    }
    dir = parent;
  }
  return statSync(dir).isDirectory() ? dir : path.dirname(dir);
}

function realpathMaybe(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function isHunkReviewStateSnapshot(value: unknown): value is HunkReviewStateSnapshot {
  return isRecord(value)
    && value.version === 1
    && typeof value.updatedAt === "string"
    && (value.followEnabled === undefined || typeof value.followEnabled === "boolean")
    && (value.followDebounceMs === undefined || typeof value.followDebounceMs === "number")
    && (value.activeRepoPinned === undefined || typeof value.activeRepoPinned === "boolean")
    && isHunkReviewMode(value.lastMode)
    && isDiffScope(value.lastScope)
    && isRecord(value.touchedFilesByRepo)
    && isRecord(value.sessionsByRepo);
}

function readOptionalString(value: unknown, configPath: ConfigPath, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${formatConfigPath(configPath)} ${key} must be a non-empty string when set.`);
  }
  return value.trim();
}

function readOptionalBoolean(value: unknown, configPath: ConfigPath, key: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${formatConfigPath(configPath)} ${key} must be a boolean.`);
  }
  return value;
}

function readOptionalLauncher(value: unknown, configPath: ConfigPath): DiffLauncherId | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isDiffLauncherId(value)) {
    throw new Error(`${formatConfigPath(configPath)} defaultLauncher must be a supported launcher id.`);
  }
  return value;
}

function readOptionalMaxTouchedFiles(value: unknown, configPath: ConfigPath): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TOUCHED_FILES_LIMIT) {
    throw new Error(`${formatConfigPath(configPath)} maxTouchedFiles must be an integer from 1 to ${MAX_TOUCHED_FILES_LIMIT}.`);
  }
  return value;
}

function readOptionalFollowDebounceMs(value: unknown, configPath: ConfigPath): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_FOLLOW_DEBOUNCE_MS || value > MAX_FOLLOW_DEBOUNCE_MS) {
    throw new Error(`${formatConfigPath(configPath)} followDebounceMs must be an integer from ${MIN_FOLLOW_DEBOUNCE_MS} to ${MAX_FOLLOW_DEBOUNCE_MS}.`);
  }
  return value;
}

function clampMaxTouchedFiles(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_TOUCHED_FILES;
  }
  return Math.min(MAX_TOUCHED_FILES_LIMIT, Math.max(1, Math.floor(value)));
}

function readConfigText(configPath: ConfigPath): string {
  return readFileSync(configPath, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLineRange(value: unknown): value is { startLine: number; endLine: number } {
  return isRecord(value)
    && typeof value.startLine === "number"
    && typeof value.endLine === "number";
}

function isDiffScope(value: unknown): value is DiffScope {
  return value === "repo" || value === "touched";
}

function isHunkReviewMode(value: unknown): value is HunkReviewMode {
  return value === "open" || value === "repo" || value === "touched" || value === "review";
}

function isDiffLauncherId(value: unknown): value is DiffLauncherId {
  return value === "auto" || value === "iterm" || value === "manual" || value === "external" || value === "ghostty" || value === "kitty" || value === "wezterm" || value === "tmux";
}

function formatRepoLabel(repo: string): string {
  return path.basename(repo) || repo;
}

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function compactOneLine(value: string | undefined): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
}

function parseJsonOrText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function toolResultText(result: AgentToolResult<unknown>): string {
  const text = result.content
    .map((item) => item.type === "text" ? item.text : "")
    .join("\n")
    .trim();
  return compactOneLine(text) ?? "Tool failed.";
}

function claudeToolCall(name: string, summary: string, theme: RenderTheme): string {
  return theme.fg("toolTitle", `⏺ ${theme.bold(name)}(`) + theme.fg("accent", summary) + theme.fg("toolTitle", ")…");
}

function claudeToolResult(summary: string, color: string, theme: RenderTheme): string {
  return theme.fg("muted", "⎿ ") + theme.fg(color, summary);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function expandHome(value: string): string {
  if (value === "~") {
    return process.env.HOME ?? value;
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", value.slice(2));
  }
  return value;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0)?.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
