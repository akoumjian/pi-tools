import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { WorkerControlParams, WorkerMergeApplyParams, WorkerMergeTestParams, WorkerRunParams, registerWorkerExtension } from "../extensions/worker/index.js";
import { RetainedToolOutputSchemas } from "../extensions/_shared/tool-output.js";
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
  assert.equal(Check(WorkerMergeTestParams, { repositories: [{ candidateId: `candidate_${"a".repeat(24)}`, targetRepo: "/target", targetRef: "refs/heads/main", method: "merge", commitMessage: "Merge" }] }), true);
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
    assert.equal(Check(RetainedToolOutputSchemas.worker_run, result), true);
    const list = await tools.find((candidate) => candidate.name === "worker_control")!.execute!("list", { action: "list" }, new AbortController().signal, undefined, context);
    assert.equal(Check(RetainedToolOutputSchemas.worker_control, list), true);
    const exact = await tools.find((candidate) => candidate.name === "worker_control")!.execute!("get", { action: "get", workerId: receipt.workerId, runId: receipt.runId }, new AbortController().signal, undefined, context);
    assert.equal(Check(RetainedToolOutputSchemas.worker_control, exact), true);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, context);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("parent tool labels and approved copy remain exact and schemas carry field descriptions", () => {
  const tools: ToolDefinition[] = [];
  registerWorkerExtension({ registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on() {}, sendMessage() {} } as unknown as ExtensionAPI);
  const run = tools.find((tool) => tool.name === "worker_run")!; const control = tools.find((tool) => tool.name === "worker_control")!; const apply = tools.find((tool) => tool.name === "worker_merge_apply")!;
  assert.equal(run.label, "Run Workers"); assert.equal(run.promptSnippet, "Start work, review, or integration workers, or resume previous workers."); assert.match(run.description, /Each new worker receives its role-specific inputs/);
  assert.equal(control.label, "Manage Workers"); assert.equal(control.description, "List and manage durable workers owned by the current parent session. Use `list` for compact worker discovery, `runs` to list one worker’s execution history, and `get` to inspect one exact active or settled run, including logs, session and workspace access, and submitted repository or artifact outputs. Use `cancel` to stop active work while preserving retained state. Use `discard` to permanently delete an idle worker and all retained state.");
  assert.equal(apply.label, "Apply Prepared Repository Merges"); assert.match(apply.description, /Applying multiple repositories is not atomic/);
  const schemaText = JSON.stringify(WorkerRunParams); for (const phrase of ["Continue a previous worker", "One or more Beads task IDs", "Additional files or directories", "When to deliver the asynchronous result"]) assert.match(schemaText, new RegExp(phrase));
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
