import { chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync as SQLiteDatabaseSync, SQLInputValue } from "node:sqlite";
import { CURRENT_WORKER_STORAGE_LAYOUT, defaultWorkerRuntimeRoot, type WorkerStorageLayout } from "./identity.js";

export const WORKER_REGISTRY_SCHEMA_VERSION = 10;
export const DEFAULT_WORKER_RUNTIME_ROOT = defaultWorkerRuntimeRoot();

export type WorkerRole = "work" | "review" | "integration";
export type WorkerStatus = "idle" | "queued" | "running";
export type WorkerRunStatus = "queued" | "running" | "settled";
export type WorkerTerminalIntent = "cancellation" | "failure";
export type ParentRuntimeIdentity = { runtimeId: string; pid: number; processStartToken: string };
export type ParentRuntimeMember = ParentRuntimeIdentity & { generation: number; retired: boolean };
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
  storageLayout: WorkerStorageLayout;
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
  terminalIntent?: WorkerTerminalIntent;
  terminalError?: string;
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
  sendStartedAt?: string;
  deliveredAt?: string;
};

export type WorkerRegistry = {
  database: SQLiteDatabaseSync;
  databasePath: string;
  close(): void;
};

type WorkerRegistryChangeListener = () => void;
type WorkerRegistryActivityHolder = { version: 1; listeners: Set<WorkerRegistryChangeListener> };
const WORKER_REGISTRY_ACTIVITY_HOLDER_KEY = Symbol.for("@akoumjian/pi-tools/worker-registry-activity");

function workerRegistryActivityHolder(): WorkerRegistryActivityHolder {
  const existing = Reflect.get(globalThis, WORKER_REGISTRY_ACTIVITY_HOLDER_KEY) as WorkerRegistryActivityHolder | undefined;
  if (existing !== undefined) {
    if (existing.version !== 1 || !(existing.listeners instanceof Set)) throw new Error("Incompatible worker-registry activity holder.");
    return existing;
  }
  const created: WorkerRegistryActivityHolder = { version: 1, listeners: new Set() };
  Reflect.set(globalThis, WORKER_REGISTRY_ACTIVITY_HOLDER_KEY, created);
  return created;
}

const workerRegistryChangeListeners = workerRegistryActivityHolder().listeners;

export function subscribeWorkerRegistryChanges(listener: WorkerRegistryChangeListener): () => void {
  workerRegistryChangeListeners.add(listener);
  return () => workerRegistryChangeListeners.delete(listener);
}

function notifyWorkerRegistryChanges(): void {
  for (const listener of workerRegistryChangeListeners) {
    try { listener(); } catch { /* Observational UI listeners never affect committed lifecycle state. */ }
  }
}

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
  storage_layout INTEGER NOT NULL DEFAULT 2 CHECK (storage_layout IN (1,2)),
  recovery_error TEXT,
  reviewed_by_worker_id TEXT,
  runtime_json TEXT NOT NULL DEFAULT '{}',
  operation_kind TEXT CHECK (operation_kind IS NULL OR operation_kind IN ('discard')),
  operation_nonce TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS workers_require_current_layout_insert
BEFORE INSERT ON workers WHEN NEW.storage_layout != 2
BEGIN SELECT RAISE(ABORT, 'new workers require current storage layout'); END;
CREATE TRIGGER IF NOT EXISTS workers_refuse_legacy_resume
BEFORE UPDATE OF status,active_run_id,recovery_error,operation_kind ON workers
WHEN OLD.storage_layout = 1 AND NEW.recovery_error IS NULL AND COALESCE(NEW.operation_kind, '') != 'discard'
BEGIN SELECT RAISE(ABORT, 'legacy worker storage cannot resume'); END;
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
  terminal_intent TEXT CHECK (terminal_intent IS NULL OR terminal_intent IN ('cancellation','failure')),
  terminal_error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  settled_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS runs_worker_created ON runs(worker_id, created_at DESC, run_id DESC);
CREATE TRIGGER IF NOT EXISTS runs_refuse_legacy_launch
BEFORE UPDATE OF status,claim_kind ON runs WHEN (NEW.status = 'running' OR NEW.claim_kind = 'launch') AND EXISTS (
  SELECT 1 FROM workers WHERE worker_id = NEW.worker_id AND storage_layout = 1
)
BEGIN SELECT RAISE(ABORT, 'legacy worker storage cannot launch'); END;
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  parent_session_file TEXT NOT NULL,
  worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  completion_delivery TEXT NOT NULL CHECK (completion_delivery IN ('steer','followUp')),
  state TEXT NOT NULL CHECK (state IN ('pending','claimed','delivered')),
  runtime_generation INTEGER,
  created_at TEXT NOT NULL,
  send_started_at TEXT,
  delivered_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS deliveries_parent_state ON deliveries(parent_session_file, state, created_at);
CREATE TABLE IF NOT EXISTS parent_runtimes (
  parent_session_file TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  runtime_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS parent_runtime_members (
  parent_session_file TEXT NOT NULL,
  generation INTEGER NOT NULL,
  runtime_id TEXT NOT NULL,
  owner_pid INTEGER,
  owner_start_token TEXT,
  registered_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (parent_session_file, generation)
) STRICT;
CREATE INDEX IF NOT EXISTS parent_runtime_members_latest ON parent_runtime_members(parent_session_file, runtime_id, generation DESC);
CREATE TABLE IF NOT EXISTS prepared_sets (
  prepared_id TEXT PRIMARY KEY,
  parent_session_file TEXT NOT NULL,
  status TEXT NOT NULL,
  order_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  task_ids_json TEXT NOT NULL DEFAULT '[]',
  apply_nonce TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS preservation_records (
  preservation_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(worker_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','published','failed')),
  destination TEXT NOT NULL,
  temp_path TEXT NOT NULL,
  latest_run_id TEXT,
  items_json TEXT NOT NULL,
  manifest_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS preservation_records_worker ON preservation_records(worker_id, created_at DESC);
CREATE TABLE IF NOT EXISTS cleanup_snapshots (
  token TEXT PRIMARY KEY,
  parent_session_file TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS cleanup_snapshots_parent ON cleanup_snapshots(parent_session_file, created_at DESC);
CREATE TABLE IF NOT EXISTS cleanup_scan_cursors (
  token TEXT PRIMARY KEY,
  parent_session_file TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS cleanup_scan_cursors_parent ON cleanup_scan_cursors(parent_session_file, created_at DESC);
CREATE TABLE IF NOT EXISTS cleanup_leftover_observations (
  leftover_id TEXT PRIMARY KEY,
  record_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS cleanup_leftover_claims (
  claim_id TEXT PRIMARY KEY,
  source_leftover_id TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('worker_root','worker_trash','prepared_root','worker_host_log')),
  original_id TEXT NOT NULL,
  entry_name TEXT NOT NULL,
  source_path TEXT NOT NULL UNIQUE,
  trash_path TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  device INTEGER NOT NULL,
  inode INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_start_token TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS cleanup_leftover_claims_root ON cleanup_leftover_claims(root_path, trash_path);
CREATE TABLE IF NOT EXISTS prepared_repositories (
  prepared_id TEXT NOT NULL REFERENCES prepared_sets(prepared_id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (prepared_id, repository_id)
) STRICT;
`;

const WORKER_REGISTRY_SCHEMA_HASH = createHash("sha256").update(SCHEMA).digest("hex");

export type OpenWorkerRegistryOptions = { strictCurrentRoot?: boolean };

const REGISTRY_INITIALIZATION_WAIT_MS = 5_000;
const REGISTRY_INITIALIZATION_POLL_MS = 10;
const registryInitializationWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export function openWorkerRegistry(runtimeRoot = DEFAULT_WORKER_RUNTIME_ROOT, options: OpenWorkerRegistryOptions = {}): WorkerRegistry {
  const exactRoot = path.resolve(runtimeRoot);
  const strictCurrentRoot = options.strictCurrentRoot ?? exactRoot === path.resolve(DEFAULT_WORKER_RUNTIME_ROOT);
  const rootExisted = existsSync(exactRoot);
  if (rootExisted) {
    const metadata = lstatSync(exactRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Managed-worker current runtime root is not an ordinary directory: ${exactRoot}.`);
    }
  }
  const databasePath = path.join(exactRoot, "registry.sqlite");
  let databaseExisted = existsSync(databasePath);
  if (!databaseExisted && strictCurrentRoot && rootExisted) {
    const entries = readdirSync(exactRoot);
    if (entries.length > 0) {
      // A first opener can create SQLite files between the initial existence
      // check and this directory read. Accept only that bounded race shape;
      // every unrelated entry still makes the current root unexpected.
      const allowed = new Set(["registry.sqlite", "registry.sqlite-journal", "registry.sqlite-wal", "registry.sqlite-shm"]);
      if (!existsSync(databasePath) || entries.some((entry) => !allowed.has(entry))) {
        throw new Error(`Managed-worker current runtime root is partial or unexpected: ${exactRoot}. Archive or remove this new versioned root before retrying; the legacy root is not inspected.`);
      }
      databaseExisted = true;
    }
  }
  mkdirSync(exactRoot, { recursive: true, mode: 0o700 });
  chmodSync(exactRoot, 0o700);
  let claimedNewDatabase = false;
  if (!databaseExisted) {
    try {
      const descriptor = openSync(databasePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o600);
      closeSync(descriptor);
      claimedNewDatabase = true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      databaseExisted = true;
    }
  }
  const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!sqlite) throw new Error("Managed workers require the Node node:sqlite builtin.");
  const database = new sqlite.DatabaseSync(databasePath);
  let transactionOpen = false;
  try {
    // Connection-local only: this must precede even read-only schema probes so
    // concurrent first openers wait through the initializer's journal lock.
    database.exec("PRAGMA busy_timeout = 5000");
    const initializationDeadline = Date.now() + REGISTRY_INITIALIZATION_WAIT_MS;
    let hasMetadata = registryHasMetadata(database, initializationDeadline);
    if (!claimedNewDatabase && !hasMetadata) {
      // O_EXCL identifies the initializer without writing a marker. A loser may
      // observe the empty database before that initializer opens SQLite, so only
      // poll for its committed authority; never initialize or repair on its behalf.
      while (!hasMetadata && Date.now() < initializationDeadline) {
        Atomics.wait(registryInitializationWait, 0, 0, REGISTRY_INITIALIZATION_POLL_MS);
        hasMetadata = registryHasMetadata(database, initializationDeadline);
      }
      if (!hasMetadata) {
        throw new Error(`Managed-worker current registry is partial or has no schema authority: ${databasePath}. No migration or repair is attempted.`);
      }
    }
    if (hasMetadata) assertExactCurrentRegistry(database, sqlite);

    chmodSync(databasePath, 0o600);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const metadataAfterLock = registryHasMetadata(database, Date.now());
    if (!metadataAfterLock) {
      if (!claimedNewDatabase) {
        throw new Error(`Managed-worker current registry lost schema authority: ${databasePath}. No migration or repair is attempted.`);
      }
      database.exec(SCHEMA);
      database.prepare("INSERT INTO registry_meta(key,value) VALUES('schema_version',?)").run(String(WORKER_REGISTRY_SCHEMA_VERSION));
      database.prepare("INSERT INTO registry_meta(key,value) VALUES('schema_hash',?)").run(WORKER_REGISTRY_SCHEMA_HASH);
      database.prepare("INSERT INTO registry_meta(key,value) VALUES(?,?)").run(`schema_hash_v${WORKER_REGISTRY_SCHEMA_VERSION}`, WORKER_REGISTRY_SCHEMA_HASH);
      database.exec(`PRAGMA user_version = ${WORKER_REGISTRY_SCHEMA_VERSION}`);
    } else if (!hasMetadata) {
      // Defensive only: another exact-schema process cannot initialize a file
      // exclusively claimed by this opener, but external interference still
      // must be accepted only when it produced the exact current schema.
      assertExactCurrentRegistry(database, sqlite);
    }
    database.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec("ROLLBACK"); } catch {}
    }
    database.close();
    throw error;
  }
  return { database, databasePath, close: () => database.close() };
}

function registryHasMetadata(database: SQLiteDatabaseSync, deadline: number): boolean {
  for (;;) {
    try {
      return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registry_meta'").get());
    } catch (error) {
      const sqliteCode = error && typeof error === "object" && "errcode" in error ? error.errcode : undefined;
      if ((sqliteCode !== 5 && sqliteCode !== 6) || Date.now() >= deadline) throw error;
      Atomics.wait(registryInitializationWait, 0, 0, REGISTRY_INITIALIZATION_POLL_MS);
    }
  }
}

function assertExactCurrentRegistry(database: SQLiteDatabaseSync, sqlite: typeof import("node:sqlite")): void {
  let version: string | undefined; let schemaHash: string | undefined; let versionHash: string | undefined; let userVersion = -1;
  try {
    version = (database.prepare("SELECT value FROM registry_meta WHERE key='schema_version'").get() as { value?: string } | undefined)?.value;
    schemaHash = (database.prepare("SELECT value FROM registry_meta WHERE key='schema_hash'").get() as { value?: string } | undefined)?.value;
    versionHash = (database.prepare("SELECT value FROM registry_meta WHERE key=?").get(`schema_hash_v${WORKER_REGISTRY_SCHEMA_VERSION}`) as { value?: string } | undefined)?.value;
    userVersion = Number((database.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version);
  } catch (cause) {
    throw new Error(`Managed-worker current registry metadata is unreadable; no migration or repair is attempted: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (version !== String(WORKER_REGISTRY_SCHEMA_VERSION) || userVersion !== WORKER_REGISTRY_SCHEMA_VERSION || schemaHash !== WORKER_REGISTRY_SCHEMA_HASH || versionHash !== WORKER_REGISTRY_SCHEMA_HASH) throw new Error(`Managed-worker current registry must be exact schema ${WORKER_REGISTRY_SCHEMA_VERSION}; found metadata schema=${version ?? "missing"}, user_version=${userVersion}. No legacy migration or fallback is permitted.`);
  const expected = new sqlite.DatabaseSync(":memory:");
  try {
    expected.exec(SCHEMA);
    if (schemaCatalog(database) !== schemaCatalog(expected)) throw new Error(`Managed-worker current registry schema objects do not exactly match schema ${WORKER_REGISTRY_SCHEMA_VERSION}; no repair is attempted.`);
  } finally { expected.close(); }
  const quick = database.prepare("PRAGMA quick_check").all() as Array<{ quick_check?: string }>;
  if (quick.length !== 1 || quick[0]?.quick_check !== "ok") throw new Error("Managed-worker current registry failed SQLite quick_check; no repair is attempted.");
}

function schemaCatalog(database: SQLiteDatabaseSync): string {
  const rows = database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  return JSON.stringify(rows.map((row) => ({ type: row.type, name: row.name, table: row.tbl_name, sql: row.sql })));
}

export function workerRegistryDataVersion(registry: WorkerRegistry): number {
  const row = registry.database.prepare("PRAGMA data_version").get() as { data_version: number };
  return Number(row.data_version);
}

export function registerParentRuntime(registry: WorkerRegistry, parentSessionFile: string, runtimeId: string, now: string, owner?: Omit<ParentRuntimeIdentity, "runtimeId">): number {
  return transaction(registry, () => registerParentRuntimeInTransaction(registry, parentSessionFile, { runtimeId, ...(owner ?? {}) }, now));
}

function registerParentRuntimeInTransaction(registry: WorkerRegistry, parentSessionFile: string, identity: { runtimeId: string; pid?: number; processStartToken?: string }, now: string): number {
  const current = registry.database.prepare("SELECT generation FROM parent_runtimes WHERE parent_session_file = ?").get(parentSessionFile) as { generation: number } | undefined;
  const generation = (current?.generation ?? 0) + 1;
  registry.database.prepare(`INSERT INTO parent_runtimes(parent_session_file,generation,runtime_id,updated_at)
    VALUES(?,?,?,?) ON CONFLICT(parent_session_file) DO UPDATE SET generation=excluded.generation,runtime_id=excluded.runtime_id,updated_at=excluded.updated_at`)
    .run(parentSessionFile, generation, identity.runtimeId, now);
  registry.database.prepare(`INSERT INTO parent_runtime_members(parent_session_file,generation,runtime_id,owner_pid,owner_start_token,registered_at,retired_at)
    VALUES(?,?,?,?,?,?,NULL)`).run(parentSessionFile, generation, identity.runtimeId, nullable(identity.pid), nullable(identity.processStartToken), now);
  return generation;
}

export function currentParentRuntime(registry: WorkerRegistry, parentSessionFile: string): { generation: number; runtimeId: string } | undefined {
  return registry.database.prepare("SELECT generation,runtime_id AS runtimeId FROM parent_runtimes WHERE parent_session_file=?")
    .get(parentSessionFile) as { generation: number; runtimeId: string } | undefined;
}

export function parentRuntimeMemberForGeneration(registry: WorkerRegistry, parentSessionFile: string, generation: number): ParentRuntimeMember | undefined {
  const row = registry.database.prepare(`SELECT generation,runtime_id,owner_pid,owner_start_token,retired_at FROM parent_runtime_members
    WHERE parent_session_file=? AND generation=?`).get(parentSessionFile, generation) as { generation: number; runtime_id: string; owner_pid: number | null; owner_start_token: string | null; retired_at: string | null } | undefined;
  return row === undefined ? undefined : { generation: row.generation, runtimeId: row.runtime_id, pid: row.owner_pid ?? 0, processStartToken: row.owner_start_token ?? "", retired: row.retired_at !== null };
}

export function latestParentRuntimeMembers(registry: WorkerRegistry, parentSessionFile: string, afterGeneration: number, throughGeneration: number): ParentRuntimeMember[] {
  const rows = registry.database.prepare(`SELECT m.generation,m.runtime_id,m.owner_pid,m.owner_start_token,m.retired_at
    FROM parent_runtime_members m
    WHERE m.parent_session_file=? AND m.generation>? AND m.generation<=?
      AND m.generation=(SELECT MAX(n.generation) FROM parent_runtime_members n WHERE n.parent_session_file=m.parent_session_file AND n.runtime_id=m.runtime_id)
    ORDER BY m.generation DESC`).all(parentSessionFile, afterGeneration, throughGeneration) as Array<{ generation: number; runtime_id: string; owner_pid: number | null; owner_start_token: string | null; retired_at: string | null }>;
  return rows.map((row) => ({ generation: row.generation, runtimeId: row.runtime_id, pid: row.owner_pid ?? 0, processStartToken: row.owner_start_token ?? "", retired: row.retired_at !== null }));
}

export function promoteParentRuntime(registry: WorkerRegistry, input: { parentSessionFile: string; expectedGeneration: number; expectedRuntimeId: string; identity: ParentRuntimeIdentity; now: string }): number | undefined {
  return transaction(registry, () => {
    const member = registry.database.prepare(`SELECT retired_at FROM parent_runtime_members
      WHERE parent_session_file=? AND runtime_id=? ORDER BY generation DESC LIMIT 1`).get(input.parentSessionFile, input.identity.runtimeId) as { retired_at: string | null } | undefined;
    if (!member || member.retired_at !== null) return undefined;
    const next = input.expectedGeneration + 1;
    const updated = registry.database.prepare(`UPDATE parent_runtimes SET generation=?,runtime_id=?,updated_at=?
      WHERE parent_session_file=? AND generation=? AND runtime_id=?`).run(next, input.identity.runtimeId, input.now, input.parentSessionFile, input.expectedGeneration, input.expectedRuntimeId);
    if (Number(updated.changes) !== 1) return undefined;
    registry.database.prepare(`INSERT INTO parent_runtime_members(parent_session_file,generation,runtime_id,owner_pid,owner_start_token,registered_at,retired_at)
      VALUES(?,?,?,?,?,?,NULL)`).run(input.parentSessionFile, next, input.identity.runtimeId, input.identity.pid, input.identity.processStartToken, input.now);
    // The caller proved the exact superseded runtime dead or retired before the
    // generation CAS. Only a claim that had not crossed the send boundary is
    // safe to replay; a started send is intentionally left unconfirmed.
    registry.database.prepare(`UPDATE deliveries SET state='pending',runtime_generation=NULL
      WHERE parent_session_file=? AND state='claimed' AND runtime_generation=? AND send_started_at IS NULL`)
      .run(input.parentSessionFile, input.expectedGeneration);
    return next;
  });
}

export function retireParentRuntime(registry: WorkerRegistry, parentSessionFile: string, runtimeId: string, now: string): void {
  transaction(registry, () => {
    registry.database.prepare("UPDATE parent_runtime_members SET retired_at=COALESCE(retired_at,?) WHERE parent_session_file=? AND runtime_id=?")
      .run(now, parentSessionFile, runtimeId);
  });
}

export function parentRuntimeGenerationMatches(registry: WorkerRegistry, parentSessionFile: string, runtimeGeneration: number): boolean {
  const row = registry.database.prepare("SELECT generation FROM parent_runtimes WHERE parent_session_file=?").get(parentSessionFile) as { generation: number } | undefined;
  return row?.generation === runtimeGeneration;
}

export type NewWorkerRegistryRecord = Omit<WorkerRegistryRecord, "version" | "storageLayout"> & { storageLayout?: typeof CURRENT_WORKER_STORAGE_LAYOUT };

export function createWorkerAndRun(registry: WorkerRegistry, worker: NewWorkerRegistryRecord, run: WorkerRunRecord): void {
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
    registry.database.prepare(`UPDATE runs SET status='settled',outcome=?,outcome_source=?,summary=?,question=?,repositories_json=?,artifacts_json=?,errors_json=?,session_start_line=?,session_end_line=?,settled_at=?,claim_kind=NULL,claim_nonce=NULL,terminal_intent=NULL,terminal_error=NULL WHERE run_id=? AND status IN ('queued','running')`)
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

export function listAllWorkers(registry: WorkerRegistry, limitInput = 100, offsetInput = 0): { workers: WorkerRegistryRecord[]; total: number; nextOffset?: number } {
  const limit = Math.min(1000, Math.max(1, limitInput));
  const offset = Math.max(0, offsetInput);
  const total = Number((registry.database.prepare("SELECT COUNT(*) AS count FROM workers").get() as { count: number }).count);
  const rows = registry.database.prepare("SELECT * FROM workers ORDER BY parent_session_file,updated_at DESC,worker_id LIMIT ? OFFSET ?").all(limit, offset) as unknown as WorkerRow[];
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

export function getWorkerDeliveryForRun(registry: WorkerRegistry, workerId: string, runId: string): WorkerDeliveryRecord | undefined {
  const row = registry.database.prepare("SELECT * FROM deliveries WHERE worker_id=? AND run_id=?").get(workerId, runId) as DeliveryRow | undefined;
  return row === undefined ? undefined : decodeDelivery(row);
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

/** Releases an exact pre-send claim after its runtime member was proved dead. */
export function recoverProvablyDeadWorkerDeliveryClaim(registry: WorkerRegistry, input: { deliveryId: string; parentSessionFile: string; ownerGeneration: number; runtimeGeneration: number }): boolean {
  return transaction(registry, () => {
    if (!parentRuntimeGenerationMatches(registry, input.parentSessionFile, input.runtimeGeneration)) return false;
    const result = registry.database.prepare(`UPDATE deliveries SET state='pending',runtime_generation=NULL
      WHERE delivery_id=? AND parent_session_file=? AND state='claimed' AND runtime_generation=? AND send_started_at IS NULL`)
      .run(input.deliveryId, input.parentSessionFile, input.ownerGeneration);
    return Number(result.changes) === 1;
  });
}

export function releaseWorkerDeliveryClaim(registry: WorkerRegistry, deliveryId: string, runtimeGeneration: number): void {
  transaction(registry, () => {
    registry.database.prepare("UPDATE deliveries SET state='pending',runtime_generation=NULL WHERE delivery_id=? AND state='claimed' AND runtime_generation=? AND send_started_at IS NULL")
      .run(deliveryId, runtimeGeneration);
  });
}

/** Durably crosses the no-replay boundary immediately before sendMessage. */
export function markWorkerDeliverySendStarted(registry: WorkerRegistry, deliveryId: string, runtimeGeneration: number, now: string): boolean {
  return transaction(registry, () => {
    const result = registry.database.prepare(`UPDATE deliveries SET send_started_at=?
      WHERE delivery_id=? AND state='claimed' AND runtime_generation=? AND send_started_at IS NULL`)
      .run(now, deliveryId, runtimeGeneration);
    return Number(result.changes) === 1;
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
  registry.database.prepare(`INSERT INTO runs(run_id,worker_id,status,task_ids_json,model_selection,completion_delivery,binding_json,job_id,stdout_log,stderr_log,session_start_line,session_end_line,outcome,outcome_source,summary,question,repositories_json,artifacts_json,errors_json,runtime_json,claim_kind,claim_nonce,terminal_intent,terminal_error,created_at,started_at,settled_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    run.runId, run.workerId, run.status, json(run.taskIds), nullable(run.modelSelection), run.completionDelivery, run.binding === undefined ? null : json(run.binding), nullable(run.jobId), nullable(run.stdoutLog), nullable(run.stderrLog), nullable(run.sessionStartLine), nullable(run.sessionEndLine), nullable(run.outcome), nullable(run.outcomeSource), nullable(run.summary), nullable(run.question), json(run.repositories), json(run.artifacts), json(run.errors), json(run.runtime ?? {}), nullable(run.claimKind), nullable(run.claimNonce), nullable(run.terminalIntent), nullable(run.terminalError), run.createdAt, nullable(run.startedAt), nullable(run.settledAt)
  );
}

function transaction<T>(registry: WorkerRegistry, fn: () => T): T {
  registry.database.exec("BEGIN IMMEDIATE");
  try {
    assertSchema(registry);
    const value = fn();
    registry.database.exec("COMMIT");
    notifyWorkerRegistryChanges();
    return value;
  } catch (error) {
    registry.database.exec("ROLLBACK");
    throw error;
  }
}

function assertSchema(registry: WorkerRegistry): void {
  const row = registry.database.prepare("SELECT value FROM registry_meta WHERE key='schema_version'").get() as { value?: string } | undefined;
  const version = Number(row?.value);
  if (!Number.isSafeInteger(version) || version < 2 || version > WORKER_REGISTRY_SCHEMA_VERSION) throw new Error(`Unsupported worker registry schema ${row?.value ?? "missing"}.`);
}

function boundedPage(value: number | undefined): number {
  return Math.min(100, Math.max(1, value ?? 20));
}

function staleWorker(workerId: string): Error { return new Error(`Worker ${workerId} changed state; inspect it and retry.`); }
function staleRun(workerId: string, runId: string): Error { return new Error(`Worker ${workerId}/${runId} changed state; inspect it and retry.`); }
function json(value: unknown): string { return JSON.stringify(value); }
function canonicalSessionFile(value: string): string {
  const resolved = path.resolve(value); const suffix: string[] = []; let cursor = resolved;
  while (true) { try { return path.join(realpathSync(cursor), ...suffix); } catch { const parent = path.dirname(cursor); if (parent === cursor) return resolved; suffix.unshift(path.basename(cursor)); cursor = parent; } }
}

function nullable<T extends SQLInputValue>(value: T | undefined): T | null { return value ?? null; }
function parseJson<T>(text: string): T { return JSON.parse(text) as T; }

function readRunRow(registry: WorkerRegistry, runId: string): RunRow {
  const row = registry.database.prepare("SELECT * FROM runs WHERE run_id=?").get(runId) as RunRow | undefined;
  if (row === undefined) throw new Error(`Unknown worker run ${runId}.`);
  return row;
}

type WorkerRow = {
  worker_id: string; parent_session_file: string; role: WorkerRole; status: WorkerStatus; active_run_id: string | null; latest_run_id: string | null;
  task_ids_json: string; model_selection: string | null; session_id: string | null; session_file: string | null; workspace_root: string; storage_layout: WorkerStorageLayout;
  recovery_error: string | null; reviewed_by_worker_id: string | null; runtime_json: string; operation_kind: "discard" | null; operation_nonce: string | null; version: number; created_at: string; updated_at: string;
};
type RunRow = {
  run_id: string; worker_id: string; status: WorkerRunStatus; task_ids_json: string; model_selection: string | null; completion_delivery: "steer" | "followUp";
  binding_json: string | null; job_id: string | null; stdout_log: string | null; stderr_log: string | null; session_start_line: number | null; session_end_line: number | null;
  outcome: WorkerOutcome | null; outcome_source: WorkerOutcomeSource | null; summary: string | null; question: string | null; repositories_json: string; artifacts_json: string;
  errors_json: string; runtime_json: string; claim_kind: "launch" | "settlement" | "cancellation" | null; claim_nonce: string | null;
  terminal_intent: WorkerTerminalIntent | null; terminal_error: string | null; created_at: string; started_at: string | null; settled_at: string | null;
};
type DeliveryRow = {
  delivery_id: string; parent_session_file: string; worker_id: string; run_id: string; completion_delivery: "steer" | "followUp"; state: "pending" | "claimed" | "delivered";
  runtime_generation: number | null; created_at: string; send_started_at: string | null; delivered_at: string | null;
};

function decodeWorker(row: WorkerRow): WorkerRegistryRecord {
  return {
    workerId: row.worker_id, parentSessionFile: row.parent_session_file, role: row.role, status: row.status,
    ...(row.active_run_id === null ? {} : { activeRunId: row.active_run_id }), ...(row.latest_run_id === null ? {} : { latestRunId: row.latest_run_id }),
    taskIds: parseJson<string[]>(row.task_ids_json), ...(row.model_selection === null ? {} : { modelSelection: row.model_selection }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }), ...(row.session_file === null ? {} : { sessionFile: row.session_file }),
    workspaceRoot: row.workspace_root, storageLayout: row.storage_layout, ...(row.recovery_error === null ? {} : { recoveryError: row.recovery_error }), ...(row.reviewed_by_worker_id === null ? {} : { reviewedByWorkerId: row.reviewed_by_worker_id }), runtime: parseJson<Record<string, unknown>>(row.runtime_json), ...(row.operation_kind === null ? {} : { operationKind: row.operation_kind }), ...(row.operation_nonce === null ? {} : { operationNonce: row.operation_nonce }), version: row.version,
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
    ...(row.terminal_intent === null ? {} : { terminalIntent: row.terminal_intent }), ...(row.terminal_error === null ? {} : { terminalError: row.terminal_error }),
    createdAt: row.created_at, ...(row.started_at === null ? {} : { startedAt: row.started_at }), ...(row.settled_at === null ? {} : { settledAt: row.settled_at })
  };
}
function decodeDelivery(row: DeliveryRow): WorkerDeliveryRecord {
  return {
    deliveryId: row.delivery_id, parentSessionFile: row.parent_session_file, workerId: row.worker_id, runId: row.run_id,
    completionDelivery: row.completion_delivery, state: row.state, ...(row.runtime_generation === null ? {} : { runtimeGeneration: row.runtime_generation }),
    createdAt: row.created_at, ...(row.send_started_at === null ? {} : { sendStartedAt: row.send_started_at }), ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at })
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

export function storePreparedSet(registry: WorkerRegistry, input: { preparedId: string; parentSessionFile: string; status: string; order: string[]; warnings?: string[]; taskIds?: string[]; repositories: Array<{ id: string } & Record<string, unknown>>; createdAt: string }): void {
  transaction(registry, () => {
    registry.database.prepare("INSERT INTO prepared_sets(prepared_id,parent_session_file,status,order_json,warnings_json,task_ids_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(input.preparedId, canonicalSessionFile(input.parentSessionFile), input.status, json(input.order), json(input.warnings ?? []), json(input.taskIds ?? []), input.createdAt, input.createdAt);
    const insert = registry.database.prepare("INSERT INTO prepared_repositories(prepared_id,repository_id,record_json) VALUES(?,?,?)");
    for (const repository of input.repositories) insert.run(input.preparedId, repository.id, json(repository));
  });
}

export type TrustedPreparedSetRecord = { version: 1; preparedId: string; parentSessionFile: string; status: "ready" | "resolution_required" | "consumed" | "completed" | "partial" | "failed" | "superseded" | "discarding"; order: string[]; repositories: Array<{ id: string } & Record<string, any>>; taskIds: string[]; createdAt: string };

export function readPreparedSetRecord(registry: WorkerRegistry, parentSessionFile: string, preparedId: string): TrustedPreparedSetRecord {
  return transaction(registry, () => {
    const set = registry.database.prepare("SELECT prepared_id,parent_session_file,status,order_json,task_ids_json,created_at FROM prepared_sets WHERE prepared_id=? AND parent_session_file=?").get(preparedId, canonicalSessionFile(parentSessionFile)) as { prepared_id: string; parent_session_file: string; status: TrustedPreparedSetRecord["status"]; order_json: string; task_ids_json: string; created_at: string } | undefined;
    if (!set) throw new Error(`Unknown prepared set ${preparedId}.`);
    const rows = registry.database.prepare("SELECT record_json FROM prepared_repositories WHERE prepared_id=? ORDER BY repository_id").all(preparedId) as Array<{ record_json: string }>;
    return { version: 1, preparedId: set.prepared_id, parentSessionFile: set.parent_session_file, status: set.status, order: parseJson<string[]>(set.order_json), taskIds: parseJson<string[]>(set.task_ids_json), repositories: rows.map((row) => parseJson<any>(row.record_json)), createdAt: set.created_at };
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

export function updatePreparedSetStatus(registry: WorkerRegistry, preparedId: string, parentSessionFile: string, status: string, now: string, expectedStatuses: string[] = ["ready","resolution_required","partial","failed"]): void {
  if (!expectedStatuses.length || expectedStatuses.includes("discarding")) throw new Error("Prepared status transition cannot accept discarding.");
  transaction(registry, () => {
    const placeholders = expectedStatuses.map(() => "?").join(",");
    const result = registry.database.prepare(`UPDATE prepared_sets SET status=?,updated_at=? WHERE prepared_id=? AND parent_session_file=? AND apply_nonce IS NULL AND status IN (${placeholders})`).run(status, now, preparedId, parentSessionFile, ...expectedStatuses);
    if (Number(result.changes) !== 1) throw new Error(`Prepared set ${preparedId} changed status or authority.`);
  });
}

export function clearWorkerRecoveryError(registry: WorkerRegistry, workerId: string, runId: string, now: string): void {
  transaction(registry, () => { registry.database.prepare("UPDATE workers SET recovery_error=NULL,updated_at=? WHERE worker_id=? AND active_run_id=?").run(now, workerId, runId); });
}

export function recordWorkerSettlementRecovery(registry: WorkerRegistry, input: { workerId: string; runId: string; claimNonce: string; error: string; now: string }): number {
  return transaction(registry, () => {
    const row = registry.database.prepare("SELECT runtime_json FROM runs WHERE worker_id=? AND run_id=? AND status='running' AND claim_kind='settlement' AND claim_nonce=?")
      .get(input.workerId, input.runId, input.claimNonce) as { runtime_json: string } | undefined;
    if (!row) throw staleRun(input.workerId, input.runId);
    const runtime = parseJson<Record<string, unknown>>(row.runtime_json);
    const previous = Number(runtime.settlementRecoveryAttempts ?? 0);
    const attempts = Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
    registry.database.prepare("UPDATE runs SET runtime_json=? WHERE worker_id=? AND run_id=? AND claim_kind='settlement' AND claim_nonce=?")
      .run(json({ ...runtime, settlementRecoveryAttempts: attempts, settlementRecoveryError: input.error }), input.workerId, input.runId, input.claimNonce);
    registry.database.prepare("UPDATE workers SET recovery_error=?,updated_at=? WHERE worker_id=? AND active_run_id=?")
      .run(input.error, input.now, input.workerId, input.runId);
    return attempts;
  });
}

export type WorkerLifecycleClaimRecoveryCandidate = {
  workerId: string;
  runId: string;
  claimKind: "launch" | "settlement" | "cancellation";
  claimNonce: string;
  runtime: Record<string, unknown>;
};

export function registerParentRuntimeAndRecoverClaims(
  registry: WorkerRegistry,
  parentSessionFile: string,
  runtimeId: string,
  now: string,
  claimIsLive: (claim: WorkerLifecycleClaimRecoveryCandidate) => boolean,
  owner?: Omit<ParentRuntimeIdentity, "runtimeId">
): number {
  return transaction(registry, () => {
    const generation = registerParentRuntimeInTransaction(registry, parentSessionFile, { runtimeId, ...(owner ?? {}) }, now);
    recoverInterruptedClaimsInTransaction(registry, parentSessionFile, generation, now, (claim) => {
      try { return claimIsLive(claim); } catch { return true; }
    });
    return generation;
  });
}

export function recoverInterruptedClaimsForParent(registry: WorkerRegistry, parentSessionFile: string, runtimeGeneration: number, now: string, preservedClaimNonces: string[] = []): void {
  transaction(registry, () => {
    const preserved = new Set(preservedClaimNonces);
    recoverInterruptedClaimsInTransaction(registry, parentSessionFile, runtimeGeneration, now, (claim) => preserved.has(claim.claimNonce));
  });
}

function recoverInterruptedClaimsInTransaction(
  registry: WorkerRegistry,
  parentSessionFile: string,
  runtimeGeneration: number,
  now: string,
  claimIsLive: (claim: WorkerLifecycleClaimRecoveryCandidate) => boolean
): void {
  const currentPrefix = `${runtimeGeneration}-%`;
  const claimed = registry.database.prepare(`SELECT w.worker_id,w.active_run_id,r.claim_kind,r.claim_nonce,r.runtime_json
    FROM workers w JOIN runs r ON r.run_id=w.active_run_id
    WHERE w.parent_session_file=? AND r.claim_kind IS NOT NULL AND (r.claim_nonce IS NULL OR r.claim_nonce NOT LIKE ?)`)
    .all(parentSessionFile, currentPrefix) as Array<{ worker_id: string; active_run_id: string; claim_kind: WorkerLifecycleClaimRecoveryCandidate["claimKind"]; claim_nonce: string | null; runtime_json: string }>;
  for (const item of claimed) {
    if (item.claim_nonce) {
      const candidate: WorkerLifecycleClaimRecoveryCandidate = { workerId: item.worker_id, runId: item.active_run_id, claimKind: item.claim_kind, claimNonce: item.claim_nonce, runtime: parseJson<Record<string, unknown>>(item.runtime_json) };
      if (claimIsLive(candidate)) continue;
    }
    registry.database.prepare(`UPDATE runs SET claim_kind=NULL,claim_nonce=NULL,
      terminal_intent=CASE WHEN claim_kind='cancellation' THEN COALESCE(terminal_intent,'cancellation') ELSE terminal_intent END,
      terminal_error=CASE WHEN claim_kind='cancellation' AND terminal_intent IS NULL THEN NULL ELSE terminal_error END
      WHERE run_id=? AND worker_id=? AND claim_kind=? AND claim_nonce IS ?`)
      .run(item.active_run_id, item.worker_id, item.claim_kind, item.claim_nonce);
    if (item.claim_kind === "cancellation") registry.database.prepare("UPDATE workers SET recovery_error=?,version=version+1,updated_at=? WHERE worker_id=?")
      .run("Interrupted cancellation claim is ready for exact containment recovery.", now, item.worker_id);
  }
  // Discard operations and prepared apply nonces are not generic lifecycle
  // claims. Their dedicated recovery paths preserve irreversible/root and
  // repository authority instead of clearing it during runtime registration.
}

export type PreparedSetApplyRecoveryCandidate={preparedId:string;claimNonce:string;runtimeGeneration:number};
/** Roll back only exact stale prepared-apply authority after its runtime owner is proved dead, retired, or missing. Repository application is idempotently revalidated by the next explicit apply. */
export function recoverInterruptedPreparedSetAppliesForParent(registry:WorkerRegistry,parentSessionFile:string,runtimeGeneration:number,now:string,mayRecover:(candidate:PreparedSetApplyRecoveryCandidate)=>boolean):string[]{
 return transaction(registry,()=>{const recovered:string[]=[];const rows=registry.database.prepare("SELECT prepared_id,apply_nonce FROM prepared_sets WHERE parent_session_file=? AND apply_nonce IS NOT NULL").all(canonicalSessionFile(parentSessionFile)) as Array<{prepared_id:string;apply_nonce:string}>;for(const row of rows){const match=/^(\d+)-/.exec(row.apply_nonce);if(!match)continue;const ownerGeneration=Number(match[1]);if(!Number.isSafeInteger(ownerGeneration)||ownerGeneration>=runtimeGeneration)continue;const candidate={preparedId:row.prepared_id,claimNonce:row.apply_nonce,runtimeGeneration:ownerGeneration};let allowed=false;try{allowed=mayRecover(candidate);}catch{}if(!allowed)continue;const changed=registry.database.prepare("UPDATE prepared_sets SET apply_nonce=NULL,updated_at=? WHERE prepared_id=? AND parent_session_file=? AND apply_nonce=?").run(now,row.prepared_id,canonicalSessionFile(parentSessionFile),row.apply_nonce);if(Number(changed.changes)===1)recovered.push(row.prepared_id);}return recovered;});
}

export function reconcileWorkerDeliveries(registry: WorkerRegistry, parentSessionFile: string, deliveredIds: string[]): void {
  transaction(registry, () => {
    const mark = registry.database.prepare("UPDATE deliveries SET state='delivered',delivered_at=COALESCE(delivered_at,?) WHERE parent_session_file=? AND delivery_id=?");
    const now = new Date().toISOString();
    for (const deliveryId of deliveredIds) mark.run(now, parentSessionFile, deliveryId);
    // Unobserved sends are ambiguous: registration alone is not proof that the
    // owning runtime died before attempting the send, so they are never replayed.
  });
}

export type WorkerBatchCreateItem =
  | { kind: "new"; worker: NewWorkerRegistryRecord; run: WorkerRunRecord }
  | { kind: "resume"; workerId: string; expectedVersion: number; taskIds: string[]; runtime?: Record<string, unknown>; run: WorkerRunRecord };
export type WorkerReviewLeaseClaim = { subjectWorkerId: string; reviewerWorkerId: string; reviewedRunId: string };

/** Atomically publishes a fully provisioned independent batch as launchable queued runs. */
export function createWorkerRunBatch(registry: WorkerRegistry, input: {
  items: WorkerBatchCreateItem[];
  reviewLeases?: WorkerReviewLeaseClaim[];
  consumedPrepared?: Array<{ preparedId: string; parentSessionFile: string }>;
  authority?: { parentSessionFile: string; runtimeGeneration: number };
  now: string;
}): void {
  transaction(registry, () => {
    if (input.authority && !parentRuntimeGenerationMatches(registry, input.authority.parentSessionFile, input.authority.runtimeGeneration))
      throw new Error("Parent runtime was superseded; reload this session to regain worker lifecycle authority.");
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

export function claimWorkerRun(registry: WorkerRegistry, workerId: string, runId: string, kind: "launch" | "settlement" | "cancellation", nonce: string, allowed: WorkerRunStatus[], runtimeGeneration?: number): boolean {
  return transaction(registry, () => {
    if (runtimeGeneration !== undefined && !workerRuntimeGenerationMatches(registry, workerId, runtimeGeneration)) return false;
    const placeholders = allowed.map(() => "?").join(",");
    const result = registry.database.prepare(`UPDATE runs SET claim_kind=?,claim_nonce=? WHERE worker_id=? AND run_id=? AND claim_kind IS NULL AND terminal_intent IS NULL AND status IN (${placeholders})`)
      .run(kind, nonce, workerId, runId, ...allowed);
    return Number(result.changes) === 1;
  });
}

export function releaseWorkerRunClaim(registry: WorkerRegistry, workerId: string, runId: string, kind: "launch" | "settlement" | "cancellation", nonce: string): boolean {
  return transaction(registry, () => Number(registry.database.prepare("UPDATE runs SET claim_kind=NULL,claim_nonce=NULL WHERE worker_id=? AND run_id=? AND claim_kind=? AND claim_nonce=?")
    .run(workerId, runId, kind, nonce).changes) === 1);
}

/** Releases one exact claim only after the caller has proved its owner dead. */
export function recoverProvablyDeadWorkerRunClaim(registry: WorkerRegistry, input: {
  workerId: string; runId: string; claimKind: "launch" | "settlement" | "cancellation"; claimNonce: string; runtimeGeneration: number; now: string;
}): boolean {
  return transaction(registry, () => {
    if (!workerRuntimeGenerationMatches(registry, input.workerId, input.runtimeGeneration)) return false;
    const result = registry.database.prepare(`UPDATE runs SET claim_kind=NULL,claim_nonce=NULL,
      terminal_intent=CASE WHEN claim_kind='cancellation' THEN COALESCE(terminal_intent,'cancellation') ELSE terminal_intent END,
      terminal_error=CASE WHEN claim_kind='cancellation' AND terminal_intent IS NULL THEN NULL ELSE terminal_error END
      WHERE worker_id=? AND run_id=? AND status IN ('queued','running') AND claim_kind=? AND claim_nonce=?`)
      .run(input.workerId, input.runId, input.claimKind, input.claimNonce);
    if (Number(result.changes) !== 1) return false;
    if (input.claimKind === "cancellation") registry.database.prepare("UPDATE workers SET recovery_error=?,version=version+1,updated_at=? WHERE worker_id=? AND active_run_id=?")
      .run("Interrupted cancellation claim is ready for exact containment recovery.", input.now, input.workerId, input.runId);
    return true;
  });
}

/** Claims a verified accepted result even if a later terminal request is pending. */
export function claimWorkerAcceptedSettlement(registry: WorkerRegistry, workerId: string, runId: string, nonce: string, runtimeGeneration: number): boolean {
  return transaction(registry, () => {
    if (!workerRuntimeGenerationMatches(registry, workerId, runtimeGeneration)) return false;
    return Number(registry.database.prepare("UPDATE runs SET claim_kind='settlement',claim_nonce=? WHERE worker_id=? AND run_id=? AND status='running' AND claim_kind IS NULL")
      .run(nonce, workerId, runId).changes) === 1;
  });
}

export function requestWorkerCancellation(registry: WorkerRegistry, workerId: string, runId: string, now: string): boolean {
  return transaction(registry, () => {
    const result = registry.database.prepare(`UPDATE runs SET terminal_intent=CASE WHEN terminal_intent='failure' THEN terminal_intent ELSE 'cancellation' END,
      terminal_error=CASE WHEN terminal_intent='failure' THEN terminal_error ELSE NULL END
      WHERE worker_id=? AND run_id=? AND status IN ('queued','running')`).run(workerId, runId);
    if (Number(result.changes) === 1) registry.database.prepare("UPDATE workers SET updated_at=? WHERE worker_id=? AND active_run_id=?").run(now, workerId, runId);
    return Number(result.changes) === 1;
  });
}

export function requestWorkerFailure(registry: WorkerRegistry, workerId: string, runId: string, error: string, now: string, runtimeGeneration?: number): boolean {
  return transaction(registry, () => {
    if (runtimeGeneration !== undefined && !workerRuntimeGenerationMatches(registry, workerId, runtimeGeneration)) return false;
    const result = registry.database.prepare(`UPDATE runs SET terminal_intent=COALESCE(terminal_intent,'failure'),
      terminal_error=CASE WHEN terminal_intent IS NULL THEN ? ELSE terminal_error END
      WHERE worker_id=? AND run_id=? AND status IN ('queued','running')`).run(error, workerId, runId);
    if (Number(result.changes) === 1) registry.database.prepare("UPDATE workers SET recovery_error=?,updated_at=? WHERE worker_id=? AND active_run_id=?").run(error, now, workerId, runId);
    return Number(result.changes) === 1;
  });
}

export function setClaimedWorkerTerminalIntent(registry: WorkerRegistry, input: {
  workerId: string; runId: string; claimKind: "launch" | "settlement" | "cancellation"; claimNonce: string;
  terminalIntent: WorkerTerminalIntent; terminalError?: string; now: string;
}): WorkerTerminalIntent {
  return transaction(registry, () => {
    const result = registry.database.prepare(`UPDATE runs SET
      terminal_intent=COALESCE(terminal_intent,?),
      terminal_error=CASE WHEN terminal_intent IS NULL THEN ? ELSE terminal_error END
      WHERE worker_id=? AND run_id=? AND status IN ('queued','running') AND claim_kind=? AND claim_nonce=?`)
      .run(input.terminalIntent, nullable(input.terminalError), input.workerId, input.runId, input.claimKind, input.claimNonce);
    if (Number(result.changes) !== 1) throw staleRun(input.workerId, input.runId);
    registry.database.prepare("UPDATE workers SET updated_at=? WHERE worker_id=? AND active_run_id=?").run(input.now, input.workerId, input.runId);
    const row = registry.database.prepare("SELECT terminal_intent FROM runs WHERE worker_id=? AND run_id=?").get(input.workerId, input.runId) as { terminal_intent: WorkerTerminalIntent };
    return row.terminal_intent;
  });
}

export function claimWorkerTerminalIntent(registry: WorkerRegistry, input: {
  workerId: string; runId: string; terminalIntent: WorkerTerminalIntent; claimKind: "settlement" | "cancellation";
  claimNonce: string; now: string; runtimeGeneration?: number;
}): boolean {
  return transaction(registry, () => {
    if (input.runtimeGeneration !== undefined && !workerRuntimeGenerationMatches(registry, input.workerId, input.runtimeGeneration)) return false;
    const result = registry.database.prepare(`UPDATE runs SET claim_kind=?,claim_nonce=?
      WHERE worker_id=? AND run_id=? AND status IN ('queued','running') AND terminal_intent=? AND claim_kind IS NULL`)
      .run(input.claimKind, input.claimNonce, input.workerId, input.runId, input.terminalIntent);
    if (Number(result.changes) === 1) registry.database.prepare("UPDATE workers SET updated_at=? WHERE worker_id=? AND active_run_id=?").run(input.now, input.workerId, input.runId);
    return Number(result.changes) === 1;
  });
}

function workerRuntimeGenerationMatches(registry: WorkerRegistry, workerId: string, runtimeGeneration: number): boolean {
  const row = registry.database.prepare(`SELECT p.generation FROM workers w JOIN parent_runtimes p ON p.parent_session_file=w.parent_session_file WHERE w.worker_id=?`).get(workerId) as { generation: number } | undefined;
  return row?.generation === runtimeGeneration;
}

export function updateClaimedWorkerRunRuntime(registry: WorkerRegistry, input: { workerId: string; runId: string; claimKind: "launch" | "settlement" | "cancellation"; claimNonce: string; runtime: Record<string, unknown> }): void {
  transaction(registry, () => {
    const result = registry.database.prepare("UPDATE runs SET runtime_json=? WHERE worker_id=? AND run_id=? AND status IN ('queued','running') AND claim_kind=? AND claim_nonce=?")
      .run(json(input.runtime), input.workerId, input.runId, input.claimKind, input.claimNonce);
    if (Number(result.changes) !== 1) throw staleRun(input.workerId, input.runId);
  });
}

export function finalizeWorkerRunLaunch(registry: WorkerRegistry, input: {
  workerId: string; runId: string; claimNonce: string; modelSelection: string; sessionId: string; sessionFile: string;
  sessionStartLine: number; jobId: string; stdoutLog: string; stderrLog: string; runtime: Record<string, unknown>; startedAt: string;
}): void {
  transaction(registry, () => {
    const run = registry.database.prepare(`UPDATE runs SET status='running',model_selection=?,job_id=?,stdout_log=?,stderr_log=?,session_start_line=?,runtime_json=?,started_at=?,claim_kind=NULL,claim_nonce=NULL
      WHERE worker_id=? AND run_id=? AND status='queued' AND claim_kind='launch' AND claim_nonce=?`)
      .run(input.modelSelection, input.jobId, input.stdoutLog, input.stderrLog, input.sessionStartLine, json(input.runtime), input.startedAt, input.workerId, input.runId, input.claimNonce);
    const worker = registry.database.prepare(`UPDATE workers SET status='running',model_selection=?,session_id=?,session_file=?,recovery_error=NULL,version=version+1,updated_at=?
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
    const run = registry.database.prepare(`UPDATE runs SET status='settled',outcome=?,outcome_source=?,summary=?,question=?,repositories_json=?,artifacts_json=?,errors_json=?,session_start_line=COALESCE(session_start_line,?),session_end_line=?,settled_at=?,claim_kind=NULL,claim_nonce=NULL,terminal_intent=NULL,terminal_error=NULL
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

export function claimWorkerRecoveryDiscard(registry:WorkerRegistry,workerId:string,expectedVersion:number,expectedRecoveryError:string,nonce:string,now:string):void{transaction(registry,()=>{const worker=getWorker(registry,workerId),recovery=worker?.runtime?.cleanupRecovery as Record<string,unknown>|undefined;if(!worker||recovery?.phase!=="precommit"||recovery.error!==expectedRecoveryError)throw staleWorker(workerId);const changed=registry.database.prepare("UPDATE workers SET operation_kind='discard',operation_nonce=?,recovery_error=NULL,version=version+1,updated_at=? WHERE worker_id=? AND version=? AND status='idle' AND reviewed_by_worker_id IS NULL AND operation_kind IS NULL AND recovery_error=?").run(nonce,now,workerId,expectedVersion,expectedRecoveryError);if(Number(changed.changes)!==1)throw staleWorker(workerId);});}

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

function runtimeWithCleanupRecovery(runtimeJson:string,error:string,now:string):string{const runtime=parseJson<Record<string,unknown>>(runtimeJson);if(runtime.cleanupConsent&&typeof runtime.cleanupConsent==="object")runtime.cleanupRecovery={phase:"precommit",error:error.slice(0,2048),recordedAt:now};return JSON.stringify(runtime);}
export function abandonWorkerDiscard(registry: WorkerRegistry, workerId: string, nonce: string, error: string, now: string): void {
  transaction(registry, () => {const row=registry.database.prepare("SELECT runtime_json FROM workers WHERE worker_id=? AND operation_kind='discard' AND operation_nonce=?").get(workerId,nonce) as {runtime_json:string}|undefined;if(!row)return;registry.database.prepare("UPDATE workers SET operation_kind=NULL,operation_nonce=NULL,recovery_error=?,runtime_json=?,version=version+1,updated_at=? WHERE worker_id=? AND operation_kind='discard' AND operation_nonce=?").run(error.slice(0, 2048),runtimeWithCleanupRecovery(row.runtime_json,error,now),now,workerId,nonce);});
}
export function markWorkerCleanupRecovery(registry:WorkerRegistry,workerId:string,parentSessionFile:string,error:string,now:string):boolean{return transaction(registry,()=>{const row=registry.database.prepare("SELECT runtime_json,recovery_error FROM workers WHERE worker_id=? AND parent_session_file=? AND status='idle' AND operation_kind IS NULL").get(workerId,parentSessionFile) as {runtime_json:string;recovery_error:string|null}|undefined;if(!row)return false;const runtime=parseJson<Record<string,unknown>>(row.runtime_json);if(!runtime.cleanupConsent||typeof runtime.cleanupConsent!=="object")return false;const retainedError=row.recovery_error??error.slice(0,2048);const changed=registry.database.prepare("UPDATE workers SET recovery_error=?,runtime_json=?,version=version+1,updated_at=? WHERE worker_id=? AND parent_session_file=? AND status='idle' AND operation_kind IS NULL").run(retainedError,runtimeWithCleanupRecovery(row.runtime_json,retainedError,now),now,workerId,parentSessionFile);return Number(changed.changes)===1;});}

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

function insertWorker(registry: WorkerRegistry, worker: NewWorkerRegistryRecord): void {
  registry.database.prepare(`INSERT INTO workers(worker_id,parent_session_file,role,status,active_run_id,latest_run_id,task_ids_json,model_selection,session_id,session_file,workspace_root,storage_layout,recovery_error,reviewed_by_worker_id,runtime_json,operation_kind,operation_nonce,version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(
    worker.workerId, canonicalSessionFile(worker.parentSessionFile), worker.role, worker.status, nullable(worker.activeRunId), nullable(worker.latestRunId), json(worker.taskIds), nullable(worker.modelSelection), nullable(worker.sessionId), nullable(worker.sessionFile), worker.workspaceRoot, worker.storageLayout ?? CURRENT_WORKER_STORAGE_LAYOUT, nullable(worker.recoveryError), nullable(worker.reviewedByWorkerId), json(worker.runtime ?? {}), nullable(worker.operationKind), nullable(worker.operationNonce), worker.createdAt, worker.updatedAt
  );
}

export function claimWorkerCancellation(registry: WorkerRegistry, workerId: string, runId: string, nonce: string, now: string, runtimeGeneration?: number): boolean {
  return transaction(registry, () => {
    const worker = registry.database.prepare("SELECT 1 AS present FROM workers WHERE worker_id=? AND active_run_id=? AND status IN ('queued','running')").get(workerId, runId) as { present: number } | undefined;
    if (!worker) return false;
    registry.database.prepare(`UPDATE runs SET terminal_intent=CASE WHEN terminal_intent='failure' THEN terminal_intent ELSE 'cancellation' END,
      terminal_error=CASE WHEN terminal_intent='failure' THEN terminal_error ELSE NULL END WHERE worker_id=? AND run_id=? AND status IN ('queued','running')`).run(workerId, runId);
    if (runtimeGeneration !== undefined && !workerRuntimeGenerationMatches(registry, workerId, runtimeGeneration)) return false;
    const result = registry.database.prepare("UPDATE runs SET claim_kind='cancellation',claim_nonce=? WHERE worker_id=? AND run_id=? AND status IN ('queued','running') AND terminal_intent='cancellation' AND claim_kind IS NULL")
      .run(nonce, workerId, runId);
    if (Number(result.changes) === 1) registry.database.prepare("UPDATE workers SET updated_at=? WHERE worker_id=?").run(now, workerId);
    return Number(result.changes) === 1;
  });
}

export function activeRunsForParent(registry: WorkerRegistry, parentSessionFile: string): Array<{ worker: WorkerRegistryRecord; run: WorkerRunRecord }> {
  const rows = registry.database.prepare("SELECT worker_id,active_run_id FROM workers WHERE parent_session_file=? AND active_run_id IS NOT NULL ORDER BY created_at,worker_id").all(parentSessionFile) as Array<{ worker_id: string; active_run_id: string }>;
  return rows.flatMap((row) => { const worker = getWorker(registry, row.worker_id); const run = getWorkerRun(registry, row.worker_id, row.active_run_id); return worker && run ? [{ worker, run }] : []; });
}
