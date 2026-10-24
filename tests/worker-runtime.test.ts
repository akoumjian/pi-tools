import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import workerRuntimeExtension, { executeWorkerBeadsHostRequest, executeWorkerResultHostRequest, readWorkerRuntimeResult } from "../extensions/worker/runtime.js";
import { buildWorkerRpcArgs, type WorkerHostConfig } from "../extensions/worker/runner.js";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

type FakeApi = ExtensionAPI & { tools: ToolDefinition[] };
function fakeApi(): FakeApi { const tools: ToolDefinition[] = []; return { tools, registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on() {}, sendMessage() {}, requestHost(service: string, payload: unknown) { if (service === "worker_result_submit") return executeWorkerResultHostRequest(payload); if (service === "worker_beads_tasks") return executeWorkerBeadsHostRequest(payload); if (service === "worker_runtime_hello" || service === "worker_runtime_state") return Promise.resolve({ accepted: true }); throw new Error(`unexpected host service ${service}`); } } as unknown as FakeApi; }
async function fixture(role: "work" | "review" | "integration", run: (root: string, api: FakeApi) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-runtime-"));
  await mkdir(path.join(root, "state", "async-shell"), { recursive: true });
  const beadsDir = path.join(root, "beads"); await mkdir(beadsDir);
  const beadsTasksFile = path.join(root, "fake-beads-tasks.json");
  await writeFile(beadsTasksFile, JSON.stringify([{ id: "personal-test", title: "Test", status: "in_progress", priority: 1, issue_type: "task", design: "Canonical design." }]));
  const bdPath = path.join(root, "fake-bd.mjs");
  await writeFile(bdPath, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const tasks = JSON.parse(readFileSync(process.env.FAKE_BEADS_TASKS_FILE, "utf8"));
if (args.includes("where")) {
  const route = JSON.parse(process.env.FAKE_BEADS_ROUTE);
  process.stdout.write(JSON.stringify({ prefix: route.prefix, path: route.path, database_path: route.databasePath }));
} else if (args.includes("search")) {
  const query = (args.find((arg) => arg.startsWith("--query=")) ?? "").slice(8).toLowerCase();
  const limit = Number((args.find((arg) => arg.startsWith("--limit=")) ?? "--limit=4").slice(8));
  process.stdout.write(JSON.stringify(tasks.filter((task) => task.id.toLowerCase().includes(query) || task.title.toLowerCase().includes(query)).slice(0, limit)));
} else if (args.includes("show")) {
  const ids = args.filter((arg) => arg.startsWith("--id=")).map((arg) => arg.slice(5));
  process.stdout.write(JSON.stringify(ids.map((id) => tasks.find((task) => task.id === id)).filter(Boolean)));
} else if (args.includes("update")) {
  process.stdout.write(JSON.stringify({ ok: true }));
} else {
  process.stderr.write("unsupported fake bd command"); process.exit(2);
}
`);
  await chmod(bdPath, 0o700);
  const beadsRoute = { prefix: "personal", path: beadsDir, databasePath: path.join(beadsDir, "database") };
  const values: Record<string, string> = {
    PI_WORKER_ID: "worker_20260101000000_aaaaaaaa", PI_WORKER_RUN_ID: "run_20260101000000_aaaaaaaa", PI_WORKER_ROLE: role, PI_WORKER_HOST_RPC: "1",
    PI_WORKER_RESULT_FILE: path.join(root, "state", "result.json"), PI_WORKER_WORKSPACE_ROOT: root,
    PI_WORKER_STATE_ROOT: root, PI_WORKER_SUPERVISION_ROOT: path.join(root, "state"), PI_WORKER_ASYNC_JOB_ROOT: path.join(root, "state", "async-shell"),
    PI_WORKER_TASK_IDS: JSON.stringify(["personal-test"]), PI_WORKER_AUTHORIZATION_FILE: path.join(root, "state", "host-authorization.json"),
    PI_WORKER_PROCESS_NONCE: "test-nonce", PI_WORKER_PARENT_PID: String(process.pid),
    PI_WORKER_BD_PATH: bdPath, PI_WORKER_BEADS_ROUTE: JSON.stringify(beadsRoute), BEADS_DIR: beadsDir,
    FAKE_BEADS_ROUTE: JSON.stringify(beadsRoute), FAKE_BEADS_TASKS_FILE: beadsTasksFile
  };
  await writeFile(values.PI_WORKER_AUTHORIZATION_FILE!, JSON.stringify({ version: 2, workerId: values.PI_WORKER_ID, runId: values.PI_WORKER_RUN_ID, processNonce: values.PI_WORKER_PROCESS_NONCE }));
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


test("durable authorization remains valid after the creating parent PID is gone", async () => {
  await fixture("work", async (root, api) => {
    const authorization = path.join(root, "state", "host-authorization.json");
    const value = JSON.parse(await readFile(authorization, "utf8")); await writeFile(authorization, JSON.stringify({ ...value, parentPid: 2_147_000_000 }));
    const tool = api.tools.find((candidate) => candidate.name === "worker_result_submit")!;
    const result = await tool.execute!("call", { outcome: "completed", summary: "Detached host settled." }, undefined, undefined, undefined as never);
    assert.equal((result.details as { status: string }).status, "accepted");
  });
});

test("review decisions require a retained report and cannot report repositories", async () => {
  await fixture("review", async (root, api) => {
    const tool = api.tools.find((candidate) => candidate.name === "worker_result_submit")!;
    const rejected = await tool.execute!("call", { outcome: "approve", summary: "Approved." }, undefined, undefined, undefined as never);
    assert.equal((rejected.details as { status: string }).status, "rejected");
    await mkdir(path.join(root, "reports")); await writeFile(path.join(root, "reports", "review.md"), "# Review\n");
    const result = await tool.execute!("call", { outcome: "approve", summary: "Approved.", artifacts: [path.join(root, "reports", "review.md")] }, undefined, undefined, undefined as never);
    assert.equal((result.details as { status: string }).status, "accepted");
  });
});

test("worker RPC arguments use immutable extensions and complete built-in tools", () => {
  const config = { provider: "openai-codex", model: "gpt", thinkingLevel: "xhigh", sessionFile: "/tmp/session.jsonl", sessionDir: "/tmp", sandbox: { extensionPaths: ["/opt/pi-tools/extensions/worker/runtime.ts"] } } as WorkerHostConfig;
  const args = buildWorkerRpcArgs(config);
  assert.equal(args.includes("--skill"), false); assert.equal(args.includes("--no-skills"), true); assert.equal(args.includes("--no-builtin-tools"), false); assert.ok(args.includes("/opt/pi-tools/extensions/worker/runtime.ts"));
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
      await assert.rejects(() => executeWorkerResultHostRequest({ outcome: "completed", summary: "probe" }), /supervision\/worker-root boundary/);
      assert.equal(existsSync(path.join(outside, "result.json")), false);
    } finally { if (prior === undefined) delete process.env.PI_WORKER_RESULT_FILE; else process.env.PI_WORKER_RESULT_FILE = prior; await rm(outside, { recursive: true, force: true }); }
  });
});

test("durable authorization revocation blocks result submission and Beads calls", async () => {
  await fixture("work", async (root, api) => {
    await rm(process.env.PI_WORKER_AUTHORIZATION_FILE!, { force: true });
    await assert.rejects(() => executeWorkerResultHostRequest({ outcome: "completed", summary: "late" }), /revoked/);
    await assert.rejects(() => executeWorkerBeadsHostRequest({ action: "assigned" }), /revoked/);
    await assert.rejects(() => executeWorkerBeadsHostRequest({ action: "design", taskId: "personal-test" }), /revoked/);
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

test("Beads task reads expose canonical design with UTF-8-safe continuation under the global budget", async () => {
  await fixture("work", async (_root, api) => {
    const canonical = "α🙂\n".repeat(8_000);
    await writeFile(process.env.FAKE_BEADS_TASKS_FILE!, JSON.stringify([{ id: "personal-test", title: "Canonical", status: "in_progress", priority: 1, issue_type: "decision", design: canonical }]));
    const tool = api.tools.find((candidate) => candidate.name === "worker_beads_tasks")!;
    const firstResult = await tool.execute!("call", { action: "get", taskIds: ["personal-test"] }, undefined, undefined, undefined as never);
    const firstText = firstResult.content[0]!.type === "text" ? firstResult.content[0]!.text : "";
    const first = JSON.parse(firstText) as { tasks: Array<{ design: { content: string; offset: number; returnedBytes: number; totalBytes: number; sha256: string; truncated: boolean; nextOffset?: number }; truncatedFields: string[] }> };
    const initial = first.tasks[0]!.design;
    assert.equal(Buffer.byteLength(firstText), (firstResult.details as { contentBytes: number }).contentBytes);
    assert.ok(Buffer.byteLength(firstText) <= 64 * 1024);
    assert.equal(initial.offset, 0); assert.equal(initial.totalBytes, Buffer.byteLength(canonical)); assert.equal(initial.sha256, sha256(canonical)); assert.equal(initial.truncated, true);
    assert.equal(canonical.startsWith(initial.content), true); assert.ok(!initial.content.includes("�"));
    assert.ok(first.tasks[0]!.truncatedFields.includes("design"));

    let combined = initial.content;
    let offset = initial.nextOffset!;
    while (offset < initial.totalBytes) {
      const result = await tool.execute!("call", { action: "design", taskId: "personal-test", offset, limit: 32 * 1024, expectedSha256: initial.sha256 }, undefined, undefined, undefined as never);
      const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
      const page = JSON.parse(text) as { design: { content: string; offset: number; returnedBytes: number; totalBytes: number; sha256: string; truncated: boolean; nextOffset?: number } };
      assert.ok(Buffer.byteLength(text) <= 64 * 1024); assert.equal(page.design.offset, offset); assert.equal(page.design.sha256, initial.sha256); assert.ok(page.design.returnedBytes > 0); assert.ok(!page.design.content.includes("�"));
      combined += page.design.content;
      offset = page.design.nextOffset ?? page.design.totalBytes;
    }
    assert.equal(combined, canonical);
  });
});

test("Beads design chunks enforce serialized response bytes and reject non-boundary offsets", async () => {
  await fixture("review", async (_root, api) => {
    const canonical = "\u0000\\\"🙂".repeat(10_000);
    await writeFile(process.env.FAKE_BEADS_TASKS_FILE!, JSON.stringify([{ id: "personal-test", title: "Budget", status: "open", priority: 1, issue_type: "task", design: canonical }]));
    const tool = api.tools.find((candidate) => candidate.name === "worker_beads_tasks")!;
    const result = await tool.execute!("call", { action: "design", taskId: "personal-test", offset: 0, limit: 48 * 1024 }, undefined, undefined, undefined as never);
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    const value = JSON.parse(text) as { design: { content: string; returnedBytes: number; totalBytes: number; sha256: string; nextOffset?: number } };
    assert.ok(Buffer.byteLength(text) <= 64 * 1024); assert.equal(Buffer.byteLength(text), (result.details as { contentBytes: number }).contentBytes);
    assert.ok(value.design.returnedBytes > 0); assert.ok(value.design.returnedBytes < 48 * 1024); assert.equal(value.design.sha256, sha256(canonical)); assert.equal(canonical.startsWith(value.design.content), true); assert.ok(value.design.nextOffset);

    await writeFile(process.env.FAKE_BEADS_TASKS_FILE!, JSON.stringify([{ id: "personal-test", title: "UTF-8", status: "open", priority: 1, issue_type: "task", design: "🙂x" }]));
    const utf8Digest = sha256("🙂x");
    await assert.rejects(() => tool.execute!("call", { action: "design", taskId: "personal-test", offset: 1, limit: 4, expectedSha256: utf8Digest }, undefined, undefined, undefined as never), /UTF-8 character boundary/);
    await assert.rejects(() => tool.execute!("call", { action: "design", taskId: "personal-test", offset: 100, limit: 4, expectedSha256: utf8Digest }, undefined, undefined, undefined as never), /exceeds 5 UTF-8 bytes/);
  });
});

test("Beads search omits design while the design continuation branch preserves read-only review authority", async () => {
  await fixture("review", async (_root, api) => {
    await writeFile(process.env.FAKE_BEADS_TASKS_FILE!, JSON.stringify([{ id: "personal-test", title: "Searchable", status: "open", priority: 1, issue_type: "task", design: "private-sized-spec" }]));
    const tool = api.tools.find((candidate) => candidate.name === "worker_beads_tasks")!;
    assert.equal(Check(tool.parameters, { action: "design", taskId: "personal-test", offset: 0, limit: 4096 }), true);
    assert.equal(Check(tool.parameters, { action: "design", taskId: "personal-test", offset: 1, limit: 4096 }), false);
    assert.equal(Check(tool.parameters, { action: "design", taskId: "personal-test", offset: 1, limit: 4096, expectedSha256: "a".repeat(64) }), true);
    assert.equal(Check(tool.parameters, { action: "design", taskId: "personal-test", offset: 1, limit: 4096, expectedSha256: "A".repeat(64) }), false);
    assert.equal(Check(tool.parameters, { action: "design", taskId: "personal-test", offset: 1, limit: 3, expectedSha256: "a".repeat(64) }), false);
    assert.equal(Check(tool.parameters, { action: "update", taskId: "personal-test", note: "no" }), false);
    const result = await tool.execute!("call", { action: "search", query: "Searchable", limit: 1 }, undefined, undefined, undefined as never);
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    const value = JSON.parse(text) as { tasks: Array<Record<string, unknown>> };
    assert.equal("design" in value.tasks[0]!, false);
  });
});

test("multi-task design projection shrinks inline chunks rather than exceeding the shared response budget", async () => {
  await fixture("work", async (_root, api) => {
    const taskIds = ["personal-one", "personal-two", "personal-three", "personal-four"];
    process.env.PI_WORKER_TASK_IDS = JSON.stringify(taskIds);
    const design = "\u0000\\\"🙂".repeat(4_000);
    await writeFile(process.env.FAKE_BEADS_TASKS_FILE!, JSON.stringify(taskIds.map((id) => ({ id, title: id, status: "open", priority: 1, issue_type: "task", design }))));
    const tool = api.tools.find((candidate) => candidate.name === "worker_beads_tasks")!;
    const result = await tool.execute!("call", { action: "assigned", limit: 4 }, undefined, undefined, undefined as never);
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    const value = JSON.parse(text) as { tasks: Array<{ design: { content: string; totalBytes: number; sha256: string; truncated: boolean; nextOffset?: number }; truncatedFields: string[] }> };
    assert.ok(Buffer.byteLength(text) <= 64 * 1024); assert.equal(value.tasks.length, 4);
    assert.ok(value.tasks.every((task) => task.design.totalBytes === Buffer.byteLength(design) && task.design.sha256 === sha256(design) && design.startsWith(task.design.content)));
    assert.ok(value.tasks.some((task) => task.design.truncated && task.truncatedFields.includes("design") && task.design.nextOffset !== undefined));
  });
});

test("Beads design continuation rejects missing, malformed, and stale full-design digests", async () => {
  await fixture("work", async (_root, api) => {
    const original = "A".repeat(20_000) + "OLD-TAIL";
    const revised = "B".repeat(20_000) + "NEW-TAIL";
    assert.equal(Buffer.byteLength(original), Buffer.byteLength(revised), "mutation fixture must preserve byte length");
    await writeFile(process.env.FAKE_BEADS_TASKS_FILE!, JSON.stringify([{ id: "personal-test", title: "Mutable", status: "open", priority: 1, issue_type: "task", design: original }]));
    const tool = api.tools.find((candidate) => candidate.name === "worker_beads_tasks")!;
    const firstResult = await tool.execute!("call", { action: "design", taskId: "personal-test", offset: 0, limit: 4096 }, undefined, undefined, undefined as never);
    const firstText = firstResult.content[0]!.type === "text" ? firstResult.content[0]!.text : "";
    const first = JSON.parse(firstText) as { design: { sha256: string; nextOffset: number } };
    assert.equal(first.design.sha256, sha256(original));
    const pinnedAtZero = await tool.execute!("call", { action: "design", taskId: "personal-test", offset: 0, limit: 4096, expectedSha256: first.design.sha256 }, undefined, undefined, undefined as never);
    const pinnedText = pinnedAtZero.content[0]!.type === "text" ? pinnedAtZero.content[0]!.text : "";
    assert.equal((JSON.parse(pinnedText) as { design: { sha256: string } }).design.sha256, first.design.sha256);
    await assert.rejects(() => tool.execute!("call", { action: "design", taskId: "personal-test", offset: first.design.nextOffset, limit: 4096 }, undefined, undefined, undefined as never), /requires expectedSha256 from offset 0/);
    await assert.rejects(() => tool.execute!("call", { action: "design", taskId: "personal-test", offset: first.design.nextOffset, limit: 4096, expectedSha256: "not-a-digest" }, undefined, undefined, undefined as never), /64 lowercase hexadecimal/);

    await writeFile(process.env.FAKE_BEADS_TASKS_FILE!, JSON.stringify([{ id: "personal-test", title: "Mutable", status: "open", priority: 1, issue_type: "task", design: revised }]));
    await assert.rejects(() => tool.execute!("call", { action: "design", taskId: "personal-test", offset: first.design.nextOffset, limit: 4096, expectedSha256: first.design.sha256 }, undefined, undefined, undefined as never), /design changed; restart at offset 0/);
    await assert.rejects(() => tool.execute!("call", { action: "design", taskId: "personal-test", offset: 0, limit: 4096, expectedSha256: first.design.sha256 }, undefined, undefined, undefined as never), /does not match the design at offset 0; retry without expectedSha256/);
    const restarted = await tool.execute!("call", { action: "design", taskId: "personal-test", offset: 0, limit: 4096 }, undefined, undefined, undefined as never);
    const restartedText = restarted.content[0]!.type === "text" ? restarted.content[0]!.text : "";
    assert.equal((JSON.parse(restartedText) as { design: { sha256: string } }).design.sha256, sha256(revised));
  });
});

test("remote result submission does not retry host commit when pre-admission runtime-state publication fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-remote-admission-"));
  const asyncRoot = path.join(root, "async-shell"); await mkdir(asyncRoot, { recursive: true });
  const values: Record<string, string> = {
    PI_WORKER_HOST_RPC: "1",
    PI_WORKER_ID: "worker_20260101000000_bbbbbbbb",
    PI_WORKER_RUN_ID: "run_20260101000000_bbbbbbbb",
    PI_WORKER_ROLE: "work",
    PI_WORKER_WORKSPACE_ROOT: root,
    PI_WORKER_ASYNC_JOB_ROOT: asyncRoot
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]])); Object.assign(process.env, values);
  const services: string[] = []; const tools: ToolDefinition[] = [];
  const api = {
    registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on() {}, sendMessage() {},
    async requestHost(service: string): Promise<unknown> { services.push(service); if (service === "worker_runtime_state") throw new Error("state transport probe"); throw new Error(`unexpected host request ${service}`); }
  } as unknown as ExtensionAPI;
  try {
    workerRuntimeExtension(api);
    const tool = tools.find((candidate) => candidate.name === "worker_result_submit")!;
    const result = await tool.execute!("call", { outcome: "completed", summary: "must not commit" }, undefined, undefined, undefined as never);
    assert.equal((result.details as { status: string }).status, "rejected");
    assert.ok(services.length >= 1); assert.ok(services.every((service) => service === "worker_runtime_state"), "a failed pre-admission state publication must never reach result commit");
  } finally {
    for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});

test("remote conflicting result replay preserves the accepted guest admission seal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-remote-replay-")); const asyncRoot = path.join(root, "async-shell"); await mkdir(asyncRoot, { recursive: true });
  const values: Record<string, string> = { PI_WORKER_HOST_RPC: "1", PI_WORKER_ID: "worker_20260101000000_cccccccc", PI_WORKER_RUN_ID: "run_20260101000000_cccccccc", PI_WORKER_ROLE: "work", PI_WORKER_WORKSPACE_ROOT: root, PI_WORKER_ASYNC_JOB_ROOT: asyncRoot };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]])); Object.assign(process.env, values);
  const tools: ToolDefinition[] = []; const handlers = new Map<string, Function[]>(); let submissions = 0; let stateReports = 0; let acceptedStateReports = 0;
  const api = {
    registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, sendMessage() {}, on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    async requestHost(service: string, payload: unknown): Promise<unknown> {
      if (service === "worker_runtime_state") { const state = payload as { sequence: number; admissionState: string }; stateReports += 1; if (state.admissionState === "accepted" && ++acceptedStateReports === 1) throw new Error("accepted-state transport probe"); return { accepted: true, sequence: state.sequence }; }
      if (service === "worker_result_submit" && submissions++ === 0) return { content: [{ type: "text", text: "accepted" }], details: { status: "accepted", outcome: "completed" } };
      throw new Error("conflicting payload probe");
    }
  } as unknown as ExtensionAPI;
  try {
    workerRuntimeExtension(api); const tool = tools.find((candidate) => candidate.name === "worker_result_submit")!;
    const committed = await tool.execute!("first", { outcome: "completed", summary: "first" }, undefined, undefined, undefined as never); assert.equal((committed.details as { status: string }).status, "rejected", "lost accepted-state delivery must report transport failure without reopening");
    await handlers.get("agent_end")?.[0]?.({}); assert.ok(stateReports >= 2); assert.ok(acceptedStateReports >= 2, "a later state transition must recover the failed accepted-state delivery");
    const conflicting = await tool.execute!("second", { outcome: "completed", summary: "different" }, undefined, undefined, undefined as never); assert.equal((conflicting.details as { status: string }).status, "rejected");
    const guard = handlers.get("tool_call")?.[0]?.({ toolName: "shell_start" }); assert.deepEqual(guard, { block: true, reason: "Worker run is sealed during or after result admission." });
  } finally {
    for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});
