import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { defaultWorkerExtensionPaths, launchWorkerHost } from "../extensions/worker/runner.js";
import { readWorkerRuntimeHandoff } from "../extensions/worker/runtime.js";
import { forkWorkerSession } from "../extensions/worker/session.js";
import { WORKER_RECORD_VERSION, type WorkerRecord } from "../extensions/worker/state.js";

const TEST_BEADS_ROUTE = { prefix: "personal" as const, path: "/test/central-beads", databasePath: "/test/central-beads/database" };

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-worker-host-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForPath(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!existsSync(filePath)) throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses" as const,
    provider: "openai",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop" as const,
    timestamp: Date.now()
  };
}

test("worker host completes an exact-fork fake-provider run while ignoring workspace startup poison", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionDir = path.join(directory, "parent-sessions");
    const workspaceRoot = path.join(directory, "workspace");
    const stateDir = path.join(directory, "state");
    const sessionDir = path.join(stateDir, "session");
    const runDir = path.join(stateDir, "runs", "run-test");
    const resultFile = path.join(runDir, "result.json");
    await Promise.all([
      mkdir(parentCwd, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
      mkdir(path.join(workspaceRoot, ".pi", "extensions"), { recursive: true })
    ]);

    const parent = SessionManager.create(parentCwd, parentSessionDir, { id: "parent-session-e2e" });
    parent.appendMessage({ role: "user", content: "PARENT_EXACT_MARKER", timestamp: Date.now() });
    parent.appendMessage(assistantMessage("The exact parent marker is durable."));
    const parentSessionFile = parent.getSessionFile();
    assert.ok(parentSessionFile);
    const forked = forkWorkerSession({
      parentSessionFile,
      workspaceRoot,
      sessionDir,
      sessionId: "worker-session-e2e"
    });

    await Promise.all([
      writeFile(path.join(workspaceRoot, ".pi", "SYSTEM.md"), "WORKSPACE_SYSTEM_POISON\n"),
      writeFile(path.join(workspaceRoot, ".pi", "APPEND_SYSTEM.md"), "WORKSPACE_SYSTEM_POISON\n"),
      writeFile(path.join(workspaceRoot, ".pi", "settings.json"), `${JSON.stringify({ extensions: [".pi/extensions/poison.ts"] })}\n`),
      writeFile(path.join(workspaceRoot, ".pi", "extensions", "poison.ts"), "import { writeFileSync } from 'node:fs'; writeFileSync('poison-loaded', 'yes'); export default function() {}\n")
    ]);

    const record: WorkerRecord = {
      version: WORKER_RECORD_VERSION,
      workerId: "worker_20260910200000_e2etest1",
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      parentSessionFile,
      workspaceRoot,
      taskIds: ["personal-workere2e"],
      route: { provider: "worker-faux", model: "worker-faux-1", thinkingLevel: "off" },
      status: "running",
      activeRun: { runId: "run-test", jobId: "job_20260910200000_e2etest1", status: "running" },
      updatedAt: new Date().toISOString()
    };
    const fakeProviderExtension = fileURLToPath(new URL("./fixtures/worker-faux-provider.js", import.meta.url));
    const api = { sendMessage(): void {} } as unknown as ExtensionAPI;
    const context = {
      cwd: parentCwd,
      sessionManager: { getSessionId: () => "parent-session-e2e" },
      isIdle: () => true
    } as ExtensionContext;
    const launched = launchWorkerHost(api, context, {
      record,
      shellExecution: { kind: "native-test" },
      prompt: "WORKER_PROMPT_MARKER: verify the managed worker lifecycle.",
      resultFile,
      runDir,
      processFile: path.join(runDir, "host-process.json"),
      processNonce: "host-process-e2e",
      bdPath: process.execPath,
      beadsRoute: TEST_BEADS_ROUTE,
      jobId: record.activeRun!.jobId,
      timeoutMs: 30_000,
      extensionPaths: [...defaultWorkerExtensionPaths(), fakeProviderExtension]
    });
    const config = JSON.parse(await readFile(launched.configFile, "utf8")) as { extensionPaths: string[]; rpcArgs: string[] };
    assert.ok(config.extensionPaths.includes(fakeProviderExtension));
    assert.ok(config.rpcArgs.includes(fakeProviderExtension));

    const keepAlive = setInterval(() => {}, 100);
    const job = await launched.handle.completion.finally(() => clearInterval(keepAlive));
    assert.equal(job.status, "exited", await readFile(job.stderrLog, "utf8"));
    assert.equal(job.exitCode, 0);

    const accepted = readWorkerRuntimeHandoff(resultFile);
    assert.equal(accepted.workerId, record.workerId);
    assert.equal(accepted.runId, "run-test");
    assert.equal(accepted.handoff.state, "assignment_complete");
    assert.match(accepted.handoff.summary, /verified the exact fork/);
    assert.match(JSON.stringify(accepted.handoff.taskUpdates), /exactParentContext.*true/);
    assert.equal(existsSync(path.join(workspaceRoot, "poison-loaded")), false);
    assert.equal(existsSync(path.join(workspaceRoot, "post-handoff-side-effect")), false);
    const workerSession = await readFile(forked.sessionFile, "utf8");
    assert.match(workerSession, /PARENT_EXACT_MARKER/);
    assert.match(workerSession, /WORKER_PROMPT_MARKER/);
    assert.doesNotMatch(workerSession, /WORKSPACE_SYSTEM_POISON/);
  });
});

test("worker host waits for the settled follow-up turn after asynchronous shell completion", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const workspaceRoot = path.join(directory, "workspace");
    const stateDir = path.join(directory, "state");
    const sessionDir = path.join(stateDir, "session");
    const runDir = path.join(stateDir, "runs", "run-multiturn");
    const resultFile = path.join(runDir, "result.json");
    await Promise.all([
      mkdir(parentCwd, { recursive: true }),
      mkdir(path.join(workspaceRoot, "cache", "config"), { recursive: true }),
      mkdir(path.join(workspaceRoot, "cache", "data"), { recursive: true }),
      mkdir(path.join(workspaceRoot, "cache", "state"), { recursive: true }),
      mkdir(path.join(workspaceRoot, "tmp"), { recursive: true }),
      mkdir(sessionDir, { recursive: true })
    ]);
    const parent = SessionManager.create(parentCwd, path.join(directory, "parent-sessions"), { id: "parent-session-multiturn" });
    parent.appendMessage({ role: "user", content: "parent multiturn context", timestamp: Date.now() });
    parent.appendMessage(assistantMessage("Ready for a multiturn run."));
    const parentSessionFile = parent.getSessionFile();
    assert.ok(parentSessionFile);
    const forked = forkWorkerSession({ parentSessionFile, workspaceRoot, sessionDir, sessionId: "worker-session-multiturn" });
    const record: WorkerRecord = {
      version: WORKER_RECORD_VERSION,
      workerId: "worker_20260910200000_multit01",
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      parentSessionFile,
      workspaceRoot,
      taskIds: ["personal-workere2e"],
      route: { provider: "worker-multiturn-faux", model: "worker-multiturn-faux-1", thinkingLevel: "off" },
      status: "running",
      activeRun: { runId: "run-multiturn", jobId: "job_20260910200000_multit01", status: "running" },
      updatedAt: new Date().toISOString()
    };
    const providerExtension = fileURLToPath(new URL("./fixtures/worker-multiturn-faux-provider.js", import.meta.url));
    const launched = launchWorkerHost({ sendMessage(): void {} } as unknown as ExtensionAPI, {
      cwd: parentCwd,
      sessionManager: { getSessionId: () => "parent-session-multiturn" },
      isIdle: () => true
    } as ExtensionContext, {
      record,
      shellExecution: { kind: "native-test" },
      prompt: "Complete the multiturn lifecycle.",
      resultFile,
      runDir,
      processFile: path.join(runDir, "host-process.json"),
      processNonce: "host-process-multiturn",
      bdPath: process.execPath,
      beadsRoute: TEST_BEADS_ROUTE,
      jobId: record.activeRun!.jobId,
      timeoutMs: 30_000,
      extensionPaths: [...defaultWorkerExtensionPaths(), providerExtension]
    });
    const keepAlive = setInterval(() => {}, 100);
    const job = await launched.handle.completion.finally(() => clearInterval(keepAlive));
    assert.equal(job.status, "exited", await readFile(job.stderrLog, "utf8"));
    assert.equal(job.exitCode, 0);
    assert.equal(readWorkerRuntimeHandoff(resultFile).handoff.state, "assignment_complete");
    assert.ok(existsSync(path.join(runDir, "settled.json")));
  });
});

test("cancelling a worker host leaves no worker-owned async-shell process alive", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const workspaceRoot = path.join(directory, "workspace");
    const stateDir = path.join(directory, "state");
    const sessionDir = path.join(stateDir, "session");
    const runDir = path.join(stateDir, "runs", "run-cancel");
    const resultFile = path.join(runDir, "result.json");
    await Promise.all([
      mkdir(parentCwd, { recursive: true }),
      mkdir(path.join(workspaceRoot, "cache", "config"), { recursive: true }),
      mkdir(path.join(workspaceRoot, "cache", "data"), { recursive: true }),
      mkdir(path.join(workspaceRoot, "cache", "state"), { recursive: true }),
      mkdir(path.join(workspaceRoot, "tmp"), { recursive: true }),
      mkdir(sessionDir, { recursive: true })
    ]);
    const parent = SessionManager.create(parentCwd, path.join(directory, "parent-sessions"), { id: "parent-session-cancel" });
    parent.appendMessage({ role: "user", content: "parent cancellation context", timestamp: Date.now() });
    parent.appendMessage(assistantMessage("Ready for a cancellation run."));
    const parentSessionFile = parent.getSessionFile();
    assert.ok(parentSessionFile);
    const forked = forkWorkerSession({
      parentSessionFile,
      workspaceRoot,
      sessionDir,
      sessionId: "worker-session-cancel"
    });
    const record: WorkerRecord = {
      version: WORKER_RECORD_VERSION,
      workerId: "worker_20260910200000_cancel01",
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      parentSessionFile,
      workspaceRoot,
      taskIds: ["personal-workere2e"],
      route: { provider: "worker-cancel-faux", model: "worker-cancel-faux-1", thinkingLevel: "off" },
      status: "running",
      activeRun: { runId: "run-cancel", jobId: "job_20260910200000_cancel01", status: "running" },
      updatedAt: new Date().toISOString()
    };
    const providerExtension = fileURLToPath(new URL("./fixtures/worker-cancel-faux-provider.js", import.meta.url));
    const api = { sendMessage(): void {} } as unknown as ExtensionAPI;
    const context = {
      cwd: parentCwd,
      sessionManager: { getSessionId: () => "parent-session-cancel" },
      isIdle: () => true
    } as ExtensionContext;
    const launched = launchWorkerHost(api, context, {
      record,
      shellExecution: { kind: "native-test" },
      prompt: "Start the cancellation probe.",
      resultFile,
      runDir,
      processFile: path.join(runDir, "host-process.json"),
      processNonce: "host-process-cancel",
      bdPath: process.execPath,
      beadsRoute: TEST_BEADS_ROUTE,
      jobId: record.activeRun!.jobId,
      timeoutMs: 30_000,
      extensionPaths: [...defaultWorkerExtensionPaths(), providerExtension]
    });
    const marker = path.join(workspaceRoot, "owned-shell.pid");
    try {
      try {
        await waitForPath(marker, 10_000);
      } catch (error) {
        const snapshot = launched.handle.snapshot();
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout:\n${await readFile(snapshot.stdoutLog, "utf8")}\nstderr:\n${await readFile(snapshot.stderrLog, "utf8")}`);
      }
      const ownedPid = Number.parseInt((await readFile(marker, "utf8")).trim(), 10);
      assert.ok(Number.isInteger(ownedPid) && ownedPid > 0);
      launched.handle.cancel("SIGTERM");
      const keepAlive = setInterval(() => {}, 100);
      const job = await launched.handle.completion.finally(() => clearInterval(keepAlive));
      assert.equal(job.status, "cancelled");
      assert.equal(await waitForPidExit(ownedPid, 5_000), true, `worker-owned process ${ownedPid} survived cancellation`);
      assert.equal(existsSync(resultFile), false);
    } finally {
      if (launched.handle.snapshot().status === "running") launched.handle.cancel("SIGKILL");
    }

    await rm(marker, { force: true });
    const timeoutRunDir = path.join(stateDir, "runs", "run-timeout");
    const timeoutRecord: WorkerRecord = {
      ...record,
      activeRun: { runId: "run-timeout", jobId: "job_20260910200000_timeout1", status: "running" }
    };
    const timedOut = launchWorkerHost(api, context, {
      record: timeoutRecord,
      shellExecution: { kind: "native-test" },
      prompt: "Start the timeout cleanup probe.",
      resultFile: path.join(timeoutRunDir, "result.json"),
      runDir: timeoutRunDir,
      processFile: path.join(timeoutRunDir, "host-process.json"),
      processNonce: "host-process-timeout",
      bdPath: process.execPath,
      beadsRoute: TEST_BEADS_ROUTE,
      jobId: timeoutRecord.activeRun!.jobId,
      timeoutMs: 1_000,
      extensionPaths: [...defaultWorkerExtensionPaths(), providerExtension]
    });
    await waitForPath(marker, 10_000);
    const timeoutOwnedPid = Number.parseInt((await readFile(marker, "utf8")).trim(), 10);
    const timeoutKeepAlive = setInterval(() => {}, 100);
    const timeoutJob = await timedOut.handle.completion.finally(() => clearInterval(timeoutKeepAlive));
    assert.equal(timeoutJob.status, "failed");
    assert.equal(await waitForPidExit(timeoutOwnedPid, 5_000), true, `worker-owned process ${timeoutOwnedPid} survived host timeout cleanup`);
  });
});
