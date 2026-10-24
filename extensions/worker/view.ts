import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";

const MAX_SESSION_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_PAGE_LINES = 512;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const SESSION_READ_CHUNK = 1024 * 1024;
const INITIAL_LINE_INDEX_STRIDE = 128;
const MAX_LINE_INDEX_CHECKPOINTS = 65_536;
const MAX_LINE_INDEX_FILES = 16;
const MAX_BLOCK_TEXT = 16 * 1024;
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

type SessionLineCheckpoint = { lineNumber: number; offset: number };
type SessionLineIndex = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  newlineCount: number;
  lastByte?: number;
  stride: number;
  checkpoints: SessionLineCheckpoint[];
};

type ReadSessionPage = {
  headerLine: string;
  lines: Array<{ lineNumber: number; text: string }>;
  runStartLine: number;
  runEndLine: number;
  pageStartLine: number;
  pageEndLine: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  skippedOversizedEntries: number;
  incompleteTrailingEntry: boolean;
};

const sessionLineIndexes = new Map<string, SessionLineIndex>();

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
  sessionRoot: string;
  workspaceRoot: string;
  parentSessionFile: string;
  sessionStartLine?: number;
  sessionEndLine?: number;
};

export type WorkerSessionPageRequest =
  | { mode: "tail" }
  | { mode: "first" }
  | { mode: "before"; line: number }
  | { mode: "after"; line: number };

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
  malformedEntries: number;
  skippedOversizedEntries: number;
  incompleteTrailingEntry: boolean;
  runStartLine: number;
  runEndLine: number;
  pageStartLine: number;
  pageEndLine: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  refreshedAt: string;
};

type WrappedBodyCache = { snapshot: WorkerSessionViewSnapshot; theme: Theme; width: number; lines: string[]; blockStarts: number[]; truncatedBlocks: number };

export type WorkerSessionViewerState = {
  snapshot: WorkerSessionViewSnapshot;
  topLine: number;
  pinnedToEnd: boolean;
  error?: string;
  loading?: boolean;
  wrappedBodyCache?: WrappedBodyCache;
};

export type WorkerSessionViewerFrame = { lines: string[]; topLine: number; pageSize: number; maxTopLine: number };

export type WorkerSessionReadDependencies = {
  beforeOpen?: (file: string) => void;
  afterChunkRead?: (file: string, offset: number) => void;
  afterReadAttempt?: (file: string, attempt: number) => void;
};

type WorkerSessionViewerComponentOptions = {
  tui: TUI;
  getTheme: () => Theme;
  initialSnapshot: WorkerSessionViewSnapshot;
  loadSnapshot: (request: WorkerSessionPageRequest) => WorkerSessionViewSnapshot;
  done: (result: void) => void;
};

export function loadWorkerSessionViewSnapshot(
  target: WorkerSessionViewTarget,
  dependencies: WorkerSessionReadDependencies = {},
  request: WorkerSessionPageRequest = { mode: "tail" }
): WorkerSessionViewSnapshot {
  validateRunRange(target);
  const selected = readTrustedSessionPage(target, request, dependencies);
  const header = parseSessionHeader(selected.headerLine);
  validateSessionHeader(header, target);
  const { entries, malformedEntries } = parseSessionEntries(selected.lines);
  const active = activeSessionEntries(entries);
  return {
    target,
    blocks: active.flatMap(renderableBlocks),
    totalActiveEntries: active.length,
    malformedEntries,
    skippedOversizedEntries: selected.skippedOversizedEntries,
    incompleteTrailingEntry: selected.incompleteTrailingEntry,
    runStartLine: selected.runStartLine,
    runEndLine: selected.runEndLine,
    pageStartLine: selected.pageStartLine,
    pageEndLine: selected.pageEndLine,
    hasPreviousPage: selected.hasPreviousPage,
    hasNextPage: selected.hasNextPage,
    refreshedAt: new Date().toISOString()
  };
}

export async function openWorkerSessionViewer(context: ExtensionCommandContext, target: WorkerSessionViewTarget, loadTarget: () => WorkerSessionViewTarget = () => target): Promise<void> {
  if (!context.hasUI || context.mode !== "tui") {
    context.ui.notify("/worker:view requires interactive Pi TUI mode.", "warning");
    return;
  }
  let initialSnapshot: WorkerSessionViewSnapshot;
  try { initialSnapshot = loadWorkerSessionViewSnapshot(target); }
  catch (error) { context.ui.notify(safeErrorMessage(error), "error"); return; }
  try {
    await context.ui.custom<void>((tui, _theme, _keybindings, done) => createWorkerSessionViewerComponent({
      tui,
      getTheme: () => context.ui.theme,
      initialSnapshot,
      loadSnapshot: (request) => loadWorkerSessionViewSnapshot(loadTarget(), {}, request),
      done
    }));
  } catch (error) { context.ui.notify(safeErrorMessage(error), "error"); }
}

export function createWorkerSessionViewerComponent(options: WorkerSessionViewerComponentOptions): Component {
  let pageSize = 1;
  let maxTopLine = 0;
  const state: WorkerSessionViewerState = { snapshot: options.initialSnapshot, topLine: 0, pinnedToEnd: true };
  const move = (delta: number) => {
    state.pinnedToEnd = false;
    state.topLine = Math.max(0, Math.min(maxTopLine, state.topLine + delta));
    options.tui.requestRender();
  };
  const moveBlock = (direction: -1 | 1) => {
    const starts = state.wrappedBodyCache?.blockStarts;
    if (!starts?.length) return move(direction);
    let current = 0;
    for (let index = 1; index < starts.length && starts[index]! <= state.topLine; index += 1) current = index;
    const next = Math.max(0, Math.min(starts.length - 1, current + direction));
    state.pinnedToEnd = false; state.topLine = starts[next]!; options.tui.requestRender();
  };
  const load = (request: WorkerSessionPageRequest, placement: "start" | "end") => {
    if (state.loading) return;
    state.loading = true;
    state.error = undefined;
    options.tui.requestRender();
    setImmediate(() => {
      try {
        state.snapshot = options.loadSnapshot(request);
        state.wrappedBodyCache = undefined;
        state.error = undefined;
        state.pinnedToEnd = placement === "end";
        state.topLine = 0;
      } catch (error) { state.error = safeErrorMessage(error); }
      finally { state.loading = false; options.tui.requestRender(); }
    });
  };
  return {
    render(width: number): string[] {
      const frame = buildWorkerSessionViewerFrame(options.getTheme(), state, width, options.tui.terminal.rows);
      state.topLine = frame.topLine;
      pageSize = frame.pageSize;
      maxTopLine = frame.maxTopLine;
      return frame.lines;
    },
    invalidate(): void { state.wrappedBodyCache = undefined; },
    handleInput(data: string): void {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q" || data === "Q") return options.done();
      if (data === "K") return moveBlock(-1);
      if (data === "J") return moveBlock(1);
      if (matchesKey(data, Key.up) || data === "k") return move(-1);
      if (matchesKey(data, Key.down) || data === "j") return move(1);
      if (matchesKey(data, Key.pageUp)) {
        if (state.topLine === 0 && state.snapshot.hasPreviousPage) load({ mode: "before", line: state.snapshot.pageStartLine }, "end");
        else move(-pageSize);
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        if (state.topLine >= maxTopLine && state.snapshot.hasNextPage) load({ mode: "after", line: state.snapshot.pageEndLine }, "start");
        else move(pageSize);
        return;
      }
      if (matchesKey(data, Key.home) || data === "g") {
        if (state.snapshot.hasPreviousPage) load({ mode: "first" }, "start");
        else { state.pinnedToEnd = false; state.topLine = 0; options.tui.requestRender(); }
        return;
      }
      if (matchesKey(data, Key.end) || data === "G") {
        if (state.snapshot.hasNextPage) load({ mode: "tail" }, "end");
        else { state.pinnedToEnd = true; options.tui.requestRender(); }
        return;
      }
      if (data === "[") { if (state.snapshot.hasPreviousPage) load({ mode: "before", line: state.snapshot.pageStartLine }, "end"); return; }
      if (data === "]") { if (state.snapshot.hasNextPage) load({ mode: "after", line: state.snapshot.pageEndLine }, "start"); return; }
      if (data === "r" || data === "R") load({ mode: "tail" }, "end");
    }
  };
}

export function buildWorkerSessionViewerFrame(theme: Theme, state: WorkerSessionViewerState, width: number, height: number): WorkerSessionViewerFrame {
  const safeWidth = Math.max(1, width);
  const body = wrappedBody(theme, state, safeWidth);
  const target = state.snapshot.target;
  const status = target.outcome ?? target.runStatus;
  const warnings = [
    state.snapshot.hasPreviousPage ? "Earlier run entries are available with [ or PgUp at the top (g opens the first page)." : undefined,
    state.snapshot.hasNextPage ? "Later run entries are available with ] or PgDn at the bottom (G opens the latest page)." : undefined,
    body.truncatedBlocks > 0 ? `${body.truncatedBlocks} long block${body.truncatedBlocks === 1 ? " was" : "s were"} explicitly truncated within this page.` : undefined,
    state.snapshot.skippedOversizedEntries > 0 ? `${state.snapshot.skippedOversizedEntries} session entr${state.snapshot.skippedOversizedEntries === 1 ? "y exceeds" : "ies exceed"} the ${MAX_SESSION_PAGE_BYTES}-byte per-entry display bound and ${state.snapshot.skippedOversizedEntries === 1 ? "was" : "were"} skipped.` : undefined,
    state.snapshot.malformedEntries > 0 ? `${state.snapshot.malformedEntries} malformed session entr${state.snapshot.malformedEntries === 1 ? "y was" : "ies were"} skipped.` : undefined,
    state.snapshot.incompleteTrailingEntry ? "The final unterminated session entry was still being written and was skipped." : undefined,
    state.loading ? "Loading transcript page…" : undefined,
    state.error
  ].filter((value): value is string => value !== undefined);
  const border = theme.fg("borderAccent", "─".repeat(safeWidth));
  const header = [
    border,
    theme.fg("accent", theme.bold("Managed worker conversation")),
    `${theme.fg(target.runStatus === "running" ? "warning" : "success", sanitizeViewText(status))} ${theme.fg("muted", `· ${sanitizeViewText(target.role)} · ${sanitizeViewText(target.workerId)}`)}`,
    theme.fg("dim", `run: ${sanitizeViewText(target.runId)} · session: ${sanitizeViewText(target.sessionId)}`),
    theme.fg("dim", `model: ${sanitizeViewText(target.modelSelection ?? "unavailable")}`),
    theme.fg("dim", `run lines: ${state.snapshot.runStartLine}..${target.sessionEndLine ?? "current"} · page: ${state.snapshot.pageStartLine}..${state.snapshot.pageEndLine}`),
    theme.fg("muted", `manual snapshot · refreshed=${sanitizeViewText(state.snapshot.refreshedAt)}`),
    theme.fg("dim", "↑↓ or j/k scroll • J/K block • PgUp/PgDn page/continue • [/] page • g/G first/latest"),
    theme.fg("dim", "r refreshes latest read-only snapshot • Esc/Ctrl+C/q closes"),
    ...warnings.map((warning) => theme.fg("warning", sanitizeViewText(warning))),
    border
  ];
  const pageSize = Math.max(1, Math.max(12, height) - header.length - 2);
  const maxTopLine = Math.max(0, body.lines.length - pageSize);
  const topLine = state.pinnedToEnd ? maxTopLine : Math.max(0, Math.min(state.topLine, maxTopLine));
  const visible = body.lines.slice(topLine, topLine + pageSize);
  const first = body.lines.length === 0 ? 0 : topLine + 1;
  const last = Math.min(body.lines.length, topLine + visible.length);
  const footer = [border, theme.fg("muted", `lines ${first}-${last} of ${body.lines.length} · page blocks ${state.snapshot.blocks.length} · active entries ${state.snapshot.totalActiveEntries}`)];
  return { lines: [...header, ...visible, ...footer].map((line) => truncateToWidth(line, safeWidth, "", false)), topLine, pageSize, maxTopLine };
}

export function sanitizeViewText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\r(?=\n|$)/g, "")
    .replace(/\t/g, "    ")
    .replace(/\r/g, "�")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�")
    .replace(BIDI_CONTROLS, "�");
}

export function countSessionLines(file: string): number {
  const exact = path.resolve(file);
  let leaf;
  try { leaf = lstatSync(exact); } catch { throw new Error("Worker session file is unavailable while counting lines."); }
  if (!leaf.isFile()) throw new Error("Worker session path is not a regular file while counting lines.");
  let fd: number;
  try { fd = openSync(exact, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error("Worker session file could not be opened safely while counting lines."); }
  try {
    let opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== leaf.dev || opened.ino !== leaf.ino) throw new Error("Worker session changed while counting lines.");
    let index = ensureSessionLineIndex(fd, exact, opened, opened.size);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const after = fstatSync(fd);
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size < opened.size) throw new Error("Worker session changed while counting lines.");
      if (after.size === opened.size) break;
      opened = after;
      index = ensureSessionLineIndex(fd, exact, opened, opened.size);
    }
    const current = lstatSync(exact);
    if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("Worker session changed while counting lines.");
    return sessionLineCount(index);
  } finally { closeSync(fd); }
}

function validateRunRange(target: WorkerSessionViewTarget): void {
  if (target.sessionStartLine === undefined) {
    if (target.runStatus === "queued") return;
    throw new Error("Worker run has no retained session range.");
  }
  if (!Number.isSafeInteger(target.sessionStartLine) || target.sessionStartLine < 1) throw new Error("Worker run session range is invalid.");
  if (target.sessionEndLine !== undefined && (!Number.isSafeInteger(target.sessionEndLine) || target.sessionEndLine < target.sessionStartLine)) throw new Error("Worker run session range is invalid.");
}

function readTrustedSessionPage(target: WorkerSessionViewTarget, request: WorkerSessionPageRequest, dependencies: WorkerSessionReadDependencies): ReadSessionPage {
  const sessionRoot = realpathSync(target.sessionRoot);
  const requested = path.resolve(target.sessionFile);
  const canonicalParent = realpathSync(path.dirname(requested));
  if (!sameOrWithin(sessionRoot, canonicalParent)) throw new Error("Worker session file is outside its retained session directory.");
  const exact = path.join(canonicalParent, path.basename(requested));
  if (!strictlyWithin(sessionRoot, exact)) throw new Error("Worker session file is outside its retained session directory.");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return readStableSessionPage(exact, target, request, dependencies, attempt); }
    catch (error) {
      if (attempt === 0 && error instanceof SessionChangedDuringReadError) continue;
      if (error instanceof SessionChangedDuringReadError) throw new Error("Worker session changed while reading; refresh the view.");
      throw error;
    }
  }
  throw new Error("Worker session changed while reading; refresh the view.");
}

class SessionChangedDuringReadError extends Error {}

function readStableSessionPage(file: string, target: WorkerSessionViewTarget, request: WorkerSessionPageRequest, dependencies: WorkerSessionReadDependencies, attempt: number): ReadSessionPage {
  let leaf;
  try { leaf = lstatSync(file); } catch { throw new Error("Worker session file is unavailable."); }
  if (leaf.isSymbolicLink()) throw new Error("Worker session file cannot be a symbolic link.");
  if (!leaf.isFile()) throw new Error("Worker session path is not a regular file.");
  dependencies.beforeOpen?.(file);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (record(error)?.code === "ELOOP") throw new Error("Worker session file cannot be a symbolic link.");
    throw new Error("Worker session file could not be opened safely.");
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("Worker session path is not a regular file.");
    if (opened.dev !== leaf.dev || opened.ino !== leaf.ino) throw new SessionChangedDuringReadError();
    const headerLine = readHeaderLine(fd, opened.size);
    if (target.sessionStartLine === undefined) return { headerLine, lines: [], runStartLine: 1, runEndLine: 0, pageStartLine: 1, pageEndLine: 0, hasPreviousPage: false, hasNextPage: false, skippedOversizedEntries: 0, incompleteTrailingEntry: false };
    const index = ensureSessionLineIndex(fd, file, opened, opened.size, dependencies);
    const availableLines = sessionLineCount(index);
    if (target.sessionEndLine !== undefined && availableLines < target.sessionEndLine) throw new Error("Worker session does not contain the retained run end line.");
    const runStartLine = Math.max(2, target.sessionStartLine);
    const runEndLine = Math.max(runStartLine - 1, target.sessionEndLine ?? availableLines);
    const bounds = pageBounds(request, runStartLine, runEndLine);
    const page = readPageLines(fd, opened.size, index, bounds.startLine, bounds.endLine, request.mode === "tail" || request.mode === "before");
    dependencies.afterReadAttempt?.(file, attempt);
    const after = fstatSync(fd);
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino || after.size < opened.size || after.size === opened.size && after.mtimeMs !== opened.mtimeMs) throw new SessionChangedDuringReadError();
    let currentLeaf;
    try { currentLeaf = lstatSync(file); } catch { throw new SessionChangedDuringReadError(); }
    if (!currentLeaf.isFile() || currentLeaf.dev !== opened.dev || currentLeaf.ino !== opened.ino) throw new SessionChangedDuringReadError();
    return {
      headerLine,
      ...page,
      runStartLine,
      runEndLine,
      hasPreviousPage: page.pageStartLine > runStartLine,
      hasNextPage: page.pageEndLine < runEndLine
    };
  } finally { closeSync(fd); }
}

function pageBounds(request: WorkerSessionPageRequest, runStartLine: number, runEndLine: number): { startLine: number; endLine: number } {
  if (runEndLine < runStartLine) return { startLine: runStartLine, endLine: runStartLine - 1 };
  if (request.mode === "first") return { startLine: runStartLine, endLine: Math.min(runEndLine, runStartLine + MAX_SESSION_PAGE_LINES - 1) };
  if (request.mode === "after") { const startLine = Math.max(runStartLine, request.line + 1); return { startLine, endLine: Math.min(runEndLine, startLine + MAX_SESSION_PAGE_LINES - 1) }; }
  const endLine = request.mode === "before" ? Math.min(runEndLine, request.line - 1) : runEndLine;
  return { startLine: Math.max(runStartLine, endLine - MAX_SESSION_PAGE_LINES + 1), endLine };
}

function ensureSessionLineIndex(fd: number, file: string, opened: Stats, snapshotSize: number, dependencies: WorkerSessionReadDependencies = {}): SessionLineIndex {
  let index = sessionLineIndexes.get(file);
  if (!index || index.dev !== opened.dev || index.ino !== opened.ino || index.size > snapshotSize || index.size === snapshotSize && index.mtimeMs !== opened.mtimeMs) {
    index = { dev: opened.dev, ino: opened.ino, size: 0, mtimeMs: opened.mtimeMs, newlineCount: 0, stride: INITIAL_LINE_INDEX_STRIDE, checkpoints: [{ lineNumber: 1, offset: 0 }] };
  }
  const buffer = Buffer.allocUnsafe(SESSION_READ_CHUNK);
  let position = index.size;
  while (position < snapshotSize) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, snapshotSize - position), position);
    if (count === 0) throw new SessionChangedDuringReadError();
    let cursor = 0;
    while (cursor < count) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline < 0 || newline >= count) break;
      index.newlineCount += 1;
      const nextLine = index.newlineCount + 1;
      if ((nextLine - 1) % index.stride === 0) index.checkpoints.push({ lineNumber: nextLine, offset: position + newline + 1 });
      cursor = newline + 1;
    }
    index.lastByte = buffer[count - 1];
    position += count;
    dependencies.afterChunkRead?.(file, position);
  }
  index.size = snapshotSize;
  index.mtimeMs = opened.mtimeMs;
  while (index.checkpoints.length > MAX_LINE_INDEX_CHECKPOINTS) {
    index.checkpoints = index.checkpoints.filter((_value, position) => position % 2 === 0);
    index.stride *= 2;
  }
  sessionLineIndexes.delete(file);
  sessionLineIndexes.set(file, index);
  while (sessionLineIndexes.size > MAX_LINE_INDEX_FILES) sessionLineIndexes.delete(sessionLineIndexes.keys().next().value!);
  return index;
}

function sessionLineCount(index: SessionLineIndex): number { return index.size === 0 ? 0 : index.newlineCount + (index.lastByte === 0x0a ? 0 : 1); }

function readHeaderLine(fd: number, snapshotSize: number): string {
  const length = Math.min(MAX_SESSION_HEADER_BYTES + 1, snapshotSize);
  const buffer = Buffer.allocUnsafe(Math.max(1, length));
  const count = length === 0 ? 0 : readSync(fd, buffer, 0, length, 0);
  const newline = buffer.subarray(0, count).indexOf(0x0a);
  if (newline < 0) {
    if (count > MAX_SESSION_HEADER_BYTES) throw new Error("Worker session header exceeds its read bound.");
    throw new Error("Worker session has no complete header.");
  }
  return decodeUtf8(buffer.subarray(0, newline));
}

function readPageLines(fd: number, snapshotSize: number, index: SessionLineIndex, desiredStart: number, desiredEnd: number, keepTail: boolean): Omit<ReadSessionPage, "headerLine" | "runStartLine" | "runEndLine" | "hasPreviousPage" | "hasNextPage"> {
  if (desiredEnd < desiredStart) return { lines: [], pageStartLine: desiredStart, pageEndLine: desiredEnd, skippedOversizedEntries: 0, incompleteTrailingEntry: false };
  const checkpoint = nearestCheckpoint(index, desiredStart);
  const buffer = Buffer.allocUnsafe(Math.min(SESSION_READ_CHUNK, Math.max(1, snapshotSize - checkpoint.offset)));
  const lines: Array<{ lineNumber: number; text: string; bytes: number }> = [];
  let totalBytes = 0;
  let skippedOversizedEntries = 0;
  let position = checkpoint.offset;
  let lineNumber = checkpoint.lineNumber;
  let parts: Buffer[] = [];
  let partBytes = 0;
  let oversized = false;
  let pageEndLine = desiredStart - 1;
  let incompleteTrailingEntry = false;
  let stoppedForPageBytes = false;

  const append = (part: Buffer) => {
    if (lineNumber < desiredStart || lineNumber > desiredEnd || oversized || part.length === 0) return;
    if (partBytes + part.length > MAX_SESSION_PAGE_BYTES) { oversized = true; parts = []; partBytes = 0; return; }
    parts.push(Buffer.from(part));
    partBytes += part.length;
  };
  const finish = (): boolean => {
    if (lineNumber >= desiredStart && lineNumber <= desiredEnd) {
      pageEndLine = lineNumber;
      if (oversized) skippedOversizedEntries += 1;
      else {
        const bytes = partBytes + 1;
        if (!keepTail && lines.length > 0 && totalBytes + bytes > MAX_SESSION_PAGE_BYTES) { pageEndLine = lineNumber - 1; stoppedForPageBytes = true; return false; }
        if (bytes > MAX_SESSION_PAGE_BYTES) skippedOversizedEntries += 1;
        else {
          lines.push({ lineNumber, text: decodeUtf8(Buffer.concat(parts, partBytes)), bytes });
          totalBytes += bytes;
          if (keepTail) while (totalBytes > MAX_SESSION_PAGE_BYTES && lines.length > 1) totalBytes -= lines.shift()!.bytes;
        }
      }
    }
    parts = []; partBytes = 0; oversized = false; lineNumber += 1;
    return lineNumber <= desiredEnd;
  };

  scan: while (position < snapshotSize && lineNumber <= desiredEnd) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, snapshotSize - position), position);
    if (count === 0) throw new SessionChangedDuringReadError();
    let cursor = 0;
    while (cursor < count) {
      const newline = buffer.indexOf(0x0a, cursor);
      const end = newline >= 0 && newline < count ? newline : count;
      if (end > cursor) append(buffer.subarray(cursor, end));
      if (newline < 0 || newline >= count) break;
      if (!finish()) break scan;
      cursor = newline + 1;
    }
    position += count;
  }
  if (!stoppedForPageBytes && lineNumber >= desiredStart && lineNumber <= desiredEnd && position >= snapshotSize && (partBytes > 0 || oversized)) {
    pageEndLine = lineNumber;
    incompleteTrailingEntry = true;
  }
  const publicLines = lines.map(({ lineNumber: number, text }) => ({ lineNumber: number, text }));
  const pageStartLine = publicLines[0]?.lineNumber ?? desiredStart;
  return { lines: publicLines, pageStartLine, pageEndLine: Math.max(desiredStart - 1, pageEndLine), skippedOversizedEntries, incompleteTrailingEntry };
}

function nearestCheckpoint(index: SessionLineIndex, lineNumber: number): SessionLineCheckpoint {
  let low = 0; let high = index.checkpoints.length - 1; let result = index.checkpoints[0]!;
  while (low <= high) { const middle = (low + high) >>> 1; const value = index.checkpoints[middle]!; if (value.lineNumber <= lineNumber) { result = value; low = middle + 1; } else high = middle - 1; }
  return result;
}

function decodeUtf8(value: Buffer): string { try { return new TextDecoder("utf-8", { fatal: true }).decode(value); } catch { throw new Error("Worker session is not valid UTF-8."); } }

function parseSessionHeader(text: string): WorkerSessionHeader {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Worker session header is malformed."); }
  if (!isSessionHeader(value)) throw new Error("Worker session header is invalid.");
  return value;
}

function parseSessionEntries(lines: Array<{ lineNumber: number; text: string }>): { entries: WorkerSessionEntry[]; malformedEntries: number } {
  const entries: WorkerSessionEntry[] = [];
  let malformedEntries = 0;
  for (const line of lines) {
    if (!line.text.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line.text); } catch { malformedEntries += 1; continue; }
    if (!isSessionEntry(value)) { malformedEntries += 1; continue; }
    entries.push({ ...value, lineNumber: line.lineNumber });
  }
  return { entries, malformedEntries };
}

function validateSessionHeader(header: WorkerSessionHeader, target: WorkerSessionViewTarget): void {
  if (header.version !== undefined && (!Number.isInteger(header.version) || header.version < 1 || header.version > 3)) throw new Error("Worker session version is unsupported.");
  if (header.id !== target.sessionId) throw new Error("Worker session id mismatch.");
  const lexicalWorkspace = path.resolve(target.workspaceRoot);
  const canonicalWorkspace = realpathSync(target.workspaceRoot);
  const headerWorkspace = path.resolve(header.cwd);
  if (headerWorkspace !== lexicalWorkspace && headerWorkspace !== canonicalWorkspace) throw new Error("Worker session workspace mismatch.");
  if (realpathSync(headerWorkspace) !== canonicalWorkspace) throw new Error("Worker session workspace mismatch.");
  if (target.role === "work") {
    const lexicalParent = path.resolve(target.parentSessionFile);
    const canonicalParent = realpathSync(target.parentSessionFile);
    const headerParent = header.parentSession && path.resolve(header.parentSession);
    if (!headerParent || headerParent !== lexicalParent && headerParent !== canonicalParent || realpathSync(headerParent) !== canonicalParent) throw new Error("Worker session parent mismatch.");
  } else if (header.parentSession !== undefined) throw new Error("Worker session unexpectedly inherits a parent conversation.");
}

function activeSessionEntries(entries: WorkerSessionEntry[]): WorkerSessionEntry[] {
  const byId = new Map<string, WorkerSessionEntry>();
  for (const entry of entries) { if (byId.has(entry.id)) throw new Error("Worker run session page contains duplicate entry ids."); byId.set(entry.id, entry); }
  const leaf = entries.at(-1);
  if (!leaf) return [];
  const branch: WorkerSessionEntry[] = [];
  const seen = new Set<string>();
  let current: WorkerSessionEntry | undefined = leaf;
  while (current) {
    if (seen.has(current.id)) throw new Error("Worker run session branch contains a cycle.");
    seen.add(current.id); branch.push(current);
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
  if (role === "bashExecution") {
    const command = textField(message.command, "(command unavailable)");
    const output = textField(message.output, textField(message.content, "(output unavailable)"));
    return [{ kind: "custom", label: "Bash execution", timestamp: entry.timestamp, text: `${command}\n${output}` }];
  }
  return [{ kind: "custom", label: role, timestamp: entry.timestamp, text: contentText(message.content) || "(No displayable content.)" }];
}

function wrappedBody(theme: Theme, state: WorkerSessionViewerState, width: number): WrappedBodyCache {
  const cached = state.wrappedBodyCache;
  if (cached && cached.snapshot === state.snapshot && cached.theme === theme && cached.width === width) return cached;
  const lines: string[] = [];
  const blockStarts: number[] = [];
  let truncatedBlocks = 0;
  for (const block of state.snapshot.blocks) {
    blockStarts.push(lines.length);
    const rendered = renderBlock(theme, block, width);
    lines.push(...rendered.lines);
    if (rendered.truncated) truncatedBlocks += 1;
  }
  if (lines.length === 0) lines.push(theme.fg("dim", "(No renderable messages on this run page.)"));
  const value: WrappedBodyCache = { snapshot: state.snapshot, theme, width, lines, blockStarts, truncatedBlocks };
  state.wrappedBodyCache = value;
  return value;
}

function renderBlock(theme: Theme, block: WorkerSessionViewBlock, width: number): { lines: string[]; truncated: boolean } {
  const labelColor: ThemeColor = block.kind === "user" ? "accent" : block.kind === "tool" ? "toolTitle" : block.kind === "toolResult" ? "success" : block.kind === "error" ? "error" : block.kind === "thinking" ? "muted" : block.kind === "compaction" ? "warning" : block.kind === "status" ? "dim" : "text";
  const label = `${theme.fg(labelColor, theme.bold(sanitizeViewText(block.label).slice(0, 256)))} ${theme.fg("dim", sanitizeViewText(block.timestamp).slice(0, 128))}`;
  const textWidth = Math.max(1, width - 2);
  const textTruncated = block.text.length > MAX_BLOCK_TEXT;
  const text = boundBlockText(block.text);
  const content: string[] = [];
  let displayTruncated = false;
  for (const rawLine of text.split("\n")) {
    for (const wrapped of wrapTextWithAnsi(sanitizeViewText(rawLine), textWidth)) {
      if (content.length >= MAX_BLOCK_RENDER_LINES) { displayTruncated = true; break; }
      content.push(`  ${wrapped}`);
    }
    if (displayTruncated) break;
  }
  if (displayTruncated) content.push(theme.fg("dim", "  [… block display truncated …]"));
  return { lines: ["", label, ...(content.length ? content : [theme.fg("dim", "  (empty)")])], truncated: textTruncated || displayTruncated };
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
  return `[${typeof value.type === "string" ? sanitizeViewText(value.type) : "unsupported content"}]`;
}
function boundBlockText(value: string): string { return value.length <= MAX_BLOCK_TEXT ? value : `${value.slice(0, MAX_BLOCK_TEXT)}\n[… block text truncated …]`; }
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
