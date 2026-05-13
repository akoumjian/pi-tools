import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type Component, type KeyId, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import { formatConfigPath, readPiToolsJsonConfigSource, type ConfigPath } from "../_shared/config.js";

type FileOpenCommandArgs = {
  help: boolean;
};

export type FileOpenSettings = {
  shortcut?: string;
  maxReferences: number;
  configSource: string;
};

export type FileReferenceCandidate = {
  rawPath: string;
  line?: number;
  column?: number;
  baseDir?: string;
  sourceLabel: string;
  displayPath?: string;
};

export type FileReference = {
  displayPath: string;
  resolvedPath: string;
  realPath: string;
  line?: number;
  column?: number;
  sourceLabel: string;
};

export type EditorInvocation = {
  command: string;
  args: string[];
  target: string;
};

type FileOpenResult = {
  reference: FileReference;
  tui: TUI;
} | undefined;

type EntryScanOptions = {
  maxReferences?: number;
};

type RecordValue = Record<string, unknown>;

const FILE_OPEN_CONFIG_FILE = "file-open-settings.json";
const DEFAULT_MAX_REFERENCES = 80;
const MAX_REFERENCE_LIMIT = 200;
const PATH_KEYS = new Set([
  "path",
  "file",
  "filePath",
  "resolvedPath",
  "sourcePath",
  "textPath",
  "downloadedPath",
  "outputPath",
  "screenshotPath",
  "screenshotDir",
  "logPath",
  "logDir",
  "stdoutLog",
  "stderrLog",
  "combinedLog",
  "cachePath",
  "source",
  "location"
]);
const PATH_ARRAY_KEYS = new Set([
  "paths",
  "files",
  "screenshotPaths",
  "screenshotPathsPreview",
  "logPaths"
]);
const GENERAL_PATH_PATTERN = /(?:^|[\s([{"'`])(@?(?:(?:~|\.{1,2})\/|\/)?(?:[A-Za-z0-9._+@=-]+\/)*[A-Za-z0-9._+@=-]+\.[A-Za-z0-9][A-Za-z0-9._+-]*)(?::(\d{1,7})(?::(\d{1,7}))?)?/g;

export default function fileOpenExtension(api: ExtensionAPI): void {
  const settings = readFileOpenSettings();

  api.registerCommand("file:open", {
    description: "Pick a recent file reference from the current chat/tool results and open it in $VISUAL, $EDITOR, or hx",
    handler: async (args, context) => {
      await handleFileOpenCommand(context, args, settings);
    }
  });

  if (settings.shortcut !== undefined) {
    api.registerShortcut(settings.shortcut as KeyId, {
      description: "Open a recent file reference",
      handler: async (context) => {
        await handleFileOpenCommand(context, "", settings);
      }
    });
  }
}

export async function handleFileOpenCommand(context: ExtensionContext, rawArgs: string, settings = readFileOpenSettings()): Promise<void> {
  let args: FileOpenCommandArgs;
  try {
    args = parseFileOpenCommandArgs(rawArgs);
  } catch (error) {
    context.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return;
  }

  if (args.help) {
    context.ui.notify(buildFileOpenUsage(settings), "info");
    return;
  }

  if (!context.hasUI) {
    context.ui.notify("/file:open requires interactive Pi UI mode.", "warning");
    return;
  }

  if (!context.isIdle()) {
    context.ui.notify("/file:open is available after the current agent turn is idle.", "warning");
    return;
  }

  const references = collectRecentFileReferences(context.sessionManager.getBranch(), context.cwd, {
    maxReferences: settings.maxReferences
  });

  if (references.length === 0) {
    context.ui.notify("No existing file references found in the current chat/tool results.", "warning");
    return;
  }

  const selection = await pickFileReference(context, references);
  if (selection === undefined) {
    context.ui.notify("File open cancelled.", "info");
    return;
  }

  const result = openReferenceInEditor(selection.tui, selection.reference);
  if (result.ok) {
    context.ui.notify(`Opened ${formatFileReference(selection.reference, context.cwd)}.`, "info");
    return;
  }

  context.ui.notify(result.message, "error");
}

export function parseFileOpenCommandArgs(rawArgs: string): FileOpenCommandArgs {
  const trimmed = rawArgs.trim();
  if (trimmed === "" || trimmed === "--help" || trimmed === "-h") {
    return { help: trimmed === "--help" || trimmed === "-h" };
  }

  throw new Error(`${buildFileOpenUsage(readFileOpenSettings())}\n\nUnknown option: ${trimmed}`);
}

export function buildFileOpenUsage(settings = readFileOpenSettings()): string {
  const shortcutLine = settings.shortcut === undefined
    ? "Optional shortcut: set file-open-settings.json shortcut to \"ctrl+e\" (or another key) if desired."
    : `Shortcut: ${settings.shortcut}`;
  return [
    "Usage: /file:open",
    "",
    "Pick a recent existing file reference from the current chat/tool results, temporarily hand the terminal to $VISUAL || $EDITOR || hx, then return to Pi.",
    shortcutLine,
    `Settings: ${settings.configSource}`
  ].join("\n");
}

export function readFileOpenSettings(settingsPath?: ConfigPath): FileOpenSettings {
  const parsed = settingsPath === undefined
    ? readPiToolsJsonConfigSource(FILE_OPEN_CONFIG_FILE, import.meta.url)
    : { path: settingsPath, source: "explicit" as const, data: JSON.parse(readConfigText(settingsPath)) as Record<string, unknown> };

  if (parsed === undefined) {
    return {
      maxReferences: DEFAULT_MAX_REFERENCES,
      configSource: "built-in defaults"
    };
  }

  if (!isRecord(parsed.data)) {
    throw new Error(`${formatConfigPath(parsed.path)} must contain a JSON object.`);
  }

  const shortcut = readOptionalShortcut(parsed.data.shortcut, parsed.path);
  const maxReferences = readOptionalReferenceLimit(parsed.data.maxReferences, parsed.path) ?? DEFAULT_MAX_REFERENCES;
  return {
    shortcut,
    maxReferences,
    configSource: `${parsed.source}:${formatConfigPath(parsed.path)}`
  };
}

export function collectRecentFileReferences(entries: readonly unknown[], cwd: string, options: EntryScanOptions = {}): FileReference[] {
  const maxReferences = clampReferenceLimit(options.maxReferences ?? DEFAULT_MAX_REFERENCES);
  const references: FileReference[] = [];
  const seen = new Set<string>();
  const seenFiles = new Set<string>();

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidates = extractCandidatesFromEntry(entries[index], cwd);
    for (const candidate of candidates) {
      const reference = resolveFileReferenceCandidate(candidate, cwd);
      if (reference === undefined) {
        continue;
      }

      const key = fileReferenceKey(reference);
      if (seen.has(key)) {
        continue;
      }
      if (reference.line === undefined && seenFiles.has(reference.realPath)) {
        continue;
      }

      seen.add(key);
      seenFiles.add(reference.realPath);
      references.push(reference);
      if (references.length >= maxReferences) {
        return references;
      }
    }
  }

  return references;
}

export function extractPathCandidatesFromText(text: string, baseDir: string, sourceLabel: string): FileReferenceCandidate[] {
  const candidates: FileReferenceCandidate[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    addCandidate(candidates, seen, readHeaderCandidate(line, baseDir, sourceLabel));
    addCandidate(candidates, seen, prefixedLineCandidate(line, baseDir, sourceLabel));

    for (const match of line.matchAll(GENERAL_PATH_PATTERN)) {
      addCandidate(candidates, seen, {
        rawPath: match[1],
        line: parsePositiveInteger(match[2]),
        column: parsePositiveInteger(match[3]),
        baseDir,
        sourceLabel
      });
    }
  }

  return candidates;
}

export function resolveFileReferenceCandidate(candidate: FileReferenceCandidate, cwd: string): FileReference | undefined {
  const parsed = parseCandidatePath(candidate.rawPath, candidate.line, candidate.column);
  if (parsed.path === "") {
    return undefined;
  }

  const baseDir = candidate.baseDir ?? cwd;
  const resolvedPath = path.isAbsolute(parsed.path)
    ? path.normalize(parsed.path)
    : path.resolve(baseDir, parsed.path);

  if (!isReadableFile(resolvedPath)) {
    return undefined;
  }

  const realPath = realpathSync(resolvedPath);
  return {
    displayPath: candidate.displayPath ?? parsed.path,
    resolvedPath,
    realPath,
    line: parsed.line,
    column: parsed.column,
    sourceLabel: candidate.sourceLabel
  };
}

export function editorCommandFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const visual = env.VISUAL?.trim();
  if (visual) return visual;

  const editor = env.EDITOR?.trim();
  if (editor) return editor;

  return "hx";
}

export function buildEditorInvocation(reference: Pick<FileReference, "realPath" | "line" | "column">, editorCommand = editorCommandFromEnv()): EditorInvocation {
  const tokens = tokenizeCommand(editorCommand);
  if (tokens.length === 0) {
    throw new Error("Editor command must not be empty.");
  }

  const [command, ...editorArgs] = tokens;
  const args = [...editorArgs, ...editorFileArgs(command, editorArgs, reference)];
  return {
    command,
    args,
    target: args[args.length - 1] ?? reference.realPath
  };
}

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;

  for (const char of command.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote !== undefined) {
    throw new Error("Unterminated quoted editor command.");
  }
  if (current !== "") {
    tokens.push(current);
  }
  return tokens;
}

export function formatEditorTarget(reference: Pick<FileReference, "realPath" | "line" | "column">): string {
  if (reference.line === undefined) {
    return reference.realPath;
  }

  if (reference.column === undefined) {
    return `${reference.realPath}:${reference.line}`;
  }

  return `${reference.realPath}:${reference.line}:${reference.column}`;
}

function openReferenceInEditor(tui: TUI, reference: FileReference): { ok: true } | { ok: false; message: string } {
  let invocation: EditorInvocation;
  try {
    invocation = buildEditorInvocation(reference);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  try {
    tui.stop();
    const result = spawnSync(invocation.command, invocation.args, {
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    if (result.error !== undefined) {
      return { ok: false, message: `Failed to run editor ${invocation.command}: ${result.error.message}` };
    }
    if (result.status !== 0) {
      return { ok: false, message: `Editor exited with status ${result.status ?? "unknown"}: ${invocation.command}` };
    }
    return { ok: true };
  } finally {
    tui.start();
    tui.requestRender(true);
  }
}

async function pickFileReference(context: ExtensionContext, references: FileReference[]): Promise<FileOpenResult> {
  let pickerTui: TUI | undefined;
  const selected = await context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    pickerTui = tui;
    return createFileReferencePicker(references, context.cwd, theme, tui, done);
  });

  if (selected === null || pickerTui === undefined) {
    return undefined;
  }

  const index = Number(selected);
  const reference = references[index];
  return reference === undefined ? undefined : { reference, tui: pickerTui };
}

function createFileReferencePicker(
  references: FileReference[],
  cwd: string,
  theme: Theme,
  tui: TUI,
  done: (result: string | null) => void
): Component {
  const items: SelectItem[] = references.map((reference, index) => ({
    value: String(index),
    label: formatFileReference(reference, cwd),
    description: `${reference.sourceLabel} • ${reference.realPath}`
  }));
  const selectList = new SelectList(items, Math.min(items.length, 12), {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text)
  });
  selectList.onSelect = (item) => done(item.value);
  selectList.onCancel = () => done(null);

  const container = new Container();
  container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
  container.addChild(new Text(theme.fg("accent", theme.bold("Open recent file reference")), 1, 0));
  container.addChild(selectList);
  container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter open • esc cancel"), 1, 0));
  container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

  return {
    render(width: number): string[] {
      return container.render(width);
    },
    invalidate(): void {
      container.invalidate();
    },
    handleInput(data: string): void {
      selectList.handleInput(data);
      tui.requestRender();
    }
  };
}

function extractCandidatesFromEntry(entry: unknown, cwd: string): FileReferenceCandidate[] {
  if (!isRecord(entry)) {
    return [];
  }

  if (entry.type === "message") {
    return extractCandidatesFromMessage(entry.message, cwd);
  }

  if (entry.type === "custom_message") {
    const sourceLabel = typeof entry.customType === "string" ? `custom message ${entry.customType}` : "custom message";
    return [
      ...extractStructuredPathCandidates(entry.details, cwd, sourceLabel),
      ...extractPathCandidatesFromText(contentToText(entry.content), cwd, sourceLabel)
    ];
  }

  if (entry.type === "compaction" && typeof entry.summary === "string") {
    return extractPathCandidatesFromText(entry.summary, cwd, "compaction summary");
  }

  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return extractPathCandidatesFromText(entry.summary, cwd, "branch summary");
  }

  if (entry.type === "custom") {
    const sourceLabel = typeof entry.customType === "string" ? `custom entry ${entry.customType}` : "custom entry";
    return extractStructuredPathCandidates(entry.data, cwd, sourceLabel);
  }

  return [];
}

function extractCandidatesFromMessage(message: unknown, cwd: string): FileReferenceCandidate[] {
  if (!isRecord(message) || typeof message.role !== "string") {
    return [];
  }

  if (message.role === "toolResult") {
    const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
    const sourceLabel = `${toolName} result`;
    return [
      ...extractStructuredPathCandidates(message.details, cwd, `${toolName} details`),
      ...extractPathCandidatesFromText(contentToText(message.content), cwd, sourceLabel)
    ];
  }

  if (message.role === "assistant") {
    const candidates: FileReferenceCandidate[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const item of content) {
      if (!isRecord(item)) {
        continue;
      }
      if (item.type === "text" && typeof item.text === "string") {
        candidates.push(...extractPathCandidatesFromText(item.text, cwd, "assistant message"));
      }
      if (item.type === "toolCall") {
        const toolName = typeof item.name === "string" ? item.name : "tool";
        candidates.push(...extractStructuredPathCandidates(item.arguments, cwd, `${toolName} call arguments`));
      }
    }
    return candidates;
  }

  if (message.role === "user") {
    return extractPathCandidatesFromText(contentToText(message.content), cwd, "user message");
  }

  if (message.role === "bashExecution") {
    const candidates = extractPathCandidatesFromText([message.command, message.output].filter((part): part is string => typeof part === "string").join("\n"), cwd, "bash output");
    if (typeof message.fullOutputPath === "string") {
      candidates.unshift({ rawPath: message.fullOutputPath, baseDir: cwd, sourceLabel: "bash full output" });
    }
    return candidates;
  }

  if (message.role === "custom") {
    const sourceLabel = typeof message.customType === "string" ? `custom message ${message.customType}` : "custom message";
    return [
      ...extractStructuredPathCandidates(message.details, cwd, sourceLabel),
      ...extractPathCandidatesFromText(contentToText(message.content), cwd, sourceLabel)
    ];
  }

  if (message.role === "branchSummary" && typeof message.summary === "string") {
    return extractPathCandidatesFromText(message.summary, cwd, "branch summary");
  }

  if (message.role === "compactionSummary" && typeof message.summary === "string") {
    return extractPathCandidatesFromText(message.summary, cwd, "compaction summary");
  }

  return [];
}

function extractStructuredPathCandidates(value: unknown, baseDir: string, sourceLabel: string, depth = 0): FileReferenceCandidate[] {
  if (depth > 8) {
    return [];
  }

  if (typeof value === "string") {
    return extractPathCandidatesFromText(value, baseDir, sourceLabel);
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractStructuredPathCandidates(item, baseDir, sourceLabel, depth + 1));
  }

  if (!isRecord(value)) {
    return [];
  }

  const candidates: FileReferenceCandidate[] = [];
  const line = lineFromRecord(value);
  const column = columnFromRecord(value);

  const resolvedPath = stringField(value, "resolvedPath");
  if (resolvedPath !== undefined) {
    candidates.push({
      rawPath: resolvedPath,
      displayPath: stringField(value, "path") ?? resolvedPath,
      line,
      column,
      baseDir,
      sourceLabel
    });
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "resolvedPath") {
      continue;
    }

    if (typeof child === "string" && PATH_KEYS.has(key)) {
      candidates.push({ rawPath: child, line, column, baseDir, sourceLabel });
      continue;
    }

    if (Array.isArray(child) && PATH_ARRAY_KEYS.has(key)) {
      for (const item of child) {
        if (typeof item === "string") {
          candidates.push({ rawPath: item, line, column, baseDir, sourceLabel });
        } else {
          candidates.push(...extractStructuredPathCandidates(item, baseDir, sourceLabel, depth + 1));
        }
      }
      continue;
    }

    candidates.push(...extractStructuredPathCandidates(child, baseDir, sourceLabel, depth + 1));
  }

  return candidates;
}

function readHeaderCandidate(line: string, baseDir: string, sourceLabel: string): FileReferenceCandidate | undefined {
  const match = line.match(/^---\s+(.+?)\s+\(lines\s+(\d+)/);
  if (match === null) {
    return undefined;
  }

  return {
    rawPath: match[1],
    line: parsePositiveInteger(match[2]),
    baseDir,
    sourceLabel
  };
}

function prefixedLineCandidate(line: string, baseDir: string, sourceLabel: string): FileReferenceCandidate | undefined {
  const trimmed = line.trim();
  const withColumn = trimmed.match(/^(.+?)(?::|-)(\d{1,7})(?::|-)(\d{1,7})(?::|-)/);
  if (withColumn !== null) {
    return {
      rawPath: withColumn[1],
      line: parsePositiveInteger(withColumn[2]),
      column: parsePositiveInteger(withColumn[3]),
      baseDir,
      sourceLabel
    };
  }

  const withLine = trimmed.match(/^(.+?)(?::|-)(\d{1,7})(?::|-)/);
  if (withLine === null) {
    return undefined;
  }

  return {
    rawPath: withLine[1],
    line: parsePositiveInteger(withLine[2]),
    baseDir,
    sourceLabel
  };
}

function addCandidate(candidates: FileReferenceCandidate[], seen: Set<string>, candidate: FileReferenceCandidate | undefined): void {
  if (candidate === undefined) {
    return;
  }

  const key = `${candidate.rawPath}\0${candidate.line ?? ""}\0${candidate.column ?? ""}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  candidates.push(candidate);
}

function parseCandidatePath(rawPath: string, line: number | undefined, column: number | undefined): { path: string; line?: number; column?: number } {
  const cleaned = cleanRawPath(rawPath);
  const match = cleaned.match(/^(.*?)(?::(\d{1,7})(?::(\d{1,7}))?)$/);
  const parsedLine = line ?? parsePositiveInteger(match?.[2]);
  const parsedColumn = column ?? parsePositiveInteger(match?.[3]);
  const candidatePath = match?.[2] === undefined ? cleaned : match[1];
  return {
    path: expandHome(candidatePath),
    line: parsedLine,
    column: parsedColumn
  };
}

function cleanRawPath(rawPath: string): string {
  let cleaned = rawPath.trim();
  cleaned = cleaned.replace(/^@/, "");
  cleaned = stripWrapping(cleaned, "`", "`");
  cleaned = stripWrapping(cleaned, "'", "'");
  cleaned = stripWrapping(cleaned, "\"", "\"");
  cleaned = stripWrapping(cleaned, "<", ">");
  cleaned = cleaned.replace(/[),.;\]]+$/g, "");
  return cleaned;
}

function stripWrapping(value: string, open: string, close: string): string {
  if (value.startsWith(open) && value.endsWith(close) && value.length >= open.length + close.length) {
    return value.slice(open.length, -close.length);
  }
  return value;
}

function expandHome(rawPath: string): string {
  if (rawPath === "~") {
    return homedir();
  }
  if (rawPath.startsWith("~/")) {
    return path.join(homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function isReadableFile(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }

  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function fileReferenceKey(reference: FileReference): string {
  return `${reference.realPath}\0${reference.line ?? ""}\0${reference.column ?? ""}`;
}

function formatFileReference(reference: FileReference, cwd: string): string {
  const relative = path.relative(cwd, reference.realPath);
  const displayPath = reference.displayPath !== "" && !path.isAbsolute(reference.displayPath)
    ? reference.displayPath
    : relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? relative
      : reference.realPath;
  const location = reference.line === undefined
    ? ""
    : reference.column === undefined
      ? `:${reference.line}`
      : `:${reference.line}:${reference.column}`;
  return `${displayPath}${location}`;
}

function editorFileArgs(command: string, editorArgs: readonly string[], reference: Pick<FileReference, "realPath" | "line" | "column">): string[] {
  const name = path.basename(command).toLowerCase();
  if (reference.line === undefined) {
    return [reference.realPath];
  }

  if (name === "hx" || name === "helix") {
    return [formatEditorTarget(reference)];
  }

  if (name === "code" || name === "code-insiders" || name === "codium") {
    const gotoArgs = editorArgs.includes("--goto") ? [] : ["--goto"];
    return [...gotoArgs, formatEditorTarget(reference)];
  }

  if (name === "vim" || name === "nvim" || name === "vi") {
    return [`+call cursor(${reference.line}, ${reference.column ?? 1})`, reference.realPath];
  }

  if (name === "emacs" || name === "emacsclient") {
    return [`+${reference.line}:${reference.column ?? 1}`, reference.realPath];
  }

  return [reference.realPath];
}

function readOptionalShortcut(value: unknown, settingsPath: ConfigPath): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${formatConfigPath(settingsPath)} shortcut must be a string or null.`);
  }
  return value;
}

function readOptionalReferenceLimit(value: unknown, settingsPath: ConfigPath): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${formatConfigPath(settingsPath)} maxReferences must be an integer.`);
  }
  return clampReferenceLimit(value);
}

function clampReferenceLimit(value: number): number {
  if (value < 1 || value > MAX_REFERENCE_LIMIT) {
    throw new Error(`file-open maxReferences must be between 1 and ${MAX_REFERENCE_LIMIT}.`);
  }
  return value;
}

function readConfigText(configPath: ConfigPath): string {
  return readFileSync(configPath, "utf8");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
}

function lineFromRecord(record: RecordValue): number | undefined {
  const direct = firstPositiveInteger(record.offset, record.line, record.lineNumber, record.startLine);
  if (direct !== undefined) {
    return direct;
  }

  if (Array.isArray(record.ranges)) {
    for (const range of record.ranges) {
      if (isRecord(range)) {
        const line = firstPositiveInteger(range.startLine, range.line, range.lineNumber);
        if (line !== undefined) {
          return line;
        }
      }
    }
  }

  return undefined;
}

function columnFromRecord(record: RecordValue): number | undefined {
  return firstPositiveInteger(record.column, record.columnNumber, record.startColumn);
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = parsePositiveInteger(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function stringField(record: RecordValue, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
