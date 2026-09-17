import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  asyncJobOutputBytes,
  createAsyncJobId,
  signalAsyncJobProcessGroup,
  spawnAsyncJobProcess
} from "../extensions/_shared/async-job.js";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-durable-job-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("shared async-job spawn writes directly to canonical log files", async () => {
  await withTempDir(async (directory) => {
    const stdoutLog = path.join(directory, "stdout.log");
    const stderrLog = path.join(directory, "stderr.log");
    const child = spawnAsyncJobProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      cwd: directory,
      env: process.env,
      stdoutLog,
      stderrLog
    });

    const result = await processResult(child);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(await readFile(stdoutLog, "utf8"), "out");
    assert.equal(await readFile(stderrLog, "utf8"), "err");
    assert.deepEqual(asyncJobOutputBytes(stdoutLog, stderrLog), { stdout: 3, stderr: 3 });
    assert.equal(createAsyncJobId(new Date("2026-09-10T19:00:00Z"), "12345678-rest"), "job_20260910190000_12345678");
  });
});

test("shared async-job signal terminates the detached process group", async () => {
  await withTempDir(async (directory) => {
    const child = spawnAsyncJobProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: directory,
      env: process.env,
      stdoutLog: path.join(directory, "stdout.log"),
      stderrLog: path.join(directory, "stderr.log")
    });
    assert.ok(child.pid);
    signalAsyncJobProcessGroup(child.pid, "SIGTERM");
    const result = await processResult(child);
    assert.equal(result.signal, "SIGTERM");
  });
});

function processResult(child: import("node:child_process").ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
