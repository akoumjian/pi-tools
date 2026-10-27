import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  claimPreparedSetApply,
  claimWorkerCancellation,
  claimWorkerDelivery,
  claimWorkerRun,
  claimWorkerTerminalIntent,
  createWorkerAndRun,
  createWorkerRunBatch,
  discardWorkerRegistryRecord,
  finalizeClaimedWorkerRun,
  finishPreparedSetApply,
  getWorker,
  getWorkerRun,
  leaseWorkerForReview,
  listWorkerRuns,
  listWorkers,
  markWorkerDeliveryDelivered,
  markWorkerDeliverySendStarted,
  markWorkerCleanupRecovery,
  markWorkerRunRunning,
  openWorkerRegistry,
  pendingWorkerDeliveries,
  promoteParentRuntime,
  reconcileWorkerDeliveries,
  recoverInterruptedClaimsForParent,
  recoverInterruptedPreparedSetAppliesForParent,
  registerParentRuntime,
  registerParentRuntimeAndRecoverClaims,
  releaseWorkerRunClaim,
  setClaimedWorkerTerminalIntent,
  releaseWorkerReviewLease,
  releaseWorkerDeliveryClaim,
  settleWorkerRun,
  storePreparedSet,
  workerRegistryDataVersion,
  type WorkerRunRecord
} from "../extensions/worker/registry.js";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-worker-registry-"));
  const registry = openWorkerRegistry(root);
  return { root, registry, close: () => { registry.close(); rmSync(root, { recursive: true, force: true }); } };
}

function queuedRun(workerId: string, runId: string): WorkerRunRecord {
  return {
    workerId, runId, status: "queued", taskIds: ["personal-test"], completionDelivery: "steer",
    repositories: [], artifacts: [], errors: [], createdAt: "2026-01-01T00:00:00.000Z"
  };
}

test("registry creates workers, versions runs, and paginates exact parent records", () => {
  const f = fixture();
  try {
    createWorkerAndRun(f.registry, {
      workerId: "worker_20260101000000_aaaaaaaa", parentSessionFile: "/sessions/parent.jsonl", role: "work", status: "queued",
      activeRunId: "run_20260101000000_aaaaaaaa", taskIds: ["personal-test"], workspaceRoot: "/workspace/a",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    }, queuedRun("worker_20260101000000_aaaaaaaa", "run_20260101000000_aaaaaaaa"));
    const listed = listWorkers(f.registry, { parentSessionFile: "/sessions/parent.jsonl" });
    assert.equal(listed.total, 1);
    assert.equal(listed.workers[0]?.status, "queued");
    assert.equal(listWorkerRuns(f.registry, listed.workers[0]!.workerId).total, 1);
    assert.equal(getWorkerRun(f.registry, listed.workers[0]!.workerId, "run_20260101000000_aaaaaaaa")?.status, "queued");
  } finally { f.close(); }
});

test("settlement and delivery claims are transactional and generation bound", () => {
  const f = fixture();
  try {
    const workerId = "worker_20260101000000_bbbbbbbb";
    const runId = "run_20260101000000_bbbbbbbb";
    createWorkerAndRun(f.registry, {
      workerId, parentSessionFile: "/sessions/parent.jsonl", role: "review", status: "queued", activeRunId: runId,
      taskIds: ["personal-test"], workspaceRoot: "/workspace/b", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    }, { ...queuedRun(workerId, runId), binding: { reviewedWorkerId: "worker_20260101000000_aaaaaaaa", reviewedRunId: "run_20260101000000_aaaaaaaa" } });
    markWorkerRunRunning(f.registry, workerId, runId, {
      modelSelection: "anthropic/claude-opus-5-5:xhigh", jobId: "job_test", stdoutLog: "/logs/out", stderrLog: "/logs/err", startedAt: "2026-01-01T00:00:01.000Z"
    });
    const deliveryId = settleWorkerRun(f.registry, {
      parentSessionFile: "/sessions/parent.jsonl", workerId, runId, outcome: "approve", outcomeSource: "worker",
      summary: "Approved.", artifacts: ["reports/review.md"], settledAt: "2026-01-01T00:00:02.000Z"
    });
    assert.equal(getWorker(f.registry, workerId)?.status, "idle");
    assert.equal(getWorkerRun(f.registry, workerId, runId)?.outcome, "approve");
    assert.equal(pendingWorkerDeliveries(f.registry, "/sessions/parent.jsonl").length, 1);
    const generation1 = registerParentRuntime(f.registry, "/sessions/parent.jsonl", "runtime-a", "2026-01-01T00:00:03.000Z");
    const generation2 = registerParentRuntime(f.registry, "/sessions/parent.jsonl", "runtime-b", "2026-01-01T00:00:04.000Z");
    assert.equal(claimWorkerDelivery(f.registry, deliveryId, "/sessions/parent.jsonl", generation1), false);
    assert.equal(claimWorkerDelivery(f.registry, deliveryId, "/sessions/parent.jsonl", generation2), true);
    releaseWorkerDeliveryClaim(f.registry, deliveryId, generation2);
    assert.equal(claimWorkerDelivery(f.registry, deliveryId, "/sessions/parent.jsonl", generation2), true);
    assert.equal(markWorkerDeliveryDelivered(f.registry, deliveryId, generation2, "2026-01-01T00:00:05.000Z"), true);
    assert.equal(pendingWorkerDeliveries(f.registry, "/sessions/parent.jsonl").length, 0);
  } finally { f.close(); }
});

test("direct connections observe data versions and stale discard fails closed", () => {
  const f = fixture();
  const second = openWorkerRegistry(f.root);
  try {
    const before = workerRegistryDataVersion(second);
    const workerId = "worker_20260101000000_cccccccc";
    const runId = "run_20260101000000_cccccccc";
    createWorkerAndRun(f.registry, {
      workerId, parentSessionFile: "/sessions/parent.jsonl", role: "work", status: "queued", activeRunId: runId,
      taskIds: ["personal-test"], workspaceRoot: "/workspace/c", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    }, queuedRun(workerId, runId));
    assert.notEqual(workerRegistryDataVersion(second), before);
    settleWorkerRun(f.registry, { parentSessionFile: "/sessions/parent.jsonl", workerId, runId, outcome: "cancelled", outcomeSource: "system", settledAt: "2026-01-01T00:00:01.000Z" });
    assert.throws(() => discardWorkerRegistryRecord(f.registry, workerId, 0), /changed state/);
    const version = getWorker(f.registry, workerId)!.version;
    discardWorkerRegistryRecord(f.registry, workerId, version);
    assert.equal(getWorker(f.registry, workerId), undefined);
  } finally { second.close(); f.close(); }
});


test("registry stores prepared set metadata and status transitions", () => {
  const f = fixture();
  try {
    const preparedId = `prepared_${"d".repeat(24)}`; const parent = "/sessions/parent.jsonl";
    storePreparedSet(f.registry, { preparedId, parentSessionFile: parent, status: "ready", order: ["repo"], repositories: [{ id: "repo", desiredCommit: "a".repeat(40) }], createdAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(claimPreparedSetApply(f.registry, preparedId, parent, "1-apply", "2026-01-01T00:00:01.000Z"), true); assert.equal(claimPreparedSetApply(f.registry, preparedId, parent, "1-other", "2026-01-01T00:00:01.000Z"), false);
    recoverInterruptedClaimsForParent(f.registry, parent, 1, "2026-01-01T00:00:02.000Z"); assert.equal(claimPreparedSetApply(f.registry, preparedId, parent, "1-other", "2026-01-01T00:00:02.000Z"), false);
    recoverInterruptedClaimsForParent(f.registry, parent, 2, "2026-01-01T00:00:03.000Z"); assert.equal(claimPreparedSetApply(f.registry, preparedId, parent, "2-apply", "2026-01-01T00:00:03.000Z"), false,"generic lifecycle recovery preserves prepared authority");assert.deepEqual(recoverInterruptedPreparedSetAppliesForParent(f.registry,parent,2,"2026-01-01T00:00:03.500Z",()=>false),[]);assert.equal(claimPreparedSetApply(f.registry,preparedId,parent,"2-apply","2026-01-01T00:00:03.500Z"),false,"live apply owner remains fenced");assert.deepEqual(recoverInterruptedPreparedSetAppliesForParent(f.registry,parent,2,"2026-01-01T00:00:03.750Z",()=>true),[preparedId]);assert.equal(claimPreparedSetApply(f.registry, preparedId, parent, "2-apply", "2026-01-01T00:00:03.800Z"), true);
    finishPreparedSetApply(f.registry, preparedId, parent, "2-apply", "completed", "2026-01-01T00:00:04.000Z");
    const row = f.registry.database.prepare("SELECT status,apply_nonce FROM prepared_sets WHERE prepared_id=?").get(preparedId) as { status: string; apply_nonce: string | null }; assert.equal(row.status, "completed"); assert.equal(row.apply_nonce, null);
  } finally { f.close(); }
});


test("review leases block subject reuse until exact reviewer release", () => {
  const f = fixture();
  try {
    const workerId = "worker_20260101000000_dddddddd"; const runId = "run_20260101000000_dddddddd";
    createWorkerAndRun(f.registry, { workerId, parentSessionFile: "/sessions/parent.jsonl", role: "work", status: "queued", activeRunId: runId, taskIds: ["personal-test"], workspaceRoot: "/workspace/d", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, queuedRun(workerId, runId));
    settleWorkerRun(f.registry, { parentSessionFile: "/sessions/parent.jsonl", workerId, runId, outcome: "completed", outcomeSource: "worker", settledAt: "2026-01-01T00:00:01.000Z" });
    leaseWorkerForReview(f.registry, workerId, "worker_20260101000000_eeeeeeee", "2026-01-01T00:00:02.000Z");
    assert.equal(getWorker(f.registry, workerId)?.reviewedByWorkerId, "worker_20260101000000_eeeeeeee");
    assert.throws(() => leaseWorkerForReview(f.registry, workerId, "worker_20260101000000_ffffffff", "2026-01-01T00:00:03.000Z"), /not available/);
    releaseWorkerReviewLease(f.registry, workerId, "worker_20260101000000_eeeeeeee", "2026-01-01T00:00:04.000Z");
    assert.equal(getWorker(f.registry, workerId)?.reviewedByWorkerId, undefined);
  } finally { f.close(); }
});


test("runtime generations recover only stale lifecycle claims for deterministic retry", () => {
  const f = fixture(); try {
    const workerId = "worker_20260101000000_recover1"; const runId = "run_20260101000000_recover1"; const parent = "/sessions/parent.jsonl";
    createWorkerAndRun(f.registry, { workerId, parentSessionFile: parent, role: "work", status: "queued", activeRunId: runId, taskIds: ["personal-test"], workspaceRoot: "/workspace/recover", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, queuedRun(workerId, runId));
    f.registry.database.prepare("UPDATE runs SET claim_kind='launch',claim_nonce='1-old' WHERE run_id=?").run(runId);
    recoverInterruptedClaimsForParent(f.registry, parent, 1, "2026-01-01T00:00:01.000Z"); assert.equal(getWorkerRun(f.registry, workerId, runId)?.claimKind, "launch");
    recoverInterruptedClaimsForParent(f.registry, parent, 2, "2026-01-01T00:00:02.000Z", ["1-old"]); assert.equal(getWorkerRun(f.registry, workerId, runId)?.claimKind, "launch", "a live durable operation token survives runtime replacement");
    recoverInterruptedClaimsForParent(f.registry, parent, 3, "2026-01-01T00:00:02.500Z"); assert.equal(getWorkerRun(f.registry, workerId, runId)?.claimKind, undefined);
    f.registry.database.prepare("UPDATE runs SET claim_kind='cancellation',claim_nonce='2-old' WHERE run_id=?").run(runId);
    recoverInterruptedClaimsForParent(f.registry, parent, 3, "2026-01-01T00:00:03.000Z");
    assert.equal(getWorkerRun(f.registry, workerId, runId)?.claimKind, undefined); assert.equal(getWorkerRun(f.registry, workerId, runId)?.terminalIntent, "cancellation"); assert.match(getWorker(f.registry, workerId)?.recoveryError ?? "", /containment recovery/);
    f.registry.database.prepare("UPDATE workers SET status='idle',active_run_id=NULL,operation_kind='discard',operation_nonce='2-old' WHERE worker_id=?").run(workerId);
    const preparedId=`prepared_${"d".repeat(24)}`;storePreparedSet(f.registry,{preparedId,parentSessionFile:parent,status:"ready",order:[],taskIds:["personal-test"],repositories:[],createdAt:"2026-01-01T00:00:03.500Z"});f.registry.database.prepare("UPDATE prepared_sets SET apply_nonce='2-prepared' WHERE prepared_id=?").run(preparedId);
    recoverInterruptedClaimsForParent(f.registry, parent, 3, "2026-01-01T00:00:04.000Z"); assert.equal(getWorker(f.registry, workerId)?.operationKind, "discard","dedicated discard recovery must retain root authority");assert.equal((f.registry.database.prepare("SELECT apply_nonce FROM prepared_sets WHERE prepared_id=?").get(preparedId) as any).apply_nonce,"2-prepared","runtime registration must not steal prepared apply authority");
  } finally { f.close(); }
});

test("runtime registration atomically preserves live foreign claims and fences old generations", () => {
  const f = fixture(); try {
    const workerId = "worker_20260101000000_atomic11"; const runId = "run_20260101000000_atomic11"; const parent = "/sessions/atomic.jsonl";
    createWorkerAndRun(f.registry, { workerId, parentSessionFile: parent, role: "work", status: "queued", activeRunId: runId, taskIds: ["personal-test"], workspaceRoot: "/workspace/atomic", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, queuedRun(workerId, runId));
    const generation1 = registerParentRuntime(f.registry, parent, "first", "2026-01-01T00:00:01.000Z");
    assert.equal(claimWorkerRun(f.registry, workerId, runId, "launch", "1-owner", ["queued"], generation1), true);
    let observed = 0; const generation2 = registerParentRuntimeAndRecoverClaims(f.registry, parent, "second", "2026-01-01T00:00:02.000Z", (claim) => { observed += 1; assert.equal(claim.claimNonce, "1-owner"); return true; });
    assert.equal(generation2, 2); assert.equal(observed, 1); assert.equal(getWorkerRun(f.registry, workerId, runId)?.claimNonce, "1-owner");
    assert.equal(releaseWorkerRunClaim(f.registry, workerId, runId, "launch", "1-owner"), true);
    assert.equal(claimWorkerRun(f.registry, workerId, runId, "launch", "1-stale", ["queued"], generation1), false, "an old process cannot claim in the post-registration gap");
    assert.equal(claimWorkerRun(f.registry, workerId, runId, "launch", "2-current", ["queued"], generation2), true);
  } finally { f.close(); }
});

test("terminal cleanup intent survives claim release and blocks every launch reclaim", () => {
  const f = fixture(); try {
    const workerId = "worker_20260101000000_intent11"; const runId = "run_20260101000000_intent11"; const parent = "/sessions/intent.jsonl";
    createWorkerAndRun(f.registry, { workerId, parentSessionFile: parent, role: "work", status: "queued", activeRunId: runId, taskIds: ["personal-test"], workspaceRoot: "/workspace/intent", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, queuedRun(workerId, runId));
    const generation = registerParentRuntime(f.registry, parent, "runtime", "2026-01-01T00:00:01.000Z");
    assert.equal(claimWorkerRun(f.registry, workerId, runId, "launch", "1-owner", ["queued"], generation), true);
    assert.equal(setClaimedWorkerTerminalIntent(f.registry, { workerId, runId, claimKind: "launch", claimNonce: "1-owner", terminalIntent: "failure", terminalError: "pre-host failed", now: "2026-01-01T00:00:02.000Z" }), "failure");
    assert.equal(releaseWorkerRunClaim(f.registry, workerId, runId, "launch", "1-owner"), true);
    assert.equal(claimWorkerRun(f.registry, workerId, runId, "launch", "1-relaunch", ["queued"], generation), false);
    assert.equal(claimWorkerTerminalIntent(f.registry, { workerId, runId, terminalIntent: "failure", claimKind: "settlement", claimNonce: "1-cleanup", now: "2026-01-01T00:00:03.000Z", runtimeGeneration: generation }), true);
    const run = getWorkerRun(f.registry, workerId, runId)!; assert.equal(run.terminalIntent, "failure"); assert.equal(run.terminalError, "pre-host failed"); assert.equal(run.claimKind, "settlement");
  } finally { f.close(); }
});

test("delivery reconciliation marks observed IDs without replaying an unconfirmed send", () => {
  const f = fixture();
  try {
    const workerId = "worker_20260101000000_11111111"; const runId = "run_20260101000000_11111111"; const parent = "/sessions/parent.jsonl";
    createWorkerAndRun(f.registry, { workerId, parentSessionFile: parent, role: "work", status: "queued", activeRunId: runId, taskIds: ["personal-test"], workspaceRoot: "/workspace/1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, queuedRun(workerId, runId));
    const deliveryId = settleWorkerRun(f.registry, { parentSessionFile: parent, workerId, runId, outcome: "completed", outcomeSource: "worker", settledAt: "2026-01-01T00:00:01.000Z" });
    const generation = registerParentRuntime(f.registry, parent, "runtime", "2026-01-01T00:00:02.000Z"); assert.equal(claimWorkerDelivery(f.registry, deliveryId, parent, generation), true);
    assert.equal(markWorkerDeliverySendStarted(f.registry, deliveryId, generation, "2026-01-01T00:00:03.000Z"), true);
    reconcileWorkerDeliveries(f.registry, parent, []); const ambiguous = pendingWorkerDeliveries(f.registry, parent)[0]!; assert.equal(ambiguous.state, "claimed"); assert.equal(ambiguous.sendStartedAt, "2026-01-01T00:00:03.000Z");
    releaseWorkerDeliveryClaim(f.registry, deliveryId, generation); assert.equal(pendingWorkerDeliveries(f.registry, parent)[0]?.state, "claimed", "a started send cannot be released for replay");
    reconcileWorkerDeliveries(f.registry, parent, [deliveryId]); assert.equal(pendingWorkerDeliveries(f.registry, parent).length, 0);
  } finally { f.close(); }
});


test("runtime promotion requeues only the dead owner's pre-send delivery claim", () => {
  const f = fixture(); try {
    const parent = "/sessions/delivery-promotion.jsonl";
    const createSettled = (suffix: string) => {
      const workerId = `worker_20260101000000_${suffix}`; const runId = `run_20260101000000_${suffix}`;
      createWorkerAndRun(f.registry, { workerId, parentSessionFile: parent, role: "work", status: "queued", activeRunId: runId, taskIds: ["personal-test"], workspaceRoot: `/workspace/${suffix}`, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, queuedRun(workerId, runId));
      return settleWorkerRun(f.registry, { parentSessionFile: parent, workerId, runId, outcome: "completed", outcomeSource: "worker", settledAt: "2026-01-01T00:00:01.000Z" });
    };
    const preSend = createSettled("delivery1"); const attempted = createSettled("delivery2");
    registerParentRuntime(f.registry, parent, "survivor", "2026-01-01T00:00:02.000Z", { pid: 101, processStartToken: "survivor-token" });
    const ownerGeneration = registerParentRuntime(f.registry, parent, "dead-owner", "2026-01-01T00:00:03.000Z", { pid: 202, processStartToken: "dead-token" });
    assert.equal(claimWorkerDelivery(f.registry, preSend, parent, ownerGeneration), true);
    const survivorGeneration = promoteParentRuntime(f.registry, { parentSessionFile: parent, expectedGeneration: ownerGeneration, expectedRuntimeId: "dead-owner", identity: { runtimeId: "survivor", pid: 101, processStartToken: "survivor-token" }, now: "2026-01-01T00:00:04.000Z" })!;
    assert.equal(pendingWorkerDeliveries(f.registry, parent).find((item) => item.deliveryId === preSend)?.state, "pending");
    assert.equal(claimWorkerDelivery(f.registry, attempted, parent, survivorGeneration), true);
    assert.equal(markWorkerDeliverySendStarted(f.registry, attempted, survivorGeneration, "2026-01-01T00:00:05.000Z"), true);
    const next = promoteParentRuntime(f.registry, { parentSessionFile: parent, expectedGeneration: survivorGeneration, expectedRuntimeId: "survivor", identity: { runtimeId: "dead-owner", pid: 202, processStartToken: "dead-token" }, now: "2026-01-01T00:00:06.000Z" });
    assert.equal(next, survivorGeneration + 1);
    const retained = pendingWorkerDeliveries(f.registry, parent).find((item) => item.deliveryId === attempted)!;
    assert.equal(retained.state, "claimed"); assert.equal(retained.sendStartedAt, "2026-01-01T00:00:05.000Z");
  } finally { f.close(); }
});

test("batch publication rolls back workers and review leases on a later insert failure", () => {
  const f = fixture(); try {
    const subjectId = "worker_20260101000000_subject1"; const subjectRun = "run_20260101000000_subject1"; const reviewerId = "worker_20260101000000_review11"; const reviewerRun = "run_20260101000000_review11";
    createWorkerAndRun(f.registry, { workerId: subjectId, parentSessionFile: "/sessions/parent.jsonl", role: "work", status: "queued", activeRunId: subjectRun, taskIds: ["personal-test"], workspaceRoot: "/workspace/subject", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, queuedRun(subjectId, subjectRun));
    settleWorkerRun(f.registry, { parentSessionFile: "/sessions/parent.jsonl", workerId: subjectId, runId: subjectRun, outcome: "completed", outcomeSource: "worker", settledAt: "2026-01-01T00:00:01.000Z" });
    const worker = { workerId: reviewerId, parentSessionFile: "/sessions/parent.jsonl", role: "review" as const, status: "queued" as const, activeRunId: reviewerRun, taskIds: ["personal-test"], workspaceRoot: "/workspace/reviewer", runtime: {}, createdAt: "2026-01-01T00:00:02.000Z", updatedAt: "2026-01-01T00:00:02.000Z" };
    assert.throws(() => createWorkerRunBatch(f.registry, { items: [
      { kind: "new", worker, run: { ...queuedRun(reviewerId, reviewerRun), binding: { reviewedWorkerId: subjectId, reviewedRunId: subjectRun } } },
      { kind: "new", worker, run: { ...queuedRun(reviewerId, "run_20260101000000_duplicate"), runId: "run_20260101000000_duplicate" } }
    ], reviewLeases: [{ subjectWorkerId: subjectId, reviewerWorkerId: reviewerId, reviewedRunId: subjectRun }], now: "2026-01-01T00:00:02.000Z" }));
    assert.equal(getWorker(f.registry, reviewerId), undefined); assert.equal(getWorker(f.registry, subjectId)?.reviewedByWorkerId, undefined);
  } finally { f.close(); }
});

test("cancellation CAS waits for an in-flight launch token before finalizing one delivery", () => {
  const f = fixture(); try {
    const workerId = "worker_20260101000000_cancel11"; const runId = "run_20260101000000_cancel11"; const parent = "/sessions/parent.jsonl";
    createWorkerAndRun(f.registry, { workerId, parentSessionFile: parent, role: "work", status: "queued", activeRunId: runId, taskIds: ["personal-test"], workspaceRoot: "/workspace/cancel", runtime: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, queuedRun(workerId, runId));
    const launchNonce = "launch"; assert.equal((awaitableClaim(f.registry, workerId, runId, launchNonce)), true);
    assert.equal(claimWorkerCancellation(f.registry, workerId, runId, "cancel", "2026-01-01T00:00:01.000Z"), false, "cancellation cannot steal a live launch operation token");
    f.registry.database.prepare("UPDATE runs SET claim_kind=NULL,claim_nonce=NULL WHERE worker_id=? AND run_id=? AND claim_kind='launch' AND claim_nonce=?").run(workerId, runId, launchNonce);
    assert.equal(claimWorkerCancellation(f.registry, workerId, runId, "cancel", "2026-01-01T00:00:01.500Z"), true);
    f.registry.database.prepare("UPDATE workers SET recovery_error='diagnostic' WHERE worker_id=?").run(workerId);
    assert.equal(claimWorkerCancellation(f.registry, workerId, runId, "cancel-successor", "2026-01-01T00:00:01.750Z"), false, "even recovery cannot steal a live cancellation token");
    finalizeClaimedWorkerRun(f.registry, { parentSessionFile: parent, workerId, runId, claimKind: "cancellation", claimNonce: "cancel", outcome: "cancelled", outcomeSource: "system", settledAt: "2026-01-01T00:00:02.000Z" });
    assert.equal(getWorkerRun(f.registry, workerId, runId)?.outcome, "cancelled"); assert.equal(pendingWorkerDeliveries(f.registry, parent).length, 1);
    assert.throws(() => finalizeClaimedWorkerRun(f.registry, { parentSessionFile: parent, workerId, runId, claimKind: "cancellation", claimNonce: "cancel", outcome: "cancelled", outcomeSource: "system", settledAt: "2026-01-01T00:00:03.000Z" }), /changed state/);
    assert.equal(pendingWorkerDeliveries(f.registry, parent).length, 1);
  } finally { f.close(); }
});

function awaitableClaim(registry: ReturnType<typeof openWorkerRegistry>, workerId: string, runId: string, nonce: string): boolean {
  const result = registry.database.prepare("UPDATE runs SET claim_kind='launch',claim_nonce=? WHERE worker_id=? AND run_id=? AND claim_kind IS NULL").run(nonce, workerId, runId);
  return Number(result.changes) === 1;
}

test("fresh current root initializes only the exact latest schema", () => {
  const root=mkdtempSync(path.join(tmpdir(),"pi-worker-registry-current-"));let registry:ReturnType<typeof openWorkerRegistry>|undefined;
  try{registry=openWorkerRegistry(root,{strictCurrentRoot:true});assert.equal((registry.database.prepare("SELECT value FROM registry_meta WHERE key='schema_version'").get() as {value:string}).value,"10");assert.equal((registry.database.prepare("PRAGMA user_version").get() as {user_version:number}).user_version,10);const storage=(registry.database.prepare("PRAGMA table_info(workers)").all() as Array<{name:string}>).find((column)=>column.name==="storage_layout");assert.ok(storage);}
  finally{registry?.close();rmSync(root,{recursive:true,force:true});}
});

test("non-current registry metadata is rejected without migration or byte rewrite", () => {
  const root=mkdtempSync(path.join(tmpdir(),"pi-worker-registry-old-schema-"));let registry:ReturnType<typeof openWorkerRegistry>|undefined;
  try{registry=openWorkerRegistry(root);registry.database.prepare("UPDATE registry_meta SET value='9' WHERE key='schema_version'").run();registry.database.exec("PRAGMA user_version = 9");registry.close();registry=undefined;const file=path.join(root,"registry.sqlite"),before=readFileSync(file);assert.throws(()=>openWorkerRegistry(root),/must be exact schema 10|migration.*not permitted/i);assert.deepEqual(readFileSync(file),before);}
  finally{registry?.close();rmSync(root,{recursive:true,force:true});}
});

test("partial or unexpected strict current roots fail closed without repair", () => {
  const occupied=mkdtempSync(path.join(tmpdir(),"pi-worker-registry-partial-dir-"));const sentinel=path.join(occupied,"unexpected");writeFileSync(sentinel,"retain-byte-for-byte\n");try{assert.throws(()=>openWorkerRegistry(occupied,{strictCurrentRoot:true}),/partial or unexpected/);assert.equal(readFileSync(sentinel,"utf8"),"retain-byte-for-byte\n");assert.equal(existsSync(path.join(occupied,"registry.sqlite")),false);}finally{rmSync(occupied,{recursive:true,force:true});}
  const partial=mkdtempSync(path.join(tmpdir(),"pi-worker-registry-partial-db-"));const file=path.join(partial,"registry.sqlite");writeFileSync(file,"partial-registry\n");const before=readFileSync(file);try{assert.throws(()=>openWorkerRegistry(partial,{strictCurrentRoot:true}),/partial|schema authority|file is not a database/i);assert.deepEqual(readFileSync(file),before);}finally{rmSync(partial,{recursive:true,force:true});}
});

test("exact current metadata cannot mask a missing schema object", () => {
  const root=mkdtempSync(path.join(tmpdir(),"pi-worker-registry-corrupt-schema-"));let registry:ReturnType<typeof openWorkerRegistry>|undefined;
  try{registry=openWorkerRegistry(root);registry.database.exec("DROP TABLE cleanup_scan_cursors");registry.close();registry=undefined;assert.throws(()=>openWorkerRegistry(root),/schema objects do not exactly match/);const sqlite=process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");const raw=new sqlite.DatabaseSync(path.join(root,"registry.sqlite"));try{assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cleanup_scan_cursors'").get(),undefined,"reopen must not repair missing objects");}finally{raw.close();}}
  finally{registry?.close();rmSync(root,{recursive:true,force:true});}
});


test("cleanup unit recovery preserves an existing exact error while refreshing its evidence",()=>{
 const f=fixture();try{const workerId="worker_20260101000000_recover1",runId="run_20260101000000_recover1",parent=path.join(f.root,"parent.jsonl");createWorkerAndRun(f.registry,{workerId,parentSessionFile:parent,role:"work",status:"queued",activeRunId:runId,taskIds:["personal-test"],workspaceRoot:path.join(f.root,"workspace"),runtime:{cleanupConsent:{token:"cleanup_token",snapshotHash:"hash"}},createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"},queuedRun(workerId,runId));f.registry.database.prepare("UPDATE workers SET status='idle',active_run_id=NULL,recovery_error='first exact failure' WHERE worker_id=?").run(workerId);const owner=getWorker(f.registry,workerId)!.parentSessionFile;assert.equal(markWorkerCleanupRecovery(f.registry,workerId,owner,"later different failure","2026-01-01T00:00:01.000Z"),true);const retained=getWorker(f.registry,workerId)!;assert.equal(retained.recoveryError,"first exact failure");assert.equal((retained.runtime!.cleanupRecovery as any).phase,"precommit");assert.equal((retained.runtime!.cleanupRecovery as any).error,"first exact failure");}finally{f.close();}
});
