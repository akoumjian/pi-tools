import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { test } from "node:test";
import {
  adoptCleanupWorkers, advanceCleanupScanCursor, buildCleanupInventory, claimPreparedSetDiscard, classifyCleanupWorker, classifyPreparedCleanupIds, createCleanupSnapshot, loadCleanupSnapshot, loadCleanupScanCursor, consumeCleanupSnapshot, readCleanupBeadsFacts, deletePlannedWorkerHostLogs, planSettledWorkerHostLogs,
  deleteCleanupLeftover, preserveWorkerArtifacts, preflightWorkerDiscard, recoverPreparedSetDiscards, scanCleanupLeftovers, unpreservedArtifacts
} from "../extensions/worker/cleanup.js";
import { claimWorkerDiscard, createWorkerAndRun, finalizeWorkerDiscard, getWorker, openWorkerRegistry, storePreparedSet, type WorkerRegistry, type WorkerRegistryRecord, type WorkerRunRecord } from "../extensions/worker/registry.js";
import { workerPaths, type WorkerRoots } from "../extensions/worker/identity.js";

const WORKER_A = "worker_20261025100002_aaaaaaaa";
const WORKER_B = "worker_20261025100002_bbbbbbbb";
const RUN_A = "run_20261025100002_aaaaaaaa";

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-worker-cleanup-")));
  const runtimeRoot = path.join(root, "runtime"); const workersRoot = path.join(runtimeRoot, "workers"); const roots: WorkerRoots = { stateRoot: workersRoot, workspaceRoot: workersRoot };
  const registry = openWorkerRegistry(runtimeRoot); const parent = path.join(root, "parent.jsonl"); writeFileSync(parent, "");
  return { root, runtimeRoot, roots, registry, parent, close() { registry.close(); rmSync(root, { recursive: true, force: true }); } };
}

function insertSettled(registry: WorkerRegistry, roots: WorkerRoots, parent: string, input: { workerId?: string; runId?: string; role?: "work" | "review" | "integration"; artifacts?: string[]; recoveryError?: string; owner?: string; reviewedByWorkerId?: string; binding?:any; job?: { id: string; stdout: string; stderr: string } } = {}) {
  const workerId = input.workerId ?? WORKER_A; const runId = input.runId ?? RUN_A; const paths = workerPaths(roots, workerId);
  mkdirSync(paths.stateDir, { recursive: true }); mkdirSync(paths.workspaceRoot, { recursive: true });
  const now = "2026-10-25T10:00:02.000Z";
  const worker: Omit<WorkerRegistryRecord, "version"> = { workerId, parentSessionFile: input.owner ?? parent, role: input.role ?? "work", status: "idle", latestRunId: runId, taskIds: ["personal-test"], workspaceRoot: paths.workspaceRoot, ...(input.recoveryError ? { recoveryError: input.recoveryError } : {}), ...(input.reviewedByWorkerId ? { reviewedByWorkerId: input.reviewedByWorkerId } : {}), createdAt: now, updatedAt: now };
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
    const destination = path.join(f.root, "published", "evidence"); const result = await preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, nonce: "a".repeat(32) });
    assert.equal(result.items[0], artifact); assert.deepEqual(readFileSync(path.join(destination, artifact)), Buffer.from([0, 1, 2, 255]));
    assert.equal(JSON.parse(readFileSync(path.join(destination, "worker-preservation.json"), "utf8")).workerId, worker.workerId);
    assert.deepEqual(unpreservedArtifacts(f.registry, getWorker(f.registry, worker.workerId)!), []);
    assert.throws(() => preflightWorkerDiscard(f.registry, f.parent, { workerIds: [worker.workerId], artifactLossAcknowledged: [WORKER_B] }), /subset/);
  } finally { f.close(); }
});

test("preservation rejects symlinks, nested git, runtime destinations, and publishes nothing", async () => {
  const f = fixture(); try {
    const worker = insertSettled(f.registry, f.roots, f.parent, { artifacts: ["artifacts/tree"] }); const tree = path.join(worker.workspaceRoot, "artifacts", "tree"); mkdirSync(tree, { recursive: true }); symlinkSync(f.parent, path.join(tree, "escape"));
    const destination = path.join(f.root, "out"); await assert.rejects(() => preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, nonce: "b".repeat(32) }), /symlink/); assert.equal(existsSync(destination), false);
    rmSync(path.join(tree, "escape")); mkdirSync(path.join(tree, ".git")); await assert.rejects(() => preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, nonce: "c".repeat(32) }), /nested \.git/);
    await assert.rejects(() => preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination: path.join(f.runtimeRoot, "archive"), nonce: "d".repeat(32) }), /managed worker or sensitive storage/);
  } finally { f.close(); }
});

test("host-log cleanup requires exact metadata identity and never removes mismatches", () => {
  const f = fixture(); try {
    const jobId = "job_20261025100002_aaaaaaaa"; const directory = path.join(f.root, ".pi", "async-shell", "jobs", jobId); mkdirSync(directory, { recursive: true }); const stdout = path.join(directory, "stdout.log"); const stderr = path.join(directory, "stderr.log"); writeFileSync(stdout, "ok"); writeFileSync(stderr, "");
    const worker = insertSettled(f.registry, f.roots, f.parent, { job: { id: jobId, stdout, stderr } }); writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ jobId, command: `Pi worker host ${worker.workerId}/${RUN_A}`, status: "exited", stdoutLog: stdout, stderrLog: stderr }));
    const plan = planSettledWorkerHostLogs(f.registry, worker); assert.deepEqual(plan.deletable.map((item) => item.path), [directory]);writeFileSync(path.join(directory,"meta.json"),JSON.stringify({jobId,command:`Pi worker host ${worker.workerId}/${RUN_A}`,status:"running",stdoutLog:stdout,stderrLog:stderr}));assert.throws(()=>deletePlannedWorkerHostLogs(plan),/metadata changed/);assert.equal(existsSync(directory),true);writeFileSync(path.join(directory,"meta.json"),JSON.stringify({jobId,command:`Pi worker host ${worker.workerId}/${RUN_A}`,status:"exited",stdoutLog:stdout,stderrLog:stderr}));const clean=deletePlannedWorkerHostLogs(planSettledWorkerHostLogs(f.registry,worker));assert.deepEqual(clean,[directory]); assert.equal(existsSync(directory), false);
  } finally { f.close(); }
});

test("unknown host-log status requires a complete provably dead process identity", () => {
  const f = fixture(); try {
    const jobId = "job_20261025100002_cccccccc"; const directory = path.join(f.root, jobId); mkdirSync(directory); const stdout = path.join(directory, "stdout.log"); const stderr = path.join(directory, "stderr.log"); writeFileSync(stdout, ""); writeFileSync(stderr, ""); const worker = insertSettled(f.registry, f.roots, f.parent, { job: { id: jobId, stdout, stderr } });
    writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ jobId, command: `Pi worker host ${worker.workerId}/${RUN_A}`, status: "unknown", stdoutLog: stdout, stderrLog: stderr })); const clean = planSettledWorkerHostLogs(f.registry, worker); assert.equal(clean.deletable.length, 0); assert.match(clean.leftovers[0]!.reason, /process identity is incomplete/); assert.equal(existsSync(directory), true);
  } finally { f.close(); }
});

test("host-log mismatch is a reported leftover", () => {
  const f = fixture(); try {
    const jobId = "job_20261025100002_bbbbbbbb"; const directory = path.join(f.root, jobId); mkdirSync(directory); const stdout = path.join(directory, "stdout.log"); const stderr = path.join(directory, "stderr.log"); writeFileSync(stdout, ""); writeFileSync(stderr, ""); const worker = insertSettled(f.registry, f.roots, f.parent, { job: { id: jobId, stdout, stderr } });
    writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ jobId, command: "not the worker", status: "exited" })); const clean = planSettledWorkerHostLogs(f.registry, worker); assert.equal(clean.deletable.length, 0); assert.match(clean.leftovers[0]!.reason, /identity mismatch/); assert.equal(existsSync(directory), true);
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

test("all-session leftover scan identifies and revalidates aged orphan roots and historical worker logs", async () => {
  const f = fixture(); try {
    const old = new Date("2026-10-23T10:00:00.000Z"); const now = new Date("2026-10-25T10:00:02.000Z");
    const orphanId = "worker_20261023100002_cccccccc"; const orphan = path.join(f.roots.stateRoot, orphanId); mkdirSync(orphan, { recursive: true }); utimesSync(orphan, old, old);
    const preparedRoot = path.join(f.root, "prepared"); const preparedId = "prepared_cccccccccccccccccccccccc"; const prepared = path.join(preparedRoot, preparedId); mkdirSync(prepared, { recursive: true }); utimesSync(prepared, old, old);
    const jobId = "job_20261023100002_cccccccc"; const job = path.join(f.root, ".pi", "async-shell", "jobs", jobId); mkdirSync(job, { recursive: true }); const stdout = path.join(job, "stdout.log"); const stderr = path.join(job, "stderr.log"); writeFileSync(stdout, ""); writeFileSync(stderr, ""); writeFileSync(path.join(job, "meta.json"), JSON.stringify({ jobId, command: `Pi worker host ${orphanId}/run_20261023100002_cccccccc`, status: "exited", stdoutLog: stdout, stderrLog: stderr })); utimesSync(job, old, old);
    const leftovers = await scanCleanupLeftovers(f.registry, { roots: f.roots, preparedRoot, projectCwd: f.root, now }); assert.deepEqual(leftovers.map((item) => item.kind).sort(), ["prepared_root", "worker_host_log", "worker_root"]); assert.equal(leftovers.every((item) => item.eligible), true);
    for (const leftover of leftovers) await deleteCleanupLeftover(f.registry, leftover, { roots: f.roots, preparedRoot, projectCwd: f.root, now }); assert.equal(existsSync(orphan), false); assert.equal(existsSync(prepared), false); assert.equal(existsSync(job), false);
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
    await assert.rejects(() => preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, nonce: "9".repeat(32) }), /temporary path is inconsistent/); assert.equal(existsSync(inconsistent), true);
  } finally { f.close(); }
});

test("preservation retry removes only its recorded stale temporary path and recovers post-rename publication", async () => {
  const f = fixture(); try {
    const artifact = "artifacts/report.txt"; const worker = insertSettled(f.registry, f.roots, f.parent, { artifacts: [artifact] }); mkdirSync(path.join(worker.workspaceRoot, "artifacts"), { recursive: true }); writeFileSync(path.join(worker.workspaceRoot, artifact), "evidence");
    const destination = path.join(f.root, "archive"); const stale = path.join(f.root, `.archive.worker-preserve-${"1".repeat(24)}`); mkdirSync(stale); writeFileSync(path.join(stale, "partial"), "x");
    f.registry.database.prepare(`INSERT INTO preservation_records(preservation_id,worker_id,status,destination,temp_path,latest_run_id,items_json,created_at,updated_at) VALUES(?,?,'pending',?,?,?,?,?,?)`).run("preservation_stale", worker.workerId, destination, stale, worker.latestRunId!, JSON.stringify([artifact]), "2026-10-25T10:00:00.000Z", "2026-10-25T10:00:00.000Z");
    const first = await preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, nonce: "e".repeat(32) }); assert.equal(existsSync(stale), false); assert.equal((f.registry.database.prepare("SELECT status FROM preservation_records WHERE preservation_id='preservation_stale'").get() as any).status, "failed");
    f.registry.database.prepare("UPDATE preservation_records SET status='pending' WHERE preservation_id=?").run(first.preservationId);
    const recovered = await preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, nonce: "f".repeat(32) }); assert.equal(recovered.preservationId, first.preservationId); assert.equal((f.registry.database.prepare("SELECT status FROM preservation_records WHERE preservation_id=?").get(first.preservationId) as any).status, "published");
  } finally { f.close(); }
});

test("preservation rejects an intermediate worker-planted symlink before reading host bytes",async()=>{
 const f=fixture();try{const host=path.join(f.root,"host");mkdirSync(host);writeFileSync(path.join(host,"secret"),"TOP-SECRET");const worker=insertSettled(f.registry,f.roots,f.parent,{artifacts:["artifacts/secret"]});symlinkSync(host,path.join(worker.workspaceRoot,"artifacts"));const destination=path.join(f.root,"published","evidence");await assert.rejects(()=>preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination,nonce:"7".repeat(32)}),/symlink ancestor/);assert.equal(existsSync(destination),false);}finally{f.close();}
});

test("preservation lock refuses a live publisher and recovers an exact dead owner",async()=>{
 const f=fixture();try{const artifact="artifacts/report.txt";const worker=insertSettled(f.registry,f.roots,f.parent,{artifacts:[artifact]});mkdirSync(path.join(worker.workspaceRoot,"artifacts"));writeFileSync(path.join(worker.workspaceRoot,artifact),"evidence");const destination=path.join(f.root,"published","evidence");mkdirSync(path.dirname(destination),{recursive:true});const lock=path.join(path.dirname(destination),`.${path.basename(destination)}.worker-preserve.lock`);const {asyncJobProcessStartToken}=await import("../extensions/_shared/async-job-process.js");writeFileSync(lock,JSON.stringify({version:1,pid:process.pid,processStartToken:asyncJobProcessStartToken(process.pid),preservationId:"live",destination}));await assert.rejects(()=>preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination,nonce:"6".repeat(32)}),/live or ambiguous/);unlinkSync(lock);writeFileSync(lock,JSON.stringify({version:1,pid:2147483647,processStartToken:"dead:owner",preservationId:"dead",destination}));const result=await preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination,nonce:"5".repeat(32)});assert.equal(result.destination,destination);assert.equal(existsSync(lock),false);}finally{f.close();}
});

test("canonical forbidden roots hold when TMPDIR and runtime paths use a symlink alias",async()=>{
 const base=mkdtempSync(path.join(tmpdir(),"pi-cleanup-real-"));const alias=`${base}-alias`;symlinkSync(base,alias);const previous=process.env.TMPDIR;process.env.TMPDIR=alias;let f:ReturnType<typeof fixture>|undefined;try{f=fixture();const artifact="artifacts/report.txt";const worker=insertSettled(f.registry,f.roots,f.parent,{artifacts:[artifact]});mkdirSync(path.join(worker.workspaceRoot,"artifacts"));writeFileSync(path.join(worker.workspaceRoot,artifact),"evidence");const canonicalRuntime=path.resolve(base,path.relative(alias,f.runtimeRoot));await assert.rejects(()=>preserveWorkerArtifacts(f!.registry,f!.roots,f!.runtimeRoot,{workerId:worker.workerId,destination:path.join(canonicalRuntime,"archive"),nonce:"4".repeat(32)}),/managed worker or sensitive storage/);}finally{f?.close();if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;unlinkSync(alias);rmSync(base,{recursive:true,force:true});}
});


test("preservation universally case-folds sensitive aliases and accepts a symlinked nearest destination ancestor",async()=>{
 const f=fixture();try{const artifact="artifacts/report.txt",worker=insertSettled(f.registry,f.roots,f.parent,{artifacts:[artifact]});mkdirSync(path.join(worker.workspaceRoot,"artifacts"));writeFileSync(path.join(worker.workspaceRoot,artifact),"evidence");const upperRuntime=path.join(f.runtimeRoot.toUpperCase(),"archive");await assert.rejects(()=>preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination:upperRuntime,nonce:"a".repeat(32)}),/managed worker or sensitive storage/);const upperPi=path.join(homedir().toUpperCase(),".PI","agent","extensions","worker-copy");await assert.rejects(()=>preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination:upperPi,nonce:"b".repeat(32)}),/managed worker or sensitive storage/);const realParent=path.join(f.root,"real-destination");mkdirSync(realParent);const alias=path.join(f.root,"destination-alias");symlinkSync(realParent,alias);const result=await preserveWorkerArtifacts(f.registry,f.roots,f.runtimeRoot,{workerId:worker.workerId,destination:path.join(alias,"published"),nonce:"c".repeat(32)});assert.equal(result.destination,path.join(realParent,"published"));assert.equal(readFileSync(path.join(realParent,"published",artifact),"utf8"),"evidence");}finally{f.close();}
});

test("reviewer and subject are co-adopted atomically while only the reviewer receives the first discard claim",async()=>{
 const f=fixture();try{const owner=path.join(f.root,"old.jsonl");const reviewerId=WORKER_B;insertSettled(f.registry,f.roots,f.parent,{workerId:reviewerId,runId:"run_20261025100002_bbbbbbbb",role:"review",owner,binding:{reviewedWorkerId:WORKER_A,reviewedRunId:RUN_A}});insertSettled(f.registry,f.roots,f.parent,{workerId:WORKER_A,owner,reviewedByWorkerId:reviewerId});const bd=path.join(f.root,"bd-pair");writeFileSync(bd,"#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='where')console.log(JSON.stringify({prefix:'personal',path:'/central',database_path:'/central/.beads/embeddeddolt'}));else console.log(JSON.stringify(a.filter(x=>x.startsWith('personal-')).map(id=>({id,status:'closed'}))));\n");chmodSync(bd,0o700);const preview=await createCleanupSnapshot(f.registry,{parentSessionFile:f.parent,workerIds:[reviewerId],cwd:f.root,roots:f.roots,preparedRoot:path.join(f.root,"prepared"),bdPath:bd,ownerAuthority:()=>({state:"missing"})});assert.deepEqual(preview.snapshot.workers.map((item)=>item.item.workerId).sort(),[WORKER_A,reviewerId].sort());const nonce="pair-claim";adoptCleanupWorkers(f.registry,{snapshots:preview.snapshot.workers,newParentSessionFile:f.parent,claimWorkerIds:[reviewerId],nonce,now:"2026-10-25T10:03:00.000Z",pendingAcknowledged:new Set(),claimedAcknowledged:new Set(),ownerAuthority:()=>({state:"missing"})});let reviewer=getWorker(f.registry,reviewerId)!,subject=getWorker(f.registry,WORKER_A)!;assert.equal(reviewer.operationKind,"discard");assert.equal(subject.operationKind,undefined);assert.equal(subject.reviewedByWorkerId,reviewerId);finalizeWorkerDiscard(f.registry,reviewerId,nonce);subject=getWorker(f.registry,WORKER_A)!;assert.equal(subject.reviewedByWorkerId,undefined);assert.equal(subject.version,preview.snapshot.workers.find((item)=>item.item.workerId===WORKER_A)!.item.version+2,"reviewer-first handoff has an exact version trajectory");const fresh="subject-claim";claimWorkerDiscard(f.registry,subject.workerId,subject.version,fresh,"2026-10-25T10:04:00.000Z");assert.equal(getWorker(f.registry,WORKER_A)!.operationNonce,fresh);
 }finally{f.close();}
});

test("owner liveness changing after preview blocks adoption atomically",async()=>{
 const f=fixture();try{const owner=path.join(f.root,"old.jsonl");insertSettled(f.registry,f.roots,f.parent,{owner});const bd=path.join(f.root,"bd-owner");writeFileSync(bd,"#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='where')console.log(JSON.stringify({prefix:'personal',path:'/central',database_path:'/central/.beads/embeddeddolt'}));else console.log(JSON.stringify(a.filter(x=>x.startsWith('personal-')).map(id=>({id,status:'closed'}))));\n");chmodSync(bd,0o700);const preview=await createCleanupSnapshot(f.registry,{parentSessionFile:f.parent,workerIds:[WORKER_A],cwd:f.root,roots:f.roots,preparedRoot:path.join(f.root,"prepared"),bdPath:bd,ownerAuthority:()=>({state:"missing"})});assert.throws(()=>adoptCleanupWorkers(f.registry,{snapshots:preview.snapshot.workers,newParentSessionFile:f.parent,claimWorkerIds:[WORKER_A],nonce:"n",now:"now",pendingAcknowledged:new Set(),claimedAcknowledged:new Set(),ownerAuthority:()=>({state:"live",generation:2,members:[]})}),/authority.*changed/);assert.equal(getWorker(f.registry,WORKER_A)!.parentSessionFile,path.resolve(owner));}finally{f.close();}
});

test("leftover inventory pages more than 32 historical host logs without whole-snapshot refusal",async()=>{
 const f=fixture();try{const old=new Date("2026-10-23T10:00:00.000Z"),now=new Date("2026-10-25T10:00:02.000Z");for(let index=0;index<40;index+=1){const suffix=index.toString(16).padStart(8,"0"),workerId=`worker_20261023100002_${suffix}`,runId=`run_20261023100002_${suffix}`,jobId=`job_20261023100002_${suffix}`,directory=path.join(f.root,".pi","async-shell","jobs",jobId);mkdirSync(directory,{recursive:true});const stdout=path.join(directory,"stdout.log"),stderr=path.join(directory,"stderr.log");writeFileSync(stdout,"");writeFileSync(stderr,"");writeFileSync(path.join(directory,"meta.json"),JSON.stringify({jobId,command:`Pi worker host ${workerId}/${runId}`,status:"exited",stdoutLog:stdout,stderrLog:stderr}));utimesSync(directory,old,old);}const first=await buildCleanupInventory(f.registry,{parentSessionFile:f.parent,allSessions:true,cwd:f.root,roots:f.roots,preparedRoot:path.join(f.root,"prepared"),limit:32,offset:0,now});assert.equal(first.leftovers.length,32);assert.equal(first.total.leftovers,32);assert.equal(first.scan.partial,true);assert.ok(first.scan.continuation);const cursor=advanceCleanupScanCursor(f.registry,f.parent,undefined,first.scan.continuation,now.toISOString())!;const scanState=loadCleanupScanCursor(f.registry,f.parent,cursor);const second=await buildCleanupInventory(f.registry,{parentSessionFile:f.parent,allSessions:true,cwd:f.root,roots:f.roots,preparedRoot:path.join(f.root,"prepared"),limit:32,offset:0,scanState,now});assert.equal(second.total.leftovers,40);assert.equal(second.leftovers.length,8);assert.equal(second.scan.partial,false);assert.equal(advanceCleanupScanCursor(f.registry,f.parent,cursor,second.scan.continuation,now.toISOString()),undefined);assert.throws(()=>loadCleanupScanCursor(f.registry,f.parent,cursor),/consumed/);assert.equal(new Set([...first.leftovers,...second.leftovers].map((item)=>item.leftoverId)).size,40);}finally{f.close();}
});

test("interrupted cleanup trash is inventoried and explicitly recoverable",async()=>{
 const f=fixture();try{const original="worker_20261023100002_deadbeef",sourcePath=path.join(f.roots.stateRoot,original),trash=`${sourcePath}.cleanup-${"a".repeat(24)}`;mkdirSync(trash,{recursive:true});writeFileSync(path.join(trash,"evidence"),"x");const info=lstatSync(trash),markerPath=path.join(trash,".pi-tools-cleanup-trash.json"),marker={version:1,nonce:"a".repeat(24),trashPath:path.resolve(trash),sourcePath:path.resolve(sourcePath),sourceKind:"worker_root",device:Number(info.dev),inode:Number(info.ino),entryName:original,originalId:original,sourceLeftoverId:`leftover_${"b".repeat(24)}`};writeFileSync(markerPath,JSON.stringify(marker));let leftovers=await scanCleanupLeftovers(f.registry,{roots:f.roots,preparedRoot:path.join(f.root,"prepared"),projectCwd:f.root});assert.equal(leftovers.find((candidate)=>candidate.path===trash)!.eligible,false,"a marker with fabricated source evidence must remain ineligible");const sourceLeftoverId=`leftover_${createHash("sha256").update(`worker_root\0${original}\0${sourcePath}\0${Number(info.dev)}\0${Number(info.ino)}`).digest("hex").slice(0,24)}`;writeFileSync(markerPath,JSON.stringify({...marker,sourceLeftoverId}));leftovers=await scanCleanupLeftovers(f.registry,{roots:f.roots,preparedRoot:path.join(f.root,"prepared"),projectCwd:f.root});const item=leftovers.find((candidate)=>candidate.path===trash)!;assert.equal(item.kind,"cleanup_trash");assert.equal(item.eligible,true);await deleteCleanupLeftover(f.registry,item,{roots:f.roots,preparedRoot:path.join(f.root,"prepared"),projectCwd:f.root});assert.equal(existsSync(trash),false);}finally{f.close();}
});

test("prepared partial state stays non-announceable when Beads is unavailable",()=>{
 const f=fixture();try{const preparedId=`prepared_${"e".repeat(24)}`;storePreparedSet(f.registry,{preparedId,parentSessionFile:f.parent,status:"partial",order:[],taskIds:["personal-test"],repositories:[{id:"repo",taskIds:["personal-test"]}],createdAt:"2026-10-25T10:00:02.000Z"});const [item]=classifyPreparedCleanupIds(f.registry,[preparedId],new Map([["personal-test","unavailable"]]));assert.equal(item!.class,"retained");assert.match(item!.reason,/unavailable/);}finally{f.close();}
});

test("unmarked cleanup-shaped trash is visible but never eligible",async()=>{
 const f=fixture();try{const trash=path.join(f.roots.stateRoot,`worker_20261023100002_unmarked.cleanup-${"c".repeat(24)}`);mkdirSync(trash,{recursive:true});const leftovers=await scanCleanupLeftovers(f.registry,{roots:f.roots,preparedRoot:path.join(f.root,"prepared"),projectCwd:f.root});const item=leftovers.find((candidate)=>candidate.path===trash)!;assert.equal(item.kind,"cleanup_trash");assert.equal(item.eligible,false);assert.match(item.reason,/lacks exact marker/);}finally{f.close();}
});
