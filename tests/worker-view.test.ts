import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { buildWorkerSessionViewerFrame, createWorkerSessionViewerComponent, loadWorkerSessionViewSnapshot, openWorkerSessionViewer, sanitizeViewText, type WorkerSessionViewSnapshot, type WorkerSessionViewTarget, type WorkerSessionViewerState } from "../extensions/worker/view.js";

function fixture(rootOverride?: string) {
  const root = rootOverride ?? mkdtempSync(path.join(tmpdir(), "worker-view-"));
  const workerRoot = path.join(root, "worker");
  const workspaceRoot = path.join(workerRoot, "workspace");
  const sessionRoot = path.join(workerRoot, "session");
  const sessionFile = path.join(sessionRoot, "worker.jsonl");
  const parentSessionFile = path.join(root, "parent.jsonl");
  mkdirSync(workspaceRoot, { recursive: true }); mkdirSync(sessionRoot, { recursive: true });
  writeFileSync(parentSessionFile, "parent\n");
  const target: WorkerSessionViewTarget = { workerId: "worker_20260101000000_aaaaaaaa", role: "work", workerStatus: "idle", runId: "run_20260101000000_bbbbbbbb", runStatus: "settled", outcome: "completed", modelSelection: "openai-codex/gpt-5.6-sol:xhigh", sessionId: "session-test", sessionFile, workspaceRoot, parentSessionFile, sessionStartLine: 2, sessionEndLine: 2 };
  return { root, sessionFile, target, close: () => rmSync(root, { recursive: true, force: true }) };
}

function header(target: WorkerSessionViewTarget, overrides: Record<string, unknown> = {}) { return { type: "session", version: 3, id: target.sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: target.workspaceRoot, parentSession: target.parentSessionFile, ...overrides }; }
function message(id: string, parentId: string | null, content: string, extra: Record<string, unknown> = {}) { return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content, ...extra } }; }
function line(value: unknown): string { return `${JSON.stringify(value)}\n`; }

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

test("worker conversation view renders the exact active compacted run branch without raw JSONL", () => {
  const f = fixture();
  try {
    const user = { type: "message", id: "u1", parentId: "outside-range", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "old question" } };
    const kept = { type: "message", id: "u2", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "kept question" } };
    const compaction = { type: "compaction", id: "c1", parentId: "u2", timestamp: "2026-01-01T00:00:03.000Z", summary: "Earlier work summary", firstKeptEntryId: "u2", tokensBefore: 1200 };
    const assistant = { type: "message", id: "a1", parentId: "c1", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", content: [{ type: "thinking", thinking: "check carefully" }, { type: "toolCall", name: "search_many", arguments: { pattern: "x" } }, { type: "text", text: "done" }] } };
    const result = { type: "message", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "toolResult", toolName: "search_many", isError: false, content: [{ type: "text", text: "match" }] } };
    writeFileSync(f.sessionFile, line(header(f.target)) + line(user) + line(kept) + line(compaction) + "{bad json}\n" + line(assistant) + line(result) + "{still-writing");
    const snapshot = loadWorkerSessionViewSnapshot({ ...f.target, sessionStartLine: 2, sessionEndLine: 7 });
    assert.equal(snapshot.malformedEntries, 1); assert.equal(snapshot.incompleteTrailingEntry, false);
    assert.deepEqual(snapshot.blocks.map((block) => block.kind), ["compaction", "user", "thinking", "tool", "assistant", "toolResult"]);
    assert.equal(snapshot.blocks.some((block) => block.text.includes("old question")), false);
    const frame = buildWorkerSessionViewerFrame(theme, { snapshot, topLine: 0, pinnedToEnd: false }, 100, 40);
    const rendered = frame.lines.join("\n");
    assert.match(rendered, /Managed worker conversation/); assert.match(rendered, /Earlier work summary/); assert.match(rendered, /Tool call · search_many/); assert.doesNotMatch(rendered, /"type":"message"/);
  } finally { f.close(); }
});

test("worker conversation view streams a small exact range after a large inherited parent prefix", () => {
  const f = fixture();
  try {
    const inherited: string[] = [];
    for (let index = 0; index < 5_000; index += 1) inherited.push(line(message(`old-${index}`, index === 0 ? null : `old-${index - 1}`, `inherited-${index}-${"x".repeat(1024)}`)));
    const currentLine = 5_002;
    writeFileSync(f.sessionFile, line(header(f.target)) + inherited.join("") + line(message("current", "old-4999", "current worker run")));
    const snapshot = loadWorkerSessionViewSnapshot({ ...f.target, sessionStartLine: currentLine, sessionEndLine: currentLine });
    assert.ok(Buffer.byteLength(inherited.join("")) > 4 * 1024 * 1024);
    assert.deepEqual(snapshot.blocks.map((block) => block.text), ["current worker run"]);
  } finally { f.close(); }
});

test("worker conversation view limits resumed sessions and treats parent links outside the range as its branch boundary", () => {
  const f = fixture();
  try {
    writeFileSync(f.sessionFile, line(header(f.target)) + line(message("u1", null, "inherited parent history")) + line(message("u2", "u1", "current worker run")) + line(message("u3", "u1", "later branched run")));
    const snapshot = loadWorkerSessionViewSnapshot({ ...f.target, sessionStartLine: 3, sessionEndLine: 3 });
    assert.deepEqual(snapshot.blocks.map((block) => block.text), ["current worker run"]);
  } finally { f.close(); }
});

test("worker conversation view rejects symlink, oversized selected range, invalid UTF-8, duplicate ids, and cycles", () => {
  const f = fixture();
  try {
    const real = path.join(path.dirname(f.sessionFile), "real.jsonl"); writeFileSync(real, line(header(f.target))); symlinkSync(real, f.sessionFile);
    assert.throws(() => loadWorkerSessionViewSnapshot(f.target), /symbolic link/);
    rmSync(f.sessionFile); writeFileSync(f.sessionFile, line(header(f.target)) + line(message("large", null, "x".repeat(4 * 1024 * 1024))));
    assert.throws(() => loadWorkerSessionViewSnapshot(f.target), /session range exceeds/);
    writeFileSync(f.sessionFile, Buffer.concat([Buffer.from(line(header(f.target))), Buffer.from([0xff, 0x0a])]));
    assert.throws(() => loadWorkerSessionViewSnapshot(f.target), /not valid UTF-8/);
    writeFileSync(f.sessionFile, line(header(f.target)) + line(message("same", null, "one")) + line(message("same", "same", "two")));
    assert.throws(() => loadWorkerSessionViewSnapshot({ ...f.target, sessionEndLine: 3 }), /duplicate entry ids/);
    writeFileSync(f.sessionFile, line(header(f.target)) + line(message("a", "b", "one")) + line(message("b", "a", "two")));
    assert.throws(() => loadWorkerSessionViewSnapshot({ ...f.target, sessionEndLine: 3 }), /cycle/);
  } finally { f.close(); }
});

test("worker conversation view retries append growth and rejects FIFO and replacement races without blocking", () => {
  const f = fixture();
  try {
    writeFileSync(f.sessionFile, line(header(f.target)) + line(message("one", null, "one")));
    let appended = false;
    const snapshot = loadWorkerSessionViewSnapshot({ ...f.target, runStatus: "running", workerStatus: "running", outcome: undefined, sessionEndLine: undefined }, { afterReadAttempt(file, attempt) { if (attempt === 0 && !appended) { appended = true; writeFileSync(file, line(message("two", "one", "two")), { flag: "a" }); } } });
    assert.deepEqual(snapshot.blocks.map((block) => block.text), ["one", "two"]);

    let swapped = false;
    assert.throws(() => loadWorkerSessionViewSnapshot(f.target, { beforeOpen(file) { if (!swapped) { swapped = true; rmSync(file); execFileSync("mkfifo", [file]); } } }), /regular file/);
    rmSync(f.sessionFile, { force: true }); writeFileSync(f.sessionFile, line(header(f.target)) + line(message("one", null, "one")));
    assert.throws(() => loadWorkerSessionViewSnapshot(f.target, { afterReadAttempt(file) { const next = `${file}.next`; writeFileSync(next, line(header(f.target)) + line(message("other", null, "other"))); renameSync(next, file); } }), /changed while reading/);
  } finally { f.close(); }
});

test("worker conversation view validates hostile headers without resolving or surfacing worker-controlled paths", async () => {
  const f = fixture();
  try {
    const hostile = "\u001b]52;c;Y2xpcGJvYXJk\u0007/net/host\u001b[2J";
    writeFileSync(f.sessionFile, line(header(f.target, { cwd: hostile })) + line(message("one", null, "one")));
    assert.throws(() => loadWorkerSessionViewSnapshot(f.target), (error: unknown) => error instanceof Error && error.message === "Worker session workspace mismatch." && !error.message.includes("\u001b"));
    writeFileSync(f.sessionFile, line(header(f.target, { version: hostile })) + line(message("one", null, "one")));
    const notifications: string[] = [];
    const context = { hasUI: true, mode: "tui", ui: { notify(value: string) { notifications.push(value); } } } as unknown as ExtensionCommandContext;
    await openWorkerSessionViewer(context, f.target);
    assert.deepEqual(notifications, ["Worker session header is invalid."]);
    assert.equal(notifications[0]!.includes("\u001b"), false);
  } finally { f.close(); }
});

test("worker conversation view renders provider errors and aborts and normalizes CRLF", () => {
  const f = fixture();
  try {
    const failed = { type: "message", id: "failed", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", provider: "evil\u001b[31m", model: "model", content: [], stopReason: "error", errorMessage: "provider\u001b]52;c;eA==\u0007 failed\r\nnext" } };
    const aborted = { type: "message", id: "aborted", parentId: "failed", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [], stopReason: "aborted" } };
    writeFileSync(f.sessionFile, line(header(f.target)) + line(failed) + line(aborted));
    const snapshot = loadWorkerSessionViewSnapshot({ ...f.target, sessionEndLine: 3 });
    assert.deepEqual(snapshot.blocks.map((block) => block.kind), ["error", "error"]);
    const rendered = buildWorkerSessionViewerFrame(theme, { snapshot, topLine: 0, pinnedToEnd: false }, 100, 40).lines.join("\n");
    assert.match(rendered, /Provider error/); assert.match(rendered, /Provider aborted/); assert.doesNotMatch(rendered, /\u001b|�\nnext/);
  } finally { f.close(); }
});

test("worker conversation view works through a symlinked temporary root", () => {
  const realRoot = mkdtempSync(path.join(tmpdir(), "worker-view-real-"));
  const alias = `${realRoot}-alias`; symlinkSync(realRoot, alias, "dir");
  const f = fixture(alias);
  try {
    writeFileSync(f.sessionFile, line(header(f.target)) + line(message("one", null, "portable")));
    assert.deepEqual(loadWorkerSessionViewSnapshot(f.target).blocks.map((block) => block.text), ["portable"]);
  } finally { f.close(); rmSync(alias, { force: true }); rmSync(realRoot, { recursive: true, force: true }); }
});

test("worker conversation rendering caches wrapped bodies and refreshes target status only on demand", () => {
  let boldCalls = 0;
  const countingTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => { boldCalls += 1; return text; } } as Theme;
  const f = fixture();
  try {
    const initial: WorkerSessionViewSnapshot = { target: { ...f.target, runStatus: "running", workerStatus: "running", outcome: undefined, sessionEndLine: undefined }, blocks: Array.from({ length: 300 }, (_, index) => ({ kind: "assistant" as const, label: `Assistant ${index}`, timestamp: "now", text: "x".repeat(16 * 1024) })), totalActiveEntries: 300, omittedEntries: 0, malformedEntries: 0, incompleteTrailingEntry: false, refreshedAt: "first" };
    const settled: WorkerSessionViewSnapshot = { ...initial, target: { ...f.target, runStatus: "settled", workerStatus: "idle", outcome: "completed", sessionEndLine: 42 }, blocks: [{ kind: "assistant", label: "Assistant", timestamp: "now", text: "done" }], totalActiveEntries: 1, refreshedAt: "second" };
    const state: WorkerSessionViewerState = { snapshot: initial, topLine: 0, pinnedToEnd: false };
    buildWorkerSessionViewerFrame(countingTheme, state, 80, 40); const firstCalls = boldCalls;
    buildWorkerSessionViewerFrame(countingTheme, state, 80, 40); assert.equal(boldCalls - firstCalls, 1, "second frame wraps only the small header");

    let refreshes = 0; let renders = 0;
    const component = createWorkerSessionViewerComponent({ tui: { terminal: { rows: 40 }, requestRender() { renders += 1; } } as never, getTheme: () => theme, initialSnapshot: initial, loadSnapshot: () => { refreshes += 1; return settled; }, done() {} });
    assert.match(component.render(100).join("\n"), /running/); component.handleInput!("r"); assert.equal(refreshes, 1); assert.equal(renders, 1); assert.match(component.render(100).join("\n"), /completed/); assert.match(component.render(100).join("\n"), /2\.\.42/);
  } finally { f.close(); }
});

test("worker conversation rendering strips terminal and bidi controls", () => {
  assert.equal(sanitizeViewText("safe\u001b[31mred\u202eevil\u0007"), "safered�evil�");
  assert.equal(sanitizeViewText("one\r\ntwo\r"), "one\ntwo");
});
