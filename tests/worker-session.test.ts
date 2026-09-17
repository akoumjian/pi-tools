import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { forkWorkerSession, verifyWorkerSession } from "../extensions/worker/session.js";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-worker-session-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("worker session forks exact parent entries into the assigned workspace and session id", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const workspaceRoot = path.join(directory, "workspace");
    const sessionDir = path.join(directory, "worker-sessions");
    await Promise.all([mkdir(parentCwd), mkdir(workspaceRoot)]);
    const parentSessionFile = path.join(directory, "parent.jsonl");
    const parentEntries = [
      {
        type: "session",
        version: 3,
        id: "parent-session",
        timestamp: "2026-09-10T19:00:00.000Z",
        cwd: parentCwd
      },
      {
        type: "custom",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-09-10T19:00:01.000Z",
        customType: "test-parent-turn",
        data: { complete: true }
      }
    ];
    await writeFile(parentSessionFile, `${parentEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const forked = forkWorkerSession({
      parentSessionFile,
      workspaceRoot,
      sessionDir,
      sessionId: "worker-session-1"
    });
    const canonicalWorkspace = await realpath(workspaceRoot);
    const canonicalParent = await realpath(parentSessionFile);

    assert.equal(forked.sessionId, "worker-session-1");
    assert.equal(forked.workspaceRoot, canonicalWorkspace);
    assert.equal(forked.parentSessionFile, canonicalParent);
    assert.equal(forked.entries.length, 2);
    assert.deepEqual(forked.entries[1], parentEntries[1]);

    const lines = (await readFile(forked.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].id, "worker-session-1");
    assert.equal(lines[0].cwd, canonicalWorkspace);
    assert.equal(lines[0].parentSession, canonicalParent);
    assert.deepEqual(lines.slice(1), parentEntries.slice(1));
  });
});

test("exact worker session verification rejects wrong session, cwd, and parent", async () => {
  await withTempDir(async (directory) => {
    const parent = path.join(directory, "parent.jsonl");
    const otherParent = path.join(directory, "other-parent.jsonl");
    const workspace = path.join(directory, "workspace");
    const otherWorkspace = path.join(directory, "other-workspace");
    const sessions = path.join(directory, "sessions");
    await Promise.all([
      mkdir(workspace),
      mkdir(otherWorkspace),
      writeFile(parent, `${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd: directory })}\n`),
      writeFile(otherParent, `${JSON.stringify({ type: "session", version: 3, id: "other", timestamp: new Date().toISOString(), cwd: directory })}\n`)
    ]);
    const forked = forkWorkerSession({
      parentSessionFile: parent,
      workspaceRoot: workspace,
      sessionDir: sessions,
      sessionId: "worker-session"
    });

    assert.throws(() => verifyWorkerSession({ ...forked, sessionId: "wrong" }), /session id mismatch/);
    assert.throws(() => verifyWorkerSession({ ...forked, workspaceRoot: otherWorkspace }), /session cwd mismatch/);
    assert.throws(() => verifyWorkerSession({ ...forked, parentSessionFile: otherParent }), /session parent mismatch/);
  });
});
