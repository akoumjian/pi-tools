import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  adoptCleanupWorkers, advanceCleanupScanCursor, buildCleanupInventory, claimPreparedSetDiscard, classifyCleanupWorker, classifyPreparedCleanupIds, createCleanupSnapshot, loadCleanupSnapshot, loadCleanupScanCursor, consumeCleanupSnapshot, readCleanupBeadsFacts, deletePlannedWorkerHostLogs, planSettledWorkerHostLogs,
  deleteCleanupLeftover, preserveWorkerArtifacts, existingAncestorIdentityOverlap, preflightWorkerDiscard, recoverPreparedSetDiscards, scanCleanupLeftovers, unpreservedArtifacts
} from "../extensions/worker/cleanup.js";
import { claimWorkerDiscard, createWorkerAndRun, finalizeWorkerDiscard, getWorker, openWorkerRegistry, storePreparedSet, type NewWorkerRegistryRecord, type WorkerRegistry, type WorkerRegistryRecord, type WorkerRunRecord } from "../extensions/worker/registry.js";
import { workerHostJobRoot, workerPaths, type WorkerRoots } from "../extensions/worker/identity.js";
import { startManagedAsyncJob } from "../extensions/async-shell/index.js";
import { matchWorkerHostJobIdentity, workerHostJobIdentity } from "../extensions/_shared/worker-host-job.js";

const WORKER_A = "worker_20261025100002_aaaaaaaa";
const WORKER_B = "worker_20261025100002_bbbbbbbb";
const RUN_A = "run_20261025100002_aaaaaaaa";

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-worker-cleanup-")));
  const runtimeRoot = path.join(root, "runtime"); const workersRoot = path.join(runtimeRoot, "workers"); const roots: WorkerRoots = { stateRoot: workersRoot, workspaceRoot: workersRoot }; const hostJobRoot = workerHostJobRoot(runtimeRoot);
  const registry = openWorkerRegistry(runtimeRoot); const parent = path.join(root, "parent.jsonl"); writeFileSync(parent, "");
  return { root, runtimeRoot, roots, hostJobRoot, registry, parent, close() { registry.close(); rmSync(root, { recursive: true, force: true }); } };
}

function insertSettled(registry: WorkerRegistry, roots: WorkerRoots, parent: string, input: { workerId?: string; runId?: string; role?: "work" | "review" | "integration"; artifacts?: string[]; recoveryError?: string; owner?: string; reviewedByWorkerId?: string; binding?:any; job?: { id: string; stdout: string; stderr: string } } = {}) {
  const workerId = input.workerId ?? WORKER_A; const runId = input.runId ?? RUN_A; const paths = workerPaths(roots, workerId);
  mkdirSync(paths.stateDir, { recursive: true }); mkdirSync(paths.workspaceRoot, { recursive: true });
  const now = "2026-10-25T10:00:02.000Z";
  const worker: NewWorkerRegistryRecord = { workerId, parentSessionFile: input.owner ?? parent, role: input.role ?? "work", status: "idle", latestRunId: runId, taskIds: ["personal-test"], workspaceRoot: paths.workspaceRoot, ...(input.recoveryError ? { recoveryError: input.recoveryError } : {}), ...(input.reviewedByWorkerId ? { reviewedByWorkerId: input.reviewedByWorkerId } : {}), createdAt: now, updatedAt: now };
  const run: WorkerRunRecord = { workerId, runId, status: "settled", taskIds: ["personal-test"], completionDelivery: "steer", ...(input.job ? { jobId: input.job.id, stdoutLog: input.job.stdout, stderrLog: input.job.stderr } : {}), outcome: "completed", outcomeSource: "worker", summary: "done", ...(input.binding?{binding:input.binding}:{}), repositories: [], artifacts: input.artifacts ?? [], errors: [], createdAt: now, settledAt: now };
  createWorkerAndRun(registry, worker, run); return getWorker(registry, workerId)!;
}

const closed = new Map([["personal-test", { id: "personal-test", status: "closed" }]] as const);

test("cleanup classification fails closed and derives due without storing relevance", () => {
  const f = fixture(); try {
    const worker = insertSettled(f.registry, f.roots, f.parent);
    assert.equal(classifyCleanupWorker(f.registry, worker, new Map(closed)).class, "due");
    assert.equal(classifyCleanupWorker(f.registry, worker, new Map([["personal-test", "missing"]])).class, "unknown:task_missing");
    assert.equal(classifyCleanupWorker(f.registry, worker, new Map([["personal-test", "unavailable"]])).class, "unknown:beads_unavailable");
    assert.equal(classifyCleanupWorker(f.registry, worker, new Map([["personal-test", { id: "personal-test", status: "in_progress" }]])).class, "retained");
    f.registry.database.prepare("UPDATE workers SET recovery_error='repair me' WHERE worker_id=?").run(worker.workerId);
    assert.equal(classifyCleanupWorker(f.registry, getWorker(f.registry, worker.workerId)!, new Map(closed)).class, "recovery");
  } finally { f.close(); }
});

test("preservation publishes atomically and provides exact latest-run artifact coverage", async () => {
  const f = fixture(); try {
    const artifact = "artifacts/report.bin"; const worker = insertSettled(f.registry, f.roots, f.parent, { artifacts: [artifact] });
    const source = path.join(worker.workspaceRoot, artifact); mkdirSync(path.dirname(source), { recursive: true }); writeFileSync(source, Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(unpreservedArtifacts(f.registry, worker), [artifact]);
    const destination = path.join(f.root, "published", "evidence"); const result = await preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, projectCwd:f.root, nonce: "a".repeat(32) });
    assert.equal(result.items[0], artifact); assert.deepEqual(readFileSync(path.join(destination, artifact)), Buffer.from([0, 1, 2, 255]));
    assert.equal(JSON.parse(readFileSync(path.join(destination, "worker-preservation.json"), "utf8")).workerId, worker.workerId);
    assert.deepEqual(unpreservedArtifacts(f.registry, getWorker(f.registry, worker.workerId)!), []);
    assert.throws(() => preflightWorkerDiscard(f.registry, f.parent, { workerIds: [worker.workerId], artifactLossAcknowledged: [WORKER_B] }), /subset/);
  } finally { f.close(); }
});

test("preservation rejects symlinks, nested git, runtime destinations, and publishes nothing", async () => {
  const f = fixture(); try {
    const worker = insertSettled(f.registry, f.roots, f.parent, { artifacts: ["artifacts/tree"] }); const tree = path.join(worker.workspaceRoot, "artifacts", "tree"); mkdirSync(tree, { recursive: true }); symlinkSync(f.parent, path.join(tree, "escape"));
    const destination = path.join(f.root, "out"); await assert.rejects(() => preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, projectCwd:f.root, nonce: "b".repeat(32) }), /symlink/); assert.equal(existsSync(destination), false);
    rmSync(path.join(tree, "escape")); mkdirSync(path.join(tree, ".git")); await assert.rejects(() => preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, projectCwd:f.root, nonce: "c".repeat(32) }), /nested \.git/);
    await assert.rejects(() => preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination: path.join(f.runtimeRoot, "archive"), projectCwd:f.root, nonce: "d".repeat(32) }), /managed worker or sensitive storage/);
  } finally { f.close(); }
});

test("shared worker-host identity accepts only exact current and legacy bindings", () => {
  const current = workerHostJobIdentity(WORKER_A, RUN_A), legacy = workerHostJobIdentity(WORKER_A, RUN_A, "legacy");
  assert.equal(matchWorkerHostJobIdentity(current)?.format, "sandbox");
  assert.equal(matchWorkerHostJobIdentity({ command: legacy.command })?.format, "legacy");
  assert.equal(matchWorkerHostJobIdentity({ managedBy: current.managedBy }), undefined);
  assert.equal(matchWorkerHostJobIdentity({ ...current, command: `${current.command} trailing` }), undefined);
  assert.equal(matchWorkerHostJobIdentity({ command: current.command, managedBy: { ...current.managedBy, runId: "run_20261025100002_bbbbbbbb" } }), undefined);
  assert.equal(matchWorkerHostJobIdentity({ command: current.command, managedBy: { ...current.managedBy, extra: true } }), undefined);
  assert.equal(matchWorkerHostJobIdentity(current, { workerId: WORKER_B, runId: RUN_A }), undefined);
});

test("host-log cleanup requires exact metadata identity and never removes mismatches", () => {
  const f = fixture(); try {
    const jobId = "job_20261025100002_aaaaaaaa"; const directory = path.join(f.hostJobRoot, "jobs", jobId); mkdirSync(directory, { recursive: true }); const stdout = path.join(directory, "stdout.log"); const stderr = path.join(directory, "stderr.log"); writeFileSync(stdout, "ok"); writeFileSync(stderr, "");
    const worker = insertSettled(f.registry, f.roots, f.parent, { job: { id: jobId, stdout, stderr } }); const identity = workerHostJobIdentity(worker.workerId, RUN_A); writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ jobId, command: identity.command, managedBy: identity.managedBy, status: "exited", stdoutLog: stdout, stderrLog: stderr }));
    const plan = planSettledWorkerHostLogs(f.registry, worker, f.hostJobRoot); assert.deepEqual(plan.deletable.map((item) => item.path), [directory]);writeFileSync(path.join(directory,"meta.json"),JSON.stringify({jobId,command:identity.command,managedBy:identity.managedBy,status:"running",stdoutLog:stdout,stderrLog:stderr}));assert.throws(()=>deletePlannedWorkerHostLogs(plan),/metadata changed/);assert.equal(existsSync(directory),true);writeFileSync(path.join(directory,"meta.json"),JSON.stringify({jobId,command:identity.command,managedBy:identity.managedBy,status:"exited",stdoutLog:stdout,stderrLog:stderr}));const clean=deletePlannedWorkerHostLogs(planSettledWorkerHostLogs(f.registry,worker,f.hostJobRoot));assert.deepEqual(clean,[directory]); assert.equal(existsSync(directory), false);
  } finally { f.close(); }
});

test("host-log cleanup retains exact legacy command compatibility", () => {
  const f = fixture(); try {
    const jobId = "job_20261025100002_legacyaa"; const directory = path.join(f.hostJobRoot, "jobs", jobId); mkdirSync(directory, { recursive: true });
    const stdout = path.join(directory, "stdout.log"), stderr = path.join(directory, "stderr.log"); writeFileSync(stdout, ""); writeFileSync(stderr, "");
    const worker = insertSettled(f.registry, f.roots, f.parent, { job: { id: jobId, stdout, stderr } });
    writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ jobId, command: workerHostJobIdentity(worker.workerId, RUN_A, "legacy").command, status: "exited", stdoutLog: stdout, stderrLog: stderr }));
    assert.deepEqual(deletePlannedWorkerHostLogs(planSettledWorkerHostLogs(f.registry, worker, f.hostJobRoot)), [directory]);
  } finally { f.close(); }
});

test("unknown host-log status requires a complete provably dead process identity", () => {
  const f = fixture(); try {
    const jobId = "job_20261025100002_cccccccc"; const directory = path.join(f.hostJobRoot, "jobs", jobId); mkdirSync(directory, { recursive: true }); const stdout = path.join(directory, "stdout.log"); const stderr = path.join(directory, "stderr.log"); writeFileSync(stdout, ""); writeFileSync(stderr, ""); const worker = insertSettled(f.registry, f.roots, f.parent, { job: { id: jobId, stdout, stderr } });
    writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ jobId, command: workerHostJobIdentity(worker.workerId, RUN_A).command, status: "unknown", stdoutLog: stdout, stderrLog: stderr })); const clean = planSettledWorkerHostLogs(f.registry, worker, f.hostJobRoot); assert.equal(clean.deletable.length, 0); assert.match(clean.leftovers[0]!.reason, /process identity is incomplete/); assert.equal(existsSync(directory), true);
  } finally { f.close(); }
});

test("host-log mismatch is a reported leftover", () => {
  const f = fixture(); try {
    const jobId = "job_20261025100002_bbbbbbbb"; const directory = path.join(f.hostJobRoot, "jobs", jobId); mkdirSync(directory, { recursive: true }); const stdout = path.join(directory, "stdout.log"); const stderr = path.join(directory, "stderr.log"); writeFileSync(stdout, ""); writeFileSync(stderr, ""); const worker = insertSettled(f.registry, f.roots, f.parent, { job: { id: jobId, stdout, stderr } });
    writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ jobId, command: "not the worker", status: "exited" })); const clean = planSettledWorkerHostLogs(f.registry, worker, f.hostJobRoot); assert.equal(clean.deletable.length, 0); assert.match(clean.leftovers[0]!.reason, /identity mismatch/); assert.equal(existsSync(directory), true);
  } finally { f.close(); }
});

test("prepared discard is claim-first, idempotently recoverable, and refuses apply claims", () => {
  const f = fixture(); try {
    const preparedRoot = path.join(f.root, "prepared"); const preparedId = "prepared_aaaaaaaaaaaaaaaaaaaaaaaa"; mkdirSync(path.join(preparedRoot, preparedId), { recursive: true }); storePreparedSet(f.registry, { preparedId, parentSessionFile: f.parent, status: "ready", order: ["repo"], taskIds: ["personal-test"], repositories: [{ id: "repo" }], createdAt: "2026-10-25T10:00:02.000Z" });
    assert.equal(claimPreparedSetDiscard(f.registry, f.parent, preparedId, "2026-10-25T10:01:00.000Z").partial, false); assert.deepEqual(recoverPreparedSetDiscards(f.registry, preparedRoot), [preparedId]); assert.equal(existsSync(path.join(preparedRoot, preparedId)), false);
    const claimed = "prepared_bbbbbbbbbbbbbbbbbbbbbbbb"; storePreparedSet(f.registry, { preparedId: claimed, parentSessionFile: f.parent, status: "ready", order: [], repositories: [], createdAt: "2026-10-25T10:00:02.000Z" }); f.registry.database.prepare("UPDATE prepared_sets SET apply_nonce='held' WHERE prepared_id=?").run(claimed); assert.throws(() => claimPreparedSetDiscard(f.registry, f.parent, claimed, "now"), /cannot be discarded/);
  } finally { f.close(); }
});

test("cross-session adoption acknowledges the exact pending delivery and snapshot tokens are one-use", async () => {
  const f=fixture();try{const owner=path.join(f.root,"old.jsonl");writeFileSync(owner,"");insertSettled(f.registry,f.roots,f.parent,{owner});f.registry.database.prepare("INSERT INTO deliveries(delivery_id,parent_session_file,worker_id,run_id,completion_delivery,state,created_at) VALUES(?,?,?,?,?,'pending',?)").run("delivery-a",owner,WORKER_A,RUN_A,"steer","2026-10-25T10:00:02.000Z");const bd=path.join(f.root,"bd");writeFileSync(bd,"#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='where')console.log(JSON.stringify({prefix:'personal',path:'/Users/aleck/.local/share/agent/beads/personal',database_path:'/Users/aleck/.local/share/agent/beads/personal/.beads/embeddeddolt'}));else console.log(JSON.stringify(a.filter(x=>x.startsWith('personal-')).map(id=>({id,status:'closed'}))));\n");chmodSync(bd,0o700);
    const preview=await createCleanupSnapshot(f.registry,{parentSessionFile:f.parent,workerIds:[WORKER_A],cwd:f.root,roots:f.roots,preparedRoot:path.join(f.root,"prepared"),bdPath:bd,now:new Date("2026-10-25T10:02:00.000Z"),ownerAuthority:()=>({state:"missing"})});const loaded=loadCleanupSnapshot(f.registry,f.parent,preview.token);assert.equal(loaded.snapshotHash,preview.snapshotHash);adoptCleanupWorkers(f.registry,{snapshots:loaded.snapshot.workers,newParentSessionFile:f.parent,claimWorkerIds:[],nonce:"n",pendingAcknowledged:new Set([WORKER_A]),claimedAcknowledged:new Set(),ownerAuthority:()=>({state:"missing"}),now:"2026-10-25T10:03:00.000Z"});assert.equal(getWorker(f.registry,WORKER_A)!.parentSessionFile,path.resolve(f.parent));assert.equal((f.registry.database.prepare("SELECT state FROM deliveries WHERE delivery_id='delivery-a'").get() as any).state,"delivered");consumeCleanupSnapshot(f.registry,f.parent,preview.token,preview.snapshotHash,"2026-10-25T10:04:00.000Z");assert.throws(()=>loadCleanupSnapshot(f.registry,f.parent,preview.token),/consumed/);
  }finally{f.close();}
});

test("claimed delivery takeover requires exact acknowledgement and a dead or unavailable owner", async()=>{
 const f=fixture();try{const owner=path.join(f.root,"old.jsonl");insertSettled(f.registry,f.roots,f.parent,{owner});f.registry.database.prepare("INSERT INTO deliveries(delivery_id,parent_session_file,worker_id,run_id,completion_delivery,state,runtime_generation,created_at) VALUES(?,?,?,?,?,'claimed',1,?)").run("delivery-b",owner,WORKER_A,RUN_A,"steer","2026-10-25T10:00:02.000Z");const bd=path.join(f.root,"bd");writeFileSync(bd,"#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='where')console.log(JSON.stringify({prefix:'personal',path:'/Users/aleck/.local/share/agent/beads/personal',database_path:'/Users/aleck/.local/share/agent/beads/personal/.beads/embeddeddolt'}));else console.log(JSON.stringify(a.filter(x=>x.startsWith('personal-')).map(id=>({id,status:'closed'}))));\n");chmodSync(bd,0o700);const preview=await createCleanupSnapshot(f.registry,{parentSessionFile:f.parent,workerIds:[WORKER_A],cwd:f.root,roots:f.roots,preparedRoot:path.join(f.root,"prepared"),bdPath:bd,now:new Date("2026-10-25T10:02:00.000Z"),ownerAuthority:()=>({state:"missing"})});const snapshots=preview.snapshot.workers;assert.throws(()=>adoptCleanupWorkers(f.registry,{snapshots,newParentSessionFile:f.parent,claimWorkerIds:[],nonce:"n",pendingAcknowledged:new Set(),claimedAcknowledged:new Set(),ownerAuthority:()=>({state:"missing"}),now:"x"}),/acknowledgement/);assert.equal(getWorker(f.registry,WORKER_A)!.parentSessionFile,path.resolve(owner));adoptCleanupWorkers(f.registry,{snapshots,newParentSessionFile:f.parent,claimWorkerIds:[],nonce:"n",pendingAcknowledged:new Set(),claimedAcknowledged:new Set([WORKER_A]),ownerAuthority:()=>({state:"missing"}),now:"y"});assert.equal((f.registry.database.prepare("SELECT state FROM deliveries WHERE delivery_id='delivery-b'").get() as any).state,"delivered");assert.equal(Number(f.registry.database.prepare("UPDATE deliveries SET delivered_at='late' WHERE delivery_id='delivery-b' AND state='claimed' AND runtime_generation=1").run().changes),0,"the original claimed-owner CAS must lose");}finally{f.close();}
});

test("production-shaped managed Sandbox host metadata plans, deletes, and inventories through cleanup", async () => {
  const f = fixture(); try {
    const api = { sendMessage() {} } as unknown as ExtensionAPI;
    const context = { cwd: f.root, sessionManager: { getSessionId: () => "cleanup-real-host" } } as ExtensionContext;
    const jobId = "job_20261025100002_realhost";
    const directory = path.join(f.hostJobRoot, "jobs", jobId);
    const worker = insertSettled(f.registry, f.roots, f.parent, { job: { id: jobId, stdout: path.join(directory, "stdout.log"), stderr: path.join(directory, "stderr.log") } });
    const identity = workerHostJobIdentity(worker.workerId, RUN_A);
    const handle = startManagedAsyncJob(api, context, {
      jobId, job_name: `worker ${worker.workerId}`, command: identity.command, cwd: worker.workspaceRoot, executable: process.execPath, args: ["-e", "process.exit(0)"], env: { ...process.env, PI_WORKER_ID: worker.workerId, PI_WORKER_RUN_ID: RUN_A }, notifyOnExit: false, settleProcessGroup: true, processToken: "123e4567-e89b-42d3-a456-426614174401", jobRoot: f.hostJobRoot, managedBy: identity.managedBy
    });
    const completed = await Promise.race([handle.completion, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("managed Sandbox host fixture timed out")), 2_000))]);
    assert.equal(completed.status, "exited");
    const persisted = JSON.parse(readFileSync(path.join(directory, "meta.json"), "utf8"));
    assert.equal(persisted.command, identity.command); assert.deepEqual(persisted.managedBy, identity.managedBy);
    assert.deepEqual(deletePlannedWorkerHostLogs(planSettledWorkerHostLogs(f.registry, worker, f.hostJobRoot)), [directory]); assert.equal(existsSync(directory), false);

    const orphanWorkerId = "worker_20261023100002_realhost", orphanRunId = "run_20261023100002_realhost", orphanJobId = "job_20261023100002_realhost";
    const orphanIdentity = workerHostJobIdentity(orphanWorkerId, orphanRunId);
    const orphan = startManagedAsyncJob(api, context, {
      jobId: orphanJobId, job_name: `worker ${orphanWorkerId}`, command: orphanIdentity.command, cwd: f.root, executable: process.execPath, args: ["-e", "process.exit(0)"], env: { ...process.env, PI_WORKER_ID: orphanWorkerId, PI_WORKER_RUN_ID: orphanRunId }, notifyOnExit: false, settleProcessGroup: true, processToken: "123e4567-e89b-42d3-a456-426614174402", jobRoot: f.hostJobRoot, managedBy: orphanIdentity.managedBy
    });
    const orphanCompleted = await Promise.race([orphan.completion, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("orphan Sandbox host fixture timed out")), 2_000))]);
    assert.equal(orphanCompleted.status, "exited");
    const old = new Date("2026-10-23T10:00:00.000Z"), now = new Date("2026-10-25T10:00:02.000Z"); utimesSync(orphanCompleted.logDir, old, old);
    const leftovers = await scanCleanupLeftovers(f.registry, { roots: f.roots, preparedRoot: path.join(f.root, "prepared"), hostJobRoot: f.hostJobRoot, projectCwd: f.root, now });
    const historical = leftovers.find((item) => item.path === orphanCompleted.logDir); assert.equal(historical?.kind, "worker_host_log"); assert.equal(historical?.eligible, true);
  } finally { f.close(); }
});

test("all-session leftover scan identifies and revalidates aged orphan roots and historical worker logs", async () => {
  const f = fixture(); try {
    const old = new Date("2026-10-23T10:00:00.000Z"); const now = new Date("2026-10-25T10:00:02.000Z");
    const orphanId = "worker_20261023100002_cccccccc"; const orphan = path.join(f.roots.stateRoot, orphanId); mkdirSync(orphan, { recursive: true }); utimesSync(orphan, old, old);
    const preparedRoot = path.join(f.root, "prepared"); const preparedId = "prepared_cccccccccccccccccccccccc"; const prepared = path.join(preparedRoot, preparedId); mkdirSync(prepared, { recursive: true }); utimesSync(prepared, old, old);
    const jobId = "job_20261023100002_cccccccc"; const job = path.join(f.hostJobRoot, "jobs", jobId); mkdirSync(job, { recursive: true }); const stdout = path.join(job, "stdout.log"); const stderr = path.join(job, "stderr.log"); writeFileSync(stdout, ""); writeFileSync(stderr, ""); writeFileSync(path.join(job, "meta.json"), JSON.stringify({ jobId, command: workerHostJobIdentity(orphanId, "run_20261023100002_cccccccc").command, status: "exited", stdoutLog: stdout, stderrLog: stderr })); utimesSync(job, old, old);
    const leftovers = await scanCleanupLeftovers(f.registry, { roots: f.roots, preparedRoot, hostJobRoot: f.hostJobRoot, projectCwd: f.root, now }); assert.deepEqual(leftovers.map((item) => item.kind).sort(), ["prepared_root", "worker_host_log", "worker_root"]); assert.equal(leftovers.every((item) => item.eligible), true);
    for (const leftover of leftovers) await deleteCleanupLeftover(f.registry, leftover, { roots: f.roots, preparedRoot, hostJobRoot: f.hostJobRoot, projectCwd: f.root, now }); assert.equal(existsSync(orphan), false); assert.equal(existsSync(prepared), false); assert.equal(existsSync(job), false);
  } finally { f.close(); }
});


test("bounded Beads facts verify the personal route and fall back to four-wide exact reads", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-worker-beads-facts-")); try {
    const script = path.join(root, "bd"); writeFileSync(script, `#!/usr/bin/env node
const a=process.argv.slice(2); if(a[0]==='where') console.log(JSON.stringify({prefix:'personal',path:'/central',database_path:'/central/.beads/embeddeddolt'})); else if(a[0]==='show'&&a.filter(x=>x.startsWith('personal-')).length>1) process.exit(2); else { const id=a.find(x=>x.startsWith('personal-')); console.log(JSON.stringify(id==='personal-missing'?[]:[{id,status:'closed'}])); }
`); chmodSync(script, 0o700);
    const facts = await readCleanupBeadsFacts(["personal-one", "personal-two", "personal-missing"], { bdPath: script, cwd: root }); assert.equal((facts.get("personal-one") as any).status, "closed"); assert.equal((facts.get("personal-two") as any).status, "closed"); assert.equal(facts.get("personal-missing"), "missing");
    const wrong = path.join(root, "wrong-bd"); writeFileSync(wrong, "#!/usr/bin/env node\nconsole.log(JSON.stringify({prefix:'other',path:'/wrong',database_path:'/wrong'}));\n"); chmodSync(wrong, 0o700); assert.equal((await readCleanupBeadsFacts(["personal-one"], { bdPath: wrong, cwd: root })).get("personal-one"), "unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preservation recovery refuses an inconsistent recorded temporary path without deleting it", async () => {
  const f = fixture(); try {
    const artifact = "artifacts/report.txt"; const worker = insertSettled(f.registry, f.roots, f.parent, { artifacts: [artifact] }); mkdirSync(path.join(worker.workspaceRoot, "artifacts"), { recursive: true }); writeFileSync(path.join(worker.workspaceRoot, artifact), "evidence");
    const destination = path.join(f.root, "archive"); const inconsistent = path.join(f.root, "must-not-delete"); mkdirSync(inconsistent);
    f.registry.database.prepare(`INSERT INTO preservation_records(preservation_id,worker_id,status,destination,temp_path,latest_run_id,items_json,created_at,updated_at) VALUES(?,?,'pending',?,?,?,?,?,?)`).run("preservation_inconsistent", worker.workerId, destination, inconsistent, worker.latestRunId!, JSON.stringify([artifact]), "2026-10-25T10:00:00.000Z", "2026-10-25T10:00:00.000Z");
    await assert.rejects(() => preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, projectCwd:f.root, nonce: "9".repeat(32) }), /temporary path is inconsistent/); assert.equal(existsSync(inconsistent), true);
  } finally { f.close(); }
});

test("preservation retry removes only its recorded stale temporary path and recovers post-rename publication", async () => {
  const f = fixture(); try {
    const artifact = "artifacts/report.txt"; const worker = insertSettled(f.registry, f.roots, f.parent, { artifacts: [artifact] }); mkdirSync(path.join(worker.workspaceRoot, "artifacts"), { recursive: true }); writeFileSync(path.join(worker.workspaceRoot, artifact), "evidence");
    const destination = path.join(f.root, "archive"); const stale = path.join(f.root, `.archive.worker-preserve-${"1".repeat(24)}`); mkdirSync(stale); writeFileSync(path.join(stale, "partial"), "x");
    f.registry.database.prepare(`INSERT INTO preservation_records(preservation_id,worker_id,status,destination,temp_path,latest_run_id,items_json,created_at,updated_at) VALUES(?,?,'pending',?,?,?,?,?,?)`).run("preservation_stale", worker.workerId, destination, stale, worker.latestRunId!, JSON.stringify([artifact]), "2026-10-25T10:00:00.000Z", "2026-10-25T10:00:00.000Z");
    const first = await preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, projectCwd:f.root, nonce: "e".repeat(32) }); assert.equal(existsSync(stale), false); assert.equal((f.registry.database.prepare("SELECT status FROM preservation_records WHERE preservation_id='preservation_stale'").get() as any).status, "failed");
    f.registry.database.prepare("UPDATE preservation_records SET status='pending' WHERE preservation_id=?").run(first.preservationId);
    const recovered = await preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, projectCwd:f.root, nonce: "f".repeat(32) }); assert.equal(recovered.preservationId, first.preservationId); assert.equal((f.registry.database.prepare("SELECT status FROM preservation_records WHERE preservation_id=?").get(first.preservationId) as any).status, "published");
  } finally { f.close(); }
});

test("preservation rejects an intermediate worker-planted symlink before reading host bytes",async()=>{
 const f=fixture();try{const host=path.join(f.root,"host");mkdirSync(host);writeFileSync(path.join(host,"secret"),"TOP-SECRET");const worker=insertSettled(f.registry,f.roots,f.parent,{artifacts:["artifacts/secret"]});symlinkSync(host,path.join(worker.workspaceRoot,"artifacts"));const destination=path.join(f.root,"published","evidence");await assert.rejects(()=>preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination,projectCwd:f.root,nonce:"7".repeat(32)}),/symlink ancestor/);assert.equal(existsSync(destination),false);}finally{f.close();}
});

test("preservation lock refuses a live publisher and recovers an exact dead owner",async()=>{
 const f=fixture();try{const artifact="artifacts/report.txt";const worker=insertSettled(f.registry,f.roots,f.parent,{artifacts:[artifact]});mkdirSync(path.join(worker.workspaceRoot,"artifacts"));writeFileSync(path.join(worker.workspaceRoot,artifact),"evidence");const destination=path.join(f.root,"published","evidence");mkdirSync(path.dirname(destination),{recursive:true});const lock=path.join(path.dirname(destination),`.${path.basename(destination)}.worker-preserve.lock`);const {asyncJobProcessStartToken}=await import("../extensions/_shared/async-job-process.js");writeFileSync(lock,JSON.stringify({version:1,pid:process.pid,processStartToken:asyncJobProcessStartToken(process.pid),preservationId:"live",destination}));await assert.rejects(()=>preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination,projectCwd:f.root,nonce:"6".repeat(32)}),/live or ambiguous/);unlinkSync(lock);writeFileSync(lock,JSON.stringify({version:1,pid:2147483647,processStartToken:"dead:owner",preservationId:"dead",destination}));const result=await preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination,projectCwd:f.root,nonce:"5".repeat(32)});assert.equal(result.destination,destination);assert.equal(existsSync(lock),false);}finally{f.close();}
});

test("canonical forbidden roots hold when TMPDIR and runtime paths use a symlink alias",async()=>{
 const base=mkdtempSync(path.join(tmpdir(),"pi-cleanup-real-"));const alias=`${base}-alias`;symlinkSync(base,alias);const previous=process.env.TMPDIR;process.env.TMPDIR=alias;let f:ReturnType<typeof fixture>|undefined;try{f=fixture();const artifact="artifacts/report.txt";const worker=insertSettled(f.registry,f.roots,f.parent,{artifacts:[artifact]});mkdirSync(path.join(worker.workspaceRoot,"artifacts"));writeFileSync(path.join(worker.workspaceRoot,artifact),"evidence");const canonicalRuntime=path.resolve(base,path.relative(alias,f.runtimeRoot));await assert.rejects(()=>preserveWorkerArtifacts(f!.registry,f!.roots,f!.runtimeRoot,{workerId:worker.workerId,destination:path.join(canonicalRuntime,"archive"),projectCwd:f!.root,nonce:"4".repeat(32)}),/managed worker or sensitive storage/);}finally{f?.close();if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;unlinkSync(alias);rmSync(base,{recursive:true,force:true});}
});


test("preservation universally case-folds sensitive aliases and accepts a symlinked nearest destination ancestor",async()=>{
 const f=fixture();try{const artifact="artifacts/report.txt",worker=insertSettled(f.registry,f.roots,f.parent,{artifacts:[artifact]});mkdirSync(path.join(worker.workspaceRoot,"artifacts"));writeFileSync(path.join(worker.workspaceRoot,artifact),"evidence");const upperRuntime=path.join(f.runtimeRoot.toUpperCase(),"archive");await assert.rejects(()=>preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination:upperRuntime,projectCwd:f.root,nonce:"a".repeat(32)}),/managed worker or sensitive storage/);const upperPi=path.join(homedir().toUpperCase(),".PI","agent","extensions","worker-copy");await assert.rejects(()=>preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination:upperPi,projectCwd:f.root,nonce:"b".repeat(32)}),/\.pi component|managed worker or sensitive storage/);const realParent=path.join(f.root,"real-destination");mkdirSync(realParent);const alias=path.join(f.root,"destination-alias");symlinkSync(realParent,alias);const result=await preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination:path.join(alias,"published"),projectCwd:f.root,nonce:"c".repeat(32)});assert.equal(result.destination,path.join(realParent,"published"));assert.equal(readFileSync(path.join(realParent,"published",artifact),"utf8"),"evidence");}finally{f.close();}
});


test("preservation rejects project Pi execution paths and filesystem-identity aliases",async()=>{
 const f=fixture();try{const artifact="artifacts/index.ts",worker=insertSettled(f.registry,f.roots,f.parent,{artifacts:[artifact]});mkdirSync(path.join(worker.workspaceRoot,"artifacts"));writeFileSync(path.join(worker.workspaceRoot,artifact),"export default true;");const projectExtension=path.join(f.root,".pi","extensions","evil","index.ts");await assert.rejects(()=>preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination:projectExtension,projectCwd:f.root,nonce:"d".repeat(32)}),/\.pi component|sensitive storage/);const folded=path.join(f.root,"ordinary",".PI","extensions","evil");await assert.rejects(()=>preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination:folded,projectCwd:f.root,nonce:"e".repeat(32)}),/\.pi component/);const mountAlias=path.join(f.root,"mount-alias"),forbidden=path.join(f.root,"forbidden");mkdirSync(mountAlias);mkdirSync(forbidden);const fakeIdentity=(value:string)=>path.resolve(value)===path.resolve(forbidden)||path.resolve(value)===path.resolve(mountAlias)?{dev:91,ino:42}:{dev:91,ino:createHash("sha256").update(path.resolve(value)).digest().readUInt32BE(0)};assert.equal(existingAncestorIdentityOverlap(path.join(mountAlias,"publish"),[forbidden],fakeIdentity),true,"a second mount/firmlink path with the forbidden root inode must be refused");}finally{f.close();}
});

test("preservation refuses a real macOS Data-volume firmlink alias of the worker workspace",async(t)=>{
 const f=fixture();try{if(process.platform!=="darwin"){t.skip("macOS firmlink evidence only");return;}const artifact="artifacts/firmlink.txt",worker=insertSettled(f.registry,f.roots,f.parent,{artifacts:[artifact]});mkdirSync(path.join(worker.workspaceRoot,"artifacts"));writeFileSync(path.join(worker.workspaceRoot,artifact),"evidence");const aliasWorkspace=`/System/Volumes/Data${worker.workspaceRoot}`;if(!existsSync(aliasWorkspace)){t.skip("Data-volume alias unavailable");return;}const direct=statSync(worker.workspaceRoot),alias=statSync(aliasWorkspace);if(Number(direct.dev)!==Number(alias.dev)||Number(direct.ino)!==Number(alias.ino)){t.skip("Data-volume path is not an identity alias on this host");return;}await assert.rejects(()=>preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination:path.join(aliasWorkspace,"published"),projectCwd:f.root,nonce:"f".repeat(32)}),/filesystem identity|managed worker or sensitive storage/);assert.equal(existsSync(path.join(worker.workspaceRoot,"published")),false);
 }finally{f.close();}
});

test("reviewer and subject are co-adopted atomically while only the reviewer receives the first discard claim",async()=>{
 const f=fixture();try{const owner=path.join(f.root,"old.jsonl");const reviewerId=WORKER_B;insertSettled(f.registry,f.roots,f.parent,{workerId:reviewerId,runId:"run_20261025100002_bbbbbbbb",role:"review",owner,binding:{reviewedWorkerId:WORKER_A,reviewedRunId:RUN_A}});insertSettled(f.registry,f.roots,f.parent,{workerId:WORKER_A,owner,reviewedByWorkerId:reviewerId});const bd=path.join(f.root,"bd-pair");writeFileSync(bd,"#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='where')console.log(JSON.stringify({prefix:'personal',path:'/central',database_path:'/central/.beads/embeddeddolt'}));else console.log(JSON.stringify(a.filter(x=>x.startsWith('personal-')).map(id=>({id,status:'closed'}))));\n");chmodSync(bd,0o700);const preview=await createCleanupSnapshot(f.registry,{parentSessionFile:f.parent,workerIds:[reviewerId],cwd:f.root,roots:f.roots,preparedRoot:path.join(f.root,"prepared"),bdPath:bd,ownerAuthority:()=>({state:"missing"})});assert.deepEqual(preview.snapshot.workers.map((item)=>item.item.workerId).sort(),[WORKER_A,reviewerId].sort());const nonce="pair-claim";adoptCleanupWorkers(f.registry,{snapshots:preview.snapshot.workers,newParentSessionFile:f.parent,claimWorkerIds:[reviewerId],nonce,now:"2026-10-25T10:03:00.000Z",pendingAcknowledged:new Set(),claimedAcknowledged:new Set(),ownerAuthority:()=>({state:"missing"})});let reviewer=getWorker(f.registry,reviewerId)!,subject=getWorker(f.registry,WORKER_A)!;assert.equal(reviewer.operationKind,"discard");assert.equal(subject.operationKind,undefined);assert.equal(subject.reviewedByWorkerId,reviewerId);finalizeWorkerDiscard(f.registry,reviewerId,nonce);subject=getWorker(f.registry,WORKER_A)!;assert.equal(subject.reviewedByWorkerId,undefined);assert.equal(subject.version,preview.snapshot.workers.find((item)=>item.item.workerId===WORKER_A)!.item.version+2,"reviewer-first handoff has an exact version trajectory");const fresh="subject-claim";claimWorkerDiscard(f.registry,subject.workerId,subject.version,fresh,"2026-10-25T10:04:00.000Z");assert.equal(getWorker(f.registry,WORKER_A)!.operationNonce,fresh);
 }finally{f.close();}
});

test("owner liveness changing after preview blocks adoption atomically",async()=>{
 const f=fixture();try{const owner=path.join(f.root,"old.jsonl");insertSettled(f.registry,f.roots,f.parent,{owner});const bd=path.join(f.root,"bd-owner");writeFileSync(bd,"#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='where')console.log(JSON.stringify({prefix:'personal',path:'/central',database_path:'/central/.beads/embeddeddolt'}));else console.log(JSON.stringify(a.filter(x=>x.startsWith('personal-')).map(id=>({id,status:'closed'}))));\n");chmodSync(bd,0o700);const preview=await createCleanupSnapshot(f.registry,{parentSessionFile:f.parent,workerIds:[WORKER_A],cwd:f.root,roots:f.roots,preparedRoot:path.join(f.root,"prepared"),bdPath:bd,ownerAuthority:()=>({state:"missing"})});assert.throws(()=>adoptCleanupWorkers(f.registry,{snapshots:preview.snapshot.workers,newParentSessionFile:f.parent,claimWorkerIds:[WORKER_A],nonce:"n",now:"now",pendingAcknowledged:new Set(),claimedAcknowledged:new Set(),ownerAuthority:()=>({state:"live",generation:2,members:[]})}),/authority.*changed/);assert.equal(getWorker(f.registry,WORKER_A)!.parentSessionFile,path.resolve(owner));}finally{f.close();}
});

test("leftover inventory pages more than 32 historical host logs without whole-snapshot refusal",async()=>{
 const f=fixture();try{const old=new Date("2026-10-23T10:00:00.000Z"),now=new Date("2026-10-25T10:00:02.000Z");for(let index=0;index<40;index+=1){const suffix=index.toString(16).padStart(8,"0"),workerId=`worker_20261023100002_${suffix}`,runId=`run_20261023100002_${suffix}`,jobId=`job_20261023100002_${suffix}`,directory=path.join(f.hostJobRoot,"jobs",jobId);mkdirSync(directory,{recursive:true});const stdout=path.join(directory,"stdout.log"),stderr=path.join(directory,"stderr.log");writeFileSync(stdout,"");writeFileSync(stderr,"");writeFileSync(path.join(directory,"meta.json"),JSON.stringify({jobId,command:workerHostJobIdentity(workerId,runId).command,status:"exited",stdoutLog:stdout,stderrLog:stderr}));utimesSync(directory,old,old);}const first=await buildCleanupInventory(f.registry,{parentSessionFile:f.parent,allSessions:true,cwd:f.root,roots:f.roots,preparedRoot:path.join(f.root,"prepared"),hostJobRoot:f.hostJobRoot,limit:32,offset:0,now});assert.equal(first.leftovers.length,32);assert.equal(first.total.leftovers,32);assert.equal(first.scan.partial,true);assert.ok(first.scan.continuation);const cursor=advanceCleanupScanCursor(f.registry,f.parent,undefined,first.scan.continuation,now.toISOString())!;const scanState=loadCleanupScanCursor(f.registry,f.parent,cursor);const second=await buildCleanupInventory(f.registry,{parentSessionFile:f.parent,allSessions:true,cwd:f.root,roots:f.roots,preparedRoot:path.join(f.root,"prepared"),hostJobRoot:f.hostJobRoot,limit:32,offset:0,scanState,now});assert.equal(second.total.leftovers,40);assert.equal(second.leftovers.length,8);assert.equal(second.scan.partial,false);assert.equal(advanceCleanupScanCursor(f.registry,f.parent,cursor,second.scan.continuation,now.toISOString()),undefined);assert.throws(()=>loadCleanupScanCursor(f.registry,f.parent,cursor),/consumed/);assert.equal(new Set([...first.leftovers,...second.leftovers].map((item)=>item.leftoverId)).size,40);}finally{f.close();}
});

test("interrupted cleanup trash is inventoried and explicitly recoverable",async()=>{
 const f=fixture();try{const original="worker_20261023100002_deadbeef",source=path.join(f.roots.stateRoot,original),old=new Date("2026-10-23T10:00:00.000Z"),now=new Date("2026-10-25T10:00:00.000Z");mkdirSync(source,{recursive:true});writeFileSync(path.join(source,"evidence"),"x");utimesSync(source,old,old);let leftovers=await scanCleanupLeftovers(f.registry,{roots:f.roots,preparedRoot:path.join(f.root,"prepared"),hostJobRoot:f.hostJobRoot,projectCwd:f.root,now});const sourceItem=leftovers.find((candidate)=>candidate.path===source)!;await assert.rejects(()=>deleteCleanupLeftover(f.registry,sourceItem,{roots:f.roots,preparedRoot:path.join(f.root,"prepared"),hostJobRoot:f.hostJobRoot,projectCwd:f.root,now,afterLeftoverClaim:()=>{throw new Error("simulated crash boundary")}}),/simulated crash/);const trash=path.join(f.roots.stateRoot,readdirSync(f.roots.stateRoot).find((name)=>name.startsWith(`${original}.cleanup-`))!);assert.equal(existsSync(source),false);assert.equal(Number((f.registry.database.prepare("SELECT COUNT(*) AS count FROM cleanup_leftover_claims").get() as {count:number}).count),1);leftovers=await scanCleanupLeftovers(f.registry,{roots:f.roots,preparedRoot:path.join(f.root,"prepared"),hostJobRoot:f.hostJobRoot,projectCwd:f.root,now});const item=leftovers.find((candidate)=>candidate.path===trash)!;assert.equal(item.kind,"cleanup_trash");assert.equal(item.eligible,true);await deleteCleanupLeftover(f.registry,item,{roots:f.roots,preparedRoot:path.join(f.root,"prepared"),hostJobRoot:f.hostJobRoot,projectCwd:f.root,now});assert.equal(existsSync(trash),false);assert.equal(Number((f.registry.database.prepare("SELECT COUNT(*) AS count FROM cleanup_leftover_claims").get() as {count:number}).count),0);}finally{f.close();}
});


test("recovery trash is identity-stable and passes the bounded no-follow safety walk before deletion",async(t)=>{
 const f=fixture(),preparedRoot=path.join(f.root,"prepared"),now=new Date("2026-10-25T10:00:00.000Z"),old=new Date("2026-10-23T10:00:00.000Z");
 const claimTrash=async(tag:string)=>{const source=path.join(f.roots.stateRoot,`worker_20261023100002_${tag.padStart(8,"0")}`);mkdirSync(source,{recursive:true});writeFileSync(path.join(source,"evidence"),"x");utimesSync(source,old,old);let items=await scanCleanupLeftovers(f.registry,{roots:f.roots,preparedRoot,hostJobRoot:f.hostJobRoot,projectCwd:f.root,now}),sourceItem=items.find((item)=>item.path===source)!;await assert.rejects(()=>deleteCleanupLeftover(f.registry,sourceItem,{roots:f.roots,preparedRoot,hostJobRoot:f.hostJobRoot,projectCwd:f.root,now,afterLeftoverClaim:()=>{throw new Error("retain recovery trash")}}),/retain recovery trash/);return path.join(f.roots.stateRoot,readdirSync(f.roots.stateRoot).find((name)=>name.startsWith(`${path.basename(source)}.cleanup-`))!);};
 const recoveryItem=async(trash:string)=>{const items=await scanCleanupLeftovers(f.registry,{roots:f.roots,preparedRoot,hostJobRoot:f.hostJobRoot,projectCwd:f.root,now}),item=items.find((candidate)=>candidate.path===trash)!;assert.equal(item.kind,"cleanup_trash");assert.equal(item.eligible,true);return item;};
 try{
  const privileged=await claimTrash("a1"),privilegedFile=path.join(privileged,"privileged");writeFileSync(privilegedFile,"unsafe");chmodSync(privilegedFile,0o4755);assert.notEqual(lstatSync(privilegedFile).mode&0o6000,0);const privilegedItem=await recoveryItem(privileged);await assert.rejects(()=>deleteCleanupLeftover(f.registry,privilegedItem,{roots:f.roots,preparedRoot,hostJobRoot:f.hostJobRoot,projectCwd:f.root,now}),/setuid or setgid/);assert.equal(existsSync(privileged),true);
  const special=await claimTrash("a2"),fifo=path.join(special,"fifo"),made=spawnSync("mkfifo",[fifo],{encoding:"utf8"});if(made.status===0){const specialItem=await recoveryItem(special);await assert.rejects(()=>deleteCleanupLeftover(f.registry,specialItem,{roots:f.roots,preparedRoot,hostJobRoot:f.hostJobRoot,projectCwd:f.root,now}),/special filesystem entries/);assert.equal(existsSync(special),true);}else t.diagnostic("mkfifo unavailable; special-file branch skipped");
  const stable=await claimTrash("a3"),stableItem=await recoveryItem(stable),moved=`${stable}.moved`;renameSync(stable,moved);mkdirSync(stable);await assert.rejects(()=>deleteCleanupLeftover(f.registry,stableItem,{roots:f.roots,preparedRoot,hostJobRoot:f.hostJobRoot,projectCwd:f.root,now}),/identity changed/);assert.equal(existsSync(stable),true);assert.equal(existsSync(moved),true);
  const linked=await claimTrash("a4"),outside=path.join(f.root,"outside-evidence");writeFileSync(outside,"retain");symlinkSync(outside,path.join(linked,"external-link"));await deleteCleanupLeftover(f.registry,await recoveryItem(linked),{roots:f.roots,preparedRoot,hostJobRoot:f.hostJobRoot,projectCwd:f.root,now});assert.equal(existsSync(linked),false);assert.equal(readFileSync(outside,"utf8"),"retain");
  assert.ok(Number((f.registry.database.prepare("SELECT COUNT(*) AS count FROM cleanup_leftover_claims").get() as {count:number}).count)>=3,"unsafe or identity-changed recovery evidence must remain claimed");
 }finally{f.close();}
});

const cleanupLeftoverCrashFixture=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"fixtures","cleanup-leftover-crash.js");
test("every leftover source kind recovers after a spawned claim crash and an actual partial tree removal",async()=>{
 const f=fixture();const preparedRoot=path.join(f.root,"prepared"),jobsRoot=path.join(f.hostJobRoot,"jobs"),old=new Date("2026-10-23T10:00:00.000Z"),now=new Date("2026-10-25T10:00:00.000Z");
 const createSource=(kind:"worker_root"|"worker_trash"|"prepared_root"|"worker_host_log",tag:string):string=>{let target:string;const suffix=createHash("sha256").update(`${kind}:${tag}`).digest("hex").slice(0,8);if(kind==="worker_root")target=path.join(f.roots.stateRoot,`worker_20261023100002_${suffix}`);else if(kind==="worker_trash")target=path.join(f.roots.workspaceRoot,`worker_20261023100002_${suffix}.discard-${"d".repeat(24)}`);else if(kind==="prepared_root")target=path.join(preparedRoot,`prepared_${createHash("sha256").update(tag).digest("hex").slice(0,24)}`);else{const jobId=`job_20261023100002_${suffix}`,workerId=`worker_20261023100002_${suffix}`,runId=`run_20261023100002_${suffix}`;target=path.join(jobsRoot,jobId);mkdirSync(target,{recursive:true});const stdout=path.join(target,"stdout.log"),stderr=path.join(target,"stderr.log");writeFileSync(stdout,"");writeFileSync(stderr,"");writeFileSync(path.join(target,"meta.json"),JSON.stringify({jobId,command:workerHostJobIdentity(workerId,runId).command,status:"exited",stdoutLog:stdout,stderrLog:stderr}));}mkdirSync(target,{recursive:true});writeFileSync(path.join(target,"evidence"),"retain until committed cleanup");utimesSync(target,old,old);return target;};
 const recover=async(source:string)=>{const inventory=await scanCleanupLeftovers(f.registry,{roots:f.roots,preparedRoot,hostJobRoot:f.hostJobRoot,projectCwd:f.root,now}),item=inventory.find((candidate)=>candidate.path===source)!;assert.ok(item?.eligible,`source must be eligible: ${source}`);return item;};
 try{for(const kind of ["worker_root","worker_trash","prepared_root","worker_host_log"] as const){const crashSource=createSource(kind,`c${kind[0]}`),crashItem=await recover(crashSource),inputFile=path.join(f.root,`crash-${kind}.json`);writeFileSync(inputFile,JSON.stringify({item:crashItem,roots:f.roots,preparedRoot,hostJobRoot:f.hostJobRoot,projectCwd:f.root,now:now.toISOString()}));const crashed=spawnSync(process.execPath,[cleanupLeftoverCrashFixture,f.runtimeRoot,inputFile],{encoding:"utf8"});assert.equal(crashed.status,73,crashed.stderr);const crashTrash=readdirSync(path.dirname(crashSource)).map((name)=>path.join(path.dirname(crashSource),name)).find((candidate)=>candidate.startsWith(`${crashSource}.cleanup-`))!;assert.equal(existsSync(crashSource),false);const claimedAfterCrash=await recover(crashTrash);assert.equal(claimedAfterCrash.kind,"cleanup_trash");await deleteCleanupLeftover(f.registry,claimedAfterCrash,{roots:f.roots,preparedRoot,hostJobRoot:f.hostJobRoot,projectCwd:f.root,now});assert.equal(existsSync(crashTrash),false);
 const partialSource=createSource(kind,`p${kind[0]}`),partialItem=await recover(partialSource);await assert.rejects(()=>deleteCleanupLeftover(f.registry,partialItem,{roots:f.roots,preparedRoot,hostJobRoot:f.hostJobRoot,projectCwd:f.root,now,removeClaimedTrash:(trash)=>{rmSync(path.join(trash,"evidence"),{force:true});throw new Error("injected after real partial removal");}}),/real partial removal/);const partialTrash=readdirSync(path.dirname(partialSource)).map((name)=>path.join(path.dirname(partialSource),name)).find((candidate)=>candidate.startsWith(`${partialSource}.cleanup-`))!;assert.equal(existsSync(path.join(partialTrash,"evidence")),false);const claimedAfterPartial=await recover(partialTrash);assert.equal(claimedAfterPartial.kind,"cleanup_trash");await deleteCleanupLeftover(f.registry,claimedAfterPartial,{roots:f.roots,preparedRoot,hostJobRoot:f.hostJobRoot,projectCwd:f.root,now});assert.equal(existsSync(partialTrash),false);}
 assert.equal(Number((f.registry.database.prepare("SELECT COUNT(*) AS count FROM cleanup_leftover_claims").get() as {count:number}).count),0);
 }finally{f.close();}
});

test("prepared partial state stays non-announceable when Beads is unavailable",()=>{
 const f=fixture();try{const preparedId=`prepared_${"e".repeat(24)}`;storePreparedSet(f.registry,{preparedId,parentSessionFile:f.parent,status:"partial",order:[],taskIds:["personal-test"],repositories:[{id:"repo",taskIds:["personal-test"]}],createdAt:"2026-10-25T10:00:02.000Z"});const [item]=classifyPreparedCleanupIds(f.registry,[preparedId],new Map([["personal-test","unavailable"]]));assert.equal(item!.class,"retained");assert.match(item!.reason,/unavailable/);}finally{f.close();}
});

test("unmarked cleanup-shaped trash is visible but never eligible",async()=>{
 const f=fixture();try{const trash=path.join(f.roots.stateRoot,`worker_20261023100002_unmarked.cleanup-${"c".repeat(24)}`);mkdirSync(trash,{recursive:true});const leftovers=await scanCleanupLeftovers(f.registry,{roots:f.roots,preparedRoot:path.join(f.root,"prepared"),hostJobRoot:f.hostJobRoot,projectCwd:f.root});const item=leftovers.find((candidate)=>candidate.path===trash)!;assert.equal(item.kind,"cleanup_trash");assert.equal(item.eligible,false);assert.match(item.reason,/lacks exact host-owned claim/);}finally{f.close();}
});

test("cleanup control rows are deterministically bounded without deleting workers",()=>{
 const f=fixture();try{insertSettled(f.registry,f.roots,f.parent);const before=Number((f.registry.database.prepare("SELECT COUNT(*) AS count FROM workers").get() as {count:number}).count);f.registry.database.exec("BEGIN IMMEDIATE");try{const snapshot=f.registry.database.prepare("INSERT INTO cleanup_snapshots(token,parent_session_file,snapshot_json,snapshot_hash,created_at,consumed_at) VALUES(?,?,?,?,?,?)"),cursor=f.registry.database.prepare("INSERT INTO cleanup_scan_cursors(token,parent_session_file,state_json,created_at,consumed_at) VALUES(?,?,?,?,?)"),observation=f.registry.database.prepare("INSERT INTO cleanup_leftover_observations(leftover_id,record_json,observed_at) VALUES(?,?,?)");for(let index=0;index<300;index+=1){const suffix=index.toString(16).padStart(48,"0");snapshot.run(`cleanup_${suffix}`,f.parent,"{}","a".repeat(64),`2026-01-01T00:00:${String(index%60).padStart(2,"0")}.000Z`,`2026-01-02T00:00:${String(index%60).padStart(2,"0")}.000Z`);cursor.run(`cleanup_scan_${suffix}`,f.parent,"{}",`2026-01-01T00:00:${String(index%60).padStart(2,"0")}.000Z`,`2026-01-02T00:00:${String(index%60).padStart(2,"0")}.000Z`);}for(let index=0;index<50_010;index+=1)observation.run(`leftover_${index.toString(16).padStart(24,"0")}`,"{}",`2026-01-${String(1+(index%28)).padStart(2,"0")}T00:00:00.000Z`);f.registry.database.exec("COMMIT");}catch(error){f.registry.database.exec("ROLLBACK");throw error;}advanceCleanupScanCursor(f.registry,f.parent,undefined,undefined,"2026-02-01T00:00:00.000Z");assert.ok(Number((f.registry.database.prepare("SELECT COUNT(*) AS count FROM cleanup_snapshots").get() as {count:number}).count)<=256);assert.ok(Number((f.registry.database.prepare("SELECT COUNT(*) AS count FROM cleanup_scan_cursors").get() as {count:number}).count)<=256);assert.equal(Number((f.registry.database.prepare("SELECT COUNT(*) AS count FROM cleanup_leftover_observations").get() as {count:number}).count),50_000);assert.equal(Number((f.registry.database.prepare("SELECT COUNT(*) AS count FROM workers").get() as {count:number}).count),before);}finally{f.close();}
});

test("current and legacy cleanup scanners cannot enumerate, mutate, or delete each other's prepared and host-log trees", async () => {
  const f = fixture();
  const legacyRoot = path.join(f.root, "worker-runtime");
  const legacyPreparedRoot = path.join(legacyRoot, "prepared");
  const legacyHostRoot = workerHostJobRoot(legacyRoot);
  const legacyRoots: WorkerRoots = { stateRoot: path.join(legacyRoot, "workers"), workspaceRoot: path.join(legacyRoot, "workers") };
  const currentPreparedRoot = path.join(f.runtimeRoot, "prepared");
  const old = new Date("2026-10-23T10:00:00.000Z");
  const now = new Date("2026-10-25T10:00:02.000Z");
  const makePrepared = (root: string, id: string, value: string): string => {
    const directory = path.join(root, id); mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, "sentinel"), value); utimesSync(directory, old, old); return directory;
  };
  const makeHostLog = (root: string, suffix: string): string => {
    const jobId = `job_20261023100002_${suffix}`, workerId = `worker_20261023100002_${suffix}`, runId = `run_20261023100002_${suffix}`;
    const directory = path.join(root, "jobs", jobId); mkdirSync(directory, { recursive: true });
    const stdout = path.join(directory, "stdout.log"), stderr = path.join(directory, "stderr.log"); writeFileSync(stdout, "stdout"); writeFileSync(stderr, "stderr");
    writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ jobId, command: workerHostJobIdentity(workerId, runId).command, status: "exited", stdoutLog: stdout, stderrLog: stderr }));
    utimesSync(directory, old, old); return directory;
  };
  const currentPrepared = makePrepared(currentPreparedRoot, `prepared_${"3".repeat(24)}`, "current cleanup target");
  const currentLog = makeHostLog(f.hostJobRoot, "current0");
  const legacyPrepared = makePrepared(legacyPreparedRoot, `prepared_${"4".repeat(24)}`, "legacy cleanup target");
  const legacyLog = makeHostLog(legacyHostRoot, "legacy00");
  const legacySentinel = path.join(legacyPrepared, "sentinel");
  const legacyBefore = { bytes: readFileSync(legacySentinel), stat: statSync(legacySentinel) };
  let legacyRegistry: WorkerRegistry | undefined;
  try {
    chmodSync(legacyRoot, 0o000);
    const current = await scanCleanupLeftovers(f.registry, { roots: f.roots, preparedRoot: currentPreparedRoot, hostJobRoot: f.hostJobRoot, projectCwd: f.root, now });
    assert.deepEqual(new Set(current.filter((item) => item.eligible).map((item) => item.path)), new Set([currentPrepared, currentLog]));
    for (const item of current.filter((candidate) => candidate.eligible)) await deleteCleanupLeftover(f.registry, item, { roots: f.roots, preparedRoot: currentPreparedRoot, hostJobRoot: f.hostJobRoot, projectCwd: f.root, now });
    assert.equal(existsSync(currentPrepared), false); assert.equal(existsSync(currentLog), false);
    chmodSync(legacyRoot, 0o700);
    assert.deepEqual(readFileSync(legacySentinel), legacyBefore.bytes);
    const legacyAfterCurrent = statSync(legacySentinel); assert.equal(legacyAfterCurrent.ino, legacyBefore.stat.ino); assert.equal(legacyAfterCurrent.mtimeMs, legacyBefore.stat.mtimeMs);

    const currentProtected = makePrepared(currentPreparedRoot, `prepared_${"5".repeat(24)}`, "current must survive legacy cleanup");
    const currentSentinel = path.join(currentProtected, "sentinel");
    const currentBefore = { bytes: readFileSync(currentSentinel), stat: statSync(currentSentinel) };
    legacyRegistry = openWorkerRegistry(legacyRoot);
    const archived = await scanCleanupLeftovers(legacyRegistry, { roots: legacyRoots, preparedRoot: legacyPreparedRoot, hostJobRoot: legacyHostRoot, projectCwd: f.root, now });
    assert.deepEqual(new Set(archived.filter((item) => item.eligible).map((item) => item.path)), new Set([legacyPrepared, legacyLog]));
    for (const item of archived.filter((candidate) => candidate.eligible)) await deleteCleanupLeftover(legacyRegistry, item, { roots: legacyRoots, preparedRoot: legacyPreparedRoot, hostJobRoot: legacyHostRoot, projectCwd: f.root, now });
    assert.equal(existsSync(legacyPrepared), false); assert.equal(existsSync(legacyLog), false);
    assert.deepEqual(readFileSync(currentSentinel), currentBefore.bytes);
    const currentAfter = statSync(currentSentinel); assert.equal(currentAfter.ino, currentBefore.stat.ino); assert.equal(currentAfter.mtimeMs, currentBefore.stat.mtimeMs);
  } finally {
    try { chmodSync(legacyRoot, 0o700); } catch {}
    legacyRegistry?.close();
    f.close();
  }
});
