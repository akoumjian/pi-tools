import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { buildWorkerSessionViewerFrame, countSessionLines, createWorkerSessionViewerComponent, loadWorkerSessionViewSnapshot, loadWorkerSessionViewSnapshotAsync, openWorkerSessionViewer, sanitizeViewText, type WorkerSessionPageRequest, type WorkerSessionViewSnapshot, type WorkerSessionViewTarget, type WorkerSessionViewerState } from "../extensions/worker/view.js";
import { forkWorkerSession } from "../extensions/worker/session.js";

function fixture(options: { root?: string; splitRoots?: boolean } = {}) {
  const root = options.root ?? mkdtempSync(path.join(tmpdir(), "worker-view-"));
  const workerRoot = path.join(root, "state", "worker");
  const workspaceRoot = options.splitRoots ? path.join(root, "workspaces", "worker") : path.join(workerRoot, "workspace");
  const sessionRoot = path.join(workerRoot, "session");
  const sessionFile = path.join(sessionRoot, "worker.jsonl");
  const parentSessionFile = path.join(root, "parent.jsonl");
  mkdirSync(workspaceRoot, { recursive: true }); mkdirSync(sessionRoot, { recursive: true });
  writeFileSync(parentSessionFile, "parent\n");
  const target: WorkerSessionViewTarget = { workerId: "worker_20260101000000_aaaaaaaa", role: "work", workerStatus: "idle", runId: "run_20260101000000_bbbbbbbb", runStatus: "settled", outcome: "completed", modelSelection: "openai-codex/gpt-5.6-sol:xhigh", sessionId: "session-test", sessionFile, sessionRoot, workspaceRoot, parentSessionFile, sessionStartLine: 2, sessionEndLine: 2 };
  return { root, sessionFile, sessionRoot, target, close: () => rmSync(root, { recursive: true, force: true }) };
}

function header(target: WorkerSessionViewTarget, overrides: Record<string, unknown> = {}) { return { type: "session", version: 3, id: target.sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: target.workspaceRoot, parentSession: target.parentSessionFile, ...overrides }; }
function message(id: string, parentId: string | null, content: string, extra: Record<string, unknown> = {}) { return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content, ...extra } }; }
function line(value: unknown): string { return `${JSON.stringify(value)}\n`; }
function snapshot(target: WorkerSessionViewTarget, blocks: WorkerSessionViewSnapshot["blocks"], overrides: Partial<WorkerSessionViewSnapshot> = {}): WorkerSessionViewSnapshot {
  return { target, blocks, totalActiveEntries: blocks.length, malformedEntries: 0, skippedOversizedEntries: 0, incompleteTrailingEntry: false, hiddenCompactedEntries: 0, compactionCount: 0, previousVisibleEntries: 0, nextVisibleEntries: 0, totalVisibleEntries: blocks.length, runStartLine: target.sessionStartLine ?? 1, runEndLine: target.sessionEndLine ?? target.sessionStartLine ?? 0, pageStartLine: target.sessionStartLine ?? 1, pageEndLine: target.sessionEndLine ?? target.sessionStartLine ?? 0, hasPreviousPage: false, hasNextPage: false, refreshedAt: "now", ...overrides };
}
async function tick() { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function watchdog<T>(promise: Promise<T>, milliseconds = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`watchdog expired after ${milliseconds}ms`)), milliseconds);
    void promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
function assertHalfWriteChildLiveness(target: WorkerSessionViewTarget): void {
  const moduleUrl = new URL("../extensions/worker/view.js", import.meta.url).href;
  const script = `import { loadWorkerSessionViewSnapshotAsync } from ${JSON.stringify(moduleUrl)}; const target = JSON.parse(process.argv[1]); const value = await loadWorkerSessionViewSnapshotAsync(target); if (!value.incompleteTrailingEntry) process.exit(2);`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(target)], { timeout: 5_000, stdio: "pipe" });
}
function assertViewerHalfWriteChildLiveness(target: WorkerSessionViewTarget, partial: string): void {
  const moduleUrl = new URL("../extensions/worker/view.js", import.meta.url).href;
  const script = `import { appendFileSync } from "node:fs"; import { createWorkerSessionViewerComponent, loadWorkerSessionViewSnapshot, loadWorkerSessionViewSnapshotAsync } from ${JSON.stringify(moduleUrl)}; const target = JSON.parse(process.argv[1]); const initial = loadWorkerSessionViewSnapshot(target); appendFileSync(target.sessionFile, process.argv[2]); await new Promise((resolve, reject) => { const component = createWorkerSessionViewerComponent({ tui: { terminal: { rows: 30 }, requestRender() {} }, getTheme: () => ({}), initialSnapshot: initial, loadSnapshot: async (request) => { try { const value = await loadWorkerSessionViewSnapshotAsync(target, request); if (!value.incompleteTrailingEntry) throw new Error("missing partial notice"); resolve(); return value; } catch (error) { reject(error); throw error; } }, done() {} }); component.handleInput("r"); });`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(target), partial], { timeout: 5_000, stdio: "pipe" });
}
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

test("worker conversation view preserves the opening assignment and renders compaction chronologically without raw JSONL", () => {
  const f = fixture();
  try {
    const user = { type: "message", id: "u1", parentId: "outside-range", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "old question" } };
    const kept = { type: "message", id: "u2", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "kept question" } };
    const compaction = { type: "compaction", id: "c1", parentId: "u2", timestamp: "2026-01-01T00:00:03.000Z", summary: "Earlier work summary", firstKeptEntryId: "u2", tokensBefore: 1200 };
    const assistant = { type: "message", id: "a1", parentId: "c1", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", content: [{ type: "thinking", thinking: "check carefully" }, { type: "toolCall", name: "search_many", arguments: { pattern: "x" } }, { type: "text", text: "done" }] } };
    const result = { type: "message", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "toolResult", toolName: "search_many", isError: false, content: [{ type: "text", text: "match" }] } };
    writeFileSync(f.sessionFile, line(header(f.target)) + line(user) + line(kept) + line(compaction) + "{bad json}\n" + line(assistant) + line(result));
    const value = loadWorkerSessionViewSnapshot({ ...f.target, sessionStartLine: 2, sessionEndLine: 7 });
    assert.equal(value.malformedEntries, 1);
    assert.deepEqual(value.blocks.map((block) => block.kind), ["user", "user", "compaction", "thinking", "tool", "assistant", "toolResult"]);
    assert.equal(value.blocks.some((block) => block.text.includes("old question")), true);
    const rendered = buildWorkerSessionViewerFrame(theme, { snapshot: value, topLine: 0, pinnedToEnd: false }, 100, 40).lines.join("\n");
    assert.match(rendered, /Earlier work summary|Tool call · search_many/); assert.doesNotMatch(rendered, /"type":"message"/);
  } finally { f.close(); }
});

test("worker conversation view streams a small exact range after a large inherited parent prefix", () => {
  const f = fixture();
  try {
    const inherited: string[] = [];
    for (let index = 0; index < 5_000; index += 1) inherited.push(line(message(`old-${index}`, index === 0 ? null : `old-${index - 1}`, `inherited-${index}-${"x".repeat(1024)}`)));
    const currentLine = 5_002;
    writeFileSync(f.sessionFile, line(header(f.target)) + inherited.join("") + line(message("current", "old-4999", "current worker run")));
    const value = loadWorkerSessionViewSnapshot({ ...f.target, sessionStartLine: currentLine, sessionEndLine: currentLine });
    assert.ok(Buffer.byteLength(inherited.join("")) > 4 * 1024 * 1024);
    assert.deepEqual(value.blocks.map((block) => block.text), ["current worker run"]);
  } finally { f.close(); }
});

test("large run ranges page to the opening prompt instead of refusing or cutting blocks", () => {
  const f = fixture();
  try {
    const entries: string[] = [];
    for (let index = 0; index < 700; index += 1) entries.push(line(message(`m-${index}`, index === 0 ? null : `m-${index - 1}`, `${index === 0 ? "OPENING PROMPT" : `entry-${index}`} ${"x".repeat(10_000)}`)));
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: 701 };
    const tail = loadWorkerSessionViewSnapshot(target);
    assert.ok(Buffer.byteLength(entries.join("")) > 4 * 1024 * 1024); assert.equal(tail.hasPreviousPage, true); assert.ok(tail.blocks.length > 0);
    const first = loadWorkerSessionViewSnapshot(target, {}, { mode: "first" });
    assert.equal(first.hasPreviousPage, false); assert.match(first.blocks[0]?.text ?? "", /OPENING PROMPT/);
    const next = loadWorkerSessionViewSnapshot(target, {}, { mode: "after", line: first.pageEndLine });
    assert.ok(next.pageStartLine > first.pageEndLine); assert.equal(next.blocks[0]?.label, "User");
  } finally { f.close(); }
});


test("622-entry compacted run has one global visible order in forward and backward navigation", () => {
  const f = fixture();
  try {
    const entries: string[] = [];
    for (let index = 0; index < 622; index += 1) {
      if (index === 234) entries.push(line({ type: "compaction", id: `m-${index}`, parentId: `m-${index - 1}`, timestamp: "2026-01-01T00:04:00.000Z", summary: "real-range compaction", firstKeptEntryId: "m-229", tokensBefore: 100_000 }));
      else entries.push(line(message(`m-${index}`, index === 0 ? null : `m-${index - 1}`, index === 0 ? "OPENING ASSIGNMENT" : `entry-${index}`)));
    }
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: 623 };
    const traverse = (direction: "forward" | "backward") => {
      const pages: WorkerSessionViewSnapshot[] = [];
      let page = loadWorkerSessionViewSnapshot(target, {}, direction === "forward" ? { mode: "first" } : { mode: "tail" });
      while (true) {
        pages.push(page);
        if (direction === "forward") {
          if (!page.hasNextPage) break;
          page = loadWorkerSessionViewSnapshot(target, {}, { mode: "after", line: page.pageEndLine });
        } else {
          if (!page.hasPreviousPage) break;
          page = loadWorkerSessionViewSnapshot(target, {}, { mode: "before", line: page.pageStartLine });
        }
      }
      if (direction === "backward") pages.reverse();
      return { texts: pages.flatMap((value) => value.blocks.map((block) => block.text)), pages };
    };
    const forward = traverse("forward"); const backward = traverse("backward");
    assert.deepEqual(backward.texts, forward.texts);
    assert.equal(forward.texts[0], "OPENING ASSIGNMENT");
    assert.ok(forward.texts.includes("entry-229")); assert.ok(forward.texts.includes("real-range compaction"));
    assert.equal(forward.texts.includes("entry-228"), false);
    assert.equal(forward.pages[0]!.hiddenCompactedEntries, 228); assert.equal(forward.pages[0]!.totalVisibleEntries, 394); assert.equal(forward.pages[0]!.compactionCount, 1);
    const frame = buildWorkerSessionViewerFrame(theme, { snapshot: forward.pages[0]!, topLine: 0, pinnedToEnd: false }, 120, 40).lines.join("\n");
    assert.match(frame, /228 earlier run entries are superseded by 1 compaction/);
  } finally { f.close(); }
});

test("overlapping visibility loads and close-then-reopen keep exact compaction counts", async () => {
  const makeCompacted = () => {
    const f = fixture(); const entries: string[] = [];
    for (let index = 0; index < 3_000; index += 1) {
      if (index === 1_200) entries.push(line({ type: "compaction", id: `m-${index}`, parentId: `m-${index - 1}`, timestamp: "now", summary: "concurrent compaction", firstKeptEntryId: "m-500", tokensBefore: 10 }));
      else entries.push(line(message(`m-${index}`, index === 0 ? null : `m-${index - 1}`, `${index === 0 ? "OPENING" : `entry-${index}`}-${"x".repeat(4_000)}`)));
    }
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
    return { f, target: { ...f.target, sessionStartLine: 2, sessionEndLine: 3_001 } };
  };
  const direct = makeCompacted();
  try {
    const [left, right] = await Promise.all([loadWorkerSessionViewSnapshotAsync(direct.target), loadWorkerSessionViewSnapshotAsync(direct.target)]);
    for (const value of [left, right, await loadWorkerSessionViewSnapshotAsync(direct.target)]) {
      assert.equal(value.hiddenCompactedEntries, 499); assert.equal(value.compactionCount, 1);
    }
  } finally { direct.f.close(); }

  const reopenedFixture = makeCompacted();
  try {
    let pending: Promise<WorkerSessionViewSnapshot> | undefined; let closed = false;
    const initial = snapshot(reopenedFixture.target, []);
    const component = createWorkerSessionViewerComponent({ tui: { terminal: { rows: 30 }, requestRender() {} } as never, getTheme: () => theme, initialSnapshot: initial,
      loadSnapshot: (request) => pending = loadWorkerSessionViewSnapshotAsync(reopenedFixture.target, request), done() { closed = true; } });
    component.handleInput!("r"); component.handleInput!("q"); assert.equal(closed, true); await tick();
    const reopened = await loadWorkerSessionViewSnapshotAsync(reopenedFixture.target); await pending;
    assert.equal(reopened.hiddenCompactedEntries, 499); assert.equal(reopened.compactionCount, 1);
    const again = await loadWorkerSessionViewSnapshotAsync(reopenedFixture.target);
    assert.equal(again.hiddenCompactedEntries, 499); assert.equal(again.compactionCount, 1);
  } finally { reopenedFixture.f.close(); }
});

test("oversized first-kept entries retain Pi compaction visibility", () => {
  const f = fixture();
  try {
    const entries = [line(message("opening", null, "OPENING"))];
    for (let index = 0; index < 10; index += 1) entries.push(line(message(`old-${index}`, index === 0 ? "opening" : `old-${index - 1}`, `OLD-${index}`)));
    entries.push(line(message("oversized-kept", "old-9", `KEPT-OVERSIZED-${"x".repeat(8 * 1024 * 1024 + 256)}`)));
    for (let index = 0; index < 19; index += 1) entries.push(line(message(`kept-${index}`, index === 0 ? "oversized-kept" : `kept-${index - 1}`, `KEPT-IN-CONTEXT-${index}`)));
    entries.push(line({ type: "compaction", id: "compact", parentId: "kept-18", timestamp: "now", summary: "oversized boundary", firstKeptEntryId: "oversized-kept", tokensBefore: 10 }));
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
    const value = loadWorkerSessionViewSnapshot({ ...f.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 });
    assert.equal(value.hiddenCompactedEntries, 10); assert.equal(value.compactionCount, 1);
    assert.equal(value.blocks.some((block) => block.text === "KEPT-IN-CONTEXT-0"), true);
    assert.equal(value.blocks.some((block) => block.text === "OLD-0"), false);
  } finally { f.close(); }
});

test("compaction boundaries before the run preserve all 15, 20, and 42 in-run entries in both directions", () => {
  for (const preCompactionEntries of [15, 20, 42]) {
    const f = fixture();
    try {
      const inherited = message("parent-kept", null, "inherited retained boundary");
      const run: string[] = [line(message("opening", "parent-kept", `OPEN-${preCompactionEntries}`))];
      for (let index = 0; index < preCompactionEntries; index += 1) run.push(line(message(`before-${index}`, index === 0 ? "opening" : `before-${index - 1}`, `before-${index}`)));
      run.push(line({ type: "compaction", id: "compaction", parentId: `before-${preCompactionEntries - 1}`, timestamp: "2026-01-01T00:04:00.000Z", summary: `summary-${preCompactionEntries}`, firstKeptEntryId: "parent-kept", tokensBefore: 100_000 }));
      for (let index = 0; index < 10; index += 1) run.push(line(message(`after-${index}`, index === 0 ? "compaction" : `after-${index - 1}`, `after-${index}`)));
      writeFileSync(f.sessionFile, line(header(f.target)) + line(inherited) + run.join(""));
      const target = { ...f.target, sessionStartLine: 3, sessionEndLine: 3 + run.length - 1 };
      const forward: WorkerSessionViewSnapshot[] = []; let page = loadWorkerSessionViewSnapshot(target, {}, { mode: "first" });
      while (true) { forward.push(page); if (!page.hasNextPage) break; page = loadWorkerSessionViewSnapshot(target, {}, { mode: "after", line: page.pageEndLine }); }
      const backward: WorkerSessionViewSnapshot[] = []; page = loadWorkerSessionViewSnapshot(target, {}, { mode: "tail" });
      while (true) { backward.push(page); if (!page.hasPreviousPage) break; page = loadWorkerSessionViewSnapshot(target, {}, { mode: "before", line: page.pageStartLine }); }
      backward.reverse();
      const texts = (pages: WorkerSessionViewSnapshot[]) => pages.flatMap((value) => value.blocks.map((block) => block.text));
      assert.deepEqual(texts(backward), texts(forward));
      assert.equal(forward[0]!.hiddenCompactedEntries, 0); assert.equal(forward[0]!.totalVisibleEntries, run.length);
      assert.equal(texts(forward)[0], `OPEN-${preCompactionEntries}`); assert.ok(texts(forward).includes("before-0"));
    } finally { f.close(); }
  }
});

test("byte-bounded latest pages retain exact backward continuation when the opening is separate", () => {
  const f = fixture();
  try {
    const entries: string[] = [line(message("opening", null, "OPENING-BYTE-RANGE")), line(message("hidden", "opening", "hidden")), line(message("kept", "hidden", "KEPT-BYTE-RANGE")), line({ type: "compaction", id: "compact", parentId: "kept", timestamp: "now", summary: "BYTE-COMPACTION", firstKeptEntryId: "kept", tokensBefore: 10 })];
    for (let index = 0; index < 301; index += 1) entries.push(line(message(`large-${index}`, index === 0 ? "compact" : `large-${index - 1}`, `LARGE-${String(index).padStart(3, "0")}-${"x".repeat(40 * 1024)}`)));
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 };
    const collect = (direction: "forward" | "backward") => {
      const pages: WorkerSessionViewSnapshot[] = []; let page = loadWorkerSessionViewSnapshot(target, {}, direction === "forward" ? { mode: "first" } : { mode: "tail" });
      while (true) { pages.push(page); if (direction === "forward") { if (!page.hasNextPage) break; page = loadWorkerSessionViewSnapshot(target, {}, { mode: "after", line: page.pageEndLine }); } else { if (!page.hasPreviousPage) break; page = loadWorkerSessionViewSnapshot(target, {}, { mode: "before", line: page.pageStartLine }); } }
      if (direction === "backward") pages.reverse();
      return { pages, sequence: pages.flatMap((value) => value.blocks.map((block) => block.text.slice(0, 16))) };
    };
    const tail = loadWorkerSessionViewSnapshot(target);
    assert.equal(tail.hasPreviousPage, true); assert.ok(tail.previousVisibleEntries > 0); assert.equal(tail.totalVisibleEntries, 304);
    assert.equal(tail.previousVisibleEntries + tail.totalActiveEntries + tail.nextVisibleEntries, tail.totalVisibleEntries);
    const forward = collect("forward"); const backward = collect("backward");
    assert.deepEqual(backward.sequence, forward.sequence); assert.equal(forward.sequence.length, 304); assert.equal(forward.sequence[0], "OPENING-BYTE-RAN");
    for (const page of [...forward.pages, ...backward.pages]) assert.equal(page.previousVisibleEntries + page.totalActiveEntries + page.nextVisibleEntries, page.totalVisibleEntries);
  } finally { f.close(); }
});

test("async running refreshes reuse visibility and scan only an appended suffix", async () => {
  const f = fixture();
  try {
    const entries = Array.from({ length: 1_400 }, (_, index) => line(message(`m-${index}`, index === 0 ? null : `m-${index - 1}`, `entry-${index}-${"x".repeat(12_000)}`)));
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
    const target = { ...f.target, runStatus: "running" as const, workerStatus: "running" as const, outcome: undefined, sessionStartLine: 2, sessionEndLine: undefined };
    let ticks = 0; const timer = setInterval(() => { ticks += 1; }, 1);
    const first = await loadWorkerSessionViewSnapshotAsync(target);
    clearInterval(timer); assert.ok(ticks > 0, "cold scan must yield to the event loop"); assert.equal(first.totalVisibleEntries, 1_400);
    writeFileSync(f.sessionFile, line(message("m-1400", "m-1399", "APPENDED-SUFFIX")), { flag: "a" });
    const started = performance.now(); const refreshed = await loadWorkerSessionViewSnapshotAsync(target); const elapsed = performance.now() - started;
    assert.match(refreshed.blocks.at(-1)?.text ?? "", /APPENDED-SUFFIX/); assert.equal(refreshed.totalVisibleEntries, 1_401); assert.ok(elapsed < 1_000, `incremental refresh took ${elapsed}ms`);
    for (let index = 0; index < 3; index += 1) writeFileSync(f.sessionFile, line(message(`m-${1_401 + index}`, `m-${1_400 + index}`, `SETTLEMENT-GAP-${index}`)), { flag: "a" });
    const settled = { ...target, runStatus: "settled" as const, workerStatus: "idle" as const, outcome: "completed", sessionEndLine: 1_405 };
    const promotedStarted = performance.now(); const promoted = await loadWorkerSessionViewSnapshotAsync(settled); const promotedElapsed = performance.now() - promotedStarted;
    assert.equal(promoted.totalVisibleEntries, 1_404); assert.match(promoted.blocks.at(-1)?.text ?? "", /SETTLEMENT-GAP-2/); assert.ok(promotedElapsed < 1_000, `settled promotion took ${promotedElapsed}ms`);
    for (let index = 0; index < 200; index += 1) writeFileSync(f.sessionFile, line(message(`later-${index}`, index === 0 ? "m-1403" : `later-${index - 1}`, `later run ${index}-${"y".repeat(10_000)}`)), { flag: "a" });
    const settledStarted = performance.now(); const settledRefresh = await loadWorkerSessionViewSnapshotAsync(settled); const settledElapsed = performance.now() - settledStarted;
    assert.equal(settledRefresh.totalVisibleEntries, 1_404); assert.ok(settledElapsed < 1_000, `settled refresh after later appends took ${settledElapsed}ms`);
  } finally { f.close(); }
});

test("running and settled half-written tails stay live and running refresh completes them", async () => {
  const f = fixture();
  try {
    const complete = line(message("complete", null, "COMPLETE"));
    const trailing = JSON.stringify(message("partial", "complete", "PARTIAL-COMPLETED"));
    const split = trailing.length - 17;
    writeFileSync(f.sessionFile, line(header(f.target)) + complete + trailing.slice(0, split));
    const running = { ...f.target, runStatus: "running" as const, workerStatus: "running" as const, outcome: undefined, sessionStartLine: 2, sessionEndLine: undefined };
    const settled = { ...running, runStatus: "settled" as const, workerStatus: "idle" as const, outcome: "failed", sessionEndLine: 3 };
    assertHalfWriteChildLiveness(running); assertHalfWriteChildLiveness(settled);
    let timerTicks = 0; const timer = setInterval(() => { timerTicks += 1; }, 1);
    const first = await watchdog(loadWorkerSessionViewSnapshotAsync(running));
    clearInterval(timer);
    assert.ok(timerTicks > 0, "partial-tail analysis must yield to timers"); assert.equal(first.incompleteTrailingEntry, true); assert.deepEqual(first.blocks.map((block) => block.text), ["COMPLETE"]);
    const repeatedStarted = performance.now(); const repeated = await watchdog(loadWorkerSessionViewSnapshotAsync(running));
    assert.equal(repeated.incompleteTrailingEntry, true); assert.ok(performance.now() - repeatedStarted < 500, "unchanged partial tail should use its bounded marker");

    const fixed = await watchdog(loadWorkerSessionViewSnapshotAsync(settled));
    assert.equal(fixed.incompleteTrailingEntry, true); assert.deepEqual(fixed.blocks.map((block) => block.text), ["COMPLETE"]);

    writeFileSync(f.sessionFile, `${trailing.slice(split)}\n`, { flag: "a" });
    const completed = await watchdog(loadWorkerSessionViewSnapshotAsync(running));
    assert.equal(completed.incompleteTrailingEntry, false); assert.equal(completed.blocks.some((block) => block.text === "PARTIAL-COMPLETED"), true);
    const fixedAgain = await watchdog(loadWorkerSessionViewSnapshotAsync(settled));
    assert.equal(fixedAgain.incompleteTrailingEntry, true, "settled snapshots retain the recorded half-write decision"); assert.deepEqual(fixedAgain.blocks.map((block) => block.text), ["COMPLETE"]);
  } finally { f.close(); }
});

test("viewer refresh remains responsive while a session entry is half-written", async () => {
  const f = fixture(); const guard = fixture();
  try {
    writeFileSync(f.sessionFile, line(header(f.target)) + line(message("complete", null, "COMPLETE")));
    const target = { ...f.target, runStatus: "running" as const, workerStatus: "running" as const, outcome: undefined, sessionStartLine: 2, sessionEndLine: undefined };
    const trailing = JSON.stringify(message("partial", "complete", "VIEWER-PARTIAL")); const split = trailing.length - 9;
    writeFileSync(guard.sessionFile, line(header(guard.target)) + line(message("complete", null, "COMPLETE")));
    assertViewerHalfWriteChildLiveness({ ...target, sessionFile: guard.sessionFile, sessionRoot: guard.sessionRoot, workspaceRoot: guard.target.workspaceRoot, parentSessionFile: guard.target.parentSessionFile }, trailing.slice(0, split));
    const initial = loadWorkerSessionViewSnapshot(target);
    writeFileSync(f.sessionFile, trailing.slice(0, split), { flag: "a" });
    let pending: Promise<WorkerSessionViewSnapshot> | undefined; let renders = 0;
    const component = createWorkerSessionViewerComponent({ tui: { terminal: { rows: 30 }, requestRender() { renders += 1; } } as never, getTheme: () => theme, initialSnapshot: initial,
      loadSnapshot: (request) => pending = loadWorkerSessionViewSnapshotAsync(target, request), done() {} });
    let heartbeats = 0; const heartbeat = setInterval(() => { heartbeats += 1; }, 1);
    component.handleInput!("r"); await tick(); await watchdog(pending!); await tick(); clearInterval(heartbeat);
    assert.ok(heartbeats > 0); assert.ok(renders >= 2); assert.match(component.render(100).join("\n"), /final unterminated session entry/);

    writeFileSync(f.sessionFile, `${trailing.slice(split)}\n`, { flag: "a" }); pending = undefined; component.handleInput!("r"); await tick(); await watchdog(pending!); await tick();
    assert.match(component.render(100).join("\n"), /VIEWER-PARTIAL/);
  } finally { f.close(); guard.close(); }
});

test("running view accepts repeated append-only growth and incrementally indexes it", () => {
  const f = fixture();
  try {
    const initial: string[] = [];
    for (let index = 0; index < 1_200; index += 1) initial.push(line(message(`m-${index}`, index === 0 ? null : `m-${index - 1}`, `initial-${index}-${"x".repeat(1500)}`)));
    writeFileSync(f.sessionFile, line(header(f.target)) + initial.join(""));
    const target = { ...f.target, runStatus: "running" as const, workerStatus: "running" as const, outcome: undefined, sessionStartLine: 2, sessionEndLine: undefined };
    let appended = 0;
    const first = loadWorkerSessionViewSnapshot(target, { afterChunkRead(file) { if (appended >= 5) return; const index = 1200 + appended; writeFileSync(file, line(message(`m-${index}`, `m-${index - 1}`, `append-${index}`)), { flag: "a" }); appended += 1; } });
    assert.equal(appended, 2, "multiple one-megabyte chunks allow multiple concurrent appends"); assert.equal(first.target.runStatus, "running");
    const refreshed = loadWorkerSessionViewSnapshot(target);
    assert.match(refreshed.blocks.at(-1)?.text ?? "", /append-1201/);
  } finally { f.close(); }
});

test("worker conversation view rejects symlink, FIFO, replacement, invalid UTF-8, duplicate ids, and cycles", () => {
  const f = fixture();
  try {
    const real = path.join(f.sessionRoot, "real.jsonl"); writeFileSync(real, line(header(f.target))); symlinkSync(real, f.sessionFile);
    assert.throws(() => loadWorkerSessionViewSnapshot(f.target), /symbolic link/);
    rmSync(f.sessionFile); writeFileSync(f.sessionFile, Buffer.concat([Buffer.from(line(header(f.target))), Buffer.from([0xff, 0x0a])]));
    assert.throws(() => loadWorkerSessionViewSnapshot(f.target), /not valid UTF-8/);
    writeFileSync(f.sessionFile, line(header(f.target)) + line(message("same", null, "one")) + line(message("same", "same", "two")));
    assert.throws(() => loadWorkerSessionViewSnapshot({ ...f.target, sessionEndLine: 3 }), /duplicate entry ids/);
    writeFileSync(f.sessionFile, line(header(f.target)) + line(message("a", "b", "one")) + line(message("b", "a", "two")));
    assert.throws(() => loadWorkerSessionViewSnapshot({ ...f.target, sessionEndLine: 3 }), /cycle/);
    writeFileSync(f.sessionFile, line(header(f.target)) + line(message("one", null, "one")));
    let swapped = false;
    assert.throws(() => loadWorkerSessionViewSnapshot(f.target, { beforeOpen(file) { if (!swapped) { swapped = true; rmSync(file); execFileSync("mkfifo", [file]); } } }), /regular file/);
    rmSync(f.sessionFile, { force: true }); writeFileSync(f.sessionFile, line(header(f.target)) + line(message("one", null, "one")));
    assert.throws(() => loadWorkerSessionViewSnapshot(f.target, { afterReadAttempt(file) { const next = `${file}.next`; writeFileSync(next, line(header(f.target)) + line(message("other", null, "other"))); renameSync(next, file); } }), /changed while reading/);
  } finally { f.close(); }
});

test("real forked sessions under symlinked roots and split state/workspace roots validate", () => {
  const realRoot = mkdtempSync(path.join(tmpdir(), "worker-view-fork-real-")); const alias = `${realRoot}-alias`; symlinkSync(realRoot, alias, "dir");
  try {
    const parentDir = path.join(realRoot, "parent"); mkdirSync(parentDir); const manager = SessionManager.create(realRoot, parentDir, { id: "parent-session" }); const parentFile = manager.getSessionFile()!; writeFileSync(parentFile, `${JSON.stringify(manager.getHeader())}\n`);
    const workspace = path.join(alias, "workspaces", "worker"); const sessionRoot = path.join(alias, "state", "worker", "session"); mkdirSync(workspace, { recursive: true });
    const fork = forkWorkerSession({ parentSessionFile: parentFile, workspaceRoot: workspace, sessionDir: sessionRoot, sessionId: "forked-session" });
    const start = countSessionLines(fork.sessionFile) + 1; writeFileSync(fork.sessionFile, line(message("current", null, "fork portable")), { flag: "a" });
    const target: WorkerSessionViewTarget = { workerId: "worker_20260101000000_forkedaa", role: "work", workerStatus: "idle", runId: "run_20260101000000_forkedbb", runStatus: "settled", outcome: "completed", sessionId: fork.sessionId, sessionFile: fork.sessionFile, sessionRoot, workspaceRoot: workspace, parentSessionFile: fork.parentSessionFile, sessionStartLine: start, sessionEndLine: start };
    assert.deepEqual(loadWorkerSessionViewSnapshot(target).blocks.map((block) => block.text), ["fork portable"]);

    const split = fixture({ root: path.join(realRoot, "split"), splitRoots: true });
    writeFileSync(split.sessionFile, line(header(split.target)) + line(message("split", null, "split roots")));
    assert.deepEqual(loadWorkerSessionViewSnapshot(split.target).blocks.map((block) => block.text), ["split roots"]);
  } finally { rmSync(alias, { force: true }); rmSync(realRoot, { recursive: true, force: true }); }
});

test("hostile headers and provider records are sanitized without raw message fallback", async () => {
  const f = fixture();
  try {
    const hostile = "\u001b]52;c;Y2xpcGJvYXJk\u0007/net/host\u001b[2J";
    writeFileSync(f.sessionFile, line(header(f.target, { cwd: hostile })) + line(message("one", null, "one")));
    assert.throws(() => loadWorkerSessionViewSnapshot(f.target), /workspace mismatch/);
    writeFileSync(f.sessionFile, line(header(f.target, { version: hostile })) + line(message("one", null, "one")));
    const notifications: string[] = []; const context = { hasUI: true, mode: "tui", ui: { notify(value: string) { notifications.push(value); } } } as unknown as ExtensionCommandContext;
    await openWorkerSessionViewer(context, f.target); assert.deepEqual(notifications, ["Worker session header is invalid."]);

    const failed = { type: "message", id: "failed", parentId: null, timestamp: "now", message: { role: "assistant", provider: "evil\u001b[31m", content: [], stopReason: "error", errorMessage: "failed\r\nnext" } };
    const bash = { type: "message", id: "bash", parentId: "failed", timestamp: "now", message: { role: "bashExecution", command: "echo ok", secretRawField: "DO_NOT_DUMP" } };
    writeFileSync(f.sessionFile, line(header(f.target)) + line(failed) + line(bash));
    const value = loadWorkerSessionViewSnapshot({ ...f.target, sessionEndLine: 3 }); const rendered = buildWorkerSessionViewerFrame(theme, { snapshot: value, topLine: 0, pinnedToEnd: false }, 100, 40).lines.join("\n");
    assert.match(rendered, /Bash execution/); assert.doesNotMatch(rendered, /DO_NOT_DUMP|\u001b|�\nnext/);
  } finally { f.close(); }
});

test("transcript pages keep every bounded block reachable and refresh theme-derived body rendering", async () => {
  const f = fixture();
  try {
    const blocks = Array.from({ length: 272 }, (_, index) => ({ kind: "assistant" as const, label: `BLOCK-${index}`, timestamp: "now", text: `content-${index}\n${"x".repeat(2000)}` }));
    const value = snapshot(f.target, blocks);
    const state: WorkerSessionViewerState = { snapshot: value, topLine: 0, pinnedToEnd: false };
    assert.match(buildWorkerSessionViewerFrame(theme, state, 80, 30).lines.join("\n"), /BLOCK-0/);
    const cache = (state as WorkerSessionViewerState & { wrappedBodyCache: { blockStarts: number[] } }).wrappedBodyCache;
    state.topLine = cache.blockStarts.at(-1)!;
    assert.match(buildWorkerSessionViewerFrame(theme, state, 80, 30).lines.join("\n"), /BLOCK-271/);

    let prefix = "A:"; const dynamicTheme = { fg: (_color: string, text: string) => `${prefix}${text}`, bold: (text: string) => text } as Theme;
    let renders = 0; const firstPage = snapshot(f.target, [{ kind: "user", label: "OPEN", timestamp: "now", text: "opening" }]);
    const tailPage = snapshot(f.target, [{ kind: "assistant", label: "TAIL", timestamp: "now", text: "tail" }], { pageStartLine: 514, pageEndLine: 600, runEndLine: 600, hasPreviousPage: true });
    let request: WorkerSessionPageRequest | undefined;
    const component = createWorkerSessionViewerComponent({ tui: { terminal: { rows: 30 }, requestRender() { renders += 1; } } as never, getTheme: () => dynamicTheme, initialSnapshot: tailPage, loadSnapshot: (next) => { request = next; return firstPage; }, done() {} });
    assert.match(component.render(80).join("\n"), /A:TAIL/); prefix = "B:"; component.invalidate(); assert.match(component.render(80).join("\n"), /B:TAIL/);
    component.handleInput!("g"); assert.equal(request, undefined, "page scan is deferred out of the key handler"); await tick(); assert.deepEqual(request, { mode: "first" }); assert.ok(renders >= 2); assert.match(component.render(80).join("\n"), /OPEN/);
  } finally { f.close(); }
});


test("adversarial page wrapping has a fixed aggregate budget while keeping every block reachable", () => {
  const f = fixture();
  try {
    const blocks = Array.from({ length: 1_536 }, (_, index) => ({ kind: index % 3 === 0 ? "tool" as const : index % 3 === 1 ? "thinking" as const : "assistant" as const, label: `ADVERSARIAL-${index}`, timestamp: "now", text: `${"z".repeat(7_000)}\n${"y".repeat(5_000)}\n${"x".repeat(5_000)}` }));
    const state: WorkerSessionViewerState = { snapshot: snapshot(f.target, blocks), topLine: 0, pinnedToEnd: false };
    const started = performance.now(); buildWorkerSessionViewerFrame(theme, state, 240, 40); const elapsed = performance.now() - started;
    const cache = state.wrappedBodyCache!;
    assert.equal(cache.blockStarts.length, 1_536); assert.ok(cache.lines.length < 20_000); assert.ok(elapsed < 2_000, `bounded wrap took ${elapsed}ms`);
  } finally { f.close(); }
});

test("settled runs with no written entries render an empty transcript", () => {
  const f = fixture();
  try {
    writeFileSync(f.sessionFile, line(header(f.target)));
    const value = loadWorkerSessionViewSnapshot({ ...f.target, sessionStartLine: 2, sessionEndLine: 1 });
    assert.deepEqual(value.blocks, []); assert.equal(value.totalVisibleEntries, 0); assert.equal(value.runStartLine, 2); assert.equal(value.runEndLine, 1);
    assert.match(buildWorkerSessionViewerFrame(theme, { snapshot: value, topLine: 0, pinnedToEnd: false }, 100, 30).lines.join("\n"), /No renderable messages/);
  } finally { f.close(); }
});

test("rendered-block pages are hard-bounded and bidirectionally reachable within one entry", () => {
  const f = fixture();
  try {
    const content = Array.from({ length: 10_000 }, (_, index) => ({ type: "text", text: `PART-${index}` }));
    const assistant = { type: "message", id: "assistant", parentId: null, timestamp: "now", message: { role: "assistant", content } };
    writeFileSync(f.sessionFile, line(header(f.target)) + line(assistant));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: 2 };
    const collect = (direction: "forward" | "backward") => {
      const pages: WorkerSessionViewSnapshot[] = []; let page = loadWorkerSessionViewSnapshot(target, {}, direction === "forward" ? { mode: "first" } : { mode: "tail" });
      while (true) {
        pages.push(page); assert.ok(page.blocks.length <= 2_048);
        if (direction === "forward") { if (!page.hasNextPage) break; page = loadWorkerSessionViewSnapshot(target, {}, { mode: "after", line: page.pageEndLine, block: page.pageEndBlock }); }
        else { if (!page.hasPreviousPage) break; page = loadWorkerSessionViewSnapshot(target, {}, { mode: "before", line: page.pageStartLine, block: page.pageStartBlock }); }
      }
      if (direction === "backward") pages.reverse();
      return { pages, texts: pages.flatMap((value) => value.blocks.map((block) => block.text)) };
    };
    const forward = collect("forward"); const backward = collect("backward");
    assert.deepEqual(backward.texts, forward.texts); assert.equal(forward.texts.length, 10_000); assert.equal(forward.texts[0], "PART-0"); assert.equal(forward.texts.at(-1), "PART-9999");
    assert.equal(forward.pages[0]!.nextVisibleEntries, 0); assert.equal(forward.pages[0]!.hasNextPage, true);
    assert.equal(forward.pages[0]!.previousVisibleEntries + forward.pages[0]!.totalActiveEntries + forward.pages[0]!.nextVisibleEntries, forward.pages[0]!.totalVisibleEntries);
    const frame = buildWorkerSessionViewerFrame(theme, { snapshot: forward.pages[0]!, topLine: 0, pinnedToEnd: false }, 100, 30).lines.join("\n");
    assert.match(frame, /Later rendered blocks from this run entry/);
  } finally { f.close(); }
});

test("production-shaped 310,000-block transcripts keep load and frames bounded", () => {
  const f = fixture();
  try {
    const content = Array.from({ length: 2_000 }, () => "x");
    const entries = Array.from({ length: 155 }, (_, index) => line({ type: "message", id: `many-${index}`, parentId: index === 0 ? null : `many-${index - 1}`, timestamp: "now", message: { role: "assistant", content } }));
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: 156 };
    const started = performance.now(); const first = loadWorkerSessionViewSnapshot(target, {}, { mode: "first" }); const loadElapsed = performance.now() - started;
    assert.equal(first.blocks.length, 2_048); assert.equal(first.hasNextPage, true); assert.equal(first.previousVisibleEntries + first.totalActiveEntries + first.nextVisibleEntries, first.totalVisibleEntries); assert.ok(loadElapsed < 2_000, `310,000-block first page took ${loadElapsed}ms`);
    const frameStarted = performance.now(); buildWorkerSessionViewerFrame(theme, { snapshot: first, topLine: 0, pinnedToEnd: false }, 120, 40); const frameElapsed = performance.now() - frameStarted;
    assert.ok(frameElapsed < 1_000, `2,048-block frame took ${frameElapsed}ms`);
    const second = loadWorkerSessionViewSnapshot(target, {}, { mode: "after", line: first.pageEndLine, block: first.pageEndBlock });
    assert.equal(second.blocks.length, 2_048); assert.equal(second.hasPreviousPage, true); assert.equal(second.hasNextPage, true); assert.equal(second.previousVisibleEntries + second.totalActiveEntries + second.nextVisibleEntries, second.totalVisibleEntries);
  } finally { f.close(); }
});

test("byte-bounded cursor pages make monotonic progress across adjacent multi-MiB entries", () => {
  const shapes = [[5, 5], [4, 5], [5, 5, 5], [3, 3, 3], [9, 1], [1, 9]];
  for (const [shapeIndex, sizes] of shapes.entries()) {
    const f = fixture();
    try {
      const entries = [line(message("opening", null, `OPENING-${shapeIndex}`))];
      for (const [index, size] of sizes!.entries()) entries.push(line(message(`big-${index}`, index === 0 ? "opening" : `big-${index - 1}`, `BIG-${index}-${"x".repeat(size * 1024 * 1024)}`)));
      entries.push(line(message("last", `big-${sizes!.length - 1}`, `LAST-${shapeIndex}`)));
      writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
      const target = { ...f.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 };
      const traverse = (direction: "forward" | "backward") => {
        const pages: WorkerSessionViewSnapshot[] = []; const cursors = new Set<string>(); let previousCursor: [number, number] | undefined;
        let page = loadWorkerSessionViewSnapshot(target, {}, direction === "forward" ? { mode: "first" } : { mode: "tail" });
        for (let step = 0; step < 32; step += 1) {
          assert.ok(page.blocks.length > 0, `${sizes} ${direction} produced an empty page`); assert.equal(page.previousVisibleEntries + page.totalActiveEntries + page.nextVisibleEntries, page.totalVisibleEntries); pages.push(page);
          const cursorValue: [number, number] = direction === "forward" ? [page.pageEndLine, page.pageEndBlock ?? 0] : [page.pageStartLine, page.pageStartBlock ?? 0];
          const cursor = `${cursorValue[0]}:${cursorValue[1]}`;
          assert.equal(cursors.has(cursor), false, `${sizes} ${direction} repeated cursor ${cursor}`); cursors.add(cursor);
          if (previousCursor) {
            const comparison = cursorValue[0] === previousCursor[0] ? cursorValue[1] - previousCursor[1] : cursorValue[0] - previousCursor[0];
            assert.ok(direction === "forward" ? comparison > 0 : comparison < 0, `${sizes} ${direction} cursor was not monotonic`);
          }
          previousCursor = cursorValue;
          if (direction === "forward") {
            if (!page.hasNextPage) break;
            page = loadWorkerSessionViewSnapshot(target, {}, { mode: "after", line: page.pageEndLine, block: page.pageEndBlock });
          } else {
            if (!page.hasPreviousPage) break;
            page = loadWorkerSessionViewSnapshot(target, {}, { mode: "before", line: page.pageStartLine, block: page.pageStartBlock });
          }
          if (step === 31) assert.fail(`${sizes} ${direction} traversal did not terminate`);
        }
        if (direction === "backward") pages.reverse();
        return pages.flatMap((value) => value.blocks.map((block) => block.text));
      };
      const expected = [`OPENING-${shapeIndex}`, ...sizes!.flatMap((size, index) => size > 8 ? [] : [`BIG-${index}-`]), `LAST-${shapeIndex}`];
      const normalize = (values: string[]) => values.map((value) => value.startsWith("BIG-") ? value.slice(0, 6) : value);
      assert.deepEqual(normalize(traverse("forward")), expected); assert.deepEqual(normalize(traverse("backward")), expected);
    } finally { f.close(); }
  }
});

test("earlier and later counts exclude non-rendering custom entries at run edges", () => {
  const f = fixture();
  try {
    const hiddenStart = { type: "custom", id: "hidden-start", parentId: null, timestamp: "now", data: "hidden" };
    const shown = message("shown", "hidden-start", "ONLY-DISPLAYED");
    const hiddenEnd = { type: "custom_message", id: "hidden-end", parentId: "shown", timestamp: "now", customType: "manual-provider-retry", display: false, content: "hidden" };
    writeFileSync(f.sessionFile, line(header(f.target)) + line(hiddenStart) + line(shown) + line(hiddenEnd));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: 4 };
    for (const request of [{ mode: "first" as const }, { mode: "tail" as const }]) {
      const value = loadWorkerSessionViewSnapshot(target, {}, request);
      assert.deepEqual(value.blocks.map((block) => block.text), ["ONLY-DISPLAYED"]); assert.equal(value.totalVisibleEntries, 1);
      assert.equal(value.previousVisibleEntries, 0); assert.equal(value.nextVisibleEntries, 0); assert.equal(value.hasPreviousPage, false); assert.equal(value.hasNextPage, false);
      const frame = buildWorkerSessionViewerFrame(theme, { snapshot: value, topLine: 0, pinnedToEnd: false }, 100, 30).lines.join("\n");
      assert.doesNotMatch(frame, /earlier visible|later visible/);
    }
  } finally { f.close(); }
});

test("line index invalidates an in-place growing rewrite and checkpoints oversized lines", () => {
  const f = fixture();
  try {
    const initial = line(header(f.target)) + line(message("old-1", null, "old one")) + line(message("old-2", "old-1", "old two")) + line(message("old-3", "old-2", "old three"));
    writeFileSync(f.sessionFile, initial);
    assert.equal(countSessionLines(f.sessionFile), 4);
    const rewritten = line(header(f.target)) + Array.from({ length: 6 }, (_, index) => line(message(`new-${index}`, index === 0 ? null : `new-${index - 1}`, `new ${index}`))).join("");
    writeFileSync(f.sessionFile, rewritten);
    assert.equal(countSessionLines(f.sessionFile), 7);

    const huge = `${line(header(f.target))}${JSON.stringify(message("huge", null, "x"))}`;
    writeFileSync(f.sessionFile, huge);
    const fd = openSync(f.sessionFile, "r+");
    try { ftruncateSync(fd, 9 * 1024 * 1024); writeSync(fd, Buffer.from(`\n${line(message("after", "huge", "after oversized"))}`), undefined, undefined, 9 * 1024 * 1024); }
    finally { closeSync(fd); }
    const lineCount = countSessionLines(f.sessionFile);
    const target = { ...f.target, sessionStartLine: lineCount, sessionEndLine: lineCount };
    assert.deepEqual(loadWorkerSessionViewSnapshot(target).blocks.map((block) => block.text), ["after oversized"]);
    assert.deepEqual(loadWorkerSessionViewSnapshot(target).blocks.map((block) => block.text), ["after oversized"]);
  } finally { f.close(); }
});

test("streaming line count handles sparse sessions beyond Node's maximum string length", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lines-large-")); const file = path.join(root, "large.jsonl"); const size = 513 * 1024 * 1024;
  const fd = openSync(file, "w+");
  try { ftruncateSync(fd, size); writeSync(fd, Buffer.from("\n"), 0, 1, size - 1); }
  finally { closeSync(fd); }
  try { assert.equal(countSessionLines(file), 1); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("worker conversation rendering strips terminal and bidi controls", () => {
  assert.equal(sanitizeViewText("safe\u001b[31mred\u202eevil\u0007"), "safered�evil�");
  assert.equal(sanitizeViewText("one\r\ntwo\r"), "one\ntwo");
});
