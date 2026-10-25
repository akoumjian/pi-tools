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
function assertRunningIndexIsolationChild(target: WorkerSessionViewTarget, mode: "settlement" | "sync" | "concurrent"): void {
  const moduleUrl = new URL("../extensions/worker/view.js", import.meta.url).href;
  const script = `import { appendFileSync } from "node:fs"; import { countSessionLines, loadWorkerSessionViewSnapshot, loadWorkerSessionViewSnapshotAsync } from ${JSON.stringify(moduleUrl)}; const target = JSON.parse(process.argv[1]); const mode = process.argv[2]; const final = JSON.stringify({ type: "message", id: "final", parentId: "seed-349", timestamp: "now", message: { role: "user", content: "FINAL ANSWER" } }) + "\\n"; let triggered = false; let end; let syncValue; let second; let heartbeats = 0; const timer = setInterval(() => { heartbeats += 1; }, 1); const dependencies = { afterChunkRead() { if (triggered) return; triggered = true; appendFileSync(target.sessionFile, final); if (mode === "settlement") end = countSessionLines(target.sessionFile); if (mode === "sync") syncValue = loadWorkerSessionViewSnapshot(target); if (mode === "concurrent") second = loadWorkerSessionViewSnapshotAsync(target); } }; const first = await loadWorkerSessionViewSnapshotAsync(target, { mode: "tail" }, dependencies); if (!triggered || first.totalVisibleEntries !== 350 || first.blocks.some((block) => block.text === "FINAL ANSWER")) throw new Error("small snapshot was not isolated"); if (mode === "settlement") { const settled = await loadWorkerSessionViewSnapshotAsync({ ...target, runStatus: "settled", workerStatus: "idle", outcome: "completed", sessionEndLine: end }); if (settled.totalVisibleEntries !== 351 || !settled.blocks.some((block) => block.text === "FINAL ANSWER")) throw new Error("settled snapshot lost final entry"); } if (mode === "sync" && (syncValue?.totalVisibleEntries !== 351 || !syncValue.blocks.some((block) => block.text === "FINAL ANSWER"))) throw new Error("sync overlap was not exact"); if (mode === "concurrent") { const larger = await second; if (larger.totalVisibleEntries !== 351 || !larger.blocks.some((block) => block.text === "FINAL ANSWER")) throw new Error("larger async snapshot was not exact"); } clearInterval(timer); if (heartbeats < 1) throw new Error("async index did not yield");`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(target), mode], { timeout: 8_000, stdio: "pipe" });
}

function assertViewerSettlementIndexIsolationChild(target: WorkerSessionViewTarget): void {
  const moduleUrl = new URL("../extensions/worker/view.js", import.meta.url).href;
  const script = `import { appendFileSync } from "node:fs"; import { countSessionLines, createWorkerSessionViewerComponent, loadWorkerSessionViewSnapshot, loadWorkerSessionViewSnapshotAsync } from ${JSON.stringify(moduleUrl)}; let target = JSON.parse(process.argv[1]); const make = (id, parentId, content) => JSON.stringify({ type: "message", id, parentId, timestamp: "now", message: { role: "user", content } }) + "\\n"; const initial = loadWorkerSessionViewSnapshot(target); let growth = ""; for (let index = 0; index < 350; index += 1) growth += make("growth-" + index, index === 0 ? "base" : "growth-" + (index - 1), "GROWTH-" + index + "-" + "x".repeat(7000)); appendFileSync(target.sessionFile, growth); let triggered = false; let pending; let heartbeats = 0; const timer = setInterval(() => { heartbeats += 1; }, 1); const dependencies = { afterChunkRead() { if (triggered) return; triggered = true; appendFileSync(target.sessionFile, make("final", "growth-349", "FINAL ANSWER")); const end = countSessionLines(target.sessionFile); target = { ...target, runStatus: "settled", workerStatus: "idle", outcome: "completed", sessionEndLine: end }; } }; const theme = { fg: (_color, text) => text, bold: (text) => text }; const component = createWorkerSessionViewerComponent({ tui: { terminal: { rows: 30 }, requestRender() {} }, getTheme: () => theme, initialSnapshot: initial, loadSnapshot: (request) => pending = loadWorkerSessionViewSnapshotAsync(target, request, dependencies), done() {} }); component.handleInput("r"); await new Promise((resolve) => setImmediate(resolve)); await pending; await new Promise((resolve) => setImmediate(resolve)); const firstFrame = component.render(100).join("\\n"); if (firstFrame.includes("Loading transcript page")) throw new Error("first refresh stayed loading"); component.handleInput("r"); await new Promise((resolve) => setImmediate(resolve)); await pending; await new Promise((resolve) => setImmediate(resolve)); const secondFrame = component.render(100).join("\\n"); if (!secondFrame.includes("FINAL ANSWER") || secondFrame.includes("Loading transcript page")) throw new Error("second refresh did not show settled final entry"); const reopened = loadWorkerSessionViewSnapshot(target); if (!reopened.blocks.some((block) => block.text === "FINAL ANSWER")) throw new Error("reopen lost final entry"); clearInterval(timer); if (heartbeats < 1) throw new Error("viewer refresh did not yield"); component.handleInput("q");`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(target)], { timeout: 8_000, stdio: "pipe" });
}

function assertAlternatingOversizedReadBound(target: WorkerSessionViewTarget, maximumBytes: number): void {
  const moduleUrl = new URL("../extensions/worker/view.js", import.meta.url).href;
  const script = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const original = fs.readSync; let bytes = 0; fs.readSync = function(...args) { const count = original.apply(this, args); bytes += count; return count; }; syncBuiltinESMExports(); const view = await import(${JSON.stringify(moduleUrl)}); const target = JSON.parse(process.argv[1]); let page = view.loadWorkerSessionViewSnapshot(target); bytes = 0; let blocks = page.blocks.length; while (page.hasPreviousPage) { page = view.loadWorkerSessionViewSnapshot(target, {}, { mode: "before", line: page.pageStartLine, ...(page.hasPreviousBlocksInEntry ? { block: page.pageStartBlock } : {}) }); blocks += page.blocks.length; } if (blocks !== 8) throw new Error("alternating traversal lost displayable entries: " + blocks); if (bytes > Number(process.argv[2])) throw new Error("alternating traversal reread " + bytes + " bytes");`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(target), String(maximumBytes)], { timeout: 8_000, stdio: "pipe" });
}

function assertLargeCheckpointTraversal(target: WorkerSessionViewTarget, expectedEntries: number): void {
  const moduleUrl = new URL("../extensions/worker/view.js", import.meta.url).href;
  const script = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; import { performance } from "node:perf_hooks"; const original = fs.readSync; let bytes = 0; fs.readSync = function(...args) { const count = original.apply(this, args); bytes += count; return count; }; syncBuiltinESMExports(); const view = await import(${JSON.stringify(moduleUrl)}); const target = JSON.parse(process.argv[1]); const expected = Number(process.argv[2]); await view.loadWorkerSessionViewSnapshotAsync(target); let maximumBytes = 0; let maximumMilliseconds = 0; const observe = (started) => { maximumBytes = Math.max(maximumBytes, bytes); maximumMilliseconds = Math.max(maximumMilliseconds, performance.now() - started); }; const traverseSync = (direction) => { let request = direction === "forward" ? { mode: "first" } : { mode: "tail" }; let total = 0; let prior; for (let step = 0; step < expected / 400 + 20; step += 1) { bytes = 0; const started = performance.now(); const page = view.loadWorkerSessionViewSnapshot(target, {}, request); observe(started); if (page.blocks.length === 0 || page.totalVisibleEntries !== expected || page.previousVisibleEntries + page.totalActiveEntries + page.nextVisibleEntries !== expected) throw new Error("invalid sync page"); const cursor = direction === "forward" ? page.pageEndLine : page.pageStartLine; if (prior !== undefined && (direction === "forward" ? cursor <= prior : cursor >= prior)) throw new Error("non-monotonic sync cursor"); prior = cursor; total += page.blocks.length; if (direction === "forward" ? !page.hasNextPage : !page.hasPreviousPage) break; request = direction === "forward" ? { mode: "after", line: page.pageEndLine, ...(page.hasNextBlocksInEntry ? { block: page.pageEndBlock } : {}) } : { mode: "before", line: page.pageStartLine, ...(page.hasPreviousBlocksInEntry ? { block: page.pageStartBlock } : {}) }; } if (total !== expected) throw new Error("sync traversal count " + total); }; traverseSync("forward"); let ticks = 0; let maximumStall = 0; let lastTick = performance.now(); const timer = setInterval(() => { const now = performance.now(); maximumStall = Math.max(maximumStall, now - lastTick); lastTick = now; ticks += 1; }, 1); const traverseAsync = async (direction) => { let request = direction === "forward" ? { mode: "first" } : { mode: "tail" }; let total = 0; let prior; for (let step = 0; step < expected / 400 + 20; step += 1) { bytes = 0; const started = performance.now(); const page = await view.loadWorkerSessionViewSnapshotAsync(target, request); observe(started); if (page.blocks.length === 0 || page.totalVisibleEntries !== expected || page.previousVisibleEntries + page.totalActiveEntries + page.nextVisibleEntries !== expected) throw new Error("invalid async page"); const cursor = direction === "forward" ? page.pageEndLine : page.pageStartLine; if (prior !== undefined && (direction === "forward" ? cursor <= prior : cursor >= prior)) throw new Error("non-monotonic async cursor"); prior = cursor; total += page.blocks.length; if (direction === "forward" ? !page.hasNextPage : !page.hasPreviousPage) break; request = direction === "forward" ? { mode: "after", line: page.pageEndLine, ...(page.hasNextBlocksInEntry ? { block: page.pageEndBlock } : {}) } : { mode: "before", line: page.pageStartLine, ...(page.hasPreviousBlocksInEntry ? { block: page.pageStartBlock } : {}) }; } if (total !== expected) throw new Error("async traversal count " + total); }; await traverseAsync("backward"); clearInterval(timer); if (maximumBytes > 8 * 1024 * 1024) throw new Error("deep page reread " + maximumBytes + " bytes"); if (maximumMilliseconds > 2000) throw new Error("deep page took " + maximumMilliseconds + "ms"); if (ticks < 2 || maximumStall > 1000) throw new Error("event loop stall " + maximumStall + "ms ticks=" + ticks);`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(target), String(expectedEntries)], { timeout: 90_000, stdio: "pipe" });
}


function assertDeepCheckpointSamples(target: WorkerSessionViewTarget, expectedEntries: number, payloadBytes: number): void {
  const moduleUrl = new URL("../extensions/worker/view.js", import.meta.url).href;
  const script = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; import { performance } from "node:perf_hooks"; const original = fs.readSync; let bytes = 0; fs.readSync = function(...args) { const count = original.apply(this, args); bytes += count; return count; }; syncBuiltinESMExports(); const view = await import(${JSON.stringify(moduleUrl)}); const target = JSON.parse(process.argv[1]); const expected = Number(process.argv[2]); const payloadBytes = Number(process.argv[3]); await view.loadWorkerSessionViewSnapshotAsync(target); const positions = [0.05, 0.2, 0.4, 0.6, 0.8].map((ratio) => Math.floor(expected * ratio)); const requests = [{ request: { mode: "first" }, first: 0 }]; for (const before of positions) { requests.push({ request: { mode: "after", line: before + 1 }, first: before }); requests.push({ request: { mode: "before", line: before + 2 }, last: before - 1 }); } let maximumBytes = 0; let maximumMilliseconds = 0; let maximumStall = 0; let ticks = 0; let lastTick = performance.now(); const timer = setInterval(() => { const now = performance.now(); maximumStall = Math.max(maximumStall, now - lastTick); lastTick = now; ticks += 1; }, 1); const verify = (page, sample) => { if (page.blocks.length === 0 || page.totalVisibleEntries !== expected || page.previousVisibleEntries + page.totalActiveEntries + page.nextVisibleEntries !== expected) throw new Error("invalid sampled page"); if (sample.first !== undefined && page.blocks[0]?.text !== "ENTRY-" + sample.first + "-" + "x".repeat(payloadBytes)) throw new Error("wrong sampled first block"); if (sample.last !== undefined && page.blocks.at(-1)?.text !== "ENTRY-" + sample.last + "-" + "x".repeat(payloadBytes)) throw new Error("wrong sampled last block"); }; const observe = (started) => { maximumBytes = Math.max(maximumBytes, bytes); maximumMilliseconds = Math.max(maximumMilliseconds, performance.now() - started); if (bytes > 8 * 1024 * 1024) throw new Error("deep sampled page reread " + bytes + " bytes"); }; for (const sample of requests) { bytes = 0; const started = performance.now(); const page = view.loadWorkerSessionViewSnapshot(target, {}, sample.request); observe(started); verify(page, sample); await new Promise((resolve) => setImmediate(resolve)); } for (const sample of requests) { bytes = 0; const started = performance.now(); const page = await view.loadWorkerSessionViewSnapshotAsync(target, sample.request); observe(started); verify(page, sample); await new Promise((resolve) => setImmediate(resolve)); } clearInterval(timer); if (maximumMilliseconds > 2000) throw new Error("deep sampled page took " + maximumMilliseconds + "ms"); if (ticks < requests.length || maximumStall > 1000) throw new Error("deep sampled event-loop stall " + maximumStall + "ms ticks=" + ticks);`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(target), String(expectedEntries), String(payloadBytes)], { timeout: 180_000, stdio: "pipe" });
}

function assertNondisplayedGapReadBound(target: WorkerSessionViewTarget, maximumBytes: number): void {
  const moduleUrl = new URL("../extensions/worker/view.js", import.meta.url).href;
  const script = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const original = fs.readSync; let bytes = 0; fs.readSync = function(...args) { const count = original.apply(this, args); bytes += count; return count; }; syncBuiltinESMExports(); const view = await import(${JSON.stringify(moduleUrl)}); const target = JSON.parse(process.argv[1]); const verify = (page) => { if (page.blocks.length !== 1 || page.blocks[0]?.text !== "FIRST" || page.skippedOversizedEntries !== 1 || page.totalVisibleEntries !== 1 || page.previousVisibleEntries !== 0 || page.nextVisibleEntries !== 0 || page.hasPreviousPage || page.hasNextPage) throw new Error("nondisplayed-gap page changed"); }; verify(await view.loadWorkerSessionViewSnapshotAsync(target)); for (const asyncMode of [false, true]) { bytes = 0; const page = asyncMode ? await view.loadWorkerSessionViewSnapshotAsync(target) : view.loadWorkerSessionViewSnapshot(target); verify(page); if (bytes > Number(process.argv[2])) throw new Error("nondisplayed-gap page reread " + bytes + " bytes"); }`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(target), String(maximumBytes)], { timeout: 20_000, stdio: "pipe" });
}

function assertEdgePageReadCeiling(target: WorkerSessionViewTarget, requests: WorkerSessionPageRequest[], maximumBytes: number): void {
  const moduleUrl = new URL("../extensions/worker/view.js", import.meta.url).href;
  const script = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const original = fs.readSync; let bytes = 0; let calls = []; fs.readSync = function(...args) { const count = original.apply(this, args); bytes += count; calls.push([args[4], args[3], count]); return count; }; syncBuiltinESMExports(); const view = await import(${JSON.stringify(moduleUrl)}); const target = JSON.parse(process.argv[1]); const requests = JSON.parse(process.argv[2]); const maximum = Number(process.argv[3]); await view.loadWorkerSessionViewSnapshotAsync(target); for (const asyncMode of [false, true]) for (const request of requests) { bytes = 0; calls = []; const page = asyncMode ? await view.loadWorkerSessionViewSnapshotAsync(target, request) : view.loadWorkerSessionViewSnapshot(target, {}, request); if (page.blocks.length === 0) throw new Error("edge page was empty " + JSON.stringify(request)); if (bytes > maximum) throw new Error("edge page reread " + bytes + " bytes request=" + JSON.stringify(request) + " calls=" + JSON.stringify(calls)); }`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(target), JSON.stringify(requests), String(maximumBytes)], { timeout: 30_000, stdio: "pipe" });
}

function assertCountSessionLinesReadFailure(target: WorkerSessionViewTarget, mode: "retry" | "fail" | "replace"): void {
  const moduleUrl = new URL("../extensions/worker/view.js", import.meta.url).href;
  const script = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const original = fs.readSync; let injected = 0; const mode = process.argv[2]; const target = JSON.parse(process.argv[1]); fs.readSync = function(fd, buffer, offset, length, position) { if (typeof position === "number" && position > 0 && (mode === "fail" || injected === 0)) { injected += 1; if (mode === "replace") { fs.renameSync(target.sessionFile, target.sessionFile + ".original"); fs.writeFileSync(target.sessionFile, "replacement\\n"); } return 0; } return original.call(this, fd, buffer, offset, length, position); }; syncBuiltinESMExports(); const view = await import(${JSON.stringify(moduleUrl)}); try { const count = view.countSessionLines(target.sessionFile); if (mode !== "retry") throw new Error("count unexpectedly succeeded"); if (count !== target.sessionEndLine) throw new Error("retry count mismatch " + count); } catch (error) { if (mode === "retry") throw error; if (error?.message !== "Worker session changed while counting lines; retry.") throw new Error("unstable count error: " + String(error?.message)); }`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(target), mode], { timeout: 8_000, stdio: "pipe" });
}

async function assertExactBidirectionalBlocks(target: WorkerSessionViewTarget, expected: string[], expectedEntries: number, expectedMalformedEntries = 0, expectedOversizedEntries = 0): Promise<void> {
  for (const asyncMode of [false, true]) for (const direction of ["forward", "backward"] as const) {
    const pages: WorkerSessionViewSnapshot[] = []; const cursors = new Set<string>();
    let request: WorkerSessionPageRequest = direction === "forward" ? { mode: "first" } : { mode: "tail" };
    for (let step = 0; step < expected.length / 1_000 + 32; step += 1) {
      const page: WorkerSessionViewSnapshot = asyncMode ? await loadWorkerSessionViewSnapshotAsync(target, request) : loadWorkerSessionViewSnapshot(target, {}, request);
      assert.ok(page.blocks.length > 0, `${direction} ${asyncMode ? "async" : "sync"} returned an empty page`);
      assert.equal(page.totalVisibleEntries, expectedEntries);
      assert.equal(page.previousVisibleEntries + page.totalActiveEntries + page.nextVisibleEntries, expectedEntries);
      const cursor: string = direction === "forward" ? `${page.pageEndLine}:${page.pageEndBlock ?? 0}` : `${page.pageStartLine}:${page.pageStartBlock ?? 0}`;
      assert.equal(cursors.has(cursor), false, `${direction} repeated ${cursor}`); cursors.add(cursor); pages.push(page);
      if (direction === "forward" ? !page.hasNextPage : !page.hasPreviousPage) break;
      request = direction === "forward"
        ? { mode: "after", line: page.pageEndLine, ...(page.hasNextBlocksInEntry ? { block: page.pageEndBlock } : {}) }
        : { mode: "before", line: page.pageStartLine, ...(page.hasPreviousBlocksInEntry ? { block: page.pageStartBlock } : {}) };
      if (step + 1 >= expected.length / 1_000 + 32) assert.fail(`${direction} traversal did not terminate`);
    }
    if (direction === "backward") pages.reverse();
    assert.deepEqual(pages.flatMap((page) => page.blocks.map((block) => block.text)), expected, `${direction} ${asyncMode ? "async" : "sync"} block sequence`);
    assert.equal(pages.reduce((total, page) => total + page.malformedEntries, 0), expectedMalformedEntries, `${direction} ${asyncMode ? "async" : "sync"} malformed count`);
    assert.equal(pages.reduce((total, page) => total + page.skippedOversizedEntries, 0), expectedOversizedEntries, `${direction} ${asyncMode ? "async" : "sync"} oversized count`);
  }
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

test("async running snapshots stay isolated from settlement, sync, and concurrent index growth", () => {
  for (const mode of ["settlement", "sync", "concurrent"] as const) {
    const f = fixture();
    try {
      const entries = Array.from({ length: 350 }, (_, index) => line(message(`seed-${index}`, index === 0 ? null : `seed-${index - 1}`, `SEED-${index}-${"x".repeat(7000)}`)));
      writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
      const running = { ...f.target, runStatus: "running" as const, workerStatus: "running" as const, outcome: undefined, sessionStartLine: 2, sessionEndLine: undefined };
      assertRunningIndexIsolationChild(running, mode);
    } finally { f.close(); }
  }
});

test("viewer refresh settles during final-write indexing and a second refresh shows the answer", () => {
  const f = fixture();
  try {
    writeFileSync(f.sessionFile, line(header(f.target)) + line(message("base", null, "BASE")));
    const running = { ...f.target, runStatus: "running" as const, workerStatus: "running" as const, outcome: undefined, sessionStartLine: 2, sessionEndLine: undefined };
    assertViewerSettlementIndexIsolationChild(running);
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

test("running and settled half-written tails stay live and settlement rechecks growth", async () => {
  const f = fixture(); const asyncClone = fixture(); const syncClone = fixture();
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
    assert.equal(fixedAgain.incompleteTrailingEntry, false, "settled snapshots must recheck a half-write decision after growth"); assert.deepEqual(fixedAgain.blocks.map((block) => block.text), ["COMPLETE", "PARTIAL-COMPLETED"]);
    const fixedAgainSync = loadWorkerSessionViewSnapshot(settled);
    assert.equal(fixedAgainSync.incompleteTrailingEntry, false); assert.equal(fixedAgainSync.blocks.some((block) => block.text === "PARTIAL-COMPLETED"), true);

    const exercisePromotion = async (clone: ReturnType<typeof fixture>, async: boolean) => {
      const cloneComplete = line(message("complete", null, "CLONE-COMPLETE"));
      const cloneTrailing = JSON.stringify(message("partial", "complete", "CLONE-PARTIAL-DONE")); const cloneSplit = cloneTrailing.length - 11;
      writeFileSync(clone.sessionFile, line(header(clone.target)) + cloneComplete + cloneTrailing.slice(0, cloneSplit));
      const cloneRunning = { ...clone.target, runStatus: "running" as const, workerStatus: "running" as const, outcome: undefined, sessionStartLine: 2, sessionEndLine: undefined };
      const cloneSettled = { ...cloneRunning, runStatus: "settled" as const, workerStatus: "idle" as const, outcome: "completed", sessionEndLine: 3 };
      const partial = async ? await watchdog(loadWorkerSessionViewSnapshotAsync(cloneRunning)) : loadWorkerSessionViewSnapshot(cloneRunning);
      assert.equal(partial.incompleteTrailingEntry, true);
      writeFileSync(clone.sessionFile, `${cloneTrailing.slice(cloneSplit)}\n`, { flag: "a" });
      const promoted = async ? await watchdog(loadWorkerSessionViewSnapshotAsync(cloneSettled)) : loadWorkerSessionViewSnapshot(cloneSettled);
      assert.equal(promoted.incompleteTrailingEntry, false); assert.deepEqual(promoted.blocks.map((block) => block.text), ["CLONE-COMPLETE", "CLONE-PARTIAL-DONE"]);
    };
    await exercisePromotion(asyncClone, true); await exercisePromotion(syncClone, false);
  } finally { f.close(); asyncClone.close(); syncClone.close(); }
});

test("viewer refresh remains responsive while a session entry is half-written", async () => {
  const f = fixture(); const guard = fixture();
  try {
    writeFileSync(f.sessionFile, line(header(f.target)) + line(message("complete", null, "COMPLETE")));
    const target = { ...f.target, runStatus: "running" as const, workerStatus: "running" as const, outcome: undefined, sessionStartLine: 2, sessionEndLine: undefined };
    const trailing = JSON.stringify(message("partial", "complete", "VIEWER-PARTIAL")); const split = trailing.length - 9;
    writeFileSync(guard.sessionFile, line(header(guard.target)) + line(message("complete", null, "COMPLETE")));
    assertViewerHalfWriteChildLiveness({ ...target, sessionFile: guard.sessionFile, sessionRoot: guard.sessionRoot, workspaceRoot: guard.target.workspaceRoot, parentSessionFile: guard.target.parentSessionFile }, trailing.slice(0, split));
    let currentTarget: WorkerSessionViewTarget = target;
    const initial = loadWorkerSessionViewSnapshot(currentTarget);
    writeFileSync(f.sessionFile, trailing.slice(0, split), { flag: "a" });
    let pending: Promise<WorkerSessionViewSnapshot> | undefined; let renders = 0;
    const component = createWorkerSessionViewerComponent({ tui: { terminal: { rows: 30 }, requestRender() { renders += 1; } } as never, getTheme: () => theme, initialSnapshot: initial,
      loadSnapshot: (request) => pending = loadWorkerSessionViewSnapshotAsync(currentTarget, request), done() {} });
    let heartbeats = 0; const heartbeat = setInterval(() => { heartbeats += 1; }, 1);
    component.handleInput!("r"); await tick(); await watchdog(pending!); await tick(); clearInterval(heartbeat);
    assert.ok(heartbeats > 0); assert.ok(renders >= 2); assert.match(component.render(100).join("\n"), /final unterminated session entry/);

    writeFileSync(f.sessionFile, `${trailing.slice(split)}\n`, { flag: "a" });
    currentTarget = { ...target, runStatus: "settled", workerStatus: "idle", outcome: "completed", sessionEndLine: 3 };
    pending = undefined; component.handleInput!("r"); await tick(); await watchdog(pending!); await tick();
    const settledFrame = component.render(100).join("\n"); assert.match(settledFrame, /VIEWER-PARTIAL/); assert.doesNotMatch(settledFrame, /final unterminated session entry/);
    component.handleInput!("q");
    const reopened = loadWorkerSessionViewSnapshot(currentTarget); assert.equal(reopened.incompleteTrailingEntry, false); assert.equal(reopened.blocks.some((block) => block.text === "VIEWER-PARTIAL"), true);
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

test("exact block-budget boundaries keep all 8-part, aligned-forward, and heavy-entry blocks reachable", async () => {
  const assistant = (id: string, parentId: string | null, texts: string[]) => ({ type: "message", id, parentId, timestamp: "now", message: { role: "assistant", content: texts.map((text) => ({ type: "text", text })) } });
  const eight = fixture();
  try {
    const expected = ["M0"]; const entries = [line(message("opening", null, "M0"))]; let marker = 1;
    for (let index = 0; index < 2_000; index += 1) { const texts = Array.from({ length: 8 }, () => `M${marker++}`); expected.push(...texts); entries.push(line(assistant(`a-${index}`, index === 0 ? "opening" : `a-${index - 1}`, texts))); }
    writeFileSync(eight.sessionFile, line(header(eight.target)) + entries.join(""));
    await assertExactBidirectionalBlocks({ ...eight.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 }, expected, entries.length);
  } finally { eight.close(); }

  const aligned = fixture();
  try {
    const expected = ["M0"]; const entries = [line(message("opening", null, "M0"))]; let marker = 1;
    const lead = Array.from({ length: 7 }, () => `M${marker++}`); expected.push(...lead); entries.push(line(assistant("lead", "opening", lead)));
    for (let index = 0; index < 1_999; index += 1) { const texts = Array.from({ length: 8 }, () => `M${marker++}`); expected.push(...texts); entries.push(line(assistant(`a-${index}`, index === 0 ? "lead" : `a-${index - 1}`, texts))); }
    writeFileSync(aligned.sessionFile, line(header(aligned.target)) + entries.join(""));
    await assertExactBidirectionalBlocks({ ...aligned.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 }, expected, entries.length);
  } finally { aligned.close(); }

  const heavy = fixture();
  try {
    const expected: string[] = []; const entries: string[] = []; let parent: string | null = null; let marker = 0;
    for (let index = 0; index < 300; index += 1) { const id = `before-${index}`; const text = `M${marker++}`; expected.push(text); entries.push(line(message(id, parent, text))); parent = id; }
    const parts = Array.from({ length: 3_700 }, () => `M${marker++}`); expected.push(...parts); entries.push(line(assistant("heavy", parent, parts))); parent = "heavy";
    for (let index = 0; index < 416; index += 1) { const id = `after-${index}`; const text = `M${marker++}`; expected.push(text); entries.push(line(message(id, parent, text))); parent = id; }
    writeFileSync(heavy.sessionFile, line(header(heavy.target)) + entries.join(""));
    await assertExactBidirectionalBlocks({ ...heavy.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 }, expected, entries.length);
  } finally { heavy.close(); }
});

test("U/A2048/B/H/X pages report post-budget malformed and oversized notices once", async () => {
  const f = fixture();
  try {
    const parts = Array.from({ length: 2_048 }, (_, index) => `A${index}`); const expected = ["U", ...parts];
    const assistant = { type: "message", id: "A", parentId: "U", timestamp: "now", message: { role: "assistant", content: parts.map((text) => ({ type: "text", text })) } };
    const hidden = { type: "custom", id: "H", parentId: "A", timestamp: "now", customType: "internal", data: { hidden: true } };
    const oversized = message("X", "H", `X-${"x".repeat(9 * 1024 * 1024)}`);
    writeFileSync(f.sessionFile, line(header(f.target)) + line(message("U", null, "U")) + line(assistant) + "{bad json}\n" + line(hidden) + line(oversized));
    await assertExactBidirectionalBlocks({ ...f.target, sessionStartLine: 2, sessionEndLine: 6 }, expected, 2, 1, 1);
  } finally { f.close(); }
});

test("post-budget hidden and malformed fuzz counts every notice exactly once", async () => {
  let random = 0x51f15e;
  const next = () => { random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0; return random; };
  for (let seed = 0; seed < 16; seed += 1) {
    const f = fixture();
    try {
      const partCount = seed === 0 ? 2_048 : 2_044 + next() % 10; const malformedCount = 1 + next() % 3; const hiddenCount = 1 + next() % 3; const oversizedEnd = seed % 4 === 0;
      const parts = Array.from({ length: partCount }, (_, index) => `S${seed}-A${index}`);
      const assistant = { type: "message", id: "A", parentId: "U", timestamp: "now", message: { role: "assistant", content: parts.map((text) => ({ type: "text", text })) } };
      const malformed = Array.from({ length: malformedCount }, (_, index) => `{bad-${seed}-${index}}\n`).join("");
      const hidden = Array.from({ length: hiddenCount }, (_, index) => line({ type: "custom", id: `H-${index}`, parentId: index === 0 ? "A" : `H-${index - 1}`, timestamp: "now", customType: "internal", data: { hidden: true } })).join("");
      const end = message("X", `H-${hiddenCount - 1}`, oversizedEnd ? `X-${"x".repeat(9 * 1024 * 1024)}` : "X");
      writeFileSync(f.sessionFile, line(header(f.target)) + line(message("U", null, "U")) + line(assistant) + malformed + hidden + line(end));
      await assertExactBidirectionalBlocks({ ...f.target, sessionStartLine: 2, sessionEndLine: 4 + malformedCount + hiddenCount }, ["U", ...parts, ...(oversizedEnd ? [] : ["X"])], oversizedEnd ? 2 : 3, malformedCount, oversizedEnd ? 1 : 0);
    } finally { f.close(); }
  }
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
  const shapes = [[5, 5], [4, 5], [5, 5, 5], [3, 3, 3], [9, 1], [1, 9], [9, 9, 9], [5, 9, 9, 5]];
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
        const skippedOversizedEntries = pages.reduce((total, value) => total + value.skippedOversizedEntries, 0);
        if (direction === "backward") pages.reverse();
        return { blocks: pages.flatMap((value) => value.blocks.map((block) => block.text)), skippedOversizedEntries };
      };
      const expected = [`OPENING-${shapeIndex}`, ...sizes!.flatMap((size, index) => size > 8 ? [] : [`BIG-${index}-`]), `LAST-${shapeIndex}`];
      const expectedSkipped = sizes!.filter((size) => size > 8).length;
      const normalize = (values: string[]) => values.map((value) => value.startsWith("BIG-") ? value.slice(0, 6) : value);
      const forward = traverse("forward"); const backward = traverse("backward");
      assert.deepEqual(normalize(forward.blocks), expected); assert.deepEqual(normalize(backward.blocks), expected);
      assert.equal(forward.skippedOversizedEntries, expectedSkipped); assert.equal(backward.skippedOversizedEntries, expectedSkipped);
    } finally { f.close(); }
  }
});

test("leveled checkpoints bound 60k, 100k, 140k-by-3KiB, and compacted traversal reads and stalls", () => {
  const shapes = [
    { count: 60_000, payloadBytes: 96 },
    { count: 100_000, payloadBytes: 96 },
    { count: 140_000, payloadBytes: 2_850 },
    { count: 100_000, payloadBytes: 1_200, compactionAt: 70_000, firstKept: 40_000 },
  ];
  for (const shape of shapes) {
    const f = fixture();
    try {
      const fd = openSync(f.sessionFile, "w");
      try {
        writeSync(fd, line(header(f.target))); let chunk = "";
        for (let index = 0; index < shape.count; index += 1) {
          chunk += line(message(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`, `ENTRY-${index}-${"x".repeat(shape.payloadBytes)}`));
          if (shape.compactionAt === index + 1) chunk += line({ type: "compaction", id: "compaction", parentId: `entry-${index}`, timestamp: "now", summary: "retained", firstKeptEntryId: `entry-${shape.firstKept}` });
          if (index % 1_000 === 999) { writeSync(fd, chunk); chunk = ""; }
        }
        if (chunk) writeSync(fd, chunk);
      } finally { closeSync(fd); }
      const compacted = shape.compactionAt !== undefined;
      const expected = compacted ? shape.count - shape.firstKept! + 2 : shape.count;
      const target = { ...f.target, sessionStartLine: 2, sessionEndLine: shape.count + 1 + (compacted ? 1 : 0) };
      assertLargeCheckpointTraversal(target, expected);
    } finally { f.close(); }
  }
});

test("400k and physical 1M-by-3KiB deep pages stay within read, latency, and event-loop bounds", () => {
  for (const { count, payloadBytes } of [{ count: 400_000, payloadBytes: 96 }, { count: 1_000_000, payloadBytes: 2_850 }]) {
    const f = fixture();
    try {
      const fd = openSync(f.sessionFile, "w");
      try {
        writeSync(fd, line(header(f.target))); let chunk = "";
        for (let index = 0; index < count; index += 1) {
          chunk += line(message(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`, `ENTRY-${index}-${"x".repeat(payloadBytes)}`));
          if (index % 1_000 === 999) { writeSync(fd, chunk); chunk = ""; }
        }
        if (chunk) writeSync(fd, chunk);
      } finally { closeSync(fd); }
      assertDeepCheckpointSamples({ ...f.target, sessionStartLine: 2, sessionEndLine: count + 1 }, count, payloadBytes);
    } finally { f.close(); }
  }
});

test("16-level checkpoint simulation bounds memory and anchor gaps through 10M entries", () => {
  type Checkpoint = { line: number; count: number };
  const capacity = 1_024; const maximumLevels = 16; const levels: Checkpoint[][] = [[{ line: 0, count: 0 }]];
  let peakRetained = 1;
  const append = (checkpoint: Checkpoint) => {
    let promoted = [checkpoint];
    for (let level = 0; promoted.length > 0; level += 1) {
      const targetLevel = Math.min(level, maximumLevels - 1);
      const values = levels[targetLevel] ?? (levels[targetLevel] = []);
      const last = values.at(-1);
      if (last?.line === promoted[0]!.line && promoted.length === 1) values[values.length - 1] = promoted[0]!;
      else values.push(...promoted);
      if (values.length <= capacity) break;
      const source = values.splice(0);
      promoted = source.filter((_value, position) => position % 2 === 0 || position === source.length - 1);
      if (targetLevel === maximumLevels - 1) {
        while (promoted.length > capacity) promoted = promoted.filter((_value, position) => position % 2 === 0 || position === promoted.length - 1);
        levels[targetLevel] = promoted; break;
      }
    }
    peakRetained = Math.max(peakRetained, levels.reduce((total, level) => total + level.length, 0));
  };
  const entries = 10_000_000;
  for (let lineNumber = 1; lineNumber <= entries; lineNumber += 1) append({ line: lineNumber, count: lineNumber });
  const anchors = levels.flat().sort((left, right) => left.line - right.line).filter((value, index, values) => index === 0 || value.line !== values[index - 1]!.line);
  let maximumGap = 0;
  for (let index = 1; index < anchors.length; index += 1) maximumGap = Math.max(maximumGap, anchors[index]!.line - anchors[index - 1]!.line);
  maximumGap = Math.max(maximumGap, entries - anchors.at(-1)!.line);
  assert.ok(levels.every((level) => level.length <= capacity));
  assert.ok(peakRetained <= 8_192, `retained ${peakRetained} checkpoints`);
  assert.ok(maximumGap <= 20_000, `checkpoint gap ${maximumGap}`);
  assert.equal(anchors.at(-1)?.count, entries);
});

test("countSessionLines retries transient zero reads and translates persistent snapshot failures", () => {
  const f = fixture();
  try {
    const entries = Array.from({ length: 400 }, (_, index) => line(message(`count-${index}`, index === 0 ? null : `count-${index - 1}`, `COUNT-${index}-${"x".repeat(7000)}`)));
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: 401 };
    assertCountSessionLinesReadFailure(target, "retry"); assertCountSessionLinesReadFailure(target, "fail"); assertCountSessionLinesReadFailure(target, "replace");
  } finally { f.close(); }
});

test("forward oversized notices are counted once across rendered-block cursors", () => {
  const f = fixture();
  try {
    const assistant = { type: "message", id: "assistant", parentId: null, timestamp: "now", message: { role: "assistant", content: Array.from({ length: 3_000 }, (_, index) => ({ type: "text", text: `PART-${index}` })) } };
    const huge = message("huge", "assistant", `HUGE-${"h".repeat(9 * 1024 * 1024)}`);
    const last = message("last", "huge", "LAST");
    writeFileSync(f.sessionFile, line(header(f.target)) + line(assistant) + line(huge) + line(last));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: 4 };
    const first = loadWorkerSessionViewSnapshot(target, {}, { mode: "first" });
    assert.equal(first.blocks.length, 2_048); assert.equal(first.skippedOversizedEntries, 0); assert.equal(first.hasNextBlocksInEntry, true);
    const second = loadWorkerSessionViewSnapshot(target, {}, { mode: "after", line: first.pageEndLine, block: first.pageEndBlock });
    assert.equal(second.skippedOversizedEntries, 1); assert.equal(second.blocks.length, 953); assert.equal(second.blocks.at(-1)?.text, "LAST");
    assert.equal(first.skippedOversizedEntries + second.skippedOversizedEntries, 1);
  } finally { f.close(); }
});

test("exact-budget end pages include trailing oversized notices without inventing continuation", async () => {
  const f = fixture();
  try {
    const assistant = { type: "message", id: "assistant", parentId: "opening", timestamp: "now", message: { role: "assistant", content: Array.from({ length: 2_047 }, (_, index) => ({ type: "text", text: `PART-${index}` })) } };
    const hidden = { type: "custom", id: "hidden", parentId: "assistant", timestamp: "now", customType: "internal", data: { hidden: true } };
    const huge = message("huge", "hidden", `HUGE-${"h".repeat(9 * 1024 * 1024)}`);
    writeFileSync(f.sessionFile, line(header(f.target)) + line(message("opening", null, "OPENING")) + line(assistant) + "{bad json}\n" + line(hidden) + line(huge));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: 6 };
    for (const page of [loadWorkerSessionViewSnapshot(target, {}, { mode: "first" }), await loadWorkerSessionViewSnapshotAsync(target, { mode: "first" })]) {
      assert.equal(page.blocks.length, 2_048);
      assert.equal(page.totalVisibleEntries, 2);
      assert.equal(page.previousVisibleEntries + page.totalActiveEntries + page.nextVisibleEntries, 2);
      assert.equal(page.skippedOversizedEntries, 1);
      assert.equal(page.malformedEntries, 1);
      assert.equal(page.hasNextPage, false);
      assert.equal(page.pageEndLine, 6);
    }
  } finally { f.close(); }
});

test("reduced compaction pages stop before a kept entry that exceeds the opening-page remainder", async () => {
  const f = fixture();
  try {
    const opening = message("opening", null, `OPENING-${"o".repeat(3_600 * 1024)}`);
    const hidden = { type: "custom", id: "hidden", parentId: "opening", timestamp: "now", customType: "internal", data: { hidden: true } };
    const kept = message("kept", "hidden", `KEPT-${"k".repeat(3_600 * 1024)}`);
    const compact = { type: "compaction", id: "compact", parentId: "kept", timestamp: "now", summary: "REDUCED-BUDGET-COMPACTION", firstKeptEntryId: "kept", tokensBefore: 10 };
    const entries = [opening, hidden, kept, compact];
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.map(line).join(""));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 };
    for (const asyncMode of [false, true]) {
      const first = asyncMode ? await loadWorkerSessionViewSnapshotAsync(target, { mode: "first" }) : loadWorkerSessionViewSnapshot(target, {}, { mode: "first" });
      assert.equal(first.blocks.length, 1); assert.match(first.blocks[0]?.text ?? "", /^OPENING-/); assert.equal(first.pageEndLine, 2); assert.equal(first.hasNextPage, true);
      const next = asyncMode ? await loadWorkerSessionViewSnapshotAsync(target, { mode: "after", line: first.pageEndLine }) : loadWorkerSessionViewSnapshot(target, {}, { mode: "after", line: first.pageEndLine });
      assert.match(next.blocks[0]?.text ?? "", /^KEPT-/); assert.equal(next.blocks[1]?.text, "REDUCED-BUDGET-COMPACTION");
      assert.equal(next.hasPreviousPage, true); assert.equal(next.hasNextPage, false);
    }
  } finally { f.close(); }
});

test("Pi-ordered large displayed custom messages remain reachable without paging cycles", async () => {
  for (const prefixEntries of [0, 512]) {
    const f = fixture();
    try {
      const prefix = Array.from({ length: prefixEntries }, (_, index) => line(message(`prefix-${index}`, index === 0 ? null : `prefix-${index - 1}`, `PREFIX-${index}`)));
      const parentId = prefixEntries === 0 ? null : `prefix-${prefixEntries - 1}`;
      const custom = { type: "custom_message", customType: "edge", content: `CUSTOM-${"c".repeat(20 * 1024)}`, display: true, details: {}, id: "custom", parentId, timestamp: "now" };
      const after = message("after", "custom", "AFTER");
      const entries = [...prefix, line(custom), line(after)]; writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
      const target = { ...f.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 };
      const customText = `CUSTOM-${"c".repeat(20 * 1024)}`;
      const expected = [...Array.from({ length: prefixEntries }, (_, index) => `PREFIX-${index}`), `${customText.slice(0, 16 * 1024)}\n[… block text truncated …]`, "AFTER"];
      await assertExactBidirectionalBlocks(target, expected, prefixEntries + 2);
    } finally { f.close(); }
  }
});

test("sparse 70k prefix pages fit hidden 3 MiB plus user 5 MiB without throwing", async () => {
  const f = fixture();
  try {
    const fd = openSync(f.sessionFile, "w");
    try {
      writeSync(fd, line(header(f.target))); let chunk = "";
      for (let index = 0; index < 70_000; index += 1) { chunk += line(message(`prefix-${index}`, index === 0 ? null : `prefix-${index - 1}`, `PREFIX-${index}`)); if (index % 1_000 === 999) { writeSync(fd, chunk); chunk = ""; } }
      if (chunk) writeSync(fd, chunk);
      writeSync(fd, line(message("opening", "prefix-69999", "OPENING")));
      writeSync(fd, line({ type: "custom", customType: "internal", content: "h".repeat(3 * 1024 * 1024), display: false, id: "hidden", parentId: "opening", timestamp: "now" }));
      writeSync(fd, line(message("user", "hidden", `USER-${"u".repeat(5 * 1024 * 1024)}`)));
      writeSync(fd, line({ type: "message", id: "assistant", parentId: "user", timestamp: "now", message: { role: "assistant", content: [{ type: "text", text: "ASSISTANT" }] } }));
    } finally { closeSync(fd); }
    const target = { ...f.target, sessionStartLine: 70_002, sessionEndLine: 70_005 };
    for (const asyncMode of [false, true]) {
      const request = { mode: "after" as const, line: 70_002 };
      const page = asyncMode ? await loadWorkerSessionViewSnapshotAsync(target, request) : loadWorkerSessionViewSnapshot(target, {}, request);
      assert.equal(page.blocks.length, 2); assert.match(page.blocks[0]?.text ?? "", /^USER-/); assert.equal(page.blocks[1]?.text, "ASSISTANT");
      assert.equal(page.totalVisibleEntries, 3); assert.equal(page.previousVisibleEntries + page.totalActiveEntries + page.nextVisibleEntries, 3);
    }
    assertEdgePageReadCeiling(target, [{ mode: "after", line: 70_002 }], 8 * 1024 * 1024);
  } finally { f.close(); }
});

test("thinned render checkpoints fit 1,100 entries around a 5.2 MiB assistant", async () => {
  const f = fixture();
  try {
    const entries: string[] = []; let parentId: string | null = null;
    for (let index = 0; index < 1_100; index += 1) {
      if (index === 300) {
        entries.push(line({ type: "message", id: "assistant-large", parentId, timestamp: "now", message: { role: "assistant", content: [{ type: "text", text: `ASSISTANT-${"a".repeat(5_200 * 1024)}` }] } })); parentId = "assistant-large";
      } else if (index === 301) {
        entries.push(line({ type: "custom", customType: "internal", content: "h".repeat(2_300 * 1024), display: false, id: "hidden-large", parentId, timestamp: "now" })); parentId = "hidden-large";
      } else {
        const id = `entry-${index}`; entries.push(line(message(id, parentId, `ENTRY-${index}-${"x".repeat(1024)}`))); parentId = id;
      }
    }
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: 1_101 };
    for (const asyncMode of [false, true]) {
      const request = { mode: "before" as const, line: 590 };
      const page = asyncMode ? await loadWorkerSessionViewSnapshotAsync(target, request) : loadWorkerSessionViewSnapshot(target, {}, request);
      assert.ok(page.blocks.length > 0); assert.equal(page.totalVisibleEntries, 1_099); assert.equal(page.previousVisibleEntries + page.totalActiveEntries + page.nextVisibleEntries, 1_099);
    }
    assertEdgePageReadCeiling(target, [{ mode: "before", line: 590 }], 8 * 1024 * 1024);
  } finally { f.close(); }
});

test("oversized Pi-ordered hidden custom entries report exact notices in both directions", async () => {
  for (const withUser of [false, true]) {
    const f = fixture();
    try {
      const custom = { type: "custom", customType: "internal", content: "h".repeat(9 * 1024 * 1024), display: false, id: "hidden", parentId: null, timestamp: "now" };
      const entries = [line(custom), ...(withUser ? [line(message("shown", "hidden", "SHOWN"))] : [])]; writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
      const target = { ...f.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 };
      if (withUser) await assertExactBidirectionalBlocks(target, ["SHOWN"], 1, 0, 1);
      else for (const page of [loadWorkerSessionViewSnapshot(target), await loadWorkerSessionViewSnapshotAsync(target), loadWorkerSessionViewSnapshot(target, {}, { mode: "first" }), await loadWorkerSessionViewSnapshotAsync(target, { mode: "first" })]) { assert.equal(page.blocks.length, 0); assert.equal(page.skippedOversizedEntries, 1); }
    } finally { f.close(); }
  }
});

test("multi-MiB skipped, compaction, and opening edge pages stay within the total 8 MiB read ceiling", () => {
  const f = fixture();
  try {
    const opening = message("opening", null, `OPENING-${"o".repeat(2 * 1024 * 1024)}`);
    const hidden = { type: "custom", customType: "internal", content: "h".repeat(3 * 1024 * 1024), display: false, id: "hidden", parentId: "opening", timestamp: "now" };
    const kept = message("kept", "hidden", `KEPT-${"k".repeat(5 * 1024 * 1024)}`);
    const compact = { type: "compaction", id: "compact", parentId: "kept", timestamp: "now", summary: "EDGE-COMPACTION", firstKeptEntryId: "kept", tokensBefore: 10 };
    const oversized = message("oversized", "compact", `OVERSIZED-${"z".repeat(9 * 1024 * 1024)}`);
    const edgeOne = message("edge-1", "oversized", `EDGE-1-${"a".repeat(2_500 * 1024)}`);
    const edgeTwo = message("edge-2", "edge-1", `EDGE-2-${"b".repeat(3_500 * 1024)}`);
    const last = message("last", "edge-2", "LAST");
    const entries = [opening, hidden, kept, compact, oversized, edgeOne, edgeTwo, last];
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.map(line).join(""));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 };
    assertEdgePageReadCeiling(target, [{ mode: "first" }, { mode: "tail" }, { mode: "after", line: 2 }, { mode: "before", line: 9 }], 8 * 1024 * 1024);
  } finally { f.close(); }
});

test("160 deterministic multi-MiB layouts preserve exact sync/async paging within the hard read ceiling", async () => {
  const f = fixture();
  try {
    let inherited = "";
    for (let index = 0; index < 70_000; index += 1) inherited += line(message(`matrix-prefix-${index}`, index === 0 ? null : `matrix-prefix-${index - 1}`, `P-${index}`));
    const retainedStartLine = 70_002;
    for (let layout = 0; layout < 160; layout += 1) {
      const opening = message(`opening-${layout}`, null, `OPEN-${layout}`);
      const before = { type: "message", id: `before-${layout}`, parentId: opening.id, timestamp: "now", message: { role: "toolResult", toolCallId: "before", toolName: "edge", content: `BEFORE-${"b".repeat(8_500 * 1024)}`, isError: false } };
      const hiddenBefore = { type: "custom", customType: "internal", content: "h".repeat(3 * 1024 * 1024), display: false, id: `hidden-before-${layout}`, parentId: layout & 8 ? before.id : opening.id, timestamp: "now" };
      const userParent = layout & 1 ? hiddenBefore.id : layout & 8 ? before.id : opening.id;
      const user = message(`user-${layout}`, userParent, `USER-${layout}-${"u".repeat(layout & 2 ? 5 * 1024 * 1024 : 64 * 1024)}`);
      const compact = { type: "compaction", id: `compact-${layout}`, parentId: user.id, timestamp: "now", summary: `COMPACT-${layout}`, firstKeptEntryId: user.id, tokensBefore: 10 };
      const assistantParent = layout & 16 ? compact.id : user.id;
      const assistant = { type: "message", id: `assistant-${layout}`, parentId: assistantParent, timestamp: "now", message: { role: "assistant", content: Array.from({ length: layout & 4 ? 4_096 : 3 }, (_, index) => ({ type: "text", text: `PART-${layout}-${index}` })) } };
      const hiddenAfter = { type: "custom", customType: "internal", content: "z".repeat(3 * 1024 * 1024), display: false, id: `hidden-after-${layout}`, parentId: assistant.id, timestamp: "now" };
      const customParent = layout & 32 ? hiddenAfter.id : assistant.id;
      const custom = { type: "custom_message", customType: "shown", content: `CUSTOM-${layout}`, display: true, details: {}, id: `custom-${layout}`, parentId: customParent, timestamp: "now" };
      const finalParent = layout & 64 ? custom.id : customParent;
      const finalTool = { type: "message", id: `final-${layout}`, parentId: finalParent, timestamp: "now", message: { role: "toolResult", toolCallId: "final", toolName: "edge", content: `FINAL-${"f".repeat(8_500 * 1024)}`, isError: false } };
      const entries: unknown[] = [opening];
      if (layout & 8) entries.push(before);
      if (layout & 1) entries.push(hiddenBefore);
      entries.push(user);
      if (layout & 16) entries.push(compact);
      entries.push(assistant);
      if (layout & 32) entries.push(hiddenAfter);
      if (layout & 128) entries.push(custom);
      if (layout & 64) entries.push(finalTool);
      writeFileSync(f.sessionFile, line(header(f.target)) + inherited + entries.map(line).join(""));
      const target = { ...f.target, sessionStartLine: retainedStartLine, sessionEndLine: retainedStartLine + entries.length - 1 };
      const collect = async (asyncMode: boolean, direction: "forward" | "backward") => {
        const pages: WorkerSessionViewSnapshot[] = []; let request: WorkerSessionPageRequest = direction === "forward" ? { mode: "first" } : { mode: "tail" };
        for (let step = 0; step < 32; step += 1) {
          const page: WorkerSessionViewSnapshot = asyncMode ? await loadWorkerSessionViewSnapshotAsync(target, request) : loadWorkerSessionViewSnapshot(target, {}, request);
          assert.ok(page.blocks.length > 0, `layout ${layout} ${direction} ${asyncMode} empty page`);
          assert.equal(page.previousVisibleEntries + page.totalActiveEntries + page.nextVisibleEntries, page.totalVisibleEntries);
          pages.push(page);
          if (direction === "forward") {
            if (!page.hasNextPage) break;
            request = { mode: "after", line: page.pageEndLine, ...(page.hasNextBlocksInEntry ? { block: page.pageEndBlock } : {}) };
          } else {
            if (!page.hasPreviousPage) break;
            request = { mode: "before", line: page.pageStartLine, ...(page.hasPreviousBlocksInEntry ? { block: page.pageStartBlock } : {}) };
          }
          if (step === 31) assert.fail(`layout ${layout} did not terminate`);
        }
        if (direction === "backward") pages.reverse();
        return { blocks: pages.flatMap((page) => page.blocks.map((block) => `${block.kind}:${block.text}`)), notices: pages.reduce((total, page) => total + page.skippedOversizedEntries, 0), visible: pages[0]!.totalVisibleEntries };
      };
      const forward = await collect(false, "forward");
      const backward = await collect(false, "backward");
      const asyncForward = await collect(true, "forward");
      const asyncBackward = await collect(true, "backward");
      assert.deepEqual(backward.blocks, forward.blocks, `layout ${layout} sync order`);
      assert.deepEqual(asyncForward.blocks, forward.blocks, `layout ${layout} async forward order`);
      assert.deepEqual(asyncBackward.blocks, forward.blocks, `layout ${layout} async backward order`);
      const expectedNotices = (layout & 8 && !(layout & 16) ? 1 : 0) + (layout & 64 ? 1 : 0);
      for (const value of [forward, backward, asyncForward, asyncBackward]) { assert.equal(value.notices, expectedNotices, `layout ${layout} notices`); assert.ok(value.visible > 0); }
    }
  } finally { f.close(); }
});

test("40 seeded sparse and dense multi-MiB layouts remain exact and bounded", async () => {
  let random = 0x5eedf10;
  const next = () => { random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0; return random; };
  const expectedText = (text: string) => text.length <= 16 * 1024 ? text : `${text.slice(0, 16 * 1024)}\n[… block text truncated …]`;
  for (let seed = 0; seed < 40; seed += 1) {
    const f = fixture();
    try {
      const count = 70 + next() % 1_531; const multiCount = 1 + next() % 5;
      const special = new Map<number, number>();
      while (special.size < multiCount) special.set(next() % count, next() % 4);
      const entries: string[] = []; const expected: string[] = []; let parentId: string | null = null; let oversized = 0;
      for (let index = 0; index < count; index += 1) {
        const id = `seed-${seed}-${index}`; const kind = special.get(index);
        if (kind === 0) {
          entries.push(line({ type: "custom", customType: "internal", content: "h".repeat((2_100 + next() % 900) * 1024), display: false, id, parentId, timestamp: "now" }));
        } else if (kind === 1) {
          entries.push(line({ type: "custom", customType: "internal", content: "z".repeat(9 * 1024 * 1024), display: false, id, parentId, timestamp: "now" })); oversized += 1;
        } else if (kind === 2) {
          const text = `USER-${seed}-${index}-${"u".repeat((4_000 + next() % 1_200) * 1024)}`; entries.push(line(message(id, parentId, text))); expected.push(expectedText(text));
        } else if (kind === 3) {
          const text = `ASSISTANT-${seed}-${index}-${"a".repeat((4_500 + next() % 800) * 1024)}`; entries.push(line({ type: "message", id, parentId, timestamp: "now", message: { role: "assistant", content: [{ type: "text", text }] } })); expected.push(expectedText(text));
        } else {
          const text = `ENTRY-${seed}-${index}`; entries.push(line(message(id, parentId, text))); expected.push(text);
        }
        parentId = id;
      }
      writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
      const target = { ...f.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 };
      await assertExactBidirectionalBlocks(target, expected, expected.length, 0, oversized);
      assertEdgePageReadCeiling(target, [{ mode: "first" }, { mode: "tail" }], 8 * 1024 * 1024);
    } finally { f.close(); }
  }
});

test("forward terminal and all-undisplayable tail pages retain indexed oversized notices", async () => {
  const terminal = fixture();
  try {
    const shown = message("shown", null, `SHOWN-${"s".repeat(5 * 1024 * 1024)}`);
    const hidden = { type: "custom", id: "hidden", parentId: "shown", timestamp: "now", customType: "internal", data: { padding: "h".repeat(3 * 1024 * 1024) } };
    const tool = { type: "message", id: "tool", parentId: "hidden", timestamp: "now", message: { role: "toolResult", toolCallId: "call", toolName: "edge", content: `TOOL-${"t".repeat(8_500 * 1024)}`, isError: false } };
    const entries = [shown, hidden, tool]; writeFileSync(terminal.sessionFile, line(header(terminal.target)) + entries.map(line).join(""));
    const target = { ...terminal.target, sessionStartLine: 2, sessionEndLine: 4 };
    for (const page of [loadWorkerSessionViewSnapshot(target, {}, { mode: "first" }), await loadWorkerSessionViewSnapshotAsync(target, { mode: "first" })]) {
      assert.equal(page.blocks.length, 1); assert.match(page.blocks[0]?.text ?? "", /^SHOWN-/); assert.equal(page.skippedOversizedEntries, 1); assert.equal(page.hasNextPage, false);
    }
  } finally { terminal.close(); }

  const undisplayable = fixture();
  try {
    const before = { type: "custom", id: "before", parentId: null, timestamp: "now", customType: "internal", data: { padding: "b".repeat(3 * 1024 * 1024) } };
    const tool = { type: "message", id: "tool", parentId: "before", timestamp: "now", message: { role: "toolResult", toolCallId: "call", toolName: "edge", content: `TOOL-${"t".repeat(8_500 * 1024)}`, isError: false } };
    const after = { type: "custom", id: "after", parentId: "tool", timestamp: "now", customType: "internal", data: { hidden: true } };
    const entries = [before, tool, after]; writeFileSync(undisplayable.sessionFile, line(header(undisplayable.target)) + entries.map(line).join(""));
    const target = { ...undisplayable.target, sessionStartLine: 2, sessionEndLine: 4 };
    for (const page of [loadWorkerSessionViewSnapshot(target), await loadWorkerSessionViewSnapshotAsync(target)]) {
      assert.equal(page.blocks.length, 0); assert.equal(page.totalVisibleEntries, 0); assert.equal(page.skippedOversizedEntries, 1); assert.equal(page.hasPreviousPage, false); assert.equal(page.hasNextPage, false);
    }
  } finally { undisplayable.close(); }
});

test("async fixed-end indexing consumes a final newline beyond the first index chunk", async () => {
  const f = fixture();
  try {
    const entry = message("final", null, "");
    const empty = Buffer.byteLength(JSON.stringify(entry));
    const headerBytes = Buffer.byteLength(line(header(f.target)));
    entry.message.content = "F".repeat(1024 * 1024 + 128 - headerBytes - empty - 1);
    const encoded = line(entry); writeFileSync(f.sessionFile, line(header(f.target)) + encoded);
    assert.equal(Buffer.byteLength(line(header(f.target)) + encoded), 1024 * 1024 + 128);
    const page = await loadWorkerSessionViewSnapshotAsync({ ...f.target, sessionStartLine: 2, sessionEndLine: 2 });
    assert.equal(page.blocks.length, 1); assert.equal(page.incompleteTrailingEntry, false); assert.match(page.blocks[0]?.text ?? "", /^F+/);
  } finally { f.close(); }
});

test("exactly 8 MiB entry content is indexed and displayed consistently as oversized", async () => {
  const f = fixture();
  try {
    const exact = message("exact", null, "");
    const empty = JSON.stringify(exact);
    exact.message.content = "x".repeat(8 * 1024 * 1024 - Buffer.byteLength(empty));
    const encoded = JSON.stringify(exact);
    assert.equal(Buffer.byteLength(encoded), 8 * 1024 * 1024);
    writeFileSync(f.sessionFile, line(header(f.target)) + encoded + "\n" + line(message("last", "exact", "LAST")));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: 3 };
    for (const page of [loadWorkerSessionViewSnapshot(target), await loadWorkerSessionViewSnapshotAsync(target)]) {
      assert.deepEqual(page.blocks.map((block) => block.text), ["LAST"]);
      assert.equal(page.skippedOversizedEntries, 1); assert.equal(page.totalVisibleEntries, 1);
      assert.equal(page.hasPreviousPage, false); assert.equal(page.hasNextPage, false);
    }
  } finally { f.close(); }
});

test("exact 2,048-block backward parsing defers the leading oversized notice when an earlier display remains", async () => {
  const f = fixture();
  try {
    const huge = message("huge", null, `HUGE-${"h".repeat(9 * 1024 * 1024)}`);
    const first = message("first", "huge", "FIRST");
    const assistant = { type: "message", id: "assistant", parentId: "first", timestamp: "now", message: { role: "assistant", content: Array.from({ length: 2_048 }, (_, index) => ({ type: "text", text: `PART-${index}` })) } };
    writeFileSync(f.sessionFile, line(header(f.target)) + line(huge) + line(first) + line(assistant));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: 4 };
    for (const asyncMode of [false, true]) {
      const tail = asyncMode ? await loadWorkerSessionViewSnapshotAsync(target) : loadWorkerSessionViewSnapshot(target);
      assert.equal(tail.blocks.length, 2_048); assert.equal(tail.blocks[0]?.text, "PART-0"); assert.equal(tail.blocks.at(-1)?.text, "PART-2047");
      assert.equal(tail.skippedOversizedEntries, 0); assert.equal(tail.hasPreviousPage, true);
      const opening = asyncMode ? await loadWorkerSessionViewSnapshotAsync(target, { mode: "before", line: tail.pageStartLine }) : loadWorkerSessionViewSnapshot(target, {}, { mode: "before", line: tail.pageStartLine });
      assert.deepEqual(opening.blocks.map((block) => block.text), ["FIRST"]); assert.equal(opening.skippedOversizedEntries, 1); assert.equal(opening.hasPreviousPage, false);
    }
  } finally { f.close(); }
});

test("backward block paging reports a leading oversized entry only with the first displayed block", async () => {
  const f = fixture();
  try {
    const firstHuge = message("huge-1", null, `HUGE-1-${"h".repeat(9 * 1024 * 1024)}`);
    const secondHuge = message("huge-2", "huge-1", `HUGE-2-${"h".repeat(9 * 1024 * 1024)}`);
    const assistant = { type: "message", id: "assistant", parentId: "huge-2", timestamp: "now", message: { role: "assistant", content: Array.from({ length: 4_096 }, (_, index) => ({ type: "text", text: `PART-${index}` })) } };
    writeFileSync(f.sessionFile, line(header(f.target)) + line(firstHuge) + line(secondHuge) + line(assistant));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: 4 };
    for (const asyncMode of [false, true]) {
      const tail = asyncMode ? await loadWorkerSessionViewSnapshotAsync(target) : loadWorkerSessionViewSnapshot(target);
      assert.equal(tail.blocks.length, 2_048); assert.equal(tail.blocks[0]?.text, "PART-2048"); assert.equal(tail.blocks.at(-1)?.text, "PART-4095");
      assert.equal(tail.skippedOversizedEntries, 0); assert.equal(tail.totalVisibleEntries, 1); assert.equal(tail.pageStartLine, 4); assert.equal(tail.pageStartBlock, 2_048); assert.equal(tail.hasPreviousBlocksInEntry, true);
      const first = asyncMode ? await loadWorkerSessionViewSnapshotAsync(target, { mode: "before", line: tail.pageStartLine, block: tail.pageStartBlock }) : loadWorkerSessionViewSnapshot(target, {}, { mode: "before", line: tail.pageStartLine, block: tail.pageStartBlock });
      assert.equal(first.blocks.length, 2_048); assert.equal(first.blocks[0]?.text, "PART-0"); assert.equal(first.blocks.at(-1)?.text, "PART-2047");
      assert.equal(first.skippedOversizedEntries, 2); assert.equal(first.totalVisibleEntries, 1); assert.equal(first.previousVisibleEntries + first.totalActiveEntries + first.nextVisibleEntries, 1);
      assert.equal(first.pageStartLine, 4); assert.equal(first.pageEndLine, 4); assert.equal(first.pageStartBlock, 0); assert.equal(first.pageEndBlock, 2_048); assert.equal(first.hasPreviousPage, false);
    }
  } finally { f.close(); }
});

test("backward fallback counts indexed oversized records before but not after its first display as leading", async () => {
  const f = fixture();
  try {
    const before = message("before", null, `BEFORE-${"b".repeat(9 * 1024 * 1024)}`);
    const assistant = { type: "message", id: "assistant", parentId: "before", timestamp: "now", message: { role: "assistant", content: Array.from({ length: 4_096 }, (_, index) => ({ type: "text", text: `PART-${index}` })) } };
    const after = message("after", "assistant", `AFTER-${"a".repeat(9 * 1024 * 1024)}`);
    const entries = [line(before), line(assistant), line(after)];
    let parentId = "after";
    for (let index = 0; index < 10; index += 1) { const id = `hidden-${index}`; entries.push(line({ type: "custom", id, parentId, timestamp: "now", customType: "internal", data: { padding: "h".repeat(900 * 1024) } })); parentId = id; }
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 };
    for (const asyncMode of [false, true]) {
      const tail = asyncMode ? await loadWorkerSessionViewSnapshotAsync(target) : loadWorkerSessionViewSnapshot(target);
      assert.equal(tail.blocks.length, 2_048); assert.equal(tail.blocks[0]?.text, "PART-2048"); assert.equal(tail.skippedOversizedEntries, 1); assert.equal(tail.hasPreviousBlocksInEntry, true);
      const first = asyncMode ? await loadWorkerSessionViewSnapshotAsync(target, { mode: "before", line: tail.pageStartLine, block: tail.pageStartBlock }) : loadWorkerSessionViewSnapshot(target, {}, { mode: "before", line: tail.pageStartLine, block: tail.pageStartBlock });
      assert.equal(first.blocks.length, 2_048); assert.equal(first.blocks[0]?.text, "PART-0"); assert.equal(first.skippedOversizedEntries, 1); assert.equal(first.hasPreviousPage, false);
    }
  } finally { f.close(); }
});

test("backward notices include indexed oversized records before the 512-line fallback window", async () => {
  const f = fixture();
  try {
    const first = message("huge-1", null, `HUGE-1-${"x".repeat(9 * 1024 * 1024)}`);
    const second = message("huge-2", "huge-1", `HUGE-2-${"y".repeat(9 * 1024 * 1024)}`);
    const hidden = Array.from({ length: 518 }, (_, index) => ({ type: "custom", id: `hidden-${index}`, parentId: index === 0 ? "huge-2" : `hidden-${index - 1}`, timestamp: "now", customType: "internal", data: { hidden: true } }));
    const shown = message("shown", "hidden-517", "SHOWN");
    const entries: unknown[] = [first, second, ...hidden, shown]; writeFileSync(f.sessionFile, line(header(f.target)) + entries.map(line).join(""));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 };
    for (const page of [loadWorkerSessionViewSnapshot(target), await loadWorkerSessionViewSnapshotAsync(target)]) {
      assert.deepEqual(page.blocks.map((block) => block.text), ["SHOWN"]); assert.equal(page.skippedOversizedEntries, 2); assert.equal(page.hasPreviousPage, false);
    }
  } finally { f.close(); }
});

test("async fallback parses exactly 512 KiB but not a byte-skipped region one byte larger", async () => {
  for (const delta of [0, 1]) {
    const f = fixture();
    try {
      const display = line(message("display", null, "FIRST"));
      const malformedBytes = 512 * 1024 + delta - Buffer.byteLength(display);
      const malformed = `{${"m".repeat(malformedBytes - 2)}\n`;
      assert.equal(Buffer.byteLength(display + malformed), 512 * 1024 + delta);
      const hidden = Array.from({ length: 8 }, (_, index) => line({ type: "custom", id: `hidden-${index}`, parentId: index === 0 ? "display" : `hidden-${index - 1}`, timestamp: "now", customType: "internal", data: { padding: "h".repeat(850 * 1024) } }));
      writeFileSync(f.sessionFile, line(header(f.target)) + display + malformed + hidden.join(""));
      const target = { ...f.target, sessionStartLine: 2, sessionEndLine: hidden.length + 3 };
      const page = await loadWorkerSessionViewSnapshotAsync(target);
      assert.deepEqual(page.blocks.map((block) => block.text), ["FIRST"]);
      assert.equal(page.malformedEntries, delta === 0 ? 1 : 0);
      assert.equal(page.hasPreviousPage, false); assert.equal(page.hasNextPage, false);
    } finally { f.close(); }
  }
});

test("backward fallback derives oversized notices across an over-8-MiB nondisplayed gap", () => {
  const f = fixture();
  try {
    const entries = [line(message("display", null, "FIRST")), line(message("oversized", "display", `OVERSIZED-${"o".repeat(9 * 1024 * 1024)}`))];
    let parentId = "oversized";
    for (let index = 0; index < 10; index += 1) {
      const id = `hidden-${index}`;
      entries.push(line({ type: "custom", id, parentId, timestamp: "now", customType: "internal", data: { padding: "h".repeat(900 * 1024) } })); parentId = id;
    }
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
    assertNondisplayedGapReadBound({ ...f.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 }, 8 * 1024 * 1024);
  } finally { f.close(); }
});

test("alternating oversized backward traversal uses cached offsets within a linear read bound", () => {
  const f = fixture();
  try {
    const entries = [line(message("opening", null, "OPENING"))];
    let parent = "opening";
    for (let index = 0; index < 6; index += 1) {
      entries.push(line(message(`small-${index}`, parent, `SMALL-${index}-${"s".repeat(1024 * 1024)}`))); parent = `small-${index}`;
      entries.push(line(message(`huge-${index}`, parent, `HUGE-${index}-${"h".repeat(9 * 1024 * 1024)}`))); parent = `huge-${index}`;
    }
    entries.push(line(message("last", parent, "LAST")));
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.join(""));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 };
    assertAlternatingOversizedReadBound(target, 96 * 1024 * 1024);
  } finally { f.close(); }
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

test("paging skips windows containing only nondisplayed entries", () => {
  const f = fixture();
  try {
    const hidden = Array.from({ length: 600 }, (_, index) => ({ type: "custom", id: `hidden-${index}`, parentId: index === 0 ? "start" : `hidden-${index - 1}`, timestamp: "now", data: "hidden" }));
    const entries = [message("start", null, "DISPLAY-START"), ...hidden, message("end", "hidden-599", "DISPLAY-END")];
    writeFileSync(f.sessionFile, line(header(f.target)) + entries.map(line).join(""));
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: entries.length + 1 };
    const forward = loadWorkerSessionViewSnapshot(target, {}, { mode: "after", line: 2 });
    assert.deepEqual(forward.blocks.map((block) => block.text), ["DISPLAY-END"]); assert.equal(forward.previousVisibleEntries, 1); assert.equal(forward.nextVisibleEntries, 0);
    const backward = loadWorkerSessionViewSnapshot(target, {}, { mode: "before", line: entries.length + 1 });
    assert.deepEqual(backward.blocks.map((block) => block.text), ["DISPLAY-START"]); assert.equal(backward.previousVisibleEntries, 0); assert.equal(backward.nextVisibleEntries, 1);
  } finally { f.close(); }
});

test("oversized skip notices remain exact after visibility and line-index thinning", async () => {
  const f = fixture();
  try {
    const hidden = Array.from({ length: 70_100 }, (_, index) => line({ type: "custom", id: `hidden-${index}`, parentId: index === 0 ? "start" : `hidden-${index - 1}`, timestamp: "now", data: "hidden" })).join("");
    const entries = line(message("start", null, "DISPLAY-START")) + hidden
      + line(message("huge-1", "hidden-70099", `HUGE-1-${"x".repeat(9 * 1024 * 1024)}`))
      + line(message("huge-2", "huge-1", `HUGE-2-${"x".repeat(9 * 1024 * 1024)}`))
      + line(message("end", "huge-2", "DISPLAY-END"));
    writeFileSync(f.sessionFile, line(header(f.target)) + entries);
    const endLine = 70_105;
    const target = { ...f.target, sessionStartLine: 2, sessionEndLine: endLine };
    for (const value of [loadWorkerSessionViewSnapshot(target, {}, { mode: "before", line: endLine }), await loadWorkerSessionViewSnapshotAsync(target, { mode: "before", line: endLine })]) {
      assert.deepEqual(value.blocks.map((block) => block.text), ["DISPLAY-START"]); assert.equal(value.skippedOversizedEntries, 2);
      assert.equal(value.previousVisibleEntries, 0); assert.equal(value.nextVisibleEntries, 1);
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
