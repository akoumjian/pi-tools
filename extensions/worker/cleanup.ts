import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { isAsyncJobExecutionAlive } from "../_shared/async-job.js";
import { isWorkerId } from "../_shared/worker-id.js";
import { defaultPreparedMergeRoot } from "./merge.js";
import { getWorker, listAllWorkers, listWorkerRuns, listWorkers, type WorkerRegistry, type WorkerRegistryRecord, type WorkerRunRecord } from "./registry.js";
import { workerPaths, type WorkerRoots } from "./identity.js";

export type CleanupClass = "active" | "recovery" | "undelivered" | "unknown:task_missing" | "unknown:beads_unavailable" | "retained" | "due" | "leased";
export type BeadsTaskFact = { id: string; status: string };
export type CleanupWorkerItem = {
  workerId: string; ownerSession: string; role: WorkerRegistryRecord["role"]; class: CleanupClass; reason: string;
  taskIds: string[]; unpreservedArtifacts: string[]; pendingResults: Array<{ runId: string; outcome?: string; summary?: string }>;
  after?: string; recoveryError?: string; preservations: ReturnType<typeof preservationRecords>;
};
export type PreparedCleanupItem = { preparedId: string; ownerSession: string; status: string; class: "due" | "retained" | "explicit_decision" | "partial" | "claimed" | "discarding"; taskIds: string[]; reason: string };
export type CleanupInventory = { workers: CleanupWorkerItem[]; prepared: PreparedCleanupItem[]; leftovers: CleanupLeftover[]; scan: { partial: boolean; examinedWorkers: number; totalWorkers: number; examinedFilesystemEntries: number }; generatedAt: string };
export type CleanupPreview = CleanupInventory & { version: 1; allSessions: boolean; token: string };

const execFileAsync = promisify(execFile);
const PREPARED_ID = /^prepared_[0-9a-f]{24}$/;
const MAX_TASKS_PER_READ = 50;
const MAX_BEADS_OUTPUT = 8 * 1024 * 1024;
const MAX_PRESERVATION_ENTRIES = 200_000;
const MAX_PRESERVATION_RECORDS = 64;

function transaction<T>(registry: WorkerRegistry, fn: () => T): T {
  registry.database.exec("BEGIN IMMEDIATE");
  try { const value = fn(); registry.database.exec("COMMIT"); return value; }
  catch (error) { registry.database.exec("ROLLBACK"); throw error; }
}
function parseJson<T>(value: string): T { return JSON.parse(value) as T; }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
}
function cleanupToken(value: Omit<CleanupPreview, "token">): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex").slice(0, 24);
}
function boundedSummary(value: string | undefined): string | undefined { return value === undefined ? undefined : value.slice(0, 512); }

/** Reads exact personal Beads facts with bounded async subprocesses. Any chunk failure is fail-closed for that chunk. */
export async function readCleanupBeadsFacts(taskIds: string[], input: { bdPath?: string; cwd: string }): Promise<Map<string, BeadsTaskFact | "missing" | "unavailable">> {
  const facts = new Map<string, BeadsTaskFact | "missing" | "unavailable">();
  const unique = [...new Set(taskIds)].sort();
  const bdPath = input.bdPath ?? "bd";
  if (unique.length === 0) return facts;
  try {
    const where = await execFileAsync(bdPath, ["where", "--json"], { cwd: input.cwd, timeout: 10_000, maxBuffer: MAX_BEADS_OUTPUT, encoding: "utf8" });
    const route = JSON.parse(where.stdout) as Record<string, unknown>;
    if (route.prefix !== "personal" || typeof route.path !== "string" || typeof route.database_path !== "string") { for (const id of unique) facts.set(id, "unavailable"); return facts; }
  } catch { for (const id of unique) facts.set(id, "unavailable"); return facts; }
  const accept = (requested: string[], stdout: string): boolean => {
    const parsed = JSON.parse(stdout) as unknown; if (!Array.isArray(parsed)) return false; const seen = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const row = item as Record<string, unknown>; const id = typeof row.id === "string" ? row.id : "";
      if (!requested.includes(id) || seen.has(id) || typeof row.status !== "string" || !id.startsWith("personal-")) return false;
      seen.add(id); facts.set(id, { id, status: row.status });
    }
    for (const id of requested) if (!seen.has(id)) facts.set(id, "missing"); return true;
  };
  const readOne = async (id: string): Promise<void> => { try { const output = await execFileAsync(bdPath, ["show", id, "--json"], { cwd: input.cwd, timeout: 10_000, maxBuffer: MAX_BEADS_OUTPUT, encoding: "utf8" }); if (!accept([id], output.stdout)) facts.set(id, "unavailable"); } catch { facts.set(id, "unavailable"); } };
  for (let offset = 0; offset < unique.length; offset += MAX_TASKS_PER_READ) {
    const chunk = unique.slice(offset, offset + MAX_TASKS_PER_READ);
    try { const output = await execFileAsync(bdPath, ["show", ...chunk, "--json"], { cwd: input.cwd, timeout: 10_000, maxBuffer: MAX_BEADS_OUTPUT, encoding: "utf8" }); if (!accept(chunk, output.stdout)) throw new Error("invalid Beads output"); }
    catch {
      for (let item = 0; item < chunk.length; item += 4) await Promise.all(chunk.slice(item, item + 4).map(readOne));
    }
  }
  return facts;
}

function workerRunsBounded(registry: WorkerRegistry, workerId: string): WorkerRunRecord[] {
  const runs: WorkerRunRecord[] = []; let offset = 0; let total = 0;
  while (runs.length < LEFTOVER_SCAN_LIMIT) { const page = listWorkerRuns(registry, workerId, Math.min(100, LEFTOVER_SCAN_LIMIT - runs.length), offset); total = page.total; runs.push(...page.runs); if (page.nextOffset === undefined) break; offset = page.nextOffset; }
  if (runs.length < total) throw new Error(`Worker ${workerId} run inventory exceeds the bounded scan.`); return runs;
}
export function reportedArtifacts(registry: WorkerRegistry, worker: WorkerRegistryRecord): string[] {
  const runs = workerRunsBounded(registry, worker.workerId);
  const output = new Set<string>();
  for (const run of runs) for (const artifact of run.artifacts) {
    const relative = normalizeWorkspacePointer(artifact);
    if (relative) output.add(relative);
  }
  return collapseParents([...output].filter((relative) => existsSync(path.join(worker.workspaceRoot, relative))));
}

export function preservationRecords(registry: WorkerRegistry, workerId: string): Array<{ id: string; status: "pending" | "published" | "failed"; destination: string; tempPath: string; latestRunId?: string; items: string[]; error?: string }> {
  const rows = registry.database.prepare("SELECT * FROM preservation_records WHERE worker_id=? ORDER BY created_at DESC,preservation_id DESC LIMIT 256").all(workerId) as Array<Record<string, any>>;
  return rows.map((row) => ({ id: row.preservation_id, status: row.status, destination: row.destination, tempPath: row.temp_path, ...(row.latest_run_id === null ? {} : { latestRunId: row.latest_run_id }), items: parseJson<string[]>(row.items_json), ...(row.error === null ? {} : { error: row.error }) }));
}

export function unpreservedArtifacts(registry: WorkerRegistry, worker: WorkerRegistryRecord): string[] {
  const published = preservationRecords(registry, worker.workerId).filter((record) => record.status === "published" && record.latestRunId === worker.latestRunId);
  return reportedArtifacts(registry, worker).filter((artifact) => !published.some((record) => record.items.some((item) => artifact === item || artifact.startsWith(`${item}/`))));
}

function hasRunClaim(registry: WorkerRegistry, workerId: string): boolean {
  return Boolean(registry.database.prepare("SELECT 1 FROM runs WHERE worker_id=? AND claim_kind IS NOT NULL LIMIT 1").get(workerId));
}
function hasUndelivered(registry: WorkerRegistry, workerId: string): boolean {
  return Boolean(registry.database.prepare("SELECT 1 FROM deliveries WHERE worker_id=? AND state!='delivered' LIMIT 1").get(workerId));
}
function pendingResults(registry: WorkerRegistry, workerId: string): CleanupWorkerItem["pendingResults"] {
  const rows = registry.database.prepare(`SELECT r.run_id,r.outcome,r.summary FROM runs r JOIN deliveries d ON d.run_id=r.run_id
    WHERE r.worker_id=? AND d.state!='delivered' ORDER BY r.created_at`).all(workerId) as Array<{ run_id: string; outcome: string | null; summary: string | null }>;
  return rows.map((row) => ({ runId: row.run_id, ...(row.outcome ? { outcome: row.outcome } : {}), ...(row.summary ? { summary: boundedSummary(row.summary) } : {}) }));
}

export function classifyCleanupWorker(registry: WorkerRegistry, worker: WorkerRegistryRecord, facts: Map<string, BeadsTaskFact | "missing" | "unavailable">): CleanupWorkerItem {
  let kind: CleanupClass; let reason: string;
  if (worker.status !== "idle" || worker.operationKind || hasRunClaim(registry, worker.workerId)) { kind = "active"; reason = "Worker or lifecycle operation is active."; }
  else if (worker.recoveryError) { kind = "recovery"; reason = worker.recoveryError; }
  else if (hasUndelivered(registry, worker.workerId)) { kind = "undelivered"; reason = "A completion result is not durably delivered."; }
  else if (worker.taskIds.length === 0 || worker.taskIds.some((id) => facts.get(id) === "missing")) { kind = "unknown:task_missing"; reason = "An assigned personal Beads task is missing or mismatched."; }
  else if (worker.taskIds.some((id) => facts.get(id) === "unavailable" || !facts.has(id))) { kind = "unknown:beads_unavailable"; reason = "Central personal Beads facts are unavailable."; }
  else if (worker.taskIds.some((id) => (facts.get(id) as BeadsTaskFact).status !== "closed")) { kind = "retained"; reason = "At least one assigned task is open."; }
  else { kind = "due"; reason = worker.reviewedByWorkerId ? `All assigned tasks are closed; discard after reviewer ${worker.reviewedByWorkerId}.` : "All assigned tasks are closed."; }
  return { workerId: worker.workerId, ownerSession: worker.parentSessionFile, role: worker.role, class: kind, reason, taskIds: worker.taskIds, unpreservedArtifacts: unpreservedArtifacts(registry, worker), pendingResults: pendingResults(registry, worker.workerId), preservations: preservationRecords(registry, worker.workerId), ...(kind === "due" && worker.reviewedByWorkerId ? { after: `reviewer ${worker.reviewedByWorkerId}` } : {}), ...(worker.recoveryError ? { recoveryError: worker.recoveryError } : {}) };
}

type PreparedRow = { prepared_id: string; parent_session_file: string; status: string; task_ids_json: string; apply_nonce: string | null };
function listPreparedRows(registry: WorkerRegistry, parent?: string): { rows: PreparedRow[]; partial: boolean } {
  const rows = (parent
    ? registry.database.prepare("SELECT prepared_id,parent_session_file,status,task_ids_json,apply_nonce FROM prepared_sets WHERE parent_session_file=? ORDER BY updated_at DESC LIMIT ?").all(parent, LEFTOVER_SCAN_LIMIT + 1)
    : registry.database.prepare("SELECT prepared_id,parent_session_file,status,task_ids_json,apply_nonce FROM prepared_sets ORDER BY parent_session_file,updated_at DESC LIMIT ?").all(LEFTOVER_SCAN_LIMIT + 1)) as PreparedRow[];
  return { rows: rows.slice(0, LEFTOVER_SCAN_LIMIT), partial: rows.length > LEFTOVER_SCAN_LIMIT };
}
function preparedTaskLineage(registry: WorkerRegistry, row: PreparedRow): { taskIds: string[]; missingRepository: boolean } {
  const repositories = registry.database.prepare("SELECT record_json FROM prepared_repositories WHERE prepared_id=?").all(row.prepared_id) as Array<{ record_json: string }>;
  if (repositories.length === 0) return { taskIds: parseJson<string[]>(row.task_ids_json), missingRepository: true };
  let missingRepository = false; const taskIds = new Set<string>();
  for (const { record_json } of repositories) {
    try {
      const record = parseJson<Record<string, any>>(record_json); let inherited = Array.isArray(record.taskIds) ? record.taskIds.filter((item: unknown): item is string => typeof item === "string") : [];
      if (inherited.length === 0 && typeof record.source?.workerId === "string") inherited = getWorker(registry, record.source.workerId)?.taskIds ?? [];
      if (inherited.length === 0) missingRepository = true; for (const id of inherited) taskIds.add(id);
    } catch { missingRepository = true; }
  }
  return { taskIds: [...taskIds].sort(), missingRepository };
}
function classifyPrepared(registry: WorkerRegistry, row: PreparedRow, facts: Map<string, BeadsTaskFact | "missing" | "unavailable">): PreparedCleanupItem {
  const lineage = preparedTaskLineage(registry, row); const taskIds = lineage.taskIds;
  if (row.status === "discarding") return { preparedId: row.prepared_id, ownerSession: row.parent_session_file, status: row.status, class: "discarding", taskIds, reason: "A committed discard must be finished." };
  if (row.apply_nonce !== null) return { preparedId: row.prepared_id, ownerSession: row.parent_session_file, status: row.status, class: "claimed", taskIds, reason: "Prepared apply is claimed." };
  if (row.status === "partial") return { preparedId: row.prepared_id, ownerSession: row.parent_session_file, status: row.status, class: "partial", taskIds, reason: "Application is partial and requires an explicit decision." };
  if (!["ready", "resolution_required", "failed"].includes(row.status)) return { preparedId: row.prepared_id, ownerSession: row.parent_session_file, status: row.status, class: "explicit_decision", taskIds, reason: `Prepared status ${row.status} is not cleanup-eligible.` };
  if (lineage.missingRepository || taskIds.length === 0 || taskIds.some((id) => !facts.has(id) || facts.get(id) === "missing" || facts.get(id) === "unavailable")) return { preparedId: row.prepared_id, ownerSession: row.parent_session_file, status: row.status, class: "explicit_decision", taskIds, reason: "Task ownership is missing or unavailable." };
  if (taskIds.some((id) => (facts.get(id) as BeadsTaskFact).status !== "closed")) return { preparedId: row.prepared_id, ownerSession: row.parent_session_file, status: row.status, class: "retained", taskIds, reason: "An inherited task is open." };
  return { preparedId: row.prepared_id, ownerSession: row.parent_session_file, status: row.status, class: "due", taskIds, reason: "All inherited tasks are closed." };
}

export async function buildCleanupInventory(registry: WorkerRegistry, input: { parentSessionFile: string; allSessions: boolean; cwd: string; bdPath?: string; now?: Date; roots?: WorkerRoots; preparedRoot?: string }): Promise<CleanupInventory> {
  const workers: WorkerRegistryRecord[] = []; let offset = 0; let totalWorkers = 0; let workerPartial = false;
  while (workers.length < LEFTOVER_SCAN_LIMIT) {
    const remaining = LEFTOVER_SCAN_LIMIT - workers.length; const page = input.allSessions ? listAllWorkers(registry, Math.min(1000, remaining), offset) : listWorkers(registry, { parentSessionFile: input.parentSessionFile, limit: Math.min(100, remaining), offset });
    totalWorkers = page.total; workers.push(...page.workers); if (page.nextOffset === undefined) break; offset = page.nextOffset;
  }
  if (workers.length < totalWorkers) workerPartial = true;
  const preparedPage = listPreparedRows(registry, input.allSessions ? undefined : input.parentSessionFile); const prepared = preparedPage.rows;
  const ids = [...new Set([...workers.flatMap((worker) => worker.taskIds), ...prepared.flatMap((row) => preparedTaskLineage(registry, row).taskIds)])];
  const facts = await readCleanupBeadsFacts(ids, { cwd: input.cwd, ...(input.bdPath ? { bdPath: input.bdPath } : {}) });
  const leftoverScan = input.allSessions && input.roots ? scanCleanupLeftoversDetailed(registry, { roots: input.roots, preparedRoot: input.preparedRoot ?? defaultPreparedMergeRoot(), projectCwd: input.cwd, now: input.now }) : { items: [] as CleanupLeftover[], partial: false, examined: 0 };
  return { workers: workers.map((worker) => classifyCleanupWorker(registry, worker, facts)), prepared: prepared.map((row) => classifyPrepared(registry, row, facts)), leftovers: leftoverScan.items, scan: { partial: workerPartial || preparedPage.partial || leftoverScan.partial, examinedWorkers: workers.length, totalWorkers, examinedFilesystemEntries: leftoverScan.examined }, generatedAt: (input.now ?? new Date()).toISOString() };
}
export async function buildCleanupPreview(registry: WorkerRegistry, input: { parentSessionFile: string; allSessions: boolean; cwd: string; bdPath?: string; now?: Date; roots?: WorkerRoots; preparedRoot?: string }): Promise<CleanupPreview> {
  const inventory = await buildCleanupInventory(registry, input);
  const base = { version: 1 as const, allSessions: input.allSessions, ...inventory };
  const tokenInput = { ...base, generatedAt: "" };
  return { ...base, token: cleanupToken(tokenInput) };
}

export type PreservationResult = { preservationId: string; destination: string; items: string[]; entries: number; bytes: number };
type PreservationEntry = { path: string; type: "file" | "directory"; bytes: number; executable: boolean };

export async function preserveWorkerArtifacts(registry: WorkerRegistry, roots: WorkerRoots, runtimeRoot: string, input: { workerId: string; destination: string; paths?: string[]; now?: Date; nonce?: string }): Promise<PreservationResult> {
  const worker = getWorker(registry, input.workerId); if (!worker) throw new Error(`Unknown worker ${input.workerId}.`);
  assertQuiescent(registry, worker, true);
  const paths = workerPaths(roots, worker.workerId); if (!existsSync(paths.stateDir)) throw new Error(`Worker state is missing for ${worker.workerId}; preservation requires recovery.`);
  const destination = resolveSafeDestination(input.destination, runtimeRoot, roots, worker.workspaceRoot);
  const selected = input.paths ? input.paths.map(normalizeRequiredWorkspacePointer) : reportedArtifacts(registry, worker);
  if (selected.length === 0) throw new Error("No existing worker artifacts were selected for preservation.");
  const items = collapseParents(selected); if (items.length !== selected.length && input.paths) throw new Error("Preservation paths must not overlap."); if (items.length > 32) throw new Error("Preservation selects more than 32 distinct artifact roots; provide a bounded parent directory selection.");
  if (items.includes("worker-preservation.json")) throw new Error("worker-preservation.json is reserved for the preservation manifest.");
  const now = input.now ?? new Date(); const nonce = input.nonce ?? randomUUID().replaceAll("-", "");
  const preservationId = `preservation_${nonce.slice(0, 24)}`; const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.worker-preserve-${nonce.slice(0, 24)}`);
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const priorPending = preservationRecords(registry, worker.workerId).filter((record) => record.status === "pending" && record.destination === destination);
  for (const pending of priorPending) assertPreservationTemporaryPath(pending.destination, pending.tempPath);
  if (existsSync(destination)) {
    const recovered = priorPending.find((record) => record.latestRunId === worker.latestRunId && JSON.stringify(record.items) === JSON.stringify(items)); if (!recovered) throw new Error(`Preservation destination already exists: ${destination}`);
    const existing = await verifyPublishedPreservation(destination, worker, items);
    const changed = transaction(registry, () => registry.database.prepare("UPDATE preservation_records SET status='published',manifest_json=?,updated_at=? WHERE preservation_id=? AND status='pending'").run(JSON.stringify(existing.manifest), now.toISOString(), recovered.id));
    if (Number(changed.changes) !== 1) throw new Error("Pending preservation changed during publication recovery.");
    return { preservationId: recovered.id, destination, items, entries: existing.entries, bytes: existing.bytes };
  }
  for (const pending of priorPending) {
    let removed = false; try { rmSync(pending.tempPath, { recursive: true, force: true }); removed = !existsSync(pending.tempPath); } catch {}
    transaction(registry, () => registry.database.prepare("UPDATE preservation_records SET status='failed',error=?,updated_at=? WHERE preservation_id=? AND status='pending'").run(removed ? "Superseded pending preservation temporary path was removed for exact retry." : "Superseded pending preservation temporary path could not be removed.", now.toISOString(), pending.id));
    if (!removed) throw new Error(`Pending preservation temporary path could not be removed safely: ${pending.tempPath}`);
  }
  if (existsSync(tempPath)) throw new Error(`Preservation temporary path already exists without a matching trusted record: ${tempPath}`);
  transaction(registry, () => {
    registry.database.prepare(`INSERT INTO preservation_records(preservation_id,worker_id,status,destination,temp_path,latest_run_id,items_json,created_at,updated_at)
      VALUES(?,?,'pending',?,?,?,?,?,?)`).run(preservationId, worker.workerId, destination, tempPath, worker.latestRunId ?? null, JSON.stringify(items), now.toISOString(), now.toISOString());
  });
  let publicationRenamed = false;
  try {
    const entries = collectPreservationEntries(worker.workspaceRoot, items);
    mkdirSync(tempPath, { recursive: false, mode: 0o700 });
    let bytes = 0;
    for (const entry of entries.filter((item) => item.type === "directory")) mkdirSync(path.join(tempPath, entry.path), { recursive: true, mode: 0o700 });
    for (const entry of entries.filter((item) => item.type === "file")) { await copyVerifiedFile(path.join(worker.workspaceRoot, entry.path), path.join(tempPath, entry.path), entry); bytes += entry.bytes; }
    const manifest = { version: 1, preservedAt: now.toISOString(), workerId: worker.workerId, role: worker.role, taskIds: worker.taskIds, sourceWorkspace: worker.workspaceRoot, latestRunIdAtStart: worker.latestRunId, items, entries, totals: { entries: entries.length, bytes } };
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(tempPath, "worker-preservation.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 }));
    const current = getWorker(registry, worker.workerId); if (!current || current.latestRunId !== worker.latestRunId) throw new Error("Worker latest run changed during preservation.");
    assertQuiescent(registry, current, true);
    if (existsSync(destination)) throw new Error(`Preservation destination appeared during publication: ${destination}`);
    renameSync(tempPath, destination); publicationRenamed = true;
    const changed = transaction(registry, () => registry.database.prepare("UPDATE preservation_records SET status='published',manifest_json=?,updated_at=? WHERE preservation_id=? AND status='pending'").run(JSON.stringify(manifest), new Date().toISOString(), preservationId));
    if (Number(changed.changes) !== 1) throw new Error("Pending preservation record changed during publication.");
    prunePreservationRecords(registry, worker.workerId);
    return { preservationId, destination, items, entries: entries.length, bytes };
  } catch (error) {
    if (publicationRenamed || (existsSync(destination) && !existsSync(tempPath))) throw new Error(`Preservation publication requires exact pending-record recovery: ${error instanceof Error ? error.message : String(error)}`);
    let removed = false; try { rmSync(tempPath, { recursive: true, force: true }); removed = !existsSync(tempPath); } catch {}
    transaction(registry, () => registry.database.prepare("UPDATE preservation_records SET status='failed',error=?,updated_at=? WHERE preservation_id=? AND status='pending'").run(`${error instanceof Error ? error.message : String(error)}${removed ? "" : " (temporary path remains)"}`.slice(0, 2000), new Date().toISOString(), preservationId));
    throw error;
  }
}

async function verifyPublishedPreservation(destination: string, worker: WorkerRegistryRecord, items: string[]): Promise<{ manifest: Record<string, unknown>; entries: number; bytes: number }> {
  const manifestPath = path.join(destination, "worker-preservation.json"); const info = lstatSync(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error("Existing preservation manifest is missing, unsafe, or oversized.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>;
  if (manifest.version !== 1 || manifest.workerId !== worker.workerId || manifest.latestRunIdAtStart !== worker.latestRunId || JSON.stringify(manifest.items) !== JSON.stringify(items) || !Array.isArray(manifest.entries)) throw new Error("Existing preservation manifest does not match this exact worker run and item set.");
  const current = collectPreservationEntries(worker.workspaceRoot, items); const targetEntries = collectPreservationEntries(destination, items); const expected = manifest.entries as PreservationEntry[];
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("Preservation sources changed since the pending publication.");
  if (JSON.stringify(targetEntries) !== JSON.stringify(expected)) throw new Error("Existing preservation tree does not match the pending publication manifest.");
  for (const entry of expected.filter((item) => item.type === "file")) {
    const target = path.join(destination, entry.path); const metadata = lstatSync(target); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== entry.bytes) throw new Error(`Existing preservation file is unsafe or changed: ${entry.path}`);
    const [sourceHash, targetHash] = await Promise.all([hashFile(path.join(worker.workspaceRoot, entry.path)), hashFile(target)]); if (sourceHash !== targetHash) throw new Error(`Existing preservation file does not match its source: ${entry.path}`);
  }
  const bytes = expected.reduce((total, entry) => total + (entry.type === "file" ? entry.bytes : 0), 0); return { manifest, entries: expected.length, bytes };
}

function assertQuiescent(registry: WorkerRegistry, worker: WorkerRegistryRecord, allowReviewLease = false): void {
  if (worker.status !== "idle" || worker.activeRunId || worker.operationKind || hasRunClaim(registry, worker.workerId)) throw new Error(`Worker ${worker.workerId} is not quiescent.`);
  if (!allowReviewLease && worker.reviewedByWorkerId) throw new Error(`Worker ${worker.workerId} has a review lease.`);
}
function resolveSafeDestination(destination: string, runtimeRoot: string, roots: WorkerRoots, workspace: string): string {
  if (!path.isAbsolute(destination) || Buffer.byteLength(destination) > 4096) throw new Error("Preservation destination must be an absolute path of at most 4096 bytes.");
  if (destination.split(path.sep).some((part) => part.toLowerCase() === ".git")) throw new Error("Preservation destination cannot contain a .git component.");
  const resolved = resolveNearestExisting(destination);
  const home = homedir();
  const sensitive = [runtimeRoot, roots.stateRoot, roots.workspaceRoot, workspace, path.join(home, ".pi"), path.join(home, ".ssh"), path.join(home, ".aws"), path.join(home, ".gnupg"), path.join(home, ".config"), path.join(home, ".docker"), path.join(home, ".kube"), path.join(home, ".local", "share", "agent"), process.env.XDG_CONFIG_HOME, process.env.AWS_SHARED_CREDENTIALS_FILE, process.env.AWS_CONFIG_FILE, process.env.KUBECONFIG, process.env.DOCKER_CONFIG, process.env.NPM_CONFIG_USERCONFIG, process.env.BEADS_DIR].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const forbidden of sensitive) if (within(resolved, path.resolve(forbidden))) throw new Error("Preservation destination is inside managed worker or sensitive storage.");
  return path.resolve(destination);
}
function resolveNearestExisting(value: string): string { let cursor = path.resolve(value); const suffix: string[] = []; while (!existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) break; suffix.unshift(path.basename(cursor)); cursor = parent; } return path.join(realpathSync(cursor), ...suffix); }
function assertPreservationTemporaryPath(destination: string, tempPath: string): void {
  const prefix = `.${path.basename(destination)}.worker-preserve-`;
  if (path.dirname(tempPath) !== path.dirname(destination) || !path.basename(tempPath).startsWith(prefix) || path.basename(tempPath).length !== prefix.length + 24) throw new Error("Pending preservation temporary path is inconsistent with its trusted destination.");
}
function within(candidate: string, root: string): boolean { const relative = path.relative(root, candidate); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function normalizeWorkspacePointer(value: string): string | undefined { try { return normalizeRequiredWorkspacePointer(value); } catch { return undefined; } }
function normalizeRequiredWorkspacePointer(value: string): string {
  if (Buffer.byteLength(value) > 4096 || value.includes("\0")) throw new Error("Invalid preservation path.");
  const candidate = value.startsWith("/workspace/") ? value.slice(11) : value;
  if (path.isAbsolute(candidate)) throw new Error(`Preservation path must be workspace-relative: ${value}`);
  const normalized = path.posix.normalize(candidate.replaceAll(path.sep, "/"));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new Error(`Preservation path escapes the workspace: ${value}`);
  return normalized;
}
function collapseParents(values: string[]): string[] { const sorted = [...new Set(values)].sort(); return sorted.filter((value, index) => !sorted.slice(0, index).some((parent) => value.startsWith(`${parent}/`))); }
function collectPreservationEntries(workspace: string, items: string[]): PreservationEntry[] {
  const entries: PreservationEntry[] = [];
  const visit = (relative: string): void => {
    if (entries.length >= MAX_PRESERVATION_ENTRIES) throw new Error(`Preservation exceeds ${MAX_PRESERVATION_ENTRIES} entries.`);
    if (relative.split("/").some((part) => part.toLowerCase() === ".git")) throw new Error(`Preservation refuses nested .git content: ${relative}`);
    const absolute = path.join(workspace, relative); const info = lstatSync(absolute);
    if (info.isDirectory() && existsSync(path.join(absolute, "HEAD")) && existsSync(path.join(absolute, "objects")) && existsSync(path.join(absolute, "refs"))) throw new Error(`Preservation refuses Git repositories: ${relative}`);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error(`Preservation refuses symlinks and special files: ${relative}`);
    if (!within(path.resolve(absolute), path.resolve(workspace))) throw new Error(`Preservation path escapes the workspace: ${relative}`);
    entries.push({ path: relative, type: info.isDirectory() ? "directory" : "file", bytes: info.isFile() ? info.size : 0, executable: Boolean(info.mode & 0o111) });
    if (info.isDirectory()) { const children: string[] = []; for (const entry of directoryEntries(absolute)) { if (entries.length + children.length >= MAX_PRESERVATION_ENTRIES) throw new Error(`Preservation exceeds ${MAX_PRESERVATION_ENTRIES} entries.`); children.push(entry.name); } children.sort(); for (const child of children) visit(path.posix.join(relative, child)); }
  };
  for (const item of items) visit(item);
  return entries;
}
function noFollowReadStream(value: string) { const fd = openSync(value, fsConstants.O_RDONLY | ((fsConstants as any).O_NOFOLLOW ?? 0)); return createReadStream(value, { fd, autoClose: true }); }
async function hashFile(value: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of noFollowReadStream(value)) hash.update(chunk as Buffer); return hash.digest("hex"); }
async function copyVerifiedFile(source: string, destination: string, expected: PreservationEntry): Promise<void> {
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const sourceBefore = lstatSync(source); if (!sourceBefore.isFile() || sourceBefore.size !== expected.bytes) throw new Error(`Artifact changed during preservation: ${expected.path}`);
  await pipeline(noFollowReadStream(source), createWriteStream(destination, { flags: "wx", mode: expected.executable ? 0o700 : 0o600 }));
  const [sourceHash, destinationHash] = await Promise.all([hashFile(source), hashFile(destination)]);
  const sourceAfter = lstatSync(source); if (sourceBefore.dev !== sourceAfter.dev || sourceBefore.ino !== sourceAfter.ino || sourceBefore.size !== sourceAfter.size || sourceHash !== destinationHash) throw new Error(`Artifact changed or failed verification during preservation: ${expected.path}`);
}
function prunePreservationRecords(registry: WorkerRegistry, workerId: string): void {
  transaction(registry, () => {
    const rows = registry.database.prepare("SELECT preservation_id,status,temp_path FROM preservation_records WHERE worker_id=? ORDER BY created_at DESC,preservation_id DESC").all(workerId) as Array<{ preservation_id: string; status: string; temp_path: string }>;
    if (rows.length <= MAX_PRESERVATION_RECORDS) return;
    const removable = rows.slice(MAX_PRESERVATION_RECORDS).filter((row) => !(row.status === "pending" && existsSync(row.temp_path)));
    const remove = registry.database.prepare("DELETE FROM preservation_records WHERE preservation_id=? AND worker_id=?"); for (const row of removable) remove.run(row.preservation_id, workerId);
  });
}

export type HostLogCleanup = { deleted: string[]; leftovers: Array<{ path: string; reason: string }> };
export function deleteSettledWorkerHostLogs(registry: WorkerRegistry, worker: WorkerRegistryRecord): HostLogCleanup {
  if (worker.status !== "idle" || worker.activeRunId) throw new Error(`Worker ${worker.workerId} is not idle for host-log cleanup.`);
  const runs = workerRunsBounded(registry, worker.workerId); if (runs.some((run) => run.status !== "settled")) throw new Error(`Worker ${worker.workerId} has an unsettled retained run.`);
  const result: HostLogCleanup = { deleted: [], leftovers: [] };
  for (const run of runs) {
    if (!run.jobId || !run.stdoutLog || !run.stderrLog) continue;
    const directory = path.dirname(run.stdoutLog);
    try {
      if (path.basename(directory) !== run.jobId || path.dirname(run.stderrLog) !== directory) throw new Error("registered log paths do not identify the exact job directory");
      const directoryInfo = lstatSync(directory); if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("host-log path is not an ordinary directory");
      const metaPath = path.join(directory, "meta.json"); const metaInfo = lstatSync(metaPath); if (!metaInfo.isFile() || metaInfo.isSymbolicLink() || metaInfo.size > 1024 * 1024) throw new Error("host-log metadata is unsafe or oversized");
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      if (meta.jobId !== run.jobId || meta.command !== `Pi worker host ${worker.workerId}/${run.runId}` || path.resolve(String(meta.stdoutLog ?? "")) !== path.resolve(run.stdoutLog) || path.resolve(String(meta.stderrLog ?? "")) !== path.resolve(run.stderrLog)) throw new Error("host-log metadata identity mismatch");
      const status = meta.status; if (!["exited", "failed", "cancelled", "unknown", "running"].includes(String(status))) throw new Error("host-log status is invalid");
      if (status === "running" || status === "unknown") {
        if (typeof meta.pid !== "number" || typeof meta.processToken !== "string") throw new Error("unsettled host-log process identity is incomplete");
        let alive = true; try { alive = isAsyncJobExecutionAlive(meta.pid, meta.processToken); } catch { alive = true; }
        if (alive) throw new Error("worker host is still live or liveness is ambiguous");
      }
      rmSync(directory, { recursive: true, force: true }); if (existsSync(directory)) throw new Error("host-log directory remains after deletion"); result.deleted.push(directory);
    } catch (error) { result.leftovers.push({ path: directory, reason: error instanceof Error ? error.message : String(error) }); }
  }
  return result;
}

export function preflightWorkerDiscard(registry: WorkerRegistry, parentSessionFile: string, input: { workerIds: string[]; artifactLossAcknowledged?: string[]; allowCrossSession?: boolean }): Array<{ worker: WorkerRegistryRecord; erasedArtifacts: string[] }> {
  if (input.workerIds.length < 1 || input.workerIds.length > 32 || new Set(input.workerIds).size !== input.workerIds.length || input.workerIds.some((id) => !isWorkerId(id))) throw new Error("Discard requires 1 to 32 unique worker IDs.");
  const acknowledgements = new Set(input.artifactLossAcknowledged ?? []); if ([...acknowledgements].some((id) => !input.workerIds.includes(id))) throw new Error("Artifact-loss acknowledgements must be a subset of worker IDs.");
  const chosen = input.workerIds.map((id) => { const worker = getWorker(registry, id); if (!worker) throw new Error(`Unknown worker ${id}.`); if (!input.allowCrossSession && worker.parentSessionFile !== parentSessionFile) throw new Error(`Worker ${id} belongs to another parent session.`); return worker; });
  const selected = new Set(input.workerIds); const failures: string[] = []; const output: Array<{ worker: WorkerRegistryRecord; erasedArtifacts: string[] }> = [];
  for (const worker of chosen) {
    try { assertQuiescent(registry, worker, true); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    if (registry.database.prepare("SELECT 1 FROM runs WHERE worker_id=? AND status!='settled' LIMIT 1").get(worker.workerId)) failures.push(`Worker ${worker.workerId} has an unsettled retained run.`);
    const reviewer = worker.reviewedByWorkerId; if (reviewer && !selected.has(reviewer)) failures.push(`Worker ${worker.workerId} is leased by reviewer ${reviewer}, which is not in the batch.`);
    const claimedDelivery = registry.database.prepare("SELECT delivery_id FROM deliveries WHERE worker_id=? AND state='claimed' LIMIT 1").get(worker.workerId) as { delivery_id: string } | undefined;
    if (claimedDelivery) failures.push(`Worker ${worker.workerId} has claimed delivery ${claimedDelivery.delivery_id}.`);
    const erasedArtifacts = unpreservedArtifacts(registry, worker); if (erasedArtifacts.length && !acknowledgements.has(worker.workerId)) failures.push(`Worker ${worker.workerId} has unpreserved reported artifacts: ${erasedArtifacts.join(", ")}.`);
    output.push({ worker, erasedArtifacts });
  }
  if (failures.length) throw new Error(`Discard preflight failed:\n- ${failures.join("\n- ")}`);
  return output.sort((a, b) => roleOrder(a.worker.role) - roleOrder(b.worker.role));
}
function roleOrder(role: WorkerRegistryRecord["role"]): number { return role === "review" ? 0 : role === "work" ? 1 : 2; }

export function claimPreparedSetDiscard(registry: WorkerRegistry, parentSessionFile: string, preparedId: string, now: string): { partial: boolean } {
  if (!PREPARED_ID.test(preparedId)) throw new Error(`Invalid prepared set ID: ${preparedId}`);
  return transaction(registry, () => {
    const row = registry.database.prepare("SELECT status,apply_nonce FROM prepared_sets WHERE prepared_id=? AND parent_session_file=?").get(preparedId, parentSessionFile) as { status: string; apply_nonce: string | null } | undefined;
    if (!row) throw new Error(`Unknown prepared set ${preparedId} for this parent session.`);
    if (row.apply_nonce !== null || !["ready", "resolution_required", "failed", "partial", "discarding"].includes(row.status)) throw new Error(`Prepared set ${preparedId} cannot be discarded from status ${row.status}.`);
    const changed = registry.database.prepare("UPDATE prepared_sets SET status='discarding',updated_at=? WHERE prepared_id=? AND parent_session_file=? AND apply_nonce IS NULL AND status IN ('ready','resolution_required','failed','partial','discarding')").run(now, preparedId, parentSessionFile);
    if (Number(changed.changes) !== 1) throw new Error(`Prepared set ${preparedId} changed during discard.`);
    return { partial: row.status === "partial" };
  });
}
export function finishPreparedSetDiscard(registry: WorkerRegistry, preparedRoot: string, preparedId: string): void {
  if (!PREPARED_ID.test(preparedId)) throw new Error(`Invalid prepared set ID: ${preparedId}`);
  const target = path.join(path.resolve(preparedRoot), preparedId); if (path.basename(target) !== preparedId || path.dirname(target) !== path.resolve(preparedRoot)) throw new Error("Prepared-set discard path escaped its root.");
  rmSync(target, { recursive: true, force: true });
  transaction(registry, () => { registry.database.prepare("DELETE FROM prepared_sets WHERE prepared_id=? AND status='discarding'").run(preparedId); });
}
export function recoverPreparedSetDiscards(registry: WorkerRegistry, preparedRoot = defaultPreparedMergeRoot()): string[] {
  const rows = registry.database.prepare("SELECT prepared_id FROM prepared_sets WHERE status='discarding'").all() as Array<{ prepared_id: string }>;
  for (const row of rows) finishPreparedSetDiscard(registry, preparedRoot, row.prepared_id); return rows.map((row) => row.prepared_id);
}

export function preflightWorkerAdoption(registry: WorkerRegistry, input: { workerIds: string[]; expectedOwners: Record<string, string>; acknowledgePending: boolean }): void {
  for (const workerId of input.workerIds) {
    const row = registry.database.prepare("SELECT parent_session_file,status,operation_kind,recovery_error,reviewed_by_worker_id FROM workers WHERE worker_id=?").get(workerId) as { parent_session_file: string; status: string; operation_kind: string | null; recovery_error: string | null; reviewed_by_worker_id: string | null } | undefined;
    if (!row || row.parent_session_file !== input.expectedOwners[workerId] || row.status !== "idle" || row.operation_kind !== null || row.recovery_error !== null || (row.reviewed_by_worker_id !== null && !input.workerIds.includes(row.reviewed_by_worker_id))) throw new Error(`Worker ${workerId} is not safely adoptable.`);
    if (registry.database.prepare("SELECT 1 FROM runs WHERE worker_id=? AND claim_kind IS NOT NULL LIMIT 1").get(workerId)) throw new Error(`Worker ${workerId} has a lifecycle claim.`);
    if (registry.database.prepare("SELECT 1 FROM deliveries WHERE worker_id=? AND state='claimed' LIMIT 1").get(workerId)) throw new Error(`Worker ${workerId} has a stranded delivery claim.`);
    if (!input.acknowledgePending && registry.database.prepare("SELECT 1 FROM deliveries WHERE worker_id=? AND state='pending' LIMIT 1").get(workerId)) throw new Error(`Worker ${workerId} has pending results that require explicit preview-bound consent.`);
  }
}

/** Atomically adopts exact idle workers and optionally claims them for discard. Pending deliveries are acknowledged only with preview-bound consent. */
export function adoptWorkers(registry: WorkerRegistry, input: { workerIds: string[]; expectedOwners: Record<string, string>; newParentSessionFile: string; discardNonce?: string; acknowledgePending: boolean; now: string }): void {
  preflightWorkerAdoption(registry, input);
  transaction(registry, () => {
    for (const workerId of input.workerIds) {
      const row = registry.database.prepare("SELECT parent_session_file,status,version,operation_kind,recovery_error,reviewed_by_worker_id,runtime_json FROM workers WHERE worker_id=?").get(workerId) as { parent_session_file: string; status: string; version: number; operation_kind: string | null; recovery_error: string | null; reviewed_by_worker_id: string | null; runtime_json: string } | undefined;
      if (!row || row.parent_session_file !== input.expectedOwners[workerId] || row.status !== "idle" || row.operation_kind !== null || row.recovery_error !== null || (row.reviewed_by_worker_id !== null && !input.workerIds.includes(row.reviewed_by_worker_id))) throw new Error(`Worker ${workerId} is not safely adoptable.`);
      if (registry.database.prepare("SELECT 1 FROM runs WHERE worker_id=? AND claim_kind IS NOT NULL LIMIT 1").get(workerId)) throw new Error(`Worker ${workerId} has a lifecycle claim.`);
      if (registry.database.prepare("SELECT 1 FROM deliveries WHERE worker_id=? AND state='claimed' LIMIT 1").get(workerId)) throw new Error(`Worker ${workerId} has a stranded delivery claim.`);
      if (!input.acknowledgePending && registry.database.prepare("SELECT 1 FROM deliveries WHERE worker_id=? AND state='pending' LIMIT 1").get(workerId)) throw new Error(`Worker ${workerId} has pending results that require explicit preview-bound consent.`);
      if (input.acknowledgePending) registry.database.prepare("UPDATE deliveries SET state='delivered',delivered_at=?,runtime_generation=NULL WHERE worker_id=? AND state='pending'").run(input.now, workerId);
      const runtime = { ...parseJson<Record<string, unknown>>(row.runtime_json), adoptedFromSession: row.parent_session_file, adoptedAt: input.now };
      const changed = registry.database.prepare(`UPDATE workers SET parent_session_file=?,operation_kind=?,operation_nonce=?,runtime_json=?,version=version+1,updated_at=?
        WHERE worker_id=? AND parent_session_file=? AND version=? AND status='idle' AND operation_kind IS NULL`).run(input.newParentSessionFile, input.discardNonce ? "discard" : null, input.discardNonce ?? null, JSON.stringify(runtime), input.now, workerId, row.parent_session_file, row.version);
      if (Number(changed.changes) !== 1) throw new Error(`Worker ${workerId} changed during adoption.`);
    }
  });
}

export function validateCleanupConfirmation(preview: CleanupPreview, token: string): void { if (preview.token !== token) throw new Error(`Cleanup preview changed; confirmation token does not match. New token: ${preview.token}`); }

export function adoptPreparedSetDiscard(registry: WorkerRegistry, input: { preparedId: string; expectedOwner: string; newParentSessionFile: string; now: string }): void {
  if (!PREPARED_ID.test(input.preparedId)) throw new Error(`Invalid prepared set ID: ${input.preparedId}`);
  transaction(registry, () => {
    const changed = registry.database.prepare(`UPDATE prepared_sets SET parent_session_file=?,status='discarding',updated_at=?
      WHERE prepared_id=? AND parent_session_file=? AND apply_nonce IS NULL AND status IN ('ready','resolution_required','failed','partial')`).run(input.newParentSessionFile, input.now, input.preparedId, input.expectedOwner);
    if (Number(changed.changes) !== 1) throw new Error(`Prepared set ${input.preparedId} is not safely adoptable for discard.`);
  });
}

export type CleanupLeftover = { kind: "worker_root" | "worker_trash" | "prepared_root" | "worker_host_log"; id: string; path: string; eligible: boolean; reason: string; device: number; inode: number };
const LEFTOVER_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const LEFTOVER_SCAN_LIMIT = 200_000;

/** Bounded accounting for unregistered physical leftovers. Nothing here deletes automatically. */
function scanCleanupLeftoversDetailed(registry: WorkerRegistry, input: { roots: WorkerRoots; preparedRoot: string; projectCwd: string; now?: Date }): { items: CleanupLeftover[]; partial: boolean; examined: number } {
  const nowMs = (input.now ?? new Date()).getTime(); const deadline = Date.now() + 60_000; const output: CleanupLeftover[] = []; let examined = 0; let partial = false;
  const add = (kind: CleanupLeftover["kind"], id: string, candidate: string, registered: boolean): void => {
    if (registered) return;
    try {
      const info = lstatSync(candidate); if (!info.isDirectory() || info.isSymbolicLink()) return;
      const oldEnough = nowMs - info.mtimeMs >= LEFTOVER_MIN_AGE_MS;
      output.push({ kind, id, path: candidate, eligible: oldEnough, reason: oldEnough ? "Unregistered directory passed the 24-hour age guard." : "Unregistered directory is younger than 24 hours.", device: info.dev, inode: info.ino });
    } catch { /* Concurrent removal is omitted from this snapshot. */ }
  };
  try {
    for (const entry of directoryEntries(path.resolve(input.roots.stateRoot))) {
      if (examined++ >= LEFTOVER_SCAN_LIMIT || Date.now() >= deadline) { partial = true; break; } if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const trashAt = entry.name.indexOf(".discard-"); const workerId = trashAt < 0 ? entry.name : entry.name.slice(0, trashAt);
      if (!isWorkerId(workerId)) continue;
      add(trashAt < 0 ? "worker_root" : "worker_trash", workerId, path.join(path.resolve(input.roots.stateRoot), entry.name), getWorker(registry, workerId) !== undefined);
    }
  } catch { /* Missing/unreadable roots remain fail-closed and produce no deletable entries. */ }
  if (path.resolve(input.roots.workspaceRoot) !== path.resolve(input.roots.stateRoot)) try {
    for (const entry of directoryEntries(path.resolve(input.roots.workspaceRoot))) {
      if (examined++ >= LEFTOVER_SCAN_LIMIT || Date.now() >= deadline) { partial = true; break; } if (!entry.isDirectory() || entry.isSymbolicLink() || !isWorkerId(entry.name)) continue;
      add("worker_root", entry.name, path.join(path.resolve(input.roots.workspaceRoot), entry.name), getWorker(registry, entry.name) !== undefined);
    }
  } catch {}
  try {
    for (const entry of directoryEntries(path.resolve(input.preparedRoot))) {
      if (examined++ >= LEFTOVER_SCAN_LIMIT || Date.now() >= deadline) { partial = true; break; } if (!entry.isDirectory() || entry.isSymbolicLink() || !PREPARED_ID.test(entry.name)) continue;
      const registered = Boolean(registry.database.prepare("SELECT 1 FROM prepared_sets WHERE prepared_id=?").get(entry.name));
      add("prepared_root", entry.name, path.join(path.resolve(input.preparedRoot), entry.name), registered);
    }
  } catch {}
  const jobsRoot = path.join(path.resolve(input.projectCwd), ".pi", "async-shell", "jobs");
  try {
    for (const entry of directoryEntries(jobsRoot)) {
      if (examined++ >= LEFTOVER_SCAN_LIMIT || Date.now() >= deadline) { partial = true; break; } if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(jobsRoot, entry.name); let meta: Record<string, unknown>;
      try { const metaPath = path.join(directory, "meta.json"); const info = lstatSync(metaPath); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) continue; meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>; } catch { continue; }
      const match = typeof meta.command === "string" ? /^Pi worker host (worker_[A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(run_[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(meta.command) : null;
      if (!match || meta.jobId !== entry.name || getWorker(registry, match[1]!) !== undefined) continue;
      let eligible = false; let reason = "Historical worker-host log failed its exact identity or age guard.";
      try {
        const age = nowMs - lstatSync(directory).mtimeMs; const pathsMatch = path.resolve(String(meta.stdoutLog ?? "")) === path.join(directory, "stdout.log") && path.resolve(String(meta.stderrLog ?? "")) === path.join(directory, "stderr.log");
        if (!pathsMatch) reason = "Historical worker-host log paths do not match the exact directory.";
        else if (age < LEFTOVER_MIN_AGE_MS) reason = "Historical worker-host log is younger than 24 hours.";
        else if (["exited", "failed", "cancelled"].includes(String(meta.status))) { eligible = true; reason = "Unregistered settled worker-host log passed identity and age guards."; }
        else if (["unknown", "running"].includes(String(meta.status)) && typeof meta.pid === "number" && typeof meta.processToken === "string") {
          let alive = true; try { alive = isAsyncJobExecutionAlive(meta.pid, meta.processToken); } catch { alive = true; }
          if (!alive) { eligible = true; reason = "Unregistered stale worker-host log has a provably dead process identity."; } else reason = "Worker-host process identity is live or ambiguous.";
        }
      } catch {}
      const identity = lstatSync(directory); output.push({ kind: "worker_host_log", id: entry.name, path: directory, eligible, reason, device: identity.dev, inode: identity.ino });
    }
  } catch {}
  return { items: output.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)), partial, examined };
}
export function scanCleanupLeftovers(registry: WorkerRegistry, input: { roots: WorkerRoots; preparedRoot: string; projectCwd: string; now?: Date }): CleanupLeftover[] { return scanCleanupLeftoversDetailed(registry, input).items; }
function* directoryEntries(directory: string): Generator<import("node:fs").Dirent> { const handle = opendirSync(directory); try { while (true) { const entry = handle.readSync(); if (!entry) return; yield entry; } } finally { handle.closeSync(); } }

export function preflightCleanupLeftovers(registry: WorkerRegistry, expected: CleanupLeftover[], input: { roots: WorkerRoots; preparedRoot: string; projectCwd: string; now?: Date }): void {
  if (expected.length === 0) return;
  const snapshot = scanCleanupLeftovers(registry, input); const byKey = new Map(snapshot.map((item) => [`${item.kind}\0${item.id}\0${item.path}`, item]));
  for (const item of expected) { const current = byKey.get(`${item.kind}\0${item.id}\0${item.path}`); if (!current?.eligible || JSON.stringify(current) !== JSON.stringify(item)) throw new Error(`Cleanup leftover changed or is no longer eligible: ${item.path}`); }
}

/** Revalidates the complete exact previewed leftover batch before deleting any item. */
export function deleteCleanupLeftovers(registry: WorkerRegistry, expected: CleanupLeftover[], input: { roots: WorkerRoots; preparedRoot: string; projectCwd: string; now?: Date; nonce?: string }): void {
  preflightCleanupLeftovers(registry, expected, input);
  const nonce = input.nonce ?? randomUUID().replaceAll("-", "").slice(0, 24);
  for (const item of expected) {
    const info = lstatSync(item.path); if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== item.device || info.ino !== item.inode) throw new Error(`Cleanup leftover identity changed: ${item.path}`);
    const trash = `${item.path}.cleanup-${nonce}`; if (existsSync(trash)) throw new Error(`Cleanup leftover trash path already exists: ${trash}`); renameSync(item.path, trash);
    const moved = lstatSync(trash); if (moved.dev !== item.device || moved.ino !== item.inode) { if (!existsSync(item.path)) renameSync(trash, item.path); throw new Error(`Cleanup leftover changed during claim: ${item.path}`); }
    rmSync(trash, { recursive: true, force: true }); if (existsSync(trash)) throw new Error(`Cleanup leftover remains after deletion: ${trash}`);
  }
}
export function deleteCleanupLeftover(registry: WorkerRegistry, expected: CleanupLeftover, input: { roots: WorkerRoots; preparedRoot: string; projectCwd: string; now?: Date }): void { deleteCleanupLeftovers(registry, [expected], input); }
