import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";

const MAX_SESSION_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_PAGE_LINES = 512;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const SESSION_READ_CHUNK = 1024 * 1024;
const INITIAL_LINE_INDEX_STRIDE = 1;
const MAX_LINE_INDEX_CHECKPOINTS = 65_536;
const MAX_LINE_INDEX_FILES = 16;
const MAX_BLOCK_TEXT = 16 * 1024;
const MAX_DEFAULT_BLOCK_RENDER_LINES = 60;
const MAX_THINKING_BLOCK_RENDER_LINES = 40;
const MAX_TOOL_BLOCK_RENDER_LINES = 24;
const SESSION_INDEX_FINGERPRINT_BYTES = 4096;
const MAX_VISIBILITY_CACHE_ENTRIES = 32;
const MAX_VISIBILITY_ENTRY_IDS = 8_192;
const MAX_PAGE_WRAP_CHARACTERS = 256 * 1024;
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

type SessionLineCheckpoint = { lineNumber: number; offset: number; pinned?: boolean };
type SessionLineIndex = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  newlineCount: number;
  lastByte?: number;
  stride: number;
  lineStartOffset: number;
  fingerprint: string;
  generation: number;
  checkpoints: SessionLineCheckpoint[];
};

type RunVisibility = { openingLine?: number; keptLine: number; hiddenEntries: number; compactionCount: number };
type RunVisibilityState = RunVisibility & {
  generation: number;
  analyzedEndLine: number;
  validEntries: number;
  entryIds: Map<string, { line: number; ordinal: number }>;
  pendingCompaction?: { line: number; ordinal: number; firstKeptEntryId?: string };
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
  hiddenCompactedEntries: number;
  compactionCount: number;
  previousVisibleEntries: number;
  nextVisibleEntries: number;
  totalVisibleEntries: number;
  droppedLeadingEntries: number;
  decodedBytes: number;
};

type ReadPageLines = Omit<ReadSessionPage, "headerLine" | "runStartLine" | "runEndLine" | "hasPreviousPage" | "hasNextPage" | "hiddenCompactedEntries" | "compactionCount" | "previousVisibleEntries" | "nextVisibleEntries" | "totalVisibleEntries">;

const sessionLineIndexes = new Map<string, SessionLineIndex>();
const runVisibilityStates = new Map<string, RunVisibilityState>();
let sessionLineIndexGeneration = 0;

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
  hiddenCompactedEntries: number;
  compactionCount: number;
  previousVisibleEntries: number;
  nextVisibleEntries: number;
  totalVisibleEntries: number;
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
  loadSnapshot: (request: WorkerSessionPageRequest) => WorkerSessionViewSnapshot | Promise<WorkerSessionViewSnapshot>;
  done: (result: void) => void;
};

export function loadWorkerSessionViewSnapshot(
  target: WorkerSessionViewTarget,
  dependencies: WorkerSessionReadDependencies = {},
  request: WorkerSessionPageRequest = { mode: "tail" }
): WorkerSessionViewSnapshot {
  validateRunRange(target);
  return snapshotFromPage(target, readTrustedSessionPage(target, request, dependencies));
}

export async function loadWorkerSessionViewSnapshotAsync(target: WorkerSessionViewTarget, request: WorkerSessionPageRequest = { mode: "tail" }): Promise<WorkerSessionViewSnapshot> {
  validateRunRange(target);
  return snapshotFromPage(target, await readTrustedSessionPageAsync(target, request));
}

function snapshotFromPage(target: WorkerSessionViewTarget, selected: ReadSessionPage): WorkerSessionViewSnapshot {
  const header = parseSessionHeader(selected.headerLine);
  validateSessionHeader(header, target);
  const { entries, malformedEntries } = parseSessionEntries(selected.lines);
  const ordered = orderedSessionEntries(entries);
  return {
    target,
    blocks: ordered.flatMap(renderableBlocks),
    totalActiveEntries: ordered.length,
    malformedEntries,
    skippedOversizedEntries: selected.skippedOversizedEntries,
    incompleteTrailingEntry: selected.incompleteTrailingEntry,
    hiddenCompactedEntries: selected.hiddenCompactedEntries,
    compactionCount: selected.compactionCount,
    previousVisibleEntries: selected.previousVisibleEntries,
    nextVisibleEntries: selected.nextVisibleEntries,
    totalVisibleEntries: selected.totalVisibleEntries,
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
  try { initialSnapshot = await loadWorkerSessionViewSnapshotAsync(target); }
  catch (error) { context.ui.notify(safeErrorMessage(error), "error"); return; }
  try {
    await context.ui.custom<void>((tui, _theme, _keybindings, done) => createWorkerSessionViewerComponent({
      tui,
      getTheme: () => context.ui.theme,
      initialSnapshot,
      loadSnapshot: (request) => loadWorkerSessionViewSnapshotAsync(loadTarget(), request),
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
      Promise.resolve().then(() => options.loadSnapshot(request)).then((snapshot) => {
        state.snapshot = snapshot;
        state.wrappedBodyCache = undefined;
        state.error = undefined;
        state.pinnedToEnd = placement === "end";
        state.topLine = 0;
      }, (error) => { state.error = safeErrorMessage(error); }).finally(() => {
        state.loading = false;
        options.tui.requestRender();
      });
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
    state.snapshot.hasPreviousPage ? `${state.snapshot.previousVisibleEntries} earlier visible run entr${state.snapshot.previousVisibleEntries === 1 ? "y is" : "ies are"} available with [ or PgUp at the top (g opens the first page).` : undefined,
    state.snapshot.hasNextPage ? `${state.snapshot.nextVisibleEntries} later visible run entr${state.snapshot.nextVisibleEntries === 1 ? "y is" : "ies are"} available with ] or PgDn at the bottom (G opens the latest page).` : undefined,
    body.truncatedBlocks > 0 ? `${body.truncatedBlocks} long block${body.truncatedBlocks === 1 ? " was" : "s were"} explicitly truncated within this page.` : undefined,
    state.snapshot.skippedOversizedEntries > 0 ? `${state.snapshot.skippedOversizedEntries} session entr${state.snapshot.skippedOversizedEntries === 1 ? "y exceeds" : "ies exceed"} the ${MAX_SESSION_PAGE_BYTES}-byte per-entry display bound and ${state.snapshot.skippedOversizedEntries === 1 ? "was" : "were"} skipped.` : undefined,
    state.snapshot.malformedEntries > 0 ? `${state.snapshot.malformedEntries} malformed session entr${state.snapshot.malformedEntries === 1 ? "y was" : "ies were"} skipped.` : undefined,
    state.snapshot.hiddenCompactedEntries > 0 ? `${state.snapshot.hiddenCompactedEntries} earlier run entr${state.snapshot.hiddenCompactedEntries === 1 ? "y is" : "ies are"} superseded by ${state.snapshot.compactionCount} compaction${state.snapshot.compactionCount === 1 ? "" : "s"}; the opening assignment remains on the first page.` : undefined,
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
    theme.fg("dim", "↑↓ or j/k scroll • J/K block • PgUp/PgDn continue • [/] page • g/Home first • G/End latest"),
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
  const footer = [border, theme.fg("muted", `lines ${first}-${last} of ${body.lines.length} · page blocks ${state.snapshot.blocks.length} · page entries ${state.snapshot.totalActiveEntries} · total visible ${state.snapshot.totalVisibleEntries}`)];
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
  const file = trustedSessionPath(target);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return readStableSessionPage(file, target, request, dependencies, attempt); }
    catch (error) {
      if (attempt === 0 && error instanceof SessionChangedDuringReadError) continue;
      if (error instanceof SessionChangedDuringReadError) throw new Error("Worker session changed while reading; refresh the view.");
      throw error;
    }
  }
  throw new Error("Worker session changed while reading; refresh the view.");
}

async function readTrustedSessionPageAsync(target: WorkerSessionViewTarget, request: WorkerSessionPageRequest): Promise<ReadSessionPage> {
  const file = trustedSessionPath(target);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await readStableSessionPageAsync(file, target, request); }
    catch (error) {
      if (attempt === 0 && error instanceof SessionChangedDuringReadError) { await yieldToEventLoop(); continue; }
      if (error instanceof SessionChangedDuringReadError) throw new Error("Worker session changed while reading; refresh the view.");
      throw error;
    }
  }
  throw new Error("Worker session changed while reading; refresh the view.");
}

function trustedSessionPath(target: WorkerSessionViewTarget): string {
  const sessionRoot = realpathSync(target.sessionRoot);
  const requested = path.resolve(target.sessionFile);
  const canonicalParent = realpathSync(path.dirname(requested));
  if (!sameOrWithin(sessionRoot, canonicalParent)) throw new Error("Worker session file is outside its retained session directory.");
  const exact = path.join(canonicalParent, path.basename(requested));
  if (!strictlyWithin(sessionRoot, exact)) throw new Error("Worker session file is outside its retained session directory.");
  return exact;
}

class SessionChangedDuringReadError extends Error {}

type OpenSessionSnapshot = { fd: number; opened: Stats };
function openSessionSnapshot(file: string, beforeOpen?: (file: string) => void): OpenSessionSnapshot {
  let leaf;
  try { leaf = lstatSync(file); } catch { throw new Error("Worker session file is unavailable."); }
  if (leaf.isSymbolicLink()) throw new Error("Worker session file cannot be a symbolic link.");
  if (!leaf.isFile()) throw new Error("Worker session path is not a regular file.");
  beforeOpen?.(file);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (record(error)?.code === "ELOOP") throw new Error("Worker session file cannot be a symbolic link.");
    throw new Error("Worker session file could not be opened safely.");
  }
  const opened = fstatSync(fd);
  if (!opened.isFile()) { closeSync(fd); throw new Error("Worker session path is not a regular file."); }
  if (opened.dev !== leaf.dev || opened.ino !== leaf.ino) { closeSync(fd); throw new SessionChangedDuringReadError(); }
  return { fd, opened };
}

function readStableSessionPage(file: string, target: WorkerSessionViewTarget, request: WorkerSessionPageRequest, dependencies: WorkerSessionReadDependencies, attempt: number): ReadSessionPage {
  const { fd, opened } = openSessionSnapshot(file, dependencies.beforeOpen);
  try {
    const headerLine = readHeaderLine(fd, opened.size);
    if (target.sessionStartLine === undefined) return emptyQueuedPage(headerLine);
    const index = ensureSessionLineIndex(fd, file, opened, opened.size, dependencies);
    const availableLines = sessionLineCount(index);
    if (target.sessionEndLine !== undefined && availableLines < target.sessionEndLine) throw new Error("Worker session does not contain the retained run end line.");
    const runStartLine = Math.max(2, target.sessionStartLine);
    const runEndLine = Math.max(runStartLine - 1, target.sessionEndLine ?? availableLines);
    const visibility = analyzeRunVisibility(fd, file, opened.size, index, runStartLine, runEndLine, target.sessionEndLine);
    const selected = selectVisiblePage(fd, opened.size, index, headerLine, request, runStartLine, runEndLine, visibility);
    dependencies.afterReadAttempt?.(file, attempt);
    validateSessionSnapshot(fd, file, opened);
    return selected;
  } finally { closeSync(fd); }
}

async function readStableSessionPageAsync(file: string, target: WorkerSessionViewTarget, request: WorkerSessionPageRequest): Promise<ReadSessionPage> {
  const { fd, opened } = openSessionSnapshot(file);
  try {
    const headerLine = readHeaderLine(fd, opened.size);
    if (target.sessionStartLine === undefined) return emptyQueuedPage(headerLine);
    const index = reusableSessionLineIndex(fd, file, opened, opened.size);
    while (index.size < opened.size && (target.sessionEndLine === undefined || sessionLineCount(index) < target.sessionEndLine)) {
      extendSessionLineIndex(fd, file, index, opened.size, {}, 1);
      retainSessionLineIndex(file, index);
      await yieldToEventLoop();
    }
    retainSessionLineIndex(file, index);
    const indexedLines = sessionLineCount(index);
    if (target.sessionEndLine !== undefined && indexedLines < target.sessionEndLine) throw new Error("Worker session does not contain the retained run end line.");
    const runStartLine = Math.max(2, target.sessionStartLine);
    const runEndLine = Math.max(runStartLine - 1, target.sessionEndLine ?? indexedLines);
    const visibility = await analyzeRunVisibilityCooperatively(fd, file, opened.size, index, runStartLine, runEndLine, target.sessionEndLine);
    await yieldToEventLoop();
    const selected = selectVisiblePage(fd, opened.size, index, headerLine, request, runStartLine, runEndLine, visibility);
    validateSessionSnapshot(fd, file, opened);
    return selected;
  } finally { closeSync(fd); }
}

function emptyQueuedPage(headerLine: string): ReadSessionPage {
  return { headerLine, lines: [], runStartLine: 1, runEndLine: 0, pageStartLine: 1, pageEndLine: 0, hasPreviousPage: false, hasNextPage: false, skippedOversizedEntries: 0, incompleteTrailingEntry: false, hiddenCompactedEntries: 0, compactionCount: 0, previousVisibleEntries: 0, nextVisibleEntries: 0, totalVisibleEntries: 0, droppedLeadingEntries: 0, decodedBytes: 0 };
}

function selectVisiblePage(fd: number, snapshotSize: number, index: SessionLineIndex, headerLine: string, request: WorkerSessionPageRequest, runStartLine: number, runEndLine: number, visibility: RunVisibility): ReadSessionPage {
  const bounds = visiblePageBounds(request, runStartLine, runEndLine, visibility);
  const page = readVisiblePage(fd, snapshotSize, index, bounds, request.mode === "tail" || request.mode === "before");
  const totalVisibleEntries = visibleLineCount(runEndLine, visibility);
  const previousVisibleEntries = visibleCountLessThan(page.pageStartLine, runEndLine, visibility);
  const nextVisibleEntries = Math.max(0, totalVisibleEntries - visibleCountLessThanOrEqual(page.pageEndLine, runEndLine, visibility));
  return { headerLine, ...page, runStartLine, runEndLine, hasPreviousPage: previousVisibleEntries > 0, hasNextPage: nextVisibleEntries > 0, hiddenCompactedEntries: visibility.hiddenEntries, compactionCount: visibility.compactionCount, previousVisibleEntries, nextVisibleEntries, totalVisibleEntries };
}

function validateSessionSnapshot(fd: number, file: string, opened: Stats): void {
  const after = fstatSync(fd);
  if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino || after.size < opened.size || after.size === opened.size && (after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)) throw new SessionChangedDuringReadError();
  let current;
  try { current = lstatSync(file); } catch { throw new SessionChangedDuringReadError(); }
  if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) throw new SessionChangedDuringReadError();
}

function yieldToEventLoop(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }

type VisiblePageBounds = { startLine: number; endLine: number; openingLine?: number };

function visiblePageBounds(request: WorkerSessionPageRequest, runStartLine: number, runEndLine: number, visibility: RunVisibility): VisiblePageBounds {
  const count = visibleLineCount(runEndLine, visibility);
  if (count === 0) return { startLine: runStartLine, endLine: runStartLine - 1 };
  let firstOrdinal: number;
  let lastOrdinal: number;
  if (request.mode === "first") { firstOrdinal = 0; lastOrdinal = Math.min(count - 1, MAX_SESSION_PAGE_LINES - 1); }
  else if (request.mode === "after") { firstOrdinal = visibleCountLessThanOrEqual(request.line, runEndLine, visibility); lastOrdinal = Math.min(count - 1, firstOrdinal + MAX_SESSION_PAGE_LINES - 1); }
  else {
    lastOrdinal = request.mode === "before" ? visibleCountLessThan(request.line, runEndLine, visibility) - 1 : count - 1;
    firstOrdinal = Math.max(0, lastOrdinal - MAX_SESSION_PAGE_LINES + 1);
  }
  if (firstOrdinal < 0 || firstOrdinal >= count || lastOrdinal < firstOrdinal) return { startLine: runStartLine, endLine: runStartLine - 1 };
  const firstLine = visibleLineAt(firstOrdinal, visibility);
  const lastLine = visibleLineAt(lastOrdinal, visibility);
  const openingIsSeparate = visibility.openingLine !== undefined && visibility.openingLine < visibility.keptLine && firstOrdinal === 0;
  return { startLine: openingIsSeparate && lastOrdinal > 0 ? visibility.keptLine : firstLine, endLine: lastLine, ...(openingIsSeparate ? { openingLine: visibility.openingLine } : {}) };
}

function visibleLineCount(runEndLine: number, visibility: RunVisibility): number {
  const preservedOpening = visibility.openingLine !== undefined && visibility.openingLine < visibility.keptLine ? 1 : 0;
  return preservedOpening + Math.max(0, runEndLine - visibility.keptLine + 1);
}
function visibleLineAt(ordinal: number, visibility: RunVisibility): number {
  const preservedOpening = visibility.openingLine !== undefined && visibility.openingLine < visibility.keptLine;
  if (preservedOpening && ordinal === 0) return visibility.openingLine!;
  return visibility.keptLine + ordinal - (preservedOpening ? 1 : 0);
}
function visibleCountLessThan(line: number, runEndLine: number, visibility: RunVisibility): number {
  const opening = visibility.openingLine !== undefined && visibility.openingLine < visibility.keptLine && visibility.openingLine < line ? 1 : 0;
  const range = Math.max(0, Math.min(runEndLine - visibility.keptLine + 1, line - visibility.keptLine));
  return opening + range;
}
function visibleCountLessThanOrEqual(line: number, runEndLine: number, visibility: RunVisibility): number {
  return visibleCountLessThan(line + 1, runEndLine, visibility);
}

function readVisiblePage(fd: number, snapshotSize: number, index: SessionLineIndex, bounds: VisiblePageBounds, keepTail: boolean): ReadPageLines {
  const byteBoundedStart = keepTail ? byteBoundedTailStart(index, bounds.startLine, bounds.endLine, snapshotSize) : bounds.startLine;
  let main = readPageLines(fd, snapshotSize, index, byteBoundedStart, bounds.endLine, keepTail);
  if (byteBoundedStart > bounds.startLine) { main.droppedLeadingEntries += byteBoundedStart - bounds.startLine; main.pageStartLine = byteBoundedStart; }
  if (bounds.openingLine === undefined || bounds.openingLine >= bounds.startLine || main.droppedLeadingEntries > 0) return main;
  const opening = readPageLines(fd, snapshotSize, index, bounds.openingLine, bounds.openingLine, false);
  if (opening.decodedBytes + main.decodedBytes > MAX_SESSION_PAGE_BYTES) {
    if (keepTail) return main;
    main = readPageLines(fd, snapshotSize, index, bounds.startLine, bounds.endLine, false, Math.max(1, MAX_SESSION_PAGE_BYTES - opening.decodedBytes));
  }
  return {
    lines: [...opening.lines, ...main.lines],
    pageStartLine: opening.pageStartLine,
    pageEndLine: main.pageEndLine >= main.pageStartLine ? main.pageEndLine : opening.pageEndLine,
    skippedOversizedEntries: opening.skippedOversizedEntries + main.skippedOversizedEntries,
    incompleteTrailingEntry: opening.incompleteTrailingEntry || main.incompleteTrailingEntry,
    droppedLeadingEntries: 0,
    decodedBytes: opening.decodedBytes + main.decodedBytes
  };
}

function byteBoundedTailStart(index: SessionLineIndex, desiredStart: number, desiredEnd: number, snapshotSize: number): number {
  if (desiredEnd < desiredStart) return desiredStart;
  let endOffset = snapshotSize;
  for (const checkpoint of index.checkpoints) {
    if (checkpoint.lineNumber > desiredEnd) { endOffset = checkpoint.offset; break; }
  }
  const candidates = index.checkpoints.filter((checkpoint) => checkpoint.lineNumber >= desiredStart && checkpoint.lineNumber <= desiredEnd);
  let low = 0; let high = candidates.length - 1; let result = desiredEnd;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const checkpoint = candidates[middle]!;
    if (endOffset - checkpoint.offset <= MAX_SESSION_PAGE_BYTES) { result = checkpoint.lineNumber; high = middle - 1; }
    else low = middle + 1;
  }
  return Math.max(desiredStart, result);
}

function visibilityStateKey(file: string, index: SessionLineIndex, runStartLine: number, fixedEndLine: number | undefined): string {
  return `${file}\0${index.dev}:${index.ino}:${index.generation}:${runStartLine}:${fixedEndLine ?? "running"}`;
}

function visibilityState(file: string, index: SessionLineIndex, runStartLine: number, fixedEndLine: number | undefined): { key: string; state: RunVisibilityState } {
  const key = visibilityStateKey(file, index, runStartLine, fixedEndLine);
  let state: RunVisibilityState | undefined = runVisibilityStates.get(key);
  if (!state) {
    const running = fixedEndLine === undefined ? undefined : runVisibilityStates.get(visibilityStateKey(file, index, runStartLine, undefined));
    if (running && running.analyzedEndLine === fixedEndLine) {
      state = { ...running, entryIds: new Map(running.entryIds) };
      if (running.pendingCompaction) state.pendingCompaction = { ...running.pendingCompaction };
    } else state = { generation: index.generation, analyzedEndLine: runStartLine - 1, validEntries: 0, entryIds: new Map(), keptLine: runStartLine, hiddenEntries: 0, compactionCount: 0 };
    runVisibilityStates.set(key, state);
  }
  runVisibilityStates.delete(key); runVisibilityStates.set(key, state);
  while (runVisibilityStates.size > MAX_VISIBILITY_CACHE_ENTRIES) runVisibilityStates.delete(runVisibilityStates.keys().next().value!);
  return { key, state };
}

function analyzeRunVisibility(fd: number, file: string, snapshotSize: number, index: SessionLineIndex, runStartLine: number, runEndLine: number, fixedEndLine?: number): RunVisibility {
  const { state } = visibilityState(file, index, runStartLine, fixedEndLine);
  if (state.analyzedEndLine < runEndLine) {
    const scan = scanRunEntries(fd, snapshotSize, index, Math.max(runStartLine, state.analyzedEndLine + 1), runEndLine, (entry, line) => updateVisibilityState(state, entry, line));
    state.analyzedEndLine = Math.max(state.analyzedEndLine, scan.lastCompleteLine);
  }
  if (state.pendingCompaction) resolveCompactionBoundary(fd, snapshotSize, index, runStartLine, state);
  return { openingLine: state.openingLine, keptLine: state.keptLine, hiddenEntries: state.hiddenEntries, compactionCount: state.compactionCount };
}

async function analyzeRunVisibilityCooperatively(fd: number, file: string, snapshotSize: number, index: SessionLineIndex, runStartLine: number, runEndLine: number, fixedEndLine?: number): Promise<RunVisibility> {
  const { state } = visibilityState(file, index, runStartLine, fixedEndLine);
  if (state.analyzedEndLine < runEndLine) {
    const scan = await scanRunEntriesCooperatively(fd, snapshotSize, index, Math.max(runStartLine, state.analyzedEndLine + 1), runEndLine, (entry, line) => updateVisibilityState(state, entry, line));
    state.analyzedEndLine = Math.max(state.analyzedEndLine, scan.lastCompleteLine);
  }
  if (state.pendingCompaction) await resolveCompactionBoundaryCooperatively(fd, snapshotSize, index, runStartLine, state);
  return { openingLine: state.openingLine, keptLine: state.keptLine, hiddenEntries: state.hiddenEntries, compactionCount: state.compactionCount };
}

function updateVisibilityState(state: RunVisibilityState, entry: WorkerSessionEntry, line: number): void {
  const ordinal = state.validEntries;
  state.entryIds.delete(entry.id);
  state.entryIds.set(entry.id, { line, ordinal });
  while (state.entryIds.size > MAX_VISIBILITY_ENTRY_IDS) state.entryIds.delete(state.entryIds.keys().next().value!);
  if (state.openingLine === undefined && entry.type === "message" && record(entry.message)?.role === "user") state.openingLine = line;
  if (entry.type === "compaction") {
    state.compactionCount += 1;
    const firstKeptEntryId = typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined;
    state.pendingCompaction = { line, ordinal, ...(firstKeptEntryId ? { firstKeptEntryId } : {}) };
    if (!firstKeptEntryId) applyCompactionBoundary(state, line, ordinal);
    else {
      const known = state.entryIds.get(firstKeptEntryId);
      if (known) applyCompactionBoundary(state, known.line, known.ordinal);
    }
  }
  state.validEntries += 1;
}

function applyCompactionBoundary(state: RunVisibilityState, keptLine: number, keptOrdinal: number): void {
  state.keptLine = keptLine;
  state.hiddenEntries = Math.max(0, keptOrdinal - (state.openingLine !== undefined && state.openingLine < keptLine ? 1 : 0));
  state.pendingCompaction = undefined;
}

function resolveCompactionBoundary(fd: number, snapshotSize: number, index: SessionLineIndex, runStartLine: number, state: RunVisibilityState): void {
  const pending = state.pendingCompaction;
  if (!pending) return;
  if (!pending.firstKeptEntryId) return applyCompactionBoundary(state, pending.line, pending.ordinal);
  const beforeRun = findEntryLine(fd, snapshotSize, index, 2, runStartLine - 1, pending.firstKeptEntryId);
  if (beforeRun !== undefined) return applyCompactionBoundary(state, runStartLine, 0);
  let ordinal = 0; let found: { line: number; ordinal: number } | undefined;
  scanRunEntries(fd, snapshotSize, index, runStartLine, pending.line, (entry, line) => { if (!found && entry.id === pending.firstKeptEntryId) found = { line, ordinal }; ordinal += 1; });
  if (found) applyCompactionBoundary(state, found.line, found.ordinal);
  else applyCompactionBoundary(state, pending.line, pending.ordinal);
}

async function resolveCompactionBoundaryCooperatively(fd: number, snapshotSize: number, index: SessionLineIndex, runStartLine: number, state: RunVisibilityState): Promise<void> {
  const pending = state.pendingCompaction;
  if (!pending) return;
  if (!pending.firstKeptEntryId) return applyCompactionBoundary(state, pending.line, pending.ordinal);
  const beforeRun = await findEntryLineCooperatively(fd, snapshotSize, index, 2, runStartLine - 1, pending.firstKeptEntryId);
  if (beforeRun !== undefined) return applyCompactionBoundary(state, runStartLine, 0);
  let ordinal = 0; let found: { line: number; ordinal: number } | undefined;
  await scanRunEntriesCooperatively(fd, snapshotSize, index, runStartLine, pending.line, (entry, line) => { if (!found && entry.id === pending.firstKeptEntryId) found = { line, ordinal }; ordinal += 1; });
  if (found) applyCompactionBoundary(state, found.line, found.ordinal);
  else applyCompactionBoundary(state, pending.line, pending.ordinal);
}

function findEntryLine(fd: number, snapshotSize: number, index: SessionLineIndex, startLine: number, endLine: number, id: string): number | undefined {
  if (endLine < startLine) return undefined;
  let found: number | undefined;
  scanRunEntries(fd, snapshotSize, index, startLine, endLine, (entry, line) => { if (found === undefined && entry.id === id) found = line; });
  return found;
}
async function findEntryLineCooperatively(fd: number, snapshotSize: number, index: SessionLineIndex, startLine: number, endLine: number, id: string): Promise<number | undefined> {
  if (endLine < startLine) return undefined;
  let found: number | undefined;
  await scanRunEntriesCooperatively(fd, snapshotSize, index, startLine, endLine, (entry, line) => { if (found === undefined && entry.id === id) found = line; });
  return found;
}

type RunEntryScanResult = { lastCompleteLine: number };

async function scanRunEntriesCooperatively(fd: number, snapshotSize: number, index: SessionLineIndex, startLine: number, endLine: number, visit: (entry: WorkerSessionEntry, line: number) => void): Promise<RunEntryScanResult> {
  let line = startLine;
  let lastCompleteLine = startLine - 1;
  while (line <= endLine) {
    const page = readPageLines(fd, snapshotSize, index, line, Math.min(endLine, line + MAX_SESSION_PAGE_LINES - 1), false);
    for (const item of page.lines) {
      let value: unknown;
      try { value = JSON.parse(item.text); } catch { continue; }
      if (isSessionEntry(value)) visit({ ...value, lineNumber: item.lineNumber }, item.lineNumber);
    }
    lastCompleteLine = page.incompleteTrailingEntry ? page.pageEndLine - 1 : page.pageEndLine;
    if (page.incompleteTrailingEntry) break;
    line = Math.max(line + 1, page.pageEndLine + 1);
    await yieldToEventLoop();
  }
  return { lastCompleteLine };
}

function scanRunEntries(fd: number, snapshotSize: number, index: SessionLineIndex, startLine: number, endLine: number, visit: (entry: WorkerSessionEntry, line: number) => void): RunEntryScanResult {
  let line = startLine;
  let lastCompleteLine = startLine - 1;
  while (line <= endLine) {
    const page = readPageLines(fd, snapshotSize, index, line, Math.min(endLine, line + MAX_SESSION_PAGE_LINES - 1), false);
    for (const item of page.lines) {
      let value: unknown;
      try { value = JSON.parse(item.text); } catch { continue; }
      if (isSessionEntry(value)) visit({ ...value, lineNumber: item.lineNumber }, item.lineNumber);
    }
    lastCompleteLine = page.incompleteTrailingEntry ? page.pageEndLine - 1 : page.pageEndLine;
    if (page.incompleteTrailingEntry) break;
    line = Math.max(line + 1, page.pageEndLine + 1);
  }
  return { lastCompleteLine };
}

function ensureSessionLineIndex(fd: number, file: string, opened: Stats, snapshotSize: number, dependencies: WorkerSessionReadDependencies = {}): SessionLineIndex {
  const index = reusableSessionLineIndex(fd, file, opened, snapshotSize);
  extendSessionLineIndex(fd, file, index, snapshotSize, dependencies);
  retainSessionLineIndex(file, index);
  return index;
}

function reusableSessionLineIndex(fd: number, file: string, opened: Stats, snapshotSize: number): SessionLineIndex {
  let index = sessionLineIndexes.get(file);
  const identityChanged = !index || index.dev !== opened.dev || index.ino !== opened.ino;
  const sizeInvalid = Boolean(index && index.size > snapshotSize);
  const sameSizeMetadataChanged = Boolean(index && index.size === snapshotSize && (index.mtimeMs !== opened.mtimeMs || index.ctimeMs !== opened.ctimeMs));
  const prefixChanged = Boolean(index && index.size <= snapshotSize && index.fingerprint !== sessionPrefixFingerprint(fd, index.size));
  if (identityChanged || sizeInvalid || sameSizeMetadataChanged || prefixChanged) {
    index = {
      dev: opened.dev, ino: opened.ino, size: 0, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs,
      newlineCount: 0, stride: INITIAL_LINE_INDEX_STRIDE, lineStartOffset: 0,
      fingerprint: sessionPrefixFingerprint(fd, 0), generation: ++sessionLineIndexGeneration, checkpoints: [{ lineNumber: 1, offset: 0, pinned: true }]
    };
  }
  return index!;
}

function extendSessionLineIndex(fd: number, file: string, index: SessionLineIndex, snapshotSize: number, dependencies: WorkerSessionReadDependencies = {}, chunks = Number.POSITIVE_INFINITY): void {
  const buffer = Buffer.allocUnsafe(SESSION_READ_CHUNK);
  let position = index.size;
  let chunksRead = 0;
  while (position < snapshotSize && chunksRead < chunks) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, snapshotSize - position), position);
    if (count === 0) throw new SessionChangedDuringReadError();
    let cursor = 0;
    while (cursor < count) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline < 0 || newline >= count) break;
      const absoluteNewline = position + newline;
      const oversized = absoluteNewline - index.lineStartOffset > MAX_SESSION_PAGE_BYTES;
      index.newlineCount += 1;
      const nextLine = index.newlineCount + 1;
      if ((nextLine - 1) % index.stride === 0 || oversized) {
        const previous = index.checkpoints.at(-1);
        const checkpoint = { lineNumber: nextLine, offset: absoluteNewline + 1, ...(oversized ? { pinned: true } : {}) };
        if (previous?.lineNumber === nextLine) index.checkpoints[index.checkpoints.length - 1] = { ...previous, ...checkpoint, pinned: previous.pinned || checkpoint.pinned };
        else index.checkpoints.push(checkpoint);
      }
      index.lineStartOffset = absoluteNewline + 1;
      cursor = newline + 1;
    }
    index.lastByte = buffer[count - 1];
    position += count;
    chunksRead += 1;
    index.size = position;
    dependencies.afterChunkRead?.(file, position);
  }
  index.size = position;
  index.mtimeMs = fstatSync(fd).mtimeMs;
  index.ctimeMs = fstatSync(fd).ctimeMs;
  index.fingerprint = sessionPrefixFingerprint(fd, position);
  while (index.checkpoints.length > MAX_LINE_INDEX_CHECKPOINTS) {
    index.checkpoints = index.checkpoints.filter((value, position) => value.pinned || position % 2 === 0);
    index.stride *= 2;
  }
}

function retainSessionLineIndex(file: string, index: SessionLineIndex): void {
  sessionLineIndexes.delete(file);
  sessionLineIndexes.set(file, index);
  while (sessionLineIndexes.size > MAX_LINE_INDEX_FILES) sessionLineIndexes.delete(sessionLineIndexes.keys().next().value!);
}

function sessionPrefixFingerprint(fd: number, size: number): string {
  const hash = createHash("sha256").update(String(size));
  for (const offset of uniqueNumbers([0, Math.max(0, size - SESSION_INDEX_FINGERPRINT_BYTES)])) {
    const length = Math.min(SESSION_INDEX_FINGERPRINT_BYTES, Math.max(0, size - offset));
    if (length === 0) continue;
    const buffer = Buffer.allocUnsafe(length);
    const count = readSync(fd, buffer, 0, length, offset);
    if (count !== length) throw new SessionChangedDuringReadError();
    hash.update(buffer.subarray(0, count));
  }
  return hash.digest("hex");
}

function uniqueNumbers(values: number[]): number[] { return [...new Set(values)]; }

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

function readPageLines(fd: number, snapshotSize: number, index: SessionLineIndex, desiredStart: number, desiredEnd: number, keepTail: boolean, maxPageBytes = MAX_SESSION_PAGE_BYTES): ReadPageLines {
  if (desiredEnd < desiredStart) return { lines: [], pageStartLine: desiredStart, pageEndLine: desiredEnd, skippedOversizedEntries: 0, incompleteTrailingEntry: false, droppedLeadingEntries: 0, decodedBytes: 0 };
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
  let droppedLeadingEntries = 0;

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
        if (!keepTail && totalBytes + bytes > maxPageBytes && (lines.length > 0 || maxPageBytes < MAX_SESSION_PAGE_BYTES)) { pageEndLine = lineNumber - 1; stoppedForPageBytes = true; return false; }
        if (bytes > MAX_SESSION_PAGE_BYTES) skippedOversizedEntries += 1;
        else {
          lines.push({ lineNumber, text: decodeUtf8(Buffer.concat(parts, partBytes)), bytes });
          totalBytes += bytes;
          if (keepTail) while (totalBytes > maxPageBytes && lines.length > 1) { totalBytes -= lines.shift()!.bytes; droppedLeadingEntries += 1; }
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
  const pageStartLine = keepTail && droppedLeadingEntries > 0 ? publicLines[0]?.lineNumber ?? desiredStart : desiredStart;
  return { lines: publicLines, pageStartLine, pageEndLine: Math.max(desiredStart - 1, pageEndLine), skippedOversizedEntries, incompleteTrailingEntry, droppedLeadingEntries, decodedBytes: totalBytes };
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

function orderedSessionEntries(entries: WorkerSessionEntry[]): WorkerSessionEntry[] {
  const byId = new Map<string, WorkerSessionEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error("Worker run session page contains duplicate entry ids.");
    byId.set(entry.id, entry);
  }
  for (const entry of entries) {
    const seen = new Set<string>();
    let current: WorkerSessionEntry | undefined = entry;
    while (current) {
      if (seen.has(current.id)) throw new Error("Worker run session branch contains a cycle.");
      seen.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  return entries;
}

function renderableBlocks(entry: WorkerSessionEntry): WorkerSessionViewBlock[] {
  if (entry.type === "message") return messageBlocks(entry);
  if (entry.type === "compaction") return [{ kind: "compaction", label: `Compaction · ${numberField(entry.tokensBefore)} tokens`, timestamp: entry.timestamp, text: boundBlockText(textField(entry.summary, "(empty compaction summary)")) }];
  if (entry.type === "branch_summary") return [{ kind: "compaction", label: "Branch summary", timestamp: entry.timestamp, text: boundBlockText(textField(entry.summary, "(empty branch summary)")) }];
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
      if (value?.type === "thinking") blocks.push({ kind: "thinking", label: "Thinking", timestamp: entry.timestamp, text: boundBlockText(textField(value.thinking, textField(value.text, ""))) });
      else if (value?.type === "toolCall") blocks.push({ kind: "tool", label: `Tool call · ${textField(value.name, "unknown")}`, timestamp: entry.timestamp, text: boundedJson(value.arguments ?? value.input ?? {}) });
      else blocks.push({ kind: "assistant", label: model ? `Assistant · ${model}` : "Assistant", timestamp: entry.timestamp, text: partText(part) });
    }
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    if (stopReason === "error" || stopReason === "aborted") blocks.push({ kind: "error", label: stopReason === "error" ? "Provider error" : "Provider aborted", timestamp: entry.timestamp, text: boundBlockText(textField(message.errorMessage, stopReason === "error" ? "The provider ended this response with an error." : "The provider response was aborted.")) });
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
    return [{ kind: "custom", label: "Bash execution", timestamp: entry.timestamp, text: boundBlockText(`${command}\n${output}`) }];
  }
  return [{ kind: "custom", label: role, timestamp: entry.timestamp, text: contentText(message.content) || "(No displayable content.)" }];
}

function wrappedBody(theme: Theme, state: WorkerSessionViewerState, width: number): WrappedBodyCache {
  const cached = state.wrappedBodyCache;
  if (cached && cached.snapshot === state.snapshot && cached.theme === theme && cached.width === width) return cached;
  const lines: string[] = [];
  const blockStarts: number[] = [];
  let truncatedBlocks = 0;
  let remainingCharacters = MAX_PAGE_WRAP_CHARACTERS;
  for (const [blockIndex, block] of state.snapshot.blocks.entries()) {
    blockStarts.push(lines.length);
    const remainingBlocks = state.snapshot.blocks.length - blockIndex;
    const fairCharacterBudget = remainingBlocks > 0 ? Math.floor(remainingCharacters / remainingBlocks) : 0;
    const rendered = renderBlock(theme, block, width, fairCharacterBudget);
    remainingCharacters = Math.max(0, remainingCharacters - rendered.consumedCharacters);
    lines.push(...rendered.lines);
    if (rendered.truncated) truncatedBlocks += 1;
  }
  if (lines.length === 0) lines.push(theme.fg("dim", "(No renderable messages on this run page.)"));
  const value: WrappedBodyCache = { snapshot: state.snapshot, theme, width, lines, blockStarts, truncatedBlocks };
  state.wrappedBodyCache = value;
  return value;
}

function renderBlock(theme: Theme, block: WorkerSessionViewBlock, width: number, remainingCharacters: number): { lines: string[]; truncated: boolean; consumedCharacters: number } {
  const labelColor: ThemeColor = block.kind === "user" ? "accent" : block.kind === "tool" ? "toolTitle" : block.kind === "toolResult" ? "success" : block.kind === "error" ? "error" : block.kind === "thinking" ? "muted" : block.kind === "compaction" ? "warning" : block.kind === "status" ? "dim" : "text";
  const label = `${theme.fg(labelColor, theme.bold(sanitizeViewText(block.label).slice(0, 256)))} ${theme.fg("dim", sanitizeViewText(block.timestamp).slice(0, 128))}`;
  const textWidth = Math.max(1, width - 2);
  const lineLimit = block.kind === "tool" || block.kind === "toolResult" || block.kind === "error" || block.kind === "custom"
    ? MAX_TOOL_BLOCK_RENDER_LINES : block.kind === "thinking" ? MAX_THINKING_BLOCK_RENDER_LINES : MAX_DEFAULT_BLOCK_RENDER_LINES;
  const blockCharacterLimit = Math.min(MAX_BLOCK_TEXT, Math.max(512, textWidth * lineLimit));
  const characterLimit = Math.max(0, Math.min(blockCharacterLimit, remainingCharacters));
  const text = block.text.slice(0, characterLimit);
  const content: string[] = [];
  let displayTruncated = block.text.length > characterLimit;
  const rawLines = text.split("\n");
  for (const [rawLineIndex, rawLine] of rawLines.entries()) {
    const remainingLines = lineLimit - content.length;
    if (remainingLines <= 0) { displayTruncated = true; break; }
    const rawCharacterLimit = Math.max(textWidth, remainingLines * textWidth);
    const boundedRawLine = rawLine.slice(0, rawCharacterLimit);
    if (boundedRawLine.length < rawLine.length) displayTruncated = true;
    for (const wrapped of wrapTextWithAnsi(sanitizeViewText(boundedRawLine), textWidth)) {
      if (content.length >= lineLimit) { displayTruncated = true; break; }
      content.push(`  ${wrapped}`);
    }
    if (content.length >= lineLimit && rawLineIndex < rawLines.length - 1) { displayTruncated = true; break; }
  }
  if (displayTruncated) content.push(theme.fg("dim", "  [… block display truncated …]"));
  return { lines: ["", label, ...(content.length ? content : [theme.fg("dim", "  (empty)")])], truncated: displayTruncated, consumedCharacters: text.length };
}

function contentParts(content: unknown): unknown[] { return Array.isArray(content) ? content : [content]; }
function contentText(content: unknown): string {
  let text = "";
  for (const part of contentParts(content)) {
    const value = partText(part);
    if (!value) continue;
    const separator = text ? "\n" : "";
    const remaining = MAX_BLOCK_TEXT - text.length - separator.length;
    if (remaining <= 0) return `${text}\n[… block text truncated …]`;
    text += separator + value.slice(0, remaining);
    if (value.length > remaining) return `${text}\n[… block text truncated …]`;
  }
  return text;
}
function partText(part: unknown): string {
  if (typeof part === "string") return boundBlockText(part);
  const value = record(part);
  if (!value) return "";
  if (typeof value.text === "string") return boundBlockText(value.text);
  if (value.type === "image") return `[image${typeof value.mimeType === "string" ? ` · ${value.mimeType}` : ""}]`;
  if (value.type === "toolCall") return `[tool call · ${textField(value.name, "unknown")}] ${boundedJson(value.arguments ?? value.input ?? {})}`;
  return `[${typeof value.type === "string" ? sanitizeViewText(value.type) : "unsupported content"}]`;
}
function boundBlockText(value: string, limit = MAX_BLOCK_TEXT): string { return value.length <= limit ? value : `${value.slice(0, limit)}\n[… block text truncated …]`; }
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
