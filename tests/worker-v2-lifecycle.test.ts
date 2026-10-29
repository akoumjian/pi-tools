import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerWorkerExtension } from "../extensions/worker/index.js";
import { createWorkerAndRun, getWorker, getWorkerRun, listWorkers, openWorkerRegistry, registerParentRuntime, storePreparedSet } from "../extensions/worker/registry.js";
import type { ManagedAsyncJobHandle, JobMeta } from "../extensions/async-shell/index.js";
import { asyncJobProcessStartToken } from "../extensions/_shared/async-job.js";
import { workerHostJobIdentity } from "../extensions/_shared/worker-host-job.js";
import { prepareWorkerMerges } from "../extensions/worker/merge.js";
import { loadCleanupSnapshot, planSettledWorkerHostLogs } from "../extensions/worker/cleanup.js";

const model = (provider: string, id: string) => ({ id, name: id, provider, api: "openai-responses", baseUrl: "https://example.invalid", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 }) as Model<Api>;

type Launch = { record: any; runtime: any; resolve(job: JobMeta): void; handle: ManagedAsyncJobHandle; job(status: JobMeta["status"], exitCode?: number): JobMeta };
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(options: { launchThrows?: boolean; mountThrows?: boolean; removeThrowsOnce?: boolean; removeAlwaysThrows?: boolean; deferSandbox?: boolean; sandboxRelease?: any; tui?: boolean; cleanupHostLogRaceOnce?: boolean; discardRootFailsOnce?: boolean; beadsStatus?: "closed" | "open" | "unavailable" } = {}) {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "pi-worker-v2-lifecycle-")));
  const runtimeRoot = path.join(root, "runtime"); const workersRoot = path.join(runtimeRoot, "workers"); mkdirSync(workersRoot, { recursive: true });
  const bdPath = path.join(root, "bd"); const beadsStatus = options.beadsStatus ?? "closed";
  writeFileSync(bdPath, `#!/usr/bin/env node
const a=process.argv.slice(2);if(a[0]==='where')console.log(JSON.stringify({prefix:'personal',path:'/Users/aleck/.local/share/agent/beads/personal',database_path:'/Users/aleck/.local/share/agent/beads/personal/.beads/embeddeddolt'}));else if('${beadsStatus}'==='unavailable')process.exit(2);else console.log(JSON.stringify(a.filter(x=>x.startsWith('personal-')).map(id=>({id,status:'${beadsStatus}'==='open'?'in_progress':'closed'}))));
`); chmodSync(bdPath, 0o700);
  const session = SessionManager.create(root, path.join(root, "parent-session"), { id: `parent-${Date.now()}` }); writeFileSync(session.getSessionFile()!, `${JSON.stringify(session.getHeader())}\n`, { mode: 0o600 }); let activeSession = session;
  const messages: any[] = []; const messageAttempts: any[] = []; const notifications: string[] = []; const launches: Launch[] = []; const created: string[] = []; const removed: string[] = []; const cleanupAnnouncements: Promise<void>[] = [];
  let releaseSandbox = () => {}; const sandboxGate = options.deferSandbox ? new Promise<void>((resolve) => { releaseSandbox = resolve; }) : undefined; let removeFailures = 0; let cleanupHostLogRaces = 0; let discardRootFailures = 0; let counter = 0;
  const random = () => `${(++counter).toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const baseContext = { cwd: root, hasUI: options.tui ?? false, mode: options.tui ? "tui" : "rpc", sessionManager: session, modelRegistry: { hasConfiguredAuth: () => true, getAll: () => [model("openai-codex", "gpt-5.6-sol"), model("anthropic", "claude-opus-5-5")] }, thinkingLevel: "xhigh", isIdle: () => true, hasPendingMessages: () => false, ui: { notify(message: string) { notifications.push(message); } } } as unknown as ExtensionContext;
  const dependencies = {
    runtimeRoot, roots: { stateRoot: workersRoot, workspaceRoot: workersRoot }, codeRoot: root, preparedRoot: path.join(runtimeRoot, "prepared"), targetRoot: root, bdPath, sbxPath: "/fake/sbx", ...(options.sandboxRelease ? { sandboxRelease: options.sandboxRelease } : {}), random, now: () => new Date(`2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`),
    waitForHostIdentity: async () => {}, cancellationResultGraceMs: 20, cancellationEofGraceMs: 20,
    observeCleanupAnnouncement: (announcement: Promise<void>) => { cleanupAnnouncements.push(announcement); },
    ...(options.discardRootFailsOnce ? { beforeDiscardRootClaim: () => { if (discardRootFailures++ === 0) throw new Error("injected root claim failure"); } } : {}),
    ...(options.cleanupHostLogRaceOnce ? { cleanupHostLogs: (registry: any, worker: any) => { const plan = planSettledWorkerHostLogs(registry, worker, path.join(runtimeRoot, "worker-host-jobs")); if (cleanupHostLogRaces++ === 0) { const appeared = path.join(root, "appeared-after-host-log-preflight"); mkdirSync(appeared, { recursive: true }); return { ...plan, absent: [...plan.absent, appeared] }; } return plan; } } : {}),
    createSandbox: async (_sbx: string, reference: any) => { const workerParent=path.join(workersRoot,reference.workerId); assert.equal(reference.workspaceRoot,realpathSync(path.join(workerParent,"guest")),"only the guest child may be the Sandbox writable root"); assert.equal(reference.mounts.some((mount:any)=>{const source=path.resolve(mount.source),host=realpathSync(path.join(workerParent,"host"));return source===host||source.startsWith(`${host}${path.sep}`)}),false,"host supervision must never be mounted into the Sandbox"); const runInputs=realpathSync(path.join(workerParent,"guest","run-inputs")); assert.equal(reference.mounts.filter((mount:any)=>{const source=path.resolve(mount.source);return source===runInputs||source.startsWith(`${runInputs}${path.sep}`)}).every((mount:any)=>mount.readOnly===true),true,"validated guest run inputs must be mounted read-only"); if (options.mountThrows && reference.mounts.some((mount: any) => mount.readOnly && mount.source.includes(`${path.sep}run-inputs${path.sep}`))) throw new Error("review mount probe failure"); created.push(reference.runId); if (sandboxGate) await sandboxGate; return { ...reference, ...(reference.reviewOverlay ? { reviewOverlay: { ...reference.reviewOverlay, setupEvidenceSha256: (++counter).toString(16).padStart(64, "0") } } : {}), createEvidenceSha256: (++counter).toString(16).padStart(64, "0") }; },
    removeSandbox: (_sbx: string, reference: any) => { removed.push(reference.runId); if (options.removeAlwaysThrows || options.removeThrowsOnce && removeFailures++ === 0) throw new Error(options.removeAlwaysThrows ? "persistent sandbox cleanup failure" : "transient sandbox cleanup failure"); },
    launch: (_api: ExtensionAPI, _context: ExtensionContext, input: any) => {
      if (options.launchThrows) throw new Error("launch probe failure"); let resolve!: (job: JobMeta) => void; const completion = new Promise<JobMeta>((done) => { resolve = done; });
      const exactJob = (status: JobMeta["status"], exitCode = status === "exited" ? 0 : undefined): JobMeta => { const jobId = input.record.jobId; const logDir = path.join(runtimeRoot, "worker-host-jobs", "jobs", jobId); mkdirSync(logDir, { recursive: true }); const stdoutLog = path.join(logDir, "stdout.log"), stderrLog = path.join(logDir, "stderr.log"); if (!existsSync(stdoutLog)) writeFileSync(stdoutLog, ""); if (!existsSync(stderrLog)) writeFileSync(stderrLog, ""); const identity = workerHostJobIdentity(input.record.workerId, input.record.runId); const value = { jobId, command: identity.command, managedBy: identity.managedBy, cwd: root, status, durationMs: 1, exitCode, signal: null, notifyOnExit: false, completionNotified: true, logDir, stdoutLog, stderrLog, outputBytes: { stdout: 0, stderr: 0 } } as JobMeta; writeFileSync(path.join(logDir, "meta.json"), JSON.stringify(value)); return value; };
      const running = exactJob("running"); const handle: ManagedAsyncJobHandle = { jobId: input.record.jobId, completion, snapshot: () => running, cancel: () => resolve(exactJob("cancelled")) }; launches.push({ ...input, resolve, handle, job: exactJob }); return handle;
    }
  };
  const instances: Array<{ tools: ToolDefinition[]; handlers: Map<string, Function[]>; commands: Map<string, any>; renderers: Map<string, Function>; call(name: string, params: any): Promise<any>; event(name: string, event?: any): Promise<void> }> = [];
  const createInstance = async () => {
    const context = Object.create(baseContext) as ExtensionContext; Object.defineProperty(context, "sessionManager", { get: () => activeSession });
    const tools: ToolDefinition[] = []; const handlers = new Map<string, Function[]>(); const commands = new Map<string, any>(); const renderers = new Map<string, Function>();
    const api = { registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand(name: string, command: any) { commands.set(name, command); }, registerMessageRenderer(name: string, renderer: Function) { renderers.set(name, renderer); }, on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, sendMessage(message: any) { messageAttempts.push(message); messages.push(message); } } as unknown as ExtensionAPI;
    registerWorkerExtension(api, dependencies);
    const call = async (name: string, params: any) => { const tool = tools.find((candidate) => candidate.name === name)!; return tool.execute!("test", params, new AbortController().signal, undefined, context); };
    const event = async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, context); if (name === "agent_end") await Promise.all(cleanupAnnouncements.splice(0)); if (name === "turn_end") await waitFor(() => { const db = openWorkerRegistry(runtimeRoot); const queued = Number((db.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE status='queued'").get() as any).count); db.close(); return queued === 0; }); };
    const instance = { tools, handlers, commands, renderers, call, event }; instances.push(instance); await event("session_start"); return instance;
  };
  let current = await createInstance(); const first = current;
  const reload = async () => { await current.event("session_shutdown"); current = await createInstance(); return current; };
  const registry = () => openWorkerRegistry(runtimeRoot);
  return { root, runtimeRoot, workersRoot, session, messages, messageAttempts, notifications, launches, releaseSandbox, created, removed, context: baseContext, tools: first.tools, handlers: first.handlers, commands: first.commands, renderers: first.renderers, call: first.call, event: first.event, registry, reload, switchSession: (next: SessionManager) => { activeSession = next; }, async close() { releaseSandbox(); for (const instance of instances) { try { await instance.event("session_shutdown"); } catch {} } rmSync(root, { recursive: true, force: true }); } };
}

const lifecycleOwnerFixture = fileURLToPath(new URL("./fixtures/worker-lifecycle-claim-owner.js", import.meta.url));
const cleanupCrashFixture = fileURLToPath(new URL("./fixtures/worker-cleanup-crash-owner.js", import.meta.url));

async function spawnDeliveryClaimOwner(f: Fixture, item: { workerId: string; runId: string }, ownerSessionFile?: string) {
  const parent = ownerSessionFile ? realpathSync(ownerSessionFile) : realpathSync(f.session.getSessionFile()!);
  const child = spawn(process.execPath, [lifecycleOwnerFixture, f.runtimeRoot, parent, item.workerId, item.runId, "delivery", "wait"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const receive = (event: string) => new Promise<any>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`delivery owner did not emit ${event}: ${stderr}`)), 4_000); const onExit = (code: number | null, signal: NodeJS.Signals | null) => { clearTimeout(timer); reject(new Error(`delivery owner exited before ${event} (${code}/${signal}): ${stderr}`)); }; const onMessage = (message: any) => { if (message?.event !== event) return; clearTimeout(timer); child.off("exit", onExit); child.off("message", onMessage); resolve(message); }; child.once("exit", onExit); child.on("message", onMessage); });
  const registered = await receive("registered"); return { child, registered, claim: async () => { const claimed = receive("claimed"); child.send({ action: "claim" }); return claimed; } };
}

async function stopLifecycleClaimOwner(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGKILL"): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return; child.kill(signal); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }

function receipt(result: any) { return result.details.runs[0] as { workerId: string; runId: string; role: string }; }
async function waitFor(check: () => boolean, timeout = 3_000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); } }
function writeCompletionEvidence(f: Fixture, item: { workerId: string; runId: string }, result: any): Launch {
  const launch = f.launches.find((value) => value.record.workerId === item.workerId && value.record.runId === item.runId);
  const db = f.registry(); const worker = getWorker(db, item.workerId)!; const currentRun = getWorkerRun(db, item.workerId, item.runId); db.close();
  if (!launch) throw new Error(`worker launch missing: ${JSON.stringify({ worker, run: currentRun })}`);
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

test("worker_run returns complete provider-visible identities and defers Sandbox creation until turn_end", async () => {
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


test("turn_end returns without awaiting deferred Sandbox readiness", async () => {
  const f = await fixture({ deferSandbox: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "async launch" }] }));
    const handler = f.handlers.get("turn_end")![0]!; const returned = handler({}, f.context); assert.equal(returned, undefined);
    let db = f.registry(); assert.equal(getWorker(db, started.workerId)!.sessionFile, undefined, "session fork must be deferred beyond the event handler"); db.close();
    await waitFor(() => f.created.length === 1); assert.equal(f.launches.length, 0);
    db = f.registry(); assert.equal(getWorkerRun(db, started.workerId, started.runId)!.status, "queued"); db.close();
    f.releaseSandbox(); await waitFor(() => f.launches.length === 1); db = f.registry(); await waitFor(() => { const current = getWorkerRun(db, started.workerId, started.runId); return current?.status === "running"; }); db.close();
    await f.call("worker_control", { action: "cancel", workerId: started.workerId });
  } finally { f.releaseSandbox(); await f.close(); }
});


test("an exact stale cancellation request is idempotent and cannot block exact removal", async () => {
  const f=await fixture(); let child: ReturnType<typeof spawn> | undefined; try {
    const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-test"],instructions:"stale cancel request"}]})); await f.event("turn_end"); const launch=f.launches[0]!; const token=`cancel-stale-${Date.now()}`; child=spawn(process.execPath,["-e","setTimeout(()=>process.exit(0),200)"],{env:{...process.env,PI_WORKER_JOB_TOKEN:token},stdio:"ignore"}); await waitFor(()=>Boolean(child?.pid&&asyncJobProcessStartToken(child.pid))); const startToken=asyncJobProcessStartToken(child.pid!);
    writeFileSync(launch.runtime.processFile,`${JSON.stringify({version:2,workerId:started.workerId,runId:started.runId,pid:child.pid,processToken:token,processStartToken:startToken,nonce:launch.runtime.processNonce,hostConfigFile:path.join(launch.runtime.runDir,"host.json"),startedAt:new Date().toISOString()})}\n`); writeFileSync(path.join(launch.runtime.runDir,"cancel-request.json"),`${JSON.stringify({version:1,workerId:started.workerId,runId:started.runId,requestedAt:new Date().toISOString()})}\n`); setTimeout(()=>launch.resolve(launch.job("exited",0)),220);
    const result=await f.call("worker_control",{action:"cancel",workerId:started.workerId}); assert.equal((result.details as any).cancellation,"cancelled"); assert.deepEqual(f.removed,[started.runId]);
  } finally { if(child?.pid) try{child.kill("SIGKILL");}catch{} await f.close(); }
});

test("a malformed or mismatched retained cancellation request is replaced and cannot suppress exact containment", async () => {
  const f=await fixture(); let child: ReturnType<typeof spawn> | undefined; try {
    const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-test"],instructions:"mismatched cancel request"}]})); await f.event("turn_end"); const launch=f.launches[0]!; const token=`cancel-mismatch-${Date.now()}`; child=spawn(process.execPath,["-e","setTimeout(()=>process.exit(0),200)"],{env:{...process.env,PI_WORKER_JOB_TOKEN:token},stdio:"ignore"}); await waitFor(()=>Boolean(child?.pid&&asyncJobProcessStartToken(child.pid))); const startToken=asyncJobProcessStartToken(child.pid!);
    writeFileSync(launch.runtime.processFile,`${JSON.stringify({version:2,workerId:started.workerId,runId:started.runId,pid:child.pid,processToken:token,processStartToken:startToken,nonce:launch.runtime.processNonce,hostConfigFile:path.join(launch.runtime.runDir,"host.json"),startedAt:new Date().toISOString()})}\n`);
    writeFileSync(path.join(launch.runtime.runDir,"cancel-request.json"),'{"version":1,"workerId":"worker_20260101000000_deadbeef","runId":"run_wrong"}\n'); setTimeout(()=>launch.resolve(launch.job("exited",0)),220);
    const result=await f.call("worker_control",{action:"cancel",workerId:started.workerId}); assert.equal((result.details as any).cancellation,"cancelled"); assert.deepEqual(f.removed,[started.runId]); const retained=JSON.parse(readFileSync(path.join(launch.runtime.runDir,"cancel-request.json"),"utf8")); assert.equal(retained.workerId,started.workerId); assert.equal(retained.runId,started.runId);
  } finally { if(child?.pid) try{child.kill("SIGKILL");}catch{} await f.close(); }
});

test("resume pre-plan snapshot failure removes reserved supervision, evidence, and cache-lineage debris", async () => {
  const f=await fixture(); try {
    const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-test"],instructions:"pre-plan cleanup baseline"}]})); await f.call("worker_control",{action:"cancel",workerId:started.workerId});
    const db=f.registry(),worker=getWorker(db,started.workerId)!; db.close(); const supervision=path.join(f.runtimeRoot,"supervision",started.workerId),state=path.join(f.workersRoot,started.workerId); const before={supervision:relativeTree(supervision),lineage:relativeTree(path.join(state,"cache-lineage"))};
    const readable=path.join(f.root,"input-readable.txt"), hostile=path.join(f.root,"input-hostile"), outside=path.join(f.root,"input-outside.txt"); writeFileSync(readable,"first\n"); mkdirSync(hostile); writeFileSync(outside,"second\n"); symlinkSync(outside,path.join(hostile,"worker-planted-link"));
    await assert.rejects(f.call("worker_run",{runs:[{action:"resume",workerId:started.workerId,instructions:"snapshot both",additionalInputs:[readable,hostile]}]}),/reject symbolic links/);
    assert.deepEqual(relativeTree(supervision),before.supervision);assert.deepEqual(relativeTree(path.join(state,"cache-lineage")),before.lineage);const after=f.registry();assert.equal(getWorker(after,started.workerId)!.activeRunId,undefined);after.close();
  } finally {await f.close();}
});

test("accepted result survives missing guest settlement through EOF and exact Sandbox removal", async () => {
  const f = await fixture(); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "accepted result" }] })); await f.event("turn_end");
    const launch = f.launches[0]!; writeFileSync(launch.runtime.resultFile, `${JSON.stringify({ version: 2, workerId: started.workerId, runId: started.runId, acceptedAt: new Date().toISOString(), result: { outcome: "completed", summary: "accepted before guest settlement" } }, null, 2)}\n`);
    setTimeout(() => launch.resolve(launch.job("exited", 0)), 5);
    const cancelled = await f.call("worker_control", { action: "cancel", workerId: started.workerId }); assert.equal((cancelled.details as any).cancellation, "superseded");
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; assert.equal(run.outcome, "completed"); assert.equal(run.outcomeSource, "worker"); assert.equal(run.summary, "accepted before guest settlement"); assert.equal(getWorker(db, started.workerId)!.status, "idle"); db.close(); assert.equal(f.removed.length >= 1, true); assert.equal(f.removed.every((runId) => runId === started.runId), true);
  } finally { await f.close(); }
});

test("a restarted runtime preserves an accepted outcome while detached cancellation precedes exact removal", async () => {
  const f=await fixture(); const secondHandlers=new Map<string,Function[]>(),secondTools:ToolDefinition[]=[];let child:ReturnType<typeof spawn>|undefined;const removalSawCancellation:boolean[]=[];try{
    const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-test"],instructions:"restart accepted result"}]}));await f.event("turn_end");const launch=f.launches[0]!;await f.event("session_shutdown");
    writeFileSync(launch.runtime.resultFile,`${JSON.stringify({version:2,workerId:started.workerId,runId:started.runId,acceptedAt:new Date().toISOString(),result:{outcome:"blocked",summary:"accepted before parent restart"}},null,2)}\n`);
    const cancellation=path.join(launch.runtime.runDir,"cancel-request.json"),seen=path.join(f.root,"detached-cancel-seen");const token=`restart-accepted-${Date.now()}`;child=spawn(process.execPath,["-e",`const fs=require("fs"),cancel=process.argv[1],seen=process.argv[2];const timer=setInterval(()=>{if(fs.existsSync(cancel)){fs.writeFileSync(seen,"seen\\n");clearInterval(timer);process.exit(0)}},10)`,cancellation,seen],{env:{...process.env,PI_WORKER_JOB_TOKEN:token},stdio:"ignore"});await waitFor(()=>Boolean(child?.pid&&asyncJobProcessStartToken(child.pid)));const startToken=asyncJobProcessStartToken(child.pid!);writeFileSync(launch.runtime.processFile,`${JSON.stringify({version:2,workerId:started.workerId,runId:started.runId,pid:child.pid,processToken:token,processStartToken:startToken,nonce:launch.runtime.processNonce,hostConfigFile:path.join(launch.runtime.runDir,"host.json"),startedAt:new Date().toISOString()})}\n`);
    const secondApi={registerTool(tool:ToolDefinition){secondTools.push(tool)},registerCommand(){},registerMessageRenderer(){},sendMessage(){},on(name:string,handler:Function){secondHandlers.set(name,[...(secondHandlers.get(name)??[]),handler]);}} as unknown as ExtensionAPI;registerWorkerExtension(secondApi,{runtimeRoot:f.runtimeRoot,roots:{stateRoot:f.workersRoot,workspaceRoot:f.workersRoot},codeRoot:f.root,preparedRoot:path.join(f.runtimeRoot,"prepared"),targetRoot:f.root,sbxPath:"/fake/sbx",waitForHostIdentity:async()=>{},createSandbox:async()=>{throw new Error("accepted restart must not create")},removeSandbox:async()=>{removalSawCancellation.push(existsSync(seen));},launch:()=>{throw new Error("accepted restart must not relaunch")},cancellationResultGraceMs:20,cancellationEofGraceMs:500});for(const handler of secondHandlers.get("session_start")??[])await handler({},f.context);
    const control=secondTools.find((tool)=>tool.name==="worker_control")!;const result=await control.execute!("restart-cancel",{action:"cancel",workerId:started.workerId},new AbortController().signal,undefined,f.context);assert.equal((result.details as any).cancellation,"superseded");await waitFor(()=>existsSync(seen));const db=f.registry(),run=getWorkerRun(db,started.workerId,started.runId)!;assert.equal(run.outcome,"blocked");assert.equal(run.outcomeSource,"worker");assert.equal(run.summary,"accepted before parent restart");db.close();assert.deepEqual(removalSawCancellation,[true]);
  }finally{if(child?.pid)try{child.kill("SIGKILL")}catch{}for(const handler of secondHandlers.get("session_shutdown")??[])await handler({},f.context);await f.close();}
});

test("cancellation waits for a deferred launch boundary before proving termination", async () => {
  const f = await fixture({ deferSandbox: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "cancel during readiness" }] }));
    const handler = f.handlers.get("turn_end")![0]!; handler({}, f.context); await waitFor(() => f.created.length === 1);
    let resolved = false; const cancelling = f.call("worker_control", { action: "cancel", workerId: started.workerId }).then((value) => { resolved = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(resolved, false); f.releaseSandbox(); await cancelling;
    const db = f.registry(); const worker = getWorker(db, started.workerId)!; const run = getWorkerRun(db, started.workerId, started.runId)!; db.close();
    assert.equal(worker.status, "idle"); assert.equal(run.outcome, "cancelled"); assert.equal(f.launches.length, 0);
  } finally { f.releaseSandbox(); await f.close(); }
});

test("abandoned partial old-nonce trash is removed without restoring a deleted live tree", async () => {
  const f=await fixture();const handlers=new Map<string,Function[]>();try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-test"],instructions:"partial trash"}]}));await f.call("worker_control",{action:"cancel",workerId:started.workerId});await f.event("session_shutdown");const original=path.join(f.workersRoot,started.workerId),trash=`${original}.discard-0-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;renameSync(original,trash);rmSync(path.join(trash,"guest","workspace"),{recursive:true,force:true});const api={registerTool(){},registerCommand(){},registerMessageRenderer(){},sendMessage(){},on(name:string,handler:Function){handlers.set(name,[...(handlers.get(name)??[]),handler]);}} as unknown as ExtensionAPI;registerWorkerExtension(api,{runtimeRoot:f.runtimeRoot,roots:{stateRoot:f.workersRoot,workspaceRoot:f.workersRoot},codeRoot:f.root,preparedRoot:path.join(f.runtimeRoot,"prepared"),targetRoot:f.root,sbxPath:"/fake/sbx",waitForHostIdentity:async()=>{},createSandbox:async()=>{throw new Error("must not create")},removeSandbox:async()=>{},launch:()=>{throw new Error("must not launch")}});for(const handler of handlers.get("session_start")??[])await handler({},f.context);assert.equal(existsSync(original),false);assert.equal(existsSync(trash),false);}finally{for(const handler of handlers.get("session_shutdown")??[])await handler({},f.context);await f.close();}
});

test("stale interrupted discard is retained for exact retry without launching", async () => {
  const f=await fixture(); const secondHandlers=new Map<string,Function[]>(); let protectedDirectory: string | undefined; try {
    const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-test"],instructions:"discard recovery"}]})); await f.call("worker_control",{action:"cancel",workerId:started.workerId}); let db=f.registry(); const worker=getWorker(db,started.workerId)!; protectedDirectory=path.join(f.workersRoot,started.workerId,"host","evidence","protected"); mkdirSync(protectedDirectory,{recursive:true}); writeFileSync(path.join(protectedDirectory,"evidence.txt"),"evidence\n",{mode:0o400}); chmodSync(protectedDirectory,0o500); const oldTrash=`${path.join(f.workersRoot,started.workerId)}.discard-0-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`; mkdirSync(oldTrash,{recursive:true}); writeFileSync(path.join(oldTrash,"old.txt"),"old\n"); db.database.prepare("UPDATE workers SET operation_kind='discard',operation_nonce='1-bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' WHERE worker_id=?").run(started.workerId); db.close(); await f.event("session_shutdown");
    const secondApi={registerTool(){},registerCommand(){},registerMessageRenderer(){},sendMessage(){},on(name:string,handler:Function){secondHandlers.set(name,[...(secondHandlers.get(name)??[]),handler]);}} as unknown as ExtensionAPI; registerWorkerExtension(secondApi,{runtimeRoot:f.runtimeRoot,roots:{stateRoot:f.workersRoot,workspaceRoot:f.workersRoot},codeRoot:f.root,preparedRoot:path.join(f.runtimeRoot,"prepared"),targetRoot:f.root,sbxPath:"/fake/sbx",createSandbox:async()=>{throw new Error("discard recovery must not create")},removeSandbox:async()=>{},waitForHostIdentity:async()=>{},launch:()=>{throw new Error("discard recovery must not launch")}}); for(const handler of secondHandlers.get("session_start")??[]) await handler({},f.context); db=f.registry(); const retained=getWorker(db,started.workerId)!; db.close(); assert.equal(retained.status,"idle"); assert.match(retained.recoveryError!,/Interrupted discard claim/); assert.equal(existsSync(worker.workspaceRoot),true); assert.equal(existsSync(oldTrash),false);
  } finally { if (protectedDirectory && existsSync(protectedDirectory)) chmodSync(protectedDirectory,0o700); for(const handler of secondHandlers.get("session_shutdown")??[]) await handler({},f.context); await f.close(); }
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

test("current-layout reviewer and subject recovery cleanup completes in one first apply", async () => {
  const f=await fixture({beadsStatus:"closed"});try{const subject=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-review-f3"],instructions:"subject"}]}));await f.event("turn_end");await complete(f,subject);await acknowledgeWorkerDeliveries(f,subject.workerId);const reviewer=receipt(await f.call("worker_run",{runs:[{action:"start",role:"review",reviewedRunId:subject.runId,instructions:"review"}]}));await f.event("turn_end");await complete(f,reviewer,{outcome:"approve",summary:"ok"});await acknowledgeWorkerDeliveries(f,reviewer.workerId);let db=f.registry();assert.equal(Number(db.database.prepare("UPDATE workers SET reviewed_by_worker_id=?,recovery_error='subject recovery',version=version+1 WHERE worker_id=? AND reviewed_by_worker_id IS NULL").run(reviewer.workerId,subject.workerId).changes),1);db.database.prepare("UPDATE workers SET recovery_error='reviewer recovery',version=version+1 WHERE worker_id=?").run(reviewer.workerId);db.close();const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[reviewer.workerId]}) as any;const ids=preview.details.workers.map((item:any)=>item.worker.workerId);assert.deepEqual(new Set(ids),new Set([subject.workerId,reviewer.workerId]));const parents=ids.map((id:string)=>path.join(f.workersRoot,id));const applied=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token,recoveryAcknowledged:ids}) as any;assert.equal(applied.details.cleanup.results.length,2);assert.equal(applied.details.cleanup.results.every((item:any)=>item.status==="discarded"),true);db=f.registry();assert.equal(getWorker(db,subject.workerId),undefined);assert.equal(getWorker(db,reviewer.workerId),undefined);db.close();for(const parent of parents)assert.equal(existsSync(parent),false);}finally{await f.close();}
});

test("discard path mismatch rolls its claim back instead of fabricating irreversible recovery", async () => {
  const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-review-f6"],instructions:"discard mismatch"}]}));await f.call("worker_control",{action:"cancel",workerId:started.workerId});await acknowledgeWorkerDeliveries(f,started.workerId);let db=f.registry();db.database.prepare("UPDATE workers SET workspace_root=?,version=version+1 WHERE worker_id=?").run(path.join(f.root,"mismatched-workspace"),started.workerId);db.close();const result=await f.call("worker_control",{action:"discard",workerId:started.workerId}) as any;assert.equal(result.details.discarded[0].status,"failed");db=f.registry();const retained=getWorker(db,started.workerId)!;db.close();assert.equal(retained.operationKind,undefined);assert.equal(retained.operationNonce,undefined);assert.doesNotMatch(retained.recoveryError??"",/Interrupted irreversible discard/);assert.match(retained.recoveryError??"",/storage layout.*registered workspace/i);assert.equal(existsSync(path.join(f.workersRoot,started.workerId)),true);}finally{await f.close();}
});

test("explicit recovery cleanup erases a schema-v9 split worker parent and external supervision", async () => {
  const f=await fixture(); try {
    const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-legacy-layout"],instructions:"legacy cleanup"}]})); await f.call("worker_control",{action:"cancel",workerId:started.workerId}); await acknowledgeWorkerDeliveries(f,started.workerId);
    const workerParent=path.join(f.workersRoot,started.workerId),guest=path.join(workerParent,"guest"),host=path.join(workerParent,"host"),legacySupervision=path.join(f.runtimeRoot,"supervision",started.workerId); mkdirSync(path.dirname(legacySupervision),{recursive:true}); renameSync(host,legacySupervision); for(const name of readdirSync(guest))renameSync(path.join(guest,name),path.join(workerParent,name)); rmSync(guest,{recursive:true});
    let db=f.registry(); db.database.prepare("UPDATE workers SET storage_layout=1,workspace_root=?,recovery_error=?,version=version+1 WHERE worker_id=?").run(path.join(workerParent,"workspace"),"Legacy split worker storage requires explicit guarded cleanup",started.workerId); db.close();
    const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any; const applied=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token,recoveryAcknowledged:[started.workerId]}) as any; assert.equal(applied.details.cleanup.results[0].status,"discarded"); assert.equal(existsSync(workerParent),false); assert.equal(existsSync(legacySupervision),false); db=f.registry(); assert.equal(getWorker(db,started.workerId),undefined); db.close();
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

test("later batch validation failure rolls back earlier Sandboxes, workspaces, and registry visibility", async () => {
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
      sbxPath: "/fake/sbx",
      createSandbox: async () => { throw new Error("settled detached work must not create a sandbox"); },
      removeSandbox: async () => {},
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

test("failed deferred review Sandbox setup system-settles and releases the subject lease", async () => {
  const f = await fixture({ mountThrows: true }); try {
    const subject = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] })); await f.event("turn_end"); await complete(f, subject);
    const review = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId }] }));
    await f.event("turn_end");
    const db = f.registry(); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, undefined); assert.equal(getWorkerRun(db, review.workerId, review.runId)!.outcome, "failed"); db.close();
  } finally { await f.close(); }
});

test("review snapshot rejects a worker-planted symlink in the retained subject session path", async () => {
  const f = await fixture(); try {
    const subject = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] })); await f.event("turn_end"); await complete(f, subject);
    const db = f.registry(); const worker = getWorker(db, subject.workerId)!; const sessionDirectory = path.dirname(worker.sessionFile!); db.close();
    const retained = `${sessionDirectory}-retained`; renameSync(sessionDirectory, retained); symlinkSync(retained, sessionDirectory, "dir");
    await assert.rejects(() => f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId }] }), /may not traverse symbolic links/); const after=f.registry(); assert.equal(getWorker(after,subject.workerId)!.reviewedByWorkerId,undefined); assert.equal(listWorkers(after,{parentSessionFile:realpathSync(f.session.getSessionFile()!)}).total,1); after.close();
  } finally { await f.close(); }
});

test("review extracts the registered run range from a retained session larger than 128 MiB", async () => {
  const f = await fixture(); try {
    const subject = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "large subject" }] })); await f.event("turn_end"); await complete(f, subject);
    let db = f.registry(); const subjectWorker = getWorker(db, subject.workerId)!; const subjectRun = getWorkerRun(db, subject.workerId, subject.runId)!; db.close();
    const descriptor = openSync(subjectWorker.sessionFile!, "r+"); try { ftruncateSync(descriptor, 160 * 1024 * 1024); } finally { closeSync(descriptor); }
    const review = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId }] })); await f.event("turn_end");
    db = f.registry(); const runtime = getWorkerRun(db, review.workerId, review.runId)!.runtime as any; const context = JSON.parse(readFileSync(runtime.contextFile, "utf8")); const snapshot = readFileSync(context.session.path, "utf8"); db.close();
    assert.deepEqual(context.session.sourceRange, { startLine: subjectRun.sessionStartLine, endLine: subjectRun.sessionEndLine });
    assert.match(snapshot, new RegExp(`result-${subject.runId}`)); assert.ok(Buffer.byteLength(snapshot) < 1024 * 1024);
    await f.call("worker_control", { action: "cancel", workerId: review.workerId });
  } finally { await f.close(); }
});

test("review starts fresh, mounts exact subject session range, cancellation releases lease, and resume recreates it", async () => {
  const f = await fixture(); try {
    const subject = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "subject" }] })); await f.event("turn_end");
    let subjectDb = f.registry(); const subjectWorkspace = getWorker(subjectDb, subject.workerId)!.workspaceRoot; subjectDb.close();
    const eligibleRepo = path.join(subjectWorkspace, "repos", "eligible"); gitInit(eligibleRepo); writeFileSync(path.join(eligibleRepo, "result.txt"), "result\n"); git(eligibleRepo, "add", "."); git(eligibleRepo, "commit", "-m", "eligible");
    const ineligibleRepo = path.join(subjectWorkspace, "repos", "dirty"); gitInit(ineligibleRepo); writeFileSync(path.join(ineligibleRepo, "result.txt"), "result\n"); git(ineligibleRepo, "add", "."); git(ineligibleRepo, "commit", "-m", "dirty"); writeFileSync(path.join(ineligibleRepo, "untracked.txt"), "dirty\n");
    mkdirSync(path.join(subjectWorkspace, "artifacts"), { recursive: true }); writeFileSync(path.join(subjectWorkspace, "artifacts", "review.txt"), "review evidence\n");
    await complete(f, subject, { outcome: "completed", summary: "subject", repositories: ["repos/eligible", "repos/dirty"], artifacts: ["artifacts/review.txt"] });
    const extra = path.join(f.root, "spec.txt"); writeFileSync(extra, "spec\n");
    const review = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "review", reviewedRunId: subject.runId, additionalInputs: [extra] }] }));
    await f.event("turn_end");
    let db = f.registry(); const reviewer = getWorker(db, review.workerId)!; const subjectRow = getWorker(db, subject.workerId)!; assert.equal(subjectRow.reviewedByWorkerId, review.workerId); const run = getWorkerRun(db, review.workerId, review.runId)!; const runtime = run.runtime as any;
    const header = JSON.parse(readFileSync(reviewer.sessionFile!, "utf8").split("\n")[0]!); assert.equal(header.parentSession, undefined);
    const context = JSON.parse(readFileSync(runtime.contextFile, "utf8")); const subjectRun = getWorkerRun(db, subject.workerId, subject.runId)!;
    assert.equal(runtime.sandbox.mounts.some((mount: any) => mount.source === realpathSync(path.dirname(runtime.contextFile)) && mount.readOnly), true);
    assert.deepEqual(context.session.sourceRange, { startLine: subjectRun.sessionStartLine, endLine: subjectRun.sessionEndLine }); assert.match(runtime.contextFile, new RegExp(review.runId)); assert.notEqual(context.session.path, subjectRow.sessionFile); assert.equal(context.version, 3); assert.equal(context.subjectWorkspace, "/review/subject"); assert.equal(context.repositories.length, 1); assert.equal(context.repositories[0].eligible, true); assert.equal(context.repositories[0].path, "repos/eligible"); assert.equal(context.skippedRepositories.length, 1); assert.match(context.skippedRepositories[0].reason, /working tree|eligible|dirty/i); assert.deepEqual(context.artifacts, ["/review/subject/artifacts/review.txt"]); assert.equal(existsSync(path.join(path.dirname(runtime.contextFile), "subject")), false, "review planning must not copy the subject"); assert.equal(existsSync(path.join(path.dirname(runtime.contextFile), "artifacts")), false, "review planning must not copy subject artifacts"); assert.equal(runtime.sandbox.workingDirectory, "/review/subject"); assert.equal(runtime.sandbox.reviewOverlay.lowerDirectory, realpathSync(subjectWorkspace)); assert.match(runtime.sandbox.reviewOverlay.setupEvidenceSha256, /^[a-f0-9]{64}$/); assert.equal(runtime.sandbox.mounts.some((mount: any) => mount.source === realpathSync(subjectWorkspace) && mount.readOnly), true); assert.equal(readFileSync(path.join(subjectWorkspace, "artifacts", "review.txt"), "utf8"), "review evidence\n"); assert.equal(git(eligibleRepo, "for-each-ref", "--format=%(refname)", "refs/heads/pi-worker-review-"), ""); assert.match(runtime.prompt, /fresh writable disposable copy-on-write view/i); assert.match(runtime.prompt, new RegExp(reviewer.workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))); assert.equal(runtime.prompt.includes(extra), false); assert.doesNotMatch(runtime.prompt, /Writable workspace:\n\/workspace(?:\n|$)/); db.close();
    await f.call("worker_control", { action: "cancel", workerId: review.workerId }); db = f.registry(); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, undefined); db.close();
    const resumed = receipt(await f.call("worker_run", { runs: [{ action: "resume", workerId: review.workerId, instructions: "continue" }] })); await f.event("turn_end"); db = f.registry(); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, review.workerId); const resumedRuntime = getWorkerRun(db, review.workerId, resumed.runId)!.runtime as any; assert.notEqual(resumedRuntime.sandbox.sandboxName, runtime.sandbox.sandboxName); assert.notEqual(resumedRuntime.sandbox.reviewOverlay.scratchDirectory, runtime.sandbox.reviewOverlay.scratchDirectory); assert.equal(f.removed.includes(review.runId), true, "review cancellation must remove the exact Sandbox that owns upper/work/merged state"); assert.equal((getWorker(db, review.workerId)!.runtime?.inputs as any[]).length, 1); db.close();
    await f.call("worker_control", { action: "cancel", workerId: review.workerId }); await acknowledgeWorkerDeliveries(f, review.workerId); await f.call("worker_control", { action: "discard", workerId: review.workerId }); db = f.registry(); assert.equal(getWorker(db, review.workerId), undefined); assert.equal(getWorker(db, subject.workerId)!.reviewedByWorkerId, undefined); db.close();
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
    const movedRepo = path.join(worker.workspaceRoot, context.repositories[0].path); assert.equal(existsSync(movedRepo), true); assert.equal(runtime.sandbox.mounts.some((mount: any) => mount.source === realpathSync(path.dirname(runtime.contextFile)) && mount.readOnly), true); db.close();
    await f.call("worker_control", { action: "cancel", workerId: started.workerId });
    const plantedTarget = path.join(f.root, "planted-run-input-target"); mkdirSync(plantedTarget); const runInputs = path.join(path.dirname(worker.workspaceRoot), "run-inputs"); rmSync(runInputs, { recursive: true, force: true }); symlinkSync(plantedTarget, runInputs, "dir");
    const extra = path.join(f.root, "extra.txt"); writeFileSync(extra, "extra\n"); await assert.rejects(()=>f.call("worker_run", { runs: [{ action: "resume", workerId: started.workerId, instructions: "continue", additionalInputs: [extra] }] }),/run-input|symbolic|ordinary/i); assert.deepEqual(readdirSync(plantedTarget), []); assert.equal(lstatSync(runInputs).isSymbolicLink(),true); unlinkSync(runInputs); mkdirSync(runInputs); const resumed = receipt(await f.call("worker_run", { runs: [{ action: "resume", workerId: started.workerId, instructions: "continue", additionalInputs: [extra] }] }));

    db = f.registry(); worker = getWorker(db, resumed.workerId)!; run = getWorkerRun(db, resumed.workerId, resumed.runId)!; runtime = run.runtime as any; const updated = JSON.parse(readFileSync(runtime.contextFile, "utf8"));
    assert.equal(updated.additionalInputs.length, 2); assert.equal(existsSync(movedRepo), true); assert.equal(runtime.sandbox.mounts.some((mount: any) => mount.source === realpathSync(path.dirname(runtime.contextFile))), true); assert.equal((worker.runtime?.inputs as any[]).length, 2); db.close();
    await f.call("worker_control", { action: "cancel", workerId: resumed.workerId }); await acknowledgeWorkerDeliveries(f, resumed.workerId); await f.call("worker_control", { action: "discard", workerId: resumed.workerId }); db = f.registry(); assert.equal(getWorker(db, resumed.workerId), undefined); const retainedPrepared = db.database.prepare("SELECT prepared_id FROM prepared_sets WHERE prepared_id=?").get(prepared.preparedId); assert.equal(retainedPrepared, undefined); db.close();
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



test("persistent accepted-result cleanup failure retains accepted authority and active containment for recovery", async () => {
  const f = await fixture({ removeAlwaysThrows: true }); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "settle persistently" }] })); await f.event("turn_end");
    const db0 = f.registry(); const workspace = getWorker(db0, started.workerId)!.workspaceRoot; db0.close(); const repo = path.join(workspace, "repos", "interrupted"); gitInit(repo); writeFileSync(path.join(repo, "dirty.txt"), "dirty\n"); writeFileSync(path.join(repo, ".git", "index.lock"), "retained\n");
    const launch = writeCompletionEvidence(f, started, { outcome: "completed", summary: "accepted before cleanup failure", repositories: ["repos/interrupted"] }); launch.resolve(launch.job("exited", 0));
    await waitFor(() => { const side=f.registry(); const worker=getWorker(side,started.workerId); side.close(); return Boolean(worker?.recoveryError); });
    const db = f.registry(); const run = getWorkerRun(db, started.workerId, started.runId)!; const worker = getWorker(db, started.workerId)!; const runtime = run.runtime as any; db.close();
    assert.equal(run.status, "running"); assert.equal(run.outcome, undefined); assert.equal(worker.status, "running"); assert.match(worker.recoveryError!, /exact Sandbox removal/); assert.equal(existsSync(runtime.resultFile), true); assert.equal(JSON.parse(readFileSync(runtime.resultFile, "utf8")).result.outcome, "completed"); assert.equal(f.removed.length >= 1, true);
    await assert.rejects(() => f.call("worker_run", { runs: [{ action: "resume", workerId: started.workerId, instructions: "must remain contained" }] }), /not idle/);
  } finally { await f.close(); }
});

test("first version-4 resume after retained legacy metadata is explicitly disclosed", async () => {
  const f=await fixture(); try {
    const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-test"],instructions:"legacy transition"}]})); await f.event("turn_end"); await f.call("worker_control",{action:"cancel",workerId:started.workerId});
    const db=f.registry(); const retained=getWorkerRun(db,started.workerId,started.runId)!; const legacy={...(retained.runtime as any),version:3}; db.database.prepare("UPDATE runs SET runtime_json=? WHERE worker_id=? AND run_id=?").run(JSON.stringify(legacy),started.workerId,started.runId); db.close();
    const resumed=receipt(await f.call("worker_run",{runs:[{action:"resume",workerId:started.workerId,instructions:"enter v4"}]})); const check=f.registry(); const runtime=getWorkerRun(check,resumed.workerId,resumed.runId)!.runtime as any; check.close(); assert.match(runtime.prompt,/first version-4 Docker Sandbox run/); assert.match(runtime.prompt,/old runtime was not reattached or trusted/); await f.call("worker_control",{action:"cancel",workerId:resumed.workerId});
  } finally { await f.close(); }
});

test("resume rejects runtime downgrade and discloses an approved monotonic runtime upgrade", async () => {
  const release: any = { schemaVersion: 1, protocolVersion: 1, releaseOrdinal: 2, status: "approved", kit: { reference: "/kit", sha256: "a".repeat(64) }, image: { reference: `example.invalid/worker@sha256:${"b".repeat(64)}`, digest: "b".repeat(64) }, sandbox: { version: "v0.49.1", buildCommit: "c5b19951af121b439800029695f88bf1139a0b0b", template: { id: "template-id-1234", repository: "docker.io/akoumjian/pi-worker-r2-deadbeef", tag: "loaded", flavor: "pi-managed-worker" } }, revisions: { pi: "1".repeat(40), profile: "2".repeat(40), piTools: "3".repeat(40), piDocparser: "4".repeat(40) }, guest: { stagedLockSha256: "e".repeat(64), piCli: "/usr/bin/pi", rpcLauncher: "/opt/pi-worker/launch.mjs", codingAgentDir: "/run/pi-worker/agent", resourceManifestSha256: "c".repeat(64), runtimeProvenanceSha256: "d".repeat(64), extensionPaths: ["/opt/pi-tools/extensions/worker/runtime.ts"], searxngUrl: "http://host.docker.internal:18888" } };
  const f = await fixture({ sandboxRelease: release }); try {
    const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-test"],instructions:"release two"}]})); await f.event("turn_end"); await complete(f,started);
    release.releaseOrdinal=1; await assert.rejects(()=>f.call("worker_run",{runs:[{action:"resume",workerId:started.workerId,instructions:"must reject downgrade"}]}),/downgrade refused/);
    release.releaseOrdinal=3; release.image={reference:`example.invalid/worker@sha256:${"d".repeat(64)}`,digest:"d".repeat(64)};
    const resumed=receipt(await f.call("worker_run",{runs:[{action:"resume",workerId:started.workerId,instructions:"adopt approved upgrade"}]})); const db=f.registry(); const runtime=getWorkerRun(db,resumed.workerId,resumed.runId)!.runtime as any; db.close(); assert.equal(runtime.releaseOrdinal,3); assert.match(runtime.prompt,/Approved runtime changed/); assert.match(runtime.prompt,/executable contracts were refreshed/);
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
    await f.commands.get("worker:cancel").handler(started.workerId, f.context); assert.match(f.notifications.at(-1)!, /Cancelled/); await acknowledgeWorkerDeliveries(f, started.workerId);
    await f.commands.get("worker:discard").handler(`${started.workerId} --confirm`, f.context); assert.match(f.notifications.at(-1)!, /Discarded/);
  } finally { await f.close(); }
});

function gitInit(repo: string): void { mkdirSync(repo, { recursive: true }); execFileSync("git", ["init", "-q", "-b", "main", repo]); git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.invalid"); }
function git(repo: string, ...args: string[]): string { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim(); }
function readDirs(root: string): string[] { return readdirSync(root).filter((name) => !name.startsWith(".")); }
function relativeTree(root: string): string[] { const result: string[]=[]; if(!existsSync(root))return result; const visit=(directory:string,relative="")=>{for(const name of readdirSync(directory).sort()){const item=path.join(directory,name),next=relative?`${relative}/${name}`:name,stat=lstatSync(item);result.push(`${next}:${stat.isDirectory()?"d":stat.isFile()?"f":stat.isSymbolicLink()?"l":"o"}`);if(stat.isDirectory())visit(item,next);}};visit(root);return result; }

test("resume rejects a worker-planted symlink in a fixed writable storage directory", async () => {
  const f = await fixture(); try {
    const started = receipt(await f.call("worker_run", { runs: [{ action: "start", role: "work", taskIds: ["personal-test"], instructions: "storage probe" }] }));
    await f.event("turn_end"); await f.call("worker_control", { action: "cancel", workerId: started.workerId });
    const db = f.registry(); const worker = getWorker(db, started.workerId)!; db.close();
    const target = path.join(f.root, "worker-cache-symlink-target"); mkdirSync(target); const cache = path.join(worker.workspaceRoot, "cache"); rmSync(cache, { recursive: true, force: true }); symlinkSync(target, cache, "dir");
    await assert.rejects(f.call("worker_run", { runs: [{ action: "resume", workerId: started.workerId, instructions: "must reject planted storage" }] }), /worker cache directory/);
    assert.deepEqual(readdirSync(target), []);
  } finally { await f.close(); }
});

test("post-containment storage-policy violations system-finalize and remain discardable", async () => {
  const f=await fixture(); try {
    const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-test"],instructions:"storage violation after containment"}]})); await f.event("turn_end");
    const launch=writeCompletionEvidence(f,started,{outcome:"completed",summary:"must become trusted system failure"}); const db=f.registry(); const workspace=getWorker(db,started.workerId)!.workspaceRoot; db.close();
    const scratch=path.join(workspace,"scratch"), outside=path.join(f.root,"outside"); mkdirSync(outside); rmSync(scratch,{recursive:true,force:true}); symlinkSync(outside,scratch);
    launch.resolve(launch.job("exited",0)); await waitFor(()=>{const check=f.registry();const run=getWorkerRun(check,started.workerId,started.runId);check.close();return run?.status==="settled";});
    const settled=f.registry(); const worker=getWorker(settled,started.workerId)!, run=getWorkerRun(settled,started.workerId,started.runId)!; settled.close(); assert.equal(worker.activeRunId,undefined); assert.equal(run.outcome,"failed"); assert.equal(run.outcomeSource,"system"); assert.match(run.errors[0]!.message,/storage policy violation/i);
    const cancelled=await f.call("worker_control",{action:"cancel",workerId:started.workerId}); assert.equal((cancelled.details as any).cancellation,"not_active"); await acknowledgeWorkerDeliveries(f,started.workerId); await f.call("worker_control",{action:"discard",workerId:started.workerId}); const after=f.registry(); assert.equal(getWorker(after,started.workerId),undefined); after.close();
  } finally { await f.close(); }
});

test("cleanup_inventory preview and one-use apply discard a delivered closed-task worker through real host logs", async () => {
  const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-cleanup"],instructions:"cleanup"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);
    const inventory=await f.call("worker_control",{action:"cleanup_inventory"}) as any;const item=inventory.details.inventory.workers.find((value:any)=>value.workerId===started.workerId);assert.equal(item.class,"due");assert.equal(typeof item.version,"number");
    const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;assert.match(preview.details.token,/^cleanup_[a-f0-9]{48}$/);const logDir=f.launches.find((value)=>value.record.runId===started.runId)!.job("exited",0).logDir;
    const applied=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}) as any;assert.equal(applied.details.cleanup.results[0].status,"discarded");const db=f.registry();assert.equal(getWorker(db,started.workerId),undefined);db.close();assert.equal(existsSync(logDir),false);await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}),/consumed/);
  }finally{await f.close();}
});

test("cleanup_apply rejects a stale version without consuming the persisted preview", async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-stale"],instructions:"stale"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;let db=f.registry();db.database.prepare("UPDATE workers SET version=version+1 WHERE worker_id=?").run(started.workerId);db.close();await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}),/stale/);db=f.registry();assert.ok((db.database.prepare("SELECT consumed_at FROM cleanup_snapshots WHERE token=?").get(preview.details.token) as any).consumed_at,"stale snapshots are deterministically invalidated");db.close();}finally{await f.close();}
});

test("cleanup_apply binds exact open-task abandonment consent",async()=>{
 const f=await fixture({beadsStatus:"open"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-open"],instructions:"open"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}),/Open-task abandonment/);const applied=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token,openTaskAbandonmentAcknowledged:[started.workerId]}) as any;assert.equal(applied.details.cleanup.results[0].status,"discarded");}finally{await f.close();}
});

test("cleanup notices are generation-scoped, self-describing, and Beads-unavailable state alone stays silent",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-notice"],instructions:"notice"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const before=f.messages.length;await f.event("agent_end");assert.equal(f.messages.length,before+1);const notice=f.messages.at(-1)!;assert.match(notice.details.guidance,/Top-level workers and preparedIds are the only routine automatic cleanup candidates/);assert.match(notice.details.guidance,/attention\.\* and otherSessions.*explicit review.*never automatic discard/);assert.equal(JSON.parse(notice.content).guidance,notice.details.guidance);assert.equal(notice.details.workers[0].workerId,started.workerId);assert.deepEqual(notice.details.preparedIds,[]);const renderer=f.renderers.get("worker-cleanup")!,theme={fg:(color:string,value:string)=>`${color}:${value}`};assert.match(renderer(notice,{},theme).render(200).join("\n"),/warning:cleanup due · 1 routine candidate/);const mixed=renderer({details:{workers:[{}],additionalWorkers:0,preparedIds:[],additionalPrepared:0,attention:{explicitDecision:["prepared_mixed"]},otherSessions:[],additionalOtherSessions:0,otherSessionsPartial:false}},{},theme).render(200).join("\n");assert.match(mixed,/warning:cleanup due · 1 routine candidate · 1 attention/);const incomplete=renderer({details:{workers:[],additionalWorkers:0,preparedIds:[],additionalPrepared:0,attention:{},otherSessions:[],additionalOtherSessions:0,otherSessionsPartial:false,currentSessionPartial:true}},{},theme).render(200).join("\n");assert.match(incomplete,/warning:cleanup inventory incomplete · explicit review required/);const first=f.messages.filter((message)=>message.details?.event==="worker_cleanup_due").length;await f.event("agent_end");assert.equal(f.messages.filter((message)=>message.details?.event==="worker_cleanup_due").length,first);const reloaded=await f.reload();await reloaded.event("agent_end");await waitFor(()=>f.messages.filter((message)=>message.details?.event==="worker_cleanup_due").length>first);
 }finally{await f.close();}
 const unavailable=await fixture({beadsStatus:"unavailable"});try{const started=receipt(await unavailable.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-unavailable"],instructions:"silent"}]}));await unavailable.event("turn_end");await complete(unavailable,started);await acknowledgeWorkerDeliveries(unavailable,started.workerId);const before=unavailable.messageAttempts.length;await unavailable.event("agent_end");assert.equal(unavailable.messageAttempts.length,before);}finally{await unavailable.close();}
});

test("only absent unclaimed terminal prepared audits stay silent while uncertain and actionable state remains visible",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const parent=realpathSync(f.session.getSessionFile()!),preparedRoot=path.join(f.runtimeRoot,"prepared"),completed="prepared_265b13e4ad6f190e195965a9",superseded=`prepared_${"a".repeat(24)}`,completedRoot=`prepared_${"b".repeat(24)}`,supersededRoot=`prepared_${"c".repeat(24)}`,claimed=`prepared_${"d".repeat(24)}`,symlink=`prepared_${"e".repeat(24)}`,partial=`prepared_${"f".repeat(24)}`,unknown=`prepared_${"9".repeat(24)}`;mkdirSync(preparedRoot,{recursive:true});for(const id of [completedRoot,supersededRoot])mkdirSync(path.join(preparedRoot,id));symlinkSync(f.root,path.join(preparedRoot,symlink));let db=f.registry();const put=(preparedId:string,status:string,createdAt:string,taskIds:string[]=[])=>storePreparedSet(db,{preparedId,parentSessionFile:parent,status,order:[preparedId],taskIds,repositories:[{id:preparedId,taskIds}],createdAt});put(completed,"completed","2026-01-01T00:00:00.000Z");put(superseded,"superseded","2026-01-01T00:00:01.000Z");put(completedRoot,"completed","2026-01-01T00:00:02.000Z");put(supersededRoot,"superseded","2026-01-01T00:00:03.000Z");put(claimed,"completed","2026-01-01T00:00:04.000Z");put(symlink,"completed","2026-01-01T00:00:05.000Z");put(partial,"partial","2026-01-01T00:00:06.000Z",["personal-partial"]);put(unknown,"inconsistent","2026-01-01T00:00:07.000Z");db.database.prepare("UPDATE prepared_sets SET apply_nonce='residual-claim' WHERE prepared_id=?").run(claimed);db.close();const inventory=await f.call("worker_control",{action:"cleanup_inventory"}) as any,byId=new Map(inventory.details.inventory.prepared.map((item:any)=>[item.preparedId,item]));assert.equal(byId.has(completed),false);assert.equal(byId.has(superseded),false);assert.equal((byId.get(completedRoot) as any)?.class,"explicit_decision");assert.equal((byId.get(supersededRoot) as any)?.class,"explicit_decision");assert.equal((byId.get(claimed) as any)?.class,"claimed");assert.equal((byId.get(symlink) as any)?.class,"explicit_decision");assert.equal((byId.get(partial) as any)?.class,"partial");assert.equal((byId.get(unknown) as any)?.class,"explicit_decision");db=f.registry();assert.ok(db.database.prepare("SELECT 1 FROM prepared_sets WHERE prepared_id=?").get(completed));assert.ok(db.database.prepare("SELECT 1 FROM prepared_sets WHERE prepared_id=?").get(superseded));db.close();const before=f.messages.length;await f.event("agent_end");await waitFor(()=>f.messages.length>before);const notice=f.messages.at(-1)!;assert.deepEqual(notice.details.workers,[]);assert.deepEqual(notice.details.preparedIds,[]);assert.deepEqual(new Set(notice.details.attention.explicitDecision),new Set([completedRoot,supersededRoot,symlink,unknown]));assert.deepEqual(notice.details.attention.partial,[partial]);assert.equal(JSON.parse(notice.content).guidance,notice.details.guidance);const renderer=f.renderers.get("worker-cleanup")!,theme={fg:(color:string,value:string)=>`${color}:${value}`};const text=renderer(notice,{},theme).render(200).join("\n");assert.match(text,/warning:cleanup attention · 5 items · explicit review required/);assert.doesNotMatch(text,/cleanup due · 0/);
 }finally{await f.close();}
});

test("a symlinked prepared root keeps terminal audit rows visible",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const parent=realpathSync(f.session.getSessionFile()!),preparedRoot=path.join(f.runtimeRoot,"prepared"),target=path.join(f.root,"prepared-target"),preparedId=`prepared_${"8".repeat(24)}`;rmSync(preparedRoot,{recursive:true,force:true});mkdirSync(target,{recursive:true});symlinkSync(target,preparedRoot,"dir");const db=f.registry();storePreparedSet(db,{preparedId,parentSessionFile:parent,status:"completed",order:[preparedId],taskIds:[],repositories:[{id:preparedId,taskIds:[]}],createdAt:"2026-01-01T00:00:00.000Z"});db.close();const inventory=await f.call("worker_control",{action:"cleanup_inventory"}) as any;const row=inventory.details.inventory.prepared.find((item:any)=>item.preparedId===preparedId);assert.equal(row?.class,"explicit_decision");
 }finally{await f.close();}
});

test("cleanup_apply continues after an exact host-log preflight failure without claiming the failed worker",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const batch=await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-batch-one"],instructions:"one"},{action:"start",role:"work",taskIds:["personal-batch-two"],instructions:"two"}]}) as any;const [first,second]=batch.details.runs;await f.event("turn_end");await complete(f,first);await complete(f,second);await acknowledgeWorkerDeliveries(f,first.workerId);await acknowledgeWorkerDeliveries(f,second.workerId);const badLaunch=f.launches.find((value)=>value.record.runId===first.runId)!;const metaPath=path.join(badLaunch.job("exited",0).logDir,"meta.json");const meta=JSON.parse(readFileSync(metaPath,"utf8"));writeFileSync(metaPath,JSON.stringify({...meta,command:"not the exact worker host"}));const beforeVersion=(()=>{const db=f.registry();const version=getWorker(db,first.workerId)!.version;db.close();return version;})();const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[first.workerId,second.workerId]}) as any;const applied=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}) as any;assert.equal(applied.isError,true);assert.equal(applied.details.cleanup.results.find((item:any)=>item.id===first.workerId).status,"failed");assert.equal(applied.details.cleanup.results.find((item:any)=>item.id===second.workerId).status,"discarded");const db=f.registry();const retained=getWorker(db,first.workerId)!;assert.equal(retained.operationKind,undefined);assert.equal(retained.version,beforeVersion);assert.equal(getWorker(db,second.workerId),undefined);db.close();}finally{await f.close();}
});

test("first agent_end reports other-session cleanup even when the current session owns zero workers",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-other"],instructions:"other"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const oldSeed=SessionManager.create(f.root,path.join(f.root,"retired-parent"),{id:"retired"});writeFileSync(oldSeed.getSessionFile()!,`${JSON.stringify(oldSeed.getHeader())}\n`);const oldManager=SessionManager.open(oldSeed.getSessionFile()!,oldSeed.getSessionDir());oldManager.appendSessionInfo("Earlier owner name");oldManager.appendSessionInfo("Retired cleanup owner");const old=oldManager.getSessionFile()!;const db=f.registry();db.database.prepare("UPDATE workers SET parent_session_file=?,version=version+1 WHERE worker_id=?").run(path.resolve(old),started.workerId);db.close();const before=f.messages.length;await f.event("agent_end");await waitFor(()=>f.messages.length>before);const notice=f.messages.at(-1)!.details;assert.equal(notice.workers.length,0);assert.equal(notice.otherSessions.length,1);assert.equal(notice.otherSessions[0].owner.state,"named");assert.equal(notice.otherSessions[0].workerIds[0],started.workerId);const renderer=f.renderers.get("worker-cleanup")!,theme={fg:(color:string,value:string)=>`${color}:${value}`};assert.match(renderer(f.messages.at(-1),{},theme).render(200).join("\n"),/warning:cleanup attention · 1 item · explicit review required/);const first=f.messageAttempts.filter((message)=>message.details?.event==="worker_cleanup_due").length;await f.event("agent_end");assert.equal(f.messageAttempts.filter((message)=>message.details?.event==="worker_cleanup_due").length,first);}finally{await f.close();}
});

test("an irreversible discard host-log failure is retained and completed by fresh-generation recovery",async()=>{
 const f=await fixture({beadsStatus:"closed",cleanupHostLogRaceOnce:true});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-recover-discard"],instructions:"recover discard"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const result=await f.call("worker_control",{action:"discard",workerId:started.workerId}) as any;assert.equal(result.isError,true);let db=f.registry();const interrupted=getWorker(db,started.workerId)!;assert.equal(interrupted.operationKind,"discard");assert.match(interrupted.recoveryError??"",/Irreversible discard/);db.close();assert.equal(existsSync(path.join(f.workersRoot,started.workerId)),false);assert.equal(readdirSync(f.workersRoot).some((name)=>name.startsWith(`${started.workerId}.discard-`)),true);await f.reload();await waitFor(()=>{const check=f.registry();const absent=getWorker(check,started.workerId)===undefined;check.close();return absent;});assert.equal(readdirSync(f.workersRoot).some((name)=>name.startsWith(`${started.workerId}.discard-`)),false);}finally{await f.close();}
});

test("current-session pending completion is ineligible for cleanup preview and apply",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-current-pending"],instructions:"pending"}]}));await f.event("turn_end");await complete(f,started);await assert.rejects(()=>f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}),/Current-session.*non-delivered/);const db=f.registry();assert.ok(getWorker(db,started.workerId));db.close();}finally{await f.close();}
});

test("spawned foreign owner liveness, recovery race, death takeover, and stale delivery CAS are fail-closed",async()=>{
 const f=await fixture({beadsStatus:"closed",discardRootFailsOnce:true});let first:ReturnType<typeof spawn>|undefined,revived:ReturnType<typeof spawn>|undefined;try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-foreign-owner"],instructions:"foreign"}]}));await f.event("turn_end");await complete(f,started);const ownerSeed=SessionManager.create(f.root,path.join(f.root,"foreign-owner"),{id:"foreign-owner"});writeFileSync(ownerSeed.getSessionFile()!,`${JSON.stringify(ownerSeed.getHeader())}\n`);const ownerManager=SessionManager.open(ownerSeed.getSessionFile()!,ownerSeed.getSessionDir());ownerManager.appendSessionInfo("Earlier foreign name");ownerManager.appendSessionInfo("Foreign cleanup owner");const foreign=ownerManager.getSessionFile()!;let db=f.registry();db.database.prepare("UPDATE workers SET parent_session_file=?,version=version+1 WHERE worker_id=?").run(realpathSync(foreign),started.workerId);db.database.prepare("UPDATE deliveries SET parent_session_file=?,state='pending',runtime_generation=NULL,send_started_at=NULL WHERE worker_id=?").run(realpathSync(foreign),started.workerId);db.close();const live=await spawnDeliveryClaimOwner(f,started,foreign);first=live.child;const claimed=await live.claim();const previewLive=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;assert.equal(previewLive.details.workers[0].authority.state,"live");assert.equal(previewLive.details.workers[0].worker.owner.name,"Foreign cleanup owner");await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:previewLive.details.token,claimedDeliveryTakeoverAcknowledged:[started.workerId]}),/live or ambiguous/);await stopLifecycleClaimOwner(first);first=undefined;const deadPreview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;assert.equal(deadPreview.details.workers[0].authority.state,"dead");const recoveryOwner=await spawnDeliveryClaimOwner(f,started,foreign);revived=recoveryOwner.child;await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:deadPreview.details.token,claimedDeliveryTakeoverAcknowledged:[started.workerId]}),/stale|authority/i);await stopLifecycleClaimOwner(revived);revived=undefined;const finalPreview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;const applied=await f.call("worker_control",{action:"cleanup_apply",token:finalPreview.details.token,claimedDeliveryTakeoverAcknowledged:[started.workerId]}) as any;assert.equal(applied.isError,true);db=f.registry();assert.ok(getWorker(db,started.workerId),"failed discard must retain the worker row");assert.equal((db.database.prepare("SELECT state FROM deliveries WHERE delivery_id=?").get(`worker-run:${started.workerId}:${started.runId}`) as {state:string}).state,"delivered");assert.equal(Number(db.database.prepare("UPDATE deliveries SET delivered_at='late' WHERE delivery_id=? AND state='claimed' AND runtime_generation=?").run(`worker-run:${started.workerId}:${started.runId}`,claimed.generation).changes),0,"the old owner CAS must lose against a retained delivered row");db.close();const retry=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;const recovered=await f.call("worker_control",{action:"cleanup_apply",token:retry.details.token,recoveryAcknowledged:[started.workerId]}) as any;assert.equal(recovered.details.cleanup.results[0].status,"discarded");}finally{if(first)await stopLifecycleClaimOwner(first);if(revived)await stopLifecycleClaimOwner(revived);await f.close();}
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
 const f=await fixture({beadsStatus:"closed",tui:true});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-slash-cleanup"],instructions:"slash"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const command=f.commands.get("worker:cleanup");await command.handler("",f.context);const previewNotice=f.notifications.at(-1)!;const token=/cleanup_[a-f0-9]{48}/.exec(previewNotice)?.[0];assert.ok(token);await command.handler(`--confirm ${token}`,f.context);const db=f.registry();assert.equal(getWorker(db,started.workerId),undefined);db.close();assert.match(f.notifications.at(-1)!,/Cleanup completed.*worker/s);}finally{await f.close();}
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


test("lease pair stays adopter-owned after reviewer failure, owner revival, and exact retry",async()=>{
 const f=await fixture({beadsStatus:"closed",discardRootFailsOnce:true});try{const subject=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-pair-recovery"],instructions:"subject"}]}));await f.event("turn_end");await complete(f,subject);const reviewer=receipt(await f.call("worker_run",{runs:[{action:"start",role:"review",reviewedRunId:subject.runId,instructions:"review"}]}));await f.event("turn_end");let db=f.registry();const reviewerWorkspace=getWorker(db,reviewer.workerId)!.workspaceRoot;db.close();mkdirSync(path.join(reviewerWorkspace,"reports"),{recursive:true});writeFileSync(path.join(reviewerWorkspace,"reports","review.md"),"approved\n");await complete(f,reviewer,{outcome:"approve",summary:"approved",artifacts:["reports/review.md"]});await acknowledgeWorkerDeliveries(f,reviewer.workerId);const originalOwner=path.join(f.root,"revived-original-owner.jsonl");db=f.registry();db.database.prepare("UPDATE workers SET parent_session_file=?,version=version+1 WHERE worker_id IN (?,?)").run(path.resolve(originalOwner),subject.workerId,reviewer.workerId);const heldLease=db.database.prepare("UPDATE workers SET reviewed_by_worker_id=?,version=version+1 WHERE worker_id=? AND reviewed_by_worker_id IS NULL").run(reviewer.workerId,subject.workerId);assert.equal(Number(heldLease.changes),1,"the regression fixture must retain the reviewer/subject lease unit");const resetDelivery=db.database.prepare("UPDATE deliveries SET parent_session_file=?,state='pending',runtime_generation=NULL,send_started_at=NULL WHERE worker_id=?").run(path.resolve(originalOwner),subject.workerId);assert.equal(Number(resetDelivery.changes),1,"subject must retain one delivery for takeover");db.close();const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[reviewer.workerId]}) as any;const pendingIds=preview.details.workers.filter((item:any)=>item.worker.pendingResults.some((delivery:any)=>delivery.state==="pending")).map((item:any)=>item.worker.workerId);assert.deepEqual(pendingIds,[subject.workerId],"the lease-unit test must exercise a real pending-result takeover");const failed=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token,pendingDeliveryTakeoverAcknowledged:pendingIds,artifactLossAcknowledged:preview.details.workers.filter((item:any)=>item.worker.unpreservedArtifacts.length).map((item:any)=>item.worker.workerId)}) as any;assert.equal(failed.isError,true);db=f.registry();const currentParent=realpathSync(f.session.getSessionFile()!);for(const id of [reviewer.workerId,subject.workerId]){const retained=getWorker(db,id)!;assert.equal(retained.parentSessionFile,currentParent);assert.match(retained.recoveryError??"",/injected root claim failure/);assert.ok((retained.runtime as any).cleanupConsent);}assert.equal((db.database.prepare("SELECT state FROM deliveries WHERE worker_id=?").get(subject.workerId) as {state:string}).state,"delivered");registerParentRuntime(db,path.resolve(originalOwner),"revived-owner",new Date().toISOString(),{pid:process.pid,processStartToken:asyncJobProcessStartToken(process.pid)!});db.close();const retry=await f.call("worker_control",{action:"cleanup_preview",workerIds:[reviewer.workerId]}) as any;const recovered=await f.call("worker_control",{action:"cleanup_apply",token:retry.details.token,recoveryAcknowledged:[reviewer.workerId,subject.workerId],artifactLossAcknowledged:retry.details.workers.filter((item:any)=>item.worker.unpreservedArtifacts.length).map((item:any)=>item.worker.workerId)}) as any;assert.equal(recovered.details.cleanup.results.every((item:any)=>item.status==="discarded"),true);db=f.registry();assert.equal(getWorker(db,reviewer.workerId),undefined);assert.equal(getWorker(db,subject.workerId),undefined);db.close();}finally{await f.close();}
});

async function makeForeignRecoveryFixture(ownerState:"missing"|"dead"){
 const f=await fixture({beadsStatus:"closed",discardRootFailsOnce:true});const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:[`personal-${ownerState}-recovery`],instructions:"recover"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const original=path.join(f.root,`${ownerState}-original.jsonl`);let db=f.registry();db.database.prepare("UPDATE workers SET parent_session_file=?,version=version+1 WHERE worker_id=?").run(path.resolve(original),started.workerId);db.close();const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;const failed=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}) as any;assert.equal(failed.isError,true);const foreign=path.join(f.root,`${ownerState}-dead-adopter.jsonl`);db=f.registry();db.database.prepare("UPDATE workers SET parent_session_file=?,version=version+1 WHERE worker_id=?").run(path.resolve(foreign),started.workerId);if(ownerState==="dead")registerParentRuntime(db,path.resolve(foreign),"dead-adopter",new Date().toISOString(),{pid:2_147_000_000,processStartToken:"dead-owner"});db.close();return{f,started,foreign};
}

test("missing and dead foreign adopters permit only exact preview-bound precommit recovery",async()=>{
 for(const state of ["missing","dead"] as const){const{f,started}=await makeForeignRecoveryFixture(state);try{const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:preview.details.token}),/Recovery retry/);const applied=await f.call("worker_control",{action:"cleanup_apply",token:preview.details.token,recoveryAcknowledged:[started.workerId]}) as any;assert.equal(applied.details.cleanup.results[0].status,"discarded");}finally{await f.close();}}
});

test("foreign recovery owner revival between preview and apply fails closed",async()=>{
 const{f,started,foreign}=await makeForeignRecoveryFixture("dead");try{const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;const db=f.registry();registerParentRuntime(db,path.resolve(foreign),"revived-adopter",new Date().toISOString(),{pid:process.pid,processStartToken:asyncJobProcessStartToken(process.pid)!});db.close();await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:preview.details.token,recoveryAcknowledged:[started.workerId]}),/stale|authority|live or ambiguous/i);const retained=f.registry();assert.ok(getWorker(retained,started.workerId));retained.close();}finally{await f.close();}
});

test("foreign irreversible recovery evidence is never adoptable",async()=>{
 const{f,started}=await makeForeignRecoveryFixture("missing");try{const db=f.registry(),worker=getWorker(db,started.workerId)!,runtime={...worker.runtime,cleanupRecovery:{...(worker.runtime as any).cleanupRecovery,phase:"irreversible"}};db.database.prepare("UPDATE workers SET runtime_json=?,version=version+1 WHERE worker_id=?").run(JSON.stringify(runtime),started.workerId);db.close();const preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;await assert.rejects(()=>f.call("worker_control",{action:"cleanup_apply",token:preview.details.token,recoveryAcknowledged:[started.workerId]}),/irreversible|pre-commit/);const retained=f.registry();assert.ok(getWorker(retained,started.workerId));retained.close();}finally{await f.close();}
});

test("bounded owner identity recovers early names, marks unread middle, and honors tail clear/update",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-owner-name"],instructions:"identity"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const seed=SessionManager.create(f.root,path.join(f.root,"large-owner"),{id:"large-owner"});writeFileSync(seed.getSessionFile()!,`${JSON.stringify(seed.getHeader())}\n`);const manager=SessionManager.open(seed.getSessionFile()!,seed.getSessionDir());manager.appendSessionInfo("Early practical owner");writeFileSync(seed.getSessionFile()!,`${"x".repeat(1024)}\n`.repeat(200),{flag:"a"});const owner=realpathSync(seed.getSessionFile()!);let db=f.registry();db.database.prepare("UPDATE workers SET parent_session_file=?,version=version+1 WHERE worker_id=?").run(owner,started.workerId);db.close();let preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;let identity=preview.details.workers[0].worker.owner;assert.equal(identity.state,"truncated");assert.equal(identity.truncated,true);assert.equal(identity.name,"Early practical owner");manager.appendSessionInfo("");preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;identity=preview.details.workers[0].worker.owner;assert.equal(identity.state,"unnamed");assert.equal(identity.name,undefined);assert.equal(identity.truncated,true);manager.appendSessionInfo("Latest tail owner");preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;identity=preview.details.workers[0].worker.owner;assert.equal(identity.state,"named");assert.equal(identity.name,"Latest tail owner");assert.equal(identity.truncated,true);}finally{await f.close();}
});

test("cleanup slash confirmation reports exact failures and partial prepared warnings",async()=>{
 const f=await fixture({beadsStatus:"closed",tui:true,discardRootFailsOnce:true});try{const started=receipt(await f.call("worker_run",{runs:[{action:"start",role:"work",taskIds:["personal-slash-failure"],instructions:"slash failure"}]}));await f.event("turn_end");await complete(f,started);await acknowledgeWorkerDeliveries(f,started.workerId);const command=f.commands.get("worker:cleanup"),preview=await f.call("worker_control",{action:"cleanup_preview",workerIds:[started.workerId]}) as any;await command.handler(`--confirm ${preview.details.token}`,f.context);assert.match(f.notifications.at(-1)!,new RegExp(`Cleanup failed[\\s\\S]*${started.workerId}: failed[\\s\\S]*injected root claim failure`));assert.doesNotMatch(f.notifications.at(-1)!,/snapshot applied/i);let db=f.registry();assert.ok(getWorker(db,started.workerId));const preparedId=`prepared_${"9".repeat(24)}`;storePreparedSet(db,{preparedId,parentSessionFile:realpathSync(f.session.getSessionFile()!),status:"partial",order:["repo"],taskIds:["personal-slash-failure"],repositories:[{id:"repo",taskIds:["personal-slash-failure"]}],createdAt:"2026-01-01T00:00:00.000Z"});db.close();const prepared=await f.call("worker_control",{action:"cleanup_preview",preparedIds:[preparedId]}) as any;await command.handler(`--confirm ${prepared.details.token}`,f.context);assert.match(f.notifications.at(-1)!,new RegExp(`prepared ${preparedId}: discarded · warning: Discarded a partially applied prepared set`));}finally{await f.close();}
});

test("cleanup slash preview preserves the filesystem continuation cursor",async()=>{
 const f=await fixture({beadsStatus:"closed",tui:true});try{const old=new Date("2025-12-20T00:00:00.000Z");for(let index=0;index<40;index+=1){const id=`worker_20251220000000_${index.toString(16).padStart(8,"0")}`,root=path.join(f.workersRoot,id);mkdirSync(root,{recursive:true});utimesSync(root,old,old);}const command=f.commands.get("worker:cleanup");await command.handler("--all-sessions",f.context);assert.match(f.notifications.at(-1)!,/Resume filesystem inventory: --all-sessions --cursor cleanup_scan_[a-f0-9]{48}/);}finally{await f.close();}
});

test("other-session aggregate completing exactly on page ten is not marked partial",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const db=f.registry(),owner=path.join(f.root,"missing-exact-ten-owner.jsonl");for(let index=0;index<1000;index+=1){const suffix=index.toString(16).padStart(8,"0"),workerId=`worker_20260102020202_${suffix}`,runId=`run_20260102020202_${suffix}`,createdAt=`2026-01-01T00:00:${String(index%60).padStart(2,"0")}.000Z`;createWorkerAndRun(db,{workerId,parentSessionFile:owner,role:"work",status:"idle",latestRunId:runId,taskIds:[`personal-ten-${index}`],workspaceRoot:path.join(f.workersRoot,workerId,"workspace"),runtime:{},createdAt,updatedAt:createdAt},{runId,workerId,status:"settled",taskIds:[`personal-ten-${index}`],completionDelivery:"steer",outcome:"completed",outcomeSource:"worker",summary:"done",repositories:[],artifacts:[],errors:[],runtime:{},createdAt,settledAt:createdAt});}db.close();const before=f.messages.length;await f.event("agent_end");await waitFor(()=>f.messages.length>before,15_000);const notice=f.messages.at(-1)!.details;assert.equal(notice.otherSessions[0].additionalWorkers,992);assert.equal(notice.otherSessionsPartial,false);assert.equal(notice.otherSessionsNextOffset,undefined);}finally{await f.close();}
});

test("changed scan roots invalidate and consume their one-use cursor",async()=>{
 const f=await fixture({beadsStatus:"closed"});try{const old=new Date("2025-12-20T00:00:00.000Z");for(let index=0;index<40;index+=1){const root=path.join(f.workersRoot,`worker_20251221000000_${index.toString(16).padStart(8,"0")}`);mkdirSync(root,{recursive:true});utimesSync(root,old,old);}const first=await f.call("worker_control",{action:"cleanup_inventory",allSessions:true,limit:32}) as any,token=first.details.inventory.nextCursor;assert.match(token,/^cleanup_scan_/);mkdirSync(path.join(f.workersRoot,"ordinary-new-entry"));utimesSync(f.workersRoot,new Date("2026-01-02T00:00:00.000Z"),new Date("2026-01-02T00:00:00.000Z"));await assert.rejects(()=>f.call("worker_control",{action:"cleanup_inventory",allSessions:true,limit:32,cursor:token}),/invalidated/);const db=f.registry(),row=db.database.prepare("SELECT consumed_at FROM cleanup_scan_cursors WHERE token=?").get(token) as {consumed_at:string|null};assert.ok(row.consumed_at);db.close();}finally{await f.close();}
});
