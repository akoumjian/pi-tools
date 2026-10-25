import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerWorkerExtension } from "../extensions/worker/index.js";
import { createWorkerAndRun, currentParentRuntime, getWorker, getWorkerRun, listWorkers, markWorkerDeliverySendStarted, openWorkerRegistry, registerParentRuntime, settleWorkerRun, storePreparedSet } from "../extensions/worker/registry.js";
import type { ManagedAsyncJobHandle, JobMeta } from "../extensions/async-shell/index.js";
import type { ReviewOverlayRecord } from "../extensions/worker/review-workspace.js";
import { prepareWorkerMerges } from "../extensions/worker/merge.js";
import { loadCleanupSnapshot, planSettledWorkerHostLogs } from "../extensions/worker/cleanup.js";
import { asyncJobProcessStartToken } from "../extensions/_shared/async-job.js";

const model = (provider: string, id: string) => ({ id, name: id, provider, api: "openai-responses", baseUrl: "https://example.invalid", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 }) as Model<Api>;

type Launch = { record: any; runtime: any; resolve(job: JobMeta): void; handle: ManagedAsyncJobHandle; job(status: JobMeta["status"], exitCode?: number): JobMeta };
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(options: { tui?: boolean; staleWarningContext?: boolean; sendMessageThrows?: boolean; launchThrows?: boolean; overlayThrows?: boolean; removeThrowsOnce?: boolean; removeAlwaysThrows?: boolean; deferRemove?: boolean; containerThrows?: boolean; deferContainer?: boolean; cleanupFailsWhileContainerLive?: boolean; staleOnReload?: boolean; launchReadsContext?: boolean; revokeClaimDuringLaunchOnce?: boolean; dockerOutage?: boolean; ownerWaitTimeoutMs?: number; ownerProbeIntervalMs?: number; readProcessStartToken?: (pid: number) => string | undefined; probeHostIdentity?: () => "alive" | "dead" | "unknown"; beforeCreateRunBatch?: () => void | Promise<void>; cleanupHostLogRaceOnce?:boolean; discardRootFailsOnce?:boolean; beadsStatus?: "closed" | "open" | "unavailable"; signalHostIdentity?: (_identity: any, signal: NodeJS.Signals) => boolean; models?: Model<Api>[]; authenticatedProviders?: string[] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-worker-v2-lifecycle-"));
  const runtimeRoot = path.join(root, "runtime"); const workersRoot = path.join(runtimeRoot, "workers"); mkdirSync(workersRoot, { recursive: true });
  const bdPath=path.join(root,"bd");const beadsStatus=options.beadsStatus??"closed";writeFileSync(bdPath,`#!/usr/bin/env node
const a=process.argv.slice(2);if(a[0]==='where')console.log(JSON.stringify({prefix:'personal',path:'/Users/aleck/.local/share/agent/beads/personal',database_path:'/Users/aleck/.local/share/agent/beads/personal/.beads/embeddeddolt'}));else if('${beadsStatus}'==='unavailable')process.exit(2);else console.log(JSON.stringify(a.filter(x=>x.startsWith('personal-')).map(id=>({id,status:'${beadsStatus}'==='open'?'in_progress':'closed'}))));
`);chmodSync(bdPath,0o700);
  const session = SessionManager.create(root, path.join(root, "parent-session"), { id: `parent-${Date.now()}` }); writeFileSync(session.getSessionFile()!, `${JSON.stringify(session.getHeader())}\n`, { mode: 0o600 });let activeSession=session;
  const messages: any[] = []; const messageAttempts: any[] = []; const notifications: string[] = []; const launches: Launch[] = []; const created: string[] = []; const removed: string[] = [];
  const overlays: ReviewOverlayRecord[] = []; const cleaned: ReviewOverlayRecord[] = []; const cleanupLeaseOwners: Array<string | undefined> = []; const liveContainers = new Set<string>(); const lifecycleEvents: string[] = []; const overlayRuns = new Map<string, string>();
  let containerGate: Promise<void> | undefined; let releaseContainer = () => {}; let removeGate: Promise<void> | undefined; let releaseRemove = () => {}; let removeFailures = 0; let counter = 0; let dockerOutage = options.dockerOutage ?? false; let revokeOnLaunch = options.revokeClaimDuringLaunchOnce ?? false; let cancelledHandles = 0;let cleanupHostLogRaces=0,discardRootFailures=0;
  const blockContainer = () => { let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); containerGate = gate; releaseContainer = () => { release(); if (containerGate === gate) containerGate = undefined; }; return releaseContainer; };
  if (options.deferContainer) blockContainer();
  if (options.deferRemove) removeGate = new Promise<void>((resolve) => { releaseRemove = resolve; });
  const random = () => `${(++counter).toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const baseContext = { cwd: root, hasUI: options.tui ?? false, mode: options.tui ? "tui" : "rpc", sessionManager: session, modelRegistry: { hasConfiguredAuth: (candidate: Model<Api>) => options.authenticatedProviders?.includes(candidate.provider) ?? true, getAll: () => options.models ?? [model("openai-codex", "gpt-5.6-sol"), model("anthropic", "claude-opus-5-5")] }, thinkingLevel: "xhigh", isIdle: () => true, hasPendingMessages: () => false, ui: { notify(message: string) { notifications.push(message); } } } as unknown as ExtensionContext;
  const dependencies = {
    runtimeRoot, roots: { stateRoot: workersRoot, workspaceRoot: workersRoot }, codeRoot: root, bdPath, preparedRoot: path.join(runtimeRoot, "prepared"), targetRoot: root, dockerPath: "/fake/docker", random, now: () => new Date(`2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`),
    waitForHostIdentity: async () => {}, ...(options.probeHostIdentity ? { probeHostIdentity: options.probeHostIdentity } : {}), ...(options.signalHostIdentity ? { signalHostIdentity: options.signalHostIdentity } : {}),
    hostTerminationGraceAttempts: 2, hostForcedTerminationAttempts: 2, hostProbeDelayMs: 1, ownerWaitTimeoutMs: options.ownerWaitTimeoutMs ?? 12_000, ownerProbeIntervalMs: options.ownerProbeIntervalMs ?? 20,
    ...(options.readProcessStartToken ? { readProcessStartToken: options.readProcessStartToken } : {}), ...(options.beforeCreateRunBatch ? { beforeCreateRunBatch: options.beforeCreateRunBatch } : {}),...(options.discardRootFailsOnce?{beforeDiscardRootClaim:()=>{if(discardRootFailures++===0)throw new Error("injected root claim failure");}}:{}),...(options.cleanupHostLogRaceOnce?{cleanupHostLogs:(registry:any,worker:any)=>{const plan=planSettledWorkerHostLogs(registry,worker);if(cleanupHostLogRaces++===0){const appeared=path.join(root,"appeared-after-host-log-preflight");mkdirSync(appeared,{recursive:true});return{...plan,absent:[...plan.absent,appeared]};}return plan;}}:{}),
    createContainer: async (_docker: string, reference: any, guard: { assertAuthority?: () => void }) => {
      guard.assertAuthority?.(); created.push(reference.runId); liveContainers.add(reference.runId); lifecycleEvents.push(`${reference.runId}:create`); const gate = containerGate; if (gate) await gate; guard.assertAuthority?.();
      if (dockerOutage || options.containerThrows) throw new Error(dockerOutage ? "Docker daemon unavailable" : "container disappeared between inspect and start"); return { ...reference, containerId: (++counter).toString(16).padStart(64, "0") };
    },
    removeContainer: async (_docker: string, reference: any) => { removed.push(reference.runId); lifecycleEvents.push(`${reference.runId}:remove`); if (removeGate) { await removeGate; removeGate = undefined; } if (dockerOutage || options.removeAlwaysThrows || options.removeThrowsOnce && removeFailures++ === 0) throw new Error(dockerOutage ? "Docker daemon unavailable" : options.removeAlwaysThrows ? "persistent container cleanup failure" : "transient container cleanup failure"); liveContainers.delete(reference.runId); },
    createOverlay: (input: any) => { if (options.overlayThrows) throw new Error("overlay probe failure"); const value: ReviewOverlayRecord = { version: 2, mergedVolume: `merged-${input.workerId}-${input.runId}`, scratchVolume: `scratch-${input.workerId}-${input.runId}`, mounts: [
      { kind: "volume", source: `merged-${input.workerId}-${input.runId}`, target: "/review/subject" }, { kind: "bind", source: input.reviewerWorkspace, target: "/workspace" },
      { kind: "bind", source: input.contextFile, target: "/review/context.json", readOnly: true }, { kind: "bind", source: input.reviewedSessionFile, target: "/review/session.jsonl", readOnly: true },
      ...(input.additionalInputs ?? []).map((item: any) => ({ kind: "bind" as const, source: item.source, target: item.target, readOnly: true }))
    ] }; overlayRuns.set(value.mergedVolume, input.runId); lifecycleEvents.push(`${input.runId}:overlay`); overlays.push(value); return value; },
    cleanupOverlay: (_docker: string, overlay: ReviewOverlayRecord) => {
      const overlayRun = overlayRuns.get(overlay.mergedVolume)!; if (options.cleanupFailsWhileContainerLive && liveContainers.has(overlayRun)) throw new Error("overlay volume is still in use");
      const db = openWorkerRegistry(runtimeRoot); const row = db.database.prepare("SELECT reviewed_by_worker_id FROM workers WHERE reviewed_by_worker_id IS NOT NULL LIMIT 1").get() as { reviewed_by_worker_id?: string } | undefined; db.close();
      cleanupLeaseOwners.push(row?.reviewed_by_worker_id); lifecycleEvents.push(`${overlayRun}:cleanup`); cleaned.push(overlay);
    },
    launch: (_api: ExtensionAPI, launchContext: ExtensionContext, input: any) => { if (options.launchReadsContext) { void launchContext.cwd; void launchContext.sessionManager.getSessionId(); } if (options.launchThrows) throw new Error("launch probe failure"); let resolve!: (job: JobMeta) => void; const completion = new Promise<JobMeta>((done) => { resolve = done; });
      const exactJob=(status:JobMeta["status"],exitCode=status==="exited"?0:undefined):JobMeta=>{const jobId=input.record.jobId;const logDir=path.join(root,".pi","async-shell","jobs",jobId);mkdirSync(logDir,{recursive:true});const stdoutLog=path.join(logDir,"stdout.log"),stderrLog=path.join(logDir,"stderr.log");if(!existsSync(stdoutLog))writeFileSync(stdoutLog,"");if(!existsSync(stderrLog))writeFileSync(stderrLog,"");const value={jobId,command:`Pi worker host ${input.record.workerId}/${input.record.runId}`,cwd:root,status,durationMs:1,exitCode,signal:null,notifyOnExit:false,completionNotified:true,logDir,stdoutLog,stderrLog,outputBytes:{stdout:0,stderr:0}} as JobMeta;writeFileSync(path.join(logDir,"meta.json"),JSON.stringify(value));return value;};
      const running = exactJob("running"); const handle: ManagedAsyncJobHandle = { jobId: input.record.jobId, completion, snapshot: () => running, cancel: () => { cancelledHandles += 1; resolve(exactJob("cancelled")); } }; launches.push({ ...input, resolve, handle, job:exactJob });
      if (revokeOnLaunch) { revokeOnLaunch = false; const db = openWorkerRegistry(runtimeRoot); db.database.prepare("UPDATE runs SET claim_kind=NULL,claim_nonce=NULL WHERE worker_id=? AND run_id=?").run(input.record.workerId, input.record.runId); db.close(); }
      return handle; }
  };
  const instances: Array<{ tools: ToolDefinition[]; handlers: Map<string, Function[]>; commands: Map<string, any>; renderers: Map<string, Function>; call(name: string, params: any): Promise<any>; event(name: string, event?: any): Promise<void>; invalidate(): void }> = [];
  const createInstance = async () => {
    let invalidated = false;
    const context = Object.create(baseContext) as ExtensionContext;
    Object.defineProperty(context, "cwd", { get: () => { if (invalidated && options.staleOnReload) throw new Error("This extension ctx is stale after session replacement or reload."); return root; } });
    Object.defineProperty(context, "sessionManager", { get: () => { if (invalidated && options.staleOnReload) throw new Error("This extension ctx is stale after session replacement or reload."); return activeSession; } });
    if (options.staleWarningContext) Object.defineProperty(context, "mode", { get: () => { if (invalidated) throw new Error("This extension warning context is stale."); return baseContext.mode; } });
    const tools: ToolDefinition[] = []; const handlers = new Map<string, Function[]>(); const commands = new Map<string, any>(); const renderers = new Map<string, Function>();
    const api = { registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer(name: string, renderer: Function) { renderers.set(name, renderer); }, on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, sendMessage(message: any) { messageAttempts.push(message); if (options.sendMessageThrows) throw new Error("send acceptance unavailable"); messages.push(message); } } as unknown as ExtensionAPI;
    registerWorkerExtension(api, dependencies);
    const call = async (name: string, params: any) => { const tool = tools.find((candidate) => candidate.name === name)!; return tool.execute!("test", params, new AbortController().signal, undefined, context); };
    const event = async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, context); if (name === "turn_end") await waitFor(() => { const db = openWorkerRegistry(runtimeRoot); const queued = Number((db.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE status='queued'").get() as any).count); db.close(); return queued === 0; }); };
    const instance = { tools, handlers, commands, renderers, call, event, invalidate: () => { invalidated = true; } }; instances.push(instance); await event("session_start"); return instance;
  };
  let current = await createInstance(); const first = current;
  const reload = async () => { await current.event("session_shutdown"); current.invalidate(); current = await createInstance(); return current; };
  const registry = () => openWorkerRegistry(runtimeRoot);
  return { root, runtimeRoot, workersRoot, session, messages, messageAttempts, notifications, launches, get releaseContainer() { return releaseContainer; }, releaseRemove, blockContainer, created, removed, liveContainers, lifecycleEvents, overlays, cleaned, cleanupLeaseOwners, context: baseContext, get cancelledHandles() { return cancelledHandles; }, setDockerOutage(value: boolean) { dockerOutage = value; },
    tools: first.tools, handlers: first.handlers, commands: first.commands, renderers: first.renderers, call: first.call, event: first.event, registry, reload, createInstance, invalidateCurrentContext: () => current.invalidate(),switchSession:(next:SessionManager)=>{activeSession=next;},
    async close() { releaseContainer(); releaseRemove(); for (const instance of instances) { try { await instance.event("session_shutdown"); } catch {} } rmSync(root, { recursive: true, force: true }); }
  };
}
const lifecycleOwnerFixture = fileURLToPath(new URL("./fixtures/worker-lifecycle-claim-owner.js", import.meta.url));
const cleanupCrashFixture=fileURLToPath(new URL("./fixtures/worker-cleanup-crash-owner.js",import.meta.url));

async function spawnLifecycleClaimOwner(f: Fixture, item: { workerId: string; runId: string }, claimKind: "launch" | "settlement", mode: "hold" | "retire" = "hold") {
  const parent = realpathSync(f.session.getSessionFile()!);
  const child = spawn(process.execPath, [lifecycleOwnerFixture, f.runtimeRoot, parent, item.workerId, item.runId, claimKind, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const claimed = await new Promise<any>((resolve, reject) => {
    let stderr = ""; child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => reject(new Error(`lifecycle owner did not claim: ${stderr}`)), 4_000);
    child.once("error", reject); child.once("exit", (code, signal) => { if (mode !== "retire") reject(new Error(`lifecycle owner exited before claim (${code}/${signal}): ${stderr}`)); });
    child.on("message", (message: any) => { if (message?.event === "claimed") { clearTimeout(timer); resolve(message); } });
  });
  return { child, claimed };
}

async function spawnDeliveryClaimOwner(f: Fixture, item: { workerId: string; runId: string }, ownerSessionFile?:string) {
  const parent = ownerSessionFile?realpathSync(ownerSessionFile):realpathSync(f.session.getSessionFile()!);
  const child = spawn(process.execPath, [lifecycleOwnerFixture, f.runtimeRoot, parent, item.workerId, item.runId, "delivery", "wait"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const receive = (event: string) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`delivery owner did not emit ${event}: ${stderr}`)), 4_000);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => { clearTimeout(timer); reject(new Error(`delivery owner exited before ${event} (${code}/${signal}): ${stderr}`)); };
    const onMessage = (message: any) => { if (message?.event !== event) return; clearTimeout(timer); child.off("exit", onExit); child.off("message", onMessage); resolve(message); };
    child.once("exit", onExit); child.on("message", onMessage);
  });
  const registered = await receive("registered");
  return { child, registered, claim: async () => { const claimed = receive("claimed"); child.send({ action: "claim" }); return claimed; } };
}

async function stopLifecycleClaimOwner(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal); await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

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
  launch.resolve(launch.job("exited", 0));
  await waitFor(() => { const side = f.registry(); const run = getWorkerRun(side, item.workerId, item.runId); side.close(); return run?.status === "settled"; });
}
async function acknowledgeWorkerDeliveries(f: Fixture, workerId: string): Promise<void> {
  for (const attempted of f.messageAttempts.filter((message) => message.details?.workerId === workerId)) {
    await f.event("message_end", { message: { role: "custom", customType: "worker-run", content: attempted.content, display: true, details: attempted.details, timestamp: Date.now() } });
  }
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


test("healthy launch finalization clears transient recovery evidence", async () => {
  const f = await fixture({ deferContainer: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "clear transient evidence" }] }));
    f.handlers.get("turn_end")![0]!({}, f.context); await waitFor(() => f.created.length === 1);
    const db = f.registry(); db.database.prepare("UPDATE workers SET recovery_error='transient owner observation' WHERE worker_id=?").run(started.workerId); db.close();
    f.releaseContainer(); await waitFor(() => f.launches.length === 1); await waitFor(() => { const state = f.registry(); const run = getWorkerRun(state, started.workerId, started.runId); state.close(); return run?.status === "running"; });
    const after = f.registry(); assert.equal(getWorker(after, started.workerId)!.recoveryError, undefined); after.close(); await f.call("worker_control", { action: "cancel", workerId: started.workerId });
  } finally { f.releaseContainer(); await f.close(); }
});

test("concurrent reconciliation cannot revoke or duplicate an in-flight launch authority", async () => {
  const f = await fixture({ deferContainer: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "reconcile during create" }] }));
    f.handlers.get("turn_end")![0]!({}, f.context); await waitFor(() => f.created.length === 1);
    for (const handler of f.handlers.get("session_start") ?? []) { await handler({}, f.context); await handler({}, f.context); }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.created.length, 1); assert.equal(f.removed.length, 0, "reconciliation must not remove a container from the retained local launch generation");
    f.releaseContainer(); await waitFor(() => f.launches.length === 1);
    const db = f.registry(); assert.equal(getWorkerRun(db, started.workerId, started.runId)!.status, "running"); db.close();
    assert.equal(f.created.length, 1, "one CAS owner creates exactly one container");
    await f.call("worker_control", { action: "cancel", workerId: started.workerId });
  } finally { f.releaseContainer(); await f.close(); }
});

test("G/C: a reloaded extension preserves the live launch owner and never races exact adoption", async () => {
  const f = await fixture({ deferContainer: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "reload during readiness" }] }));
    f.handlers.get("turn_end")![0]!({}, f.context); await waitFor(() => f.created.length === 1 && f.liveContainers.has(started.runId));
    const reloaded = await f.reload(); await new Promise((resolve) => setTimeout(resolve, 30));
    let db = f.registry(); let run = getWorkerRun(db, started.workerId, started.runId)!; db.close();
    assert.equal(run.claimKind, "launch"); assert.match(run.claimNonce!, new RegExp(`^\\d+-${process.pid}-[a-f0-9]{64}-`), "the durable claim itself identifies its exact process owner"); assert.equal(f.created.length, 1); assert.equal(f.removed.length, 0);
    assert.equal(existsSync(run.stdoutLog!), false, "a stale instance must not reserve the successor async-job directory");
    f.releaseContainer(); await waitFor(() => f.launches.length === 1); await waitFor(() => { const state = f.registry(); const value = getWorkerRun(state, started.workerId, started.runId); state.close(); return value?.status === "running"; });
    db = f.registry(); run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.status, "running"); assert.equal(f.created.length, 1); assert.equal(f.liveContainers.has(started.runId), true);
    await reloaded.call("worker_control", { action: "cancel", workerId: started.workerId }); assert.equal(f.liveContainers.has(started.runId), false);
  } finally { f.releaseContainer(); await f.close(); }
});

test("Pi-faithful reload invalidates the old context without invalidating snapshotted launch inputs", async () => {
  const f = await fixture({ deferContainer: true, staleOnReload: true, launchReadsContext: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "reload with invalidated context" }] }));
    f.handlers.get("turn_end")![0]!({}, f.context); await waitFor(() => f.created.length === 1);
    const reloaded = await f.reload(); f.releaseContainer(); await waitFor(() => f.launches.length === 1);
    await waitFor(() => { const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId); db.close(); return run?.status === "running"; });
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.status, "running"); assert.doesNotMatch(JSON.stringify(run.errors), /ctx is stale/);
    await reloaded.call("worker_control", { action: "cancel", workerId: started.workerId });
  } finally { f.releaseContainer(); await f.close(); }
});

test("H: cancellation from a reloaded extension waits for launch and leaves no live containment", async () => {
  const f = await fixture({ deferContainer: true, staleOnReload: true, launchReadsContext: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "cancel after reload" }] }));
    f.handlers.get("turn_end")![0]!({}, f.context); await waitFor(() => f.created.length === 1 && f.liveContainers.has(started.runId));
    const reloaded = await f.reload(); let resolved = false; const cancelling = reloaded.call("worker_control", { action: "cancel", workerId: started.workerId }).then((value) => { resolved = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 40)); assert.equal(resolved, false); assert.equal(f.liveContainers.has(started.runId), true);
    f.releaseContainer(); await cancelling; const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; const worker = getWorker(db, started.workerId)!; db.close();
    assert.equal(run.outcome, "cancelled"); assert.equal(worker.status, "idle"); assert.equal(f.liveContainers.has(started.runId), false); assert.deepEqual(f.removed.filter((runId) => runId === started.runId), [started.runId]);
  } finally { f.releaseContainer(); await f.close(); }
});

test("review cancellation during launch removes exact containment before exact overlay cleanup", async () => {
  const f = await fixture({ cleanupFailsWhileContainerLive: true }); try {
    const subject = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] })); await f.event("turn_end"); await complete(f, subject);
    f.blockContainer(); const review = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId }] }));
    f.handlers.get("turn_end")![0]!({}, f.context); await waitFor(() => f.overlays.some((overlay) => overlay.mergedVolume.endsWith(review.runId)) && f.liveContainers.has(review.runId));
    const exactOverlay = f.overlays.find((overlay) => overlay.mergedVolume.endsWith(review.runId))!; const reloaded = await f.reload();
    let resolved = false; const cancelling = reloaded.call("worker_control", { action: "cancel", workerId: review.workerId }).then((value) => { resolved = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 40)); assert.equal(resolved, false); assert.equal(f.cleaned.some((overlay) => overlay.mergedVolume === exactOverlay.mergedVolume), false);
    f.releaseContainer(); await cancelling;
    const events = f.lifecycleEvents.filter((event) => event.startsWith(`${review.runId}:`)); const removeIndex = events.indexOf(`${review.runId}:remove`); const cleanupIndex = events.indexOf(`${review.runId}:cleanup`);
    assert.ok(removeIndex >= 0 && cleanupIndex > removeIndex, events.join(",")); assert.equal(f.liveContainers.has(review.runId), false); assert.equal(f.cleaned.filter((overlay) => overlay.mergedVolume === exactOverlay.mergedVolume).length, 1);
    const db = f.registry(); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, undefined); db.close();
  } finally { f.releaseContainer(); await f.close(); }
});

test("pre-host container failure publishes the reported diagnostic log paths", async () => {
  const f = await fixture({ containerThrows: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "fail before host logs" }] }));
    await f.event("turn_end"); const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; db.close();
    assert.equal(run.status, "settled"); assert.equal(run.outcome, "failed"); assert.ok(run.stdoutLog && existsSync(run.stdoutLog)); assert.ok(run.stderrLog && existsSync(run.stderrLog));
    assert.match(readFileSync(run.stderrLog!, "utf8"), /container disappeared between inspect and start/);
  } finally { await f.close(); }
});

test("failed-launch diagnostic logs are best-effort and never escape the lifecycle promise", async () => {
  const f = await fixture({ containerThrows: true }); const unhandled: unknown[] = []; const onUnhandled = (error: unknown) => { unhandled.push(error); }; process.on("unhandledRejection", onUnhandled);
  try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "unwritable diagnostics" }] }));
    const blocked = path.join(f.root, "not-a-directory"); writeFileSync(blocked, "blocked"); const db0 = f.registry(); db0.database.prepare("UPDATE runs SET stdout_log=?,stderr_log=? WHERE run_id=?").run(path.join(blocked, "stdout.log"), path.join(blocked, "stderr.log"), started.runId); db0.close();
    await f.event("turn_end"); await new Promise((resolve) => setTimeout(resolve, 25)); const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; db.close();
    assert.equal(run.outcome, "failed"); assert.equal(unhandled.length, 0, unhandled.map(String).join("\n")); assert.equal(f.liveContainers.has(started.runId), false);
  } finally { process.off("unhandledRejection", onUnhandled); await f.close(); }
});

test("cancellation waits for a deferred launch boundary before proving termination", async () => {
  const f = await fixture({ deferContainer: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "cancel during readiness" }] }));
    const handler = f.handlers.get("turn_end")![0]!; handler({}, f.context); await waitFor(() => f.created.length === 1);
    let resolved = false; const cancelling = f.call("worker_control", { action: "cancel", workerId: started.workerId }).then((value) => { resolved = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(resolved, false); f.releaseContainer(); await cancelling;
    const db = f.registry(); const worker = getWorker(db, started.workerId)!; const run = getWorkerRun(db, started.workerId, started.runId)!; db.close();
    assert.equal(worker.status, "idle"); assert.equal(run.outcome, "cancelled"); assert.equal(f.launches.length, 1, "cancellation waits for the durable launch owner before containing it");
    assert.deepEqual(f.removed, [started.runId], "cancellation removes the exact launched containment once");
  } finally { f.releaseContainer(); await f.close(); }
});

test("RA: transient queued-cancellation cleanup failure retains intent and never launches", async () => {
  const f = await fixture({ removeThrowsOnce: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "cancel before launch" }] }));
    await assert.rejects(() => f.call("worker_control", { action: "cancel", workerId: started.workerId }), /cancellation requires recovery/i);
    let db = f.registry(); let run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.terminalIntent, "cancellation"); assert.equal(run.status, "queued"); assert.equal(f.launches.length, 0);
    await waitFor(() => { const state = f.registry(); const current = getWorkerRun(state, started.workerId, started.runId); state.close(); return current?.outcome === "cancelled"; }, 4_000);
    db = f.registry(); run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.outcome, "cancelled"); assert.equal(f.launches.length, 0); assert.equal(f.created.length, 0);
  } finally { await f.close(); }
});

test("RB: failed pre-host cleanup retains failure intent and cannot be relaunched", async () => {
  const f = await fixture({ containerThrows: true, removeThrowsOnce: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "fail before host" }] }));
    await f.event("turn_end"); await waitFor(() => { const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId); db.close(); return run?.status === "settled"; }, 4_000);
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.outcome, "failed"); assert.equal(f.created.length, 1); assert.equal(f.launches.length, 0);
  } finally { await f.close(); }
});

test("RD: Docker outage preserves cancellation intent until exact containment can recover", async () => {
  const f = await fixture({ dockerOutage: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "cancel during outage" }] }));
    await assert.rejects(() => f.call("worker_control", { action: "cancel", workerId: started.workerId }), /cancellation requires recovery/i);
    await new Promise((resolve) => setTimeout(resolve, 2_200)); let db = f.registry(); let run = getWorkerRun(db, started.workerId, started.runId)!; db.close();
    assert.equal(run.terminalIntent, "cancellation"); assert.equal(run.status, "queued"); assert.equal(f.created.length, 0); assert.equal(f.launches.length, 0);
    f.setDockerOutage(false); await waitFor(() => { const state = f.registry(); const current = getWorkerRun(state, started.workerId, started.runId); state.close(); return current?.outcome === "cancelled"; }, 4_000);
    db = f.registry(); run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.outcome, "cancelled"); assert.equal(f.created.length, 0);
  } finally { await f.close(); }
});

test("a superseded runtime records cancellation while only the newest live runtime performs containment", async () => {
  const f = await fixture({ deferContainer: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "two live runtimes" }] }));
    f.handlers.get("turn_end")![0]!({}, f.context); await waitFor(() => f.created.length === 1);
    await f.createInstance();
    await assert.rejects(() => f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-other"], instructions: "stale start" }] }), /runtime was superseded.*reload/i);
    const accepted = await f.call("worker_control", { action: "cancel", workerId: started.workerId });
    assert.equal((accepted.details as any).cancellation, "accepted_pending");
    let state = f.registry(); const recorded = getWorkerRun(state, started.workerId, started.runId)!; assert.equal(recorded.terminalIntent, "cancellation", "intent remains durable until the current runtime finalizes it"); state.close();
    f.releaseContainer();
    await waitFor(() => { const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId); db.close(); return run?.outcome === "cancelled"; }, 4_000);
    assert.deepEqual(f.removed, [started.runId], "only the current runtime performs exact containment");
  } finally { f.releaseContainer(); await f.close(); }
});

test("the latest remaining live runtime is elected after a newer process exits", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const f = await fixture({ deferContainer: true }); try {
    assert.ok(child.pid); let childToken: string | undefined; await waitFor(() => Boolean(childToken = asyncJobProcessStartToken(child.pid!)));
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "latest remaining owner" }] }));
    f.handlers.get("turn_end")![0]!({}, f.context); await waitFor(() => f.created.length === 1);
    await f.createInstance();
    const parent = realpathSync(f.session.getSessionFile()!); let db = f.registry();
    const newest = registerParentRuntime(db, parent, "exited-newest", new Date().toISOString(), { pid: child.pid!, processStartToken: childToken! }); assert.equal(newest, 3); db.close();
    child.kill("SIGKILL"); await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const accepted = await f.call("worker_control", { action: "cancel", workerId: started.workerId });
    assert.equal((accepted.details as any).cancellation, "accepted_pending", "the oldest runtime must not jump ahead of a newer live runtime");
    f.releaseContainer();
    await waitFor(() => { const state = f.registry(); const run = getWorkerRun(state, started.workerId, started.runId); const current = currentParentRuntime(state, parent); state.close(); return run?.outcome === "cancelled" && current?.generation === 4; }, 4_000);
  } finally { f.releaseContainer(); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await f.close(); }
});

test("first cancellation behind a dead newest owner promotes, reclaims, and finishes in the same call", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const f = await fixture({ ownerWaitTimeoutMs: 500, ownerProbeIntervalMs: 20 }); try {
    assert.ok(child.pid); let childToken: string | undefined; await waitFor(() => Boolean(childToken = asyncJobProcessStartToken(child.pid!)));
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "dead newest owner" }] }));
    const parent = realpathSync(f.session.getSessionFile()!); const digest = createHash("sha256").update(childToken!).digest("hex"); let db = f.registry();
    const foreignGeneration = registerParentRuntime(db, parent, "dead-newer-runtime", new Date().toISOString(), { pid: child.pid!, processStartToken: childToken! });
    db.database.prepare("UPDATE runs SET claim_kind='launch',claim_nonce=? WHERE worker_id=? AND run_id=?").run(`${foreignGeneration}-${child.pid}-${digest}-${randomUUID()}`, started.workerId, started.runId); db.close();
    child.kill("SIGKILL"); await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const cancelled = await f.call("worker_control", { action: "cancel", workerId: started.workerId });
    assert.equal((cancelled.details as any).cancellation, "cancelled");
    db = f.registry(); assert.equal(getWorkerRun(db, started.workerId, started.runId)!.outcome, "cancelled"); assert.equal(currentParentRuntime(db, parent)!.runtimeId !== "dead-newer-runtime", true); db.close();
    assert.equal(f.launches.length, 0);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await f.close(); }
});

test("K1: elected runtime automatically reclaims a crashed newer process launch claim and launches once", async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof spawnLifecycleClaimOwner>> | undefined; try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "K1 crashed launch owner" }] }));
    owner = await spawnLifecycleClaimOwner(f, started, "launch");
    await stopLifecycleClaimOwner(owner.child);
    await waitFor(() => f.launches.length === 1, 4_000);
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; const parent = realpathSync(f.session.getSessionFile()!); assert.equal(run.status, "running"); assert.equal(run.claimKind, undefined); assert.ok(currentParentRuntime(db, parent)!.generation > owner.claimed.generation); db.close();
    assert.equal(f.created.length, 1); assert.equal(f.launches.length, 1);
    await f.call("worker_control", { action: "cancel", workerId: started.workerId });
  } finally { if (owner) await stopLifecycleClaimOwner(owner.child); await f.close(); }
});

test("K1b: elected runtime automatically reclaims a cleanly unregistered launch claim and launches once", async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof spawnLifecycleClaimOwner>> | undefined; try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "K1b retired launch owner" }] }));
    owner = await spawnLifecycleClaimOwner(f, started, "launch", "retire");
    if (owner.child.exitCode === null && owner.child.signalCode === null) await new Promise<void>((resolve) => owner!.child.once("exit", () => resolve()));
    await waitFor(() => f.launches.length === 1, 4_000);
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.status, "running"); assert.equal(run.claimKind, undefined);
    assert.equal(f.created.length, 1); assert.equal(f.launches.length, 1);
    await f.call("worker_control", { action: "cancel", workerId: started.workerId });
  } finally { if (owner) await stopLifecycleClaimOwner(owner.child); await f.close(); }
});

test("K3: elected runtime reclaims a crashed settlement claim and preserves accepted completion", async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof spawnLifecycleClaimOwner>> | undefined; try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "K3 accepted settlement" }] })); await f.event("turn_end");
    owner = await spawnLifecycleClaimOwner(f, started, "settlement");
    const launch = writeCompletionEvidence(f, started, { outcome: "completed", summary: "accepted K3" }); launch.resolve(launch.job("exited", 0));
    await stopLifecycleClaimOwner(owner.child);
    await waitFor(() => { const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId); db.close(); return run?.outcome === "completed"; }, 4_000);
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.summary, "accepted K3"); assert.equal(run.outcomeSource, "worker");
    assert.equal(f.removed.filter((id) => id === started.runId).length, 1); assert.equal(f.messages.filter((message) => message.details?.runId === started.runId && message.details?.outcome === "completed").length, 1);
  } finally { if (owner) await stopLifecycleClaimOwner(owner.child); await f.close(); }
});

test("K3c: cancel after settlement-owner death settles accepted completion instead of cancelling", async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof spawnLifecycleClaimOwner>> | undefined; try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "K3c accepted result wins" }] })); await f.event("turn_end");
    owner = await spawnLifecycleClaimOwner(f, started, "settlement");
    const launch = writeCompletionEvidence(f, started, { outcome: "completed", summary: "accepted K3c" }); launch.resolve(launch.job("exited", 0));
    await stopLifecycleClaimOwner(owner.child);
    const cancelled = await f.call("worker_control", { action: "cancel", workerId: started.workerId }); assert.ok(["superseded", "not_active"].includes((cancelled.details as any).cancellation));
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.outcome, "completed"); assert.equal(run.summary, "accepted K3c"); assert.equal(run.terminalIntent, undefined);
    assert.equal(f.removed.filter((id) => id === started.runId).length, 1); assert.equal(f.messages.filter((message) => message.details?.runId === started.runId && message.details?.outcome === "completed").length, 1);
  } finally { if (owner) await stopLifecycleClaimOwner(owner.child); await f.close(); }
});

test("D1: promotion reclaims a crashed process pre-send delivery claim and notifies once", async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof spawnDeliveryClaimOwner>> | undefined; try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "D1 delivery owner" }] })); await f.event("turn_end");
    owner = await spawnDeliveryClaimOwner(f, started);
    const db = f.registry(); settleWorkerRun(db, { parentSessionFile: realpathSync(f.session.getSessionFile()!), workerId: started.workerId, runId: started.runId, outcome: "completed", outcomeSource: "worker", summary: "D1 settled", settledAt: new Date().toISOString() }); db.close();
    const claimed = await owner.claim();
    let state = f.registry(); let delivery = state.database.prepare("SELECT state,send_started_at FROM deliveries WHERE run_id=?").get(started.runId) as any; state.close(); assert.equal(delivery.state, "claimed"); assert.equal(delivery.send_started_at, null);
    await stopLifecycleClaimOwner(owner.child);
    await waitFor(() => f.messages.filter((message) => message.details?.event === "worker_settled" && message.details?.runId === started.runId).length === 1, 4_000);
    state = f.registry(); delivery = state.database.prepare("SELECT state,runtime_generation,send_started_at FROM deliveries WHERE run_id=?").get(started.runId) as any; const current = currentParentRuntime(state, realpathSync(f.session.getSessionFile()!)); state.close();
    assert.equal(delivery.state, "claimed"); assert.ok(delivery.send_started_at); assert.ok(current!.generation > claimed.generation); assert.equal(f.messageAttempts.filter((message) => message.details?.runId === started.runId).length, 1);
    const launch = f.launches.find((candidate) => candidate.record.runId === started.runId); if (launch) launch.resolve(launch.job("exited", 0));
  } finally { if (owner) await stopLifecycleClaimOwner(owner.child); await f.close(); }
});

test("a started completion send is surfaced as unconfirmed and never replayed", async () => {
  const f = await fixture({ sendMessageThrows: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "ambiguous completion send" }] })); await f.event("turn_end"); await complete(f, started);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(f.messageAttempts.filter((message) => message.details?.runId === started.runId).length, 1, "an attempted send cannot be replayed after acceptance becomes ambiguous");
    const shown = await f.call("worker_control", { action: "get", workerId: started.workerId, runId: started.runId });
    const shownVisible = JSON.parse((shown.content[0] as any).text);
    assert.equal((shown.details as any).notification.state, "send_started_unconfirmed"); assert.ok((shown.details as any).notification.sendStartedAt); assert.deepEqual(shownVisible.notification, (shown.details as any).notification);
    const db = f.registry(); const delivery = db.database.prepare("SELECT state,send_started_at FROM deliveries WHERE run_id=?").get(started.runId) as any; db.close(); assert.equal(delivery.state, "claimed"); assert.ok(delivery.send_started_at);
  } finally { await f.close(); }
});

test("Escape-like lost completion remains visible across reload without replay or duplicate UI warning", async () => {
  const f = await fixture({ tui: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "queued completion visibility" }] })); await f.event("turn_end"); await complete(f, started);
    assert.equal(f.messageAttempts.filter((message) => message.details?.runId === started.runId).length, 1, "the original completion send starts once");
    const listed = await f.call("worker_control", { action: "list" }); const listedVisible = JSON.parse((listed.content[0] as any).text); assert.equal((listed.details as any).workers[0].notification.state, "send_started_unconfirmed"); assert.equal((listed.details as any).workers[0].notification.runId, started.runId); assert.deepEqual(listedVisible.workers[0].notification, (listed.details as any).workers[0].notification); assert.deepEqual((listed.details as any).counts, { queued: 0, running: 0, idle: 1 }); assert.equal((listed.details as any).total, 1);
    await f.commands.get("worker:list").handler("", f.context); assert.match(f.notifications.at(-1)!, /send_started_unconfirmed/); assert.match(f.notifications.at(-1)!, new RegExp(started.runId));
    await f.commands.get("worker:show").handler(`${started.workerId} ${started.runId}`, f.context); assert.match(f.notifications.at(-1)!, /send_started_unconfirmed/);
    const beforeWarnings = f.notifications.filter((message) => /completed, but its notification is send_started_unconfirmed/.test(message)).length; assert.equal(beforeWarnings, 0);
    const current = await f.reload();
    assert.equal(f.notifications.filter((message) => /completed, but its notification is send_started_unconfirmed/.test(message)).length, 1, "reload warns once for the exact run and new runtime generation");
    assert.equal(f.messageAttempts.filter((message) => message.details?.runId === started.runId).length, 1, "reload must not replay an ambiguous send");
    await current.event("session_start"); assert.equal(f.notifications.filter((message) => /completed, but its notification is send_started_unconfirmed/.test(message)).length, 1, "repeated startup in one runtime generation is deduped");
  } finally { await f.close(); }
});

test("owner crash promotion emits one UI-only unconfirmed warning without model replay", async () => {
  const f = await fixture({ tui: true }); let owner: Awaited<ReturnType<typeof spawnDeliveryClaimOwner>> | undefined; try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "crashed ambiguous notifier" }] })); await f.event("turn_end");
    owner = await spawnDeliveryClaimOwner(f, started);
    let db = f.registry(); settleWorkerRun(db, { parentSessionFile: realpathSync(f.session.getSessionFile()!), workerId: started.workerId, runId: started.runId, outcome: "completed", outcomeSource: "worker", summary: "retained after notifier crash", settledAt: new Date().toISOString() }); db.close();
    const claimed = await owner.claim(); db = f.registry(); assert.equal(markWorkerDeliverySendStarted(db, claimed.deliveryId, claimed.generation, new Date().toISOString()), true); db.close();
    await stopLifecycleClaimOwner(owner.child);
    await waitFor(() => f.notifications.some((message) => message.includes(`${started.workerId}/${started.runId}`)), 4_000);
    assert.equal(f.notifications.filter((message) => message.includes(`${started.workerId}/${started.runId}`)).length, 1);
    assert.equal(f.messageAttempts.filter((message) => message.details?.runId === started.runId).length, 0, "promotion warning is UI-only and never replays the send");
    db = f.registry(); const parent = realpathSync(f.session.getSessionFile()!); assert.ok(currentParentRuntime(db, parent)!.generation > claimed.generation); const delivery = db.database.prepare("SELECT state,send_started_at FROM deliveries WHERE run_id=?").get(started.runId) as any; db.close(); assert.equal(delivery.state, "claimed"); assert.ok(delivery.send_started_at);
    await f.event("session_start"); assert.equal(f.notifications.filter((message) => message.includes(`${started.workerId}/${started.runId}`)).length, 1, "same-generation promotion notice remains deduped");
    const launch = f.launches.find((candidate) => candidate.record.runId === started.runId); if (launch) launch.resolve(launch.job("exited", 0));
  } finally { if (owner) await stopLifecycleClaimOwner(owner.child); await f.close(); }
});

test("stale warning-context reads cannot escape synchronous runtime promotion", async () => {
  const f = await fixture({ tui: true, staleWarningContext: true }); let owner: Awaited<ReturnType<typeof spawnDeliveryClaimOwner>> | undefined; try {
    const batch = await f.call("worker_run", { runs: [
      { action: "start", role: "work", taskIds: ["personal-warning"], instructions: "ambiguous completion" },
      { action: "start", role: "work", taskIds: ["personal-cancel"], instructions: "force synchronous promotion" }
    ] });
    const ambiguous = (batch.details as any).runs[0]; const cancellable = (batch.details as any).runs[1];
    owner = await spawnDeliveryClaimOwner(f, ambiguous);
    let db = f.registry(); settleWorkerRun(db, { parentSessionFile: realpathSync(f.session.getSessionFile()!), workerId: ambiguous.workerId, runId: ambiguous.runId, outcome: "completed", outcomeSource: "worker", summary: "retained", settledAt: new Date().toISOString() }); db.close();
    const claimed = await owner.claim(); db = f.registry(); assert.equal(markWorkerDeliverySendStarted(db, claimed.deliveryId, claimed.generation, new Date().toISOString()), true); db.close();
    f.invalidateCurrentContext(); await stopLifecycleClaimOwner(owner.child);
    const cancelled = await f.call("worker_control", { action: "cancel", workerId: cancellable.workerId }); assert.equal((cancelled.details as any).cancellation, "cancelled", "stale UI reads must not escape promotion or lifecycle work");
    db = f.registry(); const current = currentParentRuntime(db, realpathSync(f.session.getSessionFile()!)); const retained = db.database.prepare("SELECT state,send_started_at FROM deliveries WHERE run_id=?").get(ambiguous.runId) as any; db.close();
    assert.ok(current!.generation > claimed.generation); assert.equal(retained.state, "claimed"); assert.ok(retained.send_started_at); assert.equal(f.notifications.some((message) => message.includes(ambiguous.runId)), false);
  } finally { if (owner) await stopLifecycleClaimOwner(owner.child); await f.close(); }
});

test("cancel during a live accepted settlement returns result-preserved superseded without intent", async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof spawnLifecycleClaimOwner>> | undefined; try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "live accepted settlement" }] })); await f.event("turn_end");
    owner = await spawnLifecycleClaimOwner(f, started, "settlement");
    const launch = writeCompletionEvidence(f, started, { outcome: "completed", summary: "accepted before cancellation" }); launch.resolve(launch.job("exited", 0));
    const result = await f.call("worker_control", { action: "cancel", workerId: started.workerId }); assert.equal((result.details as any).cancellation, "superseded");
    let db = f.registry(); let run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.status, "running"); assert.equal(run.terminalIntent, undefined); assert.equal(run.claimKind, "settlement");
    await stopLifecycleClaimOwner(owner.child);
    await waitFor(() => { const state = f.registry(); const current = getWorkerRun(state, started.workerId, started.runId); state.close(); return current?.outcome === "completed"; }, 4_000);
    db = f.registry(); run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.summary, "accepted before cancellation"); assert.equal(run.outcomeSource, "worker");
  } finally { if (owner) await stopLifecycleClaimOwner(owner.child); await f.close(); }
});

test("cancel during this runtime's live accepted settlement returns superseded and preserves the result", async () => {
  const f = await fixture({ deferRemove: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "own live settlement" }] })); await f.event("turn_end");
    const launch = writeCompletionEvidence(f, started, { outcome: "completed", summary: "own accepted settlement" }); launch.resolve(launch.job("exited", 0));
    await waitFor(() => { const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId); db.close(); return run?.claimKind === "settlement"; });
    const result = await f.call("worker_control", { action: "cancel", workerId: started.workerId }); assert.equal((result.details as any).cancellation, "superseded");
    let db = f.registry(); let run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.terminalIntent, undefined); assert.equal(run.status, "running");
    f.releaseRemove(); await waitFor(() => { const state = f.registry(); const current = getWorkerRun(state, started.workerId, started.runId); state.close(); return current?.status === "settled"; });
    db = f.registry(); run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.outcome, "completed"); assert.equal(run.summary, "own accepted settlement");
  } finally { f.releaseRemove(); await f.close(); }
});

test("cancel in an attached accepted-result window is side-effect-free through a greater-than-five-second host exit", async () => {
  const f = await fixture(); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "cancel slow attached accepted host" }] })); await f.event("turn_end");
    const launch = writeCompletionEvidence(f, started, { outcome: "completed", summary: "accepted before slow attached exit" });
    const began = Date.now(); const result = await f.call("worker_control", { action: "cancel", workerId: started.workerId }); assert.equal((result.details as any).cancellation, "superseded"); assert.ok(Date.now() - began < 1_000, "accepted cancellation must not wait on or contain the attached host");
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    let db = f.registry(); let run = getWorkerRun(db, started.workerId, started.runId)!; let worker = getWorker(db, started.workerId)!; db.close();
    assert.equal(run.status, "running"); assert.equal(run.terminalIntent, undefined); assert.equal(worker.recoveryError, undefined); assert.equal(f.cancelledHandles, 0); assert.equal(f.removed.length, 0);
    assert.equal(f.messages.filter((message) => message.details?.event === "worker_recovery_required" && message.details?.runId === started.runId).length, 0);
    launch.resolve(launch.job("exited", 0)); await waitFor(() => { const state = f.registry(); const current = getWorkerRun(state, started.workerId, started.runId); state.close(); return current?.status === "settled"; }, 4_000);
    db = f.registry(); run = getWorkerRun(db, started.workerId, started.runId)!; worker = getWorker(db, started.workerId)!; db.close(); assert.equal(run.outcome, "completed"); assert.equal(run.summary, "accepted before slow attached exit"); assert.equal(worker.recoveryError, undefined); assert.equal(f.removed.length, 1);
    assert.equal(f.messages.filter((message) => message.details?.event === "worker_recovery_required" && message.details?.runId === started.runId).length, 0);
  } finally { await f.close(); }
});

test("an attached host may exit more than five seconds after accepted evidence without recovery noise", async () => {
  const f = await fixture(); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "slow healthy host stop" }] })); await f.event("turn_end");
    const launch = writeCompletionEvidence(f, started, { outcome: "completed", summary: "healthy delayed exit" });
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    let db = f.registry(); assert.equal(getWorkerRun(db, started.workerId, started.runId)!.status, "running"); assert.equal(getWorker(db, started.workerId)!.recoveryError, undefined); db.close();
    assert.equal(f.messages.filter((message) => message.details?.event === "worker_recovery_required" && message.details?.runId === started.runId).length, 0); assert.equal(f.removed.length, 0);
    launch.resolve(launch.job("exited", 0));
    await waitFor(() => { const state = f.registry(); const run = getWorkerRun(state, started.workerId, started.runId); state.close(); return run?.status === "settled"; }, 4_000);
    db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; const worker = getWorker(db, started.workerId)!; db.close(); assert.equal(run.outcome, "completed"); assert.equal(worker.recoveryError, undefined); assert.equal(f.removed.length, 1);
    assert.equal(f.messages.filter((message) => message.details?.event === "worker_recovery_required" && message.details?.runId === started.runId).length, 0);
  } finally { await f.close(); }
});

test("K4: current newer registration automatically reclaims an older owner after its later death", async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof spawnLifecycleClaimOwner>> | undefined; try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "K4 older owner death" }] }));
    owner = await spawnLifecycleClaimOwner(f, started, "launch");
    await f.reload();
    let db = f.registry(); assert.equal(getWorkerRun(db, started.workerId, started.runId)!.claimNonce, owner.claimed.claimNonce, "new registration preserves the live older owner"); db.close();
    await stopLifecycleClaimOwner(owner.child);
    await waitFor(() => f.launches.length === 1, 4_000);
    db = f.registry(); assert.equal(getWorkerRun(db, started.workerId, started.runId)!.status, "running"); db.close(); assert.equal(f.created.length, 1); assert.equal(f.launches.length, 1);
    const current = await f.reload(); await current.call("worker_control", { action: "cancel", workerId: started.workerId });
  } finally { if (owner) await stopLifecycleClaimOwner(owner.child); await f.close(); }
});

test("foreign-process claim survives while live and is recovered after exact owner death", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const f = await fixture({ ownerWaitTimeoutMs: 80, ownerProbeIntervalMs: 20 }); try {
    assert.ok(child.pid); let startToken: string | undefined; await waitFor(() => Boolean(startToken = asyncJobProcessStartToken(child.pid!)));
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "foreign owner crash" }] }));
    const digest = createHash("sha256").update(startToken!).digest("hex"); const foreignNonce = `1-${child.pid}-${digest}-${randomUUID()}`;
    const db = f.registry(); db.database.prepare("UPDATE runs SET claim_kind='launch',claim_nonce=? WHERE worker_id=? AND run_id=?").run(foreignNonce, started.workerId, started.runId); db.close();
    await assert.rejects(() => f.call("worker_control", { action: "cancel", workerId: started.workerId }), /cancellation remains pending/i);
    let state = f.registry(); assert.equal(getWorkerRun(state, started.workerId, started.runId)!.claimNonce, foreignNonce); assert.equal(getWorker(state, started.workerId)!.recoveryError, undefined); state.close();
    child.kill("SIGKILL"); await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await waitFor(() => { const current = f.registry(); const outcome = getWorkerRun(current, started.workerId, started.runId)?.outcome; current.close(); return outcome === "cancelled"; }, 4_000);
    state = f.registry(); assert.equal(getWorkerRun(state, started.workerId, started.runId)!.outcome, "cancelled", "the current runtime must drive pending intent after exact foreign-owner death without a second cancel"); state.close();
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await f.close(); }
});

test("live-owner wait timeout leaves cancellation pending without a spurious recovery error", async () => {
  const f = await fixture({ deferContainer: true, ownerWaitTimeoutMs: 60, ownerProbeIntervalMs: 20 }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "slow readiness" }] }));
    f.handlers.get("turn_end")![0]!({}, f.context); await waitFor(() => f.created.length === 1);
    await assert.rejects(() => f.call("worker_control", { action: "cancel", workerId: started.workerId }), /cancellation remains pending/i);
    let db = f.registry(); assert.equal(getWorker(db, started.workerId)!.recoveryError, undefined); assert.equal(getWorkerRun(db, started.workerId, started.runId)!.terminalIntent, "cancellation"); db.close();
    f.releaseContainer(); await waitFor(() => { const state = f.registry(); const run = getWorkerRun(state, started.workerId, started.runId); state.close(); return run?.outcome === "cancelled"; }, 4_000);
    db = f.registry(); assert.equal(getWorker(db, started.workerId)!.recoveryError, undefined); db.close();
  } finally { f.releaseContainer(); await f.close(); }
});

test("a host started across revoked authority is retained long enough to cancel", async () => {
  const f = await fixture({ revokeClaimDuringLaunchOnce: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "revoke after spawn" }] }));
    await f.event("turn_end"); await waitFor(() => f.cancelledHandles >= 1); await waitFor(() => f.launches.length >= 2);
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; db.close(); assert.equal(run.status, "running"); assert.equal(f.cancelledHandles, 1);
    await f.call("worker_control", { action: "cancel", workerId: started.workerId });
  } finally { await f.close(); }
});

test("parent process start token is cached and unavailable identity never escapes detached launch", async () => {
  let reads = 0; const f = await fixture({ readProcessStartToken: () => { reads += 1; return "test:cached-parent"; } }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "cached identity" }] })); await f.event("turn_end");
    await f.call("worker_control", { action: "cancel", workerId: started.workerId }); assert.equal(reads, 1);
  } finally { await f.close(); }
  const unhandled: unknown[] = []; const listener = (error: unknown) => unhandled.push(error); process.on("unhandledRejection", listener);
  const unavailable = await fixture({ readProcessStartToken: () => undefined }); try {
    const started = receipt(await unavailable.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "unreadable parent token" }] }));
    unavailable.handlers.get("turn_end")![0]!({}, unavailable.context); await new Promise((resolve) => setTimeout(resolve, 80));
    const db = unavailable.registry(); assert.match(getWorker(db, started.workerId)!.recoveryError ?? "", /start token/i); assert.equal(getWorkerRun(db, started.workerId, started.runId)!.status, "queued"); assert.equal(getWorkerRun(db, started.workerId, started.runId)!.terminalIntent, "failure"); db.close(); assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", listener); await unavailable.close(); }
});

test("ambiguous supervisor identity makes cancellation recovery-required instead of finalizing", async () => {
  const f = await fixture({ probeHostIdentity: () => "unknown" }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "probe ambiguous identity" }] }));
    await f.event("turn_end");
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; const runtime = run.runtime as any; db.close();
    writeFileSync(runtime.processFile, `${JSON.stringify({ version: 2, workerId: started.workerId, runId: started.runId, pid: 4242, processToken: "owned", processStartToken: "darwin:expected", nonce: runtime.processNonce, hostConfigFile: path.join(runtime.runDir, "host.json"), startedAt: new Date().toISOString() })}
`);
    await assert.rejects(() => f.call("worker_control", { action: "cancel", workerId: started.workerId }), /cancellation requires recovery.*ambiguous/i);
    const after = f.registry(); const worker = getWorker(after, started.workerId)!; const retainedRun = getWorkerRun(after, started.workerId, started.runId)!; after.close();
    assert.equal(worker.status, "running"); assert.equal(retainedRun.status, "running"); assert.match(worker.recoveryError ?? "", /ambiguous/i);
    assert.deepEqual(f.removed, [started.runId], "the exact container must be removed and verified despite ambiguous host identity");
  } finally { await f.close(); }
});

test("concurrent resume attempts cross the same CAS boundary without reusing one retained session", async () => {
  let armed = false; let arrivals = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture({ beforeCreateRunBatch: async () => {
    if (!armed) return;
    arrivals += 1;
    if (arrivals === 2) release();
    await gate;
  } });
  try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "initial" }] })); await f.event("turn_end");
    await complete(f, started); armed = true;
    const attempts = await Promise.allSettled([
      f.call("worker_run", { runs: [{ action: "resume", workerId: started.workerId, instructions: "resume A" }] }),
      f.call("worker_run", { runs: [{ action: "resume", workerId: started.workerId, instructions: "resume B" }] })
    ]);
    assert.equal(arrivals, 2, "both resumes must finish preflight before either reaches createWorkerRunBatch");
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const rejected = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected"); assert.ok(rejected);
    assert.match(String(rejected.reason), /changed state/i, "the loser must fail the version/status CAS, not preflight");
    const state = f.registry(); const worker = getWorker(state, started.workerId)!; const queued = Number((state.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE worker_id=? AND status='queued'").get(started.workerId) as any).count); state.close();
    assert.equal(worker.status, "queued"); assert.equal(queued, 1);
    await f.call("worker_control", { action: "cancel", workerId: started.workerId });
  } finally { release(); await f.close(); }
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
    await acknowledgeWorkerDeliveries(f, started.workerId);
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

test("work resume uses bounded session identity for a sparse session beyond 512 MiB", async () => {
  const f = await fixture();
  try {
    const first = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "create retained session" }] }));
    await f.event("turn_end"); await complete(f, first);
    const before = f.registry(); const sessionFile = getWorker(before, first.workerId)!.sessionFile!; const previousEnd = getWorkerRun(before, first.workerId, first.runId)!.sessionEndLine!; before.close();
    const fd = openSync(sessionFile, "r+"); try { ftruncateSync(fd, 600 * 1024 * 1024); } finally { closeSync(fd); }
    const rssBefore = process.memoryUsage().rss; const started = performance.now();
    const resumed = receipt(await f.call("worker_run", { runs: [{ action: "resume", workerId: first.workerId, instructions: "resume a very large retained session" }] }));
    const elapsed = performance.now() - started; const rssGrowth = process.memoryUsage().rss - rssBefore;
    assert.equal(resumed.workerId, first.workerId); assert.ok(elapsed < 1_000, `large resume should not scan the retained session; took ${elapsed}ms`); assert.ok(rssGrowth < 32 * 1024 * 1024, `large resume grew RSS by ${rssGrowth} bytes`);
    let db = f.registry(); assert.equal(getWorkerRun(db, resumed.workerId, resumed.runId)!.sessionStartLine, previousEnd + 1); db.close();
    await f.event("turn_end"); assert.equal(f.launches.some((launch) => launch.record.runId === resumed.runId), true);
    db = f.registry(); assert.equal(getWorkerRun(db, resumed.workerId, resumed.runId)!.sessionStartLine, previousEnd + 1); db.close();
    await f.call("worker_control", { action: "cancel", workerId: resumed.workerId });
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
    detachedLaunch.resolve(detachedLaunch.job("exited", 0));
  } finally {
    for (const handler of secondHandlers.get("session_shutdown") ?? []) await handler({}, f.context);
    await f.close();
  }
});

test("unreceipted idle-origin managed completion is not replayed after its send boundary starts", async () => {
  const f = await fixture();
  try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "retain ambiguous delivery" }] }));
    await f.event("turn_end");
    await complete(f, started);
    await waitFor(() => f.messages.filter((message) => message.details?.event === "worker_settled").length === 1);
    await f.event("agent_end");
    await f.event("agent_end");
    assert.equal(f.messages.filter((message) => message.details?.event === "worker_settled").length, 1, "an accepted send without a receipt is ambiguous even when it began while idle");
    const db = f.registry();
    const delivery = db.database.prepare("SELECT state,runtime_generation,send_started_at FROM deliveries WHERE run_id=?").get(started.runId) as { state: string; runtime_generation: number; send_started_at: string | null };
    assert.equal(delivery.state, "claimed");
    assert.ok(delivery.runtime_generation > 0);
    assert.ok(delivery.send_started_at, "the durable send boundary prevents an automatic duplicate");
    db.close();
  } finally { await f.close(); }
});

test("agent_end acknowledges exact same-session completion history without replay or model steering", async () => {
  const f = await fixture();
  try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "reconcile exact receipt" }] }));
    await f.event("turn_end");
    await complete(f, started);
    await waitFor(() => f.messages.filter((message) => message.details?.event === "worker_settled").length === 1);
    const deliveryId = `worker-run:${started.workerId}:${started.runId}`;
    let db = f.registry();
    const before = db.database.prepare("SELECT state,send_started_at FROM deliveries WHERE run_id=?").get(started.runId) as { state: string; send_started_at: string | null };
    assert.equal(before.state, "claimed"); assert.ok(before.send_started_at); db.close();

    f.session.appendCustomMessageEntry("model-tool-arguments", "untrusted nested tool call", false, { toolCall: { name: "fixture_tool", arguments: { deliveryId } } });
    f.session.appendCustomMessageEntry("other-extension", "nested argument", false, { event: "worker_settled", workerId: started.workerId, runId: started.runId, deliveryId });
    f.session.appendCustomMessageEntry("worker-run", "wrong event", true, { event: "worker_progress", workerId: started.workerId, runId: started.runId, deliveryId });
    f.session.appendCustomMessageEntry("worker-run", "wrong exact ID", true, { event: "worker_settled", workerId: started.workerId, runId: started.runId, deliveryId: `${deliveryId}-other` });
    const sendAttempts = f.messageAttempts.length;
    await f.event("agent_end");
    db = f.registry(); assert.equal((db.database.prepare("SELECT state FROM deliveries WHERE run_id=?").get(started.runId) as { state: string }).state, "claimed", "nested model/tool arguments and non-exact custom entries are never receipt evidence"); db.close();
    assert.equal(f.messageAttempts.length, sendAttempts, "rejected receipt lookalikes cannot send or steer");

    f.session.appendCustomMessageEntry("worker-run", JSON.stringify({ event: "worker_settled", workerId: started.workerId, runId: started.runId }), true, { event: "worker_settled", workerId: started.workerId, runId: started.runId, deliveryId });
    await f.event("agent_end");

    db = f.registry();
    const after = db.database.prepare("SELECT state,delivered_at FROM deliveries WHERE run_id=?").get(started.runId) as { state: string; delivered_at: string | null };
    assert.equal(after.state, "delivered"); assert.ok(after.delivered_at); db.close();
    assert.equal(f.messageAttempts.length, sendAttempts, "history reconciliation never invokes sendMessage or starts a model turn");
    assert.equal(f.messages.filter((message) => message.details?.event === "worker_settled").length, 1, "history reconciliation never replays the managed completion");
    const shown = await f.call("worker_control", { action: "get", workerId: started.workerId, runId: started.runId });
    const visible = JSON.parse((shown.content[0] as any).text);
    assert.equal(visible.notification.state, "delivered"); assert.equal(visible.notification.runId, started.runId);
  } finally { await f.close(); }
});

test("message_end acknowledges only the exact managed completion message without replay or steering", async () => {
  const f = await fixture();
  try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "acknowledge exact message receipt" }] }));
    await f.event("turn_end");
    await complete(f, started);
    await waitFor(() => f.messageAttempts.filter((message) => message.details?.runId === started.runId).length === 1);
    const attempted = f.messageAttempts.find((message) => message.details?.runId === started.runId)!;
    const deliveryId = `worker-run:${started.workerId}:${started.runId}`;
    const exactDetails = { ...attempted.details, event: "worker_settled", workerId: started.workerId, runId: started.runId, deliveryId };
    const lookalikes = [
      { role: "toolResult", customType: "worker-run", details: exactDetails },
      { role: "assistant", customType: "worker-run", details: exactDetails },
      { role: "custom", customType: "third-party", details: exactDetails },
      { role: "custom", customType: "worker-run", details: { ...exactDetails, event: "tool_result" } },
      { role: "custom", customType: "worker-run", details: { ...exactDetails, deliveryId: `${deliveryId}-other` } },
      { role: "toolResult", details: { result: { customType: "worker-run", details: exactDetails } } },
      { type: "custom_message", customType: "worker-run", details: exactDetails }
    ];
    const sendAttempts = f.messageAttempts.length; const acceptedMessages = f.messages.length;
    for (const message of lookalikes) await f.event("message_end", { message });
    let db = f.registry();
    assert.equal((db.database.prepare("SELECT state FROM deliveries WHERE run_id=?").get(started.runId) as { state: string }).state, "claimed", "tool results, wrong roles/custom types, malformed events, mismatched IDs, and session-entry lookalikes are not message receipts"); db.close();
    assert.equal(f.messageAttempts.length, sendAttempts); assert.equal(f.messages.length, acceptedMessages, "rejected message receipts never send, replay, or steer");

    await f.event("message_end", { message: { role: "custom", customType: "worker-run", content: attempted.content, display: true, details: exactDetails, timestamp: Date.now() } });
    db = f.registry();
    const delivered = db.database.prepare("SELECT state,delivered_at FROM deliveries WHERE run_id=?").get(started.runId) as { state: string; delivered_at: string | null };
    assert.equal(delivered.state, "delivered"); assert.ok(delivered.delivered_at); db.close();
    assert.equal(f.messageAttempts.length, sendAttempts); assert.equal(f.messages.length, acceptedMessages, "exact acknowledgement is receipt-only and never sends, replays, or steers");
  } finally { await f.close(); }
});

test("managed completion accepted while active is not ambiguously retried at agent_end", async () => {
  const f = await fixture();
  try {
    (f.context as unknown as { isIdle: () => boolean }).isIdle = () => false;
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "active delivery" }] }));
    await f.event("turn_end");
    await complete(f, started);
    await waitFor(() => f.messages.filter((message) => message.details?.event === "worker_settled").length === 1);
    await f.event("agent_end");
    assert.equal(f.messages.filter((message) => message.details?.event === "worker_settled").length, 1, "an active-origin send may still be queued and must not be duplicated");
    const db = f.registry();
    const delivery = db.database.prepare("SELECT state,runtime_generation FROM deliveries WHERE run_id=?").get(started.runId) as { state: string; runtime_generation: number };
    assert.equal(delivery.state, "claimed");
    assert.ok(delivery.runtime_generation > 0);
    db.close();
  } finally { await f.close(); }
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
      launch.resolve(launch.job("exited", 0));
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
    detached.resolve(detached.job("exited", 0));
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

test("only completed work and integration outcomes are review-ready", async () => {
  const f = await fixture(); try {
    const blocked = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] }));
    await f.event("turn_end"); await complete(f, blocked, { outcome: "blocked", summary: "External prerequisite." });
    await assert.rejects(f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: blocked.runId }] }), /not eligible/);
  } finally { await f.close(); }
});

test("review selection is provider-independent and fails closed without an alternative provider", async () => {
  const f = await fixture(); try {
    const anthropicSubject = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject", modelSelection: "anthropic/claude-opus-5-5:xhigh" }] }));
    await f.event("turn_end"); await complete(f, anthropicSubject);
    const openaiReview = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: anthropicSubject.runId }] }));
    let db = f.registry(); assert.equal(getWorker(db, openaiReview.workerId)!.modelSelection, "openai-codex/gpt-5.6-sol:xhigh"); db.close();
    await f.event("turn_end"); await f.call("worker_control", { action: "cancel", workerId: openaiReview.workerId });
  } finally { await f.close(); }

  const onlyOpenAi = await fixture({ models: [model("openai-codex", "gpt-5.6-sol")] }); try {
    const subject = receipt(await onlyOpenAi.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] }));
    await onlyOpenAi.event("turn_end"); await complete(onlyOpenAi, subject);
    await assert.rejects(onlyOpenAi.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId }] }), /independent from subject provider openai-codex/);
  } finally { await onlyOpenAi.close(); }

  const missingProvenance = await fixture(); try {
    const subject = receipt(await missingProvenance.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] }));
    await missingProvenance.event("turn_end"); await complete(missingProvenance, subject);
    const db = missingProvenance.registry(); db.database.prepare("UPDATE runs SET model_selection=NULL WHERE run_id=?").run(subject.runId); db.close();
    await assert.rejects(missingProvenance.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId }] }), /no model provider provenance/);
  } finally { await missingProvenance.close(); }
});

test("review creation refuses an unauthenticated independent provider without residue", async () => {
  const f = await fixture({ authenticatedProviders: ["openai-codex"] }); try {
    const subject = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] }));
    await f.event("turn_end"); await complete(f, subject);
    const before = readdirSync(f.workersRoot).sort();
    await assert.rejects(f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId }] }), /No configured review model selection independent from subject provider openai-codex.*no configured auth/i);
    const db = f.registry(); const rows = listWorkers(db, { parentSessionFile: realpathSync(f.session.getSessionFile()!) });
    assert.equal(rows.total, 1); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, undefined); db.close();
    assert.deepEqual(readdirSync(f.workersRoot).sort(), before);
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
    assert.equal(f.cleaned.length, 1, "review cancellation must remove its exact disposable overlay");
    assert.equal(f.cleaned[0]!.mergedVolume, runtime.overlay.mergedVolume, "cleanup must target the exact run overlay identity");
    assert.equal(f.cleanupLeaseOwners[0], review.workerId, "overlay cleanup must occur before finalization releases the exact review lease");
    const resumed = receipt(await f.call("worker_run", { runs: [{ action: "resume", workerId: review.workerId, instructions: "continue" }] })); await f.event("turn_end"); db = f.registry(); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, review.workerId); const resumedRuntime = getWorkerRun(db, review.workerId, resumed.runId)!.runtime as any; assert.notEqual(resumedRuntime.overlay.mergedVolume, runtime.overlay.mergedVolume); assert.equal((getWorker(db, review.workerId)!.runtime?.inputs as any[]).length, 1); db.close();
    await f.call("worker_control", { action: "cancel", workerId: review.workerId }); await acknowledgeWorkerDeliveries(f, review.workerId); await f.call("worker_control", { action: "discard", workerIds: [review.workerId], artifactLossAcknowledged: [review.workerId] }); db = f.registry(); assert.equal(getWorker(db, review.workerId), undefined); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, undefined); db.close();
  } finally { await f.close(); }
});


test("review resume rejects retained same-provider provenance without creating a run or lease", async () => {
  const f = await fixture(); try {
    const subject = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] })); await f.event("turn_end"); await complete(f, subject);
    const review = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId }] }));
    await f.call("worker_control", { action: "cancel", workerId: review.workerId });
    let db = f.registry(); db.database.prepare("UPDATE workers SET model_selection=? WHERE worker_id=?").run("openai-codex/gpt-5.6-sol:xhigh", review.workerId); db.database.prepare("UPDATE runs SET model_selection=? WHERE worker_id=?").run("openai-codex/gpt-5.6-sol:xhigh", review.workerId);
    const runCount = Number((db.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE worker_id=?").get(review.workerId) as any).count); const runDirectory = path.join(f.workersRoot, review.workerId, "runs"); const before = readdirSync(runDirectory).sort(); db.close();
    await assert.rejects(f.call("worker_run", { runs: [{ action: "resume", workerId: review.workerId, instructions: "continue" }] }), /not independent from the subject provider openai-codex/);
    db = f.registry(); assert.equal(Number((db.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE worker_id=?").get(review.workerId) as any).count), runCount); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, undefined); db.close();
    assert.deepEqual(readdirSync(runDirectory).sort(), before);
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

test("integration starts fresh, resumes with retained context, and exposes its completed run for independent review", async () => {
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
    await f.event("turn_end"); await complete(f, resumed);
    const review = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: resumed.runId }] })); db = f.registry(); assert.equal(getWorker(db, review.workerId)!.modelSelection, "anthropic/claude-opus-5-5:xhigh"); assert.deepEqual(getWorkerRun(db, review.workerId, review.runId)!.binding, { reviewedWorkerId: resumed.workerId, reviewedRunId: resumed.runId }); db.close();
    await f.call("worker_control", { action: "cancel", workerId: review.workerId }); await acknowledgeWorkerDeliveries(f, review.workerId); await acknowledgeWorkerDeliveries(f, resumed.workerId); await f.call("worker_control", { action: "discard", workerIds: [review.workerId], artifactLossAcknowledged: [review.workerId] }); await f.call("worker_control", { action: "discard", workerIds: [resumed.workerId], artifactLossAcknowledged: [resumed.workerId] }); db = f.registry(); assert.equal(getWorker(db, resumed.workerId), undefined); const retainedPrepared = db.database.prepare("SELECT prepared_id FROM prepared_sets WHERE prepared_id=?").get(prepared.preparedId); assert.equal(retainedPrepared, undefined); db.close();
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



test("post-containment evidence failure alone uses the bounded failed settlement path", async () => {
  const f = await fixture(); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "corrupt settled evidence" }] })); await f.event("turn_end");
    const launch = writeCompletionEvidence(f, started, { outcome: "completed", summary: "accepted but mismatched settlement" });
    const settled = JSON.parse(readFileSync(launch.runtime.settledFile, "utf8")); writeFileSync(launch.runtime.settledFile, `${JSON.stringify({ ...settled, workerId: "worker_mismatch" })}\n`);
    launch.resolve(launch.job("exited", 0));
    await waitFor(() => { const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId); db.close(); return run?.status === "settled"; }, 6_000);
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; const worker = getWorker(db, started.workerId)!; db.close();
    assert.equal(run.outcome, "failed"); assert.equal(run.outcomeSource, "system"); assert.equal(worker.status, "idle"); assert.equal((run.runtime as any).settlementRecoveryAttempts, 3);
    assert.match(run.errors[0]!.message, /Accepted result completed remains retained/); assert.equal(f.removed.length, 3, "each deterministic attempt must first repeat exact containment proof");
  } finally { await f.close(); }
});

test("persistent exact-container cleanup failure retains recovery authority without aging into finalization", async () => {
  const f = await fixture({ removeAlwaysThrows: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "settle persistently" }] })); await f.event("turn_end");
    const launch = writeCompletionEvidence(f, started, { outcome: "completed", summary: "accepted before cleanup failure" }); launch.resolve(launch.job("exited", 0));
    await waitFor(() => f.removed.length >= 3, 8_000);
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; const worker = getWorker(db, started.workerId)!; const runtime = run.runtime as any; db.close();
    assert.equal(run.status, "running"); assert.equal(run.outcome, undefined); assert.equal(worker.status, "running");
    assert.equal(runtime.settlementRecoveryAttempts, undefined, "containment failures must not increment the finalizable settlement-attempt counter");
    assert.equal(existsSync(runtime.resultFile), true); assert.equal(JSON.parse(readFileSync(runtime.resultFile, "utf8")).result.outcome, "completed");
    assert.equal(existsSync(path.join(runtime.runDir, "host-authorization.json")), false, "every retry must keep launch authority revoked");
    await assert.rejects(() => f.call("worker_run", { runs: [{ action: "resume", workerId: started.workerId, instructions: "must not overlap" }] }), /not idle/);
  } finally { await f.close(); }
});

test("a provably live host is SIGKILLed before probing and never finalizes while it survives", async () => {
  const events: string[] = [];
  const f = await fixture({ probeHostIdentity: () => { events.push("probe"); return "alive"; }, signalHostIdentity: (_identity, signal) => { events.push(signal); return true; } }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "retain live host" }] })); await f.event("turn_end");
    const db0 = f.registry(); const runtime = getWorkerRun(db0, started.workerId, started.runId)!.runtime as any; db0.close();
    writeFileSync(runtime.processFile, `${JSON.stringify({ version: 2, workerId: started.workerId, runId: started.runId, pid: 4242, processToken: "owned", processStartToken: "darwin:expected", nonce: runtime.processNonce, hostConfigFile: path.join(runtime.runDir, "host.json"), startedAt: new Date().toISOString() })}\n`);
    const launch = writeCompletionEvidence(f, started, { outcome: "completed", summary: "accepted while host survives" }); launch.resolve(launch.job("exited", 0));
    await waitFor(() => events.includes("SIGKILL") && f.removed.length >= 1, 3_000); await new Promise((resolve) => setTimeout(resolve, 25));
    const firstKill = events.indexOf("SIGKILL"); assert.ok(firstKill >= 2, `grace probes must precede SIGKILL: ${events.join(",")}`); assert.ok(events.slice(firstKill + 1).includes("probe"), `post-SIGKILL absence probes must follow the signal: ${events.join(",")}`);
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; const worker = getWorker(db, started.workerId)!; db.close();
    assert.equal(run.status, "running"); assert.equal(run.outcome, undefined); assert.equal(worker.status, "running"); assert.match(worker.recoveryError ?? "", /remained alive/i);
    assert.equal((run.runtime as any).settlementRecoveryAttempts, undefined); assert.ok(f.removed.length >= 1);
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
    await f.commands.get("worker:list").handler("", f.context); assert.match(f.notifications.at(-1)!, /queued · work/); assert.doesNotMatch(f.notifications.at(-1)!, /send_started_unconfirmed|^\{/);
    await f.commands.get("worker:show").handler(`${started.workerId} ${started.runId}`, f.context); assert.match(f.notifications.at(-1)!, new RegExp(started.runId));
    await f.commands.get("worker:cancel").handler(started.workerId, f.context); assert.match(f.notifications.at(-1)!, /Cancelled/); await acknowledgeWorkerDeliveries(f, started.workerId);
    await f.commands.get("worker:discard").handler(`${started.workerId} --confirm`, f.context); assert.match(f.notifications.at(-1)!, /Discarded/);
  } finally { await f.close(); }
});

function gitInit(repo: string): void { mkdirSync(repo, { recursive: true }); execFileSync("git", ["init", "-q", "-b", "main", repo]); git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.invalid"); }
function git(repo: string, ...args: string[]): string { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim(); }
function readDirs(root: string): string[] { return readdirSync(root).filter((name) => !name.startsWith(".")); }

test("cleanup_inventory preview and one-use apply discard a delivered closed-task worker through real host logs", async () => {
  const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-cleanup"],instructions:"cleanup"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);
    const inventory=await f.call("worker_control",{action:"cleanup_inventory"}) as any;const item=inventory.details.inventory.workers.find((value:any)=>value.workerId===started.workerId);assert.equal(item.class,"due");assert.equal(typeof item.version,"number");
    const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;assert.match(preview.details.token,/^cleanup_[a-f0-9]{48}$/);const logDir=f.launches.find((value)=>value.record.runId===started.runId)!.job("exited",0).logDir;
    const applied=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}) as any;assert.equal(applied.details.cleanup.results[0].status,"discarded");const db=f.registry();assert.equal(getWorker(db,started.workerId),undefined);db.close();assert.equal(existsSync(logDir),false);await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}),/consumed/);
  }finally{await f.close();}
});

test("cleanup_apply rejects a stale version without consuming the persisted preview", async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-stale"],instructions:"stale"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;let db=f.registry();db.database.prepare("UPDATE workers SET version=version+1 WHERE worker_id=?").run(started.workerId);db.close();await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}),/stale/);db=f.registry();assert.equal((db.database.prepare("SELECT consumed_at FROM cleanup_snapshots WHERE token=?").get(preview.details.token) as any).consumed_at,null);db.close();}finally{await f.close();}
});

test("cleanup_apply binds exact open-task abandonment consent",async()=>{
 const f=await fixture({beadsStatus:"open"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-open"],instructions:"open"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}),/Open-task abandonment/);const applied=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token,openTaskAbandonmentAcknowledged:[started.workerId]}) as any;assert.equal(applied.details.cleanup.results[0].status,"discarded");}finally{await f.close();}
});

test("cleanup notices are generation-scoped and Beads-unavailable state alone stays silent",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-notice"],instructions:"notice"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const before=f.messages.length;await f.event("agent_end");await waitFor(()=>f.messages.length>before);const first=f.messages.filter((message)=>message.details?.event==="worker_cleanup_due").length;await f.event("agent_end");await new Promise((resolve)=>setTimeout(resolve,100));assert.equal(f.messages.filter((message)=>message.details?.event==="worker_cleanup_due").length,first);const reloaded=await f.reload();await reloaded.event("agent_end");await waitFor(()=>f.messages.filter((message)=>message.details?.event==="worker_cleanup_due").length>first);
 }finally{await f.close();}
 const unavailable=await fixture({beadsStatus:"unavailable"});try{const started=receipt(await unavailable.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-unavailable"],instructions:"silent"}]}));await unavailable.event("turn_end");await complete(unavailable,started);await acknowledgeWorkerDeliveries(unavailable,started.workerId);const before=unavailable.messages.length;await unavailable.event("agent_end");await new Promise((resolve)=>setTimeout(resolve,150));assert.equal(unavailable.messages.length,before);}finally{await unavailable.close();}
});

test("cleanup_apply continues after an exact host-log preflight failure without claiming the failed worker",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const batch=await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-batch-one"],instructions:"one"},{action:"start",role:"work",taskIds:["personal-batch-two"],instructions:"two"}]}) as any;const [first,second]=batch.details.runs;await f.event("turn_end");await complete(f,first);await complete(f,second);await acknowledgeWorkerDeliveries(f,first.workerId);await acknowledgeWorkerDeliveries(f,second.workerId);const badLaunch=f.launches.find((value)=>value.record.runId===first.runId)!;const metaPath=path.join(badLaunch.job("exited",0).logDir,"meta.json");const meta=JSON.parse(readFileSync(metaPath,"utf8"));writeFileSync(metaPath,JSON.stringify({...meta,command:"not the exact worker host"}));const beforeVersion=(()=>{const db=f.registry();const version=getWorker(db,first.workerId)!.version;db.close();return version;})();const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[first.workerId,second.workerId]}) as any;const applied=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}) as any;assert.equal(applied.isError,true);assert.equal(applied.details.cleanup.results.find((item:any)=>item.id===first.workerId).status,"failed");assert.equal(applied.details.cleanup.results.find((item:any)=>item.id===second.workerId).status,"discarded");const db=f.registry();const retained=getWorker(db,first.workerId)!;assert.equal(retained.operationKind,undefined);assert.equal(retained.version,beforeVersion);assert.equal(getWorker(db,second.workerId),undefined);db.close();}finally{await f.close();}
});

test("first agent_end reports other-session cleanup even when the current session owns zero workers",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-other"],instructions:"other"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const oldSeed=SessionManager.create(f.root,path.join(f.root,"retired-parent"),{id:"retired"});writeFileSync(oldSeed.getSessionFile()!,`${JSON.stringify(oldSeed.getHeader())}\n`);const oldManager=SessionManager.open(oldSeed.getSessionFile()!,oldSeed.getSessionDir());oldManager.appendSessionInfo("Earlier owner name");oldManager.appendSessionInfo("Retired cleanup owner");const old=oldManager.getSessionFile()!;const db=f.registry();db.database.prepare("UPDATE workers SET parent_session_file=?,version=version+1 WHERE worker_id=?").run(path.resolve(old),started.workerId);db.close();const before=f.messages.length;await f.event("agent_end");await waitFor(()=>f.messages.length>before);const notice=f.messages.at(-1)!.details;assert.equal(notice.workers.length,0);assert.equal(notice.otherSessions.length,1);assert.equal(notice.otherSessions[0].owner.state,"named");assert.equal(notice.otherSessions[0].workerIds[0],started.workerId);await f.event("agent_end");await new Promise((resolve)=>setTimeout(resolve,100));assert.equal(f.messages.length,before+1);}finally{await f.close();}
});

test("an irreversible discard host-log failure is retained and completed by fresh-generation recovery",async()=>{
 const f=await fixture({beadsStatus:"closed",cleanupHostLogRaceOnce:true});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-recover-discard"],instructions:"recover discard"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const result=await f.call("worker_control",{action:"discard",workerId:started.workerId}) as any;assert.equal(result.isError,true);let db=f.registry();const interrupted=getWorker(db,started.workerId)!;assert.equal(interrupted.operationKind,"discard");assert.match(interrupted.recoveryError??"",/Irreversible discard/);db.close();assert.equal(existsSync(path.join(f.workersRoot,started.workerId)),false);assert.equal(readdirSync(f.workersRoot).some((name)=>name.startsWith(`${started.workerId}.discard-`)),true);await f.reload();await waitFor(()=>{const check=f.registry();const absent=getWorker(check,started.workerId)===undefined;check.close();return absent;});assert.equal(readdirSync(f.workersRoot).some((name)=>name.startsWith(`${started.workerId}.discard-`)),false);}finally{await f.close();}
});

test("current-session pending completion is ineligible for cleanup preview and apply",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-current-pending"],instructions:"pending"}]}));await f.event("turn_end");await complete(f,started);await assert.rejects(()=>f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}),/Current-session.*non-delivered/);const db=f.registry();assert.ok(getWorker(db,started.workerId));db.close();}finally{await f.close();}
});

test("spawned foreign owner liveness, recovery race, death takeover, and stale delivery CAS are fail-closed",async()=>{
 const f=await fixture({beadsStatus:"closed"});let first:ReturnType<typeof spawn>|undefined,revived:ReturnType<typeof spawn>|undefined;try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-foreign-owner"],instructions:"foreign"}]}));await f.event("turn_end");await complete(f,started);const ownerSeed=SessionManager.create(f.root,path.join(f.root,"foreign-owner"),{id:"foreign-owner"});writeFileSync(ownerSeed.getSessionFile()!,`${JSON.stringify(ownerSeed.getHeader())}\n`);const ownerManager=SessionManager.open(ownerSeed.getSessionFile()!,ownerSeed.getSessionDir());ownerManager.appendSessionInfo("Earlier foreign name");ownerManager.appendSessionInfo("Foreign cleanup owner");const foreign=ownerManager.getSessionFile()!;let db=f.registry();db.database.prepare("UPDATE workers SET parent_session_file=?,version=version+1 WHERE worker_id=?").run(realpathSync(foreign),started.workerId);db.database.prepare("UPDATE deliveries SET parent_session_file=?,state='pending',runtime_generation=NULL,send_started_at=NULL WHERE worker_id=?").run(realpathSync(foreign),started.workerId);db.close();const live=await spawnDeliveryClaimOwner(f,started,foreign);first=live.child;const claimed=await live.claim();const previewLive=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;assert.equal(previewLive.details.workers[0].authority.state,"live");assert.equal(previewLive.details.workers[0].worker.owner.name,"Foreign cleanup owner");await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:previewLive.details.token,claimedDeliveryTakeoverAcknowledged:[started.workerId]}),/live or ambiguous/);await stopLifecycleClaimOwner(first);first=undefined;const deadPreview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;assert.equal(deadPreview.details.workers[0].authority.state,"dead");const recoveryOwner=await spawnDeliveryClaimOwner(f,started,foreign);revived=recoveryOwner.child;await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:deadPreview.details.token,claimedDeliveryTakeoverAcknowledged:[started.workerId]}),/stale|authority/i);await stopLifecycleClaimOwner(revived);revived=undefined;const finalPreview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;const applied=await f.call("worker_control",{action:"cleanup_apply",token:finalPreview.details.token,claimedDeliveryTakeoverAcknowledged:[started.workerId]}) as any;assert.equal(applied.details.cleanup.results[0].status,"discarded");db=f.registry();assert.equal(Number(db.database.prepare("UPDATE deliveries SET delivered_at='late' WHERE delivery_id=? AND state='claimed' AND runtime_generation=?").run(`worker-run:${started.workerId}:${started.runId}`,claimed.generation).changes),0);db.close();}finally{if(first)await stopLifecycleClaimOwner(first);if(revived)await stopLifecycleClaimOwner(revived);await f.close();}
});

test("missing foreign owner pending takeover requires exact acknowledgement",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-missing-owner"],instructions:"missing"}]}));await f.event("turn_end");await complete(f,started);const missing=path.join(f.root,"missing-owner.jsonl");const db=f.registry();db.database.prepare("UPDATE workers SET parent_session_file=?,version=version+1 WHERE worker_id=?").run(path.resolve(missing),started.workerId);db.database.prepare("UPDATE deliveries SET parent_session_file=?,state='pending',runtime_generation=NULL,send_started_at=NULL WHERE worker_id=?").run(path.resolve(missing),started.workerId);db.close();const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;assert.equal(preview.details.workers[0].authority.state,"missing");await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}),/Pending-delivery takeover/);const applied=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token,pendingDeliveryTakeoverAcknowledged:[started.workerId]}) as any;assert.equal(applied.details.cleanup.results[0].status,"discarded");}finally{await f.close();}
});

test("failed adopted open-task cleanup stays with adopter and exact recovery retry succeeds",async()=>{
 const f=await fixture({beadsStatus:"open",discardRootFailsOnce:true});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-open-recovery"],instructions:"recover"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const missing=path.join(f.root,"gone-owner.jsonl");let db=f.registry();db.database.prepare("UPDATE workers SET parent_session_file=?,version=version+1 WHERE worker_id=?").run(path.resolve(missing),started.workerId);db.close();const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;const failed=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token,openTaskAbandonmentAcknowledged:[started.workerId]}) as any;assert.equal(failed.isError,true);db=f.registry();const retained=getWorker(db,started.workerId)!;assert.equal(retained.parentSessionFile,realpathSync(f.session.getSessionFile()!));assert.match(retained.recoveryError??"",/injected root claim failure/);assert.equal((retained.runtime as any).cleanupConsent.openTaskAbandonmentAcknowledged[0],started.workerId);db.close();const retry=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:retry.details.token,openTaskAbandonmentAcknowledged:[started.workerId]}),/Recovery retry/);const applied=await f.call("worker_control",{action:"cleanup_apply",token:retry.details.token,openTaskAbandonmentAcknowledged:[started.workerId],recoveryAcknowledged:[started.workerId]}) as any;assert.equal(applied.details.cleanup.results[0].status,"discarded");}finally{await f.close();}
});

test("spawned crash after adoption and claim recovers adopter ownership, open-task consent, and host logs",async()=>{
 const f=await fixture({beadsStatus:"open"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-crash-open"],instructions:"crash"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const missing=path.join(f.root,"crashed-owner.jsonl");let db=f.registry();db.database.prepare("UPDATE workers SET parent_session_file=?,version=version+1 WHERE worker_id=?").run(path.resolve(missing),started.workerId);db.close();const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;db=f.registry();const persisted=loadCleanupSnapshot(db,realpathSync(f.session.getSessionFile()!),preview.details.token);db.close();const snapshotFile=path.join(f.root,"cleanup-crash-snapshot.json");writeFileSync(snapshotFile,JSON.stringify(persisted.snapshot.workers));const child=spawn(process.execPath,[cleanupCrashFixture,f.runtimeRoot,realpathSync(f.session.getSessionFile()!),snapshotFile],{stdio:["ignore","ignore","pipe","ipc"]});await new Promise<void>((resolve,reject)=>{let stderr="";child.stderr?.on("data",(chunk)=>stderr+=String(chunk));child.on("message",(message:any)=>{if(message?.event==="adopted")resolve();});child.once("error",reject);child.once("exit",(code)=>{if(code)reject(new Error(stderr));});});await new Promise<void>((resolve)=>child.once("exit",()=>resolve()));await f.reload();db=f.registry();const recovered=getWorker(db,started.workerId)!;assert.equal(recovered.parentSessionFile,realpathSync(f.session.getSessionFile()!));assert.match(recovered.recoveryError??"",/rolled back before the root claim/);assert.equal((recovered.runtime as any).cleanupConsent.openTaskAbandonmentAcknowledged[0],started.workerId);const run=getWorkerRun(db,started.workerId,started.runId)!;const hostLog=path.dirname(run.stdoutLog!);db.close();const retry=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;const applied=await f.call("worker_control",{action:"cleanup_apply",token:retry.details.token,openTaskAbandonmentAcknowledged:[started.workerId],recoveryAcknowledged:[started.workerId]}) as any;assert.equal(applied.details.cleanup.results[0].status,"discarded");assert.equal(existsSync(hostLog),false);}finally{await f.close();}
});

test("actual worker cleanup slash command previews and confirms exact current-session cleanup",async()=>{
 const f=await fixture({beadsStatus:"closed",tui:true});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-slash-cleanup"],instructions:"slash"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const command=f.commands.get("worker:cleanup");await command.handler("",f.context);const previewNotice=f.notifications.at(-1)!;const token=/cleanup_[a-f0-9]{48}/.exec(previewNotice)?.[0];assert.ok(token);await command.handler(`--confirm ${token}`,f.context);const db=f.registry();assert.equal(getWorker(db,started.workerId),undefined);db.close();assert.match(f.notifications.at(-1)!,/applied/);}finally{await f.close();}
});

test("cleanup preview reports an active reviewer instead of an inconsistent lease",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const subject=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-active-review"],instructions:"subject"}]}));await f.event("turn_end");await complete(f,subject);await acknowledgeWorkerDeliveries(f,subject.workerId);const reviewer=receipt(await f.call("worker_run",{runs:[{action:"start",role:"review",reviewedRunId:subject.runId,instructions:"review"}]}));await f.event("turn_end");const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[subject.workerId]}) as any;const classes=new Map(preview.details.workers.map((item:any)=>[item.worker.workerId,item.worker.class]));assert.equal(classes.get(reviewer.workerId),"active");assert.equal(classes.get(subject.workerId),"leased");}finally{await f.close();}
});

test("cleanup apply warns when explicitly discarding a partial prepared set",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const preparedId=`prepared_${"f".repeat(24)}`;const db=f.registry();storePreparedSet(db,{preparedId,parentSessionFile:realpathSync(f.session.getSessionFile()!),status:"partial",order:["repo"],taskIds:["personal-partial"],repositories:[{id:"repo",taskIds:["personal-partial"]}],createdAt:"2026-01-01T00:00:00.000Z"});db.close();const preview=await f.call("worker_control",{action:"cleanup_preview",preparedIds:[preparedId]}) as any;const applied=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}) as any;assert.equal(applied.details.cleanup.results[0].status,"discarded");assert.match(applied.details.cleanup.results[0].warning,/partially applied/);}finally{await f.close();}
});

test("cleanup notice dedupe is scoped by parent session and equal runtime generation",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-session-scope"],instructions:"scope"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);await f.event("agent_end");await waitFor(()=>f.messages.some((item)=>item.details?.event==="worker_cleanup_due"));const before=f.messages.length;const next=SessionManager.create(f.root,path.join(f.root,"second-parent"),{id:"second-parent"});writeFileSync(next.getSessionFile()!,`${JSON.stringify(next.getHeader())}\n`);f.switchSession(next);await f.event("session_start");await f.event("agent_end");await waitFor(()=>f.messages.length>before);const notice=f.messages.at(-1)!.details;assert.equal(notice.otherSessions[0].workerIds[0],started.workerId);}finally{await f.close();}
});

test("other-session cleanup aggregate paginates beyond one hundred workers and marks completion",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const db=f.registry(),owner=path.join(f.root,"missing-bulk-owner.jsonl");for(let index=0;index<101;index+=1){const suffix=index.toString(16).padStart(8,"0"),workerId=`worker_20260101010101_${suffix}`,runId=`run_20260101010101_${suffix}`,createdAt=`2026-01-01T00:00:${String(index%60).padStart(2,"0")}.000Z`;createWorkerAndRun(db,{workerId,parentSessionFile:owner,role:"work",status:"idle",latestRunId:runId,taskIds:[`personal-bulk-${index}`],workspaceRoot:path.join(f.workersRoot,workerId,"workspace"),runtime:{},createdAt,updatedAt:createdAt},{runId,workerId,status:"settled",taskIds:[`personal-bulk-${index}`],completionDelivery:"steer",outcome:"completed",outcomeSource:"worker",summary:"done",repositories:[],artifacts:[],errors:[],runtime:{},createdAt,settledAt:createdAt});}db.close();const before=f.messages.length;await f.event("agent_end");await waitFor(()=>f.messages.length>before,10_000);const notice=f.messages.at(-1)!.details;assert.equal(notice.otherSessions.length,1);assert.equal(notice.otherSessions[0].workerIds.length,8);assert.equal(notice.otherSessions[0].additionalWorkers,93);assert.equal(notice.otherSessionsPartial,false);}finally{await f.close();}
});
