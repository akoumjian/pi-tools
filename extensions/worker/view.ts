import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";

const MAX_SESSION_RANGE_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_RANGE_LINES = 8192;
const MAX_SESSION_ENTRIES = 4096;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const SESSION_READ_CHUNK = 256 * 1024;
const MAX_VIEW_BLOCKS = 500;
const MAX_BLOCK_TEXT = 16 * 1024;
const MAX_RENDER_LINES = 2000;
const MAX_BLOCK_RENDER_LINES = 400;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

type WorkerSessionEntry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  lineNumber: number;
  [key: string]: unknown;
};

type WorkerSessionHeader = {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
};

type ReadSessionRange = {
  headerLine: string;
  lines: Array<{ lineNumber: number; text: string }>;
  incompleteTrailingEntry: boolean;
};

export type WorkerSessionViewTarget = {
  workerId: string;
  role: "work" | "review" | "integration";
  workerStatus: "idle" | "queued" | "running";
  runId: string;
  runStatus: "queued" | "running" | "settled";
  outcome?: string;
  modelSelection?: string;
  sessionId: string;
  sessionFile: string;
  workspaceRoot: string;
  parentSessionFile: string;
  sessionStartLine?: number;
  sessionEndLine?: number;
};

export type WorkerSessionViewBlock = {
  kind: "user" | "assistant" | "thinking" | "tool" | "toolResult" | "error" | "status" | "compaction" | "custom";
  label: string;
  timestamp: string;
  text: string;
};

export type WorkerSessionViewSnapshot = {
  target: WorkerSessionViewTarget;
  blocks: WorkerSessionViewBlock[];
  totalActiveEntries: number;
  omittedEntries: number;
  malformedEntries: number;
  incompleteTrailingEntry: boolean;
  refreshedAt: string;
};

type WrappedBodyCache = { snapshot: WorkerSessionViewSnapshot; theme: Theme; width: number; lines: string[]; omittedLines: boolean };

export type WorkerSessionViewerState = {
  snapshot: WorkerSessionViewSnapshot;
  topLine: number;
  pinnedToEnd: boolean;
  error?: string;
  wrappedBodyCache?: WrappedBodyCache;
};

export type WorkerSessionViewerFrame = { lines: string[]; topLine: number; pageSize: number };

export type WorkerSessionReadDependencies = {
  beforeOpen?: (file: string) => void;
  afterReadAttempt?: (file: string, attempt: number) => void;
};

type WorkerSessionViewerComponentOptions = {
  tui: TUI;
  getTheme: () => Theme;
  initialSnapshot: WorkerSessionViewSnapshot;
  loadSnapshot: () => WorkerSessionViewSnapshot;
  done: (result: void) => void;
};

export function loadWorkerSessionViewSnapshot(target: WorkerSessionViewTarget, dependencies: WorkerSessionReadDependencies = {}): WorkerSessionViewSnapshot {
  validateRunRange(target);
  const selected = readTrustedSessionRange(target, dependencies);
  const header = parseSessionHeader(selected.headerLine);
  validateSessionHeader(header, target);
  const { entries, malformedEntries } = parseSessionEntries(selected.lines);
  const active = activeSessionEntries(entries);
  const blocks = active.flatMap(renderableBlocks);
  const omittedEntries = Math.max(0, blocks.length - MAX_VIEW_BLOCKS);
  return {
    target,
    blocks: blocks.slice(-MAX_VIEW_BLOCKS),
    totalActiveEntries: active.length,
    omittedEntries,
    malformedEntries,
    incompleteTrailingEntry: selected.incompleteTrailingEntry,
    refreshedAt: new Date().toISOString()
  };
}

export async function openWorkerSessionViewer(context: ExtensionCommandContext, target: WorkerSessionViewTarget, loadTarget: () => WorkerSessionViewTarget = () => target): Promise<void> {
  if (!context.hasUI || context.mode !== "tui") {
    context.ui.notify("/worker:view requires interactive Pi TUI mode.", "warning");
    return;
  }
  let initialSnapshot: WorkerSessionViewSnapshot;
  try {
    initialSnapshot = loadWorkerSessionViewSnapshot(target);
  } catch (error) {
    context.ui.notify(safeErrorMessage(error), "error");
    return;
  }
  try {
    await context.ui.custom<void>((tui, _theme, _keybindings, done) => createWorkerSessionViewerComponent({
      tui,
      getTheme: () => context.ui.theme,
      initialSnapshot,
      loadSnapshot: () => loadWorkerSessionViewSnapshot(loadTarget()),
      done
    }));
  } catch (error) {
    context.ui.notify(safeErrorMessage(error), "error");
  }
}

export function createWorkerSessionViewerComponent(options: WorkerSessionViewerComponentOptions): Component {
  let pageSize = 1;
  const state: WorkerSessionViewerState = { snapshot: options.initialSnapshot, topLine: 0, pinnedToEnd: true };
  const move = (delta: number) => {
    state.pinnedToEnd = false;
    state.topLine = Math.max(0, state.topLine + delta);
    options.tui.requestRender();
  };
  const refresh = () => {
    try {
      state.snapshot = options.loadSnapshot();
      state.wrappedBodyCache = undefined;
      state.error = undefined;
    } catch (error) {
      state.error = safeErrorMessage(error);
    }
    options.tui.requestRender();
  };
  return {
    render(width: number): string[] {
      const frame = buildWorkerSessionViewerFrame(options.getTheme(), state, width, options.tui.terminal.rows);
      state.topLine = frame.topLine;
      pageSize = frame.pageSize;
      return frame.lines;
    },
    invalidate(): void {},
    handleInput(data: string): void {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q" || data === "Q") return options.done();
      if (matchesKey(data, Key.up) || data === "k" || data === "K") return move(-1);
      if (matchesKey(data, Key.down) || data === "j" || data === "J") return move(1);
      if (matchesKey(data, Key.pageUp)) return move(-pageSize);
      if (matchesKey(data, Key.pageDown)) return move(pageSize);
      if (matchesKey(data, Key.home) || data === "g") { state.pinnedToEnd = false; state.topLine = 0; options.tui.requestRender(); return; }
      if (matchesKey(data, Key.end) || data === "G") { state.pinnedToEnd = true; options.tui.requestRender(); return; }
      if (data === "r" || data === "R") refresh();
    }
  };
}

export function buildWorkerSessionViewerFrame(theme: Theme, state: WorkerSessionViewerState, width: number, height: number): WorkerSessionViewerFrame {
  const safeWidth = Math.max(1, width);
  const body = wrappedBody(theme, state, safeWidth);
  const target = state.snapshot.target;
  const status = target.outcome ?? target.runStatus;
  const warnings = [
    state.snapshot.omittedEntries > 0 ? `${state.snapshot.omittedEntries} older rendered entr${state.snapshot.omittedEntries === 1 ? "y" : "ies"} omitted by the ${MAX_VIEW_BLOCKS}-entry view bound.` : undefined,
    body.omittedLines ? `Older wrapped transcript lines were omitted by the ${MAX_RENDER_LINES}-line render bound.` : undefined,
    state.snapshot.malformedEntries > 0 ? `${state.snapshot.malformedEntries} malformed session entr${state.snapshot.malformedEntries === 1 ? "y was" : "ies were"} skipped.` : undefined,
    state.snapshot.incompleteTrailingEntry ? "The final unterminated session entry was still being written and was skipped." : undefined,
    state.error
  ].filter((value): value is string => value !== undefined);
  const border = theme.fg("borderAccent", "─".repeat(safeWidth));
  const header = [
    border,
    theme.fg("accent", theme.bold("Managed worker conversation")),
    `${theme.fg(target.runStatus === "running" ? "warning" : "success", sanitizeViewText(status))} ${theme.fg("muted", `· ${sanitizeViewText(target.role)} · ${sanitizeViewText(target.workerId)}`)}`,
    theme.fg("dim", `run: ${sanitizeViewText(target.runId)} · session: ${sanitizeViewText(target.sessionId)}`),
    theme.fg("dim", `model: ${sanitizeViewText(target.modelSelection ?? "unavailable")}`),
    theme.fg("dim", `session lines: ${target.sessionStartLine === undefined ? "unavailable" : `${target.sessionStartLine}`}..${target.sessionEndLine ?? "current"}`),
    theme.fg("muted", `manual snapshot · refreshed=${sanitizeViewText(state.snapshot.refreshedAt)}`),
    theme.fg("dim", "↑↓ or j/k scroll • PgUp/PgDn page • Home/End or g/G jump"),
    theme.fg("dim", "r refreshes this read-only view • Esc/Ctrl+C/q closes"),
    ...warnings.map((warning) => theme.fg("warning", sanitizeViewText(warning))),
    border
  ];
  const pageSize = Math.max(1, Math.max(12, height) - header.length - 2);
  const maxTopLine = Math.max(0, body.lines.length - pageSize);
  const topLine = state.pinnedToEnd ? maxTopLine : Math.max(0, Math.min(state.topLine, maxTopLine));
  const visible = body.lines.slice(topLine, topLine + pageSize);
  const first = body.lines.length === 0 ? 0 : topLine + 1;
  const last = Math.min(body.lines.length, topLine + visible.length);
  const footer = [border, theme.fg("muted", `lines ${first}-${last} of ${body.lines.length} · active entries ${state.snapshot.totalActiveEntries}`)];
  return { lines: [...header, ...visible, ...footer].map((line) => truncateToWidth(line, safeWidth, "", false)), topLine, pageSize };
}

export function sanitizeViewText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\r(?=\n|$)/g, "")
    .replace(/\t/g, "    ")
    .replace(/\r/g, "�")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�")
    .replace(BIDI_CONTROLS, "�");
}

function validateRunRange(target: WorkerSessionViewTarget): void {
  if (target.sessionStartLine === undefined) {
    if (target.runStatus === "queued") return;
    throw new Error("Worker run has no retained session range.");
  }
  if (!Number.isSafeInteger(target.sessionStartLine) || target.sessionStartLine < 1) throw new Error("Worker run session range is invalid.");
  if (target.sessionEndLine !== undefined && (!Number.isSafeInteger(target.sessionEndLine) || target.sessionEndLine < target.sessionStartLine)) throw new Error("Worker run session range is invalid.");
}

function readTrustedSessionRange(target: WorkerSessionViewTarget, dependencies: WorkerSessionReadDependencies): ReadSessionRange {
  const workspace = realpathSync(target.workspaceRoot);
  const workerRoot = path.dirname(workspace);
  const sessionRoot = realpathSync(path.join(workerRoot, "session"));
  const requested = path.resolve(target.sessionFile);
  const canonicalParent = realpathSync(path.dirname(requested));
  if (!sameOrWithin(sessionRoot, canonicalParent)) throw new Error("Worker session file is outside its retained session directory.");
  const exact = path.join(canonicalParent, path.basename(requested));
  if (!strictlyWithin(sessionRoot, exact)) throw new Error("Worker session file is outside its retained session directory.");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return readStableSessionRange(exact, target, dependencies, attempt); }
    catch (error) {
      if (attempt === 0 && error instanceof SessionChangedDuringReadError) continue;
      if (error instanceof SessionChangedDuringReadError) throw new Error("Worker session changed while reading; refresh the view.");
      throw error;
    }
  }
  throw new Error("Worker session changed while reading; refresh the view.");
}

class SessionChangedDuringReadError extends Error {}

function readStableSessionRange(file: string, target: WorkerSessionViewTarget, dependencies: WorkerSessionReadDependencies, attempt: number): ReadSessionRange {
  let leaf;
  try { leaf = lstatSync(file); }
  catch { throw new Error("Worker session file is unavailable."); }
  if (leaf.isSymbolicLink()) throw new Error("Worker session file cannot be a symbolic link.");
  dependencies.beforeOpen?.(file);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = record(error)?.code;
    if (code === "ELOOP") throw new Error("Worker session file cannot be a symbolic link.");
    throw new Error("Worker session file could not be opened safely.");
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("Worker session path is not a regular file.");
    if (opened.dev !== leaf.dev || opened.ino !== leaf.ino) throw new SessionChangedDuringReadError();
    const selected = streamSessionRange(fd, opened.size, target.sessionStartLine, target.sessionEndLine);
    dependencies.afterReadAttempt?.(file, attempt);
    const after = fstatSync(fd);
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) throw new SessionChangedDuringReadError();
    let currentLeaf;
    try { currentLeaf = lstatSync(file); } catch { throw new SessionChangedDuringReadError(); }
    if (!currentLeaf.isFile() || currentLeaf.dev !== opened.dev || currentLeaf.ino !== opened.ino) throw new SessionChangedDuringReadError();
    if (target.sessionEndLine === undefined && (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)) throw new SessionChangedDuringReadError();
    if (target.sessionEndLine !== undefined && (after.size < opened.size || after.size === opened.size && after.mtimeMs !== opened.mtimeMs)) throw new SessionChangedDuringReadError();
    return selected;
  } finally { closeSync(fd); }
}

function streamSessionRange(fd: number, snapshotSize: number, startLine: number | undefined, endLine: number | undefined): ReadSessionRange {
  const selectedStart = startLine === undefined ? undefined : Math.max(2, startLine);
  const buffer = Buffer.allocUnsafe(Math.min(SESSION_READ_CHUNK, Math.max(1, snapshotSize)));
  let position = 0;
  let lineNumber = 1;
  let capturedBytes = 0;
  let capturedLines = 0;
  let parts: Buffer[] = [];
  let partBytes = 0;
  let headerLine: string | undefined;
  const lines: Array<{ lineNumber: number; text: string }> = [];
  let finalLineHasBytes = false;

  const capturesCurrent = () => lineNumber === 1 || (selectedStart !== undefined && lineNumber >= selectedStart && (endLine === undefined || lineNumber <= endLine));
  const append = (part: Buffer) => {
    if (!capturesCurrent() || part.length === 0) return;
    const limit = lineNumber === 1 ? MAX_SESSION_HEADER_BYTES : MAX_SESSION_RANGE_BYTES;
    const next = partBytes + part.length;
    if (next > limit || lineNumber !== 1 && capturedBytes + next > MAX_SESSION_RANGE_BYTES) throw new Error(lineNumber === 1 ? "Worker session header exceeds its read bound." : `Worker run session range exceeds ${MAX_SESSION_RANGE_BYTES} bytes.`);
    parts.push(Buffer.from(part));
    partBytes = next;
  };
  const finishLine = () => {
    if (capturesCurrent()) {
      const text = decodeUtf8(Buffer.concat(parts, partBytes));
      if (lineNumber === 1) headerLine = text;
      else {
        capturedBytes += partBytes + 1;
        capturedLines += 1;
        if (capturedBytes > MAX_SESSION_RANGE_BYTES) throw new Error(`Worker run session range exceeds ${MAX_SESSION_RANGE_BYTES} bytes.`);
        if (capturedLines > MAX_SESSION_RANGE_LINES) throw new Error(`Worker run session range exceeds ${MAX_SESSION_RANGE_LINES} lines.`);
        lines.push({ lineNumber, text });
      }
    }
    parts = [];
    partBytes = 0;
    lineNumber += 1;
    finalLineHasBytes = false;
  };

  while (position < snapshotSize) {
    const requested = Math.min(buffer.length, snapshotSize - position);
    const count = readSync(fd, buffer, 0, requested, position);
    if (count === 0) throw new SessionChangedDuringReadError();
    let cursor = 0;
    while (cursor < count) {
      const newline = buffer.indexOf(0x0a, cursor);
      const end = newline >= 0 && newline < count ? newline : count;
      if (end > cursor) { append(buffer.subarray(cursor, end)); finalLineHasBytes = true; }
      if (newline < 0 || newline >= count) break;
      finishLine();
      cursor = newline + 1;
      if (headerLine !== undefined && (startLine === undefined || endLine !== undefined && lineNumber > endLine)) {
        return { headerLine, lines, incompleteTrailingEntry: false };
      }
    }
    position += count;
  }
  if (!headerLine) {
    if (lineNumber === 1 && finalLineHasBytes) throw new Error("Worker session has no complete header.");
    throw new Error("Worker session header is unavailable.");
  }
  if (endLine !== undefined && (lineNumber < endLine || lineNumber === endLine && !finalLineHasBytes)) throw new Error("Worker session does not contain the retained run end line.");
  const incompleteTrailingEntry = selectedStart !== undefined && lineNumber >= selectedStart && (endLine === undefined || lineNumber <= endLine) && finalLineHasBytes;
  return { headerLine, lines, incompleteTrailingEntry };
}

function decodeUtf8(value: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new Error("Worker session is not valid UTF-8."); }
}

function parseSessionHeader(text: string): WorkerSessionHeader {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Worker session header is malformed."); }
  if (!isSessionHeader(value)) throw new Error("Worker session header is invalid.");
  return value;
}

function parseSessionEntries(lines: Array<{ lineNumber: number; text: string }>): { entries: WorkerSessionEntry[]; malformedEntries: number } {
  const entries: WorkerSessionEntry[] = [];
  let malformedEntries = 0;
  for (const line of lines) {
    if (!line.text.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line.text); }
    catch { malformedEntries += 1; continue; }
    if (!isSessionEntry(value)) { malformedEntries += 1; continue; }
    if (entries.length >= MAX_SESSION_ENTRIES) throw new Error(`Worker run session range exceeds the ${MAX_SESSION_ENTRIES}-entry parsing bound.`);
    entries.push({ ...value, lineNumber: line.lineNumber });
  }
  return { entries, malformedEntries };
}

function validateSessionHeader(header: WorkerSessionHeader, target: WorkerSessionViewTarget): void {
  if (header.version !== undefined && (!Number.isInteger(header.version) || header.version < 1 || header.version > 3)) throw new Error("Worker session version is unsupported.");
  if (header.id !== target.sessionId) throw new Error("Worker session id mismatch.");
  if (path.resolve(header.cwd) !== path.resolve(target.workspaceRoot)) throw new Error("Worker session workspace mismatch.");
  if (target.role === "work") {
    if (!header.parentSession || path.resolve(header.parentSession) !== path.resolve(target.parentSessionFile)) throw new Error("Worker session parent mismatch.");
  } else if (header.parentSession !== undefined) {
    throw new Error("Worker session unexpectedly inherits a parent conversation.");
  }
}

function activeSessionEntries(entries: WorkerSessionEntry[]): WorkerSessionEntry[] {
  const byId = new Map<string, WorkerSessionEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error("Worker run session range contains duplicate entry ids.");
    byId.set(entry.id, entry);
  }
  const leaf = entries.at(-1);
  if (!leaf) return [];
  const branch: WorkerSessionEntry[] = [];
  const seen = new Set<string>();
  let current: WorkerSessionEntry | undefined = leaf;
  while (current) {
    if (seen.has(current.id)) throw new Error("Worker run session branch contains a cycle.");
    seen.add(current.id);
    branch.push(current);
    if (current.parentId === null) break;
    current = byId.get(current.parentId);
    if (!current) break;
  }
  branch.reverse();
  let compactionIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) if (branch[index]?.type === "compaction") { compactionIndex = index; break; }
  if (compactionIndex < 0) return branch;
  const compaction = branch[compactionIndex]!;
  const firstKeptEntryId = typeof compaction.firstKeptEntryId === "string" ? compaction.firstKeptEntryId : undefined;
  const keptIndex = firstKeptEntryId ? branch.findIndex((entry) => entry.id === firstKeptEntryId) : -1;
  return [compaction, ...(keptIndex >= 0 && keptIndex < compactionIndex ? branch.slice(keptIndex, compactionIndex) : []), ...branch.slice(compactionIndex + 1)];
}

function renderableBlocks(entry: WorkerSessionEntry): WorkerSessionViewBlock[] {
  if (entry.type === "message") return messageBlocks(entry);
  if (entry.type === "compaction") return [{ kind: "compaction", label: `Compaction · ${numberField(entry.tokensBefore)} tokens`, timestamp: entry.timestamp, text: textField(entry.summary, "(empty compaction summary)") }];
  if (entry.type === "branch_summary") return [{ kind: "compaction", label: "Branch summary", timestamp: entry.timestamp, text: textField(entry.summary, "(empty branch summary)") }];
  if (entry.type === "model_change") return [{ kind: "status", label: "Model", timestamp: entry.timestamp, text: `${textField(entry.provider, "unknown")}/${textField(entry.modelId, "unknown")}` }];
  if (entry.type === "thinking_level_change") return [{ kind: "status", label: "Thinking", timestamp: entry.timestamp, text: textField(entry.thinkingLevel, "unknown") }];
  if (entry.type === "custom_message" && entry.display === true) return [{ kind: "custom", label: textField(entry.customType, "Custom message"), timestamp: entry.timestamp, text: contentText(entry.content) }];
  return [];
}

function messageBlocks(entry: WorkerSessionEntry): WorkerSessionViewBlock[] {
  const message = record(entry.message);
  if (!message) return [{ kind: "status", label: "Malformed message", timestamp: entry.timestamp, text: "Message payload was not an object." }];
  const role = typeof message.role === "string" ? message.role : "unknown";
  if (role === "assistant") {
    const model = [message.provider, message.model].filter((value): value is string => typeof value === "string").join("/");
    const blocks: WorkerSessionViewBlock[] = [];
    for (const part of contentParts(message.content)) {
      if (part === undefined || part === null) continue;
      const value = record(part);
      if (value?.type === "thinking") blocks.push({ kind: "thinking", label: "Thinking", timestamp: entry.timestamp, text: textField(value.thinking, textField(value.text, "")) });
      else if (value?.type === "toolCall") blocks.push({ kind: "tool", label: `Tool call · ${textField(value.name, "unknown")}`, timestamp: entry.timestamp, text: boundedJson(value.arguments ?? value.input ?? {}) });
      else blocks.push({ kind: "assistant", label: model ? `Assistant · ${model}` : "Assistant", timestamp: entry.timestamp, text: partText(part) });
    }
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    if (stopReason === "error" || stopReason === "aborted") blocks.push({ kind: "error", label: stopReason === "error" ? "Provider error" : "Provider aborted", timestamp: entry.timestamp, text: textField(message.errorMessage, stopReason === "error" ? "The provider ended this response with an error." : "The provider response was aborted.") });
    return blocks.length ? blocks : [{ kind: "assistant", label: model ? `Assistant · ${model}` : "Assistant", timestamp: entry.timestamp, text: "(empty message)" }];
  }
  if (role === "toolResult") {
    const failed = message.isError === true;
    return [{ kind: failed ? "error" : "toolResult", label: `${failed ? "Tool error" : "Tool result"}${typeof message.toolName === "string" ? ` · ${message.toolName}` : ""}`, timestamp: entry.timestamp, text: contentText(message.content) }];
  }
  if (role === "user") return [{ kind: "user", label: "User", timestamp: entry.timestamp, text: contentText(message.content) }];
  const fallback = contentText(message.content) || boundedJson(message);
  return [{ kind: "custom", label: role, timestamp: entry.timestamp, text: fallback }];
}

function wrappedBody(theme: Theme, state: WorkerSessionViewerState, width: number): { lines: string[]; omittedLines: boolean } {
  const cached = state.wrappedBodyCache;
  if (cached && cached.snapshot === state.snapshot && cached.theme === theme && cached.width === width) return cached;
  const chunks: string[][] = [];
  let total = 0;
  let omittedLines = false;
  for (let index = state.snapshot.blocks.length - 1; index >= 0; index -= 1) {
    const rendered = renderBlock(theme, state.snapshot.blocks[index]!, width);
    if (total + rendered.length > MAX_RENDER_LINES) {
      const available = MAX_RENDER_LINES - total;
      if (available > 0) chunks.push(rendered.slice(-available));
      omittedLines = true;
      break;
    }
    chunks.push(rendered);
    total += rendered.length;
  }
  const lines = chunks.reverse().flat();
  if (lines.length === 0) lines.push(theme.fg("dim", "(No renderable messages on the active session branch.)"));
  const value: WrappedBodyCache = { snapshot: state.snapshot, theme, width, lines, omittedLines };
  state.wrappedBodyCache = value;
  return value;
}

function renderBlock(theme: Theme, block: WorkerSessionViewBlock, width: number): string[] {
  const labelColor: ThemeColor = block.kind === "user" ? "accent" : block.kind === "tool" ? "toolTitle" : block.kind === "toolResult" ? "success" : block.kind === "error" ? "error" : block.kind === "thinking" ? "muted" : block.kind === "compaction" ? "warning" : block.kind === "status" ? "dim" : "text";
  const label = `${theme.fg(labelColor, theme.bold(sanitizeViewText(block.label).slice(0, 256)))} ${theme.fg("dim", sanitizeViewText(block.timestamp).slice(0, 128))}`;
  const textWidth = Math.max(1, width - 2);
  const text = boundBlockText(block.text);
  const content: string[] = [];
  for (const rawLine of text.split("\n")) {
    for (const wrapped of wrapTextWithAnsi(sanitizeViewText(rawLine), textWidth)) {
      content.push(`  ${wrapped}`);
      if (content.length >= MAX_BLOCK_RENDER_LINES) { content.push(theme.fg("dim", "  [… wrapped block truncated …]")); break; }
    }
    if (content.length > MAX_BLOCK_RENDER_LINES) break;
  }
  return ["", label, ...(content.length ? content : [theme.fg("dim", "  (empty)")])];
}

function contentParts(content: unknown): unknown[] { return Array.isArray(content) ? content : [content]; }
function contentText(content: unknown): string { return contentParts(content).map(partText).filter(Boolean).join("\n"); }
function partText(part: unknown): string {
  if (typeof part === "string") return part;
  const value = record(part);
  if (!value) return "";
  if (typeof value.text === "string") return value.text;
  if (value.type === "image") return `[image${typeof value.mimeType === "string" ? ` · ${value.mimeType}` : ""}]`;
  if (value.type === "toolCall") return `[tool call · ${textField(value.name, "unknown")}] ${boundedJson(value.arguments ?? value.input ?? {})}`;
  return boundedJson(value);
}
function boundBlockText(value: string): string { return value.length <= MAX_BLOCK_TEXT ? value : `${value.slice(0, MAX_BLOCK_TEXT)}\n[… block truncated …]`; }
function boundedJson(value: unknown): string { try { return boundBlockText(JSON.stringify(value)); } catch { return "[unserializable content]"; } }
function textField(value: unknown, fallback: string): string { return typeof value === "string" ? value : fallback; }
function numberField(value: unknown): string { return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown"; }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function isSessionHeader(value: unknown): value is WorkerSessionHeader { const item = record(value); return item?.type === "session" && (item.version === undefined || typeof item.version === "number") && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256 && typeof item.timestamp === "string" && item.timestamp.length <= 128 && typeof item.cwd === "string" && item.cwd.length <= 4096 && (item.parentSession === undefined || (typeof item.parentSession === "string" && item.parentSession.length <= 4096)); }
function isSessionEntry(value: unknown): value is WorkerSessionEntry { const item = record(value); return typeof item?.type === "string" && item.type.length <= 64 && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256 && (item.parentId === null || (typeof item.parentId === "string" && item.parentId.length <= 256)) && typeof item.timestamp === "string" && item.timestamp.length <= 128; }
function sameOrWithin(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function strictlyWithin(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safeErrorMessage(error: unknown): string { return sanitizeViewText(errorMessage(error)); }
