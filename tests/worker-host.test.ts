import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { defaultWorkerExtensionPaths, launchWorkerHost, type WorkerLaunchRecord } from "../extensions/worker/runner.js";
import { readWorkerRuntimeResult } from "../extensions/worker/runtime.js";
import { previewAsyncShellPrune } from "../extensions/async-shell/index.js";
import { forkWorkerSession } from "../extensions/worker/session.js";
const WORKER_RECORD_VERSION = 1;
type WorkerRecord = {
  version: number; workerId: string; sessionId: string; sessionFile?: string; workspaceRoot: string; taskIds: string[];
  route: { provider: string; model: string; thinkingLevel: string }; role?: "work" | "review" | "integration";
  activeRun?: { runId: string; jobId: string; status: string }; [key: string]: unknown;
};

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

function launchRecord(record: WorkerRecord): WorkerLaunchRecord {
  if (!record.activeRun || !record.sessionFile) throw new Error("test record is not launchable");
  return { workerId: record.workerId, runId: record.activeRun.runId, jobId: record.activeRun.jobId, sessionId: record.sessionId, sessionFile: record.sessionFile, workspaceRoot: record.workspaceRoot, taskIds: record.taskIds, role: record.role ?? "work", modelSelection: `${record.route.provider}/${record.route.model}:${record.route.thinkingLevel}` };
}

test("worker host completes an exact-fork fake-provider run while ignoring workspace startup poison", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionDir = path.join(directory, "parent-sessions");
    const stateDir = path.join(directory, "state");
    const workspaceRoot = path.join(stateDir, "workspace");
    const sessionDir = path.join(stateDir, "session");
    const runDir = path.join(stateDir, "runs", "run-test");
    const resultFile = path.join(runDir, "result.json");
    await Promise.all([
      mkdir(parentCwd, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
      mkdir(path.join(stateDir, "async-shell"), { recursive: true }),
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
      record: launchRecord(record),
      shellExecution: { kind: "native-test" },
      prompt: "WORKER_PROMPT_MARKER: verify the managed worker lifecycle.",
      resultFile,
      runDir,
      processFile: path.join(runDir, "host-process.json"),
      processNonce: "host-process-e2e",
      bdPath: process.execPath,
      beadsRoute: TEST_BEADS_ROUTE,
      extensionPaths: [...defaultWorkerExtensionPaths(), fakeProviderExtension]
    });
    const config = JSON.parse(await readFile(launched.configFile, "utf8")) as { extensionPaths: string[]; rpcArgs: string[]; timeoutMs?: number };
    assert.ok(config.extensionPaths.includes(fakeProviderExtension));
    assert.ok(config.rpcArgs.includes(fakeProviderExtension));
    assert.equal(config.timeoutMs, undefined);

    const keepAlive = setInterval(() => {}, 100);
    const job = await launched.handle.completion.finally(() => clearInterval(keepAlive));
    assert.equal(job.status, "exited", await readFile(job.stderrLog, "utf8"));
    assert.equal(job.exitCode, 0);
    const expectedManagedBy = { kind: "worker-host", workerId: record.workerId, runId: "run-test" };
    assert.deepEqual(job.managedBy, expectedManagedBy, "launchWorkerHost must mark its actual async host job");
    const persistedHostMeta = JSON.parse(await readFile(path.join(job.logDir, "meta.json"), "utf8")) as { managedBy?: unknown };
    assert.deepEqual(persistedHostMeta.managedBy, expectedManagedBy);
    assert.throws(() => previewAsyncShellPrune({ cwd: parentCwd }, [job.jobId]), /managed-worker evidence; ordinary prune refused/);

    const accepted = readWorkerRuntimeResult(resultFile);
    assert.equal(accepted.workerId, record.workerId);
    assert.equal(accepted.runId, "run-test");
    assert.equal(accepted.result.outcome, "completed");
    assert.match(accepted.result.summary, /verified the exact fork/);
    assert.match(accepted.result.summary, /verified the exact fork/);
    assert.equal(existsSync(path.join(workspaceRoot, "poison-loaded")), false);
    assert.equal(existsSync(path.join(workspaceRoot, "post-handoff-side-effect")), false);
    const workerSession = await readFile(forked.sessionFile, "utf8");
    assert.match(workerSession, /PARENT_EXACT_MARKER/);
    assert.match(workerSession, /WORKER_PROMPT_MARKER/);
    assert.doesNotMatch(workerSession, /WORKSPACE_SYSTEM_POISON/);
  });
});

test("worker host fails when the initial prompt is rejected before an agent turn starts", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const workspaceRoot = path.join(directory, "workspace");
    const stateDir = path.join(directory, "state");
    const sessionDir = path.join(stateDir, "session");
    const runDir = path.join(stateDir, "runs", "run-preflight-failure");
    const resultFile = path.join(runDir, "result.json");
    await Promise.all([
      mkdir(parentCwd, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(sessionDir, { recursive: true })
    ]);
    const parent = SessionManager.create(parentCwd, path.join(directory, "parent-sessions"), { id: "parent-session-preflight-failure" });
    parent.appendMessage({ role: "user", content: "parent preflight failure context", timestamp: Date.now() });
    parent.appendMessage(assistantMessage("Ready for the preflight failure probe."));
    const parentSessionFile = parent.getSessionFile();
    assert.ok(parentSessionFile);
    const forked = forkWorkerSession({ parentSessionFile, workspaceRoot, sessionDir, sessionId: "worker-session-preflight-failure" });
    const record: WorkerRecord = {
      version: WORKER_RECORD_VERSION,
      workerId: "worker_20260910200000_preflt01",
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      parentSessionFile,
      workspaceRoot,
      taskIds: ["personal-workere2e"],
      route: { provider: "worker-faux", model: "worker-faux-1", thinkingLevel: "off" },
      status: "running",
      activeRun: { runId: "run-preflight-failure", jobId: "job_20260910200000_preflt01", status: "running" },
      updatedAt: new Date().toISOString()
    };
    const failureExtension = fileURLToPath(new URL("./fixtures/worker-preflight-failure.js", import.meta.url));
    const launched = launchWorkerHost({ sendMessage(): void {} } as unknown as ExtensionAPI, {
      cwd: parentCwd,
      sessionManager: { getSessionId: () => "parent-session-preflight-failure" },
      isIdle: () => true
    } as ExtensionContext, {
      record: launchRecord(record),
      shellExecution: { kind: "native-test" },
      prompt: "This prompt must fail before the worker turn starts.",
      resultFile,
      runDir,
      processFile: path.join(runDir, "host-process.json"),
      processNonce: "host-process-preflight-failure",
      bdPath: process.execPath,
      beadsRoute: TEST_BEADS_ROUTE,
      extensionPaths: [...defaultWorkerExtensionPaths(), failureExtension]
    });
    const keepAlive = setInterval(() => {}, 100);
    const job = await launched.handle.completion.finally(() => clearInterval(keepAlive));
    assert.equal(job.status, "failed");
    const stderr = await readFile(job.stderrLog, "utf8");
    assert.match(stderr, /No API key found for worker-faux|Intentionally unavailable worker test credential/);
    assert.doesNotMatch(stderr, /prompt response did not begin an agent turn/, "the checked response must preserve the immediate rejection cause");
    assert.equal(existsSync(resultFile), false);
  });
});

test("worker host permits pre-prompt compaction to exceed the prompt-start watchdog", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const workspaceRoot = path.join(directory, "workspace");
    const stateDir = path.join(directory, "state");
    const sessionDir = path.join(stateDir, "session");
    const runDir = path.join(stateDir, "runs", "run-preprompt-compaction");
    const resultFile = path.join(runDir, "result.json");
    await Promise.all([
      mkdir(parentCwd, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
      mkdir(path.join(stateDir, "async-shell"), { recursive: true })
    ]);
    const parent = SessionManager.create(parentCwd, path.join(directory, "parent-sessions"), { id: "parent-session-preprompt-compaction" });
    for (let index = 0; index < 8; index += 1) {
      parent.appendMessage({ role: "user", content: `parent compaction context ${index} ${"x".repeat(20_000)}`, timestamp: Date.now() + index * 2 });
      parent.appendMessage(assistantMessage(`Parent compaction response ${index}.`));
    }
    const highUsage = assistantMessage("The parent context is near the worker model threshold.");
    parent.appendMessage({
      ...highUsage,
      provider: "worker-faux",
      model: "worker-faux-1",
      usage: { ...highUsage.usage, input: 120_000, totalTokens: 120_000 }
    });
    const parentSessionFile = parent.getSessionFile();
    assert.ok(parentSessionFile);
    const forked = forkWorkerSession({ parentSessionFile, workspaceRoot, sessionDir, sessionId: "worker-session-preprompt-compaction" });
    const record: WorkerRecord = {
      version: WORKER_RECORD_VERSION,
      workerId: "worker_20260910200000_compact1",
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      parentSessionFile,
      workspaceRoot,
      taskIds: ["personal-workere2e"],
      route: { provider: "worker-faux", model: "worker-faux-1", thinkingLevel: "off" },
      status: "running",
      activeRun: { runId: "run-preprompt-compaction", jobId: "job_20260910200000_compact1", status: "running" },
      updatedAt: new Date().toISOString()
    };
    const compactionExtension = fileURLToPath(new URL("./fixtures/worker-compaction-faux-provider.js", import.meta.url));
    const startedAt = Date.now();
    const launched = launchWorkerHost({ sendMessage(): void {} } as unknown as ExtensionAPI, {
      cwd: parentCwd,
      sessionManager: { getSessionId: () => "parent-session-preprompt-compaction" },
      isIdle: () => true
    } as ExtensionContext, {
      record: launchRecord(record),
      shellExecution: { kind: "native-test" },
      prompt: "Complete after compacting the inherited parent context.",
      resultFile,
      runDir,
      processFile: path.join(runDir, "host-process.json"),
      processNonce: "host-process-preprompt-compaction",
      bdPath: process.execPath,
      beadsRoute: TEST_BEADS_ROUTE,
      extensionPaths: [...defaultWorkerExtensionPaths(), compactionExtension]
    });
    const keepAlive = setInterval(() => {}, 100);
    const job = await launched.handle.completion.finally(() => clearInterval(keepAlive));
    const workerSession = await readFile(forked.sessionFile, "utf8");
    assert.equal(job.status, "exited", `${await readFile(job.stderrLog, "utf8")}\nSTDOUT:\n${await readFile(job.stdoutLog, "utf8")}\nSESSION TAIL:\n${workerSession.slice(-8_000)}`);
    assert.equal(job.exitCode, 0);
    assert.ok(Date.now() - startedAt >= 5_500, "pre-prompt compaction must outlive the five-second post-response watchdog");
    assert.equal(readWorkerRuntimeResult(resultFile).result.outcome, "completed");
    assert.match(workerSession, /"type":"compaction"/);
  });
});

test("worker host detects an RPC child exit after agent_start without waiting for cancellation", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const workspaceRoot = path.join(directory, "workspace");
    const stateDir = path.join(directory, "state");
    const sessionDir = path.join(stateDir, "session");
    const runDir = path.join(stateDir, "runs", "run-rpc-exit");
    const resultFile = path.join(runDir, "result.json");
    await Promise.all([
      mkdir(parentCwd, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
      mkdir(path.join(stateDir, "async-shell"), { recursive: true })
    ]);
    const parent = SessionManager.create(parentCwd, path.join(directory, "parent-sessions"), { id: "parent-session-rpc-exit" });
    parent.appendMessage({ role: "user", content: "parent RPC exit context", timestamp: Date.now() });
    parent.appendMessage(assistantMessage("Ready for the RPC exit probe."));
    const parentSessionFile = parent.getSessionFile();
    assert.ok(parentSessionFile);
    const forked = forkWorkerSession({ parentSessionFile, workspaceRoot, sessionDir, sessionId: "worker-session-rpc-exit" });
    const record: WorkerRecord = {
      version: WORKER_RECORD_VERSION,
      workerId: "worker_20260910200000_rpcexit1",
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      parentSessionFile,
      workspaceRoot,
      taskIds: ["personal-workere2e"],
      route: { provider: "worker-faux", model: "worker-faux-1", thinkingLevel: "off" },
      status: "running",
      activeRun: { runId: "run-rpc-exit", jobId: "job_20260910200000_rpcexit1", status: "running" },
      updatedAt: new Date().toISOString()
    };
    const exitExtension = fileURLToPath(new URL("./fixtures/worker-rpc-exit-faux-provider.js", import.meta.url));
    const startedAt = Date.now();
    const launched = launchWorkerHost({ sendMessage(): void {} } as unknown as ExtensionAPI, {
      cwd: parentCwd,
      sessionManager: { getSessionId: () => "parent-session-rpc-exit" },
      isIdle: () => true
    } as ExtensionContext, {
      record: launchRecord(record),
      shellExecution: { kind: "native-test" },
      prompt: "Start and then terminate the RPC child.",
      resultFile,
      runDir,
      processFile: path.join(runDir, "host-process.json"),
      processNonce: "host-process-rpc-exit",
      bdPath: process.execPath,
      beadsRoute: TEST_BEADS_ROUTE,
      timeoutMs: 15_000,
      extensionPaths: [...defaultWorkerExtensionPaths(), exitExtension]
    });
    const keepAlive = setInterval(() => {}, 100);
    const job = await launched.handle.completion.finally(() => clearInterval(keepAlive));
    const stderr = await readFile(job.stderrLog, "utf8");
    assert.equal(job.status, "failed", stderr);
    assert.match(stderr, /Agent process exited/);
    assert.ok(Date.now() - startedAt < 12_000, `RPC child exit should fail before the 15-second explicit backstop:\n${stderr}`);
    assert.equal(existsSync(resultFile), false);
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
      record: launchRecord(record),
      shellExecution: { kind: "native-test" },
      prompt: "Complete the multiturn lifecycle.",
      resultFile,
      runDir,
      processFile: path.join(runDir, "host-process.json"),
      processNonce: "host-process-multiturn",
      bdPath: process.execPath,
      beadsRoute: TEST_BEADS_ROUTE,
      extensionPaths: [...defaultWorkerExtensionPaths(), providerExtension]
    });
    const keepAlive = setInterval(() => {}, 100);
    const job = await launched.handle.completion.finally(() => clearInterval(keepAlive));
    assert.equal(job.status, "exited", `${await readFile(job.stderrLog, "utf8")}\nSTDOUT:\n${await readFile(job.stdoutLog, "utf8")}`);
    assert.equal(job.exitCode, 0);
    assert.equal(readWorkerRuntimeResult(resultFile).result.outcome, "completed");
    assert.ok(existsSync(path.join(runDir, "settled.json")));
    const jobsDirectory = path.join(stateDir, "async-shell", "jobs");
    const entries = await readdir(jobsDirectory);
    const published = entries.filter((entry) => entry.startsWith("job_"));
    assert.equal(published.length, 13, "the initial job and all 12 post-idle jobs must be atomically published");
    assert.deepEqual(entries.filter((entry) => entry.startsWith(".pending-")), []);
    for (const jobId of published) {
      const metadata = JSON.parse(await readFile(path.join(jobsDirectory, jobId, "meta.json"), "utf8"));
      assert.equal(Number.isInteger(metadata.pid) && metadata.pid > 0, true, `${jobId} must publish a complete process identity`);
    }
  });
});

test("worker host fails promptly when a quiescent worker settles without typed result", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const workspaceRoot = path.join(directory, "workspace");
    const stateDir = path.join(directory, "state");
    const sessionDir = path.join(stateDir, "session");
    const runDir = path.join(stateDir, "runs", "run-no-handoff");
    await Promise.all([
      mkdir(parentCwd, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(sessionDir, { recursive: true })
    ]);
    const parent = SessionManager.create(parentCwd, path.join(directory, "parent-sessions"), { id: "parent-session-no-handoff" });
    parent.appendMessage({ role: "user", content: "parent no-handoff context", timestamp: Date.now() });
    parent.appendMessage(assistantMessage("Ready for the no-handoff protocol probe."));
    const parentSessionFile = parent.getSessionFile();
    assert.ok(parentSessionFile);
    const forked = forkWorkerSession({ parentSessionFile, workspaceRoot, sessionDir, sessionId: "worker-session-no-handoff" });
    const record: WorkerRecord = {
      version: WORKER_RECORD_VERSION,
      workerId: "worker_20260925120000_nohand01",
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      parentSessionFile,
      workspaceRoot,
      taskIds: ["personal-workere2e"],
      route: { provider: "worker-no-handoff-faux", model: "worker-no-handoff-faux-1", thinkingLevel: "off" },
      status: "running",
      activeRun: { runId: "run-no-handoff", jobId: "job_20260925120000_nohand01", status: "running" },
      updatedAt: new Date().toISOString()
    };
    const providerExtension = fileURLToPath(new URL("./fixtures/worker-no-handoff-faux-provider.js", import.meta.url));
    const launched = launchWorkerHost({ sendMessage(): void {} } as unknown as ExtensionAPI, {
      cwd: parentCwd,
      sessionManager: { getSessionId: () => "parent-session-no-handoff" },
      isIdle: () => true
    } as ExtensionContext, {
      record: launchRecord(record),
      shellExecution: { kind: "native-test" },
      prompt: "Settle without a result.",
      resultFile: path.join(runDir, "result.json"),
      runDir,
      processFile: path.join(runDir, "host-process.json"),
      processNonce: "host-process-no-handoff",
      bdPath: process.execPath,
      beadsRoute: TEST_BEADS_ROUTE,
      extensionPaths: [...defaultWorkerExtensionPaths(), providerExtension]
    });
    const keepAlive = setInterval(() => {}, 100);
    const job = await launched.handle.completion.finally(() => clearInterval(keepAlive));
    assert.equal(job.status, "failed");
    assert.match(await readFile(job.stderrLog, "utf8"), /settled quiescent turn without the required typed worker_result_submit/);
  });
});

test("review worker receives one bounded repair turn and submits the required typed result", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const workspaceRoot = path.join(directory, "workspace");
    const stateDir = path.join(directory, "state");
    const sessionDir = path.join(stateDir, "session");
    const runDir = path.join(stateDir, "runs", "run-review-repair");
    const resultFile = path.join(runDir, "result.json");
    await Promise.all([mkdir(parentCwd, { recursive: true }), mkdir(workspaceRoot, { recursive: true }), mkdir(sessionDir, { recursive: true }), mkdir(path.join(stateDir, "async-shell"), { recursive: true })]);
    const parent = SessionManager.create(parentCwd, path.join(directory, "parent-sessions"), { id: "parent-session-review-repair" });
    parent.appendMessage({ role: "user", content: "parent review repair context", timestamp: Date.now() });
    parent.appendMessage(assistantMessage("Ready for the review repair probe."));
    const parentSessionFile = parent.getSessionFile(); assert.ok(parentSessionFile);
    const forked = forkWorkerSession({ parentSessionFile, workspaceRoot, sessionDir, sessionId: "worker-session-review-repair" });
    const record: WorkerRecord = {
      version: WORKER_RECORD_VERSION, workerId: "worker_20260925120000_review01", sessionId: forked.sessionId, sessionFile: forked.sessionFile,
      parentSessionFile, workspaceRoot, taskIds: ["personal-workere2e"], role: "review",
      route: { provider: "worker-review-repair-faux", model: "worker-review-repair-faux-1", thinkingLevel: "off" }, status: "running",
      activeRun: { runId: "run-review-repair", jobId: "job_20260925120000_review01", status: "running" }, updatedAt: new Date().toISOString()
    };
    const providerExtension = fileURLToPath(new URL("./fixtures/worker-review-repair-faux-provider.js", import.meta.url));
    const launched = launchWorkerHost({ sendMessage(): void {} } as unknown as ExtensionAPI, {
      cwd: parentCwd, sessionManager: { getSessionId: () => "parent-session-review-repair" }, isIdle: () => true
    } as ExtensionContext, {
      record: launchRecord(record), shellExecution: { kind: "native-test" }, prompt: "Review the candidate and submit a typed verdict.", resultFile, runDir,
      processFile: path.join(runDir, "host-process.json"), processNonce: "host-process-review-repair", bdPath: process.execPath,
      beadsRoute: TEST_BEADS_ROUTE, extensionPaths: [...defaultWorkerExtensionPaths(), providerExtension]
    });
    const keepAlive = setInterval(() => {}, 100);
    const job = await launched.handle.completion.finally(() => clearInterval(keepAlive));
    const repairSession = await readFile(forked.sessionFile, "utf8");
    assert.equal(job.status, "exited", `${await readFile(job.stderrLog, "utf8")}\nSTDOUT:\n${await readFile(job.stdoutLog, "utf8")}\nSESSION TAIL:\n${repairSession.slice(-12_000)}`);
    const accepted = readWorkerRuntimeResult(resultFile);
    assert.equal(accepted.result.outcome, "approve");
    assert.match(accepted.result.summary, /bounded typed-result repair turn/);
    assert.deepEqual(accepted.result.artifacts, ["artifacts/review-repair.md"]);
    assert.equal((repairSession.match(/Do not restate the verdict in prose/g) ?? []).length, 1, "repair instruction must be injected exactly once");
  });
});

test("review worker gets only one repair turn before missing typed result fails closed", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent"); const workspaceRoot = path.join(directory, "workspace"); const stateDir = path.join(directory, "state");
    const sessionDir = path.join(stateDir, "session"); const runDir = path.join(stateDir, "runs", "run-review-no-handoff");
    await Promise.all([mkdir(parentCwd, { recursive: true }), mkdir(workspaceRoot, { recursive: true }), mkdir(sessionDir, { recursive: true }), mkdir(path.join(stateDir, "async-shell"), { recursive: true })]);
    const parent = SessionManager.create(parentCwd, path.join(directory, "parent-sessions"), { id: "parent-session-review-no-handoff" });
    parent.appendMessage({ role: "user", content: "parent review no-handoff context", timestamp: Date.now() }); parent.appendMessage(assistantMessage("Ready for bounded review failure."));
    const parentSessionFile = parent.getSessionFile(); assert.ok(parentSessionFile); const forked = forkWorkerSession({ parentSessionFile, workspaceRoot, sessionDir, sessionId: "worker-session-review-no-handoff" });
    const record: WorkerRecord = { version: WORKER_RECORD_VERSION, workerId: "worker_20260925120000_review02", sessionId: forked.sessionId, sessionFile: forked.sessionFile,
      parentSessionFile, workspaceRoot, taskIds: ["personal-workere2e"], role: "review", route: { provider: "worker-review-no-handoff-faux", model: "worker-review-no-handoff-faux-1", thinkingLevel: "off" }, status: "running",
      activeRun: { runId: "run-review-no-handoff", jobId: "job_20260925120000_review02", status: "running" }, updatedAt: new Date().toISOString() };
    const providerExtension = fileURLToPath(new URL("./fixtures/worker-review-no-handoff-faux-provider.js", import.meta.url));
    const launched = launchWorkerHost({ sendMessage(): void {} } as unknown as ExtensionAPI, { cwd: parentCwd, sessionManager: { getSessionId: () => "parent-session-review-no-handoff" }, isIdle: () => true } as ExtensionContext, {
      record: launchRecord(record), shellExecution: { kind: "native-test" }, prompt: "Review but omit typed submission twice.", resultFile: path.join(runDir, "result.json"), runDir,
      processFile: path.join(runDir, "host-process.json"), processNonce: "host-process-review-no-handoff", bdPath: process.execPath, beadsRoute: TEST_BEADS_ROUTE,
      extensionPaths: [...defaultWorkerExtensionPaths(), providerExtension]
    });
    const keepAlive = setInterval(() => {}, 100); const job = await launched.handle.completion.finally(() => clearInterval(keepAlive));
    assert.equal(job.status, "failed"); assert.match(await readFile(job.stderrLog, "utf8"), /settled quiescent turn without the required typed worker_result_submit/);
    const sessionText = await readFile(forked.sessionFile, "utf8"); assert.equal((sessionText.match(/Do not restate the verdict in prose/g) ?? []).length, 1);
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
      record: launchRecord(record),
      shellExecution: { kind: "native-test" },
      prompt: "Start the cancellation probe.",
      resultFile,
      runDir,
      processFile: path.join(runDir, "host-process.json"),
      processNonce: "host-process-cancel",
      bdPath: process.execPath,
      beadsRoute: TEST_BEADS_ROUTE,
      timeoutMs: 30_000,
      extensionPaths: [...defaultWorkerExtensionPaths(), providerExtension]
    });
    const marker = path.join(workspaceRoot, "owned-shell.pid");
    try {
      try {
        await waitForPath(marker, 30_000);
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
      record: launchRecord(timeoutRecord),
      shellExecution: { kind: "native-test" },
      prompt: "Start the timeout cleanup probe.",
      resultFile: path.join(timeoutRunDir, "result.json"),
      runDir: timeoutRunDir,
      processFile: path.join(timeoutRunDir, "host-process.json"),
      processNonce: "host-process-timeout",
      bdPath: process.execPath,
      beadsRoute: TEST_BEADS_ROUTE,
      timeoutMs: 1_000,
      extensionPaths: [...defaultWorkerExtensionPaths(), providerExtension]
    });
    await waitForPath(marker, 30_000);
    const timeoutOwnedPid = Number.parseInt((await readFile(marker, "utf8")).trim(), 10);
    const timeoutKeepAlive = setInterval(() => {}, 100);
    const timeoutJob = await timedOut.handle.completion.finally(() => clearInterval(timeoutKeepAlive));
    assert.equal(timeoutJob.status, "failed");
    assert.equal(await waitForPidExit(timeoutOwnedPid, 5_000), true, `worker-owned process ${timeoutOwnedPid} survived host timeout cleanup`);
  });
});
