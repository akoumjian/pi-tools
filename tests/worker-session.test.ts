import assert from "node:assert/strict";
import { closeSync, ftruncateSync, openSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { forkWorkerSession, readWorkerSessionHeader, readWorkerSessionRange, verifyWorkerSession } from "../extensions/worker/session.js";

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

test("worker session range extraction skips large prefixes and validates the exact selected range", async () => {
  await withTempDir(async (directory) => {
    const session = path.join(directory, "session.jsonl");
    await writeFile(session, `header\n${"x".repeat(2 * 1024 * 1024)}\ntarget\n`);
    assert.equal(readWorkerSessionRange(session, directory, 3, 3), "target\n");
    assert.throws(() => readWorkerSessionRange(session, directory, 3, 4), /range is invalid/);
    const invalid = path.join(directory, "invalid.jsonl");
    await writeFile(invalid, Buffer.from([0xff, 0x0a]));
    assert.throws(() => readWorkerSessionRange(invalid, directory, 1, 1), /not valid UTF-8/);
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


test("retained worker session verification remains bounded beyond Node's maximum string length", async () => {
  await withTempDir(async (directory) => {
    const workspace = path.join(directory, "workspace"); await mkdir(workspace);
    const parent = path.join(directory, "parent.jsonl");
    await writeFile(parent, `${JSON.stringify({ type: "session", version: 3, id: "parent-large", timestamp: new Date().toISOString(), cwd: directory })}\n`);
    const sessionFile = path.join(directory, "worker-large.jsonl");
    const sessionId = "worker-large";
    const header = Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: await realpath(workspace), parentSession: await realpath(parent) })}\n`);
    const fd = openSync(sessionFile, "w+");
    try { writeSync(fd, header, 0, header.length, 0); ftruncateSync(fd, 513 * 1024 * 1024); }
    finally { closeSync(fd); }
    const verified = verifyWorkerSession({ sessionFile, sessionId, workspaceRoot: workspace, parentSessionFile: parent });
    assert.equal(verified.sessionId, sessionId); assert.equal(verified.entries.length, 1); assert.equal(verified.entries[0]!.type, "session");
  });
});

test("retained worker session verification rejects a worker-planted parent-directory symlink", async () => {
  await withTempDir(async (directory) => {
    const parent = path.join(directory, "parent.jsonl"); const workspace = path.join(directory, "workspace"); const sessions = path.join(directory, "sessions");
    await Promise.all([mkdir(workspace), writeFile(parent, `${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd: directory })}\n`)]);
    const forked = forkWorkerSession({ parentSessionFile: parent, workspaceRoot: workspace, sessionDir: sessions, sessionId: "worker-session" });
    const retained = path.join(directory, "retained-sessions"); await rename(sessions, retained); await symlink(retained, sessions, "dir");
    assert.throws(() => verifyWorkerSession(forked), /session directory must be an ordinary directory/);
  });
});

test("canonical session spelling accepts only ordinary paths beneath an alias-spelled retained directory", async () => {
  await withTempDir(async (directory) => {
    const actualPath = path.join(directory, "actual");
    const alias = path.join(directory, "alias");
    await mkdir(path.join(actualPath, "sessions", "retained"), { recursive: true });
    const actual = await realpath(actualPath);
    const retained = path.join(actual, "sessions", "retained");
    await symlink(actual, alias, "dir");
    const session = path.join(retained, "session.jsonl");
    await writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: "worker-session", timestamp: new Date().toISOString(), cwd: actual })}\n`);
    assert.equal(readWorkerSessionHeader(session, { sessionDir: path.join(alias, "sessions") }).header.id, "worker-session");
    await symlink(retained, path.join(actual, "sessions", "linked"), "dir");
    assert.throws(
      () => readWorkerSessionHeader(path.join(actual, "sessions", "linked", "session.jsonl"), { sessionDir: path.join(alias, "sessions") }),
      /must use its retained session directory's requested or canonical spelling/
    );
  });
});
