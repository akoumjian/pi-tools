import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import workerRuntimeExtension, { readWorkerRuntimeResult } from "../extensions/worker/runtime.js";
import { buildWorkerRpcArgs, type WorkerHostConfig } from "../extensions/worker/runner.js";

type FakeApi = ExtensionAPI & { tools: ToolDefinition[] };
function fakeApi(): FakeApi { const tools: ToolDefinition[] = []; return { tools, registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on() {}, sendMessage() {} } as unknown as FakeApi; }
async function fixture(role: "work" | "review" | "integration", run: (root: string, api: FakeApi) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-runtime-"));
  await mkdir(path.join(root, "state", "async-shell"), { recursive: true });
  const values: Record<string, string> = {
    PI_WORKER_ID: "worker_20260101000000_aaaaaaaa", PI_WORKER_RUN_ID: "run_20260101000000_aaaaaaaa", PI_WORKER_ROLE: role,
    PI_WORKER_RESULT_FILE: path.join(root, "state", "result.json"), PI_WORKER_WORKSPACE_ROOT: root,
    PI_WORKER_STATE_ROOT: path.join(root, "state"), PI_WORKER_ASYNC_JOB_ROOT: path.join(root, "state", "async-shell"),
    PI_WORKER_TASK_IDS: JSON.stringify(["personal-test"]), PI_WORKER_AUTHORIZATION_FILE: path.join(root, "state", "host-authorization.json"),
    PI_WORKER_PROCESS_NONCE: "test-nonce", PI_WORKER_PARENT_PID: String(process.pid)
  };
  await writeFile(values.PI_WORKER_AUTHORIZATION_FILE!, JSON.stringify({ version: 1, workerId: values.PI_WORKER_ID, runId: values.PI_WORKER_RUN_ID, parentPid: process.pid, processNonce: values.PI_WORKER_PROCESS_NONCE }));
  const old = new Map(Object.keys(values).map((key) => [key, process.env[key]])); Object.assign(process.env, values);
  try { const api = fakeApi(); workerRuntimeExtension(api); await run(root, api); }
  finally { for (const [key, value] of old) value === undefined ? delete process.env[key] : process.env[key] = value; await rm(root, { recursive: true, force: true }); }
}

test("runtime exposes only consolidated worker tools", async () => {
  await fixture("work", async (_root, api) => {
    assert.deepEqual(api.tools.map((tool) => tool.name).sort(), ["worker_beads_tasks", "worker_result_submit"]);
  });
});

test("work result submission validates and persists normalized repository and artifact paths", async () => {
  await fixture("work", async (root, api) => {
    const repository = path.join(root, "repos", "project"); await mkdir(repository, { recursive: true }); execFileSync("git", ["init", "-q", repository]);
    await mkdir(path.join(root, "artifacts")); await writeFile(path.join(root, "artifacts", "report.txt"), "ok\n");
    const tool = api.tools.find((candidate) => candidate.name === "worker_result_submit")!;
    const result = await tool.execute!("call", { outcome: "completed", summary: "Done.", repositories: ["repos/project"], artifacts: ["artifacts/report.txt"] }, undefined, undefined, undefined as never);
    assert.equal((result.details as { status: string }).status, "accepted");
    const accepted = readWorkerRuntimeResult(path.join(root, "state", "result.json"));
    assert.deepEqual(accepted.result.repositories, ["repos/project"]);
    assert.deepEqual(accepted.result.artifacts, ["artifacts/report.txt"]);
  });
});

test("review decisions require a retained report and cannot report repositories", async () => {
  await fixture("review", async (root, api) => {
    const tool = api.tools.find((candidate) => candidate.name === "worker_result_submit")!;
    const rejected = await tool.execute!("call", { outcome: "approve", summary: "Approved." }, undefined, undefined, undefined as never);
    assert.equal((rejected.details as { status: string }).status, "rejected");
    await mkdir(path.join(root, "reports")); await writeFile(path.join(root, "reports", "review.md"), "# Review\n");
    const result = await tool.execute!("call", { outcome: "approve", summary: "Approved.", artifacts: ["/workspace/reports/review.md"] }, undefined, undefined, undefined as never);
    assert.equal((result.details as { status: string }).status, "accepted");
  });
});

test("worker RPC arguments use plain role instructions rather than injected skills", () => {
  const config = {
    version: 1, workerId: "worker_20260101000000_aaaaaaaa", runId: "run_20260101000000_aaaaaaaa", sessionId: "session", sessionFile: "/tmp/session.jsonl", sessionDir: "/tmp",
    workspaceRoot: "/tmp/workspace", stateRoot: "/tmp/state", asyncJobRoot: "/tmp/jobs", taskIds: ["personal-test"], role: "work", resultFile: "/tmp/result", settledFile: "/tmp/settled",
    processFile: "/tmp/process", processNonce: "nonce", hostConfigFile: "/tmp/host", authorizationFile: "/tmp/auth", parentPid: process.pid, prompt: "prompt",
    provider: "openai-codex", model: "gpt", thinkingLevel: "xhigh", piCliPath: "/bin/pi", bdPath: "/bin/bd", beadsRoute: { prefix: "personal", path: "/beads", databasePath: "/beads/db" },
    extensionPaths: ["/worker/runtime.js"], shellExecution: { kind: "native-test" }, rpcArgs: []
  } satisfies WorkerHostConfig;
  const args = buildWorkerRpcArgs(config);
  assert.equal(args.includes("--skill"), false);
  assert.equal(args.includes("--no-skills"), true);
});

test("result submission rejects parent-directory symlink escapes with a coded non-sealing result", async () => {
  await fixture("work", async (root, api) => {
    const outside = await mkdtemp(path.join(tmpdir(), "pi-worker-result-outside-"));
    try {
      await mkdir(path.join(outside, "repo")); execFileSync("git", ["init", "-q", path.join(outside, "repo")]); await writeFile(path.join(outside, "evidence.txt"), "outside\n");
      await mkdir(path.join(root, "repos"), { recursive: true });
      await symlink(outside, path.join(root, "repos", "link"));
      const tool = api.tools.find((candidate) => candidate.name === "worker_result_submit")!;
      const result = await tool.execute!("call", { outcome: "completed", summary: "probe", repositories: ["repos/link/repo"], artifacts: ["repos/link/evidence.txt"] }, undefined, undefined, undefined as never);
      const details = result.details as { status: string; errors: Array<{ code: string; path: string }> };
      assert.equal(details.status, "rejected"); assert.equal(details.errors[0]?.code, "path_outside_workspace"); assert.match(details.errors[0]?.path ?? "", /repositories/);
      assert.equal(existsSync(path.join(root, "state", "result.json")), false);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

test("runtime rejects a result-file parent that resolves outside trusted state", async () => {
  await fixture("work", async (root, api) => {
    const outside = await mkdtemp(path.join(tmpdir(), "pi-worker-state-outside-"));
    const prior = process.env.PI_WORKER_RESULT_FILE;
    try {
      await symlink(outside, path.join(root, "state", "escape"));
      process.env.PI_WORKER_RESULT_FILE = path.join(root, "state", "escape", "result.json");
      const tool = api.tools.find((candidate) => candidate.name === "worker_result_submit")!;
      await assert.rejects(() => tool.execute!("call", { outcome: "completed", summary: "probe" }, undefined, undefined, undefined as never), /state paths must remain beneath/);
      assert.equal(existsSync(path.join(outside, "result.json")), false);
    } finally { if (prior === undefined) delete process.env.PI_WORKER_RESULT_FILE; else process.env.PI_WORKER_RESULT_FILE = prior; await rm(outside, { recursive: true, force: true }); }
  });
});

test("durable authorization revocation blocks result submission and Beads calls", async () => {
  await fixture("work", async (root, api) => {
    await rm(process.env.PI_WORKER_AUTHORIZATION_FILE!, { force: true });
    const result = api.tools.find((candidate) => candidate.name === "worker_result_submit")!;
    await assert.rejects(() => result.execute!("call", { outcome: "completed", summary: "late" }, undefined, undefined, undefined as never), /revoked/);
    const beads = api.tools.find((candidate) => candidate.name === "worker_beads_tasks")!;
    await assert.rejects(() => beads.execute!("call", { action: "assigned" }, undefined, undefined, undefined as never), /revoked/);
    assert.equal(existsSync(path.join(root, "state", "result.json")), false);
  });
});

test("review runtime exposes only read-only Beads branches with four-item bounds", async () => {
  await fixture("review", async (_root, api) => {
    const tool = api.tools.find((candidate) => candidate.name === "worker_beads_tasks")!;
    assert.equal(Check(tool.parameters, { action: "assigned", limit: 4 }), true);
    assert.equal(Check(tool.parameters, { action: "get", taskIds: ["personal-a", "personal-b", "personal-c", "personal-d", "personal-e"] }), false);
    assert.equal(Check(tool.parameters, { action: "update", taskId: "personal-a", note: "no" }), false);
    assert.equal(tool.label, "Read and Update Beads Tasks");
  });
});

test("worker_result_submit returns the approved accepted/rejected semantic union", async () => {
  await fixture("work", async (_root, api) => {
    const tool = api.tools.find((candidate) => candidate.name === "worker_result_submit")!;
    assert.equal(tool.description, "End the current worker run by submitting a structured result. Use it for completed work, requests for guidance, blockers, and review verdicts. The tool records the outcome, summary, optional question, and reported repository and artifact paths, then seals the run and returns control to the parent. It does not approve work, apply repositories, close tasks, or discard the worker.");
    const rejected = await tool.execute!("call", { outcome: "needs_input", summary: "question missing" }, undefined, undefined, undefined as never);
    assert.deepEqual((rejected.details as any).errors.map((item: any) => ({ code: item.code, path: item.path })), [{ code: "question_required", path: "question" }]);
    const accepted = await tool.execute!("call", { outcome: "completed", summary: "done" }, undefined, undefined, undefined as never);
    assert.deepEqual(accepted.details, { status: "accepted", outcome: "completed" });
  });
});
