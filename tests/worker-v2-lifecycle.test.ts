import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerWorkerExtension } from "../extensions/worker/index.js";
import { getWorker, getWorkerRun, listWorkers, openWorkerRegistry, storePreparedSet } from "../extensions/worker/registry.js";
import type { ManagedAsyncJobHandle, JobMeta } from "../extensions/async-shell/index.js";
import type { ReviewOverlayRecord } from "../extensions/worker/review-workspace.js";
import { prepareWorkerMerges } from "../extensions/worker/merge.js";

const model = (provider: string, id: string) => ({ id, name: id, provider, api: "openai-responses", baseUrl: "https://example.invalid", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 }) as Model<Api>;

type Launch = { record: any; runtime: any; resolve(job: JobMeta): void; handle: ManagedAsyncJobHandle };
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(options: { launchThrows?: boolean; overlayThrows?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-v2-lifecycle-"));
  const runtimeRoot = path.join(root, "runtime"); const workersRoot = path.join(runtimeRoot, "workers"); mkdirSync(workersRoot, { recursive: true });
  const session = SessionManager.create(root, path.join(root, "parent-session"), { id: `parent-${Date.now()}` }); writeFileSync(session.getSessionFile()!, `${JSON.stringify(session.getHeader())}\n`, { mode: 0o600 });
  const tools: ToolDefinition[] = []; const handlers = new Map<string, Function[]>(); const messages: any[] = [];
  const launches: Launch[] = []; const removed: string[] = []; const overlays: ReviewOverlayRecord[] = []; const cleaned: ReviewOverlayRecord[] = [];
  let counter = 0; const random = () => `${(++counter).toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const api = { registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, registerMessageRenderer() {}, on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, sendMessage(message: any) { messages.push(message); } } as unknown as ExtensionAPI;
  const context = { cwd: root, hasUI: false, mode: "rpc", sessionManager: session, modelRegistry: { hasConfiguredAuth: () => true, getAll: () => [model("openai-codex", "gpt-5.6-sol"), model("anthropic", "claude-opus-5-5")] }, thinkingLevel: "xhigh", isIdle: () => true, hasPendingMessages: () => false, ui: { notify() {} } } as unknown as ExtensionContext;
  registerWorkerExtension(api, {
    runtimeRoot, roots: { stateRoot: workersRoot, workspaceRoot: workersRoot }, codeRoot: root, preparedRoot: path.join(runtimeRoot, "prepared"), targetRoot: root, dockerPath: "/fake/docker", random, now: () => new Date(`2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`),
    createContainer: (_docker, reference) => ({ ...reference, containerId: (++counter).toString(16).padStart(64, "0") }), removeContainer: (_docker, reference) => { removed.push(reference.runId); },
    createOverlay: (input) => { if (options.overlayThrows) throw new Error("overlay probe failure"); const value: ReviewOverlayRecord = { version: 2, mergedVolume: `merged-${input.workerId}-${input.runId}`, scratchVolume: `scratch-${input.workerId}-${input.runId}`, mounts: [
      { kind: "volume", source: `merged-${input.workerId}-${input.runId}`, target: "/review/subject" }, { kind: "bind", source: input.reviewerWorkspace, target: "/workspace" },
      { kind: "bind", source: input.contextFile, target: "/review/context.json", readOnly: true }, { kind: "bind", source: input.reviewedSessionFile, target: "/review/session.jsonl", readOnly: true },
      ...(input.additionalInputs ?? []).map((item) => ({ kind: "bind" as const, source: item.source, target: item.target, readOnly: true }))
    ] }; overlays.push(value); return value; }, cleanupOverlay: (_docker, overlay) => { cleaned.push(overlay); },
    launch: (_api, _context, input) => { if (options.launchThrows) throw new Error("launch probe failure"); let resolve!: (job: JobMeta) => void; const completion = new Promise<JobMeta>((done) => { resolve = done; });
      const running = job(input.record.jobId, "running"); const handle: ManagedAsyncJobHandle = { jobId: input.record.jobId, completion, snapshot: () => running, cancel: () => resolve(job(input.record.jobId, "cancelled")) }; launches.push({ ...input, resolve, handle }); return handle; }
  });
  for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
  const call = async (name: string, params: any) => { const tool = tools.find((candidate) => candidate.name === name)!; return tool.execute!("test", params, new AbortController().signal, undefined, context); };
  const event = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, context); };
  const registry = () => openWorkerRegistry(runtimeRoot);
  return { root, runtimeRoot, workersRoot, session, tools, handlers, messages, launches, removed, overlays, cleaned, context, call, event, registry, async close() { try { await event("session_shutdown"); } catch {} rmSync(root, { recursive: true, force: true }); } };
}

function job(jobId: string, status: JobMeta["status"], exitCode = status === "exited" ? 0 : undefined): JobMeta { return { jobId, command: "worker", cwd: "/tmp", status, durationMs: 1, exitCode, signal: null, notifyOnExit: false, completionNotified: true, logDir: "/tmp", stdoutLog: `/tmp/${jobId}.out`, stderrLog: `/tmp/${jobId}.err`, outputBytes: { stdout: 0, stderr: 0 } } as JobMeta; }
function receipt(result: any) { return result.details.runs[0] as { workerId: string; runId: string; role: string }; }
async function waitFor(check: () => boolean, timeout = 3_000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); } }
async function complete(f: Fixture, item: { workerId: string; runId: string }, result: any = { outcome: "completed", summary: "done" }) {
  const launch = f.launches.find((value) => value.record.workerId === item.workerId && value.record.runId === item.runId)!;
  const db = f.registry(); const worker = getWorker(db, item.workerId)!; const currentRun = getWorkerRun(db, item.workerId, item.runId); db.close();
  if (!worker.sessionFile) throw new Error(`worker session missing: ${JSON.stringify({ worker, run: currentRun })}`);
  writeFileSync(worker.sessionFile, `${JSON.stringify({ type: "message", id: `result-${item.runId}`, parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [] } })}\n`, { flag: "a" });
  writeFileSync(launch.runtime.resultFile, `${JSON.stringify({ version: 2, workerId: item.workerId, runId: item.runId, acceptedAt: new Date().toISOString(), result }, null, 2)}\n`);
  writeFileSync(launch.runtime.settledFile, `${JSON.stringify({ version: 1, workerId: item.workerId, runId: item.runId, sessionId: worker.sessionId, resultFile: launch.runtime.resultFile, settledAt: new Date().toISOString() }, null, 2)}\n`);
  launch.resolve(job(launch.record.jobId, "exited", 0));
  await waitFor(() => { const side = f.registry(); const run = getWorkerRun(side, item.workerId, item.runId); side.close(); return run?.status === "settled"; });
}

test("queued cancellation system-settles once, never launches, then discards without a phantom row", async () => {
  const f = await fixture(); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "probe" }] }));
    const cancelled = await f.call("worker_control", { action: "cancel", workerId: started.workerId });
    assert.equal((cancelled.details as any).cancellation, "cancelled"); await f.event("turn_end"); assert.equal(f.launches.length, 0);
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; assert.equal(run.outcome, "cancelled"); assert.equal(run.outcomeSource, "system"); assert.equal(getWorker(db, started.workerId)!.status, "idle"); db.close();
    assert.equal(f.messages.filter((message) => message.details?.event === "worker_settled").length, 1);
    await f.call("worker_control", { action: "discard", workerId: started.workerId }); const after = f.registry(); assert.equal(getWorker(after, started.workerId), undefined); after.close(); assert.equal(existsSync(path.join(f.workersRoot, started.workerId)), false);
  } finally { await f.close(); }
});

test("cancelling an initial queued work run preserves its exact fork for resume", async () => {
  const f = await fixture(); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "probe" }] }));
    await f.call("worker_control", { action: "cancel", workerId: started.workerId });
    let db = f.registry(); const worker = getWorker(db, started.workerId)!; assert.ok(worker.sessionId); assert.ok(worker.sessionFile); const header = JSON.parse(readFileSync(worker.sessionFile!, "utf8").split("\n")[0]!); assert.equal(header.parentSession, path.resolve(f.session.getSessionFile()!)); db.close();
    const resumed = receipt(await f.call("worker_run", { runs: [{ action: "resume", workerId: started.workerId, instructions: "continue" }] }));
    assert.equal(resumed.workerId, started.workerId); await f.call("worker_control", { action: "cancel", workerId: resumed.workerId });
    db = f.registry(); assert.equal(getWorkerRun(db, resumed.workerId, resumed.runId)!.outcome, "cancelled"); db.close();
  } finally { await f.close(); }
});

test("later batch validation failure rolls back earlier containers, workspaces, and registry visibility", async () => {
  const f = await fixture(); try {
    await assert.rejects(() => f.call("worker_run", { runs: [
      { action: "start", role: "work", taskIds: ["personal-a"], instructions: "first" },
      { action: "start", role: "review", reviewedRunId: "run_20260101000000_deadbeef" }
    ] }), /Unknown reviewed run/);
    const db = f.registry(); assert.equal(listWorkers(db, { parentSessionFile: path.resolve(f.session.getSessionFile()!) }).total, 0); db.close();
    assert.equal(f.removed.length, 1); assert.deepEqual(existsSync(f.workersRoot) ? readDirs(f.workersRoot) : [], []);
    await f.event("turn_end"); assert.equal(f.launches.length, 0);
  } finally { await f.close(); }
});

test("deferred launch failure system-settles instead of leaving a queued run", async () => {
  const f = await fixture({ launchThrows: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "probe" }] }));
    await f.event("turn_end"); const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; assert.equal(run.status, "settled"); assert.equal(run.outcome, "failed"); assert.equal(getWorker(db, started.workerId)!.status, "idle"); db.close(); assert.equal(f.removed.length, 1);
  } finally { await f.close(); }
});

test("completion finalizes SQLite and leaves pending delivery even after parent runtime shutdown", async () => {
  const f = await fixture(); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "probe" }] })); await f.event("turn_end");
    await f.event("session_shutdown"); await complete(f, started);
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; assert.equal(run.status, "settled"); assert.equal(run.outcomeSource, "worker"); const pending = db.database.prepare("SELECT state FROM deliveries WHERE run_id=?").get(started.runId) as any; assert.equal(pending.state, "pending"); db.close();
  } finally { await f.close(); }
});

test("failed review overlay preflight leaves no reviewer and no subject lease", async () => {
  const f = await fixture({ overlayThrows: true }); try {
    const subject = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] })); await f.event("turn_end"); await complete(f, subject);
    await assert.rejects(() => f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId }] }), /overlay probe failure/);
    const db = f.registry(); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, undefined); assert.equal(listWorkers(db, { parentSessionFile: path.resolve(f.session.getSessionFile()!), role: "review" }).total, 0); db.close();
  } finally { await f.close(); }
});

test("review starts fresh, mounts exact subject session range, cancellation releases lease, and resume recreates it", async () => {
  const f = await fixture(); try {
    const subject = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] })); await f.event("turn_end"); await complete(f, subject);
    const extra = path.join(f.root, "spec.txt"); writeFileSync(extra, "spec\n");
    const review = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId, additionalInputs: [extra] }] }));
    let db = f.registry(); const reviewer = getWorker(db, review.workerId)!; const subjectRow = getWorker(db, subject.workerId)!; assert.equal(subjectRow.reviewedByWorkerId, review.workerId); const run = getWorkerRun(db, review.workerId, review.runId)!; const runtime = run.runtime as any;
    const header = JSON.parse(readFileSync(reviewer.sessionFile!, "utf8").split("\n")[0]!); assert.equal(header.parentSession, undefined);
    assert.equal(runtime.container.mounts.some((mount: any) => mount.target === "/review/session.jsonl" && mount.readOnly), true);
    const context = JSON.parse(readFileSync(runtime.contextFile, "utf8")); const subjectRun = getWorkerRun(db, subject.workerId, subject.runId)!; assert.deepEqual(context.session.range, { startLine: subjectRun.sessionStartLine, endLine: subjectRun.sessionEndLine }); db.close();
    await f.call("worker_control", { action: "cancel", workerId: review.workerId }); db = f.registry(); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, undefined); db.close();
    const resumed = receipt(await f.call("worker_run", { runs: [{ action: "resume", workerId: review.workerId, instructions: "continue" }] })); db = f.registry(); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, review.workerId); const resumedRuntime = getWorkerRun(db, review.workerId, resumed.runId)!.runtime as any; assert.notEqual(resumedRuntime.overlay.mergedVolume, runtime.overlay.mergedVolume); assert.equal((getWorker(db, review.workerId)!.runtime?.inputs as any[]).length, 1); db.close();
  } finally { await f.close(); }
});


test("integration starts in a fresh session, receives full conflict context, and resume preserves repositories and prior inputs", async () => {
  const f = await fixture(); try {
    const target = path.join(f.root, "targets", "repo"); const candidate = path.join(f.root, "candidate"); mkdirSync(path.dirname(target), { recursive: true });
    gitInit(target); writeFileSync(path.join(target, "shared.txt"), "base\n"); git(target, "add", "."); git(target, "commit", "-m", "base");
    execFileSync("git", ["clone", "--no-hardlinks", target, candidate], { stdio: "ignore" }); git(candidate, "config", "user.name", "Test"); git(candidate, "config", "user.email", "test@example.invalid"); writeFileSync(path.join(candidate, "shared.txt"), "candidate\n"); git(candidate, "add", "."); git(candidate, "commit", "-m", "candidate");
    writeFileSync(path.join(target, "shared.txt"), "target\n"); git(target, "add", "."); git(target, "commit", "-m", "target");
    const parent = path.resolve(f.session.getSessionFile()!); const prepared = prepareWorkerMerges(parent, [{ id: `candidate_${"a".repeat(24)}`, candidateRepo: candidate, targetRepo: target, targetRef: "refs/heads/main", method: "merge", commitMessage: "merge", dependsOn: [] }], { preparedRoot: path.join(f.runtimeRoot, "prepared"), targetRoot: f.root, randomHex: () => "b".repeat(24) });
    assert.equal(prepared.status, "resolution_required"); const db0 = f.registry(); storePreparedSet(db0, { preparedId: prepared.preparedId, parentSessionFile: parent, status: prepared.status, order: prepared.order, repositories: prepared.repositories, createdAt: prepared.createdAt }); db0.close();
    const input = path.join(f.root, "decision.txt"); writeFileSync(input, "decision\n");
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "integration", preparedId: prepared.preparedId, taskIds: ["personal-test"], additionalInputs: [input] }] }));
    let db = f.registry(); let worker = getWorker(db, started.workerId)!; let run = getWorkerRun(db, started.workerId, started.runId)!; let runtime = run.runtime as any;
    const header = JSON.parse(readFileSync(worker.sessionFile!, "utf8").split("\n")[0]!); assert.equal(header.parentSession, undefined);
    const context = JSON.parse(readFileSync(runtime.contextFile, "utf8")); assert.equal(context.repositories[0].conflicts.length, 1); assert.equal(context.repositories[0].mergeBase.length >= 40, true);
    const movedRepo = path.join(worker.workspaceRoot, context.repositories[0].path); assert.equal(existsSync(movedRepo), true); assert.equal(runtime.container.mounts.some((mount: any) => mount.target === "/integration/context.json" && mount.readOnly), true); db.close();
    await f.call("worker_control", { action: "cancel", workerId: started.workerId });
    const extra = path.join(f.root, "extra.txt"); writeFileSync(extra, "extra\n"); const resumed = receipt(await f.call("worker_run", { runs: [{ action: "resume", workerId: started.workerId, instructions: "continue", additionalInputs: [extra] }] }));
    db = f.registry(); worker = getWorker(db, resumed.workerId)!; run = getWorkerRun(db, resumed.workerId, resumed.runId)!; runtime = run.runtime as any; const updated = JSON.parse(readFileSync(runtime.contextFile, "utf8"));
    assert.equal(updated.additionalInputs.length, 2); assert.equal(existsSync(movedRepo), true); assert.equal(runtime.container.mounts.some((mount: any) => mount.target === "/integration/context.json"), true); assert.equal((worker.runtime?.inputs as any[]).length, 2); db.close();
  } finally { await f.close(); }
});

function gitInit(repo: string): void { mkdirSync(repo, { recursive: true }); execFileSync("git", ["init", "-q", "-b", "main", repo]); git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.invalid"); }
function git(repo: string, ...args: string[]): string { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim(); }
function readDirs(root: string): string[] { return readdirSync(root).filter((name) => !name.startsWith(".")); }
