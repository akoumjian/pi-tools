import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Check } from "typebox/value";
import { WORKER_ACTIVITY_STATUS_KEY, WorkerControlParams, WorkerMergeApplyParams, WorkerMergeTestParams, WorkerRunParams, activeWorkerCountForContext, registerWorkerExtension, renderWorkerActivityStatus, renderWorkerOperationHint, sanitizeWorkerOperationText, workerRunCallOperationHint, workerRunResultOperationHint } from "../extensions/worker/index.js";
import { RetainedToolOutputSchemas } from "../extensions/_shared/tool-output.js";
import { normalizeWorkerSettings } from "../extensions/worker/settings.js";
import { normalizeWorkspaceResultPaths, validateWorkerResultInput, WorkerResultValidationError } from "../extensions/worker/contract.js";
import { resultPathMetadata } from "../extensions/worker/runtime.js";
import { ASYNC_SHELL_ACTIVITY_STATUS_KEY, renderAsyncShellActivityStatus } from "../extensions/async-shell/index.js";
import { createWorkerAndRun, getWorker, getWorkerRun, openWorkerRegistry, setWorkerRecoveryError, settleWorkerRun, type WorkerRegistry, type WorkerRunRecord } from "../extensions/worker/registry.js";

const settings = {
  modelPreferences: {
    work: ["openai-codex/gpt-5.6-sol:xhigh", "anthropic/claude-opus-5-5:xhigh"],
    review: ["anthropic/claude-opus-5-5:xhigh", "openai-codex/gpt-5.6-sol:xhigh"],
    integration: ["openai-codex/gpt-5.6-sol:xhigh", "anthropic/claude-opus-5-5:xhigh"]
  }
};

test("worker settings accept exact role model preferences", () => {
  const value = normalizeWorkerSettings(settings, "fixture");
  assert.deepEqual(value.modelPreferences, settings.modelPreferences);
  assert.throws(() => normalizeWorkerSettings({ modelPreferences: { ...settings.modelPreferences, work: ["openai-codex/gpt:max"] } }, "fixture"), /selection|xhigh/);
  assert.throws(() => normalizeWorkerSettings({ defaultRoute: "openai-codex/gpt:xhigh" }, "fixture"), /unsupported/);
});

test("worker_run schema exposes orthogonal action and role branches", () => {
  assert.equal(Check(WorkerRunParams, { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "Implement." }] }), true);
  assert.equal(Check(WorkerRunParams, { runs: [{ action: "start", role: "review", reviewedRunId: "run_20260101000000_aaaaaaaa" }] }), true);
  assert.equal(Check(WorkerRunParams, { runs: [{ action: "start", role: "integration", preparedId: `prepared_${"a".repeat(24)}`, taskIds: ["personal-test"] }] }), true);
  assert.equal(Check(WorkerRunParams, { runs: [{ action: "resume", workerId: "worker_20260101000000_aaaaaaaa", instructions: "Continue." }] }), true);
  assert.equal(Check(WorkerRunParams, { runs: [{ action: "start", role: "implementation", taskIds: ["personal-test"], instructions: "No." }] }), false);
});

test("worker_control and merge schemas use only v2 actions", () => {
  for (const value of [{ action: "list" }, { action: "runs", workerId: "worker_20260101000000_aaaaaaaa" }, { action: "get", workerId: "worker_20260101000000_aaaaaaaa", runId: "run_20260101000000_aaaaaaaa" }, { action: "cancel", workerId: "worker_20260101000000_aaaaaaaa" }, { action: "discard", workerId: "worker_20260101000000_aaaaaaaa" }, { action: "discard", workerIds: ["worker_20260101000000_aaaaaaaa"], artifactLossAcknowledged: ["worker_20260101000000_aaaaaaaa"] }, { action: "preserve", workerId: "worker_20260101000000_aaaaaaaa", destination: "/tmp/archive", paths: ["artifacts/report.md"] }, { action: "cleanup_inventory", allSessions: true }, { action: "cleanup_preview", workerIds: ["worker_20260101000000_aaaaaaaa"] }, { action: "cleanup_apply", token: `cleanup_${"a".repeat(48)}` }]) assert.equal(Check(WorkerControlParams, value), true);
  assert.equal(Check(WorkerControlParams, { action: "status" }), false);
  assert.equal(Check(WorkerControlParams, { action: "discard", workerIds: ["worker_20260101000000_aaaaaaaa"], artifactLossAcknowledged: ["worker_20260101000000_bbbbbbbb"] }), true, "schema validates shape; runtime and tool-safety enforce acknowledgement subset");
  assert.equal(Check(WorkerControlParams, { action: "discard" }), false);
  assert.equal(Check(WorkerControlParams, { action: "preserve", workerId: "worker_20260101000000_aaaaaaaa", destination: "relative" }), false);
  assert.equal(Check(WorkerMergeTestParams, { repositories: [{ id: "repo", candidateRepo: "/candidate", candidateRef: "HEAD", targetRepo: "/target", targetRef: "refs/heads/main", method: "merge", commitMessage: "Merge" }] }), true);
  assert.equal(Check(WorkerMergeApplyParams, { preparedId: `prepared_${"b".repeat(24)}` }), true);
});

test("result outcomes are role-specific and reviews require artifacts", () => {
  assert.equal(validateWorkerResultInput("work", { outcome: "completed", summary: "Done." }).outcome, "completed");
  assert.throws(() => validateWorkerResultInput("work", { outcome: "approve", summary: "No." }), WorkerResultValidationError);
  assert.throws(() => validateWorkerResultInput("review", { outcome: "approve", summary: "Approved." }), /artifact/);
  assert.equal(validateWorkerResultInput("review", { outcome: "request_changes", summary: "Fix.", artifacts: ["review.md"] }).outcome, "request_changes");
  assert.throws(() => validateWorkerResultInput("integration", { outcome: "needs_input", summary: "Question." }), /question/);
});


test("artifact paths reject exact standalone, shallow, nested, worktree, and bare Git roots while allowing ordinary subdirectories",async()=>{
 const temporary=await mkdtemp(path.join(tmpdir(),"pi-worker-artifact-git-")),root=realpathSync(temporary);try{const repository=path.join(root,"repo");execFileSync("git",["init",repository]);execFileSync("git",["-C",repository,"config","user.name","Test"]);execFileSync("git",["-C",repository,"config","user.email","test@example.invalid"]);await writeFile(path.join(repository,"tracked.txt"),"tracked");execFileSync("git",["-C",repository,"add","tracked.txt"]);execFileSync("git",["-C",repository,"commit","-m","initial"]);await writeFile(path.join(repository,".git","shallow"),`${execFileSync("git",["-C",repository,"rev-parse","HEAD"],{encoding:"utf8"}).trim()}\n`);const ordinary=path.join(repository,"reports");await mkdir(ordinary);await writeFile(path.join(ordinary,"review.md"),"detailed report");const nested=path.join(repository,"nested");execFileSync("git",["init",nested]);const worktree=path.join(root,"worktree");execFileSync("git",["-C",repository,"worktree","add","--detach",worktree]);const bare=path.join(root,"bare.git");execFileSync("git",["init","--bare",bare]);for(const artifact of [repository,nested,worktree,bare])assert.throws(()=>normalizeWorkspaceResultPaths(root,[artifact],"artifact",resultPathMetadata),/Git repository root/);assert.deepEqual(normalizeWorkspaceResultPaths(root,[ordinary],"artifact",resultPathMetadata),["repo/reports"]);assert.deepEqual(normalizeWorkspaceResultPaths(root,[repository],"repository",resultPathMetadata),["repo"]);}finally{await rm(root,{recursive:true,force:true});}
});

test("parent extension exposes only the v2 worker tool and command surface", async () => {
  const { registerWorkerExtension } = await import("../extensions/worker/index.js");
  const tools: string[] = [];
  const commands: string[] = [];
  const api = {
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    registerCommand(name: string) { commands.push(name); },
    registerMessageRenderer() {},
    on() {},
    sendMessage() {}
  } as never;
  registerWorkerExtension(api);
  assert.deepEqual(tools.sort(), ["worker_control", "worker_merge_apply", "worker_merge_test", "worker_run"]);
  assert.deepEqual(commands.sort(), ["worker:cancel", "worker:cleanup", "worker:discard", "worker:list", "worker:logs", "worker:show", "worker:view"]);
});


test("worker_run work start persists a v2 registry receipt before deferred launch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-v2-facade-"));
  try {
    const sessionFile = path.join(root, "parent.jsonl"); await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`);
    const workersRoot = path.join(root, "runtime", "workers"); await mkdir(workersRoot, { recursive: true });
    const tools: ToolDefinition[] = []; const handlers = new Map<string, Function[]>();
    const api = { registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, sendMessage() {} } as unknown as ExtensionAPI;
    registerWorkerExtension(api, { runtimeRoot: path.join(root, "runtime"), roots: { stateRoot: workersRoot, workspaceRoot: workersRoot }, codeRoot: root,
      now: () => new Date("2026-01-01T00:00:00.000Z"), random: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      launch: () => { throw new Error("deferred launch must not run during receipt test"); }
    });
    const model = { id: "gpt-5.6-sol", name: "gpt-5.6-sol", provider: "openai-codex", api: "openai-responses", baseUrl: "https://example.invalid", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 } as Model<Api>;
    const context = { cwd: root, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "parent" }, modelRegistry: { hasConfiguredAuth: () => true, getAll: () => [model] }, isIdle: () => true, hasPendingMessages: () => false, ui: { notify() {} } } as unknown as ExtensionContext;
    for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
    const tool = tools.find((candidate) => candidate.name === "worker_run")!;
    const result = await tool.execute!("call", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "Implement." }] }, new AbortController().signal, undefined, context);
    const receipt = (result.details as { runs: Array<{ workerId: string; runId: string; role: string; status: string }> }).runs[0]!;
    assert.equal(receipt.role, "work"); assert.equal(receipt.status, "queued");
    assert.equal(Check(RetainedToolOutputSchemas.worker_run, result), true, JSON.stringify(result));
    const list = await tools.find((candidate) => candidate.name === "worker_control")!.execute!("list", { action: "list" }, new AbortController().signal, undefined, context);
    assert.equal(Check(RetainedToolOutputSchemas.worker_control, list), true, JSON.stringify(list));
    const exact = await tools.find((candidate) => candidate.name === "worker_control")!.execute!("get", { action: "get", workerId: receipt.workerId, runId: receipt.runId }, new AbortController().signal, undefined, context);
    assert.equal(Check(RetainedToolOutputSchemas.worker_control, exact), true, JSON.stringify(exact));
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("parent tool labels and approved copy remain exact and schemas carry field descriptions", () => {
  const tools: ToolDefinition[] = [];
  registerWorkerExtension({ registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on() {}, sendMessage() {} } as unknown as ExtensionAPI);
  const run = tools.find((tool) => tool.name === "worker_run")!; const control = tools.find((tool) => tool.name === "worker_control")!; const apply = tools.find((tool) => tool.name === "worker_merge_apply")!;
  assert.equal(run.label, "Run Workers"); assert.equal(run.promptSnippet, "Start work, review, or integration workers, or resume previous workers."); assert.match(run.description, /Each new worker receives its role-specific inputs/);
  assert.equal(control.label, "Manage Workers"); assert.equal(control.description, "List and manage durable workers. Use `list`, `runs`, and `get` for retained lifecycle evidence; `inventory` for bounded Beads-derived cleanup classes; `preserve` for explicit atomic non-Git artifact copies; `cancel` to stop active work; and exact batched `discard` for idle current-session workers or prepared sets after complete preflight.");
  assert.equal(apply.label, "Apply Prepared Repository Merges"); assert.match(apply.description, /Applying multiple repositories is not atomic/);
  const schemaText = JSON.stringify(WorkerRunParams); for (const phrase of ["Continue a previous worker", "One or more Beads task IDs", "Additional files or directories", "When to deliver the asynchronous result"]) assert.match(schemaText, new RegExp(phrase));
  const controlGuidance = JSON.stringify(control.promptGuidelines); for (const phrase of ["notification", "send_started_unconfirmed", "delivered", "runtimeGeneration", "sendStartedAt"]) assert.match(controlGuidance, new RegExp(phrase), `provider-visible worker_control output guidance includes ${phrase}`);
});

test("worker package-generation mismatch registers no launchable tools", () => {
  const tools: ToolDefinition[] = [];
  assert.throws(
    () => registerWorkerExtension({ registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on() {}, sendMessage() {} } as unknown as ExtensionAPI, {
      assertPackageGeneration() { throw new Error("Fully quit and restart Pi; /reload cannot activate package-code updates safely."); }
    }),
    /Fully quit and restart Pi/
  );
  assert.deepEqual(tools, []);
});

test("worker tools fail before lifecycle effects when package generation changes", async () => {
  const tools: ToolDefinition[] = [];
  let checks = 0;
  registerWorkerExtension({ registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on() {}, sendMessage() {} } as unknown as ExtensionAPI, {
    assertPackageGeneration() {
      checks += 1;
      if (checks > 1) throw new Error("Fully quit and restart Pi; /reload cannot activate package-code updates safely.");
    }
  });
  const run = tools.find((tool) => tool.name === "worker_run")!;
  await assert.rejects(
    () => run.execute!("generation-call", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "Do work." }] }, new AbortController().signal, undefined, undefined as never),
    /Fully quit and restart Pi/
  );
  assert.equal(checks, 2, "registration and execution each check the package generation");
});

test("deferred turn_end launch rechecks generation and settles failed before launching", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-generation-launch-"));
  try {
    const sessionFile = path.join(root, "parent.jsonl");
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`);
    const runtimeRoot = path.join(root, "runtime");
    const workersRoot = path.join(runtimeRoot, "workers");
    await mkdir(workersRoot, { recursive: true });
    const tools: ToolDefinition[] = [];
    const handlers = new Map<string, Function[]>();
    let checks = 0;
    let launches = 0;
    const api = {
      registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, sendMessage() {},
      on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }
    } as unknown as ExtensionAPI;
    registerWorkerExtension(api, {
      runtimeRoot, roots: { stateRoot: workersRoot, workspaceRoot: workersRoot }, codeRoot: root,
      now: () => new Date("2026-01-01T00:00:00.000Z"), random: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      assertPackageGeneration() { checks += 1; if (checks >= 4) throw new Error("Fully quit and restart Pi; mixed generation."); },
      launch: () => { launches += 1; throw new Error("launch must not run after generation drift"); }
    });
    const model = { id: "gpt-5.6-sol", name: "gpt-5.6-sol", provider: "openai-codex", api: "openai-responses", baseUrl: "https://example.invalid", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 } as Model<Api>;
    const context = { cwd: root, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "parent" }, modelRegistry: { hasConfiguredAuth: () => true, getAll: () => [model] }, isIdle: () => true, hasPendingMessages: () => false, ui: { notify() {} } } as unknown as ExtensionContext;
    for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
    const result = await tools.find((tool) => tool.name === "worker_run")!.execute!("generation-launch", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "Implement." }] }, new AbortController().signal, undefined, context);
    const receipt = (result.details as { runs: Array<{ workerId: string; runId: string }> }).runs[0]!;
    for (const handler of handlers.get("turn_end") ?? []) await handler({}, context);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const registry = openWorkerRegistry(runtimeRoot);
    try {
      const run = getWorkerRun(registry, receipt.workerId, receipt.runId)!;
      assert.equal(run.status, "settled");
      assert.equal(run.outcome, "failed");
      assert.match(run.errors[0]?.message ?? "", /Fully quit and restart Pi/);
    } finally { registry.close(); }
    assert.equal(launches, 0);
    assert.ok(checks >= 4, `expected registration, tool, turn_end, and launch checks; got ${checks}`);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reconciliation timer and slash cancel/discard paths recheck package generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-generation-boundaries-"));
  const runtimeRoot = path.join(root, "runtime");
  const workersRoot = path.join(runtimeRoot, "workers");
  await mkdir(workersRoot, { recursive: true });
  const sessionFile = path.join(root, "parent.jsonl");
  await writeFile(sessionFile, "\n");
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, { handler: Function }>();
  const notifications: string[] = [];
  let checks = 0;
  let blocked = false;
  const api = {
    registerTool() {}, registerMessageRenderer() {}, sendMessage() {},
    registerCommand(name: string, command: { handler: Function }) { commands.set(name, command); },
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }
  } as unknown as ExtensionAPI;
  const context = { cwd: root, mode: "tui", hasUI: true, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "parent" }, ui: { notify(message: string) { notifications.push(message); }, theme: { fg: (_color: string, text: string) => text }, setStatus() {} }, isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
  try {
    registerWorkerExtension(api, {
      runtimeRoot, roots: { stateRoot: workersRoot, workspaceRoot: workersRoot }, codeRoot: root,
      assertPackageGeneration() { checks += 1; if (blocked) throw new Error("Fully quit and restart Pi; mixed generation."); }
    });
    for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const registry = openWorkerRegistry(runtimeRoot);
    const created = addActivityWorker(registry, sessionFile, "guarded", "queued");
    const originalRecovery = "container cleanup must be retried";
    setWorkerRecoveryError(registry, created.workerId, created.runId, originalRecovery, "2026-01-01T00:00:00.000Z");
    const beforeTimer = checks;
    blocked = true;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.ok(checks > beforeTimer, "the reconciliation timer rechecks generation before queued launch");
    assert.equal(getWorker(registry, created.workerId)?.recoveryError, originalRecovery, "a process-local package mismatch never overwrites durable recovery state");
    assert.equal(notifications.length, 1, "the mismatch is a single transient notice for this parent runtime");
    assert.match(notifications[0]!, /Fully quit and restart Pi/);

    blocked = false;
    settleWorkerRun(registry, { parentSessionFile: sessionFile, ...created, outcome: "failed", outcomeSource: "system", settledAt: "2026-01-01T00:00:00.000Z" });
    blocked = true;
    await assert.rejects(() => commands.get("worker:cancel")!.handler(created.workerId, context), /Fully quit and restart Pi/);
    await commands.get("worker:discard")!.handler(`${created.workerId} --confirm`, context);assert.match(notifications.at(-1)??"",/Fully quit and restart Pi/);
    assert.equal(getWorker(registry, created.workerId)?.status, "idle", "guarded commands do not mutate the worker");
    registry.close();
  } finally {
    blocked = false;
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
    await rm(root, { recursive: true, force: true });
  }
});

test("package mismatch stays process-local and a clean restart auto-fails a dead supervised run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-generation-restart-"));
  const runtimeRoot = path.join(root, "runtime");
  const workersRoot = path.join(runtimeRoot, "workers");
  await mkdir(workersRoot, { recursive: true });
  const sessionFile = path.join(root, "parent.jsonl");
  await writeFile(sessionFile, "\n");
  const registry = openWorkerRegistry(runtimeRoot);
  const dead = addDeadSupervisedWorker(registry, sessionFile, root);
  const contextNotifications: string[] = [];
  const sent: Array<{ message: any; options: any }> = [];
  const context = {
    cwd: root, mode: "tui", hasUI: true, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "parent" },
    ui: { notify(message: string) { contextNotifications.push(message); }, theme: { fg: (_color: string, text: string) => text }, setStatus() {} },
    isIdle: () => true, hasPendingMessages: () => false
  } as unknown as ExtensionContext;
  const testLaunch = () => ({ jobId: "job_unused", completion: new Promise<never>(() => {}), snapshot: () => ({ status: "running" } as never), cancel: async () => ({ status: "cancelled" } as never) });
  try {
    let packageChanged = false;
    const firstHandlers = new Map<string, Function[]>();
    registerWorkerExtension({
      registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
      sendMessage(message: any, options: any) { sent.push({ message, options }); },
      on(name: string, handler: Function) { firstHandlers.set(name, [...(firstHandlers.get(name) ?? []), handler]); }
    } as unknown as ExtensionAPI, {
      runtimeRoot, roots: { stateRoot: workersRoot, workspaceRoot: workersRoot }, codeRoot: root,
      random: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", launch: testLaunch,
      assertPackageGeneration() { if (packageChanged) throw new Error("Package files changed. Fully quit and restart Pi."); }
    });
    packageChanged = true;
    for (const handler of firstHandlers.get("session_start") ?? []) await handler({}, context);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(getWorkerRun(registry, dead.workerId, dead.runId)?.status, "running");
    assert.equal(getWorker(registry, dead.workerId)?.recoveryError, undefined, "generation guidance is never durable run recovery state");
    assert.deepEqual(contextNotifications, ["Package files changed. Fully quit and restart Pi."]);
    assert.equal(sent.length, 0, "the timer notice cannot trigger a model-turn notification loop");
    for (const handler of firstHandlers.get("session_shutdown") ?? []) await handler({}, context);

    contextNotifications.length = 0;
    const restartedHandlers = new Map<string, Function[]>();
    registerWorkerExtension({
      registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
      sendMessage(message: any, options: any) { sent.push({ message, options }); },
      on(name: string, handler: Function) { restartedHandlers.set(name, [...(restartedHandlers.get(name) ?? []), handler]); }
    } as unknown as ExtensionAPI, {
      runtimeRoot, roots: { stateRoot: workersRoot, workspaceRoot: workersRoot }, codeRoot: root,
      random: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", launch: testLaunch,
      assertPackageGeneration() {}
    });
    for (const handler of restartedHandlers.get("session_start") ?? []) await handler({}, context);
    for (let attempt = 0; attempt < 500 && getWorkerRun(registry, dead.workerId, dead.runId)?.status !== "settled"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const settled = getWorkerRun(registry, dead.workerId, dead.runId)!;
    assert.equal(settled.status, "settled");
    assert.equal(settled.outcome, "failed");
    assert.match(settled.errors[0]?.message ?? "", /supervisor exited without a verified result settlement/);
    assert.equal(getWorker(registry, dead.workerId)?.recoveryError, undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.deepEqual(contextNotifications, [], "the fresh process emits no stale restart notice");
    assert.equal(sent.filter(({ message }) => message?.details?.event === "worker_recovery_required").length, 0);
    assert.equal(sent.filter(({ message }) => message?.details?.event === "worker_settled").length, 1, "normal failed-run delivery proceeds once");
    assert.equal(sent.some(({ message }) => JSON.stringify(message).includes("Fully quit and restart Pi")), false);
    for (const handler of restartedHandlers.get("session_shutdown") ?? []) await handler({}, context);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("strict control and beads schemas reject unrelated fields and approved bounds", async () => {
  assert.equal(Check(WorkerControlParams, { action: "cancel", workerId: "worker_20260101000000_aaaaaaaa", limit: 1 }), false);
  assert.equal(Check(WorkerControlParams, { action: "list", runId: "run_20260101000000_aaaaaaaa" }), false);
  assert.ok((WorkerControlParams as any).properties?.action, "root control properties must remain provider-visible"); assert.ok((WorkerControlParams as any).anyOf, "strict control branches must remain host-visible");
  const { WorkerBeadsTasksParams } = await import("../extensions/worker/contract.js");
  assert.equal(Check(WorkerBeadsTasksParams, { action: "get", taskIds: ["personal-a", "personal-b", "personal-c", "personal-d"] }), true);
  assert.equal(Check(WorkerBeadsTasksParams, { action: "get", taskIds: ["personal-a", "personal-b", "personal-c", "personal-d", "personal-e"] }), false);
  assert.equal(Check(WorkerBeadsTasksParams, { action: "search", query: "x", offset: 1 }), false);
  assert.equal(Check(WorkerBeadsTasksParams, { action: "update", taskId: "personal-a", note: "x", query: "bad" }), false);
});

function addDeadSupervisedWorker(registry: WorkerRegistry, parentSessionFile: string, root: string): { workerId: string; runId: string } {
  const workerId = "worker_20260101000000_deadbeef";
  const runId = "run_20260101000000_deadbeef";
  const timestamp = "2026-01-01T00:00:00.000Z";
  const runDir = path.join(root, "dead-run");
  const workspaceRoot = path.join(root, "dead-workspace");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const runtime = {
    version: 2, prompt: "test", runDir, resultFile: path.join(runDir, "result.json"), settledFile: path.join(runDir, "settled.json"),
    processFile: path.join(runDir, "process.json"), processNonce: "dead-process", inputs: [], repositoryBefore: [],
    container: { version: 1, workerId, runId, name: "pi-worker-dead", nonce: "dead-container", image: "test", codeRoot: root, workspaceRoot }
  };
  createWorkerAndRun(registry, {
    workerId, parentSessionFile, role: "work", status: "running", activeRunId: runId, taskIds: ["personal-test"],
    modelSelection: "openai-codex/gpt-5.6-sol:xhigh", workspaceRoot, runtime: { version: 2, inputs: [] }, createdAt: timestamp, updatedAt: timestamp
  }, {
    runId, workerId, status: "running", taskIds: ["personal-test"], modelSelection: "openai-codex/gpt-5.6-sol:xhigh", completionDelivery: "steer",
    jobId: "job_dead", stdoutLog: path.join(runDir, "stdout.log"), stderrLog: path.join(runDir, "stderr.log"), repositories: [], artifacts: [], errors: [], runtime,
    createdAt: timestamp, startedAt: timestamp
  });
  return { workerId, runId };
}

function addActivityWorker(registry: WorkerRegistry, parentSessionFile: string, suffix: string, status: "queued" | "running", claimNonce = "activity-hold"): { workerId: string; runId: string } {
  const workerId = `worker_20260101000000_${suffix.padEnd(8, "a")}`;
  const runId = `run_20260101000000_${suffix.padEnd(8, "b")}`;
  const timestamp = "2026-01-01T00:00:00.000Z";
  const run: WorkerRunRecord = {
    runId, workerId, status, taskIds: ["personal-test"], modelSelection: "openai-codex/gpt-5.6-sol:xhigh", completionDelivery: "steer",
    repositories: [], artifacts: [], errors: [], claimKind: "launch", claimNonce, createdAt: timestamp,
    ...(status === "running" ? { startedAt: timestamp } : {})
  };
  createWorkerAndRun(registry, {
    workerId, parentSessionFile, role: "work", status, activeRunId: runId, taskIds: ["personal-test"],
    modelSelection: "openai-codex/gpt-5.6-sol:xhigh", workspaceRoot: `/tmp/${workerId}`, runtime: {}, createdAt: timestamp, updatedAt: timestamp
  }, run);
  return { workerId, runId };
}

test("worker activity count is exact-session registry state across queued, running, settled, and cancelled transitions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-activity-registry-"));
  const registry = openWorkerRegistry(root);
  try {
    const parent = path.join(root, "parent.jsonl"); const other = path.join(root, "other.jsonl");
    await writeFile(parent, "\n"); await writeFile(other, "\n");
    const context = { sessionManager: { getSessionFile: () => parent } } as Pick<ExtensionContext, "sessionManager">;
    const queued = addActivityWorker(registry, parent, "queued", "queued");
    const running = addActivityWorker(registry, parent, "running", "running");
    addActivityWorker(registry, other, "other", "running");
    assert.equal(activeWorkerCountForContext(registry, context), 2);
    assert.equal(activeWorkerCountForContext(registry, { sessionManager: { getSessionFile: () => undefined } } as unknown as Pick<ExtensionContext, "sessionManager">), 0);
    settleWorkerRun(registry, { parentSessionFile: parent, ...queued, outcome: "failed", outcomeSource: "system", settledAt: "2026-01-01T00:00:01.000Z" });
    assert.equal(activeWorkerCountForContext(registry, context), 1);
    settleWorkerRun(registry, { parentSessionFile: parent, ...running, outcome: "cancelled", outcomeSource: "system", settledAt: "2026-01-01T00:00:02.000Z" });
    assert.equal(activeWorkerCountForContext(registry, context), 0);
    const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as Theme;
    assert.equal(renderWorkerActivityStatus(0, theme), undefined);
    assert.equal(renderWorkerActivityStatus(12, theme), "<accent>w12</accent>");
  } finally { registry.close(); await rm(root, { recursive: true, force: true }); }
});

test("worker activity footer repaints from registry events, fences reload listeners, and orders before direct shell activity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-activity-ui-"));
  const runtimeRoot = path.join(root, "runtime"); const workersRoot = path.join(runtimeRoot, "workers"); await mkdir(workersRoot, { recursive: true });
  const sessionFile = path.join(root, "parent.jsonl"); await writeFile(sessionFile, "\n");
  const registry = openWorkerRegistry(runtimeRoot);
  const first = addActivityWorker(registry, sessionFile, "first", "queued", "1-hold");
  const handlers = new Map<string, Function[]>(); const statuses: Array<{ key: string; text: string | undefined }> = [];
  const api = {
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, sendMessage() {},
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }
  } as unknown as ExtensionAPI;
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  const context = {
    cwd: root, mode: "tui", hasUI: true, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "activity-session" },
    ui: { theme, setStatus(key: string, text: string | undefined) { statuses.push({ key, text }); }, notify() {} },
    isIdle: () => true, hasPendingMessages: () => false
  } as unknown as ExtensionContext;
  try {
    registerWorkerExtension(api, { runtimeRoot, roots: { stateRoot: workersRoot, workspaceRoot: workersRoot }, codeRoot: root, random: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", launch: () => ({ jobId: "job_test", completion: new Promise(() => {}), snapshot: () => ({ status: "running" } as never), cancel: async () => ({ status: "cancelled" } as never) }) });
    for (const handler of handlers.get("session_start") ?? []) handler({ reason: "startup" }, context);
    assert.deepEqual(statuses.at(-1), { key: WORKER_ACTIVITY_STATUS_KEY, text: "w1" });
    const second = addActivityWorker(registry, sessionFile, "second", "running", "1-hold-2");
    assert.deepEqual(statuses.at(-1), { key: WORKER_ACTIVITY_STATUS_KEY, text: "w2" });

    registry.database.prepare("UPDATE runs SET claim_nonce='2-reload-hold' WHERE claim_kind='launch'").run();
    const beforeReloadEvent = statuses.length;
    for (const handler of handlers.get("session_start") ?? []) handler({ reason: "reload" }, context);
    const third = addActivityWorker(registry, sessionFile, "third", "queued", "2-hold-3");
    assert.equal(statuses.slice(beforeReloadEvent).filter((item) => item.text === "w3").length, 1, "only the current reload listener repaints");
    const footer = new Map([
      [ASYNC_SHELL_ACTIVITY_STATUS_KEY, renderAsyncShellActivityStatus(2, theme)!],
      [WORKER_ACTIVITY_STATUS_KEY, renderWorkerActivityStatus(3, theme)!]
    ]);
    assert.equal([...footer.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, text]) => text).join(" "), "w3 sh2");
    settleWorkerRun(registry, { parentSessionFile: sessionFile, ...third, outcome: "completed", outcomeSource: "worker", settledAt: "2026-01-01T00:00:03.000Z" });
    assert.deepEqual(statuses.at(-1), { key: WORKER_ACTIVITY_STATUS_KEY, text: "w2" });
    settleWorkerRun(registry, { parentSessionFile: sessionFile, ...first, outcome: "cancelled", outcomeSource: "system", settledAt: "2026-01-01T00:00:04.000Z" });
    assert.deepEqual(statuses.at(-1), { key: WORKER_ACTIVITY_STATUS_KEY, text: "w1" });

    for (const handler of handlers.get("session_shutdown") ?? []) handler({ reason: "reload" }, context);
    assert.deepEqual(statuses.at(-1), { key: WORKER_ACTIVITY_STATUS_KEY, text: undefined });
    const afterShutdown = statuses.length;
    settleWorkerRun(registry, { parentSessionFile: sessionFile, ...second, outcome: "cancelled", outcomeSource: "system", settledAt: "2026-01-01T00:00:05.000Z" });
    assert.equal(statuses.length, afterShutdown, "shutdown removes the registry listener");
  } finally { registry.close(); await rm(root, { recursive: true, force: true }); }
});

test("pure worker operation projections cover complete calls, progress, results, roles, and merge operations", () => {
  const workCall = { runs: [{ action: "start", role: "work", taskIds: ["personal-work", "personal-other"], instructions: "UNTRUSTED-INSTRUCTIONS" }] };
  assert.equal(workerRunCallOperationHint(workCall, false), undefined, "streaming arguments expose no partial metadata");
  assert.equal(workerRunCallOperationHint(workCall, true), "personal-work +1");
  assert.equal(workerRunCallOperationHint({ runs: [{ action: "resume", workerId: "worker_20260101000000_aaaaaaaa", instructions: "UNTRUSTED" }] }, true), undefined);
  assert.equal(workerRunCallOperationHint({ runs: [{ action: "start", role: "review", reviewedRunId: "run_20260101000000_reviewaa" }] }, true), "review · run reviewaa");
  assert.equal(workerRunCallOperationHint({ runs: [{ action: "start", role: "integration", preparedId: `prepared_${"a".repeat(24)}`, taskIds: ["personal-work"] }] }, true), "prepared aaaaaaaa");

  assert.equal(workerRunResultOperationHint({ runs: [{ action: "start", role: "work", taskIds: ["personal-work", "personal-other"] }] }), "personal-work +1");
  assert.equal(workerRunResultOperationHint({ runs: [{ action: "resume", role: "review", taskIds: ["personal-resume"] }] }), "personal-resume");
  assert.equal(workerRunResultOperationHint({ runs: [{ action: "start", role: "review", taskIds: ["personal-reviewed", "personal-second"], reviewedRunId: "run_20260101000000_reviewaa" }] }), "personal-reviewed +1 · run reviewaa");
  assert.equal(workerRunResultOperationHint({ runs: [{ action: "start", role: "integration", taskIds: ["personal-work"], preparedId: `prepared_${"a".repeat(24)}` }] }, { kind: "integration", repositories: [{ targetRepo: "/code/pi-tools" }, { targetRepo: "/code/pi-agent-config" }] } as never), "pi-tools +1");
  assert.equal(renderWorkerOperationHint({ kind: "merge", repositories: [{ targetRepo: "/code/pi-tools", targetRef: "refs/heads/main", method: "merge" }, { targetRepo: "/code/second", targetRef: "refs/heads/release", method: "squash" }] }), "pi-tools → main · merge +1");

  for (const malformed of [undefined, null, {}, { kind: "work" }, { kind: "integration", repositories: [null] }, new Proxy({}, { get() { throw new Error("hostile getter"); } })]) {
    assert.doesNotThrow(() => renderWorkerOperationHint(malformed));
  }
  assert.doesNotThrow(() => workerRunCallOperationHint(new Proxy({}, { get() { throw new Error("hostile getter"); } }), true));
  assert.doesNotThrow(() => workerRunResultOperationHint(new Proxy({}, { get() { throw new Error("hostile getter"); } })));
});

test("worker operation hints sanitize hostile optional titles and truncate by visible Unicode width", () => {
  const hostile = `\u001b[31mline one\nline two\u001b[0m \u061c\u200e\u200f${"家族👨‍👩‍👧‍👦".repeat(20)}\u202e`;
  const hint = renderWorkerOperationHint({ kind: "work", taskIds: ["personal-safe"], title: hostile })!;
  assert.ok(visibleWidth(hint) <= 48, `${visibleWidth(hint)}: ${hint}`);
  assert.equal(hint.includes("\u001b"), false); assert.equal(/[\r\n\u061c\u200e\u200f\u202e]/u.test(hint), false); assert.equal(hint.includes("�"), false);
  assert.equal(sanitizeWorkerOperationText("\u001b]8;;https://evil.invalid\u0007safe\u001b]8;;\u0007\n\u061c\u200e\u200ftext"), "safe text");
});

test("collapsed call, progress, and result renderers use structured metadata and obey narrow widths", () => {
  const tools: ToolDefinition[] = [];
  registerWorkerExtension({ registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on() {}, sendMessage() {} } as unknown as ExtensionAPI);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
  const workerRun = tools.find((candidate) => candidate.name === "worker_run")!;
  const args = { runs: [{ action: "start", role: "work", taskIds: ["personal-display"], instructions: "DO-NOT-RENDER-RAW-PROSE" }] };
  const partialContext = { args, argsComplete: false, executionStarted: false, toolCallId: "partial", cwd: "/tmp" } as never;
  const partialCall = workerRun.renderCall!(args as never, theme, partialContext).render(120).join("\n");
  assert.equal(partialCall.includes("personal-display"), false);
  const completeContext = { args, argsComplete: true, executionStarted: false, toolCallId: "complete", cwd: "/tmp" } as never;
  const call = workerRun.renderCall!(args as never, theme, completeContext);
  const callWide = stripTerminalSequences(call.render(120).join("\n"));
  assert.match(callWide, /personal-display/); assert.equal(callWide.includes("DO-NOT-RENDER-RAW-PROSE"), false);
  const callNarrow = call.render(16).join("\n"); assert.ok(visibleWidth(callNarrow) <= 16); assert.equal(callNarrow.includes("�"), false); assert.equal(callNarrow.includes("\u001b"), false);
  const result = { content: [{ type: "text", text: JSON.stringify({ provider: "unchanged" }) }], details: { runs: [{ action: "start", role: "work", workerId: "worker_20260101000000_aaaaaaaa", runId: "run_20260101000000_aaaaaaaa", status: "queued", taskIds: ["personal-display"] }] } };
  for (const isPartial of [true, false]) {
    const rendered = workerRun.renderResult!(result as never, { expanded: false, isPartial }, theme, completeContext).render(120).join("\n");
    assert.match(rendered, /personal-display/); assert.equal(rendered.includes("DO-NOT-RENDER-RAW-PROSE"), false);
  }
  assert.equal(result.content[0]!.text, '{"provider":"unchanged"}');

  const reviewArgs = { runs: [{ action: "start", role: "review", reviewedRunId: "run_20260101000000_reviewaa" }] };
  assert.match(workerRun.renderCall!(reviewArgs as never, theme, { args: reviewArgs, argsComplete: true, toolCallId: "review" } as never).render(120).join("\n"), /run reviewaa/);
  const integrationArgs = { runs: [{ action: "start", role: "integration", preparedId: `prepared_${"a".repeat(24)}`, taskIds: ["personal-task"] }] };
  assert.match(workerRun.renderCall!(integrationArgs as never, theme, { args: integrationArgs, argsComplete: true, toolCallId: "integration" } as never).render(120).join("\n"), /prepared aaaaaaaa/);
  const resumeArgs = { runs: [{ action: "resume", workerId: "worker_20260101000000_aaaaaaaa", instructions: "SECRET" }] };
  const resumeText = workerRun.renderCall!(resumeArgs as never, theme, { args: resumeArgs, argsComplete: true, toolCallId: "resume" } as never).render(120).join("\n");
  assert.equal(resumeText.includes("SECRET"), false); assert.equal(resumeText.includes("personal-"), false);
});

test("worker_run snapshots require nonempty call IDs and exact result run identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-snapshot-identity-"));
  const sessionFile = path.join(root, "parent.jsonl");
  const runtimeRoot = path.join(root, "runtime"); const workersRoot = path.join(runtimeRoot, "workers");
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`);
  await mkdir(workersRoot, { recursive: true });
  const tools: ToolDefinition[] = []; const handlers = new Map<string, Function[]>(); let randomIndex = 0;
  const api = { registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, sendMessage() {} } as unknown as ExtensionAPI;
  registerWorkerExtension(api, { runtimeRoot, roots: { stateRoot: workersRoot, workspaceRoot: workersRoot }, codeRoot: root,
    now: () => new Date("2026-01-01T00:00:00.000Z"), random: () => `${String(++randomIndex).padStart(8, "0")}-0000-4000-8000-000000000000`,
    launch: () => { throw new Error("snapshot identity test does not launch workers"); }
  });
  const model = { id: "gpt-5.6-sol", name: "gpt-5.6-sol", provider: "openai-codex", api: "openai-responses", baseUrl: "https://example.invalid", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 } as Model<Api>;
  const context = { cwd: root, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "parent" }, modelRegistry: { hasConfiguredAuth: () => true, getAll: () => [model] }, isIdle: () => true, hasPendingMessages: () => false, ui: { notify() {} } } as unknown as ExtensionContext;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
  const signal = new AbortController().signal;
  try {
    for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
    const run = tools.find((tool) => tool.name === "worker_run")!;
    const executeWork = (toolCallId: string, taskId: string) => run.execute!(toolCallId, { runs: [{ action: "start", role: "work", taskIds: [taskId], instructions: "Do not render." }] }, signal, undefined, context);
    const render = (result: unknown, toolCallId: string) => stripTerminalSequences(run.renderResult!(result as never, { expanded: false, isPartial: false }, theme, { toolCallId } as never).render(120).join("\n"));

    const first = await executeWork("same-id", "personal-first");
    const second = await executeWork("same-id", "personal-second");
    assert.match(render(first, "same-id"), /personal-first/); assert.doesNotMatch(render(first, "same-id"), /personal-second/);
    assert.match(render(second, "same-id"), /personal-second/);

    const mismatched = structuredClone(second) as any;
    mismatched.details.runs[0].runId = "run_20260101000000_mismatch";
    mismatched.details.runs[0].taskIds = ["personal-details"];
    assert.match(render(mismatched, "same-id"), /personal-details/); assert.doesNotMatch(render(mismatched, "same-id"), /personal-second/);

    await assert.rejects(run.execute!("same-id", { runs: [{ action: "start", role: "review", reviewedRunId: "run_20260101000000_missingx" }] }, signal, undefined, context));
    const failed = { content: [{ type: "text", text: "failed" }] };
    assert.doesNotMatch(render(failed, "same-id"), /personal-(?:first|second)/);
    assert.match(render(second, "same-id"), /personal-second/, "failed preflight leaves the old row to its own details");

    const emptyFirst = await executeWork("", "personal-emptyfirst");
    const emptySecond = await executeWork("", "personal-emptysecond");
    assert.match(render(emptyFirst, ""), /personal-emptyfirst/); assert.doesNotMatch(render(emptyFirst, ""), /personal-emptysecond/);
    assert.match(render(emptySecond, ""), /personal-emptysecond/);
    const emptyProbe = structuredClone(emptySecond) as any;
    emptyProbe.details.runs[0].taskIds = ["personal-emptydetails"];
    assert.match(render(emptyProbe, ""), /personal-emptydetails/); assert.doesNotMatch(render(emptyProbe, ""), /personal-emptysecond/);
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
    await rm(root, { recursive: true, force: true });
  }
});

test("collapsed merge renderers use complete arguments or trusted returned metadata only", () => {
  const preparedId = `prepared_${"a".repeat(24)}`;
  const repositories = [
    { id: "first", candidateRepo: "/candidate/pi-tools", candidateRef: "HEAD", targetRepo: "/target/pi-tools", targetRef: "refs/heads/main", method: "merge", commitMessage: "UNTRUSTED-COMMIT-PROSE" },
    { id: "second", candidateRepo: "/candidate/config", candidateRef: "HEAD", targetRepo: "/target/config", targetRef: "refs/heads/release", method: "squash", commitMessage: "ALSO-UNTRUSTED" }
  ];
  const tools: ToolDefinition[] = [];
  registerWorkerExtension({ registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on() {}, sendMessage() {} } as unknown as ExtensionAPI);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
  const mergeTest = tools.find((tool) => tool.name === "worker_merge_test")!;
  const partial = mergeTest.renderCall!({ repositories } as never, theme, { args: { repositories }, argsComplete: false, toolCallId: "merge-partial" } as never).render(120).join("\n");
  assert.equal(partial.includes("pi-tools"), false);
  const testContext = { args: { repositories }, argsComplete: true, toolCallId: "merge-test", cwd: "/tmp" } as never;
  const testText = mergeTest.renderCall!({ repositories } as never, theme, testContext).render(120).join("\n");
  assert.match(testText, /pi-tools → main · merge \+1/); assert.equal(testText.includes("UNTRUSTED"), false);
  const testResult = mergeTest.renderResult!({ content: [{ type: "text", text: "provider-json" }], details: { preparedId, status: "ready", repositories } } as never, { expanded: false, isPartial: false }, theme, testContext).render(120).join("\n");
  assert.match(testResult, /pi-tools → main · merge \+1/); assert.equal(testResult.includes("UNTRUSTED"), false);
  const mergeApply = tools.find((tool) => tool.name === "worker_merge_apply")!;
  const applyContext = { args: { preparedId }, argsComplete: true, toolCallId: "merge-apply", cwd: "/tmp" } as never;
  const applyText = mergeApply.renderCall!({ preparedId } as never, theme, applyContext).render(120).join("\n");
  assert.match(applyText, /prepared aaaaaaaa/);
  const applyResult = mergeApply.renderResult!({ content: [{ type: "text", text: "provider-json" }], details: { status: "completed", repositories } } as never, { expanded: false, isPartial: false }, theme, applyContext).render(120).join("\n");
  assert.equal(applyResult.includes("UNTRUSTED"), false);
});

function snapshotGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

async function createSnapshotMerge(root: string, name: string): Promise<{ id: string; candidateRepo: string; candidateRef: string; targetRepo: string; targetRef: string; method: "squash"; commitMessage: string }> {
  const targetRepo = path.join(root, "targets", `target-${name}`); const candidateRepo = path.join(root, "candidates", `candidate-${name}`);
  await mkdir(targetRepo, { recursive: true });
  snapshotGit(targetRepo, "init", "--initial-branch=main"); snapshotGit(targetRepo, "config", "user.name", "Snapshot Test"); snapshotGit(targetRepo, "config", "user.email", "snapshot@example.invalid");
  await writeFile(path.join(targetRepo, "base.txt"), "base\n"); snapshotGit(targetRepo, "add", "base.txt"); snapshotGit(targetRepo, "commit", "-m", "base");
  await mkdir(path.dirname(candidateRepo), { recursive: true });
  execFileSync("git", ["clone", "--no-local", "--no-hardlinks", targetRepo, candidateRepo], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  snapshotGit(candidateRepo, "config", "user.name", "Snapshot Test"); snapshotGit(candidateRepo, "config", "user.email", "snapshot@example.invalid");
  await writeFile(path.join(candidateRepo, `${name}.txt`), `${name}\n`); snapshotGit(candidateRepo, "add", `${name}.txt`); snapshotGit(candidateRepo, "commit", "-m", `candidate ${name}`);
  return { id: name, candidateRepo, candidateRef: "HEAD", targetRepo, targetRef: "refs/heads/main", method: "squash", commitMessage: `Apply ${name}` };
}

test("worker_merge_apply snapshots require nonempty call IDs and exact prepared identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-merge-snapshot-"));
  const sessionFile = path.join(root, "parent.jsonl"); const runtimeRoot = path.join(root, "runtime"); const workersRoot = path.join(runtimeRoot, "workers");
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`); await mkdir(workersRoot, { recursive: true });
  const tools: ToolDefinition[] = []; const handlers = new Map<string, Function[]>();
  const api = { registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, sendMessage() {} } as unknown as ExtensionAPI;
  registerWorkerExtension(api, { runtimeRoot, roots: { stateRoot: workersRoot, workspaceRoot: workersRoot }, codeRoot: root, preparedRoot: path.join(root, "prepared"), targetRoot: path.join(root, "targets") });
  const context = { cwd: root, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "parent" }, isIdle: () => true, hasPendingMessages: () => false, ui: { notify() {} } } as unknown as ExtensionContext;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never; const signal = new AbortController().signal;
  try {
    for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
    const mergeTest = tools.find((tool) => tool.name === "worker_merge_test")!; const apply = tools.find((tool) => tool.name === "worker_merge_apply")!;
    const prepareAndApply = async (toolCallId: string, name: string) => {
      const repository = await createSnapshotMerge(root, name);
      const prepared = await mergeTest.execute!(`prepare-${name}`, { repositories: [repository] }, signal, undefined, context) as any;
      const preparedId = prepared.details.preparedId as string;
      return apply.execute!(toolCallId, { preparedId }, signal, undefined, context);
    };
    const render = (result: unknown, toolCallId: string) => stripTerminalSequences(apply.renderResult!(result as never, { expanded: false, isPartial: false }, theme, { toolCallId } as never).render(160).join("\n"));

    const first = await prepareAndApply("same-apply", "first");
    const second = await prepareAndApply("same-apply", "second");
    assert.match(render(first, "same-apply"), /target-first/); assert.doesNotMatch(render(first, "same-apply"), /target-second/);
    assert.match(render(second, "same-apply"), /target-second/);

    const mismatched = structuredClone(second) as any;
    mismatched.details.preparedId = `prepared_${"f".repeat(24)}`;
    mismatched.details.repositories[0].targetRepo = "/trusted/target-details";
    assert.match(render(mismatched, "same-apply"), /target-details/); assert.doesNotMatch(render(mismatched, "same-apply"), /target-second/);

    await assert.rejects(apply.execute!("same-apply", { preparedId: `prepared_${"0".repeat(24)}` }, signal, undefined, context));
    const failed = { content: [{ type: "text", text: "failed" }] };
    assert.doesNotMatch(render(failed, "same-apply"), /target-(?:first|second)/);
    assert.match(render(second, "same-apply"), /target-second/, "failed preflight leaves the old row to its own details");

    const emptyFirst = await prepareAndApply("", "empty-first");
    const emptySecond = await prepareAndApply("", "empty-second");
    assert.match(render(emptyFirst, ""), /target-empty-first/); assert.doesNotMatch(render(emptyFirst, ""), /target-empty-second/);
    assert.match(render(emptySecond, ""), /target-empty-second/);
    const emptyProbe = structuredClone(emptySecond) as any;
    emptyProbe.details.repositories[0].targetRepo = "/trusted/target-empty-details";
    assert.match(render(emptyProbe, ""), /target-empty-details/); assert.doesNotMatch(render(emptyProbe, ""), /target-empty-second/);
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
    await rm(root, { recursive: true, force: true });
  }
});

test("renderers never invoke bd or touch a registry while arguments stream or locks are held", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-render-pure-"));
  const bin = path.join(root, "bin"); await mkdir(bin);
  const marker = path.join(root, "bd-invoked"); const bd = path.join(bin, "bd");
  await writeFile(bd, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "invoked\\n");\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);\n`);
  await chmod(bd, 0o700);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath ?? ""}`;
  const runtimeRoot = path.join(root, "runtime"); const registry = openWorkerRegistry(runtimeRoot); registry.database.exec("BEGIN IMMEDIATE");
  try {
    const tools: ToolDefinition[] = [];
    registerWorkerExtension({ registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on() {}, sendMessage() {} } as unknown as ExtensionAPI, { runtimeRoot, roots: { stateRoot: path.join(runtimeRoot, "workers"), workspaceRoot: path.join(runtimeRoot, "workers") } });
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
    const run = tools.find((tool) => tool.name === "worker_run")!; const control = tools.find((tool) => tool.name === "worker_control")!; const mergeTest = tools.find((tool) => tool.name === "worker_merge_test")!; const apply = tools.find((tool) => tool.name === "worker_merge_apply")!;
    const started = performance.now();
    for (const taskId of ["personal-z", "personal-z5", "personal-z52", "personal-z52n", "personal-z52n5", "personal-z52n5.1", "personal-z52n5.11"]) {
      const streamed = { runs: [{ action: "start", role: "work", taskIds: [taskId], instructions: "partial" }] };
      run.renderCall!(streamed as never, theme, { args: streamed, argsComplete: false, executionStarted: false, toolCallId: taskId } as never).render(120);
    }
    const complete = { runs: [{ action: "start", role: "work", taskIds: ["personal-z52n5.11"], instructions: "complete" }] };
    run.renderCall!(complete as never, theme, { args: complete, argsComplete: true, toolCallId: "complete" } as never).render(120);
    const review = { runs: [{ action: "start", role: "review", reviewedRunId: "run_20260101000000_aaaaaaaa" }] };
    run.renderCall!(review as never, theme, { args: review, argsComplete: true, toolCallId: "review" } as never).render(120);
    const resume = { runs: [{ action: "resume", workerId: "worker_20260101000000_aaaaaaaa", instructions: "resume" }] };
    run.renderCall!(resume as never, theme, { args: resume, argsComplete: true, toolCallId: "resume" } as never).render(120);
    const integration = { runs: [{ action: "start", role: "integration", preparedId: `prepared_${"a".repeat(24)}`, taskIds: ["personal-task"] }] };
    run.renderCall!(integration as never, theme, { args: integration, argsComplete: true, toolCallId: "integration" } as never).render(120);
    apply.renderCall!({ preparedId: `prepared_${"a".repeat(24)}` } as never, theme, { argsComplete: true, toolCallId: "apply" } as never).render(120);
    run.renderResult!({ content: [{ type: "text", text: "provider" }], details: { runs: [{ action: "resume", role: "work", taskIds: ["personal-task"] }] } } as never, { expanded: false, isPartial: true }, theme, { toolCallId: "missing" } as never).render(120);
    const hostile = new Proxy({}, { get() { throw new Error("malformed metadata"); } });
    for (const tool of [run, control, mergeTest, apply]) {
      assert.doesNotThrow(() => tool.renderCall!(hostile as never, theme, hostile as never).render(40));
      assert.doesNotThrow(() => tool.renderResult!(hostile as never, { expanded: false, isPartial: false }, theme, hostile as never).render(40));
    }
    assert.ok(performance.now() - started < 500, `rendering blocked for ${performance.now() - started}ms`);
    await assert.rejects(readFile(marker, "utf8"), (error: any) => error?.code === "ENOENT");
  } finally {
    registry.database.exec("ROLLBACK"); registry.close();
    oldPath === undefined ? delete process.env.PATH : process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});
