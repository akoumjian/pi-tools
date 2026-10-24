import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildWorkerSessionViewerFrame, loadWorkerSessionViewSnapshot, sanitizeViewText, type WorkerSessionViewTarget } from "../extensions/worker/view.js";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "worker-view-"));
  const workerRoot = path.join(root, "worker");
  const workspaceRoot = path.join(workerRoot, "workspace");
  const sessionRoot = path.join(workerRoot, "session");
  const sessionFile = path.join(sessionRoot, "worker.jsonl");
  const parentSessionFile = path.join(root, "parent.jsonl");
  mkdirSync(workspaceRoot, { recursive: true }); mkdirSync(sessionRoot, { recursive: true });
  writeFileSync(parentSessionFile, "parent\n");
  const target: WorkerSessionViewTarget = { workerId: "worker_20260101000000_aaaaaaaa", role: "work", workerStatus: "idle", runId: "run_20260101000000_bbbbbbbb", runStatus: "settled", outcome: "completed", modelSelection: "openai-codex/gpt-5.6-sol:xhigh", sessionId: "session-test", sessionFile, workspaceRoot, parentSessionFile, sessionStartLine: 1, sessionEndLine: 100 };
  return { root, sessionFile, target, close: () => rmSync(root, { recursive: true, force: true }) };
}

function line(value: unknown): string { return `${JSON.stringify(value)}\n`; }

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text
} as Theme;

test("worker conversation view renders the active compacted branch without raw JSONL", () => {
  const f = fixture();
  try {
    const header = { type: "session", version: 3, id: "session-test", timestamp: "2026-01-01T00:00:00.000Z", cwd: f.target.workspaceRoot, parentSession: f.target.parentSessionFile };
    const user = { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "old question" } };
    const kept = { type: "message", id: "u2", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "kept question" } };
    const compaction = { type: "compaction", id: "c1", parentId: "u2", timestamp: "2026-01-01T00:00:03.000Z", summary: "Earlier work summary", firstKeptEntryId: "u2", tokensBefore: 1200 };
    const assistant = { type: "message", id: "a1", parentId: "c1", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", content: [{ type: "thinking", thinking: "check carefully" }, { type: "toolCall", name: "search_many", arguments: { pattern: "x" } }, { type: "text", text: "done" }] } };
    const result = { type: "message", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "toolResult", toolName: "search_many", isError: false, content: [{ type: "text", text: "match" }] } };
    writeFileSync(f.sessionFile, line(header) + line(user) + line(kept) + line(compaction) + "{bad json}\n" + line(assistant) + line(result) + "{still-writing");

    const snapshot = loadWorkerSessionViewSnapshot(f.target);
    assert.equal(snapshot.malformedEntries, 1); assert.equal(snapshot.incompleteTrailingEntry, true);
    assert.deepEqual(snapshot.blocks.map((block) => block.kind), ["compaction", "user", "thinking", "tool", "assistant", "toolResult"]);
    assert.equal(snapshot.blocks.some((block) => block.text.includes("old question")), false);
    const frame = buildWorkerSessionViewerFrame(theme, { snapshot, topLine: 0, pinnedToEnd: false }, 100, 40);
    const rendered = frame.lines.join("\n");
    assert.match(rendered, /Managed worker conversation/); assert.match(rendered, /Earlier work summary/); assert.match(rendered, /Tool call · search_many/); assert.doesNotMatch(rendered, /"type":"message"/);
  } finally { f.close(); }
});

test("worker conversation view limits a resumed session to the selected run range", () => {
  const f = fixture();
  try {
    const header = { type: "session", version: 3, id: "session-test", timestamp: "2026-01-01T00:00:00.000Z", cwd: f.target.workspaceRoot, parentSession: f.target.parentSessionFile };
    const inherited = { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "inherited parent history" } };
    const current = { type: "message", id: "u2", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "current worker run" } };
    const laterBranch = { type: "message", id: "u3", parentId: "u1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "later branched run" } };
    writeFileSync(f.sessionFile, line(header) + line(inherited) + line(current) + line(laterBranch));
    const snapshot = loadWorkerSessionViewSnapshot({ ...f.target, sessionStartLine: 3, sessionEndLine: 3 });
    assert.deepEqual(snapshot.blocks.map((block) => block.text), ["current worker run"]);
  } finally { f.close(); }
});

test("worker conversation view rejects symlink and oversized session files", () => {
  const f = fixture();
  try {
    const header = line({ type: "session", version: 3, id: "session-test", timestamp: "2026-01-01T00:00:00.000Z", cwd: f.target.workspaceRoot, parentSession: f.target.parentSessionFile });
    const real = path.join(path.dirname(f.sessionFile), "real.jsonl"); writeFileSync(real, header); symlinkSync(real, f.sessionFile);
    assert.throws(() => loadWorkerSessionViewSnapshot(f.target), /symbolic link/);
    rmSync(f.sessionFile); writeFileSync(f.sessionFile, header + "x".repeat(4 * 1024 * 1024));
    assert.throws(() => loadWorkerSessionViewSnapshot(f.target), /accepts at most/);
  } finally { f.close(); }
});

test("worker conversation rendering strips terminal and bidi controls", () => {
  assert.equal(sanitizeViewText("safe\u001b[31mred\u202eevil\u0007"), "safered�evil�");
});
