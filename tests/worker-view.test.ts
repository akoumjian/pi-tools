import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { buildWorkerSessionViewerFrame, countSessionLines, createWorkerSessionViewerComponent, loadWorkerSessionViewSnapshot, openWorkerSessionViewer, sanitizeViewText, type WorkerSessionPageRequest, type WorkerSessionViewSnapshot, type WorkerSessionViewTarget, type WorkerSessionViewerState } from "../extensions/worker/view.js";
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
  return { target, blocks, totalActiveEntries: blocks.length, malformedEntries: 0, skippedOversizedEntries: 0, incompleteTrailingEntry: false, hiddenCompactedEntries: 0, compactionCount: 0, runStartLine: target.sessionStartLine ?? 1, runEndLine: target.sessionEndLine ?? target.sessionStartLine ?? 0, pageStartLine: target.sessionStartLine ?? 1, pageEndLine: target.sessionEndLine ?? target.sessionStartLine ?? 0, hasPreviousPage: false, hasNextPage: false, refreshedAt: "now", ...overrides };
}
async function tick() { await new Promise<void>((resolve) => setImmediate(resolve)); }
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
    assert.equal(forward.pages[0]!.hiddenCompactedEntries, 228);
    const frame = buildWorkerSessionViewerFrame(theme, { snapshot: forward.pages[0]!, topLine: 0, pinnedToEnd: false }, 120, 40).lines.join("\n");
    assert.match(frame, /228 earlier run entries are superseded by 1 compaction/);
  } finally { f.close(); }
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
