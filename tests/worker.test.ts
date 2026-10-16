import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { WorkerControlParams, WorkerMergeApplyParams, WorkerMergeTestParams, WorkerRunParams, registerWorkerExtension } from "../extensions/worker/index.js";
import { normalizeWorkerSettings } from "../extensions/worker/settings.js";
import { validateWorkerResultInput, WorkerResultValidationError } from "../extensions/worker/contract.js";

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
  assert.equal(value.defaultRoute, settings.modelPreferences.work[0]);
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
  for (const value of [{ action: "list" }, { action: "runs", workerId: "worker_20260101000000_aaaaaaaa" }, { action: "get", workerId: "worker_20260101000000_aaaaaaaa", runId: "run_20260101000000_aaaaaaaa" }, { action: "cancel", workerId: "worker_20260101000000_aaaaaaaa" }, { action: "discard", workerId: "worker_20260101000000_aaaaaaaa" }]) assert.equal(Check(WorkerControlParams, value), true);
  assert.equal(Check(WorkerControlParams, { action: "status" }), false);
  assert.equal(Check(WorkerMergeTestParams, { repositories: [{ id: "repo", candidateRepo: "/candidate", targetRepo: "/target", targetRef: "refs/heads/main", method: "merge", commitMessage: "Merge" }] }), true);
  assert.equal(Check(WorkerMergeApplyParams, { preparedId: `prepared_${"b".repeat(24)}` }), true);
});

test("result outcomes are role-specific and reviews require artifacts", () => {
  assert.equal(validateWorkerResultInput("work", { outcome: "completed", summary: "Done." }).outcome, "completed");
  assert.throws(() => validateWorkerResultInput("work", { outcome: "approve", summary: "No." }), WorkerResultValidationError);
  assert.throws(() => validateWorkerResultInput("review", { outcome: "approve", summary: "Approved." }), /artifact/);
  assert.equal(validateWorkerResultInput("review", { outcome: "request_changes", summary: "Fix.", artifacts: ["review.md"] }).outcome, "request_changes");
  assert.throws(() => validateWorkerResultInput("integration", { outcome: "needs_input", summary: "Question." }), /question/);
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
  assert.deepEqual(commands.sort(), ["worker:cancel", "worker:discard", "worker:list", "worker:logs", "worker:show"]);
});


test("worker_run work start persists a v2 registry receipt before deferred launch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-v2-facade-"));
  try {
    const sessionFile = path.join(root, "parent.jsonl"); await writeFile(sessionFile, "{}\n");
    const workersRoot = path.join(root, "runtime", "workers"); await mkdir(workersRoot, { recursive: true });
    const tools: ToolDefinition[] = []; const handlers = new Map<string, Function[]>();
    const api = { registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, sendMessage() {} } as unknown as ExtensionAPI;
    registerWorkerExtension(api, { runtimeRoot: path.join(root, "runtime"), legacy: {
      roots: { stateRoot: workersRoot, workspaceRoot: workersRoot }, now: () => new Date("2026-01-01T00:00:00.000Z"), random: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      launch: () => { throw new Error("deferred launch must not run during receipt test"); }, adoptRuns: async () => {}, pinRepositories: () => []
    } });
    const model = { id: "gpt-5.6-sol", name: "gpt-5.6-sol", provider: "openai-codex", api: "openai-responses", baseUrl: "https://example.invalid", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 } as Model<Api>;
    const context = { cwd: root, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "parent" }, modelRegistry: { hasConfiguredAuth: () => true, getAll: () => [model] }, isIdle: () => true, hasPendingMessages: () => false, ui: { notify() {} } } as unknown as ExtensionContext;
    for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
    const tool = tools.find((candidate) => candidate.name === "worker_run")!;
    const result = await tool.execute!("call", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "Implement." }] }, new AbortController().signal, undefined, context);
    const receipt = (result.details as { runs: Array<{ role: string; status: string }> }).runs[0]!;
    assert.equal(receipt.role, "work"); assert.equal(receipt.status, "queued");
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
  } finally { await rm(root, { recursive: true, force: true }); }
});
