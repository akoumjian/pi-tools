import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";

const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_ENTRIES = 4096;
const MAX_VIEW_BLOCKS = 500;
const MAX_BLOCK_TEXT = 16 * 1024;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

type WorkerSessionEntry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  lineNumber?: number;
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
  kind: "user" | "assistant" | "thinking" | "tool" | "toolResult" | "status" | "compaction" | "custom";
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

export type WorkerSessionViewerState = {
  snapshot: WorkerSessionViewSnapshot;
  topLine: number;
  pinnedToEnd: boolean;
  error?: string;
};

export type WorkerSessionViewerFrame = { lines: string[]; topLine: number; pageSize: number };

type WorkerSessionViewerComponentOptions = {
  tui: TUI;
  getTheme: () => Theme;
  initialSnapshot: WorkerSessionViewSnapshot;
  loadSnapshot: () => WorkerSessionViewSnapshot;
  done: (result: void) => void;
};

export function loadWorkerSessionViewSnapshot(target: WorkerSessionViewTarget): WorkerSessionViewSnapshot {
  const content = readTrustedSessionFile(target);
  const { header, entries, malformedEntries, incompleteTrailingEntry } = parseWorkerSession(content);
  validateSessionHeader(header, target);
  const entriesThroughRun = target.sessionEndLine === undefined ? entries : entries.filter((entry) => (entry.lineNumber ?? Number.MAX_SAFE_INTEGER) <= target.sessionEndLine!);
  const active = selectRunEntries(activeSessionEntries(entriesThroughRun), target);
  const blocks = active.flatMap(renderableBlocks);
  const omittedEntries = Math.max(0, blocks.length - MAX_VIEW_BLOCKS);
  return {
    target,
    blocks: blocks.slice(-MAX_VIEW_BLOCKS),
    totalActiveEntries: active.length,
    omittedEntries,
    malformedEntries,
    incompleteTrailingEntry,
    refreshedAt: new Date().toISOString()
  };
}

export async function openWorkerSessionViewer(context: ExtensionCommandContext, target: WorkerSessionViewTarget): Promise<void> {
  if (!context.hasUI || context.mode !== "tui") {
    context.ui.notify("/worker:view requires interactive Pi TUI mode.", "warning");
    return;
  }
  let initialSnapshot: WorkerSessionViewSnapshot;
  try {
    initialSnapshot = loadWorkerSessionViewSnapshot(target);
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
    return;
  }
  try {
    await context.ui.custom<void>((tui, _theme, _keybindings, done) => createWorkerSessionViewerComponent({
      tui,
      getTheme: () => context.ui.theme,
      initialSnapshot,
      loadSnapshot: () => loadWorkerSessionViewSnapshot(target),
      done
    }));
  } catch (error) {
    context.ui.notify(errorMessage(error), "error");
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
      state.error = undefined;
    } catch (error) {
      state.error = errorMessage(error);
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
  const target = state.snapshot.target;
  const status = target.outcome ?? target.runStatus;
  const warnings = [
    state.snapshot.omittedEntries > 0 ? `${state.snapshot.omittedEntries} older rendered entr${state.snapshot.omittedEntries === 1 ? "y" : "ies"} omitted by the ${MAX_VIEW_BLOCKS}-entry view bound.` : undefined,
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
    theme.fg("muted", `manual snapshot · refreshed=${state.snapshot.refreshedAt}`),
    theme.fg("dim", "↑↓ or j/k scroll • PgUp/PgDn page • Home/End or g/G jump"),
    theme.fg("dim", "r refreshes this read-only view • Esc/Ctrl+C/q closes"),
    ...warnings.map((warning) => theme.fg("warning", sanitizeViewText(warning))),
    border
  ];
  const body = state.snapshot.blocks.flatMap((block) => renderBlock(theme, block, safeWidth));
  if (body.length === 0) body.push(theme.fg("dim", "(No renderable messages on the active session branch.)"));
  const pageSize = Math.max(1, Math.max(12, height) - header.length - 2);
  const maxTopLine = Math.max(0, body.length - pageSize);
  const topLine = state.pinnedToEnd ? maxTopLine : Math.max(0, Math.min(state.topLine, maxTopLine));
  const visible = body.slice(topLine, topLine + pageSize);
  const first = body.length === 0 ? 0 : topLine + 1;
  const last = Math.min(body.length, topLine + visible.length);
  const footer = [border, theme.fg("muted", `lines ${first}-${last} of ${body.length} · active entries ${state.snapshot.totalActiveEntries}`)];
  return { lines: [...header, ...visible, ...footer].map((line) => truncateToWidth(line, safeWidth, "", false)), topLine, pageSize };
}

export function sanitizeViewText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\t/g, "    ")
    .replace(/\r/g, "�")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�")
    .replace(BIDI_CONTROLS, "�");
}

function readTrustedSessionFile(target: WorkerSessionViewTarget): string {
  const workerRoot = realpathSync(path.dirname(path.resolve(target.workspaceRoot)));
  const sessionRoot = realpathSync(path.join(workerRoot, "session"));
  const lexical = path.resolve(target.sessionFile);
  if (!strictlyWithin(sessionRoot, lexical)) throw new Error("Worker session file is outside its retained session directory.");
  if (lstatSync(lexical).isSymbolicLink()) throw new Error("Worker session file cannot be a symbolic link.");
  const exact = realpathSync(lexical);
  if (!strictlyWithin(sessionRoot, exact)) throw new Error("Worker session file resolves outside its retained session directory.");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return readStableFile(exact); }
    catch (error) {
      if (attempt === 0 && error instanceof SessionChangedDuringReadError) continue;
      throw error;
    }
  }
  throw new Error("Worker session changed while reading; refresh the view.");
}

class SessionChangedDuringReadError extends Error {}

function readStableFile(file: string): string {
  const before = statSync(file);
  if (!before.isFile()) throw new Error("Worker session path is not a regular file.");
  if (before.size > MAX_SESSION_BYTES) throw new Error(`Worker session is ${before.size} bytes; /worker:view accepts at most ${MAX_SESSION_BYTES} bytes.`);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new SessionChangedDuringReadError();
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd);
    if (offset !== buffer.length || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.dev !== opened.dev || after.ino !== opened.ino) throw new SessionChangedDuringReadError();
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { throw new Error("Worker session is not valid UTF-8."); }
  } finally { closeSync(fd); }
}

function parseWorkerSession(content: string): { header: WorkerSessionHeader; entries: WorkerSessionEntry[]; malformedEntries: number; incompleteTrailingEntry: boolean } {
  const lines = content.split("\n");
  const completeLineCount = content.endsWith("\n") ? lines.length : Math.max(0, lines.length - 1);
  const incompleteTrailingEntry = !content.endsWith("\n") && lines.at(-1)?.trim() !== "";
  let header: WorkerSessionHeader | undefined;
  const entries: WorkerSessionEntry[] = [];
  let malformedEntries = 0;
  for (let index = 0; index < completeLineCount; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch {
      if (header === undefined) throw new Error("Worker session header is malformed.");
      malformedEntries += 1;
      continue;
    }
    if (header === undefined) {
      if (!isSessionHeader(value)) throw new Error("Worker session header is invalid.");
      header = value;
      continue;
    }
    if (entries.length >= MAX_SESSION_ENTRIES) throw new Error(`Worker session exceeds the ${MAX_SESSION_ENTRIES}-entry parsing bound.`);
    if (!isSessionEntry(value)) { malformedEntries += 1; continue; }
    entries.push({ ...value, lineNumber: index + 1 });
  }
  if (!header) throw new Error("Worker session has no complete header.");
  return { header, entries, malformedEntries, incompleteTrailingEntry };
}

function validateSessionHeader(header: WorkerSessionHeader, target: WorkerSessionViewTarget): void {
  if (header.version !== undefined && (!Number.isInteger(header.version) || header.version < 1 || header.version > 3)) throw new Error(`Worker session version ${header.version} is unsupported.`);
  if (header.id !== target.sessionId) throw new Error(`Worker session id mismatch: expected ${target.sessionId}.`);
  if (realpathSync(header.cwd) !== realpathSync(target.workspaceRoot)) throw new Error("Worker session workspace mismatch.");
  if (target.role === "work") {
    if (!header.parentSession || realpathSync(header.parentSession) !== realpathSync(target.parentSessionFile)) throw new Error("Worker session parent mismatch.");
  } else if (header.parentSession !== undefined) {
    throw new Error(`${target.role} session unexpectedly inherits a parent conversation.`);
  }
}

function activeSessionEntries(entries: WorkerSessionEntry[]): WorkerSessionEntry[] {
  const byId = new Map<string, WorkerSessionEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error(`Worker session contains duplicate entry id: ${sanitizeViewText(entry.id)}.`);
    byId.set(entry.id, entry);
  }
  const leaf = entries.at(-1);
  if (!leaf) return [];
  const branch: WorkerSessionEntry[] = [];
  const seen = new Set<string>();
  let current: WorkerSessionEntry | undefined = leaf;
  while (current) {
    if (seen.has(current.id)) throw new Error("Worker session active branch contains a cycle.");
    seen.add(current.id);
    branch.push(current);
    if (current.parentId === null) break;
    current = byId.get(current.parentId);
    if (!current) throw new Error("Worker session active branch references a missing parent entry.");
  }
  branch.reverse();
  let compactionIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index]?.type === "compaction") { compactionIndex = index; break; }
  }
  if (compactionIndex < 0) return branch;
  const compaction = branch[compactionIndex]!;
  const firstKeptEntryId = typeof compaction.firstKeptEntryId === "string" ? compaction.firstKeptEntryId : undefined;
  const keptIndex = firstKeptEntryId ? branch.findIndex((entry) => entry.id === firstKeptEntryId) : -1;
  return [compaction, ...(keptIndex >= 0 && keptIndex < compactionIndex ? branch.slice(keptIndex, compactionIndex) : []), ...branch.slice(compactionIndex + 1)];
}

function selectRunEntries(entries: WorkerSessionEntry[], target: WorkerSessionViewTarget): WorkerSessionEntry[] {
  if (target.sessionStartLine === undefined) return target.runStatus === "queued" ? [] : entries;
  return entries.filter((entry) => (entry.lineNumber ?? 0) >= target.sessionStartLine! && (target.sessionEndLine === undefined || (entry.lineNumber ?? Number.MAX_SAFE_INTEGER) <= target.sessionEndLine));
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
      const value = record(part);
      if (value?.type === "thinking") blocks.push({ kind: "thinking", label: "Thinking", timestamp: entry.timestamp, text: textField(value.thinking, textField(value.text, "")) });
      else if (value?.type === "toolCall") blocks.push({ kind: "tool", label: `Tool call · ${textField(value.name, "unknown")}`, timestamp: entry.timestamp, text: boundedJson(value.arguments ?? value.input ?? {}) });
      else blocks.push({ kind: "assistant", label: model ? `Assistant · ${model}` : "Assistant", timestamp: entry.timestamp, text: partText(part) });
    }
    return blocks.length ? blocks : [{ kind: "assistant", label: model ? `Assistant · ${model}` : "Assistant", timestamp: entry.timestamp, text: "(empty message)" }];
  }
  if (role === "toolResult") {
    const failed = message.isError === true;
    return [{ kind: "toolResult", label: `${failed ? "Tool error" : "Tool result"}${typeof message.toolName === "string" ? ` · ${message.toolName}` : ""}`, timestamp: entry.timestamp, text: contentText(message.content) }];
  }
  if (role === "user") return [{ kind: "user", label: "User", timestamp: entry.timestamp, text: contentText(message.content) }];
  return [{ kind: "custom", label: sanitizeViewText(role), timestamp: entry.timestamp, text: contentText(message.content) }];
}

function renderBlock(theme: Theme, block: WorkerSessionViewBlock, width: number): string[] {
  const labelColor: ThemeColor = block.kind === "user" ? "accent" : block.kind === "tool" ? "toolTitle" : block.kind === "toolResult" ? "success" : block.kind === "thinking" ? "muted" : block.kind === "compaction" ? "warning" : block.kind === "status" ? "dim" : "text";
  const label = `${theme.fg(labelColor, theme.bold(sanitizeViewText(block.label).slice(0, 256)))} ${theme.fg("dim", sanitizeViewText(block.timestamp).slice(0, 128))}`;
  const textWidth = Math.max(1, width - 2);
  const text = boundBlockText(block.text);
  const content = text.split("\n").flatMap((line) => wrapTextWithAnsi(sanitizeViewText(line), textWidth)).map((line) => `  ${line}`);
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
function isSessionHeader(value: unknown): value is WorkerSessionHeader { const item = record(value); return item?.type === "session" && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256 && typeof item.timestamp === "string" && item.timestamp.length <= 128 && typeof item.cwd === "string" && item.cwd.length <= 4096 && (item.parentSession === undefined || (typeof item.parentSession === "string" && item.parentSession.length <= 4096)); }
function isSessionEntry(value: unknown): value is WorkerSessionEntry { const item = record(value); return typeof item?.type === "string" && item.type.length <= 64 && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256 && (item.parentId === null || (typeof item.parentId === "string" && item.parentId.length <= 256)) && typeof item.timestamp === "string" && item.timestamp.length <= 128; }
function strictlyWithin(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
