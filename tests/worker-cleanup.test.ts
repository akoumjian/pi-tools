import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { test } from "node:test";
import {
  adoptWorkers, claimPreparedSetDiscard, classifyCleanupWorker, readCleanupBeadsFacts, deleteSettledWorkerHostLogs, finishPreparedSetDiscard,
  deleteCleanupLeftover, preserveWorkerArtifacts, preflightWorkerDiscard, recoverPreparedSetDiscards, scanCleanupLeftovers, unpreservedArtifacts, validateCleanupConfirmation,
  type CleanupPreview
} from "../extensions/worker/cleanup.js";
import { createWorkerAndRun, getWorker, openWorkerRegistry, storePreparedSet, type WorkerRegistry, type WorkerRegistryRecord, type WorkerRunRecord } from "../extensions/worker/registry.js";
import { workerPaths, type WorkerRoots } from "../extensions/worker/identity.js";

const WORKER_A = "worker_20261025100002_aaaaaaaa";
const WORKER_B = "worker_20261025100002_bbbbbbbb";
const RUN_A = "run_20261025100002_aaaaaaaa";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-worker-cleanup-"));
  const runtimeRoot = path.join(root, "runtime"); const workersRoot = path.join(runtimeRoot, "workers"); const roots: WorkerRoots = { stateRoot: workersRoot, workspaceRoot: workersRoot };
  const registry = openWorkerRegistry(runtimeRoot); const parent = path.join(root, "parent.jsonl"); writeFileSync(parent, "");
  return { root, runtimeRoot, roots, registry, parent, close() { registry.close(); rmSync(root, { recursive: true, force: true }); } };
}

function insertSettled(registry: WorkerRegistry, roots: WorkerRoots, parent: string, input: { workerId?: string; runId?: string; role?: "work" | "review" | "integration"; artifacts?: string[]; recoveryError?: string; owner?: string; reviewedByWorkerId?: string; job?: { id: string; stdout: string; stderr: string } } = {}) {
  const workerId = input.workerId ?? WORKER_A; const runId = input.runId ?? RUN_A; const paths = workerPaths(roots, workerId);
  mkdirSync(paths.stateDir, { recursive: true }); mkdirSync(paths.workspaceRoot, { recursive: true });
  const now = "2026-10-25T10:00:02.000Z";
  const worker: Omit<WorkerRegistryRecord, "version"> = { workerId, parentSessionFile: input.owner ?? parent, role: input.role ?? "work", status: "idle", latestRunId: runId, taskIds: ["personal-test"], workspaceRoot: paths.workspaceRoot, ...(input.recoveryError ? { recoveryError: input.recoveryError } : {}), ...(input.reviewedByWorkerId ? { reviewedByWorkerId: input.reviewedByWorkerId } : {}), createdAt: now, updatedAt: now };
  const run: WorkerRunRecord = { workerId, runId, status: "settled", taskIds: ["personal-test"], completionDelivery: "steer", ...(input.job ? { jobId: input.job.id, stdoutLog: input.job.stdout, stderrLog: input.job.stderr } : {}), outcome: "completed", outcomeSource: "worker", summary: "done", repositories: [], artifacts: input.artifacts ?? [], errors: [], createdAt: now, settledAt: now };
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
    const destination = path.join(f.root, "out"); await assert.rejects(() => preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, nonce: "b".repeat(32) }), /symlinks and special/); assert.equal(existsSync(destination), false);
    rmSync(path.join(tree, "escape")); mkdirSync(path.join(tree, ".git")); await assert.rejects(() => preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination, nonce: "c".repeat(32) }), /nested \.git/);
    await assert.rejects(() => preserveWorkerArtifacts(f.registry, f.roots, f.runtimeRoot, { workerId: worker.workerId, destination: path.join(f.runtimeRoot, "archive"), nonce: "d".repeat(32) }), /managed worker or sensitive storage/);
  } finally { f.close(); }
});

test("host-log cleanup requires exact metadata identity and never removes mismatches", () => {
  const f = fixture(); try {
    const jobId = "job_20261025100002_aaaaaaaa"; const directory = path.join(f.root, ".pi", "async-shell", "jobs", jobId); mkdirSync(directory, { recursive: true }); const stdout = path.join(directory, "stdout.log"); const stderr = path.join(directory, "stderr.log"); writeFileSync(stdout, "ok"); writeFileSync(stderr, "");
    const worker = insertSettled(f.registry, f.roots, f.parent, { job: { id: jobId, stdout, stderr } }); writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ jobId, command: `Pi worker host ${worker.workerId}/${RUN_A}`, status: "exited", stdoutLog: stdout, stderrLog: stderr }));
    const clean = deleteSettledWorkerHostLogs(f.registry, worker); assert.deepEqual(clean.deleted, [directory]); assert.equal(existsSync(directory), false);
  } finally { f.close(); }
});

test("unknown host-log status requires a complete provably dead process identity", () => {
  const f = fixture(); try {
    const jobId = "job_20261025100002_cccccccc"; const directory = path.join(f.root, jobId); mkdirSync(directory); const stdout = path.join(directory, "stdout.log"); const stderr = path.join(directory, "stderr.log"); writeFileSync(stdout, ""); writeFileSync(stderr, ""); const worker = insertSettled(f.registry, f.roots, f.parent, { job: { id: jobId, stdout, stderr } });
    writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ jobId, command: `Pi worker host ${worker.workerId}/${RUN_A}`, status: "unknown", stdoutLog: stdout, stderrLog: stderr })); const clean = deleteSettledWorkerHostLogs(f.registry, worker); assert.equal(clean.deleted.length, 0); assert.match(clean.leftovers[0]!.reason, /process identity is incomplete/); assert.equal(existsSync(directory), true);
  } finally { f.close(); }
});

test("host-log mismatch is a reported leftover", () => {
  const f = fixture(); try {
    const jobId = "job_20261025100002_bbbbbbbb"; const directory = path.join(f.root, jobId); mkdirSync(directory); const stdout = path.join(directory, "stdout.log"); const stderr = path.join(directory, "stderr.log"); writeFileSync(stdout, ""); writeFileSync(stderr, ""); const worker = insertSettled(f.registry, f.roots, f.parent, { job: { id: jobId, stdout, stderr } });
    writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ jobId, command: "not the worker", status: "exited" })); const clean = deleteSettledWorkerHostLogs(f.registry, worker); assert.equal(clean.deleted.length, 0); assert.match(clean.leftovers[0]!.reason, /identity mismatch/); assert.equal(existsSync(directory), true);
  } finally { f.close(); }
});

test("prepared discard is claim-first, idempotently recoverable, and refuses apply claims", () => {
  const f = fixture(); try {
    const preparedRoot = path.join(f.root, "prepared"); const preparedId = "prepared_aaaaaaaaaaaaaaaaaaaaaaaa"; mkdirSync(path.join(preparedRoot, preparedId), { recursive: true }); storePreparedSet(f.registry, { preparedId, parentSessionFile: f.parent, status: "ready", order: ["repo"], taskIds: ["personal-test"], repositories: [{ id: "repo" }], createdAt: "2026-10-25T10:00:02.000Z" });
    assert.equal(claimPreparedSetDiscard(f.registry, f.parent, preparedId, "2026-10-25T10:01:00.000Z").partial, false); assert.deepEqual(recoverPreparedSetDiscards(f.registry, preparedRoot), [preparedId]); assert.equal(existsSync(path.join(preparedRoot, preparedId)), false);
    const claimed = "prepared_bbbbbbbbbbbbbbbbbbbbbbbb"; storePreparedSet(f.registry, { preparedId: claimed, parentSessionFile: f.parent, status: "ready", order: [], repositories: [], createdAt: "2026-10-25T10:00:02.000Z" }); f.registry.database.prepare("UPDATE prepared_sets SET apply_nonce='held' WHERE prepared_id=?").run(claimed); assert.throws(() => claimPreparedSetDiscard(f.registry, f.parent, claimed, "now"), /cannot be discarded/);
  } finally { f.close(); }
});

test("cross-session adoption acknowledges pending results atomically and marks adopted workers non-resumable", () => {
  const f = fixture(); try {
    const owner = path.join(f.root, "old.jsonl"); writeFileSync(owner, ""); insertSettled(f.registry, f.roots, f.parent, { owner });
    f.registry.database.prepare("INSERT INTO deliveries(delivery_id,parent_session_file,worker_id,run_id,completion_delivery,state,created_at) VALUES(?,?,?,?,?,'pending',?)").run("delivery-a", owner, WORKER_A, RUN_A, "steer", "2026-10-25T10:00:02.000Z");
    adoptWorkers(f.registry, { workerIds: [WORKER_A], expectedOwners: { [WORKER_A]: owner }, newParentSessionFile: f.parent, acknowledgePending: true, now: "2026-10-25T10:02:00.000Z" }); const adopted = getWorker(f.registry, WORKER_A)!;
    assert.equal(adopted.parentSessionFile, path.resolve(f.parent)); assert.equal(adopted.runtime?.adoptedFromSession, path.resolve(owner)); assert.equal((f.registry.database.prepare("SELECT state FROM deliveries WHERE delivery_id='delivery-a'").get() as any).state, "delivered");
  } finally { f.close(); }
});

test("claimed delivery makes adoption fail closed without partial ownership changes", () => {
  const f = fixture(); try {
    const owner = path.join(f.root, "old.jsonl"); writeFileSync(owner, ""); insertSettled(f.registry, f.roots, f.parent, { owner }); f.registry.database.prepare("INSERT INTO deliveries(delivery_id,parent_session_file,worker_id,run_id,completion_delivery,state,runtime_generation,created_at) VALUES(?,?,?,?,?,'claimed',1,?)").run("delivery-b", owner, WORKER_A, RUN_A, "steer", "2026-10-25T10:00:02.000Z");
    assert.throws(() => adoptWorkers(f.registry, { workerIds: [WORKER_A], expectedOwners: { [WORKER_A]: owner }, newParentSessionFile: f.parent, acknowledgePending: true, now: "now" }), /stranded delivery claim/); assert.equal(getWorker(f.registry, WORKER_A)!.parentSessionFile, path.resolve(owner));
  } finally { f.close(); }
});

test("preview validation is exact and rejects changed tokens", () => {
  const preview = { version: 1, allSessions: false, workers: [], prepared: [], leftovers: [], scan: { partial: false, examinedWorkers: 0, totalWorkers: 0, examinedFilesystemEntries: 0 }, generatedAt: "2026-10-25T10:00:02.000Z", token: "abc" } satisfies CleanupPreview;
  assert.doesNotThrow(() => validateCleanupConfirmation(preview, "abc")); assert.throws(() => validateCleanupConfirmation(preview, "def"), /does not match/);
});


test("all-session leftover scan identifies and revalidates aged orphan roots and historical worker logs", () => {
  const f = fixture(); try {
    const old = new Date("2026-10-23T10:00:00.000Z"); const now = new Date("2026-10-25T10:00:02.000Z");
    const orphanId = "worker_20261023100002_cccccccc"; const orphan = path.join(f.roots.stateRoot, orphanId); mkdirSync(orphan, { recursive: true }); utimesSync(orphan, old, old);
    const preparedRoot = path.join(f.root, "prepared"); const preparedId = "prepared_cccccccccccccccccccccccc"; const prepared = path.join(preparedRoot, preparedId); mkdirSync(prepared, { recursive: true }); utimesSync(prepared, old, old);
    const jobId = "job_20261023100002_cccccccc"; const job = path.join(f.root, ".pi", "async-shell", "jobs", jobId); mkdirSync(job, { recursive: true }); const stdout = path.join(job, "stdout.log"); const stderr = path.join(job, "stderr.log"); writeFileSync(stdout, ""); writeFileSync(stderr, ""); writeFileSync(path.join(job, "meta.json"), JSON.stringify({ jobId, command: `Pi worker host ${orphanId}/run_20261023100002_cccccccc`, status: "exited", stdoutLog: stdout, stderrLog: stderr })); utimesSync(job, old, old);
    const leftovers = scanCleanupLeftovers(f.registry, { roots: f.roots, preparedRoot, projectCwd: f.root, now }); assert.deepEqual(leftovers.map((item) => item.kind).sort(), ["prepared_root", "worker_host_log", "worker_root"]); assert.equal(leftovers.every((item) => item.eligible), true);
    for (const leftover of leftovers) deleteCleanupLeftover(f.registry, leftover, { roots: f.roots, preparedRoot, projectCwd: f.root, now }); assert.equal(existsSync(orphan), false); assert.equal(existsSync(prepared), false); assert.equal(existsSync(job), false);
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
