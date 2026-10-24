import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

async function fixture(options: { launchThrows?: boolean; overlayThrows?: boolean; removeThrowsOnce?: boolean; removeAlwaysThrows?: boolean; deferContainer?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-v2-lifecycle-"));
  const runtimeRoot = path.join(root, "runtime"); const workersRoot = path.join(runtimeRoot, "workers"); mkdirSync(workersRoot, { recursive: true });
  const session = SessionManager.create(root, path.join(root, "parent-session"), { id: `parent-${Date.now()}` }); writeFileSync(session.getSessionFile()!, `${JSON.stringify(session.getHeader())}\n`, { mode: 0o600 });
  const tools: ToolDefinition[] = []; const handlers = new Map<string, Function[]>(); const commands = new Map<string, any>(); const renderers = new Map<string, Function>(); const messages: any[] = []; const notifications: string[] = [];
  const launches: Launch[] = []; const created: string[] = []; const removed: string[] = []; const overlays: ReviewOverlayRecord[] = []; const cleaned: ReviewOverlayRecord[] = [];
  let releaseContainer = () => {}; const containerGate = options.deferContainer ? new Promise<void>((resolve) => { releaseContainer = resolve; }) : undefined; let removeFailures = 0; let counter = 0; const random = () => `${(++counter).toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const api = { registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer(name: string, renderer: Function) { renderers.set(name, renderer); }, on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, sendMessage(message: any) { messages.push(message); } } as unknown as ExtensionAPI;
  const context = { cwd: root, hasUI: false, mode: "rpc", sessionManager: session, modelRegistry: { hasConfiguredAuth: () => true, getAll: () => [model("openai-codex", "gpt-5.6-sol"), model("anthropic", "claude-opus-5-5")] }, thinkingLevel: "xhigh", isIdle: () => true, hasPendingMessages: () => false, ui: { notify(message: string) { notifications.push(message); } } } as unknown as ExtensionContext;
  registerWorkerExtension(api, {
    runtimeRoot, roots: { stateRoot: workersRoot, workspaceRoot: workersRoot }, codeRoot: root, preparedRoot: path.join(runtimeRoot, "prepared"), targetRoot: root, dockerPath: "/fake/docker", random, now: () => new Date(`2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`),
    waitForHostIdentity: async () => {},
    createContainer: async (_docker, reference) => { created.push(reference.runId); if (containerGate) await containerGate; return { ...reference, containerId: (++counter).toString(16).padStart(64, "0") }; }, removeContainer: (_docker, reference) => { removed.push(reference.runId); if (options.removeAlwaysThrows || options.removeThrowsOnce && removeFailures++ === 0) throw new Error(options.removeAlwaysThrows ? "persistent container cleanup failure" : "transient container cleanup failure"); },
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
  const registry = () => openWorkerRegistry(runtimeRoot);
  const event = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, context); if (name === "turn_end") await waitFor(() => { const db = registry(); const queued = Number((db.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE status='queued'").get() as any).count); db.close(); return queued === 0; }); };
  return { root, runtimeRoot, workersRoot, session, tools, handlers, commands, renderers, messages, notifications, launches, releaseContainer, created, removed, overlays, cleaned, context, call, event, registry, async close() { try { await event("session_shutdown"); } catch {} rmSync(root, { recursive: true, force: true }); } };
}

function job(jobId: string, status: JobMeta["status"], exitCode = status === "exited" ? 0 : undefined): JobMeta { return { jobId, command: "worker", cwd: "/tmp", status, durationMs: 1, exitCode, signal: null, notifyOnExit: false, completionNotified: true, logDir: "/tmp", stdoutLog: `/tmp/${jobId}.out`, stderrLog: `/tmp/${jobId}.err`, outputBytes: { stdout: 0, stderr: 0 } } as JobMeta; }
function receipt(result: any) { return result.details.runs[0] as { workerId: string; runId: string; role: string }; }
async function waitFor(check: () => boolean, timeout = 3_000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); } }
function writeCompletionEvidence(f: Fixture, item: { workerId: string; runId: string }, result: any): Launch {
  const launch = f.launches.find((value) => value.record.workerId === item.workerId && value.record.runId === item.runId)!;
  const db = f.registry(); const worker = getWorker(db, item.workerId)!; const currentRun = getWorkerRun(db, item.workerId, item.runId); db.close();
  if (!worker.sessionFile) throw new Error(`worker session missing: ${JSON.stringify({ worker, run: currentRun })}`);
  writeFileSync(worker.sessionFile, `${JSON.stringify({ type: "message", id: `result-${item.runId}`, parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [] } })}\n`, { flag: "a" });
  writeFileSync(launch.runtime.resultFile, `${JSON.stringify({ version: 2, workerId: item.workerId, runId: item.runId, acceptedAt: new Date().toISOString(), result }, null, 2)}\n`);
  writeFileSync(launch.runtime.settledFile, `${JSON.stringify({ version: 1, workerId: item.workerId, runId: item.runId, sessionId: worker.sessionId, resultFile: launch.runtime.resultFile, settledAt: new Date().toISOString() }, null, 2)}\n`);
  return launch;
}

async function complete(f: Fixture, item: { workerId: string; runId: string }, result: any = { outcome: "completed", summary: "done" }) {
  const launch = writeCompletionEvidence(f, item, result);
  launch.resolve(job(launch.record.jobId, "exited", 0));
  await waitFor(() => { const side = f.registry(); const run = getWorkerRun(side, item.workerId, item.runId); side.close(); return run?.status === "settled"; });
}

test("worker_run returns complete provider-visible identities and defers Docker creation until turn_end", async () => {
  const f = await fixture(); try {
    const result = await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "probe" }] });
    assert.equal(f.created.length, 0); assert.equal(f.launches.length, 0);
    const visible: any = JSON.parse((result.content[0] as any).text);
    assert.match(visible.runs[0].workerId, /^worker_/); assert.match(visible.runs[0].runId, /^run_/); assert.deepEqual(visible, result.details);
    writeFileSync(f.session.getSessionFile()!, `${JSON.stringify({ type: "message", id: "completed-parent-turn", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "PARENT_TURN_DURABLE" }] } })}\n`, { flag: "a" });
    await f.event("turn_end"); assert.equal(f.created.length, 1); assert.equal(f.launches.length, 1); assert.equal(f.launches[0]!.record.cacheLineage?.mode, "fresh");
    const db = f.registry(); const worker = getWorker(db, (visible as any).runs[0].workerId)!; assert.match(readFileSync(worker.sessionFile!, "utf8"), /PARENT_TURN_DURABLE/); db.close();
  } finally { await f.close(); }
});


test("worker:view handler enforces parent and worker/run ownership without mutation or delivery", async () => {
  const f = await fixture(); try {
    const first = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-first"], instructions: "first" }] }));
    const second = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-second"], instructions: "second" }] }));
    await f.event("turn_end");
    const command = f.commands.get("worker:view")!;
    const beforeMessages = f.messages.length;
    const before = (() => { const db = f.registry(); const rows = db.database.prepare("SELECT worker_id,status,active_run_id,latest_run_id,version FROM workers ORDER BY worker_id").all(); db.close(); return JSON.stringify(rows); })();

    await command.handler(`${first.workerId} ${second.runId}`, f.context);
    assert.match(f.notifications.at(-1) ?? "", /no matching retained run/i);
    await command.handler(first.workerId, f.context);
    assert.match(f.notifications.at(-1) ?? "", /requires interactive Pi TUI mode/);

    const foreignSession = path.join(f.root, "foreign-parent.jsonl"); writeFileSync(foreignSession, "\n");
    const foreign = { ...f.context, sessionManager: { getSessionFile: () => foreignSession, getSessionId: () => "foreign" } } as unknown as ExtensionContext;
    await command.handler(first.workerId, foreign);
    assert.match(f.notifications.at(-1) ?? "", /Unknown worker.*parent session/);
    assert.equal(f.messages.length, beforeMessages, "view must not emit or acknowledge delivery messages");
    const after = (() => { const db = f.registry(); const rows = db.database.prepare("SELECT worker_id,status,active_run_id,latest_run_id,version FROM workers ORDER BY worker_id").all(); db.close(); return JSON.stringify(rows); })();
    assert.equal(after, before, "view must not mutate worker lifecycle state");
  } finally { await f.close(); }
});

test("turn_end returns without awaiting deferred container readiness", async () => {
  const f = await fixture({ deferContainer: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "async launch" }] }));
    const handler = f.handlers.get("turn_end")![0]!; const returned = handler({}, f.context); assert.equal(returned, undefined);
    let db = f.registry(); assert.equal(getWorker(db, started.workerId)!.sessionFile, undefined, "session fork must be deferred beyond the event handler"); db.close();
    await waitFor(() => f.created.length === 1); assert.equal(f.launches.length, 0);
    db = f.registry(); assert.equal(getWorkerRun(db, started.workerId, started.runId)!.status, "queued"); db.close();
    f.releaseContainer(); await waitFor(() => f.launches.length === 1); db = f.registry(); await waitFor(() => { const current = getWorkerRun(db, started.workerId, started.runId); return current?.status === "running"; }); db.close();
    await f.call("worker_control", { action: "cancel", workerId: started.workerId });
  } finally { f.releaseContainer(); await f.close(); }
});


test("cancellation waits for a deferred launch boundary before proving termination", async () => {
  const f = await fixture({ deferContainer: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "cancel during readiness" }] }));
    const handler = f.handlers.get("turn_end")![0]!; handler({}, f.context); await waitFor(() => f.created.length === 1);
    let resolved = false; const cancelling = f.call("worker_control", { action: "cancel", workerId: started.workerId }).then((value) => { resolved = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(resolved, false); f.releaseContainer(); await cancelling;
    const db = f.registry(); const worker = getWorker(db, started.workerId)!; const run = getWorkerRun(db, started.workerId, started.runId)!; db.close();
    assert.equal(worker.status, "idle"); assert.equal(run.outcome, "cancelled"); assert.equal(f.launches.length, 0);
  } finally { f.releaseContainer(); await f.close(); }
});

test("worker_control get content exposes complete settled candidates and artifact paths", async () => {
  const f = await fixture(); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "produce candidate" }] })); await f.event("turn_end");
    const db = f.registry(); const workspace = getWorker(db, started.workerId)!.workspaceRoot; db.close();
    const repo = path.join(workspace, "repos", "project"); gitInit(repo); git(repo, "remote", "add", "origin", "https://example.invalid/project.git"); writeFileSync(path.join(repo, "result.txt"), "result\n"); git(repo, "add", "."); git(repo, "commit", "-m", "result");
    mkdirSync(path.join(workspace, "artifacts"), { recursive: true }); writeFileSync(path.join(workspace, "artifacts", "report.txt"), "report\n");
    await complete(f, started, { outcome: "completed", summary: "Candidate ready.", repositories: ["repos/project"], artifacts: ["artifacts/report.txt"] });
    const result = await f.call("worker_control", { action: "get", workerId: started.workerId, runId: started.runId }); const visible: any = JSON.parse((result.content[0] as any).text);
    assert.equal(visible.summary, "Candidate ready."); assert.equal(visible.artifacts[0], "artifacts/report.txt"); assert.equal(visible.repositories[0].repositoryPath, repo); assert.equal("candidateId" in visible.repositories[0], false); assert.equal("path" in visible.repositories[0], false); assert.equal(visible.repositories[0].source, "https://example.invalid/project.git"); assert.equal(visible.repositories[0].reported, true); assert.equal(visible.repositories[0].changed, true); assert.equal(visible.repositories[0].dirty, false); assert.equal(visible.repositories[0].eligible, true); assert.match(visible.repositories[0].commit, /^[a-f0-9]{40}$/); assert.deepEqual(visible, result.details);
  } finally { await f.close(); }
});

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

test("cancelling an initial queued work run defers its exact fork until a resumed turn", async () => {
  const f = await fixture(); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "probe" }] }));
    await f.call("worker_control", { action: "cancel", workerId: started.workerId });
    let db = f.registry(); let worker = getWorker(db, started.workerId)!; assert.equal(worker.sessionId, undefined); assert.equal(worker.sessionFile, undefined); db.close();
    const resumed = receipt(await f.call("worker_run", { runs: [{ action: "resume", workerId: started.workerId, instructions: "continue" }] }));
    assert.equal(resumed.workerId, started.workerId); await f.event("turn_end"); db = f.registry(); worker = getWorker(db, resumed.workerId)!; const header = JSON.parse(readFileSync(worker.sessionFile!, "utf8").split("\n")[0]!); assert.equal(realpathSync(header.parentSession), realpathSync(f.session.getSessionFile()!)); db.close();
    await f.call("worker_control", { action: "cancel", workerId: resumed.workerId }); db = f.registry(); assert.equal(getWorkerRun(db, resumed.workerId, resumed.runId)!.outcome, "cancelled"); db.close();
  } finally { await f.close(); }
});

test("later batch validation failure rolls back earlier containers, workspaces, and registry visibility", async () => {
  const f = await fixture(); try {
    await assert.rejects(() => f.call("worker_run", { runs: [
      { action: "start", role: "work", taskIds: ["personal-a"], instructions: "first" },
      { action: "start", role: "review", reviewedRunId: "run_20260101000000_deadbeef" }
    ] }), /Unknown reviewed run/);
    const db = f.registry(); assert.equal(listWorkers(db, { parentSessionFile: path.resolve(f.session.getSessionFile()!) }).total, 0); db.close();
    assert.equal(f.removed.length, 0); assert.deepEqual(existsSync(f.workersRoot) ? readDirs(f.workersRoot) : [], []);
    await f.event("turn_end"); assert.equal(f.launches.length, 0);
  } finally { await f.close(); }
});

test("deferred launch failure system-settles instead of leaving a queued run", async () => {
  const f = await fixture({ launchThrows: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "probe" }] }));
    await f.event("turn_end"); const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; assert.equal(run.status, "settled"); assert.equal(run.outcome, "failed"); assert.equal(getWorker(db, started.workerId)!.status, "idle"); db.close(); assert.equal(f.removed.length, 1);
  } finally { await f.close(); }
});

test("a new parent runtime adopts exact settlement after the launching runtime shuts down", async () => {
  const f = await fixture();
  const secondHandlers = new Map<string, Function[]>();
  const secondMessages: any[] = [];
  try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "probe" }] })); await f.event("turn_end");
    await f.event("session_shutdown");
    const detachedLaunch = writeCompletionEvidence(f, started, { outcome: "completed", summary: "detached completion" });

    let relaunches = 0;
    const secondApi = {
      registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, sendMessage(message: any) { secondMessages.push(message); },
      on(name: string, handler: Function) { secondHandlers.set(name, [...(secondHandlers.get(name) ?? []), handler]); }
    } as unknown as ExtensionAPI;
    registerWorkerExtension(secondApi, {
      runtimeRoot: f.runtimeRoot,
      roots: { stateRoot: f.workersRoot, workspaceRoot: f.workersRoot },
      codeRoot: f.root,
      preparedRoot: path.join(f.runtimeRoot, "prepared"),
      targetRoot: f.root,
      dockerPath: "/fake/docker",
      createContainer: async () => { throw new Error("settled detached work must not create a container"); },
      removeContainer: async () => {},
      createOverlay: async () => { throw new Error("settled detached work must not create an overlay"); },
      cleanupOverlay: async () => {},
      waitForHostIdentity: async () => {},
      launch: () => { relaunches += 1; throw new Error("settled detached work must not relaunch"); }
    });
    for (const handler of secondHandlers.get("session_start") ?? []) await handler({}, f.context);
    await waitFor(() => { const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId); db.close(); return run?.status === "settled"; });

    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!;
    assert.equal(run.outcomeSource, "worker"); assert.equal(run.summary, "detached completion"); assert.equal(relaunches, 0);
    const delivery = db.database.prepare("SELECT state FROM deliveries WHERE run_id=?").get(started.runId) as any; assert.equal(delivery.state, "claimed"); db.close();
    assert.equal(secondMessages.filter((message) => message.details?.event === "worker_settled").length, 1);
    detachedLaunch.resolve(job(detachedLaunch.record.jobId, "exited", 0));
  } finally {
    for (const handler of secondHandlers.get("session_shutdown") ?? []) await handler({}, f.context);
    await f.close();
  }
});

test("truncated and non-regular sessions become bounded settlement evidence", async () => {
  for (const damage of ["truncated", "non-regular"] as const) {
    const f = await fixture();
    try {
      const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: `settle with ${damage} session` }] }));
      await f.event("turn_end");
      const launch = writeCompletionEvidence(f, started, { outcome: "completed", summary: `${damage} retained result` });
      const db = f.registry(); const sessionFile = getWorker(db, started.workerId)!.sessionFile!; db.close();
      if (damage === "truncated") writeFileSync(sessionFile, "");
      else { rmSync(sessionFile); mkdirSync(sessionFile); }
      launch.resolve(job(launch.record.jobId, "exited", 0));
      await waitFor(() => { const side = f.registry(); const run = getWorkerRun(side, started.workerId, started.runId); side.close(); return run?.status === "settled"; });
      const after = f.registry(); const run = getWorkerRun(after, started.workerId, started.runId)!; after.close();
      assert.equal(run.outcome, "completed"); assert.equal(run.outcomeSource, "worker"); assert.equal(run.sessionEndLine, undefined);
      assert.match(run.errors.map((error) => error.message).join(" "), damage === "truncated" ? /truncated below retained line/i : /not a regular file/i);
    } finally { await f.close(); }
  }
});

test("missing session settlement is best-effort and repeated reconciliation never leaks an async rejection", async () => {
  const f = await fixture();
  const runtimes: Array<{ handlers: Map<string, Function[]> }> = [];
  try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "settle after session damage" }] }));
    await f.event("turn_end"); await f.event("session_shutdown");
    const detached = writeCompletionEvidence(f, started, { outcome: "completed", summary: "retained despite missing session" });
    const before = f.registry(); const sessionFile = getWorker(before, started.workerId)!.sessionFile!; before.close(); rmSync(sessionFile);

    for (let restart = 0; restart < 3; restart += 1) {
      const handlers = new Map<string, Function[]>(); const api = {
        registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, sendMessage() {},
        on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }
      } as unknown as ExtensionAPI;
      registerWorkerExtension(api, {
        runtimeRoot: f.runtimeRoot, roots: { stateRoot: f.workersRoot, workspaceRoot: f.workersRoot }, codeRoot: f.root,
        preparedRoot: path.join(f.runtimeRoot, "prepared"), targetRoot: f.root, dockerPath: "/fake/docker",
        createContainer: async () => { throw new Error("settled run must not relaunch"); }, removeContainer: async () => {},
        createOverlay: async () => { throw new Error("settled run must not create an overlay"); }, cleanupOverlay: async () => {},
        waitForHostIdentity: async () => {}, launch: () => { throw new Error("settled run must not relaunch"); }
      });
      runtimes.push({ handlers });
      for (const handler of handlers.get("session_start") ?? []) assert.equal(handler({}, f.context), undefined);
      await waitFor(() => { const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId); db.close(); return run?.status === "settled"; });
    }
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; db.close();
    assert.equal(run.outcome, "completed"); assert.equal(run.outcomeSource, "worker"); assert.equal(run.sessionEndLine, undefined);
    assert.match(run.errors.map((error) => error.message).join(" "), /session end line could not be recorded safely.*unavailable/i);
    detached.resolve(job(detached.record.jobId, "exited", 0));
  } finally {
    for (const runtime of runtimes) for (const handler of runtime.handlers.get("session_shutdown") ?? []) await handler({}, f.context);
    await f.close();
  }
});

test("failed deferred review overlay setup system-settles and releases the subject lease", async () => {
  const f = await fixture({ overlayThrows: true }); try {
    const subject = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] })); await f.event("turn_end"); await complete(f, subject);
    const review = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId }] }));
    assert.equal(f.overlays.length, 0); await f.event("turn_end");
    const db = f.registry(); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, undefined); assert.equal(getWorkerRun(db, review.workerId, review.runId)!.outcome, "failed"); db.close();
  } finally { await f.close(); }
});

test("review starts fresh, mounts exact subject session range, cancellation releases lease, and resume recreates it", async () => {
  const f = await fixture(); try {
    const subject = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] })); await f.event("turn_end"); await complete(f, subject);
    const extra = path.join(f.root, "spec.txt"); writeFileSync(extra, "spec\n");
    const review = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId, additionalInputs: [extra] }] }));
    assert.equal(f.overlays.length, 0); await f.event("turn_end");
    let db = f.registry(); const reviewer = getWorker(db, review.workerId)!; const subjectRow = getWorker(db, subject.workerId)!; assert.equal(subjectRow.reviewedByWorkerId, review.workerId); const run = getWorkerRun(db, review.workerId, review.runId)!; const runtime = run.runtime as any;
    const header = JSON.parse(readFileSync(reviewer.sessionFile!, "utf8").split("\n")[0]!); assert.equal(header.parentSession, undefined);
    assert.equal(runtime.container.mounts.some((mount: any) => mount.target === "/review/session.jsonl" && mount.readOnly), true);
    const context = JSON.parse(readFileSync(runtime.contextFile, "utf8")); const subjectRun = getWorkerRun(db, subject.workerId, subject.runId)!; assert.deepEqual(context.session.range, { startLine: subjectRun.sessionStartLine, endLine: subjectRun.sessionEndLine }); assert.match(runtime.contextFile, new RegExp(review.runId)); db.close();
    await f.call("worker_control", { action: "cancel", workerId: review.workerId }); db = f.registry(); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, undefined); db.close();
    const resumed = receipt(await f.call("worker_run", { runs: [{ action: "resume", workerId: review.workerId, instructions: "continue" }] })); await f.event("turn_end"); db = f.registry(); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, review.workerId); const resumedRuntime = getWorkerRun(db, review.workerId, resumed.runId)!.runtime as any; assert.notEqual(resumedRuntime.overlay.mergedVolume, runtime.overlay.mergedVolume); assert.equal((getWorker(db, review.workerId)!.runtime?.inputs as any[]).length, 1); db.close();
    await f.call("worker_control", { action: "cancel", workerId: review.workerId }); await f.call("worker_control", { action: "discard", workerId: review.workerId }); db = f.registry(); assert.equal(getWorker(db, review.workerId), undefined); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, undefined); db.close();
  } finally { await f.close(); }
});


test("historical managed commits remain usable through Git-native candidate inputs", async () => {
  const f = await fixture(); try {
    const first = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "candidate" }] })); await f.event("turn_end");
    let db = f.registry(); const workspace = getWorker(db, first.workerId)!.workspaceRoot; db.close(); const repo = path.join(workspace, "repos", "project"); gitInit(repo); writeFileSync(path.join(repo, "one.txt"), "one\n"); git(repo, "add", "."); git(repo, "commit", "-m", "one");
    await complete(f, first, { outcome: "completed", summary: "first", repositories: ["repos/project"] });
    const firstGet: any = (await f.call("worker_control", { action: "get", workerId: first.workerId, runId: first.runId })).details; const candidate = firstGet.repositories[0];
    const target = path.join(f.root, "targets", "historical"); mkdirSync(path.dirname(target), { recursive: true }); execFileSync("git", ["clone", "-q", "--no-hardlinks", repo, target]);
    const second = receipt(await f.call("worker_run", { runs: [{ action: "resume", workerId: first.workerId, instructions: "newer candidate" }] })); await f.event("turn_end"); writeFileSync(path.join(repo, "two.txt"), "two\n"); git(repo, "add", "."); git(repo, "commit", "-m", "two"); await complete(f, second, { outcome: "completed", summary: "second", repositories: ["repos/project"] });
    await assert.rejects(f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: first.runId }] }), /latest completed run/);
    const merged = await f.call("worker_merge_test", { repositories: [{ id: "historical", candidateRepo: candidate.repositoryPath, candidateRef: candidate.commit, targetRepo: target, targetRef: "refs/heads/main", method: "merge", commitMessage: "historical" }] }); const visible: any = JSON.parse((merged.content[0] as any).text);
    assert.match(visible.repositories[0].warnings.join(" "), /historical run/); assert.equal(visible.repositories[0].source.runId, first.runId);
    writeFileSync(path.join(f.runtimeRoot, "prepared", visible.preparedId, "prepared.json"), JSON.stringify({ version: 1, preparedId: visible.preparedId, parentSessionFile: "/tampered", status: "resolution_required", order: [], repositories: [] }));
    const applied = await f.call("worker_merge_apply", { preparedId: visible.preparedId }); const applyVisible: any = JSON.parse((applied.content[0] as any).text); assert.equal(applyVisible.status, "completed"); assert.equal(applyVisible.repositories[0].id, "historical");
  } finally { await f.close(); }
});

test("review needs_input retains its exact subject lease and the same reviewer can resume", async () => {
  const f = await fixture(); try {
    const subject = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] })); await f.event("turn_end"); await complete(f, subject);
    const review = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId }] })); await f.event("turn_end");
    await complete(f, review, { outcome: "needs_input", summary: "Need a decision.", question: "Which policy?" });
    let db = f.registry(); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, review.workerId); db.close();
    const resumed = receipt(await f.call("worker_run", { runs: [{ action: "resume", workerId: review.workerId, instructions: "Use policy A." }] }));
    assert.equal(resumed.workerId, review.workerId); db = f.registry(); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, review.workerId); db.close();
    await f.call("worker_control", { action: "cancel", workerId: review.workerId });
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
    writeFileSync(path.join(f.runtimeRoot, "prepared", prepared.preparedId, "prepared.json"), JSON.stringify({ ...prepared, parentSessionFile: "/tampered", repositories: [] }));
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
    await f.call("worker_control", { action: "cancel", workerId: resumed.workerId }); await f.call("worker_control", { action: "discard", workerId: resumed.workerId }); db = f.registry(); assert.equal(getWorker(db, resumed.workerId), undefined); const retainedPrepared = db.database.prepare("SELECT prepared_id FROM prepared_sets WHERE prepared_id=?").get(prepared.preparedId); assert.equal(retainedPrepared, undefined); db.close();
  } finally { await f.close(); }
});


test("completion notification uses only the approved compact settlement grammar", async () => {
  const f = await fixture(); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "settle" }] })); await f.event("turn_end"); await complete(f, started);
    const message = [...f.messages].reverse().find((value: any) => value.details?.event === "worker_settled"); assert.ok(message);
    const visible = JSON.parse(message.content); assert.deepEqual(Object.keys(visible).sort(), ["artifactCount", "event", "outcome", "outcomeSource", "repositoryCount", "role", "runId", "summary", "workerId"].sort());
    assert.equal(visible.workspaceRoot, undefined); assert.equal(visible.repositories, undefined); assert.equal(visible.stdoutLog, undefined);
  } finally { await f.close(); }
});

test("attached running cancellation uses the exact lifecycle claim and returns the worker idle", async () => {
  const f = await fixture(); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "run" }] })); await f.event("turn_end");
    const cancelled = await f.call("worker_control", { action: "cancel", workerId: started.workerId }); assert.equal((cancelled.details as any).cancellation, "cancelled");
    const db = f.registry(); assert.equal(getWorker(db, started.workerId)!.status, "idle"); assert.equal(getWorkerRun(db, started.workerId, started.runId)!.outcome, "cancelled"); db.close();
  } finally { await f.close(); }
});

test("verified accepted result settlement retries after transient cleanup recovery", async () => {
  const f = await fixture({ removeThrowsOnce: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "settle" }] })); await f.event("turn_end"); await complete(f, started);
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; assert.equal(run.outcome, "completed"); assert.equal(run.outcomeSource, "worker"); assert.equal(getWorker(db, started.workerId)!.recoveryError, undefined); db.close(); assert.equal(f.removed.length >= 2, true);
  } finally { await f.close(); }
});



test("persistent accepted-result settlement failure is bounded, retained, and system-failed without cancellation", async () => {
  const f = await fixture({ removeAlwaysThrows: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "settle persistently" }] })); await f.event("turn_end");
    const db0 = f.registry(); const workspace = getWorker(db0, started.workerId)!.workspaceRoot; db0.close(); const repo = path.join(workspace, "repos", "interrupted"); gitInit(repo); writeFileSync(path.join(repo, "dirty.txt"), "dirty\n"); writeFileSync(path.join(repo, ".git", "index.lock"), "retained\n");
    await complete(f, started, { outcome: "completed", summary: "accepted before cleanup failure", repositories: ["repos/interrupted"] });
    let db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; const worker = getWorker(db, started.workerId)!; const runtime = run.runtime as any; db.close();
    assert.equal(run.outcome, "failed"); assert.equal(run.outcomeSource, "system"); assert.equal(worker.status, "idle"); assert.equal(runtime.settlementRecoveryAttempts, 3); assert.match(run.errors[0]!.message, /Accepted result completed remains retained/); assert.equal(existsSync(runtime.resultFile), true); assert.equal(JSON.parse(readFileSync(runtime.resultFile, "utf8")).result.outcome, "completed"); assert.equal(f.removed.length, 3);
    const resumed = receipt(await f.call("worker_run", { runs: [{ action: "resume", workerId: started.workerId, instructions: "inspect retained failure" }] })); db = f.registry(); const resumedRun = getWorkerRun(db, resumed.workerId, resumed.runId)!; db.close(); assert.match((resumedRun.runtime as any).prompt, /system-failed/); assert.match(((resumedRun.runtime as any).interruptionWarnings ?? []).join(" "), /index.lock/);
  } finally { await f.close(); }
});

test("session_start defers reconciliation and recovery renderer never reports green completion", async () => {
  const f = await fixture(); try {
    const handler = f.handlers.get("session_start")![0]!; assert.equal(handler({}, f.context), undefined);
    const renderer = f.renderers.get("worker-run")!; const theme = { fg: (color: string, value: string) => `${color}:${value}` };
    const text = renderer({ details: { event: "worker_recovery_required", workerId: "worker_12345678", runId: "run_1", role: "work", status: "running", error: "retry" } }, {}, theme).render(200).join("\n");
    assert.match(text, /error:recovery required/); assert.doesNotMatch(text, /completed/);
  } finally { await f.close(); }
});

test("worker commands exercise compact list/show and exact cancel/discard lifecycle paths", async () => {
  const f = await fixture(); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "command probe" }] }));
    await f.commands.get("worker:list").handler("", f.context); assert.match(f.notifications.at(-1)!, /queued · work/); assert.doesNotMatch(f.notifications.at(-1)!, /^\{/);
    await f.commands.get("worker:show").handler(`${started.workerId} ${started.runId}`, f.context); assert.match(f.notifications.at(-1)!, new RegExp(started.runId));
    await f.commands.get("worker:cancel").handler(started.workerId, f.context); assert.match(f.notifications.at(-1)!, /Cancelled/);
    await f.commands.get("worker:discard").handler(`${started.workerId} --confirm`, f.context); assert.match(f.notifications.at(-1)!, /Discarded/);
  } finally { await f.close(); }
});

function gitInit(repo: string): void { mkdirSync(repo, { recursive: true }); execFileSync("git", ["init", "-q", "-b", "main", repo]); git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.invalid"); }
function git(repo: string, ...args: string[]): string { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim(); }
function readDirs(root: string): string[] { return readdirSync(root).filter((name) => !name.startsWith(".")); }
