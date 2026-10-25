import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";

const MAX_SESSION_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_ENTRY_DISPLAY_BYTES = 7 * 1024 * 1024;
const MAX_SESSION_PAGE_LINES = 512;
const MAX_SESSION_PAGE_BLOCKS = 2_048;
const OVERSIZED_ENTRY_PREFIX_BYTES = 16 * 1024;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const SESSION_READ_CHUNK = 1024 * 1024;
const SESSION_PAGE_READ_CHUNK = 256 * 1024;
const SESSION_FALLBACK_RECOVERY_BYTES = 512 * 1024;
const SESSION_PAGE_METADATA_RESERVE = SESSION_READ_CHUNK;
const MAX_SESSION_PAGE_CONTENT_BYTES = MAX_SESSION_PAGE_BYTES - SESSION_PAGE_METADATA_RESERVE;
const INITIAL_LINE_INDEX_STRIDE = 1;
const MAX_LINE_INDEX_CHECKPOINTS = 65_536;
const MAX_LINE_INDEX_FILES = 16;
const SESSION_INDEX_PIN_BYTES = 256 * 1024;
const MAX_BLOCK_TEXT = 16 * 1024;
const MAX_DEFAULT_BLOCK_RENDER_LINES = 60;
const MAX_THINKING_BLOCK_RENDER_LINES = 40;
const MAX_TOOL_BLOCK_RENDER_LINES = 24;
const SESSION_INDEX_FINGERPRINT_BYTES = 4096;
const MAX_VISIBILITY_CACHE_ENTRIES = 32;
const MAX_VISIBILITY_ENTRY_IDS = 8_192;
const VISIBILITY_RANK_BLOCK_LINES = 256;
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

type SessionLineCheckpoint = { lineNumber: number; offset: number; pinned?: boolean; oversizedStartOffset?: number };
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

type VisibilityRankIndex = {
  baseLine: number;
  throughLine: number;
  displayBits: Uint32Array;
  oversizedBits: Uint32Array;
  displayBlockRanks: Uint32Array;
  oversizedBlockRanks: Uint32Array;
};
type RunVisibilityBase = { openingLine?: number; openingRenderable: boolean; keptLine: number; renderedBeforeKept: number; hiddenEntries: number; compactionCount: number; incompleteTrailingEntry: boolean; renderedEntries: number; oversizedEntries: number; incompleteLine?: number };
type RunVisibility = RunVisibilityBase & { rankIndex: VisibilityRankIndex };
type RunVisibilityState = RunVisibilityBase & {
  generation: number;
  snapshotSize: number;
  analyzedEndLine: number;
  validEntries: number;
  entryIds: Map<string, { line: number; ordinal: number; renderedBefore: number }>;
  incompleteSnapshotSize?: number;
  pendingCompaction?: { line: number; ordinal: number; renderedBefore: number; firstKeptEntryId?: string };
  rankIndex: VisibilityRankIndex;
};

function createVisibilityRankIndex(baseLine: number, endLine: number): VisibilityRankIndex {
  const lines = Math.max(0, endLine - baseLine + 1);
  const words = Math.ceil(lines / 32);
  const blocks = Math.ceil(lines / VISIBILITY_RANK_BLOCK_LINES);
  return { baseLine, throughLine: baseLine - 1, displayBits: new Uint32Array(words), oversizedBits: new Uint32Array(words), displayBlockRanks: new Uint32Array(blocks + 1), oversizedBlockRanks: new Uint32Array(blocks + 1) };
}

function cloneVisibilityRankIndex(index: VisibilityRankIndex): VisibilityRankIndex {
  return { ...index, displayBits: index.displayBits.slice(), oversizedBits: index.oversizedBits.slice(), displayBlockRanks: index.displayBlockRanks.slice(), oversizedBlockRanks: index.oversizedBlockRanks.slice() };
}

function ensureVisibilityRankCapacity(index: VisibilityRankIndex, endLine: number): void {
  const lines = Math.max(0, endLine - index.baseLine + 1);
  const words = Math.ceil(lines / 32);
  if (words > index.displayBits.length) {
    const display = new Uint32Array(words); display.set(index.displayBits); index.displayBits = display;
    const oversized = new Uint32Array(words); oversized.set(index.oversizedBits); index.oversizedBits = oversized;
  }
  const blocks = Math.ceil(lines / VISIBILITY_RANK_BLOCK_LINES) + 1;
  if (blocks > index.displayBlockRanks.length) {
    const display = new Uint32Array(blocks); display.set(index.displayBlockRanks); index.displayBlockRanks = display;
    const oversized = new Uint32Array(blocks); oversized.set(index.oversizedBlockRanks); index.oversizedBlockRanks = oversized;
  }
}

function setVisibilityBit(index: VisibilityRankIndex, kind: "display" | "oversized", line: number): void {
  const offset = line - index.baseLine;
  if (offset < 0 || offset >>> 5 >= index.displayBits.length) return;
  const bits = kind === "display" ? index.displayBits : index.oversizedBits;
  bits[offset >>> 5] |= 1 << (offset & 31);
}

function popcount32(value: number): number {
  value -= value >>> 1 & 0x55555555;
  value = (value & 0x33333333) + (value >>> 2 & 0x33333333);
  return ((value + (value >>> 4) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function visibilityBitsInRange(bits: Uint32Array, startOffset: number, endOffset: number): number {
  let count = 0;
  for (let offset = startOffset; offset < endOffset;) {
    const word = offset >>> 5;
    const bit = offset & 31;
    const take = Math.min(32 - bit, endOffset - offset);
    const mask = take === 32 ? 0xffffffff : ((2 ** take - 1) << bit) >>> 0;
    count += popcount32((bits[word] ?? 0) & mask);
    offset += take;
  }
  return count;
}

function completeVisibilityRankIndex(index: VisibilityRankIndex, throughLine: number): void {
  if (throughLine < index.baseLine) { index.throughLine = Math.max(index.throughLine, throughLine); return; }
  ensureVisibilityRankCapacity(index, throughLine);
  const firstBlock = Math.max(0, Math.floor((index.throughLine + 1 - index.baseLine) / VISIBILITY_RANK_BLOCK_LINES));
  const lastBlock = Math.floor((throughLine - index.baseLine) / VISIBILITY_RANK_BLOCK_LINES);
  for (let block = firstBlock; block <= lastBlock; block += 1) {
    const start = block * VISIBILITY_RANK_BLOCK_LINES;
    const end = Math.min(start + VISIBILITY_RANK_BLOCK_LINES, throughLine - index.baseLine + 1);
    index.displayBlockRanks[block + 1] = index.displayBlockRanks[block]! + visibilityBitsInRange(index.displayBits, start, end);
    index.oversizedBlockRanks[block + 1] = index.oversizedBlockRanks[block]! + visibilityBitsInRange(index.oversizedBits, start, end);
  }
  index.throughLine = Math.max(index.throughLine, throughLine);
}

function visibilityRankLessThan(index: VisibilityRankIndex, kind: "display" | "oversized", line: number): number {
  const limit = Math.max(0, Math.min(index.throughLine - index.baseLine + 1, line - index.baseLine));
  if (limit <= 0) return 0;
  const block = Math.floor(limit / VISIBILITY_RANK_BLOCK_LINES);
  const blockStart = block * VISIBILITY_RANK_BLOCK_LINES;
  const ranks = kind === "display" ? index.displayBlockRanks : index.oversizedBlockRanks;
  const bits = kind === "display" ? index.displayBits : index.oversizedBits;
  return ranks[block]! + visibilityBitsInRange(bits, blockStart, limit);
}

function visibilitySelect(index: VisibilityRankIndex, kind: "display" | "oversized", ordinal: number): number | undefined {
  const total = visibilityRankLessThan(index, kind, index.throughLine + 1);
  if (ordinal < 0 || ordinal >= total) return undefined;
  let low = index.baseLine; let high = index.throughLine;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (visibilityRankLessThan(index, kind, middle + 1) > ordinal) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** @internal Deterministic scale probe for the visibility rank representation. */
export function simulateWorkerSessionVisibilityRankIndex(lineCount: number): { bytes: number; displays: number; oversized: number; lastDisplay?: number } {
  const count = Math.max(0, Math.floor(lineCount));
  const index = createVisibilityRankIndex(1, count);
  for (let line = 1; line <= count; line += 17) setVisibilityBit(index, "display", line);
  for (let line = 1; line <= count; line += 1_009) setVisibilityBit(index, "oversized", line);
  completeVisibilityRankIndex(index, count);
  const displays = visibilityRankLessThan(index, "display", count + 1);
  const oversized = visibilityRankLessThan(index, "oversized", count + 1);
  const bytes = index.displayBits.byteLength + index.oversizedBits.byteLength + index.displayBlockRanks.byteLength + index.oversizedBlockRanks.byteLength;
  return { bytes, displays, oversized, ...(displays > 0 ? { lastDisplay: visibilitySelect(index, "display", displays - 1) } : {}) };
}

type ReadSessionPage = {
  headerLine: string;
  lines: Array<{ lineNumber: number; text: string }>;
  oversizedEntryPrefixes: Array<{ lineNumber: number; text: string }>;
  runStartLine: number;
  runEndLine: number;
  pageStartLine: number;
  pageEndLine: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  skippedOversizedEntries: number;
  leadingOversizedEntries: number;
  trailingOversizedEntries: number;
  incompleteTrailingEntry: boolean;
  hiddenCompactedEntries: number;
  compactionCount: number;
  previousVisibleEntries: number;
  nextVisibleEntries: number;
  totalVisibleEntries: number;
  droppedLeadingEntries: number;
  decodedBytes: number;
};

type ReadPageLines = Omit<ReadSessionPage, "headerLine" | "runStartLine" | "runEndLine" | "hasPreviousPage" | "hasNextPage" | "hiddenCompactedEntries" | "compactionCount" | "previousVisibleEntries" | "nextVisibleEntries" | "totalVisibleEntries" | "leadingOversizedEntries" | "trailingOversizedEntries">;

const sessionLineIndexes = new Map<string, SessionLineIndex>();
const runVisibilityStates = new Map<string, RunVisibilityState>();
type RunVisibilityFlight = { promise: Promise<{ incompleteTrailingEntry: boolean; snapshotSize: number }> };
const runVisibilityFlights = new Map<string, RunVisibilityFlight>();
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
  | { mode: "before"; line: number; block?: number }
  | { mode: "after"; line: number; block?: number };

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
  /** Zero-based rendered-block cursor within pageStartLine. */
  pageStartBlock?: number;
  /** Exclusive rendered-block cursor within pageEndLine. */
  pageEndBlock?: number;
  hasPreviousBlocksInEntry?: boolean;
  hasNextBlocksInEntry?: boolean;
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
  return snapshotFromPage(target, readTrustedSessionPage(target, request, dependencies), request);
}

export async function loadWorkerSessionViewSnapshotAsync(target: WorkerSessionViewTarget, request: WorkerSessionPageRequest = { mode: "tail" }, dependencies: WorkerSessionReadDependencies = {}): Promise<WorkerSessionViewSnapshot> {
  validateRunRange(target);
  return snapshotFromPage(target, await readTrustedSessionPageAsync(target, request, dependencies), request);
}

function snapshotFromPage(target: WorkerSessionViewTarget, selected: ReadSessionPage, request: WorkerSessionPageRequest): WorkerSessionViewSnapshot {
  const header = parseSessionHeader(selected.headerLine);
  validateSessionHeader(header, target);
  const { entries, malformedEntries, truncated: entryParsingTruncated } = parseSessionEntriesForBlockPage(selected.lines, request);
  const ordered = orderedSessionEntries(entries);
  const descriptors = ordered.map((entry) => ({ entry, line: entry.lineNumber, count: renderableBlockCount(entry) }));
  const totalBlocks = descriptors.reduce((total, descriptor) => total + descriptor.count, 0);
  let availableStart = 0;
  let availableEnd = totalBlocks;
  if (request.mode === "after" && request.block !== undefined) availableStart = blockCursor(descriptors, request.line, request.block);
  if (request.mode === "before" && request.block !== undefined) availableEnd = blockCursor(descriptors, request.line, request.block);
  availableStart = Math.max(0, Math.min(totalBlocks, availableStart));
  availableEnd = Math.max(availableStart, Math.min(totalBlocks, availableEnd));
  const sliceFromTail = request.mode === "tail" || request.mode === "before";
  const blockStart = sliceFromTail ? Math.max(availableStart, availableEnd - MAX_SESSION_PAGE_BLOCKS) : availableStart;
  const blockEnd = sliceFromTail ? availableEnd : Math.min(availableEnd, availableStart + MAX_SESSION_PAGE_BLOCKS);
  const blocks: WorkerSessionViewBlock[] = [];
  let pageStartLine = selected.pageStartLine;
  let pageEndLine = selected.pageEndLine;
  let pageStartBlock = 0;
  let pageEndBlock = 0;
  let representedEntries = 0;
  let cursor = 0;
  for (const descriptor of descriptors) {
    const descriptorStart = cursor;
    const descriptorEnd = cursor + descriptor.count;
    cursor = descriptorEnd;
    const localStart = Math.max(0, blockStart - descriptorStart);
    const localEnd = Math.min(descriptor.count, blockEnd - descriptorStart);
    if (localEnd <= localStart) continue;
    if (representedEntries === 0) { pageStartLine = descriptor.line; pageStartBlock = localStart; }
    representedEntries += 1;
    pageEndLine = descriptor.line;
    pageEndBlock = localEnd;
    blocks.push(...renderableBlockSlice(descriptor.entry, localStart, localEnd));
  }
  if (!entryParsingTruncated && !sliceFromTail && blockEnd === totalBlocks && representedEntries > 0 && selected.pageEndLine > pageEndLine) { pageEndLine = selected.pageEndLine; pageEndBlock = 0; }
  if (!entryParsingTruncated && sliceFromTail && blockStart === 0 && representedEntries > 0 && selected.pageStartLine < pageStartLine) { pageStartLine = selected.pageStartLine; pageStartBlock = 0; }
  const activeEntries = representedEntries;
  const skippedDisplayedBefore = descriptors.filter((descriptor) => descriptor.count > 0 && descriptor.line < pageStartLine).length;
  const skippedDisplayedAfter = descriptors.filter((descriptor) => descriptor.count > 0 && descriptor.line > pageEndLine).length;
  const keepTail = request.mode === "tail" || request.mode === "before";
  const previousVisibleEntries = keepTail ? Math.max(0, selected.totalVisibleEntries - selected.nextVisibleEntries - skippedDisplayedAfter - activeEntries) : selected.previousVisibleEntries + skippedDisplayedBefore;
  const nextVisibleEntries = keepTail ? selected.nextVisibleEntries + skippedDisplayedAfter : Math.max(0, selected.totalVisibleEntries - previousVisibleEntries - activeEntries);
  const startDescriptor = descriptors.find((descriptor) => descriptor.line === pageStartLine);
  const endDescriptor = descriptors.find((descriptor) => descriptor.line === pageEndLine);
  const hasPreviousBlocksInEntry = Boolean(startDescriptor && pageStartBlock > 0);
  const hasNextBlocksInEntry = Boolean(endDescriptor && pageEndBlock < endDescriptor.count);
  const hasPreviousPage = selected.hasPreviousPage || previousVisibleEntries > 0 || blockStart > 0;
  const hasNextPage = selected.hasNextPage || nextVisibleEntries > 0 || blockEnd < totalBlocks;
  const positionedOversizedLines = new Set(selected.oversizedEntryPrefixes
    .map((item) => item.lineNumber)
    .filter((line) => sliceFromTail ? line >= pageStartLine : line <= pageEndLine));
  const unpositionedOversizedEntries = Math.max(0, selected.skippedOversizedEntries - new Set(selected.oversizedEntryPrefixes.map((item) => item.lineNumber)).size);
  const containsFirstDisplayedBlock = !entryParsingTruncated && selected.previousVisibleEntries === 0 && blockStart === 0;
  const containsLastDisplayedBlock = !entryParsingTruncated && selected.nextVisibleEntries === 0 && blockEnd === totalBlocks;
  const skippedOversizedEntries = unpositionedOversizedEntries + positionedOversizedLines.size
    + (sliceFromTail && containsFirstDisplayedBlock ? selected.leadingOversizedEntries : 0)
    + (!sliceFromTail && containsLastDisplayedBlock ? selected.trailingOversizedEntries : 0);
  return {
    target,
    blocks,
    totalActiveEntries: activeEntries,
    malformedEntries,
    skippedOversizedEntries,
    incompleteTrailingEntry: selected.incompleteTrailingEntry,
    hiddenCompactedEntries: selected.hiddenCompactedEntries,
    compactionCount: selected.compactionCount,
    previousVisibleEntries,
    nextVisibleEntries,
    totalVisibleEntries: selected.totalVisibleEntries,
    runStartLine: selected.runStartLine,
    runEndLine: selected.runEndLine,
    pageStartLine,
    pageEndLine,
    pageStartBlock,
    pageEndBlock,
    hasPreviousBlocksInEntry,
    hasNextBlocksInEntry,
    hasPreviousPage,
    hasNextPage,
    refreshedAt: new Date().toISOString()
  };
}

function blockCursor(descriptors: Array<{ line: number; count: number }>, line: number, block: number): number {
  const safeBlock = Number.isSafeInteger(block) && block >= 0 ? block : 0;
  let cursor = 0;
  for (const descriptor of descriptors) {
    if (descriptor.line === line) return cursor + Math.min(descriptor.count, safeBlock);
    if (descriptor.line > line) return cursor;
    cursor += descriptor.count;
  }
  return cursor;
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
        if (state.topLine === 0 && state.snapshot.hasPreviousPage) load({ mode: "before", line: state.snapshot.pageStartLine, ...(state.snapshot.hasPreviousBlocksInEntry ? { block: state.snapshot.pageStartBlock } : {}) }, "end");
        else move(-pageSize);
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        if (state.topLine >= maxTopLine && state.snapshot.hasNextPage) load({ mode: "after", line: state.snapshot.pageEndLine, ...(state.snapshot.hasNextBlocksInEntry ? { block: state.snapshot.pageEndBlock } : {}) }, "start");
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
      if (data === "[") { if (state.snapshot.hasPreviousPage) load({ mode: "before", line: state.snapshot.pageStartLine, ...(state.snapshot.hasPreviousBlocksInEntry ? { block: state.snapshot.pageStartBlock } : {}) }, "end"); return; }
      if (data === "]") { if (state.snapshot.hasNextPage) load({ mode: "after", line: state.snapshot.pageEndLine, ...(state.snapshot.hasNextBlocksInEntry ? { block: state.snapshot.pageEndBlock } : {}) }, "start"); return; }
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
    state.snapshot.hasPreviousPage && state.snapshot.previousVisibleEntries > 0 ? `${state.snapshot.previousVisibleEntries} earlier visible run entr${state.snapshot.previousVisibleEntries === 1 ? "y is" : "ies are"} available with [ or PgUp at the top (g opens the first page).` : undefined,
    state.snapshot.hasPreviousBlocksInEntry ? "Earlier rendered blocks from this run entry are available with [ or PgUp at the top (g opens the first page)." : undefined,
    state.snapshot.hasNextPage && state.snapshot.nextVisibleEntries > 0 ? `${state.snapshot.nextVisibleEntries} later visible run entr${state.snapshot.nextVisibleEntries === 1 ? "y is" : "ies are"} available with ] or PgDn at the bottom (G opens the latest page).` : undefined,
    state.snapshot.hasNextBlocksInEntry ? "Later rendered blocks from this run entry are available with ] or PgDn at the bottom (G opens the latest page)." : undefined,
    body.truncatedBlocks > 0 ? `${body.truncatedBlocks} long block${body.truncatedBlocks === 1 ? " was" : "s were"} explicitly truncated within this page.` : undefined,
    state.snapshot.skippedOversizedEntries > 0 ? `${state.snapshot.skippedOversizedEntries} session entr${state.snapshot.skippedOversizedEntries === 1 ? "y reaches or exceeds" : "ies reach or exceed"} the ${MAX_SESSION_ENTRY_DISPLAY_BYTES}-byte per-entry display bound and ${state.snapshot.skippedOversizedEntries === 1 ? "was" : "were"} skipped.` : undefined,
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
    const identity = fstatSync(fd);
    if (!identity.isFile() || identity.dev !== leaf.dev || identity.ino !== leaf.ino) throw new Error("Worker session changed while counting lines; retry.");
    sessionRangeReaders.set(fd, new SessionRangeReader(fd, identity.size));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return countSessionLinesFromOpenFile(fd, exact, identity); }
      catch (error) {
        if (!(error instanceof SessionChangedDuringReadError)) throw error;
        let current;
        try { current = lstatSync(exact); } catch { throw new Error("Worker session changed while counting lines; retry."); }
        if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("Worker session changed while counting lines; retry.");
      }
    }
    throw new Error("Worker session changed while counting lines; retry.");
  } finally { closeSessionRangeReader(fd); closeSync(fd); }
}

function countSessionLinesFromOpenFile(fd: number, exact: string, identity: Stats): number {
  let opened = fstatSync(fd);
  if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino) throw new SessionChangedDuringReadError();
  let index = ensureSessionLineIndex(fd, exact, opened, opened.size);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const after = fstatSync(fd);
    if (after.dev !== identity.dev || after.ino !== identity.ino || after.size < opened.size) throw new SessionChangedDuringReadError();
    if (after.size === opened.size) break;
    opened = after;
    sessionRangeReaders.get(fd)?.setSnapshotSize(opened.size);
    index = ensureSessionLineIndex(fd, exact, opened, opened.size);
  }
  let current;
  try { current = lstatSync(exact); } catch { throw new SessionChangedDuringReadError(); }
  if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) throw new SessionChangedDuringReadError();
  return sessionLineCount(index);
}

function validateRunRange(target: WorkerSessionViewTarget): void {
  if (target.sessionStartLine === undefined) {
    if (target.runStatus === "queued") return;
    throw new Error("Worker run has no retained session range.");
  }
  if (!Number.isSafeInteger(target.sessionStartLine) || target.sessionStartLine < 1) throw new Error("Worker run session range is invalid.");
  if (target.sessionEndLine !== undefined && (!Number.isSafeInteger(target.sessionEndLine) || target.sessionEndLine < target.sessionStartLine - 1)) throw new Error("Worker run session range is invalid.");
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

async function readTrustedSessionPageAsync(target: WorkerSessionViewTarget, request: WorkerSessionPageRequest, dependencies: WorkerSessionReadDependencies): Promise<ReadSessionPage> {
  const file = trustedSessionPath(target);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await readStableSessionPageAsync(file, target, request, dependencies); }
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

type CachedSessionRange = { start: number; data: Buffer };
class SessionRangeReader {
  private snapshotSize: number;
  private readonly ranges: CachedSessionRange[] = [];
  private cachedBytes = 0;
  private pageBudgetActive = false;
  private pageReadBytes = 0;
  private pageBudgetExhausted = false;
  actualReadBytes = 0;

  constructor(private readonly fd: number, snapshotSize: number) { this.snapshotSize = snapshotSize; }

  setSnapshotSize(snapshotSize: number): void { this.snapshotSize = snapshotSize; }
  beginPageReads(): void { this.pageBudgetActive = true; this.pageReadBytes = Math.min(this.actualReadBytes, SESSION_PAGE_METADATA_RESERVE); this.pageBudgetExhausted = false; }
  exhaustedPageBudget(): boolean { return this.pageBudgetExhausted; }

  readInto(buffer: Buffer, bufferOffset: number, length: number, position: number): number {
    const requestedEnd = Math.min(this.snapshotSize, position + Math.max(0, length));
    let current = Math.max(0, position); let written = 0;
    while (current < requestedEnd) {
      const cached = this.ranges.find((range) => range.start <= current && current < range.start + range.data.length);
      if (cached) {
        const sourceOffset = current - cached.start;
        const count = Math.min(requestedEnd - current, cached.data.length - sourceOffset);
        cached.data.copy(buffer, bufferOffset + written, sourceOffset, sourceOffset + count);
        current += count; written += count; continue;
      }
      const next = this.ranges.filter((range) => range.start > current).reduce<number | undefined>((best, range) => best === undefined || range.start < best ? range.start : best, undefined);
      const gapLength = Math.min(requestedEnd - current, next === undefined ? requestedEnd - current : next - current);
      if (this.pageBudgetActive && this.pageReadBytes + gapLength > MAX_SESSION_PAGE_BYTES) { this.pageBudgetExhausted = true; break; }
      const data = Buffer.allocUnsafe(gapLength);
      const count = readSync(this.fd, data, 0, gapLength, current);
      if (count === 0) break;
      const value = Buffer.from(data.subarray(0, count));
      value.copy(buffer, bufferOffset + written);
      this.actualReadBytes += count;
      if (this.pageBudgetActive) this.pageReadBytes += count;
      this.ranges.push({ start: current, data: value }); this.cachedBytes += count;
      while (this.cachedBytes > MAX_SESSION_PAGE_BYTES && this.ranges.length > 1) this.cachedBytes -= this.ranges.shift()!.data.length;
      current += count; written += count;
      if (count < gapLength) break;
    }
    return written;
  }
}

const sessionRangeReaders = new Map<number, SessionRangeReader>();
function readSessionRange(fd: number, buffer: Buffer, bufferOffset: number, length: number, position: number): number {
  const reader = sessionRangeReaders.get(fd);
  return reader ? reader.readInto(buffer, bufferOffset, length, position) : readSync(fd, buffer, bufferOffset, length, position);
}
function closeSessionRangeReader(fd: number): void { sessionRangeReaders.delete(fd); }
function sessionPageBudgetExhausted(fd: number): boolean { return sessionRangeReaders.get(fd)?.exhaustedPageBudget() === true; }

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
  sessionRangeReaders.set(fd, new SessionRangeReader(fd, opened.size));
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
    sessionRangeReaders.get(fd)?.beginPageReads();
    const selected = selectVisiblePage(fd, opened.size, index, headerLine, request, runStartLine, runEndLine, visibility);
    dependencies.afterReadAttempt?.(file, attempt);
    validateSessionSnapshot(fd, file, opened);
    return selected;
  } finally { closeSessionRangeReader(fd); closeSync(fd); }
}

async function readStableSessionPageAsync(file: string, target: WorkerSessionViewTarget, request: WorkerSessionPageRequest, dependencies: WorkerSessionReadDependencies): Promise<ReadSessionPage> {
  const { fd, opened } = openSessionSnapshot(file);
  try {
    const headerLine = readHeaderLine(fd, opened.size);
    if (target.sessionStartLine === undefined) return emptyQueuedPage(headerLine);
    const index = cloneSessionLineIndex(reusableSessionLineIndex(fd, file, opened, opened.size));
    retainSessionLineIndexByCas(file, index);
    while (index.size < opened.size && (target.sessionEndLine === undefined || index.newlineCount < target.sessionEndLine)) {
      extendSessionLineIndex(fd, file, index, opened.size, dependencies, 1);
      retainSessionLineIndexByCas(file, index);
      await yieldToEventLoop();
    }
    retainSessionLineIndexByCas(file, index);
    const indexedLines = sessionLineCount(index);
    if (target.sessionEndLine !== undefined && indexedLines < target.sessionEndLine) throw new Error("Worker session does not contain the retained run end line.");
    const runStartLine = Math.max(2, target.sessionStartLine);
    const runEndLine = Math.max(runStartLine - 1, target.sessionEndLine ?? indexedLines);
    const visibility = await analyzeRunVisibilityCooperatively(fd, file, opened.size, index, runStartLine, runEndLine, target.sessionEndLine);
    await yieldToEventLoop();
    sessionRangeReaders.get(fd)?.beginPageReads();
    const selected = selectVisiblePage(fd, opened.size, index, headerLine, request, runStartLine, runEndLine, visibility);
    dependencies.afterReadAttempt?.(file, 0);
    validateSessionSnapshot(fd, file, opened);
    return selected;
  } finally { closeSessionRangeReader(fd); closeSync(fd); }
}

function emptyQueuedPage(headerLine: string): ReadSessionPage {
  return { headerLine, lines: [], oversizedEntryPrefixes: [], runStartLine: 1, runEndLine: 0, pageStartLine: 1, pageEndLine: 0, hasPreviousPage: false, hasNextPage: false, skippedOversizedEntries: 0, leadingOversizedEntries: 0, trailingOversizedEntries: 0, incompleteTrailingEntry: false, hiddenCompactedEntries: 0, compactionCount: 0, previousVisibleEntries: 0, nextVisibleEntries: 0, totalVisibleEntries: 0, droppedLeadingEntries: 0, decodedBytes: 0 };
}

function selectVisiblePage(fd: number, snapshotSize: number, index: SessionLineIndex, headerLine: string, request: WorkerSessionPageRequest, runStartLine: number, runEndLine: number, visibility: RunVisibility): ReadSessionPage {
  const includeCursorLine = cursorBoundaryNeedsEntry(fd, snapshotSize, index, request);
  const selectableEndLine = visibility.incompleteLine === runEndLine ? runEndLine - 1 : runEndLine;
  const bounds = visiblePageBounds(request, runStartLine, selectableEndLine, visibility, includeCursorLine);
  const keepTail = request.mode === "tail" || request.mode === "before";
  let page = readVisiblePage(fd, snapshotSize, index, bounds, keepTail);
  if (visibility.incompleteLine !== undefined) {
    page.lines = page.lines.filter((item) => item.lineNumber !== visibility.incompleteLine);
    page.oversizedEntryPrefixes = page.oversizedEntryPrefixes.filter((item) => item.lineNumber !== visibility.incompleteLine);
  }
  const renderableCounts = new Map<number, number>();
  const totalVisibleEntries = visibleRenderableCountLessThan(fd, snapshotSize, index, runEndLine + 1, runEndLine, visibility, renderableCounts);
  let previousVisibleEntries = visibleRenderableCountLessThan(fd, snapshotSize, index, page.pageStartLine, runEndLine, visibility, renderableCounts);
  let throughEnd = visibleRenderableCountLessThan(fd, snapshotSize, index, page.pageEndLine + 1, runEndLine, visibility, renderableCounts);
  const requestedWindowExists = bounds.endLine >= bounds.startLine || bounds.openingLine !== undefined;
  if (requestedWindowExists && throughEnd === previousVisibleEntries && totalVisibleEntries > 0) {
    const display = keepTail
      ? previousVisibleRenderableLine(fd, snapshotSize, index, page.pageStartLine - 1, selectableEndLine, visibility, renderableCounts, false)
      : nextVisibleRenderableLine(fd, snapshotSize, index, page.pageEndLine + 1, selectableEndLine, visibility, renderableCounts);
    if (display?.line !== undefined) {
      const recoverBackwardGap = keepTail && indexedLineRangeWithinBytes(index, display.line, page.pageStartLine - 1, snapshotSize, SESSION_FALLBACK_RECOVERY_BYTES);
      const backwardGapOversizedEntries = keepTail && !recoverBackwardGap ? oversizedLineCount(fd, snapshotSize, index, visibility, display.line + 1, page.pageStartLine - 1) : 0;
      const skippedOversizedEntries = page.skippedOversizedEntries + (keepTail ? backwardGapOversizedEntries : display.skippedOversizedEntries);
      const oversizedEntryPrefixes = page.oversizedEntryPrefixes;
      const nondisplayedLines = page.lines;
      const incompleteTrailingEntry = page.incompleteTrailingEntry;
      const droppedLeadingEntries = page.droppedLeadingEntries;
      const displayEndLine = recoverBackwardGap ? Math.max(display.line, page.pageStartLine - 1) : display.line;
      page = readVisiblePage(fd, snapshotSize, index, { startLine: display.line, endLine: displayEndLine }, false);
      page.skippedOversizedEntries += skippedOversizedEntries;
      page.lines = [...nondisplayedLines, ...page.lines].sort((left, right) => left.lineNumber - right.lineNumber);
      page.oversizedEntryPrefixes = [...oversizedEntryPrefixes, ...page.oversizedEntryPrefixes];
      page.incompleteTrailingEntry ||= incompleteTrailingEntry;
      page.droppedLeadingEntries += droppedLeadingEntries;
      previousVisibleEntries = visibleRenderableCountLessThan(fd, snapshotSize, index, page.pageStartLine, runEndLine, visibility, renderableCounts);
      throughEnd = visibleRenderableCountLessThan(fd, snapshotSize, index, page.pageEndLine + 1, runEndLine, visibility, renderableCounts);
    }
  }
  const nextVisibleEntries = Math.max(0, totalVisibleEntries - throughEnd);
  let trailingOversizedEntries = 0;
  if (!keepTail && nextVisibleEntries === 0 && page.pageEndLine < bounds.endLine) {
    const trailingStart = page.pageEndLine + 1;
    const indexedTrailing = oversizedLineCount(fd, snapshotSize, index, visibility, trailingStart, bounds.endLine);
    const loadedTrailingLines = new Set(page.oversizedEntryPrefixes.filter((item) => item.lineNumber >= trailingStart && item.lineNumber <= bounds.endLine).map((item) => item.lineNumber));
    trailingOversizedEntries = Math.max(0, indexedTrailing - loadedTrailingLines.size);
  }
  const firstDisplayedLine = firstRenderableLineInLoadedPage(page.lines);
  const requestedStartLine = visibleLineAt(0, visibility);
  const leadingEndLine = firstDisplayedLine === undefined && totalVisibleEntries === 0 ? bounds.endLine : (firstDisplayedLine ?? requestedStartLine) - 1;
  let leadingOversizedEntries = 0;
  if (keepTail && previousVisibleEntries === 0 && leadingEndLine >= requestedStartLine) {
    const indexedLeading = oversizedLineCount(fd, snapshotSize, index, visibility, requestedStartLine, leadingEndLine);
    const loadedLeadingLines = new Set(page.oversizedEntryPrefixes.filter((item) => item.lineNumber >= requestedStartLine && item.lineNumber <= leadingEndLine).map((item) => item.lineNumber));
    leadingOversizedEntries = Math.max(0, indexedLeading - loadedLeadingLines.size);
  }
  return { headerLine, ...page, leadingOversizedEntries, trailingOversizedEntries, runStartLine, runEndLine, incompleteTrailingEntry: page.incompleteTrailingEntry || visibility.incompleteTrailingEntry, hasPreviousPage: previousVisibleEntries > 0, hasNextPage: nextVisibleEntries > 0, hiddenCompactedEntries: visibility.hiddenEntries, compactionCount: visibility.compactionCount, previousVisibleEntries, nextVisibleEntries, totalVisibleEntries };
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

function cursorBoundaryNeedsEntry(fd: number, snapshotSize: number, index: SessionLineIndex, request: WorkerSessionPageRequest): boolean {
  if ((request.mode !== "after" && request.mode !== "before") || request.block === undefined) return false;
  if (request.mode === "before") return request.block > 0;
  const count = renderableBlockCountAtLine(fd, snapshotSize, index, request.line);
  return request.block < count;
}

function renderableBlockCountAtLine(fd: number, snapshotSize: number, index: SessionLineIndex, line: number): number {
  const prefixed = renderableBlockCountFromIndexedPrefix(fd, snapshotSize, index, line);
  if (prefixed !== undefined) return prefixed;
  const page = readPageLines(fd, snapshotSize, index, line, line, false);
  const item = page.lines[0];
  if (!item) return 0;
  try {
    const value: unknown = JSON.parse(item.text);
    return isSessionEntry(value) ? renderableBlockCount({ ...value, lineNumber: line }) : 0;
  } catch { return 0; }
}

function exactCheckpoint(index: SessionLineIndex, lineNumber: number): SessionLineCheckpoint | undefined {
  let low = 0; let high = index.checkpoints.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1; const checkpoint = index.checkpoints[middle]!;
    if (checkpoint.lineNumber === lineNumber) return checkpoint;
    if (checkpoint.lineNumber < lineNumber) low = middle + 1; else high = middle - 1;
  }
  return undefined;
}

type IndexedLineMetadata = { start: number; next?: number; completeLength?: number; prefix: string; suffix: string };
function indexedLineMetadata(fd: number, snapshotSize: number, index: SessionLineIndex, line: number, includeSuffix = true): IndexedLineMetadata | undefined {
  const start = exactCheckpoint(index, line)?.offset;
  if (start === undefined) return undefined;
  const nextCheckpoint = exactCheckpoint(index, line + 1);
  const next = nextCheckpoint?.offset;
  const completeLength = next === undefined ? undefined : Math.max(0, next - start - 1);
  const prefixLength = Math.min(OVERSIZED_ENTRY_PREFIX_BYTES, completeLength ?? Math.max(0, snapshotSize - start));
  if (prefixLength === 0) return { start, next, completeLength, prefix: "", suffix: "" };
  const prefixBuffer = Buffer.allocUnsafe(prefixLength);
  const prefixCount = readSessionRange(fd, prefixBuffer, 0, prefixLength, start);
  if (prefixCount !== prefixLength) return undefined;
  let suffix = "";
  if (includeSuffix && completeLength !== undefined && completeLength > prefixLength) {
    const suffixLength = Math.min(OVERSIZED_ENTRY_PREFIX_BYTES, completeLength - prefixLength);
    const suffixBuffer = Buffer.allocUnsafe(suffixLength);
    const suffixCount = readSessionRange(fd, suffixBuffer, 0, suffixLength, start + completeLength - suffixLength);
    if (suffixCount !== suffixLength) return undefined;
    suffix = new TextDecoder("utf-8").decode(suffixBuffer);
  }
  return { start, next, completeLength, prefix: new TextDecoder("utf-8").decode(prefixBuffer), suffix };
}

function renderableBlockCountFromIndexedPrefix(fd: number, snapshotSize: number, index: SessionLineIndex, line: number): number | undefined {
  const metadata = indexedLineMetadata(fd, snapshotSize, index, line);
  if (!metadata) return undefined;
  const { start, completeLength, prefix, suffix } = metadata;
  const nextCheckpoint = exactCheckpoint(index, line + 1);
  if (nextCheckpoint?.oversizedStartOffset === start) return 0;
  if (prefix.length === 0) return 0;
  if (completeLength !== undefined && completeLength <= Buffer.byteLength(prefix)) {
    try {
      const value: unknown = JSON.parse(prefix);
      return isSessionEntry(value) ? renderableBlockCount({ ...value, lineNumber: line }) : 0;
    } catch { return 0; }
  }
  const type = prefix.match(/^\s*\{\s*"type"\s*:\s*"([^"]+)"/u)?.[1];
  if (type === "message") {
    const role = prefix.match(/"message"\s*:\s*\{\s*"role"\s*:\s*"([^"]+)"/u)?.[1];
    if (role && role !== "assistant") return 1;
    return undefined;
  }
  if (type === "compaction" || type === "branch_summary" || type === "model_change" || type === "thinking_level_change") return 1;
  if (type === "custom_message") {
    const metadataText = `${prefix}
${suffix}`;
    if (/"display"\s*:\s*true/u.test(metadataText)) return 1;
    if (/"display"\s*:\s*false/u.test(metadataText)) return 0;
    return undefined;
  }
  if (type !== undefined) return 0;
  return undefined;
}

function visiblePageBounds(request: WorkerSessionPageRequest, runStartLine: number, runEndLine: number, visibility: RunVisibility, includeCursorLine = false): VisiblePageBounds {
  const count = visibleLineCount(runEndLine, visibility);
  if (count === 0) return { startLine: runStartLine, endLine: runStartLine - 1 };
  let firstOrdinal: number;
  let lastOrdinal: number;
  if (request.mode === "first") { firstOrdinal = 0; lastOrdinal = Math.min(count - 1, MAX_SESSION_PAGE_LINES - 1); }
  else if (request.mode === "after") { firstOrdinal = includeCursorLine ? visibleCountLessThan(request.line, runEndLine, visibility) : visibleCountLessThanOrEqual(request.line, runEndLine, visibility); lastOrdinal = Math.min(count - 1, firstOrdinal + MAX_SESSION_PAGE_LINES - 1); }
  else {
    lastOrdinal = request.mode === "before" ? (includeCursorLine ? visibleCountLessThanOrEqual(request.line, runEndLine, visibility) : visibleCountLessThan(request.line, runEndLine, visibility)) - 1 : count - 1;
    firstOrdinal = Math.max(0, lastOrdinal - MAX_SESSION_PAGE_LINES + 1);
  }
  if (firstOrdinal < 0 || firstOrdinal >= count || lastOrdinal < firstOrdinal) return request.mode === "after" ? { startLine: runEndLine + 1, endLine: runEndLine } : { startLine: runStartLine, endLine: runStartLine - 1 };
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

function visibleRenderableCountLessThan(_fd: number, _snapshotSize: number, _index: SessionLineIndex, line: number, runEndLine: number, visibility: RunVisibility, memo?: Map<number, number>): number {
  const cached = memo?.get(line);
  if (cached !== undefined) return cached;
  const end = Math.min(runEndLine + 1, line);
  const opening = visibility.openingLine !== undefined && visibility.openingLine < visibility.keptLine && visibility.openingRenderable && visibility.openingLine < end ? 1 : 0;
  const rangeStartRank = visibilityRankLessThan(visibility.rankIndex, "display", visibility.keptLine);
  const rangeEndRank = visibilityRankLessThan(visibility.rankIndex, "display", Math.max(visibility.keptLine, end));
  const count = opening + Math.max(0, rangeEndRank - rangeStartRank);
  memo?.set(line, count);
  return count;
}


type RenderableLineSearch = { line?: number; skippedOversizedEntries: number };

function firstRenderableLineInRange(_fd: number, _snapshotSize: number, _index: SessionLineIndex, startLine: number, endLine: number, visibility: RunVisibility, _memo?: Map<number, number>): RenderableLineSearch {
  if (endLine < startLine) return { skippedOversizedEntries: 0 };
  const before = visibilityRankLessThan(visibility.rankIndex, "display", startLine);
  const through = visibilityRankLessThan(visibility.rankIndex, "display", endLine + 1);
  const line = through > before ? visibilitySelect(visibility.rankIndex, "display", before) : undefined;
  return { line, skippedOversizedEntries: oversizedLineCount(_fd, _snapshotSize, _index, visibility, startLine, (line ?? startLine) - 1) };
}

function lastRenderableLineInRange(_fd: number, _snapshotSize: number, _index: SessionLineIndex, startLine: number, endLine: number, visibility: RunVisibility, _memo?: Map<number, number>, countSkippedOversized = true): RenderableLineSearch {
  if (endLine < startLine) return { skippedOversizedEntries: 0 };
  const before = visibilityRankLessThan(visibility.rankIndex, "display", startLine);
  const through = visibilityRankLessThan(visibility.rankIndex, "display", endLine + 1);
  const line = through > before ? visibilitySelect(visibility.rankIndex, "display", through - 1) : undefined;
  return { line, skippedOversizedEntries: countSkippedOversized ? oversizedLineCount(_fd, _snapshotSize, _index, visibility, (line ?? startLine - 1) + 1, endLine) : 0 };
}

function oversizedLineCount(_fd: number, _snapshotSize: number, _index: SessionLineIndex, visibility: RunVisibility, startLine: number, endLine: number): number {
  if (endLine < startLine) return 0;
  const separateOpening = visibility.openingLine !== undefined && visibility.openingLine < visibility.keptLine;
  const opening = separateOpening && visibility.openingLine! >= startLine && visibility.openingLine! <= endLine
    ? visibilityRankLessThan(visibility.rankIndex, "oversized", visibility.openingLine! + 1) - visibilityRankLessThan(visibility.rankIndex, "oversized", visibility.openingLine!) : 0;
  const keptStart = Math.max(startLine, visibility.keptLine);
  const kept = endLine < keptStart ? 0 : visibilityRankLessThan(visibility.rankIndex, "oversized", endLine + 1) - visibilityRankLessThan(visibility.rankIndex, "oversized", keptStart);
  return opening + Math.max(0, kept);
}


function nextVisibleRenderableLine(fd: number, snapshotSize: number, index: SessionLineIndex, startLine: number, runEndLine: number, visibility: RunVisibility, memo?: Map<number, number>): RenderableLineSearch {
  const separateOpening = visibility.openingLine !== undefined && visibility.openingLine < visibility.keptLine;
  if (separateOpening && visibility.openingRenderable && visibility.openingLine! >= startLine) return { line: visibility.openingLine, skippedOversizedEntries: 0 };
  return firstRenderableLineInRange(fd, snapshotSize, index, Math.max(startLine, visibility.keptLine), runEndLine, visibility, memo);
}

function previousVisibleRenderableLine(fd: number, snapshotSize: number, index: SessionLineIndex, endLine: number, runEndLine: number, visibility: RunVisibility, memo?: Map<number, number>, countSkippedOversized = true): RenderableLineSearch {
  const search = lastRenderableLineInRange(fd, snapshotSize, index, visibility.keptLine, Math.min(endLine, runEndLine), visibility, memo, countSkippedOversized);
  if (search.line !== undefined) return search;
  const separateOpening = visibility.openingLine !== undefined && visibility.openingLine < visibility.keptLine;
  return { ...search, ...(separateOpening && visibility.openingRenderable && visibility.openingLine! <= endLine ? { line: visibility.openingLine } : {}) };
}

function readVisiblePage(fd: number, snapshotSize: number, index: SessionLineIndex, bounds: VisiblePageBounds, keepTail: boolean): ReadPageLines {
  const separateOpening = bounds.openingLine !== undefined && bounds.openingLine < bounds.startLine;
  if (separateOpening && !keepTail) {
    const opening = readPageLines(fd, snapshotSize, index, bounds.openingLine!, bounds.openingLine!, false, MAX_SESSION_PAGE_CONTENT_BYTES, true);
    const remainingBytes = Math.max(1, MAX_SESSION_PAGE_CONTENT_BYTES - opening.decodedBytes);
    const main = readPageLines(fd, snapshotSize, index, bounds.startLine, bounds.endLine, false, remainingBytes, true);
    return combineOpeningAndMainPages(opening, main);
  }
  const byteBoundedStart = keepTail ? byteBoundedTailStart(index, bounds.startLine, bounds.endLine, snapshotSize) : bounds.startLine;
  const main = readPageLines(fd, snapshotSize, index, byteBoundedStart, bounds.endLine, keepTail, MAX_SESSION_PAGE_CONTENT_BYTES, true);
  if (byteBoundedStart > bounds.startLine) { main.droppedLeadingEntries += byteBoundedStart - bounds.startLine; main.pageStartLine = byteBoundedStart; }
  if (!separateOpening || main.droppedLeadingEntries > 0) return main;
  const remainingBytes = Math.max(1, MAX_SESSION_PAGE_CONTENT_BYTES - main.decodedBytes);
  const opening = readPageLines(fd, snapshotSize, index, bounds.openingLine!, bounds.openingLine!, false, remainingBytes, true);
  if (opening.lines.length === 0 && opening.oversizedEntryPrefixes.length === 0) return main;
  return combineOpeningAndMainPages(opening, main);
}

function combineOpeningAndMainPages(opening: ReadPageLines, main: ReadPageLines): ReadPageLines {
  return {
    lines: [...opening.lines, ...main.lines],
    oversizedEntryPrefixes: [...opening.oversizedEntryPrefixes, ...main.oversizedEntryPrefixes],
    pageStartLine: opening.pageStartLine,
    pageEndLine: main.pageEndLine >= main.pageStartLine ? main.pageEndLine : opening.pageEndLine,
    skippedOversizedEntries: opening.skippedOversizedEntries + main.skippedOversizedEntries,
    incompleteTrailingEntry: opening.incompleteTrailingEntry || main.incompleteTrailingEntry,
    droppedLeadingEntries: 0,
    decodedBytes: opening.decodedBytes + main.decodedBytes
  };
}

function firstRenderableLineInLoadedPage(lines: Array<{ lineNumber: number; text: string }>): number | undefined {
  for (const line of lines) {
    if (!line.text.trim()) continue;
    try {
      const value: unknown = JSON.parse(line.text);
      if (isSessionEntry(value) && isRenderableSessionEntry({ ...value, lineNumber: line.lineNumber })) return line.lineNumber;
    } catch { /* Malformed records do not render. */ }
  }
  return undefined;
}


function indexedLineRangeWithinBytes(index: SessionLineIndex, startLine: number, endLine: number, snapshotSize: number, maximumBytes: number): boolean {
  if (endLine < startLine) return true;
  const startOffset = nearestCheckpoint(index, startLine).offset;
  let endOffset = snapshotSize;
  for (const checkpoint of index.checkpoints) {
    if (checkpoint.lineNumber > endLine) { endOffset = checkpoint.offset; break; }
  }
  return endOffset - startOffset <= maximumBytes;
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
    if (endOffset - checkpoint.offset <= MAX_SESSION_PAGE_CONTENT_BYTES) { result = checkpoint.lineNumber; high = middle - 1; }
    else low = middle + 1;
  }
  return Math.max(desiredStart, result);
}

function visibilityStatePrefix(file: string, index: SessionLineIndex, runStartLine: number): string {
  return `${file}\0${index.dev}:${index.ino}:${index.generation}:${runStartLine}:`;
}

function visibilityStateKey(file: string, index: SessionLineIndex, runStartLine: number, runEndLine: number, snapshotSize: number, fixedEndLine: number | undefined): string {
  const boundary = fixedEndLine === undefined ? `running:${runEndLine}:${snapshotSize}` : `settled:${fixedEndLine}`;
  return `${visibilityStatePrefix(file, index, runStartLine)}${boundary}`;
}

function reusableVisibilityState(file: string, index: SessionLineIndex, runStartLine: number, runEndLine: number, snapshotSize: number): RunVisibilityState | undefined {
  const prefix = `${visibilityStatePrefix(file, index, runStartLine)}running:`;
  let best: RunVisibilityState | undefined;
  for (const [candidateKey, candidate] of runVisibilityStates) {
    if (!candidateKey.startsWith(prefix) || candidate.analyzedEndLine > runEndLine || candidate.snapshotSize > snapshotSize) continue;
    if (!best || candidate.analyzedEndLine > best.analyzedEndLine || candidate.analyzedEndLine === best.analyzedEndLine && candidate.snapshotSize > best.snapshotSize) best = candidate;
  }
  return best;
}

function visibilityState(file: string, index: SessionLineIndex, runStartLine: number, runEndLine: number, snapshotSize: number, fixedEndLine: number | undefined): { key: string; state: RunVisibilityState } {
  const key = visibilityStateKey(file, index, runStartLine, runEndLine, snapshotSize, fixedEndLine);
  let state: RunVisibilityState | undefined = runVisibilityStates.get(key);
  if (!state) {
    const reusable = reusableVisibilityState(file, index, runStartLine, fixedEndLine ?? runEndLine, snapshotSize);
    if (reusable) { state = cloneVisibilityState(reusable); state.snapshotSize = snapshotSize; ensureVisibilityRankCapacity(state.rankIndex, runEndLine); }
    else state = { generation: index.generation, snapshotSize, analyzedEndLine: runStartLine - 1, validEntries: 0, entryIds: new Map(), openingRenderable: false, keptLine: runStartLine, renderedBeforeKept: 0, hiddenEntries: 0, compactionCount: 0, incompleteTrailingEntry: false, renderedEntries: 0, oversizedEntries: 0, rankIndex: createVisibilityRankIndex(runStartLine, runEndLine) };
    runVisibilityStates.set(key, state);
  }
  touchVisibilityState(key, state);
  return { key, state };
}

function cloneVisibilityState(state: RunVisibilityState): RunVisibilityState {
  return { ...state, entryIds: new Map(state.entryIds), rankIndex: cloneVisibilityRankIndex(state.rankIndex), ...(state.pendingCompaction ? { pendingCompaction: { ...state.pendingCompaction } } : {}) };
}

function touchVisibilityState(key: string, state: RunVisibilityState): void {
  runVisibilityStates.delete(key); runVisibilityStates.set(key, state);
  while (runVisibilityStates.size > MAX_VISIBILITY_CACHE_ENTRIES) {
    const evicted = [...runVisibilityStates.keys()].find((candidate) => !runVisibilityFlights.has(candidate));
    if (!evicted) break;
    runVisibilityStates.delete(evicted);
  }
}

function visibilityResult(state: RunVisibilityState): RunVisibility {
  return { openingLine: state.openingLine, openingRenderable: state.openingRenderable, keptLine: state.keptLine, renderedBeforeKept: state.renderedBeforeKept, hiddenEntries: state.hiddenEntries, compactionCount: state.compactionCount, incompleteTrailingEntry: state.incompleteTrailingEntry, renderedEntries: state.renderedEntries, oversizedEntries: state.oversizedEntries, rankIndex: state.rankIndex, ...(state.incompleteLine === undefined ? {} : { incompleteLine: state.incompleteLine }) };
}

function visibilityAnalysisComplete(state: RunVisibilityState, runEndLine: number, snapshotSize: number): boolean {
  if (state.analyzedEndLine >= runEndLine && !state.pendingCompaction) return true;
  return state.incompleteLine === runEndLine && !state.pendingCompaction && state.incompleteSnapshotSize === snapshotSize;
}

function analyzeRunVisibility(fd: number, file: string, snapshotSize: number, index: SessionLineIndex, runStartLine: number, runEndLine: number, fixedEndLine?: number): RunVisibility {
  for (;;) {
    const { key, state } = visibilityState(file, index, runStartLine, runEndLine, snapshotSize, fixedEndLine);
    if (visibilityAnalysisComplete(state, runEndLine, snapshotSize)) return visibilityResult(state);
    const next = cloneVisibilityState(state);
    next.snapshotSize = snapshotSize;
    next.incompleteTrailingEntry = false; delete next.incompleteLine; delete next.incompleteSnapshotSize;
    if (next.analyzedEndLine < runEndLine) {
      const scan = scanRunEntries(fd, snapshotSize, index, Math.max(runStartLine, next.analyzedEndLine + 1), runEndLine, (entry, line) => { updateVisibilityState(next, entry, line); }, (line) => { completeVisibilityRankIndex(next.rankIndex, line); }, (line) => { next.oversizedEntries += 1; setVisibilityBit(next.rankIndex, "oversized", line); });
      if (scan.snapshotExhausted) throw new SessionChangedDuringReadError();
      next.analyzedEndLine = Math.max(next.analyzedEndLine, scan.lastCompleteLine);
      if (scan.incompleteLine !== undefined) { next.incompleteTrailingEntry = true; next.incompleteLine = scan.incompleteLine; next.incompleteSnapshotSize = snapshotSize; }
    }
    if (next.pendingCompaction) resolveCompactionBoundary(fd, snapshotSize, index, runStartLine, next);
    if (runVisibilityStates.get(key) === state) {
      touchVisibilityState(key, next);
      return visibilityResult(next);
    }
  }
}

async function analyzeRunVisibilityCooperatively(fd: number, file: string, snapshotSize: number, index: SessionLineIndex, runStartLine: number, runEndLine: number, fixedEndLine?: number): Promise<RunVisibility> {
  for (;;) {
    const { key, state } = visibilityState(file, index, runStartLine, runEndLine, snapshotSize, fixedEndLine);
    if (visibilityAnalysisComplete(state, runEndLine, snapshotSize)) return visibilityResult(state);
    let flight = runVisibilityFlights.get(key);
    if (!flight) {
      const base = state;
      const next = cloneVisibilityState(base);
      next.snapshotSize = snapshotSize;
      next.incompleteTrailingEntry = false; delete next.incompleteLine; delete next.incompleteSnapshotSize;
      const promise = (async () => {
        let incompleteTrailingEntry = false;
        if (next.analyzedEndLine < runEndLine) {
          const scan = await scanRunEntriesCooperatively(fd, snapshotSize, index, Math.max(runStartLine, next.analyzedEndLine + 1), runEndLine, (entry, line) => { updateVisibilityState(next, entry, line); }, (line) => { completeVisibilityRankIndex(next.rankIndex, line); }, (line) => { next.oversizedEntries += 1; setVisibilityBit(next.rankIndex, "oversized", line); });
          if (scan.snapshotExhausted) throw new SessionChangedDuringReadError();
          next.analyzedEndLine = Math.max(next.analyzedEndLine, scan.lastCompleteLine);
          if (scan.incompleteLine !== undefined) { incompleteTrailingEntry = true; next.incompleteTrailingEntry = true; next.incompleteLine = scan.incompleteLine; next.incompleteSnapshotSize = snapshotSize; }
        }
        if (next.pendingCompaction) await resolveCompactionBoundaryCooperatively(fd, snapshotSize, index, runStartLine, next);
        if (runVisibilityStates.get(key) === base) touchVisibilityState(key, next);
        return { incompleteTrailingEntry, snapshotSize };
      })();
      flight = { promise }; runVisibilityFlights.set(key, flight);
      const clearFlight = () => { if (runVisibilityFlights.get(key) === flight) runVisibilityFlights.delete(key); };
      void promise.then(clearFlight, clearFlight);
    }
    const result = await flight.promise;
    if (result.incompleteTrailingEntry && result.snapshotSize === snapshotSize) {
      const current = visibilityState(file, index, runStartLine, runEndLine, snapshotSize, fixedEndLine).state;
      return visibilityResult(current);
    }
  }
}

function updateVisibilityState(state: RunVisibilityState, entry: WorkerSessionEntry, line: number): void {
  const ordinal = state.validEntries;
  const renderable = isRenderableSessionEntry(entry);
  state.entryIds.delete(entry.id);
  state.entryIds.set(entry.id, { line, ordinal, renderedBefore: state.renderedEntries });
  while (state.entryIds.size > MAX_VISIBILITY_ENTRY_IDS) state.entryIds.delete(state.entryIds.keys().next().value!);
  if (state.openingLine === undefined && entry.type === "message" && record(entry.message)?.role === "user") { state.openingLine = line; state.openingRenderable = renderable; }
  if (entry.type === "compaction") {
    state.compactionCount += 1;
    const firstKeptEntryId = typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined;
    state.pendingCompaction = { line, ordinal, renderedBefore: state.renderedEntries, ...(firstKeptEntryId ? { firstKeptEntryId } : {}) };
    if (!firstKeptEntryId) applyCompactionBoundary(state, line, ordinal, state.renderedEntries);
    else {
      const known = state.entryIds.get(firstKeptEntryId);
      if (known) applyCompactionBoundary(state, known.line, known.ordinal, known.renderedBefore);
    }
  }
  state.validEntries += 1;
  if (renderable) { state.renderedEntries += 1; setVisibilityBit(state.rankIndex, "display", line); }
}

function isRenderableSessionEntry(entry: WorkerSessionEntry): boolean {
  return entry.oversized !== true && renderableBlockCount(entry) > 0;
}


function applyCompactionBoundary(state: RunVisibilityState, keptLine: number, keptOrdinal: number, renderedBeforeKept: number): void {
  state.keptLine = keptLine;
  state.renderedBeforeKept = renderedBeforeKept;
  const preservesOpening = state.openingLine !== undefined && state.openingLine < keptLine;
  state.hiddenEntries = Math.max(0, keptOrdinal - (preservesOpening ? 1 : 0));
  state.pendingCompaction = undefined;
}

function resolveCompactionBoundary(fd: number, snapshotSize: number, index: SessionLineIndex, runStartLine: number, state: RunVisibilityState): void {
  const pending = state.pendingCompaction;
  if (!pending) return;
  if (!pending.firstKeptEntryId) return applyCompactionBoundary(state, pending.line, pending.ordinal, pending.renderedBefore);
  const beforeRun = findEntryLine(fd, snapshotSize, index, 2, runStartLine - 1, pending.firstKeptEntryId);
  if (beforeRun !== undefined) return applyCompactionBoundary(state, runStartLine, 0, 0);
  let ordinal = 0; let rendered = 0; let found: { line: number; ordinal: number; renderedBefore: number } | undefined;
  scanRunEntries(fd, snapshotSize, index, runStartLine, pending.line, (entry, line) => { if (!found && entry.id === pending.firstKeptEntryId) found = { line, ordinal, renderedBefore: rendered }; ordinal += 1; if (isRenderableSessionEntry(entry)) rendered += 1; });
  if (found) applyCompactionBoundary(state, found.line, found.ordinal, found.renderedBefore);
  else applyCompactionBoundary(state, pending.line, pending.ordinal, pending.renderedBefore);
}

async function resolveCompactionBoundaryCooperatively(fd: number, snapshotSize: number, index: SessionLineIndex, runStartLine: number, state: RunVisibilityState): Promise<void> {
  const pending = state.pendingCompaction;
  if (!pending) return;
  if (!pending.firstKeptEntryId) return applyCompactionBoundary(state, pending.line, pending.ordinal, pending.renderedBefore);
  const beforeRun = await findEntryLineCooperatively(fd, snapshotSize, index, 2, runStartLine - 1, pending.firstKeptEntryId);
  if (beforeRun !== undefined) return applyCompactionBoundary(state, runStartLine, 0, 0);
  let ordinal = 0; let rendered = 0; let found: { line: number; ordinal: number; renderedBefore: number } | undefined;
  await scanRunEntriesCooperatively(fd, snapshotSize, index, runStartLine, pending.line, (entry, line) => { if (!found && entry.id === pending.firstKeptEntryId) found = { line, ordinal, renderedBefore: rendered }; ordinal += 1; if (isRenderableSessionEntry(entry)) rendered += 1; });
  if (found) applyCompactionBoundary(state, found.line, found.ordinal, found.renderedBefore);
  else applyCompactionBoundary(state, pending.line, pending.ordinal, pending.renderedBefore);
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

type RunEntryScanResult = { lastCompleteLine: number; skippedOversizedEntries: number; incompleteLine?: number; snapshotExhausted?: true };

async function scanRunEntriesCooperatively(fd: number, snapshotSize: number, index: SessionLineIndex, startLine: number, endLine: number, visit: (entry: WorkerSessionEntry, line: number) => void, pageComplete?: (line: number, skippedOversizedEntries: number) => void, visitOversized?: (line: number) => void): Promise<RunEntryScanResult> {
  let line = startLine;
  let lastCompleteLine = startLine - 1;
  let skippedOversizedEntries = 0;
  while (line <= endLine) {
    const page = readPageLines(fd, snapshotSize, index, line, Math.min(endLine, line + MAX_SESSION_PAGE_LINES - 1), false);
    skippedOversizedEntries += page.skippedOversizedEntries;
    lastCompleteLine = page.incompleteTrailingEntry ? page.pageEndLine - 1 : page.pageEndLine;
    for (const entry of parsedRunPageEntries(page)) if (entry.lineNumber <= lastCompleteLine) visit(entry, entry.lineNumber);
    for (const item of page.oversizedEntryPrefixes) if (item.lineNumber <= lastCompleteLine) visitOversized?.(item.lineNumber);
    if (lastCompleteLine >= line) pageComplete?.(lastCompleteLine, page.oversizedEntryPrefixes.filter((item) => item.lineNumber <= lastCompleteLine).length);
    if (page.incompleteTrailingEntry) { await yieldToEventLoop(); return { lastCompleteLine, skippedOversizedEntries, incompleteLine: page.pageEndLine }; }
    if (page.pageEndLine < line) { await yieldToEventLoop(); return { lastCompleteLine, skippedOversizedEntries, snapshotExhausted: true }; }
    line = page.pageEndLine + 1;
    await yieldToEventLoop();
  }
  return { lastCompleteLine, skippedOversizedEntries };
}

function scanRunEntries(fd: number, snapshotSize: number, index: SessionLineIndex, startLine: number, endLine: number, visit: (entry: WorkerSessionEntry, line: number) => void, pageComplete?: (line: number, skippedOversizedEntries: number) => void, visitOversized?: (line: number) => void): RunEntryScanResult {
  let line = startLine;
  let lastCompleteLine = startLine - 1;
  let skippedOversizedEntries = 0;
  while (line <= endLine) {
    const page = readPageLines(fd, snapshotSize, index, line, Math.min(endLine, line + MAX_SESSION_PAGE_LINES - 1), false);
    skippedOversizedEntries += page.skippedOversizedEntries;
    lastCompleteLine = page.incompleteTrailingEntry ? page.pageEndLine - 1 : page.pageEndLine;
    for (const entry of parsedRunPageEntries(page)) if (entry.lineNumber <= lastCompleteLine) visit(entry, entry.lineNumber);
    for (const item of page.oversizedEntryPrefixes) if (item.lineNumber <= lastCompleteLine) visitOversized?.(item.lineNumber);
    if (lastCompleteLine >= line) pageComplete?.(lastCompleteLine, page.oversizedEntryPrefixes.filter((item) => item.lineNumber <= lastCompleteLine).length);
    if (page.incompleteTrailingEntry) return { lastCompleteLine, skippedOversizedEntries, incompleteLine: page.pageEndLine };
    if (page.pageEndLine < line) return { lastCompleteLine, skippedOversizedEntries, snapshotExhausted: true };
    line = page.pageEndLine + 1;
  }
  return { lastCompleteLine, skippedOversizedEntries };
}

function parsedRunPageEntries(page: ReadPageLines): WorkerSessionEntry[] {
  const entries: WorkerSessionEntry[] = [];
  for (const item of page.lines) {
    let value: unknown;
    try { value = JSON.parse(item.text); } catch { continue; }
    if (isSessionEntry(value)) entries.push({ ...value, lineNumber: item.lineNumber });
  }
  for (const item of page.oversizedEntryPrefixes) {
    const entry = parseOversizedSessionEntryPrefix(item.text, item.lineNumber);
    if (entry) entries.push(entry);
  }
  return entries.sort((left, right) => left.lineNumber - right.lineNumber);
}

function parseOversizedSessionEntryPrefix(metadata: string, lineNumber: number): WorkerSessionEntry | undefined {
  const ordered = metadata.match(/^\s*\{\s*"type"\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*"id"\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*"parentId"\s*:\s*(null|"(?:\\.|[^"\\])*")\s*,\s*"timestamp"\s*:\s*("(?:\\.|[^"\\])*")/u);
  try {
    const typeToken = ordered?.[1] ?? metadata.match(/^\s*\{\s*"type"\s*:\s*("(?:\\.|[^"\\])*")/u)?.[1];
    if (!typeToken) return undefined;
    const type = JSON.parse(typeToken) as unknown;
    let idToken = ordered?.[2]; let parentToken = ordered?.[3]; let timestampToken = ordered?.[4];
    if (!ordered && (type === "custom" || type === "custom_message")) {
      idToken = [...metadata.matchAll(/"id"\s*:\s*("(?:\\.|[^"\\])*")/gu)].at(-1)?.[1];
      parentToken = [...metadata.matchAll(/"parentId"\s*:\s*(null|"(?:\\.|[^"\\])*")/gu)].at(-1)?.[1];
      timestampToken = [...metadata.matchAll(/"timestamp"\s*:\s*("(?:\\.|[^"\\])*")/gu)].at(-1)?.[1];
    }
    if (!idToken || !parentToken || !timestampToken) return undefined;
    const value: Record<string, unknown> = { type, id: JSON.parse(idToken), parentId: JSON.parse(parentToken), timestamp: JSON.parse(timestampToken), oversized: true };
    const firstKept = metadata.match(/"firstKeptEntryId"\s*:\s*("(?:\\.|[^"\\])*")/u);
    if (firstKept) value.firstKeptEntryId = JSON.parse(firstKept[1]!);
    const role = metadata.match(/"message"\s*:\s*\{\s*"role"\s*:\s*("(?:\\.|[^"\\])*")/u);
    if (role) value.message = { role: JSON.parse(role[1]!) };
    return isSessionEntry(value) ? { ...value, lineNumber } : undefined;
  } catch { return undefined; }
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
    const count = readSessionRange(fd, buffer, 0, Math.min(buffer.length, snapshotSize - position), position);
    if (count === 0) throw new SessionChangedDuringReadError();
    let cursor = 0;
    while (cursor < count) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline < 0 || newline >= count) break;
      const absoluteNewline = position + newline;
      const lineBytes = absoluteNewline - index.lineStartOffset;
      const oversized = lineBytes >= MAX_SESSION_ENTRY_DISPLAY_BYTES;
      const pinned = lineBytes >= SESSION_INDEX_PIN_BYTES;
      index.newlineCount += 1;
      const nextLine = index.newlineCount + 1;
      if (pinned) {
        const currentLine = nextLine - 1; const previous = index.checkpoints.at(-1);
        if (previous?.lineNumber === currentLine) index.checkpoints[index.checkpoints.length - 1] = { ...previous, pinned: true };
        else index.checkpoints.push({ lineNumber: currentLine, offset: index.lineStartOffset, pinned: true });
      }
      if ((nextLine - 1) % index.stride === 0 || pinned) {
        const previous = index.checkpoints.at(-1);
        const checkpoint = { lineNumber: nextLine, offset: absoluteNewline + 1, ...(pinned ? { pinned: true } : {}), ...(oversized ? { oversizedStartOffset: index.lineStartOffset } : {}) };
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
    const last = index.checkpoints.length - 1;
    const preferred = index.checkpoints.filter((value, position) => position === 0 || position === last || value.pinned === true || position % 2 === 0);
    index.checkpoints = preferred.length < index.checkpoints.length && preferred.length <= MAX_LINE_INDEX_CHECKPOINTS
      ? preferred : index.checkpoints.filter((_value, position) => position === 0 || position === last || position % 2 === 0);
    index.stride *= 2;
  }
}

function cloneSessionLineIndex(index: SessionLineIndex): SessionLineIndex {
  return { ...index, checkpoints: index.checkpoints.slice() };
}

function retainSessionLineIndexByCas(file: string, index: SessionLineIndex): void {
  const current = sessionLineIndexes.get(file);
  if (current && (current.generation > index.generation
    || current.generation === index.generation && current.size >= index.size
    || current.generation < index.generation && current.dev === index.dev && current.ino === index.ino && current.size > index.size)) return;
  retainSessionLineIndex(file, cloneSessionLineIndex(index));
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
    const count = readSessionRange(fd, buffer, 0, length, offset);
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
  const count = length === 0 ? 0 : readSessionRange(fd, buffer, 0, length, 0);
  const newline = buffer.subarray(0, count).indexOf(0x0a);
  if (newline < 0) {
    if (count > MAX_SESSION_HEADER_BYTES) throw new Error("Worker session header exceeds its read bound.");
    throw new Error("Worker session has no complete header.");
  }
  return decodeUtf8(buffer.subarray(0, newline));
}

function indexedNondisplayLineEnd(fd: number, snapshotSize: number, index: SessionLineIndex, line: number, lineStartOffset: number): number | undefined {
  const metadata = indexedLineMetadata(fd, snapshotSize, index, line, false);
  if (!metadata || metadata.start !== lineStartOffset || metadata.next === undefined) return undefined;
  const type = metadata.prefix.match(/^\s*\{\s*"type"\s*:\s*"([^"]+)"/u)?.[1];
  const metadataText = `${metadata.prefix}\n${metadata.suffix}`;
  if (type === "custom") return metadata.next;
  return undefined;
}

function readPageLines(fd: number, snapshotSize: number, index: SessionLineIndex, desiredStart: number, desiredEnd: number, keepTail: boolean, maxPageBytes = MAX_SESSION_PAGE_BYTES, skipKnownNondisplay = false): ReadPageLines {
  if (desiredEnd < desiredStart) return { lines: [], oversizedEntryPrefixes: [], pageStartLine: desiredStart, pageEndLine: desiredEnd, skippedOversizedEntries: 0, incompleteTrailingEntry: false, droppedLeadingEntries: 0, decodedBytes: 0 };
  const checkpoint = nearestCheckpoint(index, desiredStart);
  const buffer = Buffer.allocUnsafe(Math.min(SESSION_PAGE_READ_CHUNK, Math.max(1, snapshotSize - checkpoint.offset)));
  const oversizedSpans = index.checkpoints.filter((value) => value.oversizedStartOffset !== undefined && value.offset <= snapshotSize);
  let oversizedSpanIndex = oversizedSpans.findIndex((value) => value.offset > checkpoint.offset);
  if (oversizedSpanIndex < 0) oversizedSpanIndex = oversizedSpans.length;
  const lines: Array<{ lineNumber: number; text: string; bytes: number }> = [];
  const oversizedEntryPrefixes: Array<{ lineNumber: number; text: string }> = [];
  let totalBytes = 0;
  let skippedOversizedEntries = 0;
  let position = checkpoint.offset;
  let lineNumber = checkpoint.lineNumber;
  let lineStartOffset = checkpoint.offset;
  let parts: Buffer[] = [];
  let partBytes = 0;
  let oversized = false;
  let pageEndLine = desiredStart - 1;
  let incompleteTrailingEntry = false;
  let stoppedForPageBytes = false;
  let droppedLeadingEntries = 0;

  const append = (part: Buffer): boolean => {
    if (lineNumber < desiredStart || lineNumber > desiredEnd || oversized || part.length === 0) return true;
    if (!keepTail && totalBytes + partBytes + part.length + 1 > maxPageBytes && (lines.length > 0 || maxPageBytes < MAX_SESSION_PAGE_CONTENT_BYTES)) {
      pageEndLine = lineNumber - 1; stoppedForPageBytes = true; return false;
    }
    if (partBytes + part.length >= MAX_SESSION_ENTRY_DISPLAY_BYTES) { oversized = true; parts = []; partBytes = 0; return true; }
    parts.push(Buffer.from(part));
    partBytes += part.length;
    return true;
  };
  const finish = (lineEndOffset: number): boolean => {
    if (lineNumber >= desiredStart && lineNumber <= desiredEnd) {
      pageEndLine = lineNumber;
      if (oversized) {
        skippedOversizedEntries += 1;
        oversizedEntryPrefixes.push({ lineNumber, text: readOversizedEntryPrefix(fd, { startOffset: lineStartOffset, endOffset: lineEndOffset }, snapshotSize) });
      } else {
        const bytes = partBytes + 1;
        if (!keepTail && totalBytes + bytes > maxPageBytes && (lines.length > 0 || maxPageBytes < MAX_SESSION_PAGE_CONTENT_BYTES)) { pageEndLine = lineNumber - 1; stoppedForPageBytes = true; return false; }
        if (partBytes >= MAX_SESSION_ENTRY_DISPLAY_BYTES) { skippedOversizedEntries += 1; oversizedEntryPrefixes.push({ lineNumber, text: "" }); }
        else {
          lines.push({ lineNumber, text: decodeUtf8(Buffer.concat(parts, partBytes)), bytes });
          totalBytes += bytes;
          if (keepTail) while (totalBytes > maxPageBytes && lines.length > 1) { totalBytes -= lines.shift()!.bytes; droppedLeadingEntries += 1; }
        }
      }
    }
    parts = []; partBytes = 0; oversized = false; lineNumber += 1; lineStartOffset = lineEndOffset + 1;
    return lineNumber <= desiredEnd;
  };

  scan: while (position < snapshotSize && lineNumber <= desiredEnd) {
    while (oversizedSpanIndex < oversizedSpans.length && oversizedSpans[oversizedSpanIndex]!.offset <= position) oversizedSpanIndex += 1;
    const span = oversizedSpans[oversizedSpanIndex];
    if (span?.oversizedStartOffset === position && span.lineNumber === lineNumber + 1) {
      if (lineNumber >= desiredStart) {
        pageEndLine = lineNumber;
        skippedOversizedEntries += 1;
        oversizedEntryPrefixes.push({ lineNumber, text: readOversizedEntryPrefix(fd, { startOffset: position, endOffset: span.offset - 1 }, snapshotSize) });
      }
      position = span.offset; lineNumber += 1; lineStartOffset = position; parts = []; partBytes = 0; oversized = false; oversizedSpanIndex += 1;
      continue;
    }
    if (skipKnownNondisplay && lineNumber >= desiredStart) {
      const nondisplayEnd = indexedNondisplayLineEnd(fd, snapshotSize, index, lineNumber, position);
      if (nondisplayEnd !== undefined) {
        pageEndLine = lineNumber; position = nondisplayEnd; lineNumber += 1; lineStartOffset = position; parts = []; partBytes = 0; oversized = false;
        continue;
      }
    }
    const beforePinnedSpan = span?.oversizedStartOffset !== undefined && span.oversizedStartOffset > position ? span.oversizedStartOffset - position : buffer.length;
    const count = readSessionRange(fd, buffer, 0, Math.min(buffer.length, snapshotSize - position, beforePinnedSpan), position);
    if (count === 0) {
      if (sessionPageBudgetExhausted(fd)) { stoppedForPageBytes = true; parts = []; partBytes = 0; break; }
      throw new SessionChangedDuringReadError();
    }
    let cursor = 0;
    while (cursor < count) {
      const newline = buffer.indexOf(0x0a, cursor);
      const end = newline >= 0 && newline < count ? newline : count;
      if (end > cursor && !append(buffer.subarray(cursor, end))) break scan;
      if (newline < 0 || newline >= count) break;
      if (!finish(position + newline)) break scan;
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
  return { lines: publicLines, oversizedEntryPrefixes, pageStartLine, pageEndLine: Math.max(desiredStart - 1, pageEndLine), skippedOversizedEntries, incompleteTrailingEntry, droppedLeadingEntries, decodedBytes: totalBytes };
}

function readOversizedEntryPrefix(fd: number, offsets: { startOffset: number; endOffset: number }, snapshotSize: number): string {
  const entryEnd = Math.min(offsets.endOffset, snapshotSize);
  const length = Math.min(OVERSIZED_ENTRY_PREFIX_BYTES, entryEnd - offsets.startOffset);
  if (length <= 0) return "";
  const buffer = Buffer.allocUnsafe(length);
  const count = readSessionRange(fd, buffer, 0, length, offsets.startOffset);
  if (count !== length) { if (sessionPageBudgetExhausted(fd)) return ""; throw new SessionChangedDuringReadError(); }
  const head = new TextDecoder("utf-8").decode(buffer);
  const suffixLength = Math.min(OVERSIZED_ENTRY_PREFIX_BYTES, Math.max(0, entryEnd - offsets.startOffset - length));
  if (suffixLength === 0) return head;
  const suffixBuffer = Buffer.allocUnsafe(suffixLength);
  const suffixCount = readSessionRange(fd, suffixBuffer, 0, suffixLength, entryEnd - suffixLength);
  if (suffixCount !== suffixLength) { if (sessionPageBudgetExhausted(fd)) return head; throw new SessionChangedDuringReadError(); }
  return `${head}
${new TextDecoder("utf-8").decode(suffixBuffer)}`;
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

function parseSessionEntriesForBlockPage(lines: Array<{ lineNumber: number; text: string }>, request: WorkerSessionPageRequest): { entries: WorkerSessionEntry[]; malformedEntries: number; truncated: boolean } {
  const keepTail = request.mode === "tail" || request.mode === "before";
  const source = keepTail ? [...lines].reverse() : lines;
  const entries: WorkerSessionEntry[] = [];
  let malformedEntries = 0;
  let remainingBlocks = MAX_SESSION_PAGE_BLOCKS;
  let truncated = false;
  for (const [sourceIndex, line] of source.entries()) {
    if (!line.text.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line.text); } catch { malformedEntries += 1; continue; }
    if (!isSessionEntry(value)) { malformedEntries += 1; continue; }
    const entry = { ...value, lineNumber: line.lineNumber };
    entries.push(entry);
    const count = renderableBlockCount(entry);
    const available = request.mode === "after" && request.block !== undefined && line.lineNumber === request.line ? Math.max(0, count - request.block)
      : request.mode === "before" && request.block !== undefined && line.lineNumber === request.line ? Math.min(count, Math.max(0, request.block)) : count;
    remainingBlocks -= available;
    if (remainingBlocks <= 0) {
      let trailingMalformedEntries = 0;
      for (const candidate of source.slice(sourceIndex + 1)) {
        if (!candidate.text.trim()) continue;
        let later: unknown;
        try { later = JSON.parse(candidate.text); } catch { trailingMalformedEntries += 1; continue; }
        if (!isSessionEntry(later)) { trailingMalformedEntries += 1; continue; }
        if (renderableBlockCount({ ...later, lineNumber: candidate.lineNumber }) > 0) { truncated = true; break; }
      }
      if (!truncated && remainingBlocks === 0) malformedEntries += trailingMalformedEntries;
      break;
    }
  }
  if (keepTail) entries.reverse();
  return { entries, malformedEntries, truncated };
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

function renderableBlockCount(entry: WorkerSessionEntry): number {
  if (entry.type !== "message") return renderableBlocks(entry).length;
  const message = record(entry.message);
  if (!message || message.role !== "assistant") return 1;
  let count = 0;
  for (const part of contentParts(message.content)) if (part !== undefined && part !== null) count += 1;
  if (message.stopReason === "error" || message.stopReason === "aborted") count += 1;
  return Math.max(1, count);
}

function renderableBlockSlice(entry: WorkerSessionEntry, start: number, end: number): WorkerSessionViewBlock[] {
  if (entry.type === "message" && record(entry.message)?.role === "assistant") return messageBlocks(entry, start, end);
  return renderableBlocks(entry).slice(start, end);
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

function messageBlocks(entry: WorkerSessionEntry, start = 0, end = Number.POSITIVE_INFINITY): WorkerSessionViewBlock[] {
  const message = record(entry.message);
  if (!message) return [{ kind: "status", label: "Malformed message", timestamp: entry.timestamp, text: "Message payload was not an object." }];
  const role = typeof message.role === "string" ? message.role : "unknown";
  if (role === "assistant") {
    const model = [message.provider, message.model].filter((value): value is string => typeof value === "string").join("/");
    const blocks: WorkerSessionViewBlock[] = [];
    let ordinal = 0;
    for (const part of contentParts(message.content)) {
      if (part === undefined || part === null) continue;
      if (ordinal >= start && ordinal < end) {
        const value = record(part);
        if (value?.type === "thinking") blocks.push({ kind: "thinking", label: "Thinking", timestamp: entry.timestamp, text: boundBlockText(textField(value.thinking, textField(value.text, ""))) });
        else if (value?.type === "toolCall") blocks.push({ kind: "tool", label: `Tool call · ${textField(value.name, "unknown")}`, timestamp: entry.timestamp, text: boundedJson(value.arguments ?? value.input ?? {}) });
        else blocks.push({ kind: "assistant", label: model ? `Assistant · ${model}` : "Assistant", timestamp: entry.timestamp, text: partText(part) });
      }
      ordinal += 1;
    }
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    if (stopReason === "error" || stopReason === "aborted") {
      if (ordinal >= start && ordinal < end) blocks.push({ kind: "error", label: stopReason === "error" ? "Provider error" : "Provider aborted", timestamp: entry.timestamp, text: boundBlockText(textField(message.errorMessage, stopReason === "error" ? "The provider ended this response with an error." : "The provider response was aborted.")) });
      ordinal += 1;
    }
    if (ordinal === 0 && start === 0 && end > 0) blocks.push({ kind: "assistant", label: model ? `Assistant · ${model}` : "Assistant", timestamp: entry.timestamp, text: "(empty message)" });
    return blocks;
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
