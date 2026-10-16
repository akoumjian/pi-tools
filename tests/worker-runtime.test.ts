import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
    PI_WORKER_TASK_IDS: JSON.stringify(["personal-test"])
  };
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
    assert.equal((result.details as { accepted: boolean }).accepted, true);
    const accepted = readWorkerRuntimeResult(path.join(root, "state", "result.json"));
    assert.deepEqual(accepted.result.repositories, ["repos/project"]);
    assert.deepEqual(accepted.result.artifacts, ["artifacts/report.txt"]);
  });
});

test("review decisions require a retained report and cannot report repositories", async () => {
  await fixture("review", async (root, api) => {
    const tool = api.tools.find((candidate) => candidate.name === "worker_result_submit")!;
    await assert.rejects(() => tool.execute!("call", { outcome: "approve", summary: "Approved." }, undefined, undefined, undefined as never), /artifact/);
    await mkdir(path.join(root, "reports")); await writeFile(path.join(root, "reports", "review.md"), "# Review\n");
    const result = await tool.execute!("call", { outcome: "approve", summary: "Approved.", artifacts: ["/workspace/reports/review.md"] }, undefined, undefined, undefined as never);
    assert.equal((result.details as { accepted: boolean }).accepted, true);
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
