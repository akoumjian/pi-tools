import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RetainedToolOutputSchemas } from "../extensions/_shared/tool-output.js";
import { MAX_WORKER_TASK_IDS } from "../extensions/_shared/worker-contract.js";
import { startManagedAsyncJob, type JobMeta } from "../extensions/async-shell/index.js";
import type { WorkerContainerReference } from "../extensions/_shared/worker-container.js";
import { registerWorkerExtension, resolveWorkerRoute } from "../extensions/worker/index.js";
import { persistRepositoryInventory } from "../extensions/worker/repositories.js";
import { forkWorkerSession } from "../extensions/worker/session.js";
import { normalizeWorkerSettings } from "../extensions/worker/settings.js";
import {
  WORKER_RECORD_VERSION,
  acquireWorkerLease,
  acquireWorkerOperationLock,
  provisionWorkerPaths,
  readWorkerRecord,
  releaseWorkerLease,
  workerPaths,
  writeWorkerRecord,
  type WorkerRecord
} from "../extensions/worker/state.js";

type FakeApi = ExtensionAPI & {
  tools: ToolDefinition[];
  commands: Map<string, { handler: (args: string, context: ExtensionContext) => Promise<void> | void }>;
  handlers: Map<string, Function[]>;
  messages: Array<{ message: unknown; options: unknown }>;
  emit(name: string, event: unknown, context: ExtensionContext): Promise<void>;
};

function fakeApi(): FakeApi {
  const tools: ToolDefinition[] = [];
  const commands = new Map<string, { handler: (args: string, context: ExtensionContext) => Promise<void> | void }>();
  const handlers = new Map<string, Function[]>();
  const messages: Array<{ message: unknown; options: unknown }> = [];
  return {
    tools,
    commands,
    handlers,
    messages,
    registerTool(tool: ToolDefinition): void { tools.push(tool); },
    registerCommand(name: string, command: { handler: (args: string, context: ExtensionContext) => Promise<void> | void }): void { commands.set(name, command); },
    on(name: string, handler: Function): void { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    sendMessage(message: unknown, options: unknown): void { messages.push({ message, options }); },
    async emit(name: string, event: unknown, context: ExtensionContext): Promise<void> {
      for (const handler of handlers.get(name) ?? []) await handler(event, context);
    }
  } as unknown as FakeApi;
}

function fakeModel(id = "gpt-test"): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: "openai-codex",
    baseUrl: "https://example.invalid",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000
  } as Model<Api>;
}

function parentContext(cwd: string, sessionFile: string, entries: unknown[] = []): ExtensionContext {
  const model = fakeModel();
  const defaultWorkerModel = fakeModel("gpt-5.6-sol");
  return {
    cwd,
    model,
    thinkingLevel: "xhigh",
    sessionManager: {
      getSessionId: () => "parent-session",
      getSessionFile: () => sessionFile,
      getEntries: () => entries
    },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      getAll: () => [model, defaultWorkerModel]
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { notify(): void {} }
  } as unknown as ExtensionContext;
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const created = await mkdtemp(path.join(tmpdir(), "pi-worker-tool-"));
  const directory = await realpath(created);
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}


const workerRenderTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text
};

function renderWorkerToolCall(tool: ToolDefinition, args: unknown): string {
  assert.ok(tool.renderCall, `${tool.name} should define renderCall`);
  return tool.renderCall(args as never, workerRenderTheme as never, {} as never).render(200).join("\n");
}

function renderWorkerToolResult(tool: ToolDefinition, result: unknown, options: { expanded?: boolean; isPartial?: boolean } = {}, context: unknown = {}): string {
  assert.ok(tool.renderResult, `${tool.name} should define renderResult`);
  return tool.renderResult(result as never, { expanded: options.expanded ?? false, isPartial: options.isPartial ?? false }, workerRenderTheme as never, context as never).render(200).join("\n");
}

function isProcessAliveForTest(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function writeHostSettlement(resultFile: string, workerId: string, runId: string, sessionId: string): Promise<void> {
  await writeFile(path.join(path.dirname(resultFile), "settled.json"), `${JSON.stringify({
    version: 1,
    workerId,
    runId,
    sessionId,
    resultFile,
    settledAt: "2026-09-10T19:31:02.000Z"
  })}\n`);
}

function gitFixture(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Worker Test",
      GIT_AUTHOR_EMAIL: "worker@example.invalid",
      GIT_COMMITTER_NAME: "Worker Test",
      GIT_COMMITTER_EMAIL: "worker@example.invalid"
    }
  }).trim();
}

function completedJob(jobId: string, cwd: string): JobMeta {
  const logDir = path.join(cwd, ".pi", "async-shell", "jobs", jobId);
  return {
    jobId,
    job_name: "worker test",
    command: "worker host",
    cwd,
    shell: process.execPath,
    status: "exited",
    pid: process.pid,
    startedAt: "2026-09-10T19:30:00.000Z",
    endedAt: "2026-09-10T19:30:01.000Z",
    durationMs: 1_000,
    exitCode: 0,
    signal: null,
    notifyOnExit: false,
    completionNotified: false,
    logDir,
    stdoutLog: path.join(logDir, "stdout.log"),
    stderrLog: path.join(logDir, "stderr.log"),
    outputBytes: { stdout: 0, stderr: 0 }
  };
}

test("worker settings select a configured default while explicit routes override it", () => {
  const context = parentContext("/tmp/parent", "/tmp/parent.jsonl");
  assert.deepEqual(normalizeWorkerSettings({ defaultRoute: " openai-codex/gpt-5.6-sol:xhigh " }, "fixture"), {
    defaultRoute: "openai-codex/gpt-5.6-sol:xhigh",
    configSource: "fixture"
  });
  assert.throws(() => normalizeWorkerSettings({}, "fixture"), /defaultRoute/);
  assert.throws(() => normalizeWorkerSettings({ defaultRoute: "openai-codex/gpt-5.6-sol:xhigh", extra: true }, "fixture"), /unsupported worker setting/);
  assert.deepEqual(resolveWorkerRoute(undefined, context), {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinkingLevel: "xhigh"
  });
  assert.deepEqual(resolveWorkerRoute("openai-codex/gpt-test:xhigh", context), {
    provider: "openai-codex",
    model: "gpt-test",
    thinkingLevel: "xhigh"
  });
  const unavailableContext = parentContext("/tmp/parent", "/tmp/parent.jsonl") as ExtensionContext & {
    modelRegistry: { hasConfiguredAuth(model: Model<Api>): boolean; getAll(): Model<Api>[] };
  };
  unavailableContext.modelRegistry.getAll = () => [fakeModel()];
  assert.throws(() => resolveWorkerRoute(undefined, unavailableContext), /Worker model not found: openai-codex\/gpt-5\.6-sol/);
});

test("worker_run queues immediately, then forks the completed parent turn before launch", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd }),
      JSON.stringify({ type: "custom", id: "before", parentId: null, timestamp: "2026-09-10T19:29:01.000Z", customType: "before-worker", data: {} })
    ].join("\n") + "\n");
    const context = parentContext(parentCwd, parentSessionFile);
    const api = fakeApi();
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const sourceRepo = path.join(directory, "source-repo");
    await mkdir(sourceRepo);
    gitFixture(sourceRepo, "init", "-q", "-b", "main");
    await writeFile(path.join(sourceRepo, "README.md"), "base\n");
    gitFixture(sourceRepo, "add", "README.md");
    gitFixture(sourceRepo, "commit", "-qm", "base");
    const randomValues = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444"
    ];
    const launchCompletion = deferred<JobMeta>();
    let plannedContainer: WorkerContainerReference | undefined;
    let parkedContainer: WorkerContainerReference | undefined;
    const launches: Array<{ record: { workerId: string; sessionFile?: string }; resultFile: string; jobId: string }> = [];
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:30:00.000Z"),
      random: () => randomValues.shift() ?? "55555555-5555-4555-8555-555555555555",
      parkContainer: (container) => { parkedContainer = container; },
      planContainer: (record, runId, nonce) => {
        plannedContainer = {
          version: 1,
          workerId: record.workerId,
          runId,
          name: `pi-${record.workerId}-${runId}`,
          nonce,
          image: "alpine@test",
          codeRoot: parentCwd,
          workspaceRoot: record.workspaceRoot,
          containerId: "a".repeat(64)
        };
        return plannedContainer;
      },
      launch: (_api, _context, request) => {
        launches.push({ record: request.record, resultFile: request.resultFile, jobId: request.jobId });
        return {
          jobId: request.jobId,
          completion: launchCompletion.promise,
          snapshot: () => completedJob(request.jobId, request.record.workspaceRoot),
          cancel(): void {},
          container: request.container
        };
      }
    });
    const tool = api.tools.find((candidate) => candidate.name === "worker_run");
    assert.ok(tool?.execute);

    const result = await tool.execute("call-1", {
      runs: [{
        kind: "new",
        taskIds: ["personal-test"],
        guidance: "Implement the focused slice.",
        completionDelivery: "followUp",
        initialRepos: [{ source: sourceRepo, revision: gitFixture(sourceRepo, "rev-parse", "HEAD") }]
      }]
    } as never, undefined, undefined, context);
    const receipt = (result.details as { runs: Array<{ workerId: string; runId: string; jobId: string; sessionId: string; sessionFile?: string; completionDelivery: string; state: string }> }).runs[0];
    assert.equal(receipt.workerId, "worker_20260910193000_11111111");
    assert.equal(receipt.runId, "run_20260910193000_22222222");
    assert.equal(receipt.jobId, "job_20260910193000_33333333");
    assert.equal(receipt.sessionId, "44444444-4444-4444-8444-444444444444");
    assert.equal(receipt.sessionFile, undefined);
    assert.equal(receipt.completionDelivery, "followUp");
    assert.equal(receipt.state, "queued");
    assert.equal((receipt as unknown as { provider: string }).provider, "openai-codex");
    assert.equal((receipt as unknown as { model: string }).model, "gpt-5.6-sol");
    assert.equal((receipt as unknown as { thinkingLevel: string }).thinkingLevel, "xhigh");
    assert.equal(launches.length, 0, "launch waits for the parent turn to be durable");
    const candidateRepo = path.join(workerPaths(roots, receipt.workerId).reposDir, "project");
    execFileSync("git", ["clone", "-q", "--no-hardlinks", sourceRepo, candidateRepo]);
    await writeFile(path.join(candidateRepo, "feature.txt"), "feature\n");
    gitFixture(candidateRepo, "add", "feature.txt");
    gitFixture(candidateRepo, "commit", "-qm", "feature");

    await appendFile(parentSessionFile, `${JSON.stringify({ type: "custom", id: "after", parentId: "before", timestamp: "2026-09-10T19:30:00.500Z", customType: "worker-run-result", data: { jobId: receipt.jobId } })}\n`);
    await api.emit("turn_end", {}, context);
    assert.equal(launches.length, 1);
    assert.ok(launches[0].record.sessionFile);
    const forkText = await readFile(launches[0].record.sessionFile!, "utf8");
    assert.match(forkText, /worker-run-result/);
    assert.match(forkText, new RegExp(receipt.jobId));

    await mkdir(path.dirname(launches[0].resultFile), { recursive: true });
    await writeFile(launches[0].resultFile, `${JSON.stringify({
      version: 1,
      workerId: receipt.workerId,
      runId: receipt.runId,
      acceptedAt: "2026-09-10T19:30:01.000Z",
      handoff: {
        state: "assignment_complete",
        summary: "done",
        taskUpdates: [],
        repositories: [{ workspaceRepo: "repos/project", purpose: "candidate integration test" }]
      }
    })}\n`);
    await writeHostSettlement(launches[0].resultFile, receipt.workerId, receipt.runId, receipt.sessionId);
    launchCompletion.resolve(completedJob(receipt.jobId, parentCwd));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const record = readWorkerRecord(workerPaths(roots, receipt.workerId).recordFile);
    assert.equal(record.status, "handed_off");
    assert.equal(record.activeRun, undefined);
    assert.equal(record.lastRun?.runId, receipt.runId);
    assert.deepEqual(record.container, plannedContainer, "successful handoff preserves the exact worker container for resume");
    assert.deepEqual(parkedContainer, plannedContainer, "successful handoff parks the exact worker container");
    assert.equal(api.messages.length, 1);
    assert.match(JSON.stringify(api.messages[0].message), /assignment_complete/);
    assert.match(JSON.stringify(api.messages[0].message), /openai-codex\/gpt-5\.6-sol:xhigh/);
    assert.deepEqual(api.messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
    assert.equal(record.lastRun?.delivery, "pending");
    assert.equal(record.lastRun?.repositoryInventory?.candidateCount, 1);
    assert.equal(record.lastRun?.repositoryInventory?.foldableCount, 1);
    assert.equal(record.lastRun?.repositoryInventory?.candidates[0]?.workspaceRepo, "repos/project");
    assert.match(JSON.stringify(api.messages[0].message), /candidate_[0-9a-f]{24}/);

    await api.emit(
      "message_end",
      { message: { role: "custom", ...(api.messages[0].message as object) } },
      parentContext(parentCwd, path.join(directory, "different-parent.jsonl"))
    );
    assert.equal(readWorkerRecord(workerPaths(roots, receipt.workerId).recordFile).lastRun?.delivery, "pending");

    await api.emit("message_end", { message: { role: "custom", ...(api.messages[0].message as object) } }, context);
    assert.equal(readWorkerRecord(workerPaths(roots, receipt.workerId).recordFile).lastRun?.delivery, "delivered");
  });
});

test("queued launch revalidates its exact lease before spawning a host", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const context = parentContext(parentCwd, parentSessionFile);
    const api = fakeApi();
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    let launched = false;
    const values = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444"
    ];
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:30:00.000Z"),
      random: () => values.shift() ?? "55555555-5555-4555-8555-555555555555",
      launch: () => { launched = true; throw new Error("must not launch"); }
    });
    const tool = api.tools.find((candidate) => candidate.name === "worker_run");
    assert.ok(tool?.execute);
    const result = await tool.execute("call-lease", {
      runs: [{ kind: "new", taskIds: ["personal-test.1"] }]
    } as never, undefined, undefined, context);
    const receipt = (result.details as { runs: Array<{ workerId: string; runId: string }> }).runs[0];
    const paths = workerPaths(roots, receipt.workerId);
    await writeFile(paths.leaseFile, `${JSON.stringify({
      version: 1,
      workerId: receipt.workerId,
      runId: receipt.runId,
      parentPid: process.pid + 100_000,
      acquiredAt: "2026-09-10T19:30:00.000Z"
    })}\n`);
    await api.emit("turn_end", {}, context);
    assert.equal(launched, false);
    assert.equal(readWorkerRecord(paths.recordFile).activeRun?.runId, receipt.runId);
    assert.equal(existsSync(paths.leaseFile), true);
  });
});

test("worker cleanup uncertainty retains the active run and lease for explicit recovery", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const context = parentContext(parentCwd, parentSessionFile);
    const api = fakeApi();
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const completion = deferred<JobMeta>();
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:30:00.000Z"),
      random: (() => {
        const values = [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
          "33333333-3333-4333-8333-333333333333",
          "44444444-4444-4444-8444-444444444444"
        ];
        return () => values.shift() ?? "55555555-5555-4555-8555-555555555555";
      })(),
      launch: (_api, _context, request) => ({
        jobId: request.jobId,
        completion: completion.promise,
        snapshot: () => completedJob(request.jobId, request.record.workspaceRoot),
        cancel(): void {}
      })
    });
    const tool = api.tools.find((candidate) => candidate.name === "worker_run");
    assert.ok(tool?.execute);
    const result = await tool.execute("call-cleanup", {
      runs: [{ kind: "new", taskIds: ["personal-test"] }]
    } as never, undefined, undefined, context);
    const receipt = (result.details as { runs: Array<{ workerId: string; runId: string; jobId: string }> }).runs[0];
    await api.emit("turn_end", {}, context);
    const paths = workerPaths(roots, receipt.workerId);
    const malformedJobDir = path.join(paths.stateDir, "async-shell", "jobs", "job_malformed");
    await mkdir(malformedJobDir, { recursive: true });
    await writeFile(path.join(malformedJobDir, "meta.json"), "{not-json\n");
    completion.resolve(completedJob(receipt.jobId, parentCwd));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const record = readWorkerRecord(paths.recordFile);
    assert.equal(record.status, "running");
    assert.equal(record.activeRun?.runId, receipt.runId);
    assert.match(record.activeRun?.recoveryError ?? "", /JSON|position|property/i);
    assert.equal(existsSync(paths.leaseFile), true);
    assert.match(JSON.stringify(api.messages.at(-1)?.message), /cleanup requires recovery/);

    await rm(malformedJobDir, { recursive: true, force: true });
    const cancel = api.commands.get("worker:cancel");
    assert.ok(cancel);
    await cancel.handler(receipt.workerId, context);
    const cancelled = readWorkerRecord(paths.recordFile);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.activeRun, undefined);
    assert.equal(existsSync(paths.leaseFile), false);
  });
});

test("worker_run removes a newly provisioned batch entry when a later generated identity conflicts", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const context = parentContext(parentCwd, parentSessionFile);
    const api = fakeApi();
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const values = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "11111111-1111-4111-8111-111111111111"
    ];
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:30:00.000Z"),
      random: () => values.shift() ?? "55555555-5555-4555-8555-555555555555"
    });
    const tool = api.tools.find((candidate) => candidate.name === "worker_run");
    assert.ok(tool?.execute);
    await assert.rejects(tool.execute("call-new-batch", {
      runs: [
        { kind: "new", taskIds: ["personal-first"] },
        { kind: "new", taskIds: ["personal-second"] }
      ]
    } as never, undefined, undefined, context), /already exists/);
    const paths = workerPaths(roots, "worker_20260910193000_11111111");
    assert.equal(existsSync(paths.stateDir), false);
    assert.equal(existsSync(paths.workspaceRoot), false);
  });
});

test("worker_run removes newly provisioned paths when initial repository pinning fails", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const context = parentContext(parentCwd, parentSessionFile);
    const api = fakeApi();
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:30:00.000Z"),
      random: () => "11111111-1111-4111-8111-111111111111",
      pinRepositories: () => { throw new Error("git executable unavailable"); }
    });
    const tool = api.tools.find((candidate) => candidate.name === "worker_run");
    assert.ok(tool?.execute);
    await assert.rejects(tool.execute("call-pin-failure", {
      runs: [{ kind: "new", taskIds: ["personal-pin"], initialRepos: [{ source: "/tmp/source" }] }]
    } as never, undefined, undefined, context), /git executable unavailable/);
    const paths = workerPaths(roots, "worker_20260910193000_11111111");
    assert.equal(existsSync(paths.stateDir), false);
    assert.equal(existsSync(paths.workspaceRoot), false);
  });
});

test("worker_run rolls back an earlier prepared batch entry when a later run lease conflicts", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const records = ["batch001", "batch002"].map((suffix) => {
      const workerId = `worker_20260910190000_${suffix}`;
      const paths = workerPaths(roots, workerId);
      provisionWorkerPaths(paths);
      const forked = forkWorkerSession({ parentSessionFile, workspaceRoot: paths.workspaceRoot, sessionDir: paths.sessionDir, sessionId: `session-${suffix}` });
      const record: WorkerRecord = {
        version: WORKER_RECORD_VERSION,
        workerId,
        sessionId: forked.sessionId,
        sessionFile: forked.sessionFile,
        parentSessionFile,
        workspaceRoot: paths.workspaceRoot,
        taskIds: [`personal-${suffix}`],
        route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" } as const,
        status: "handed_off" as const,
        lastRun: { runId: `old-${suffix}`, jobId: `old-job-${suffix}`, status: "handed_off" as const },
        updatedAt: "2026-09-10T19:29:30.000Z"
      };
      writeWorkerRecord(paths.recordFile, record);
      return { paths, record };
    });
    acquireWorkerLease(records[1].paths.leaseFile, {
      version: 1,
      workerId: records[1].record.workerId,
      runId: "other-run",
      parentPid: process.pid,
      acquiredAt: "2026-09-10T19:30:00.000Z"
    });
    const api = fakeApi();
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:30:00.000Z"),
      random: () => "11111111-1111-4111-8111-111111111111"
    });
    const tool = api.tools.find((candidate) => candidate.name === "worker_run");
    assert.ok(tool?.execute);
    await assert.rejects(tool.execute("call-batch", {
      runs: records.map(({ record }) => ({ kind: "resume", workerId: record.workerId, message: "resume" }))
    } as never, undefined, undefined, parentContext(parentCwd, parentSessionFile)), /active run lease/);
    assert.deepEqual(readWorkerRecord(records[0].paths.recordFile), records[0].record);
    assert.equal(existsSync(records[0].paths.leaseFile), false);
  });
});

test("worker_run resume reopens only the exact worker session and captures fresh parent context", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd }),
      JSON.stringify({ type: "custom", id: "parent-before", parentId: null, timestamp: "2026-09-10T19:29:01.000Z", customType: "parent-before", data: {} })
    ].join("\n") + "\n");
    const context = parentContext(parentCwd, parentSessionFile);
    const api = fakeApi();
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910190000_resume01";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const forked = forkWorkerSession({
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      sessionDir: paths.sessionDir,
      sessionId: "worker-session-existing"
    });
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: Array.from({ length: MAX_WORKER_TASK_IDS - 1 }, (_, index) => `personal-existing.${index + 1}`),
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "handed_off",
      lastRun: { runId: "run-old", jobId: "job-old", status: "handed_off" },
      updatedAt: "2026-09-10T19:29:30.000Z"
    });
    const completion = deferred<JobMeta>();
    let launch: { sessionFile?: string; prompt: string; resultFile: string; jobId: string } | undefined;
    const randomValues = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    ];
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:31:00.000Z"),
      random: () => randomValues.shift() ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      launch: (_api, _context, request) => {
        launch = { sessionFile: request.record.sessionFile, prompt: request.prompt, resultFile: request.resultFile, jobId: request.jobId };
        return {
          jobId: request.jobId,
          completion: completion.promise,
          snapshot: () => completedJob(request.jobId, parentCwd),
          cancel(): void {}
        };
      }
    });
    const tool = api.tools.find((candidate) => candidate.name === "worker_run");
    assert.ok(tool?.execute);
    const result = await tool.execute("call-resume", {
      runs: [{ kind: "resume", workerId, message: "Inspect the fresh parent context.", addTaskIds: ["personal-added"] }]
    } as never, undefined, undefined, context);
    const receipt = (result.details as { runs: Array<{ runId: string; jobId: string; sessionFile?: string; taskIds: string[] }> }).runs[0];
    assert.equal(Check(RetainedToolOutputSchemas.worker_run, result), true);
    assert.equal(receipt.sessionFile, forked.sessionFile);
    assert.equal(receipt.taskIds.length, MAX_WORKER_TASK_IDS);
    assert.equal(receipt.taskIds.at(-1), "personal-added");

    await appendFile(parentSessionFile, `${JSON.stringify({ type: "custom", id: "parent-fresh", parentId: "parent-before", timestamp: "2026-09-10T19:30:59.000Z", customType: "FRESH_PARENT_MARKER", data: {} })}\n`);
    await api.emit("turn_end", {}, context);
    assert.ok(launch);
    assert.equal(launch.sessionFile, forked.sessionFile);
    assert.match(launch.prompt, /fresh mode-0400 snapshot/);
    assert.match(launch.prompt, /Inspect the fresh parent context/);
    const snapshot = path.join(paths.artifactsDir, `parent-context-${receipt.runId}.jsonl`);
    assert.match(await readFile(snapshot, "utf8"), /FRESH_PARENT_MARKER/);

    await writeFile(launch.resultFile, `${JSON.stringify({
      version: 1,
      workerId,
      runId: receipt.runId,
      acceptedAt: "2026-09-10T19:31:01.000Z",
      handoff: { state: "checkpoint", summary: "resume done", taskUpdates: [] }
    })}\n`);
    await writeHostSettlement(launch.resultFile, workerId, receipt.runId, forked.sessionId);
    completion.resolve(completedJob(launch.jobId, parentCwd));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const completed = readWorkerRecord(paths.recordFile);
    assert.equal(completed.status, "handed_off");
    assert.ok(completed.lastRun);
    writeWorkerRecord(paths.recordFile, {
      ...completed,
      lastRun: { ...completed.lastRun, delivery: "delivered" }
    });
    await assert.rejects(
      tool.execute("call-resume-over-limit", {
        runs: [{ kind: "resume", workerId, message: "One task too many.", addTaskIds: ["personal-over-limit"] }]
      } as never, undefined, undefined, context),
      /at most 32 assigned task IDs/
    );
    const afterRejectedResume = readWorkerRecord(paths.recordFile);
    assert.equal(afterRejectedResume.taskIds.length, MAX_WORKER_TASK_IDS);
    assert.equal(afterRejectedResume.activeRun, undefined);
  });
});

test("resume rejects a poisoned artifacts symlink and removes the persistent container before failing", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(parentCwd, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910190000_poison01";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const forked = forkWorkerSession({
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      sessionDir: paths.sessionDir,
      sessionId: "worker-session-poison"
    });
    const container: WorkerContainerReference = {
      version: 1,
      workerId,
      runId: "run_20260910190000_oldcont1",
      name: "pi-worker-poison",
      nonce: "poison-container-nonce",
      image: "alpine@test",
      codeRoot: parentCwd,
      workspaceRoot: paths.workspaceRoot,
      containerId: "a".repeat(64)
    };
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-poison"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "handed_off",
      container,
      lastRun: { runId: "run-old", jobId: "job-old", status: "handed_off" },
      updatedAt: "2026-09-10T19:29:30.000Z"
    });
    await rm(paths.artifactsDir, { recursive: true, force: true });
    await symlink(parentCwd, paths.artifactsDir, "dir");
    const removed: WorkerContainerReference[] = [];
    let launched = false;
    const api = fakeApi();
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:31:00.000Z"),
      random: (() => {
        const values = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
        return () => values.shift() ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      })(),
      removeContainer: (reference) => { removed.push(reference); },
      launch: () => { launched = true; throw new Error("must not launch"); }
    });
    const context = parentContext(parentCwd, parentSessionFile);
    const tool = api.tools.find((candidate) => candidate.name === "worker_run");
    assert.ok(tool?.execute);
    const result = await tool.execute("call-poison", {
      runs: [{ kind: "resume", workerId, message: "resume safely" }]
    } as never, undefined, undefined, context);
    const receipt = (result.details as { runs: Array<{ runId: string }> }).runs[0];
    await api.emit("turn_end", {}, context);

    assert.equal(launched, false);
    assert.deepEqual(removed, [container]);
    assert.equal(existsSync(path.join(parentCwd, `parent-context-${receipt.runId}.jsonl`)), false);
    const failed = readWorkerRecord(paths.recordFile);
    assert.equal(failed.status, "failed");
    assert.equal(failed.activeRun, undefined);
    assert.equal(failed.container, undefined);
  });
});

test("session restart does not invalidate a queued run leased by another live parent", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910190000_queueown";
    const runId = "run_20260910193000_queueown";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    assert.ok(owner.pid);
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "worker-session-queue-owner",
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-queue-owner"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "queued",
      activeRun: { runId, jobId: "job_20260910193000_queueown", status: "queued" },
      updatedAt: "2026-09-10T19:30:00.000Z"
    });
    acquireWorkerLease(paths.leaseFile, {
      version: 1,
      workerId,
      runId,
      parentPid: owner.pid,
      acquiredAt: "2026-09-10T19:30:00.000Z"
    });
    const api = fakeApi();
    registerWorkerExtension(api, { roots, now: () => new Date("2026-09-10T19:31:00.000Z") });
    const context = parentContext(parentCwd, parentSessionFile);
    await api.emit("session_start", {}, context);
    assert.equal(readWorkerRecord(paths.recordFile).status, "queued");
    await api.emit("session_shutdown", {}, context);
    owner.kill("SIGKILL");
  });
});

test("restart cleanup failure remains explicitly cancellable after container control recovers", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910190000_recover1";
    const runId = "run_20260910193000_recover1";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const container: WorkerContainerReference = {
      version: 1,
      workerId,
      runId,
      name: "pi-worker-recovery",
      nonce: "recovery-container-nonce",
      image: "alpine@test",
      codeRoot: parentCwd,
      workspaceRoot: paths.workspaceRoot,
      containerId: "b".repeat(64)
    };
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "worker-session-recovery",
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-recovery"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "running",
      container,
      activeRun: {
        runId,
        jobId: "job_20260910193000_recover1",
        status: "running",
        pid: 2_147_483_000,
        container,
        cleanupOwner: "dead-parent-cleanup-owner"
      },
      updatedAt: "2026-09-10T19:30:00.000Z"
    });
    acquireWorkerLease(paths.leaseFile, {
      version: 1,
      workerId,
      runId,
      parentPid: 2_147_483_000,
      acquiredAt: "2026-09-10T19:30:00.000Z"
    });
    let unavailable = true;
    let removals = 0;
    const api = fakeApi();
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:32:00.000Z"),
      removeContainer: () => {
        removals += 1;
        if (unavailable) throw new Error("Docker temporarily unavailable");
      }
    });
    const context = parentContext(parentCwd, parentSessionFile);
    await api.emit("session_start", {}, context);
    const uncertain = readWorkerRecord(paths.recordFile);
    assert.equal(uncertain.activeRun?.hostProcessSettled, true);
    assert.equal(uncertain.activeRun?.cleanupOwner, undefined);
    assert.match(uncertain.activeRun?.recoveryError ?? "", /Docker temporarily unavailable/);
    assert.equal(uncertain.container?.containerId, container.containerId);

    unavailable = false;
    const cancel = api.commands.get("worker:cancel");
    assert.ok(cancel);
    await cancel.handler(workerId, context);
    const cancelled = readWorkerRecord(paths.recordFile);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.activeRun, undefined);
    assert.equal(cancelled.container, undefined);
    assert.equal(removals, 2);
  });
});

test("recovery retains an unverified pre-marker host until its process group exits and revokes late startup", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910190000_premarke";
    const runId = "run_20260910193000_premarke";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const runDir = path.join(paths.stateDir, "runs", runId);
    const authorizationFile = path.join(runDir, "host-authorization.json");
    await mkdir(runDir, { recursive: true });
    await writeFile(authorizationFile, "authorized\n");
    const suspendedHost = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    assert.ok(suspendedHost.pid);
    suspendedHost.unref();
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "worker-session-premarker",
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-premarker"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "running",
      activeRun: { runId, jobId: "job_20260910193000_premarke", status: "running", pid: suspendedHost.pid },
      updatedAt: "2026-09-10T19:30:00.000Z"
    });
    const api = fakeApi();
    const context = parentContext(parentCwd, parentSessionFile);
    registerWorkerExtension(api, { roots, now: () => new Date("2026-09-10T19:32:00.000Z") });
    await api.emit("session_start", {}, context);
    assert.equal(readWorkerRecord(paths.recordFile).activeRun?.runId, runId);
    assert.equal(existsSync(authorizationFile), true);

    process.kill(-suspendedHost.pid, "SIGKILL");
    for (let attempt = 0; attempt < 100 && readWorkerRecord(paths.recordFile).activeRun; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const recovered = readWorkerRecord(paths.recordFile);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.activeRun, undefined);
    assert.equal(existsSync(authorizationFile), false);
    await api.emit("session_shutdown", {}, context);
  });
});

test("session restart recovers a spawned host from its process marker before parent PID persistence", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910190000_process1";
    const runId = "run_20260910193000_process1";
    const jobId = "job_20260910193000_process1";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const runDir = path.join(paths.stateDir, "runs", runId);
    const hostConfigFile = path.join(runDir, "host.json");
    const processFile = path.join(runDir, "host-process.json");
    const processNonce = "process-marker-nonce";
    await mkdir(runDir, { recursive: true });
    await writeFile(hostConfigFile, "{}\n");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", hostConfigFile], {
      detached: true,
      stdio: "ignore"
    });
    assert.ok(child.pid);
    child.unref();
    await writeFile(processFile, `${JSON.stringify({
      version: 1,
      workerId,
      runId,
      pid: child.pid,
      nonce: processNonce,
      hostConfigFile,
      startedAt: "2026-09-10T19:30:00.000Z"
    })}\n`);
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "worker-session-process",
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-process"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "running",
      activeRun: { runId, jobId, status: "running", hostConfigFile, processFile, processNonce },
      updatedAt: "2026-09-10T19:30:00.000Z"
    });
    const api = fakeApi();
    registerWorkerExtension(api, { roots, now: () => new Date("2026-09-10T19:30:01.000Z") });
    await api.emit("session_start", {}, parentContext(parentCwd, parentSessionFile));
    assert.equal(readWorkerRecord(paths.recordFile).activeRun?.pid, child.pid);
    await api.emit("session_shutdown", {}, parentContext(parentCwd, parentSessionFile));
    process.kill(-child.pid, "SIGKILL");
  });
});

test("session restart adopts a settled durable worker handoff", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const context = parentContext(parentCwd, parentSessionFile);
    const api = fakeApi();
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910190000_adopt001";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const runId = "run_20260910193000_adopt001";
    const jobId = "job_20260910193000_adopt001";
    const resultFile = path.join(paths.stateDir, "runs", runId, "result.json");
    await mkdir(path.dirname(resultFile), { recursive: true });
    await writeFile(resultFile, `${JSON.stringify({
      version: 1,
      workerId,
      runId,
      acceptedAt: "2026-09-10T19:31:00.000Z",
      handoff: { state: "ready_for_review", summary: "recovered", taskUpdates: [] }
    })}\n`);
    const settledFile = path.join(paths.stateDir, "runs", runId, "settled.json");
    await writeFile(settledFile, `${JSON.stringify({
      version: 1,
      workerId,
      runId,
      sessionId: "worker-session-adopt",
      resultFile,
      settledAt: "2026-09-10T19:31:01.000Z"
    })}\n`);
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "worker-session-adopt",
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-adopt"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "running",
      activeRun: { runId, jobId, status: "running", pid: 2_147_483_000, resultFile, settledFile },
      updatedAt: "2026-09-10T19:30:00.000Z"
    });
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:32:00.000Z")
    });
    await api.emit("session_start", {}, context);

    const recovered = readWorkerRecord(paths.recordFile);
    assert.equal(recovered.status, "handed_off");
    assert.equal(recovered.activeRun, undefined);
    assert.equal(recovered.lastRun?.resultFile, resultFile);
    assert.equal(api.messages.length, 1);
    assert.match(JSON.stringify(api.messages[0].message), /ready_for_review/);
  });
});

test("session restart rejects an unverified handoff without a host settlement marker", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910190000_unverify";
    const runId = "run_20260910193000_unverify";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const resultFile = path.join(paths.stateDir, "runs", runId, "result.json");
    await mkdir(path.dirname(resultFile), { recursive: true });
    await writeFile(resultFile, `${JSON.stringify({
      version: 1,
      workerId,
      runId,
      acceptedAt: "2026-09-10T19:31:00.000Z",
      handoff: { state: "assignment_complete", summary: "not host verified", taskUpdates: [] }
    })}\n`);
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "worker-session-unverified",
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-unverified"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "running",
      activeRun: {
        runId,
        jobId: "job_20260910193000_unverify",
        status: "running",
        pid: 2_147_483_000,
        resultFile,
        settledFile: path.join(path.dirname(resultFile), "settled.json")
      },
      updatedAt: "2026-09-10T19:30:00.000Z"
    });
    const api = fakeApi();
    registerWorkerExtension(api, { roots, now: () => new Date("2026-09-10T19:32:00.000Z") });
    await api.emit("session_start", {}, parentContext(parentCwd, parentSessionFile));
    const recovered = readWorkerRecord(paths.recordFile);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.lastRun?.resultFile, undefined);
    assert.match(JSON.stringify(api.messages[0].message), /before the host verified final session identity and quiescence/);
  });
});

test("session restart does not redeliver an uncertain worker completion and explicit acknowledgment resolves it", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910190000_deliver1";
    const runId = "run_20260910193000_deliver1";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const resultFile = path.join(paths.stateDir, "runs", runId, "result.json");
    await mkdir(path.dirname(resultFile), { recursive: true });
    await writeFile(resultFile, `${JSON.stringify({
      version: 1,
      workerId,
      runId,
      acceptedAt: "2026-09-10T19:31:00.000Z",
      handoff: { state: "checkpoint", summary: "redeliver me", taskUpdates: [] }
    })}\n`);
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "worker-session-delivery",
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-delivery"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "handed_off",
      lastRun: {
        runId,
        jobId: "job_20260910193000_deliver1",
        status: "handed_off",
        resultFile,
        delivery: "pending",
        processStatus: "exited",
        exitCode: 0,
        logDir: path.join(paths.stateDir, "runs", runId),
        stdoutLog: path.join(paths.stateDir, "runs", runId, "stdout.log"),
        stderrLog: path.join(paths.stateDir, "runs", runId, "stderr.log")
      },
      updatedAt: "2026-09-10T19:31:01.000Z"
    });
    const api = fakeApi();
    const context = parentContext(parentCwd, parentSessionFile);
    registerWorkerExtension(api, { roots, now: () => new Date("2026-09-10T19:32:00.000Z") });
    const status = api.commands.get("worker:status");
    assert.ok(status);
    await assert.rejects(
      async () => status.handler(workerId, parentContext(parentCwd, path.join(directory, "different-parent.jsonl"))),
      /different parent session/
    );
    await api.emit("session_start", {}, context);
    assert.equal(api.messages.length, 0, "an ambiguous prior delivery must not be replayed after restart");
    assert.equal(readWorkerRecord(paths.recordFile).lastRun?.delivery, "pending");

    const acknowledge = api.commands.get("worker:ack");
    assert.ok(acknowledge);
    await acknowledge.handler(workerId, context);
    assert.equal(readWorkerRecord(paths.recordFile).lastRun?.delivery, "delivered");
  });
});

test("worker_control cancels and settles an attached running host without duplicate completion delivery", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const context = parentContext(parentCwd, parentSessionFile);
    const api = fakeApi();
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const randomValues = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444"
    ];
    const attachedMarker = path.join(parentCwd, "attached-ready");
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:30:00.000Z"),
      random: () => randomValues.shift() ?? "55555555-5555-4555-8555-555555555555",
      launch: (extensionApi, extensionContext, request) => startManagedAsyncJob(extensionApi, extensionContext, {
        jobId: request.jobId,
        command: "attached cancellation probe",
        cwd: parentCwd,
        executable: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(attachedMarker)},'ready');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],
        notifyOnExit: false
      })
    });
    const tool = api.tools.find((candidate) => candidate.name === "worker_run");
    assert.ok(tool?.execute);
    const result = await tool.execute("call-attached", { runs: [{ kind: "new", taskIds: ["personal-test"] }] } as never, undefined, undefined, context);
    const workerId = (result.details as { runs: Array<{ workerId: string }> }).runs[0].workerId;
    await api.emit("turn_end", {}, context);
    for (let attempt = 0; attempt < 200 && !existsSync(attachedMarker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(existsSync(attachedMarker));
    const control = api.tools.find((candidate) => candidate.name === "worker_control");
    assert.ok(control?.execute);
    const cancellation = await control.execute("control-cancel-attached", { action: "cancel", workerId } as never, undefined, undefined, context);
    assert.equal(Check(RetainedToolOutputSchemas.worker_control, cancellation), true);
    const record = readWorkerRecord(workerPaths(roots, workerId).recordFile);
    assert.equal(record.status, "cancelled");
    assert.equal(record.activeRun, undefined);
    assert.equal(record.lastRun?.delivery, "delivered");
    assert.equal(api.messages.length, 0, "the synchronous control result already observes cancellation");
  });
});

test("detached cancellation retains ownership when live host verification fails and succeeds after proven exit", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910190000_badmark1";
    const runId = "run_20260910193000_badmark1";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const runDir = path.join(paths.stateDir, "runs", runId);
    const processFile = path.join(runDir, "host-process.json");
    const hostConfigFile = path.join(runDir, "host.json");
    await mkdir(runDir, { recursive: true });
    await writeFile(processFile, "{malformed\n");
    await writeFile(hostConfigFile, "{}\n");
    const liveHost = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", hostConfigFile], { detached: true, stdio: "ignore" });
    assert.ok(liveHost.pid);
    liveHost.unref();
    const container: WorkerContainerReference = {
      version: 1,
      workerId,
      runId,
      name: "pi-worker-bad-marker",
      nonce: "bad-marker-container",
      image: "alpine@test",
      codeRoot: parentCwd,
      workspaceRoot: paths.workspaceRoot,
      containerId: "d".repeat(64)
    };
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "worker-session-bad-marker",
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-bad-marker"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "running",
      container,
      activeRun: {
        runId,
        jobId: "job_20260910193000_badmark1",
        status: "running",
        pid: liveHost.pid,
        processFile,
        processNonce: "bad-marker-nonce",
        hostConfigFile,
        container
      },
      updatedAt: "2026-09-10T19:30:00.000Z"
    });
    let removals = 0;
    const api = fakeApi();
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:32:00.000Z"),
      removeContainer: () => { removals += 1; }
    });
    const context = parentContext(parentCwd, parentSessionFile);
    const cancel = api.commands.get("worker:cancel");
    assert.ok(cancel);
    await assert.rejects(async () => cancel.handler(workerId, context), /no verified host process/);
    const retained = readWorkerRecord(paths.recordFile);
    assert.equal(retained.activeRun?.hostProcessSettled, false);
    assert.equal(retained.activeRun?.cleanupOwner, undefined);
    assert.equal(retained.container?.containerId, container.containerId);
    assert.equal(existsSync(paths.leaseFile), true);
    assert.equal(removals, 0);

    process.kill(-liveHost.pid, "SIGKILL");
    for (let attempt = 0; attempt < 200 && isProcessAliveForTest(liveHost.pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(isProcessAliveForTest(liveHost.pid), false);
    await cancel.handler(workerId, context);
    const cancelled = readWorkerRecord(paths.recordFile);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.activeRun, undefined);
    assert.equal(cancelled.container, undefined);
    assert.equal(removals, 1);
  });
});

test("worker:cancel verifies and finalizes a detached host with durable delivery", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910193000_detach01";
    const runId = "run_20260910193100_detach01";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const runDir = path.join(paths.stateDir, "runs", runId);
    const processFile = path.join(runDir, "host-process.json");
    const hostConfigFile = path.join(runDir, "host.json");
    const processNonce = "detached-process-nonce";
    await mkdir(runDir, { recursive: true });
    await writeFile(hostConfigFile, "{}\n");
    const host = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", hostConfigFile], {
      cwd: paths.workspaceRoot,
      detached: true,
      stdio: "ignore"
    });
    assert.ok(host.pid);
    await writeFile(processFile, `${JSON.stringify({
      version: 1,
      workerId,
      runId,
      pid: host.pid,
      nonce: processNonce,
      hostConfigFile,
      startedAt: "2026-09-10T19:30:00.000Z"
    })}\n`);
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "worker-session-detached",
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-detached"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "running",
      activeRun: {
        runId,
        jobId: "job_20260910193100_detach01",
        status: "running",
        pid: host.pid,
        logDir: runDir,
        stdoutLog: path.join(runDir, "stdout.log"),
        stderrLog: path.join(runDir, "stderr.log"),
        processFile,
        processNonce,
        hostConfigFile
      },
      updatedAt: "2026-09-10T19:30:00.000Z"
    });
    acquireWorkerLease(paths.leaseFile, {
      version: 1,
      workerId,
      runId,
      parentPid: process.pid,
      acquiredAt: "2026-09-10T19:30:00.000Z"
    });
    const api = fakeApi();
    registerWorkerExtension(api, { roots, now: () => new Date("2026-09-10T19:32:00.000Z") });
    const cancel = api.commands.get("worker:cancel");
    assert.ok(cancel);
    await cancel.handler(workerId, parentContext(parentCwd, parentSessionFile));
    const record = readWorkerRecord(paths.recordFile);
    assert.equal(record.status, "cancelled");
    assert.equal(record.activeRun, undefined);
    assert.equal(record.lastRun?.delivery, "pending");
    assert.match(JSON.stringify(api.messages.at(-1)?.message), /semantic: cancelled/);
    assert.equal(existsSync(paths.leaseFile), false);
  });
});

test("worker:cancel removes a queued resume container and makes cleanup failure retryable", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910190000_queuecn1";
    const runId = "run_20260910193000_queuecn1";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const container: WorkerContainerReference = {
      version: 1,
      workerId,
      runId: "run_20260910190000_prior001",
      name: "pi-worker-queued-resume",
      nonce: "queued-resume-container",
      image: "alpine@test",
      codeRoot: parentCwd,
      workspaceRoot: paths.workspaceRoot,
      containerId: "c".repeat(64)
    };
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "worker-session-queued-resume",
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-queued-resume"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "queued",
      container,
      activeRun: { runId, jobId: "job_20260910193000_queuecn1", status: "queued" },
      updatedAt: "2026-09-10T19:30:00.000Z"
    });
    acquireWorkerLease(paths.leaseFile, {
      version: 1,
      workerId,
      runId,
      parentPid: process.pid,
      acquiredAt: "2026-09-10T19:30:00.000Z"
    });
    let failCleanup = true;
    let removals = 0;
    const api = fakeApi();
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:32:00.000Z"),
      removeContainer: () => {
        removals += 1;
        if (failCleanup) throw new Error("queued container cleanup unavailable");
      }
    });
    const context = parentContext(parentCwd, parentSessionFile);
    const cancel = api.commands.get("worker:cancel");
    assert.ok(cancel);
    await assert.rejects(async () => cancel.handler(workerId, context), /queued container cleanup unavailable/);
    const uncertain = readWorkerRecord(paths.recordFile);
    assert.equal(uncertain.activeRun?.status, "running");
    assert.equal(uncertain.activeRun?.hostProcessSettled, true);
    assert.match(uncertain.activeRun?.recoveryError ?? "", /queued container cleanup unavailable/);
    assert.equal(uncertain.container?.containerId, container.containerId);
    assert.equal(existsSync(paths.leaseFile), true);

    failCleanup = false;
    await cancel.handler(workerId, context);
    const cancelled = readWorkerRecord(paths.recordFile);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.activeRun, undefined);
    assert.equal(cancelled.container, undefined);
    assert.equal(existsSync(paths.leaseFile), false);
    assert.equal(removals, 2);
  });
});

test("worker_control lists exact-session workers and validates a typed result before acknowledging delivery", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910190000_control1";
    const runId = "run_20260910193000_control1";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const resultFile = path.join(paths.stateDir, "runs", runId, "result.json");
    await mkdir(path.dirname(resultFile), { recursive: true });
    const repositoryInventory = persistRepositoryInventory(path.join(path.dirname(resultFile), "repository-candidates.json"), {
      version: 2,
      workerId,
      runId,
      workspaceRoot: paths.workspaceRoot,
      generatedAt: "2026-09-10T19:31:00.500Z",
      candidates: [{
        candidateId: "candidate_aaaaaaaaaaaaaaaaaaaaaaaa",
        workerId,
        runId,
        workspaceRepo: "repos/project",
        reported: true,
        purpose: "control candidate",
        dependsOn: [],
        baseCommit: "a".repeat(40),
        baseTree: "b".repeat(40),
        headCommit: "c".repeat(40),
        headTree: "d".repeat(40),
        dirty: false,
        committedChanged: true,
        foldable: true,
        policyIssues: []
      }],
      reportedIssues: [],
      scanCoverage: { complete: true, limitations: [] }
    });
    await writeFile(resultFile, `${JSON.stringify({
      version: 1,
      workerId,
      runId,
      acceptedAt: "2026-09-10T19:31:00.000Z",
      handoff: {
        state: "ready_for_review",
        summary: "control result",
        taskUpdates: [{ taskId: "personal-control", update: "implemented" }],
        checks: [{ cwd: paths.workspaceRoot, command: "npm test", outcome: "passed" }]
      }
    })}\n`);
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "worker-session-control",
      sessionFile: path.join(paths.sessionDir, "session.jsonl"),
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: Array.from({ length: MAX_WORKER_TASK_IDS }, (_, index) => `personal-control.${index + 1}`),
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "handed_off",
      lastRun: {
        runId,
        jobId: "job_20260910193000_control1",
        status: "handed_off",
        resultFile,
        delivery: "pending",
        completionDelivery: "followUp",
        stdoutLog: path.join(path.dirname(resultFile), "stdout.log"),
        stderrLog: path.join(path.dirname(resultFile), "stderr.log"),
        repositoryInventory
      },
      updatedAt: "2026-09-10T19:31:01.000Z"
    });
    const otherWorkerId = "worker_20260910190000_other002";
    const otherPaths = workerPaths(roots, otherWorkerId);
    provisionWorkerPaths(otherPaths);
    writeWorkerRecord(otherPaths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId: otherWorkerId,
      sessionId: "worker-session-other",
      parentSessionFile: path.join(directory, "other-parent.jsonl"),
      workspaceRoot: otherPaths.workspaceRoot,
      taskIds: ["personal-other"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "cancelled",
      updatedAt: "2026-09-10T19:31:01.000Z"
    });

    const api = fakeApi();
    const context = parentContext(parentCwd, parentSessionFile);
    registerWorkerExtension(api, { roots, now: () => new Date("2026-09-10T19:32:00.000Z") });
    const control = api.tools.find((candidate) => candidate.name === "worker_control");
    assert.ok(control?.execute);

    const status = await control.execute("control-status", { action: "status" } as never, undefined, undefined, context);
    const statusDetails = status.details as { action: string; workers: Array<{ workerId: string; lastRun?: { repositoryInventory?: { candidateCount: number } } }> };
    assert.equal(Check(RetainedToolOutputSchemas.worker_control, status), true);
    assert.equal(statusDetails.action, "status");
    assert.deepEqual(statusDetails.workers.map((worker) => worker.workerId), [workerId]);
    assert.equal(statusDetails.workers[0]?.lastRun?.repositoryInventory?.candidateCount, 1);
    assert.doesNotMatch(JSON.stringify(status.content), /repository_inventory|candidate_aaaaaaaa/);
    const oneWorkerStatus = await control.execute("control-status-one", { action: "status", workerId } as never, undefined, undefined, context);
    assert.match(JSON.stringify(oneWorkerStatus.content), /repository_inventory|candidate_aaaaaaaa/);

    const inventoryText = await readFile(repositoryInventory.inventoryFile, "utf8");
    await writeFile(repositoryInventory.inventoryFile, `${inventoryText} `);
    await assert.rejects(
      async () => control.execute("control-poisoned-inventory", { action: "result", workerId } as never, undefined, undefined, context),
      /inventory hash mismatch/
    );
    assert.equal(readWorkerRecord(paths.recordFile).lastRun?.delivery, "pending");
    await writeFile(repositoryInventory.inventoryFile, inventoryText);

    const result = await control.execute("control-result", { action: "result", workerId } as never, undefined, undefined, context);
    const resultDetails = result.details as { action: string; acknowledgedDelivery: boolean; delivery?: string; handoff?: { handoff: { summary: string } }; repositories?: { candidates: Array<{ workspaceRepo: string; foldable: boolean }> } };
    assert.equal(Check(RetainedToolOutputSchemas.worker_control, result), true);
    assert.equal(resultDetails.action, "result");
    assert.equal(resultDetails.acknowledgedDelivery, true);
    assert.equal(resultDetails.handoff?.handoff.summary, "control result");
    assert.equal(resultDetails.delivery, "delivered");
    assert.deepEqual(resultDetails.repositories?.candidates.map((candidate) => [candidate.workspaceRepo, candidate.foldable]), [["repos/project", true]]);
    assert.match(JSON.stringify(result.content), /control result/);
    assert.match(JSON.stringify(result.content), /candidate_aaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.equal(readWorkerRecord(paths.recordFile).lastRun?.delivery, "delivered");
    const observedAgain = await control.execute("control-result-again", { action: "result", workerId } as never, undefined, undefined, context);
    assert.equal((observedAgain.details as { acknowledgedDelivery: boolean }).acknowledgedDelivery, false);

    await assert.rejects(
      async () => control.execute("control-wrong-parent", { action: "status", workerId } as never, undefined, undefined, parentContext(parentCwd, path.join(directory, "other-parent.jsonl"))),
      /different parent session/
    );
  });
});

test("worker_control refuses a poisoned handoff without acknowledging delivery", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, "parent\n");
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const workerId = "worker_20260910190000_poison01";
    const runId = "run_20260910193000_poison01";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const resultFile = path.join(paths.stateDir, "runs", runId, "result.json");
    await mkdir(path.dirname(resultFile), { recursive: true });
    await writeFile(resultFile, `${JSON.stringify({
      version: 1,
      workerId: "worker_20260910190000_wrong001",
      runId,
      acceptedAt: "2026-09-10T19:31:00.000Z",
      handoff: { state: "checkpoint", summary: "poisoned", taskUpdates: [] }
    })}\n`);
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "worker-session-poison",
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-poison"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "handed_off",
      lastRun: { runId, jobId: "job_20260910193000_poison01", status: "handed_off", resultFile, delivery: "pending" },
      updatedAt: "2026-09-10T19:31:01.000Z"
    });
    const api = fakeApi();
    registerWorkerExtension(api, { roots });
    const control = api.tools.find((candidate) => candidate.name === "worker_control");
    assert.ok(control?.execute);
    await assert.rejects(
      async () => control.execute("control-poison", { action: "result", workerId } as never, undefined, undefined, parentContext(parentCwd, parentSessionFile)),
      /handoff identity mismatch/
    );
    assert.equal(readWorkerRecord(paths.recordFile).lastRun?.delivery, "pending");
  });
});

test("worker_control cancels queued work and discards the settled worker", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const context = parentContext(parentCwd, parentSessionFile);
    const api = fakeApi();
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    let launches = 0;
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:30:00.000Z"),
      random: () => "22222222-2222-4222-8222-222222222222",
      launch: () => {
        launches += 1;
        throw new Error("cancelled queued run must not launch");
      }
    });
    const run = api.tools.find((candidate) => candidate.name === "worker_run");
    const control = api.tools.find((candidate) => candidate.name === "worker_control");
    assert.ok(run?.execute);
    assert.ok(control?.execute);
    const started = await run.execute("control-new", {
      runs: [{ kind: "new", taskIds: ["personal-control"], completionDelivery: "followUp" }]
    } as never, undefined, undefined, context);
    const workerId = (started.details as { runs: Array<{ workerId: string }> }).runs[0].workerId;

    await assert.rejects(
      async () => control.execute("control-discard-active", { action: "discard", workerId, confirm: true } as never, undefined, undefined, context),
      /became active before discard/
    );
    const cancelled = await control.execute("control-cancel", { action: "cancel", workerId } as never, undefined, undefined, context);
    assert.equal(Check(RetainedToolOutputSchemas.worker_control, cancelled), true);
    assert.equal((cancelled.details as { outcome: string }).outcome, "cancelled");
    const cancelledRecord = readWorkerRecord(workerPaths(roots, workerId).recordFile);
    assert.equal(cancelledRecord.lastRun?.delivery, "delivered");
    assert.equal(cancelledRecord.lastRun?.completionDelivery, "followUp");
    assert.equal(api.messages.length, 0, "the synchronous control result observes queued cancellation without another model message");
    await api.emit("turn_end", {}, context);
    assert.equal(launches, 0);
    assert.equal(api.messages.length, 0);
    assert.equal(readWorkerRecord(workerPaths(roots, workerId).recordFile).status, "cancelled");

    const discarded = await control.execute("control-discard", { action: "discard", workerId, confirm: true } as never, undefined, undefined, context);
    assert.equal(Check(RetainedToolOutputSchemas.worker_control, discarded), true);
    assert.equal((discarded.details as { discarded: boolean }).discarded, true);
    assert.equal(existsSync(workerPaths(roots, workerId).workspaceRoot), false);
    assert.equal(existsSync(workerPaths(roots, workerId).stateDir), false);
  });
});

test("worker:cancel removes a queued run before it can fork or launch", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    await mkdir(parentCwd);
    await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-09-10T19:29:00.000Z", cwd: parentCwd })}\n`);
    const context = parentContext(parentCwd, parentSessionFile);
    const api = fakeApi();
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    let launches = 0;
    registerWorkerExtension(api, {
      roots,
      now: () => new Date("2026-09-10T19:30:00.000Z"),
      random: () => "11111111-1111-4111-8111-111111111111",
      launch: () => {
        launches += 1;
        throw new Error("cancelled queued run must not launch");
      }
    });
    const tool = api.tools.find((candidate) => candidate.name === "worker_run");
    assert.ok(tool?.execute);
    const result = await tool.execute("call-1", {
      runs: [{ kind: "new", taskIds: ["personal-test"] }]
    } as never, undefined, undefined, context);
    const receipt = (result.details as { runs: Array<{ workerId: string }> }).runs[0];
    const cancel = api.commands.get("worker:cancel");
    assert.ok(cancel);
    await cancel.handler(receipt.workerId, context);
    assert.equal(api.messages.length, 1, "user cancellation keeps normal completion delivery");
    await api.emit("turn_end", {}, context);

    const record = readWorkerRecord(workerPaths(roots, receipt.workerId).recordFile);
    assert.equal(record.status, "cancelled");
    assert.equal(record.activeRun, undefined);
    assert.equal(record.lastRun?.status, "cancelled");
    assert.equal(record.lastRun?.delivery, "pending");
    assert.equal(record.lastRun?.completionDelivery, "steer");
    assert.equal(launches, 0);

    const discard = api.commands.get("worker:discard");
    assert.ok(discard);
    await discard.handler(`${receipt.workerId} --confirm`, context);
    assert.equal(existsSync(workerPaths(roots, receipt.workerId).workspaceRoot), false);
    assert.equal(existsSync(workerPaths(roots, receipt.workerId).stateDir), false);
  });
});


test("worker:list defaults to active current-chat workers and --all includes settled workers", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const parentSessionFile = path.join(directory, "parent.jsonl");
    const foreignSessionFile = path.join(directory, "foreign.jsonl");
    await mkdir(parentCwd);
    await Promise.all([
      writeFile(parentSessionFile, "{}\n"),
      writeFile(foreignSessionFile, "{}\n")
    ]);
    const roots = { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") };
    const records: WorkerRecord[] = [
      {
        version: WORKER_RECORD_VERSION,
        workerId: "worker_20260922150000_list0001",
        sessionId: "session-list-1",
        parentSessionFile,
        workspaceRoot: workerPaths(roots, "worker_20260922150000_list0001").workspaceRoot,
        taskIds: ["personal-alpha"],
        route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "high" },
        status: "running",
        activeRun: { runId: "run_20260922150000_list0001", jobId: "job_20260922150000_list0001", status: "running" },
        updatedAt: "2026-09-22T15:00:00.000Z"
      },
      {
        version: WORKER_RECORD_VERSION,
        workerId: "worker_20260922150000_list0002",
        sessionId: "session-list-2",
        parentSessionFile,
        workspaceRoot: workerPaths(roots, "worker_20260922150000_list0002").workspaceRoot,
        taskIds: ["personal-beta", "personal-gamma"],
        route: { provider: "anthropic", model: "claude-test", thinkingLevel: "xhigh" },
        status: "handed_off",
        lastRun: { runId: "run_20260922150000_list0002", jobId: "job_20260922150000_list0002", status: "handed_off", completionDelivery: "steer" },
        updatedAt: "2026-09-22T15:01:00.000Z"
      },
      {
        version: WORKER_RECORD_VERSION,
        workerId: "worker_20260922150000_foreign1",
        sessionId: "session-foreign",
        parentSessionFile: foreignSessionFile,
        workspaceRoot: workerPaths(roots, "worker_20260922150000_foreign1").workspaceRoot,
        taskIds: ["personal-foreign"],
        route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "low" },
        status: "queued",
        updatedAt: "2026-09-22T15:02:00.000Z"
      }
    ];
    for (const record of records) {
      const paths = workerPaths(roots, record.workerId);
      provisionWorkerPaths(paths);
      writeWorkerRecord(paths.recordFile, record);
    }

    const notifications: string[] = [];
    const context = parentContext(parentCwd, parentSessionFile);
    context.ui.notify = (message: string) => { notifications.push(message); };
    const api = fakeApi();
    registerWorkerExtension(api, { roots });
    const list = api.commands.get("worker:list");
    assert.ok(list);

    await list.handler("", context);
    assert.match(notifications.at(-1) ?? "", /1 active managed worker in this chat · 1 running/);
    assert.match(notifications.at(-1) ?? "", /worker_20260922150000_list0001/);
    assert.doesNotMatch(notifications.at(-1) ?? "", /personal-beta|personal-gamma|foreign1|personal-foreign/);
    assert.match(notifications.at(-1) ?? "", /\/worker:list --all to include 1 settled worker/);
    assert.match(notifications.at(-1) ?? "", /\/worker:status <worker-id>/);

    await list.handler("--all", context);
    assert.match(notifications.at(-1) ?? "", /2 managed workers in this chat · 1 running, 1 handed_off/);
    assert.match(notifications.at(-1) ?? "", /personal-beta, personal-gamma/);
    assert.doesNotMatch(notifications.at(-1) ?? "", /foreign1|personal-foreign/);

    await list.handler("unexpected", context);
    assert.equal(notifications.at(-1), "Usage: /worker:list [--all]");

    const extraRecords = Array.from({ length: 99 }, (_, index): WorkerRecord => {
      const workerId = `worker_20260922150001_${String(index).padStart(8, "0")}`;
      return {
        version: WORKER_RECORD_VERSION,
        workerId,
        sessionId: `session-extra-${index}`,
        parentSessionFile,
        workspaceRoot: workerPaths(roots, workerId).workspaceRoot,
        taskIds: [`personal-extra${index}`],
        route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "low" },
        status: "queued",
        updatedAt: "2026-09-22T15:03:00.000Z"
      };
    });
    for (const record of extraRecords) {
      const paths = workerPaths(roots, record.workerId);
      provisionWorkerPaths(paths);
      writeWorkerRecord(paths.recordFile, record);
    }
    await list.handler("", context);
    assert.match(notifications.at(-1) ?? "", /100 active managed workers in this chat/);
    assert.doesNotMatch(notifications.at(-1) ?? "", /\+1 more workers/);
    await list.handler("--all", context);
    assert.match(notifications.at(-1) ?? "", /101 managed workers in this chat/);
    assert.match(notifications.at(-1) ?? "", /\+1 more workers/);

    await Promise.all(extraRecords.map((record) => rm(workerPaths(roots, record.workerId).stateDir, { recursive: true, force: true })));
    await rm(workerPaths(roots, records[0]!.workerId).stateDir, { recursive: true, force: true });
    await list.handler("", context);
    assert.equal(notifications.at(-1), "No active managed workers belong to this chat. Use /worker:list --all to include 1 settled worker.");

    await rm(workerPaths(roots, records[1]!.workerId).stateDir, { recursive: true, force: true });
    await list.handler("", context);
    assert.equal(notifications.at(-1), "No managed workers belong to this chat.");
  });
});

test("worker_run and worker_control render compact lifecycle snippets", async () => {
  await withTempDir(async (directory) => {
    const api = fakeApi();
    registerWorkerExtension(api, { roots: { stateRoot: path.join(directory, "workers"), workspaceRoot: path.join(directory, "workspaces") } });
    const workerRun = api.tools.find((tool) => tool.name === "worker_run");
    const workerControl = api.tools.find((tool) => tool.name === "worker_control");
    assert.ok(workerRun);
    assert.ok(workerControl);
    const workerId = "worker_20260922141407_841146f1";
    const workerId2 = "worker_20260922141500_22222222";

    assert.match(renderWorkerToolCall(workerRun, {}), /⏺ Worker\(no runs\)…/);
    assert.match(renderWorkerToolCall(workerRun, { runs: [{}] }), /⏺ Worker\(new · 0 tasks\)…/);
    assert.match(renderWorkerToolCall(workerRun, { runs: [{ kind: "new", taskIds: ["personal-a"], route: "openai-codex/gpt-5.6-luna:low" }] }), /⏺ Worker\(new · 1 task · openai-codex\/gpt-5\.6-luna:low\)…/);
    assert.match(renderWorkerToolCall(workerRun, { runs: [{ kind: "resume", workerId, message: "continue" }] }), /⏺ Worker\(resume worker_202…41146f1\)…/);
    assert.match(renderWorkerToolCall(workerRun, { runs: [
      { kind: "new", taskIds: ["personal-a"] },
      { kind: "new", taskIds: ["personal-b", "personal-c"] },
      { kind: "resume", workerId: workerId2, message: "continue" }
    ] }), /⏺ Worker\(3 runs · new · 1 task, new · 2 tasks, \+1\)…/);

    const runResult = { content: [{ type: "text", text: "provider-visible receipt" }], details: { runs: [
      { workerId, runId: "run_a", jobId: "job_a", sessionId: "session_a", workspaceRoot: "/tmp/a", taskIds: ["personal-a"], provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "low", completionDelivery: "steer", state: "queued" },
      { workerId: workerId2, runId: "run_b", jobId: "job_b", sessionId: "session_b", workspaceRoot: "/tmp/b", taskIds: ["personal-b", "personal-c"], provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "low", completionDelivery: "followUp", state: "running" }
    ] }
    };
    assert.match(renderWorkerToolResult(workerRun, runResult), /⎿ 2 workers · 1 queued, 1 running/);
    const expandedRuns = renderWorkerToolResult(workerRun, runResult, { expanded: true });
    assert.match(expandedRuns, /worker_202…41146f1/);
    assert.match(expandedRuns, /openai-codex\/gpt-5\.6-luna:low/);
    assert.match(expandedRuns, /personal-a/);
    assert.match(renderWorkerToolResult(workerRun, runResult, { isPartial: true }), /⎿ starting workers/);
    assert.match(renderWorkerToolResult(workerRun, { content: [{ type: "text", text: "sensitive internal failure" }], details: undefined }, {}, { isError: true }), /⎿ error: sensitive internal failure/);

    assert.match(renderWorkerToolCall(workerControl, {}), /⏺ Worker\(status · all\)…/);
    const malformedControlCall = renderWorkerToolCall(workerControl, { action: `bad\n${"x".repeat(100)}` });
    assert.equal(malformedControlCall.split("\n").length, 1);
    assert.doesNotMatch(malformedControlCall, /x{24}/);
    assert.match(renderWorkerToolCall(workerControl, { action: "status" }), /⏺ Worker\(status · all\)…/);
    assert.match(renderWorkerToolCall(workerControl, { action: "result", workerId }), /⏺ Worker\(result · worker_202…41146f1\)…/);
    assert.match(renderWorkerToolCall(workerControl, { action: "cancel", workerId }), /⏺ Worker\(cancel · worker_202…41146f1\)…/);
    assert.match(renderWorkerToolCall(workerControl, { action: "discard", workerId, confirm: true }), /⏺ Worker\(discard · worker_202…41146f1\)…/);

    const baseWorker = { workerId, status: "running", sessionId: "session_a", workspaceRoot: "/tmp/a", taskIds: ["personal-a"], route: { provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "low" }, updatedAt: "2026-09-22T14:00:00.000Z" };
    assert.match(renderWorkerToolResult(workerControl, { content: [], details: { action: "status", workers: [baseWorker, { ...baseWorker, workerId: workerId2, status: "handed_off", taskIds: ["personal-b", "personal-c"] }] } }), /⎿ 2 workers · 1 running, 1 handed_off/);
    assert.match(renderWorkerToolResult(workerControl, { content: [], details: { action: "status", workers: [baseWorker, { ...baseWorker, workerId: workerId2, status: "handed_off", taskIds: ["personal-b", "personal-c"] }] } }, { expanded: true }), /worker_202…41146f1/);
    const manyWorkers = Array.from({ length: 10 }, (_, index) => ({
      ...baseWorker,
      workerId: `worker_20260922141500_${String(index).padStart(8, "0")}`
    }));
    const boundedStatus = renderWorkerToolResult(workerControl, { content: [], details: { action: "status", workers: manyWorkers } }, { expanded: true });
    assert.match(boundedStatus, /\+2 more/);
    assert.doesNotMatch(boundedStatus, /00000008/);
    const controlResult = { content: [], details: { action: "result", workerId, runId: "run_a", jobId: "job_a", status: "handed_off", delivery: "delivered", completionDelivery: "steer", sessionId: "session_a", workspaceRoot: "/tmp/a", taskIds: ["personal-a"], route: baseWorker.route, acknowledgedDelivery: true, handoff: { version: 1, workerId, runId: "run_a", acceptedAt: "2026-09-22T14:00:00.000Z", handoff: { state: "assignment_complete", summary: "done", taskUpdates: [] } }, repositories: { version: 2, workerId, runId: "run_a", workspaceRoot: "/tmp/a", generatedAt: "2026-09-22T14:00:01.000Z", candidates: [{ candidateId: "candidate_aaaaaaaaaaaaaaaaaaaaaaaa", workerId, runId: "run_a", workspaceRepo: "repos/project", reported: true, purpose: "render", dependsOn: [], baseCommit: "a".repeat(40), baseTree: "b".repeat(40), headCommit: "c".repeat(40), headTree: "d".repeat(40), dirty: false, committedChanged: true, foldable: true, policyIssues: [] }], reportedIssues: [], scanCoverage: { complete: true, limitations: [] } } } };
    assert.match(renderWorkerToolResult(workerControl, controlResult), /⎿ result · handed_off · worker_202…41146f1 · assignment_complete · 1 candidate/);
    const expandedControlResult = renderWorkerToolResult(workerControl, controlResult, { expanded: true });
    assert.match(expandedControlResult, /run run_a · job job_a · delivered · steer · personal-a/);
    assert.match(expandedControlResult, /assignment_complete: done/);
    assert.match(expandedControlResult, /candidate_…aaaaaaa · repos\/project · foldable/);
    assert.match(renderWorkerToolResult(workerControl, { content: [], details: { action: "cancel", workerId, outcome: "cancelled", status: "cancelled", runId: "run_a", jobId: "job_a" } }), /⎿ cancelled · worker_202…41146f1 · cancelled/);
    assert.match(renderWorkerToolResult(workerControl, { content: [], details: { action: "discard", workerId, discarded: true } }), /⎿ discarded · worker_202…41146f1/);
    assert.match(renderWorkerToolResult(workerControl, { content: [], details: { action: "status", workers: [] } }, { isPartial: true }), /⎿ checking workers/);
    assert.match(renderWorkerToolResult(workerControl, { content: [{ type: "text", text: "control failure" }], details: undefined }, {}, { isError: true }), /⎿ error: control failure/);
  });
});

test("worker_fold_prepare resolves exact-session candidates and returns a strict durable summary", async () => {
  await withTempDir(async (directory) => {
    const roots = {
      stateRoot: path.join(directory, "workers"),
      workspaceRoot: path.join(directory, "workspaces")
    };
    const workerId = "worker_20260922220000_12345678";
    const runId = "run_20260922220000_87654321";
    const candidateId = "candidate_aaaaaaaaaaaaaaaaaaaaaaaa";
    const paths = workerPaths(roots, workerId);
    provisionWorkerPaths(paths);
    const inventory = {
      version: 2 as const,
      workerId,
      runId,
      workspaceRoot: paths.workspaceRoot,
      generatedAt: "2026-09-22T22:00:00.000Z",
      candidates: [{
        candidateId,
        workerId,
        runId,
        workspaceRepo: "repos/project",
        reported: true,
        purpose: "project",
        dependsOn: [],
        source: "/tmp/source",
        baseCommit: "a".repeat(40),
        baseTree: "b".repeat(40),
        headCommit: "c".repeat(40),
        headTree: "d".repeat(40),
        dirty: false,
        committedChanged: true,
        foldable: true,
        policyIssues: []
      }],
      reportedIssues: [],
      scanCoverage: { complete: true, limitations: [] }
    };
    const repositoryInventory = persistRepositoryInventory(path.join(paths.stateDir, "runs", runId, "repository-candidates.json"), inventory);
    const parentSessionFile = path.join(directory, "parent.jsonl");
    writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId,
      sessionId: "019c0000-0000-7000-8000-000000000001",
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-test"],
      route: { provider: "openai-codex", model: "gpt-test", thinkingLevel: "xhigh" },
      status: "handed_off",
      lastRun: {
        runId,
        jobId: "job_20260922220000_abcdefgh",
        status: "handed_off",
        completionDelivery: "steer",
        repositoryInventory
      },
      updatedAt: "2026-09-22T22:00:00.000Z"
    });

    let resolvedCandidate = "";
    const summary = {
      preparedId: "prepared_bbbbbbbbbbbbbbbbbbbbbbbb",
      manifestFile: path.join(directory, "folds", "prepared_bbbbbbbbbbbbbbbbbbbbbbbb", "manifest.json"),
      manifestSha256: "b".repeat(64),
      status: "ready" as const,
      repositoryCount: 1,
      resolutionCaseCount: 0,
      overlapCount: 0,
      repositories: [{
        candidateId,
        targetRepo: path.join(directory, "targets", "project"),
        targetRef: "refs/heads/main",
        method: "merge" as const,
        status: "ready" as const,
        expectedCommit: "e".repeat(40),
        desiredCommit: "f".repeat(40),
        artifactFile: path.join(directory, "folds", "prepared_bbbbbbbbbbbbbbbbbbbbbbbb", "repositories", "01", "prepared-objects.bundle"),
        viewPath: path.join(directory, "folds", "prepared_bbbbbbbbbbbbbbbbbbbbbbbb", "repositories", "01", "view")
      }]
    };
    const api = fakeApi();
    registerWorkerExtension(api, {
      roots,
      foldsRoot: path.join(directory, "folds"),
      targetRoot: path.join(directory, "targets"),
      now: () => new Date("2026-09-22T22:00:00.000Z"),
      prepareFold: ((input: { candidates: Array<{ candidate: { candidateId: string }; inventory: { inventorySha256: string } }> }) => {
        resolvedCandidate = input.candidates[0]?.candidate.candidateId ?? "";
        assert.equal(input.candidates[0]?.inventory.inventorySha256, repositoryInventory.inventorySha256);
        assert.throws(() => acquireWorkerOperationLock(paths.operationLockFile), /already active/);
        return { manifest: {} as never, summary };
      }) as never
    });
    const tool = api.tools.find((candidate) => candidate.name === "worker_fold_prepare");
    assert.ok(tool?.execute);
    const params = {
      repositories: [{
        candidateId,
        targetRepo: path.join(directory, "targets", "project"),
        targetRef: "refs/heads/main",
        purpose: "prepare project",
        method: "merge"
      }]
    };
    const result = await tool.execute("fold-1", params as never, undefined, undefined, parentContext(directory, parentSessionFile));
    assert.equal(resolvedCandidate, candidateId);
    assert.equal(Check(RetainedToolOutputSchemas.worker_fold_prepare, result), true);
    assert.match(JSON.stringify(result.content), /prepared_bbbbb/);
    assert.match(renderWorkerToolCall(tool, params), /Worker Fold\(1 repository\)/);
    assert.match(renderWorkerToolResult(tool, result), /ready · prepared_b/);

    const settled = readWorkerRecord(paths.recordFile);
    writeWorkerRecord(paths.recordFile, {
      ...settled,
      status: "running",
      activeRun: { runId: "run_20260922220100_active00", jobId: "job_20260922220100_active00", status: "running" }
    });
    await assert.rejects(
      tool.execute("fold-active", params as never, undefined, undefined, parentContext(directory, parentSessionFile)),
      /active run or lease/
    );

    writeWorkerRecord(paths.recordFile, { ...settled, status: "handed_off", activeRun: undefined });
    acquireWorkerLease(paths.leaseFile, {
      version: 1,
      workerId,
      runId: "run_20260922220200_resume00",
      parentPid: process.pid,
      acquiredAt: "2026-09-22T22:02:00.000Z"
    });
    await assert.rejects(
      tool.execute("fold-resume", params as never, undefined, undefined, parentContext(directory, parentSessionFile)),
      /active run or lease/
    );
    releaseWorkerLease(paths.leaseFile, workerId, "run_20260922220200_resume00");
  });
});
