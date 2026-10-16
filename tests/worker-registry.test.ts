import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  claimWorkerCancellation,
  claimWorkerDelivery,
  createWorkerAndRun,
  createWorkerRunBatch,
  discardWorkerRegistryRecord,
  finalizeClaimedWorkerRun,
  getWorker,
  getWorkerRun,
  leaseWorkerForReview,
  listWorkerRuns,
  listWorkers,
  markWorkerDeliveryDelivered,
  markWorkerRunRunning,
  openWorkerRegistry,
  pendingWorkerDeliveries,
  reconcileWorkerDeliveries,
  registerParentRuntime,
  releaseWorkerReviewLease,
  releaseWorkerDeliveryClaim,
  settleWorkerRun,
  storePreparedSet,
  updatePreparedSetStatus,
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
    storePreparedSet(f.registry, { preparedId: `prepared_${"d".repeat(24)}`, parentSessionFile: "/sessions/parent.jsonl", status: "ready", order: ["repo"], repositories: [{ id: "repo", desiredCommit: "a".repeat(40) }], createdAt: "2026-01-01T00:00:00.000Z" });
    updatePreparedSetStatus(f.registry, `prepared_${"d".repeat(24)}`, "/sessions/parent.jsonl", "completed", "2026-01-01T00:00:01.000Z");
    const row = f.registry.database.prepare("SELECT status FROM prepared_sets WHERE prepared_id=?").get(`prepared_${"d".repeat(24)}`) as { status: string };
    assert.equal(row.status, "completed");
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


test("delivery reconciliation marks session-observed IDs and requeues uncertain claims", () => {
  const f = fixture();
  try {
    const workerId = "worker_20260101000000_11111111"; const runId = "run_20260101000000_11111111"; const parent = "/sessions/parent.jsonl";
    createWorkerAndRun(f.registry, { workerId, parentSessionFile: parent, role: "work", status: "queued", activeRunId: runId, taskIds: ["personal-test"], workspaceRoot: "/workspace/1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, queuedRun(workerId, runId));
    const deliveryId = settleWorkerRun(f.registry, { parentSessionFile: parent, workerId, runId, outcome: "completed", outcomeSource: "worker", settledAt: "2026-01-01T00:00:01.000Z" });
    const generation = registerParentRuntime(f.registry, parent, "runtime", "2026-01-01T00:00:02.000Z"); assert.equal(claimWorkerDelivery(f.registry, deliveryId, parent, generation), true);
    reconcileWorkerDeliveries(f.registry, parent, []); assert.equal(pendingWorkerDeliveries(f.registry, parent)[0]?.state, "pending");
    reconcileWorkerDeliveries(f.registry, parent, [deliveryId]); assert.equal(pendingWorkerDeliveries(f.registry, parent).length, 0);
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

test("cancellation CAS revokes an in-flight launch and finalizes one cancelled delivery", () => {
  const f = fixture(); try {
    const workerId = "worker_20260101000000_cancel11"; const runId = "run_20260101000000_cancel11"; const parent = "/sessions/parent.jsonl";
    createWorkerAndRun(f.registry, { workerId, parentSessionFile: parent, role: "work", status: "queued", activeRunId: runId, taskIds: ["personal-test"], workspaceRoot: "/workspace/cancel", runtime: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, queuedRun(workerId, runId));
    const launchNonce = "launch"; assert.equal((awaitableClaim(f.registry, workerId, runId, launchNonce)), true);
    assert.equal(claimWorkerCancellation(f.registry, workerId, runId, "cancel", "2026-01-01T00:00:01.000Z"), true);
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
