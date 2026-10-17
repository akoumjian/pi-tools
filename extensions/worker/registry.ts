import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { DatabaseSync as SQLiteDatabaseSync, SQLInputValue } from "node:sqlite";

export const WORKER_REGISTRY_SCHEMA_VERSION = 3;
export const DEFAULT_WORKER_RUNTIME_ROOT = path.join(homedir(), ".local", "share", "agent", "worker-runtime");

export type WorkerRole = "work" | "review" | "integration";
export type WorkerStatus = "idle" | "queued" | "running";
export type WorkerRunStatus = "queued" | "running" | "settled";
export type WorkerOutcomeSource = "worker" | "system";
export type WorkerOutcome =
  | "completed"
  | "needs_input"
  | "blocked"
  | "approve"
  | "request_changes"
  | "failed"
  | "cancelled";

export type WorkerRepositoryResult = {
  candidateId: string;
  path: string;
  commit: string;
  source?: string;
  reported: boolean;
  changed: boolean;
  dirty: boolean;
  eligible: boolean;
  issues?: string[];
};

export type WorkerScopedError = {
  scope: "run" | "repositories" | "artifacts";
  message: string;
};

export type WorkerBinding =
  | { reviewedWorkerId: string; reviewedRunId: string }
  | { preparedId: string };

export type WorkerRegistryRecord = {
  workerId: string;
  parentSessionFile: string;
  role: WorkerRole;
  status: WorkerStatus;
  activeRunId?: string;
  latestRunId?: string;
  taskIds: string[];
  modelSelection?: string;
  sessionId?: string;
  sessionFile?: string;
  workspaceRoot: string;
  recoveryError?: string;
  reviewedByWorkerId?: string;
  runtime?: Record<string, unknown>;
  operationKind?: "discard";
  operationNonce?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkerRunRecord = {
  runId: string;
  workerId: string;
  status: WorkerRunStatus;
  taskIds: string[];
  modelSelection?: string;
  completionDelivery: "steer" | "followUp";
  binding?: WorkerBinding;
  jobId?: string;
  stdoutLog?: string;
  stderrLog?: string;
  sessionStartLine?: number;
  sessionEndLine?: number;
  outcome?: WorkerOutcome;
  outcomeSource?: WorkerOutcomeSource;
  summary?: string;
  question?: string;
  repositories: WorkerRepositoryResult[];
  artifacts: string[];
  errors: WorkerScopedError[];
  runtime?: Record<string, unknown>;
  claimKind?: "launch" | "settlement" | "cancellation";
  claimNonce?: string;
  createdAt: string;
  startedAt?: string;
  settledAt?: string;
};

export type WorkerDeliveryRecord = {
  deliveryId: string;
  parentSessionFile: string;
  workerId: string;
  runId: string;
  completionDelivery: "steer" | "followUp";
  state: "pending" | "claimed" | "delivered";
  runtimeGeneration?: number;
  createdAt: string;
  deliveredAt?: string;
};

export type WorkerRegistry = {
  database: SQLiteDatabaseSync;
  databasePath: string;
  close(): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS registry_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS workers (
  worker_id TEXT PRIMARY KEY,
  parent_session_file TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('work','review','integration')),
  status TEXT NOT NULL CHECK (status IN ('idle','queued','running')),
  active_run_id TEXT,
  latest_run_id TEXT,
  task_ids_json TEXT NOT NULL,
  model_selection TEXT,
  session_id TEXT,
  session_file TEXT,
  workspace_root TEXT NOT NULL,
  recovery_error TEXT,
  reviewed_by_worker_id TEXT,
  runtime_json TEXT NOT NULL DEFAULT '{}',
  operation_kind TEXT CHECK (operation_kind IS NULL OR operation_kind IN ('discard')),
  operation_nonce TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','settled')),
  task_ids_json TEXT NOT NULL,
  model_selection TEXT,
  completion_delivery TEXT NOT NULL CHECK (completion_delivery IN ('steer','followUp')),
  binding_json TEXT,
  job_id TEXT,
  stdout_log TEXT,
  stderr_log TEXT,
  session_start_line INTEGER,
  session_end_line INTEGER,
  outcome TEXT,
  outcome_source TEXT CHECK (outcome_source IS NULL OR outcome_source IN ('worker','system')),
  summary TEXT,
  question TEXT,
  repositories_json TEXT NOT NULL DEFAULT '[]',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  errors_json TEXT NOT NULL DEFAULT '[]',
  runtime_json TEXT NOT NULL DEFAULT '{}',
  claim_kind TEXT CHECK (claim_kind IS NULL OR claim_kind IN ('launch','settlement','cancellation')),
  claim_nonce TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  settled_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS runs_worker_created ON runs(worker_id, created_at DESC, run_id DESC);
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  parent_session_file TEXT NOT NULL,
  worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  completion_delivery TEXT NOT NULL CHECK (completion_delivery IN ('steer','followUp')),
  state TEXT NOT NULL CHECK (state IN ('pending','claimed','delivered')),
  runtime_generation INTEGER,
  created_at TEXT NOT NULL,
  delivered_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS deliveries_parent_state ON deliveries(parent_session_file, state, created_at);
CREATE TABLE IF NOT EXISTS parent_runtimes (
  parent_session_file TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  runtime_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS prepared_sets (
  prepared_id TEXT PRIMARY KEY,
  parent_session_file TEXT NOT NULL,
  status TEXT NOT NULL,
  order_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  apply_nonce TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS prepared_repositories (
  prepared_id TEXT NOT NULL REFERENCES prepared_sets(prepared_id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (prepared_id, repository_id)
) STRICT;
`;

const WORKER_REGISTRY_SCHEMA_HASH = createHash("sha256").update(SCHEMA).digest("hex");

export function openWorkerRegistry(runtimeRoot = DEFAULT_WORKER_RUNTIME_ROOT): WorkerRegistry {
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  chmodSync(runtimeRoot, 0o700);
  const databasePath = path.join(runtimeRoot, "registry.sqlite");
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!sqlite) throw new Error("Managed workers require the Node node:sqlite builtin.");
  const database = new sqlite.DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(SCHEMA);
    const row = database.prepare("SELECT value FROM registry_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    const fingerprint = database.prepare("SELECT value FROM registry_meta WHERE key = 'schema_hash'").get() as { value?: string } | undefined;
    if (row === undefined) {
      database.prepare("INSERT INTO registry_meta(key,value) VALUES('schema_version',?)").run(String(WORKER_REGISTRY_SCHEMA_VERSION));
      database.prepare("INSERT INTO registry_meta(key,value) VALUES('schema_hash',?)").run(WORKER_REGISTRY_SCHEMA_HASH);
    } else {
      const version = Number(row.value);
      if (!Number.isSafeInteger(version) || version < 2 || version > WORKER_REGISTRY_SCHEMA_VERSION) throw new Error(`Unsupported worker registry schema ${row.value ?? "missing"}.`);
      migrateWorkerRegistry(database, version);
      database.prepare("UPDATE registry_meta SET value=? WHERE key='schema_version'").run(String(WORKER_REGISTRY_SCHEMA_VERSION));
      if (fingerprint === undefined) database.prepare("INSERT INTO registry_meta(key,value) VALUES('schema_hash',?)").run(WORKER_REGISTRY_SCHEMA_HASH);
      else database.prepare("UPDATE registry_meta SET value=? WHERE key='schema_hash'").run(WORKER_REGISTRY_SCHEMA_HASH);
    }
    database.exec(`PRAGMA user_version = ${WORKER_REGISTRY_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }
  return { database, databasePath, close: () => database.close() };
}

function migrateWorkerRegistry(database: SQLiteDatabaseSync, fromVersion: number): void {
  // v3 replaces source-text fingerprint gating with explicit numbered migration authority.
  // v2 already has the complete v3 table shape, so this migration is intentionally data-only.
  if (fromVersion <= 2) return;
}

export function workerRegistryDataVersion(registry: WorkerRegistry): number {
  const row = registry.database.prepare("PRAGMA data_version").get() as { data_version: number };
  return Number(row.data_version);
}

export function registerParentRuntime(registry: WorkerRegistry, parentSessionFile: string, runtimeId: string, now: string): number {
  return transaction(registry, () => {
    const current = registry.database.prepare("SELECT generation FROM parent_runtimes WHERE parent_session_file = ?").get(parentSessionFile) as { generation: number } | undefined;
    const generation = (current?.generation ?? 0) + 1;
    registry.database.prepare(`INSERT INTO parent_runtimes(parent_session_file,generation,runtime_id,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(parent_session_file) DO UPDATE SET generation=excluded.generation,runtime_id=excluded.runtime_id,updated_at=excluded.updated_at`)
      .run(parentSessionFile, generation, runtimeId, now);
    return generation;
  });
}

export function createWorkerAndRun(registry: WorkerRegistry, worker: Omit<WorkerRegistryRecord, "version">, run: WorkerRunRecord): void {
  transaction(registry, () => {
    insertWorker(registry, worker);
    insertRun(registry, run);
  });
}

export function insertWorkerRun(registry: WorkerRegistry, workerId: string, expectedVersion: number, run: WorkerRunRecord, now: string): void {
  transaction(registry, () => {
    const update = registry.database.prepare(`UPDATE workers SET status=?,active_run_id=?,task_ids_json=?,model_selection=COALESCE(?,model_selection),version=version+1,updated_at=? WHERE worker_id=? AND version=? AND status='idle'`)
      .run(run.status === "queued" ? "queued" : "running", run.runId, json(run.taskIds), nullable(run.modelSelection), now, workerId, expectedVersion);
    if (Number(update.changes) !== 1) throw staleWorker(workerId);
    insertRun(registry, run);
  });
}

export function markWorkerRunRunning(registry: WorkerRegistry, workerId: string, runId: string, values: { modelSelection: string; jobId: string; stdoutLog: string; stderrLog: string; startedAt: string }): void {
  transaction(registry, () => {
    const run = registry.database.prepare(`UPDATE runs SET status='running',model_selection=?,job_id=?,stdout_log=?,stderr_log=?,started_at=? WHERE run_id=? AND worker_id=? AND status='queued'`)
      .run(values.modelSelection, values.jobId, values.stdoutLog, values.stderrLog, values.startedAt, runId, workerId);
    const worker = registry.database.prepare(`UPDATE workers SET status='running',model_selection=?,version=version+1,updated_at=? WHERE worker_id=? AND active_run_id=? AND status='queued'`)
      .run(values.modelSelection, values.startedAt, workerId, runId);
    if (Number(run.changes) !== 1 || Number(worker.changes) !== 1) throw staleRun(workerId, runId);
  });
}

export function settleWorkerRun(registry: WorkerRegistry, input: {
  parentSessionFile: string;
  workerId: string;
  runId: string;
  outcome: WorkerOutcome;
  outcomeSource: WorkerOutcomeSource;
  summary?: string;
  question?: string;
  repositories?: WorkerRepositoryResult[];
  artifacts?: string[];
  errors?: WorkerScopedError[];
  sessionStartLine?: number;
  sessionEndLine?: number;
  settledAt: string;
}): string {
  return transaction(registry, () => {
    const deliveryId = `worker-run:${input.workerId}:${input.runId}`;
    const current = readRunRow(registry, input.runId);
    if (current.worker_id !== input.workerId || current.status === "settled") throw staleRun(input.workerId, input.runId);
    registry.database.prepare(`UPDATE runs SET status='settled',outcome=?,outcome_source=?,summary=?,question=?,repositories_json=?,artifacts_json=?,errors_json=?,session_start_line=?,session_end_line=?,settled_at=?,claim_kind=NULL,claim_nonce=NULL WHERE run_id=? AND status IN ('queued','running')`)
      .run(input.outcome, input.outcomeSource, nullable(input.summary), nullable(input.question), json(input.repositories ?? []), json(input.artifacts ?? []), json(input.errors ?? []), nullable(input.sessionStartLine), nullable(input.sessionEndLine), input.settledAt, input.runId);
    const worker = registry.database.prepare(`UPDATE workers SET status='idle',active_run_id=NULL,latest_run_id=?,recovery_error=NULL,version=version+1,updated_at=? WHERE worker_id=? AND active_run_id=?`)
      .run(input.runId, input.settledAt, input.workerId, input.runId);
    if (Number(worker.changes) !== 1) throw staleRun(input.workerId, input.runId);
    registry.database.prepare(`INSERT INTO deliveries(delivery_id,parent_session_file,worker_id,run_id,completion_delivery,state,created_at)
      VALUES(?,?,?,?,?,'pending',?)`).run(deliveryId, input.parentSessionFile, input.workerId, input.runId, current.completion_delivery, input.settledAt);
    return deliveryId;
  });
}

export function setWorkerRecoveryError(registry: WorkerRegistry, workerId: string, runId: string, error: string, now: string): void {
  transaction(registry, () => {
    const result = registry.database.prepare("UPDATE workers SET recovery_error=?,version=version+1,updated_at=? WHERE worker_id=? AND active_run_id=?")
      .run(error, now, workerId, runId);
    if (Number(result.changes) !== 1) throw staleRun(workerId, runId);
  });
}

export function listWorkers(registry: WorkerRegistry, input: { parentSessionFile: string; status?: WorkerStatus; role?: WorkerRole; limit?: number; offset?: number }): { workers: WorkerRegistryRecord[]; total: number; nextOffset?: number } {
  const limit = boundedPage(input.limit);
  const offset = Math.max(0, input.offset ?? 0);
  const predicates = ["parent_session_file = ?"];
  const values: SQLInputValue[] = [input.parentSessionFile];
  if (input.status !== undefined) { predicates.push("status = ?"); values.push(input.status); }
  if (input.role !== undefined) { predicates.push("role = ?"); values.push(input.role); }
  const where = predicates.join(" AND ");
  const total = Number((registry.database.prepare(`SELECT COUNT(*) AS count FROM workers WHERE ${where}`).get(...values) as { count: number }).count);
  const rows = registry.database.prepare(`SELECT * FROM workers WHERE ${where} ORDER BY updated_at DESC,worker_id DESC LIMIT ? OFFSET ?`).all(...values, limit, offset) as unknown as WorkerRow[];
  return { workers: rows.map(decodeWorker), total, ...(offset + rows.length < total ? { nextOffset: offset + rows.length } : {}) };
}

export function listWorkerRuns(registry: WorkerRegistry, workerId: string, limitInput?: number, offsetInput?: number): { runs: WorkerRunRecord[]; total: number; nextOffset?: number } {
  const limit = boundedPage(limitInput);
  const offset = Math.max(0, offsetInput ?? 0);
  const total = Number((registry.database.prepare("SELECT COUNT(*) AS count FROM runs WHERE worker_id=?").get(workerId) as { count: number }).count);
  const rows = registry.database.prepare("SELECT * FROM runs WHERE worker_id=? ORDER BY created_at DESC,run_id DESC LIMIT ? OFFSET ?").all(workerId, limit, offset) as unknown as RunRow[];
  return { runs: rows.map(decodeRun), total, ...(offset + rows.length < total ? { nextOffset: offset + rows.length } : {}) };
}

export function getWorker(registry: WorkerRegistry, workerId: string): WorkerRegistryRecord | undefined {
  const row = registry.database.prepare("SELECT * FROM workers WHERE worker_id=?").get(workerId) as WorkerRow | undefined;
  return row === undefined ? undefined : decodeWorker(row);
}

export function getWorkerRun(registry: WorkerRegistry, workerId: string, runId: string): WorkerRunRecord | undefined {
  const row = registry.database.prepare("SELECT * FROM runs WHERE worker_id=? AND run_id=?").get(workerId, runId) as RunRow | undefined;
  return row === undefined ? undefined : decodeRun(row);
}

export function pendingWorkerDeliveries(registry: WorkerRegistry, parentSessionFile: string): WorkerDeliveryRecord[] {
  const rows = registry.database.prepare("SELECT * FROM deliveries WHERE parent_session_file=? AND state!='delivered' ORDER BY created_at,delivery_id").all(parentSessionFile) as unknown as DeliveryRow[];
  return rows.map(decodeDelivery);
}

export function claimWorkerDelivery(registry: WorkerRegistry, deliveryId: string, parentSessionFile: string, runtimeGeneration: number): boolean {
  return transaction(registry, () => {
    const active = registry.database.prepare("SELECT generation FROM parent_runtimes WHERE parent_session_file=?").get(parentSessionFile) as { generation: number } | undefined;
    if (active?.generation !== runtimeGeneration) return false;
    const result = registry.database.prepare(`UPDATE deliveries SET state='claimed',runtime_generation=? WHERE delivery_id=? AND parent_session_file=? AND state='pending'`)
      .run(runtimeGeneration, deliveryId, parentSessionFile);
    return Number(result.changes) === 1;
  });
}

export function releaseWorkerDeliveryClaim(registry: WorkerRegistry, deliveryId: string, runtimeGeneration: number): void {
  transaction(registry, () => {
    registry.database.prepare("UPDATE deliveries SET state='pending',runtime_generation=NULL WHERE delivery_id=? AND state='claimed' AND runtime_generation=?")
      .run(deliveryId, runtimeGeneration);
  });
}

export function markWorkerDeliveryDelivered(registry: WorkerRegistry, deliveryId: string, runtimeGeneration: number, now: string): boolean {
  return transaction(registry, () => {
    const result = registry.database.prepare(`UPDATE deliveries SET state='delivered',delivered_at=? WHERE delivery_id=? AND state='claimed' AND runtime_generation=?`)
      .run(now, deliveryId, runtimeGeneration);
    return Number(result.changes) === 1;
  });
}

export function discardWorkerRegistryRecord(registry: WorkerRegistry, workerId: string, expectedVersion: number): void {
  transaction(registry, () => {
    const result = registry.database.prepare("DELETE FROM workers WHERE worker_id=? AND version=? AND status='idle'").run(workerId, expectedVersion);
    if (Number(result.changes) !== 1) throw staleWorker(workerId);
  });
}

function insertRun(registry: WorkerRegistry, run: WorkerRunRecord): void {
  registry.database.prepare(`INSERT INTO runs(run_id,worker_id,status,task_ids_json,model_selection,completion_delivery,binding_json,job_id,stdout_log,stderr_log,session_start_line,session_end_line,outcome,outcome_source,summary,question,repositories_json,artifacts_json,errors_json,runtime_json,claim_kind,claim_nonce,created_at,started_at,settled_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    run.runId, run.workerId, run.status, json(run.taskIds), nullable(run.modelSelection), run.completionDelivery, run.binding === undefined ? null : json(run.binding), nullable(run.jobId), nullable(run.stdoutLog), nullable(run.stderrLog), nullable(run.sessionStartLine), nullable(run.sessionEndLine), nullable(run.outcome), nullable(run.outcomeSource), nullable(run.summary), nullable(run.question), json(run.repositories), json(run.artifacts), json(run.errors), json(run.runtime ?? {}), nullable(run.claimKind), nullable(run.claimNonce), run.createdAt, nullable(run.startedAt), nullable(run.settledAt)
  );
}

function transaction<T>(registry: WorkerRegistry, fn: () => T): T {
  registry.database.exec("BEGIN IMMEDIATE");
  try {
    assertSchema(registry);
    const value = fn();
    registry.database.exec("COMMIT");
    return value;
  } catch (error) {
    registry.database.exec("ROLLBACK");
    throw error;
  }
}

function assertSchema(registry: WorkerRegistry): void {
  const row = registry.database.prepare("SELECT value FROM registry_meta WHERE key='schema_version'").get() as { value?: string } | undefined;
  const fingerprint = registry.database.prepare("SELECT value FROM registry_meta WHERE key='schema_hash'").get() as { value?: string } | undefined;
  if (Number(row?.value) !== WORKER_REGISTRY_SCHEMA_VERSION || fingerprint?.value !== WORKER_REGISTRY_SCHEMA_HASH) throw new Error(`Unsupported worker registry schema ${row?.value ?? "missing"} or schema fingerprint mismatch.`);
}

function boundedPage(value: number | undefined): number {
  return Math.min(100, Math.max(1, value ?? 20));
}

function staleWorker(workerId: string): Error { return new Error(`Worker ${workerId} changed state; inspect it and retry.`); }
function staleRun(workerId: string, runId: string): Error { return new Error(`Worker ${workerId}/${runId} changed state; inspect it and retry.`); }
function json(value: unknown): string { return JSON.stringify(value); }
function canonicalSessionFile(value: string): string { try { return realpathSync(path.resolve(value)); } catch { return path.resolve(value); } }

function nullable<T extends SQLInputValue>(value: T | undefined): T | null { return value ?? null; }
function parseJson<T>(text: string): T { return JSON.parse(text) as T; }

function readRunRow(registry: WorkerRegistry, runId: string): RunRow {
  const row = registry.database.prepare("SELECT * FROM runs WHERE run_id=?").get(runId) as RunRow | undefined;
  if (row === undefined) throw new Error(`Unknown worker run ${runId}.`);
  return row;
}

type WorkerRow = {
  worker_id: string; parent_session_file: string; role: WorkerRole; status: WorkerStatus; active_run_id: string | null; latest_run_id: string | null;
  task_ids_json: string; model_selection: string | null; session_id: string | null; session_file: string | null; workspace_root: string;
  recovery_error: string | null; reviewed_by_worker_id: string | null; runtime_json: string; operation_kind: "discard" | null; operation_nonce: string | null; version: number; created_at: string; updated_at: string;
};
type RunRow = {
  run_id: string; worker_id: string; status: WorkerRunStatus; task_ids_json: string; model_selection: string | null; completion_delivery: "steer" | "followUp";
  binding_json: string | null; job_id: string | null; stdout_log: string | null; stderr_log: string | null; session_start_line: number | null; session_end_line: number | null;
  outcome: WorkerOutcome | null; outcome_source: WorkerOutcomeSource | null; summary: string | null; question: string | null; repositories_json: string; artifacts_json: string;
  errors_json: string; runtime_json: string; claim_kind: "launch" | "settlement" | "cancellation" | null; claim_nonce: string | null; created_at: string; started_at: string | null; settled_at: string | null;
};
type DeliveryRow = {
  delivery_id: string; parent_session_file: string; worker_id: string; run_id: string; completion_delivery: "steer" | "followUp"; state: "pending" | "claimed" | "delivered";
  runtime_generation: number | null; created_at: string; delivered_at: string | null;
};

function decodeWorker(row: WorkerRow): WorkerRegistryRecord {
  return {
    workerId: row.worker_id, parentSessionFile: row.parent_session_file, role: row.role, status: row.status,
    ...(row.active_run_id === null ? {} : { activeRunId: row.active_run_id }), ...(row.latest_run_id === null ? {} : { latestRunId: row.latest_run_id }),
    taskIds: parseJson<string[]>(row.task_ids_json), ...(row.model_selection === null ? {} : { modelSelection: row.model_selection }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }), ...(row.session_file === null ? {} : { sessionFile: row.session_file }),
    workspaceRoot: row.workspace_root, ...(row.recovery_error === null ? {} : { recoveryError: row.recovery_error }), ...(row.reviewed_by_worker_id === null ? {} : { reviewedByWorkerId: row.reviewed_by_worker_id }), runtime: parseJson<Record<string, unknown>>(row.runtime_json), ...(row.operation_kind === null ? {} : { operationKind: row.operation_kind }), ...(row.operation_nonce === null ? {} : { operationNonce: row.operation_nonce }), version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}
function decodeRun(row: RunRow): WorkerRunRecord {
  return {
    runId: row.run_id, workerId: row.worker_id, status: row.status, taskIds: parseJson<string[]>(row.task_ids_json),
    ...(row.model_selection === null ? {} : { modelSelection: row.model_selection }), completionDelivery: row.completion_delivery,
    ...(row.binding_json === null ? {} : { binding: parseJson<WorkerBinding>(row.binding_json) }), ...(row.job_id === null ? {} : { jobId: row.job_id }),
    ...(row.stdout_log === null ? {} : { stdoutLog: row.stdout_log }), ...(row.stderr_log === null ? {} : { stderrLog: row.stderr_log }),
    ...(row.session_start_line === null ? {} : { sessionStartLine: row.session_start_line }), ...(row.session_end_line === null ? {} : { sessionEndLine: row.session_end_line }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }), ...(row.outcome_source === null ? {} : { outcomeSource: row.outcome_source }),
    ...(row.summary === null ? {} : { summary: row.summary }), ...(row.question === null ? {} : { question: row.question }),
    repositories: parseJson<WorkerRepositoryResult[]>(row.repositories_json), artifacts: parseJson<string[]>(row.artifacts_json), errors: parseJson<WorkerScopedError[]>(row.errors_json), runtime: parseJson<Record<string, unknown>>(row.runtime_json), ...(row.claim_kind === null ? {} : { claimKind: row.claim_kind }), ...(row.claim_nonce === null ? {} : { claimNonce: row.claim_nonce }),
    createdAt: row.created_at, ...(row.started_at === null ? {} : { startedAt: row.started_at }), ...(row.settled_at === null ? {} : { settledAt: row.settled_at })
  };
}
function decodeDelivery(row: DeliveryRow): WorkerDeliveryRecord {
  return {
    deliveryId: row.delivery_id, parentSessionFile: row.parent_session_file, workerId: row.worker_id, runId: row.run_id,
    completionDelivery: row.completion_delivery, state: row.state, ...(row.runtime_generation === null ? {} : { runtimeGeneration: row.runtime_generation }),
    createdAt: row.created_at, ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at })
  };
}

export function leaseWorkerForReview(registry: WorkerRegistry, subjectWorkerId: string, reviewerWorkerId: string, now: string): void {
  transaction(registry, () => { const result = registry.database.prepare("UPDATE workers SET reviewed_by_worker_id=?,version=version+1,updated_at=? WHERE worker_id=? AND status='idle' AND (reviewed_by_worker_id IS NULL OR reviewed_by_worker_id=?)").run(reviewerWorkerId, now, subjectWorkerId, reviewerWorkerId); if (Number(result.changes) !== 1) throw new Error(`Worker ${subjectWorkerId} is not available for review.`); });
}
export function releaseWorkerReviewLease(registry: WorkerRegistry, subjectWorkerId: string, reviewerWorkerId: string, now: string): void {
  transaction(registry, () => { registry.database.prepare("UPDATE workers SET reviewed_by_worker_id=NULL,version=version+1,updated_at=? WHERE worker_id=? AND reviewed_by_worker_id=?").run(now, subjectWorkerId, reviewerWorkerId); });
}

export function updateWorkerRuntimeMetadata(registry: WorkerRegistry, workerId: string, values: { sessionId?: string; sessionFile?: string; modelSelection?: string; updatedAt: string }): void {
  transaction(registry, () => {
    const result = registry.database.prepare(`UPDATE workers SET session_id=COALESCE(?,session_id),session_file=COALESCE(?,session_file),model_selection=COALESCE(?,model_selection),updated_at=? WHERE worker_id=?`)
      .run(nullable(values.sessionId), nullable(values.sessionFile), nullable(values.modelSelection), values.updatedAt, workerId);
    if (Number(result.changes) !== 1) throw new Error(`Unknown worker ${workerId}.`);
  });
}

export function updateWorkerRunSessionRange(registry: WorkerRegistry, workerId: string, runId: string, startLine?: number, endLine?: number): void {
  transaction(registry, () => {
    const result = registry.database.prepare("UPDATE runs SET session_start_line=COALESCE(session_start_line,?),session_end_line=COALESCE(?,session_end_line) WHERE worker_id=? AND run_id=?")
      .run(nullable(startLine), nullable(endLine), workerId, runId);
    if (Number(result.changes) !== 1) throw new Error(`Unknown worker run ${workerId}/${runId}.`);
  });
}

export function storePreparedSet(registry: WorkerRegistry, input: { preparedId: string; parentSessionFile: string; status: string; order: string[]; warnings?: string[]; repositories: Array<{ id: string } & Record<string, unknown>>; createdAt: string }): void {
  transaction(registry, () => {
    registry.database.prepare("INSERT INTO prepared_sets(prepared_id,parent_session_file,status,order_json,warnings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(input.preparedId, canonicalSessionFile(input.parentSessionFile), input.status, json(input.order), json(input.warnings ?? []), input.createdAt, input.createdAt);
    const insert = registry.database.prepare("INSERT INTO prepared_repositories(prepared_id,repository_id,record_json) VALUES(?,?,?)");
    for (const repository of input.repositories) insert.run(input.preparedId, repository.id, json(repository));
  });
}

export type TrustedPreparedSetRecord = { version: 1; preparedId: string; parentSessionFile: string; status: "ready" | "resolution_required" | "consumed" | "completed" | "partial" | "failed" | "superseded"; order: string[]; repositories: Array<{ id: string } & Record<string, any>>; createdAt: string };

export function readPreparedSetRecord(registry: WorkerRegistry, parentSessionFile: string, preparedId: string): TrustedPreparedSetRecord {
  return transaction(registry, () => {
    const set = registry.database.prepare("SELECT prepared_id,parent_session_file,status,order_json,created_at FROM prepared_sets WHERE prepared_id=? AND parent_session_file=?").get(preparedId, canonicalSessionFile(parentSessionFile)) as { prepared_id: string; parent_session_file: string; status: TrustedPreparedSetRecord["status"]; order_json: string; created_at: string } | undefined;
    if (!set) throw new Error(`Unknown prepared set ${preparedId}.`);
    const rows = registry.database.prepare("SELECT record_json FROM prepared_repositories WHERE prepared_id=? ORDER BY repository_id").all(preparedId) as Array<{ record_json: string }>;
    return { version: 1, preparedId: set.prepared_id, parentSessionFile: set.parent_session_file, status: set.status, order: parseJson<string[]>(set.order_json), repositories: rows.map((row) => parseJson<any>(row.record_json)), createdAt: set.created_at };
  });
}

export function claimPreparedSetApply(registry: WorkerRegistry, preparedId: string, parentSessionFile: string, nonce: string, now: string): boolean {
  return transaction(registry, () => Number(registry.database.prepare("UPDATE prepared_sets SET apply_nonce=?,updated_at=? WHERE prepared_id=? AND parent_session_file=? AND apply_nonce IS NULL AND status IN ('ready','partial','failed')").run(nonce, now, preparedId, parentSessionFile).changes) === 1);
}

export function finishPreparedSetApply(registry: WorkerRegistry, preparedId: string, parentSessionFile: string, nonce: string, status: "completed" | "partial" | "failed", now: string): void {
  transaction(registry, () => { const result = registry.database.prepare("UPDATE prepared_sets SET status=?,apply_nonce=NULL,updated_at=? WHERE prepared_id=? AND parent_session_file=? AND apply_nonce=?").run(status, now, preparedId, parentSessionFile, nonce); if (Number(result.changes) !== 1) throw new Error(`Prepared set ${preparedId} apply authority changed.`); });
}

export function releasePreparedSetApply(registry: WorkerRegistry, preparedId: string, parentSessionFile: string, nonce: string, now: string): void {
  transaction(registry, () => { registry.database.prepare("UPDATE prepared_sets SET apply_nonce=NULL,updated_at=? WHERE prepared_id=? AND parent_session_file=? AND apply_nonce=?").run(now, preparedId, parentSessionFile, nonce); });
}

export function updatePreparedSetStatus(registry: WorkerRegistry, preparedId: string, parentSessionFile: string, status: string, now: string): void {
  transaction(registry, () => {
    const result = registry.database.prepare("UPDATE prepared_sets SET status=?,updated_at=? WHERE prepared_id=? AND parent_session_file=? AND apply_nonce IS NULL").run(status, now, preparedId, parentSessionFile);
    if (Number(result.changes) !== 1) throw new Error(`Unknown prepared set ${preparedId}.`);
  });
}

export function clearWorkerRecoveryError(registry: WorkerRegistry, workerId: string, runId: string, now: string): void {
  transaction(registry, () => { registry.database.prepare("UPDATE workers SET recovery_error=NULL,updated_at=? WHERE worker_id=? AND active_run_id=?").run(now, workerId, runId); });
}

export function recoverInterruptedClaimsForParent(registry: WorkerRegistry, parentSessionFile: string, runtimeGeneration: number, now: string): void {
  transaction(registry, () => {
    const currentPrefix = `${runtimeGeneration}-%`;
    const claimed = registry.database.prepare(`SELECT w.worker_id,w.active_run_id,r.claim_kind,r.claim_nonce FROM workers w JOIN runs r ON r.run_id=w.active_run_id WHERE w.parent_session_file=? AND r.claim_kind IS NOT NULL AND (r.claim_nonce IS NULL OR r.claim_nonce NOT LIKE ?)`).all(parentSessionFile, currentPrefix) as Array<{ worker_id: string; active_run_id: string; claim_kind: string; claim_nonce?: string }>;
    for (const item of claimed) {
      registry.database.prepare("UPDATE runs SET claim_kind=NULL,claim_nonce=NULL WHERE run_id=? AND worker_id=? AND claim_kind=? AND claim_nonce IS ?").run(item.active_run_id, item.worker_id, item.claim_kind, item.claim_nonce ?? null);
      if (item.claim_kind === "cancellation") registry.database.prepare("UPDATE workers SET recovery_error=?,version=version+1,updated_at=? WHERE worker_id=?").run("Interrupted cancellation claim is ready for an exact cancellation retry.", now, item.worker_id);
    }
    registry.database.prepare("UPDATE workers SET operation_kind=NULL,operation_nonce=NULL,recovery_error=COALESCE(recovery_error,'Interrupted discard claim is ready for an exact discard retry.'),version=version+1,updated_at=? WHERE parent_session_file=? AND operation_kind='discard' AND (operation_nonce IS NULL OR operation_nonce NOT LIKE ?)").run(now, parentSessionFile, currentPrefix);
    registry.database.prepare("UPDATE prepared_sets SET apply_nonce=NULL,updated_at=? WHERE parent_session_file=? AND apply_nonce IS NOT NULL AND apply_nonce NOT LIKE ?").run(now, parentSessionFile, currentPrefix);
  });
}

export function reconcileWorkerDeliveries(registry: WorkerRegistry, parentSessionFile: string, deliveredIds: string[]): void {
  transaction(registry, () => {
    const mark = registry.database.prepare("UPDATE deliveries SET state='delivered',delivered_at=COALESCE(delivered_at,?) WHERE parent_session_file=? AND delivery_id=?");
    const now = new Date().toISOString();
    for (const deliveryId of deliveredIds) mark.run(now, parentSessionFile, deliveryId);
    registry.database.prepare("UPDATE deliveries SET state='pending',runtime_generation=NULL WHERE parent_session_file=? AND state='claimed'").run(parentSessionFile);
  });
}

export type WorkerBatchCreateItem =
  | { kind: "new"; worker: Omit<WorkerRegistryRecord, "version">; run: WorkerRunRecord }
  | { kind: "resume"; workerId: string; expectedVersion: number; taskIds: string[]; runtime?: Record<string, unknown>; run: WorkerRunRecord };
export type WorkerReviewLeaseClaim = { subjectWorkerId: string; reviewerWorkerId: string; reviewedRunId: string };

/** Atomically publishes a fully provisioned independent batch as launchable queued runs. */
export function createWorkerRunBatch(registry: WorkerRegistry, input: {
  items: WorkerBatchCreateItem[];
  reviewLeases?: WorkerReviewLeaseClaim[];
  consumedPrepared?: Array<{ preparedId: string; parentSessionFile: string }>;
  now: string;
}): void {
  transaction(registry, () => {
    for (const lease of input.reviewLeases ?? []) {
      const result = registry.database.prepare(`UPDATE workers SET reviewed_by_worker_id=?,version=version+1,updated_at=?
        WHERE worker_id=? AND status='idle' AND (reviewed_by_worker_id IS NULL OR reviewed_by_worker_id=?) AND latest_run_id=? AND role IN ('work','integration')`)
        .run(lease.reviewerWorkerId, input.now, lease.subjectWorkerId, lease.reviewerWorkerId, lease.reviewedRunId);
      if (Number(result.changes) !== 1) throw new Error(`Worker ${lease.subjectWorkerId} is not available for review of ${lease.reviewedRunId}.`);
    }
    for (const prepared of input.consumedPrepared ?? []) {
      const result = registry.database.prepare("UPDATE prepared_sets SET status='consumed',updated_at=? WHERE prepared_id=? AND parent_session_file=? AND status='resolution_required'")
        .run(input.now, prepared.preparedId, prepared.parentSessionFile);
      if (Number(result.changes) !== 1) throw new Error(`Prepared set ${prepared.preparedId} is not available for integration.`);
    }
    for (const item of input.items) {
      if (item.kind === "new") insertWorker(registry, item.worker);
      else {
        const update = registry.database.prepare(`UPDATE workers SET status='queued',active_run_id=?,task_ids_json=?,runtime_json=?,recovery_error=NULL,version=version+1,updated_at=?
          WHERE worker_id=? AND version=? AND status='idle' AND operation_kind IS NULL`)
          .run(item.run.runId, json(item.taskIds), json(item.runtime ?? {}), input.now, item.workerId, item.expectedVersion);
        if (Number(update.changes) !== 1) throw staleWorker(item.workerId);
      }
      insertRun(registry, item.run);
    }
  });
}

export function claimWorkerRun(registry: WorkerRegistry, workerId: string, runId: string, kind: "launch" | "settlement" | "cancellation", nonce: string, allowed: WorkerRunStatus[]): boolean {
  return transaction(registry, () => {
    const placeholders = allowed.map(() => "?").join(",");
    const result = registry.database.prepare(`UPDATE runs SET claim_kind=?,claim_nonce=? WHERE worker_id=? AND run_id=? AND claim_kind IS NULL AND status IN (${placeholders})`)
      .run(kind, nonce, workerId, runId, ...allowed);
    return Number(result.changes) === 1;
  });
}

export function releaseWorkerRunClaim(registry: WorkerRegistry, workerId: string, runId: string, kind: "launch" | "settlement" | "cancellation", nonce: string): boolean {
  return transaction(registry, () => Number(registry.database.prepare("UPDATE runs SET claim_kind=NULL,claim_nonce=NULL WHERE worker_id=? AND run_id=? AND claim_kind=? AND claim_nonce=?")
    .run(workerId, runId, kind, nonce).changes) === 1);
}

export function finalizeWorkerRunLaunch(registry: WorkerRegistry, input: {
  workerId: string; runId: string; claimNonce: string; modelSelection: string; sessionId: string; sessionFile: string;
  sessionStartLine: number; jobId: string; stdoutLog: string; stderrLog: string; runtime: Record<string, unknown>; startedAt: string;
}): void {
  transaction(registry, () => {
    const run = registry.database.prepare(`UPDATE runs SET status='running',model_selection=?,job_id=?,stdout_log=?,stderr_log=?,session_start_line=?,runtime_json=?,started_at=?,claim_kind=NULL,claim_nonce=NULL
      WHERE worker_id=? AND run_id=? AND status='queued' AND claim_kind='launch' AND claim_nonce=?`)
      .run(input.modelSelection, input.jobId, input.stdoutLog, input.stderrLog, input.sessionStartLine, json(input.runtime), input.startedAt, input.workerId, input.runId, input.claimNonce);
    const worker = registry.database.prepare(`UPDATE workers SET status='running',model_selection=?,session_id=?,session_file=?,version=version+1,updated_at=?
      WHERE worker_id=? AND active_run_id=? AND status='queued'`)
      .run(input.modelSelection, input.sessionId, input.sessionFile, input.startedAt, input.workerId, input.runId);
    if (Number(run.changes) !== 1 || Number(worker.changes) !== 1) throw staleRun(input.workerId, input.runId);
  });
}

export function finalizeClaimedWorkerRun(registry: WorkerRegistry, input: {
  parentSessionFile: string; workerId: string; runId: string; claimKind: "launch" | "settlement" | "cancellation"; claimNonce: string;
  outcome: WorkerOutcome; outcomeSource: WorkerOutcomeSource; summary?: string; question?: string; repositories?: WorkerRepositoryResult[];
  artifacts?: string[]; errors?: WorkerScopedError[]; sessionStartLine?: number; sessionEndLine?: number; settledAt: string;
}): string {
  return transaction(registry, () => {
    const current = readRunRow(registry, input.runId);
    if (current.worker_id !== input.workerId || current.status === "settled" || current.claim_kind !== input.claimKind || current.claim_nonce !== input.claimNonce) throw staleRun(input.workerId, input.runId);
    const deliveryId = `worker-run:${input.workerId}:${input.runId}`;
    const run = registry.database.prepare(`UPDATE runs SET status='settled',outcome=?,outcome_source=?,summary=?,question=?,repositories_json=?,artifacts_json=?,errors_json=?,session_start_line=COALESCE(session_start_line,?),session_end_line=?,settled_at=?,claim_kind=NULL,claim_nonce=NULL
      WHERE worker_id=? AND run_id=? AND status IN ('queued','running') AND claim_kind=? AND claim_nonce=?`)
      .run(input.outcome, input.outcomeSource, nullable(input.summary), nullable(input.question), json(input.repositories ?? []), json(input.artifacts ?? []), json(input.errors ?? []), nullable(input.sessionStartLine), nullable(input.sessionEndLine), input.settledAt, input.workerId, input.runId, input.claimKind, input.claimNonce);
    const worker = registry.database.prepare(`UPDATE workers SET status='idle',active_run_id=NULL,latest_run_id=?,recovery_error=NULL,version=version+1,updated_at=? WHERE worker_id=? AND active_run_id=?`)
      .run(input.runId, input.settledAt, input.workerId, input.runId);
    if (Number(run.changes) !== 1 || Number(worker.changes) !== 1) throw staleRun(input.workerId, input.runId);
    if (current.binding_json) {
      const binding = parseJson<WorkerBinding>(current.binding_json);
      if ("reviewedWorkerId" in binding && (input.outcome !== "needs_input" && input.outcome !== "blocked" || input.outcomeSource === "system")) {
        registry.database.prepare("UPDATE workers SET reviewed_by_worker_id=NULL,version=version+1,updated_at=? WHERE worker_id=? AND reviewed_by_worker_id=?")
          .run(input.settledAt, binding.reviewedWorkerId, input.workerId);
      }
    }
    registry.database.prepare(`INSERT INTO deliveries(delivery_id,parent_session_file,worker_id,run_id,completion_delivery,state,created_at) VALUES(?,?,?,?,?,'pending',?)`)
      .run(deliveryId, input.parentSessionFile, input.workerId, input.runId, current.completion_delivery, input.settledAt);
    return deliveryId;
  });
}


export function claimWorkerDiscard(registry: WorkerRegistry, workerId: string, expectedVersion: number, nonce: string, now: string): WorkerRunRecord | undefined {
  return transaction(registry, () => {
    const worker = getWorker(registry, workerId);
    if (!worker || worker.version !== expectedVersion || worker.status !== "idle" || worker.reviewedByWorkerId || worker.operationKind) throw staleWorker(workerId);
    const changed = registry.database.prepare("UPDATE workers SET operation_kind='discard',operation_nonce=?,version=version+1,updated_at=? WHERE worker_id=? AND version=? AND status='idle' AND reviewed_by_worker_id IS NULL AND operation_kind IS NULL")
      .run(nonce, now, workerId, expectedVersion);
    if (Number(changed.changes) !== 1) throw staleWorker(workerId);
    return worker.latestRunId ? getWorkerRun(registry, workerId, worker.latestRunId) : undefined;
  });
}

export function finalizeWorkerDiscard(registry: WorkerRegistry, workerId: string, nonce: string): void {
  transaction(registry, () => {
    const row = registry.database.prepare("SELECT latest_run_id FROM workers WHERE worker_id=? AND operation_kind='discard' AND operation_nonce=?").get(workerId, nonce) as { latest_run_id: string | null } | undefined;
    if (!row) throw staleWorker(workerId);
    if (row.latest_run_id) {
      const run = readRunRow(registry, row.latest_run_id);
      if (run.binding_json) {
        const binding = parseJson<WorkerBinding>(run.binding_json);
        if ("reviewedWorkerId" in binding) registry.database.prepare("UPDATE workers SET reviewed_by_worker_id=NULL,version=version+1 WHERE worker_id=? AND reviewed_by_worker_id=?").run(binding.reviewedWorkerId, workerId);
        else registry.database.prepare("DELETE FROM prepared_sets WHERE prepared_id=? AND status='consumed'").run(binding.preparedId);
      }
    }
    const result = registry.database.prepare("DELETE FROM workers WHERE worker_id=? AND operation_kind='discard' AND operation_nonce=?").run(workerId, nonce);
    if (Number(result.changes) !== 1) throw staleWorker(workerId);
  });
}

export function abandonWorkerDiscard(registry: WorkerRegistry, workerId: string, nonce: string, error: string, now: string): void {
  transaction(registry, () => registry.database.prepare("UPDATE workers SET operation_kind=NULL,operation_nonce=NULL,recovery_error=?,version=version+1,updated_at=? WHERE worker_id=? AND operation_kind='discard' AND operation_nonce=?")
    .run(error.slice(0, 2048), now, workerId, nonce));
}

export function countWorkers(registry: WorkerRegistry, parentSessionFile: string): { idle: number; queued: number; running: number } {
  const rows = registry.database.prepare("SELECT status,COUNT(*) AS count FROM workers WHERE parent_session_file=? GROUP BY status").all(parentSessionFile) as Array<{ status: WorkerStatus; count: number }>;
  const result = { idle: 0, queued: 0, running: 0 };
  for (const row of rows) result[row.status] = Number(row.count);
  return result;
}

export function findWorkerRunById(registry: WorkerRegistry, runId: string): { worker: WorkerRegistryRecord; run: WorkerRunRecord } | undefined {
  const row = registry.database.prepare("SELECT worker_id FROM runs WHERE run_id=?").get(runId) as { worker_id: string } | undefined;
  if (!row) return undefined;
  const worker = getWorker(registry, row.worker_id); const run = getWorkerRun(registry, row.worker_id, runId);
  return worker && run ? { worker, run } : undefined;
}

function insertWorker(registry: WorkerRegistry, worker: Omit<WorkerRegistryRecord, "version">): void {
  registry.database.prepare(`INSERT INTO workers(worker_id,parent_session_file,role,status,active_run_id,latest_run_id,task_ids_json,model_selection,session_id,session_file,workspace_root,recovery_error,reviewed_by_worker_id,runtime_json,operation_kind,operation_nonce,version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(
    worker.workerId, canonicalSessionFile(worker.parentSessionFile), worker.role, worker.status, nullable(worker.activeRunId), nullable(worker.latestRunId), json(worker.taskIds), nullable(worker.modelSelection), nullable(worker.sessionId), nullable(worker.sessionFile), worker.workspaceRoot, nullable(worker.recoveryError), nullable(worker.reviewedByWorkerId), json(worker.runtime ?? {}), nullable(worker.operationKind), nullable(worker.operationNonce), worker.createdAt, worker.updatedAt
  );
}

export function claimWorkerCancellation(registry: WorkerRegistry, workerId: string, runId: string, nonce: string, now: string): boolean {
  return transaction(registry, () => {
    const worker = registry.database.prepare("SELECT recovery_error FROM workers WHERE worker_id=? AND active_run_id=? AND status IN ('queued','running')").get(workerId, runId) as { recovery_error: string | null } | undefined;
    if (!worker) return false;
    const result = worker.recovery_error
      ? registry.database.prepare("UPDATE runs SET claim_kind='cancellation',claim_nonce=? WHERE worker_id=? AND run_id=? AND status IN ('queued','running')").run(nonce, workerId, runId)
      : registry.database.prepare("UPDATE runs SET claim_kind='cancellation',claim_nonce=? WHERE worker_id=? AND run_id=? AND status IN ('queued','running') AND (claim_kind IS NULL OR claim_kind='launch')").run(nonce, workerId, runId);
    if (Number(result.changes) === 1) registry.database.prepare("UPDATE workers SET updated_at=? WHERE worker_id=?").run(now, workerId);
    return Number(result.changes) === 1;
  });
}

export function activeRunsForParent(registry: WorkerRegistry, parentSessionFile: string): Array<{ worker: WorkerRegistryRecord; run: WorkerRunRecord }> {
  const rows = registry.database.prepare("SELECT worker_id,active_run_id FROM workers WHERE parent_session_file=? AND active_run_id IS NOT NULL ORDER BY created_at,worker_id").all(parentSessionFile) as Array<{ worker_id: string; active_run_id: string }>;
  return rows.flatMap((row) => { const worker = getWorker(registry, row.worker_id); const run = getWorkerRun(registry, row.worker_id, row.active_run_id); return worker && run ? [{ worker, run }] : []; });
}
