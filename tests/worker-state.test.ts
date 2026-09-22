import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WORKER_RECORD_VERSION,
  acquireWorkerLease,
  acquireWorkerOperationLock,
  createWorkerId,
  createWorkerRunId,
  provisionWorkerPaths,
  readWorkerRecord,
  releaseWorkerLease,
  releaseWorkerOperationLock,
  workerPaths,
  writeWorkerRecord,
  type WorkerRecord
} from "../extensions/worker/state.js";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-worker-state-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("worker paths are stable, provisioned, and state records round-trip atomically", async () => {
  await withTempDir(async (directory) => {
    const workerId = createWorkerId(new Date("2026-09-10T19:30:00Z"), "abcdef12-rest");
    const runId = createWorkerRunId(new Date("2026-09-10T19:31:00Z"), "12345678-rest");
    assert.equal(workerId, "worker_20260910193000_abcdef12");
    assert.equal(runId, "run_20260910193100_12345678");

    const paths = workerPaths({
      stateRoot: path.join(directory, "workers"),
      workspaceRoot: path.join(directory, "workspaces")
    }, workerId);
    provisionWorkerPaths(paths);
    for (const created of [paths.sessionDir, paths.reposDir, paths.scratchDir, paths.cacheDir, paths.artifactsDir, paths.tempDir]) {
      assert.equal((await stat(created)).isDirectory(), true);
    }

    const record: WorkerRecord = {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "019c-session",
      parentSessionFile: "/tmp/parent.jsonl",
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-test"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "queued",
      activeRun: { runId, jobId: "job_1", status: "queued" },
      updatedAt: "2026-09-10T19:31:00.000Z"
    };
    writeWorkerRecord(paths.recordFile, record);
    assert.deepEqual(readWorkerRecord(paths.recordFile), record);

    const invalid = {
      ...record,
      initialRepositories: [{ source: "/tmp/source", status: "unsupported" as const, issue: "x".repeat(161) }]
    };
    assert.throws(() => writeWorkerRecord(paths.recordFile, invalid), /Invalid worker record/);
    assert.deepEqual(readWorkerRecord(paths.recordFile), record);
  });
});

test("worker run leases enforce one owner with exclusive creation", async () => {
  await withTempDir(async (directory) => {
    const paths = workerPaths({ stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") }, "worker_20260910193000_lease001");
    provisionWorkerPaths(paths);
    const lease = {
      version: 1 as const,
      workerId: "worker_20260910193000_lease001",
      runId: "run_20260910193100_lease001",
      parentPid: process.pid,
      acquiredAt: "2026-09-10T19:31:00.000Z"
    };
    acquireWorkerLease(paths.leaseFile, lease);
    assert.throws(() => acquireWorkerLease(paths.leaseFile, { ...lease, parentPid: process.pid + 1 }), /active run lease/);
    assert.throws(() => releaseWorkerLease(paths.leaseFile, lease.workerId, "run-wrong"), /mismatched worker lease/);
    releaseWorkerLease(paths.leaseFile, lease.workerId, lease.runId);
    assert.equal(existsSync(paths.leaseFile), false);
  });
});

test("worker lifecycle operation lock excludes another process and safely replaces its stale lock", async () => {
  await withTempDir(async (directory) => {
    const lockFile = path.join(directory, "workers", ".locks", "worker-test.lock");
    const marker = path.join(directory, "holder-ready");
    const stateModule = new URL("../extensions/worker/state.js", import.meta.url).href;
    const holder = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `import{writeFileSync}from'node:fs';import{acquireWorkerOperationLock}from${JSON.stringify(stateModule)};acquireWorkerOperationLock(${JSON.stringify(lockFile)},'child-owner');writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`
    ], { stdio: "ignore" });
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await readFile(marker, "utf8"), "ready");
    assert.throws(() => acquireWorkerOperationLock(lockFile, "parent-contender"), /already active/);
    holder.kill("SIGKILL");
    await new Promise<void>((resolve) => holder.once("close", () => resolve()));
    const recovered = acquireWorkerOperationLock(lockFile, "parent-recovery");
    releaseWorkerOperationLock(recovered);
  });
});

test("concurrent stale operation-lock reclaimers admit exactly one owner", async () => {
  await withTempDir(async (directory) => {
    const lockFile = path.join(directory, "workers", ".locks", "worker-race.lock");
    const staleReady = path.join(directory, "stale-ready");
    const gate = path.join(directory, "reclaim-gate");
    const stateModule = new URL("../extensions/worker/state.js", import.meta.url).href;
    const staleHolder = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `import{writeFileSync}from'node:fs';import{acquireWorkerOperationLock}from${JSON.stringify(stateModule)};acquireWorkerOperationLock(${JSON.stringify(lockFile)},'stale-owner');writeFileSync(${JSON.stringify(staleReady)},'ready');setInterval(()=>{},1000)`
    ], { stdio: "ignore" });
    for (let attempt = 0; attempt < 200 && !existsSync(staleReady); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    staleHolder.kill("SIGKILL");
    await new Promise<void>((resolve) => staleHolder.once("close", () => resolve()));

    const results = [path.join(directory, "result-a"), path.join(directory, "result-b")];
    const contenders = results.map((result, index) => spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `import{existsSync,writeFileSync}from'node:fs';import{acquireWorkerOperationLock,releaseWorkerOperationLock}from${JSON.stringify(stateModule)};while(!existsSync(${JSON.stringify(gate)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);try{const lock=acquireWorkerOperationLock(${JSON.stringify(lockFile)},${JSON.stringify(`contender-${index}`)});writeFileSync(${JSON.stringify(result)},'acquired');await new Promise(r=>setTimeout(r,400));releaseWorkerOperationLock(lock)}catch{writeFileSync(${JSON.stringify(result)},'blocked')}`
    ], { stdio: "ignore" }));
    await writeFile(gate, "go");
    await Promise.all(contenders.map((child) => new Promise<void>((resolve) => child.once("close", () => resolve()))));
    const outcomes = (await Promise.all(results.map((result) => readFile(result, "utf8")))).sort();
    assert.deepEqual(outcomes, ["acquired", "blocked"]);
  });
});

test("worker path derivation rejects path-shaped identities", () => {
  assert.throws(() => workerPaths({ stateRoot: "/tmp/a", workspaceRoot: "/tmp/b" }, "../escape"), /Invalid worker id/);
});
