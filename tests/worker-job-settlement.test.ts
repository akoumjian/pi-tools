import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readStrictWorkerJobMeta, workerJobIsSettled } from "../extensions/_shared/worker-job-settlement.js";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-worker-job-settlement-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function validMeta(jobsDirectory: string, jobId: string): Record<string, unknown> {
  const logDir = path.join(jobsDirectory, jobId);
  return {
    jobId,
    command: "npm test",
    cwd: "/tmp/workspace",
    shell: "/bin/sh",
    status: "cancelled",
    pid: process.pid + 100_000,
    startedAt: "2026-09-22T15:00:00.000Z",
    endedAt: "2026-09-22T15:01:00.000Z",
    notifyOnExit: false,
    completionNotified: false,
    owner: { kind: "worker-run", workerId: "worker-test", runId: "run-test" },
    processToken: "11111111-1111-4111-8111-111111111111",
    logDir,
    stdoutLog: path.join(logDir, "stdout.log"),
    stderrLog: path.join(logDir, "stderr.log"),
    outputBytes: { stdout: 0, stderr: 0 }
  };
}

async function writeMeta(jobsDirectory: string, jobId: string, meta: Record<string, unknown>): Promise<void> {
  const logDir = path.join(jobsDirectory, jobId);
  await mkdir(logDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(logDir, "stdout.log"), ""),
    writeFile(path.join(logDir, "stderr.log"), ""),
    writeFile(path.join(logDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`)
  ]);
}

test("shared worker job settlement validation is strict for admission and host settlement", async () => {
  await withTempDir(async (directory) => {
    const jobsDirectory = path.join(directory, "jobs");
    const jobId = "job_20260922150000_settle1";
    const base = validMeta(jobsDirectory, jobId);
    await writeMeta(jobsDirectory, jobId, base);
    assert.equal(workerJobIsSettled(readStrictWorkerJobMeta(jobsDirectory, jobId)), true);

    const invalidCases: Array<[string, Record<string, unknown>]> = [
      ["leading-space owner", { ...base, owner: { kind: "worker-run", workerId: " worker-test", runId: "run-test" } }],
      ["blank run owner", { ...base, owner: { kind: "worker-run", workerId: "worker-test", runId: " " } }],
      ["blank token", { ...base, processToken: " " }],
      ["non-UUID token", { ...base, processToken: "dead-token" }],
      ["array log path", { ...base, logDir: [path.join(jobsDirectory, jobId)] }],
      ["noncanonical stdout path", { ...base, stdoutLog: `${path.join(jobsDirectory, jobId)}/./stdout.log` }],
      ["missing PID", { ...base, pid: undefined }],
      ["out-of-range PID", { ...base, pid: 2 ** 40 }],
      ["mismatched job ID", { ...base, jobId: "job_20260922150000_other001" }]
    ];
    for (const [name, candidate] of invalidCases) {
      await writeMeta(jobsDirectory, jobId, candidate);
      assert.throws(() => readStrictWorkerJobMeta(jobsDirectory, jobId), /invalid metadata|unverifiable ownership/, name);
    }

    await writeMeta(jobsDirectory, jobId, { ...base, notifyOnExit: true, completionNotified: false });
    assert.equal(workerJobIsSettled(readStrictWorkerJobMeta(jobsDirectory, jobId)), false);
    await writeMeta(jobsDirectory, jobId, { ...base, status: "unknown" });
    assert.equal(workerJobIsSettled(readStrictWorkerJobMeta(jobsDirectory, jobId)), false);
  });
});
