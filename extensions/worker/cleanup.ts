import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, closeSync, createReadStream, createWriteStream, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat as lstatAsync, opendir as opendirAsync, readFile as readFileAsync } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { isAsyncJobExecutionAlive } from "../_shared/async-job.js";
import { asyncJobProcessStartToken } from "../_shared/async-job-process.js";
import { isWorkerId } from "../_shared/worker-id.js";
import { defaultPreparedMergeRoot } from "./merge.js";
import { getWorker, getWorkerRun, listAllWorkers, listWorkerRuns, listWorkers, type WorkerRegistry, type WorkerRegistryRecord, type WorkerRunRecord } from "./registry.js";
import { workerPaths, type WorkerRoots } from "./identity.js";

export type CleanupClass = "active" | "recovery" | "undelivered" | "unknown:task_missing" | "unknown:beads_unavailable" | "retained" | "due" | "leased";
export type BeadsTaskFact = { id: string; status: string };
export type OwnerSessionIdentity = { file: string; state: "named" | "unnamed" | "missing" | "unreadable" | "truncated"; id?: string; name?: string; label: string; truncated?: boolean };
export type CleanupDelivery = { deliveryId: string; runId: string; state: "pending" | "claimed"; runtimeGeneration?: number; sendStartedAt?: string; outcome?: string; summary?: string };
export type CleanupWorkerItem = {
  workerId: string; ownerSession: string; owner: OwnerSessionIdentity; role: WorkerRegistryRecord["role"]; class: CleanupClass; reason: string;
  version: number; latestRunId?: string; reviewedByWorkerId?: string; taskIds: string[]; taskFacts: Array<{ id: string; status: string }>;
  unpreservedArtifacts: string[]; additionalUnpreservedArtifacts: number; pendingResults: CleanupDelivery[]; additionalPendingResults: number; additionalPendingPreservations: number; after?: string; recoveryError?: string; preservations: ReturnType<typeof preservationRecords>;
};
export type PreparedCleanupItem = { preparedId: string; ownerSession: string; owner:OwnerSessionIdentity; status: string; class: "due" | "retained" | "explicit_decision" | "partial" | "claimed" | "discarding"; taskIds: string[]; taskFacts:Array<{id:string;status:string}>; reason: string };
export type CleanupInventory = { workers: CleanupWorkerItem[]; prepared: PreparedCleanupItem[]; leftovers: CleanupLeftover[]; total: { workers: number; prepared: number; leftovers: number }; scan: { partial: boolean; examinedWorkers: number; totalWorkers: number; examinedFilesystemEntries: number; roots: Array<{ root: string; examined: number; partial: boolean; position?:number }>; continuation?:CleanupScanState }; generatedAt: string };
export type CleanupOwnerAuthority = { state: "current" | "retired" | "dead" | "live" | "ambiguous" | "missing"; generation?: number; members?: Array<{ generation: number; runtimeId: string; pid: number; processStartToken: string; retired: boolean; liveness: string }> };
export type CleanupSnapshotWorker = { item: CleanupWorkerItem; status: string; operationKind?: string; operationNonce?: string; runClaims: Array<{ runId: string; claimKind: string; claimNonce?: string }>; authority: CleanupOwnerAuthority; runtime: Record<string, unknown> };
export type CleanupSnapshotPrepared = PreparedCleanupItem & { applyNonce?: string; authority:CleanupOwnerAuthority };
export type CleanupSnapshot = { version: 2; parentSessionFile: string; createdAt: string; workers: CleanupSnapshotWorker[]; prepared: CleanupSnapshotPrepared[]; leftovers: CleanupLeftover[]; scan: CleanupInventory["scan"] };
export type PersistedCleanupPreview = { token: string; snapshotHash: string; snapshot: CleanupSnapshot };


const execFileAsync = promisify(execFile);
const PREPARED_ID = /^prepared_[0-9a-f]{24}$/;
const MAX_TASKS_PER_READ = 50;
const MAX_BEADS_OUTPUT = 8 * 1024 * 1024;
const MAX_PRESERVATION_ENTRIES = 50_000;
const MAX_PRESERVATION_BYTES = 1024 * 1024 * 1024;

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
function cleanupHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
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
  const maximum=4096;const runs: WorkerRunRecord[] = []; let offset = 0; let total = 0;
  while (runs.length < maximum) { const page = listWorkerRuns(registry, workerId, Math.min(100, maximum - runs.length), offset); total = page.total; runs.push(...page.runs); if (page.nextOffset === undefined) break; offset = page.nextOffset; }
  if (runs.length < total) throw new Error(`Worker ${workerId} run inventory exceeds the ${maximum}-run bound.`); return runs;
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
function hasUndelivered(registry: WorkerRegistry, workerId: string): boolean { return Boolean(registry.database.prepare("SELECT 1 FROM deliveries WHERE worker_id=? AND state!='delivered' LIMIT 1").get(workerId)); }
function pendingResults(registry: WorkerRegistry, workerId: string): {items:CleanupDelivery[];additional:number} {
  const total=Number((registry.database.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE worker_id=? AND state!='delivered'").get(workerId) as {count:number|bigint}).count);const rows = registry.database.prepare(`SELECT d.delivery_id,d.run_id,d.state,d.runtime_generation,d.send_started_at,r.outcome,r.summary FROM deliveries d JOIN runs r ON r.run_id=d.run_id
    WHERE d.worker_id=? AND d.state!='delivered' ORDER BY d.created_at,d.delivery_id LIMIT 256`).all(workerId) as Array<{ delivery_id: string; run_id: string; state: "pending" | "claimed"; runtime_generation: number | null; send_started_at: string | null; outcome: string | null; summary: string | null }>;
  return {items:rows.map((row) => ({ deliveryId: row.delivery_id, runId: row.run_id, state: row.state, ...(row.runtime_generation === null ? {} : { runtimeGeneration: row.runtime_generation }), ...(row.send_started_at === null ? {} : { sendStartedAt: row.send_started_at }), ...(row.outcome ? { outcome: row.outcome } : {}), ...(row.summary ? { summary: boundedSummary(row.summary) } : {}) })),additional:Math.max(0,total-rows.length)};
}
function ownerSessionIdentity(sessionFile: string): OwnerSessionIdentity {
  const exact=path.resolve(sessionFile);if(!existsSync(exact))return{file:exact,state:"missing",label:exact};
  try{
    const info=lstatSync(exact);if(!info.isFile()||info.isSymbolicLink()||info.size>512*1024*1024)return{file:exact,state:"unreadable",label:exact};
    const fd=openSync(exact,fsConstants.O_RDONLY|((fsConstants as any).O_NOFOLLOW??0));const bound=64*1024,truncated=info.size>bound;let head="",tail="";
    try{const first=Buffer.allocUnsafe(Math.min(bound,Number(info.size)));const firstBytes=readSync(fd,first,0,first.length,0);head=first.subarray(0,firstBytes).toString("utf8");const tailStart=Math.max(0,Number(info.size)-bound);const last=Buffer.allocUnsafe(Number(info.size)-tailStart);const lastBytes=readSync(fd,last,0,last.length,tailStart);tail=last.subarray(0,lastBytes).toString("utf8");}finally{closeSync(fd);}
    let id:string|undefined;try{const header=JSON.parse(head.split("\n",1)[0]??"") as Record<string,unknown>;if(typeof header.id==="string"&&header.id.length<=256)id=header.id;}catch{}
    const completeHead=truncated?head.slice(0,Math.max(0,head.lastIndexOf("\n")+1)):head;const firstTailNewline=tail.indexOf("\n"),completeTail=truncated?(firstTailNewline<0?"":tail.slice(firstTailNewline+1)):tail;
    let name:string|undefined,sawHead=false,sawTail=false;const readNames=(text:string,tailWindow:boolean)=>{for(const line of text.split("\n")){if(!line)continue;try{const entry=JSON.parse(line) as Record<string,unknown>;if(entry.type==="session_info"&&typeof entry.name==="string"&&entry.name.length<=256){if(tailWindow)sawTail=true;else sawHead=true;const next=entry.name.trim();name=next||undefined;}}catch{}}};readNames(completeHead,false);readNames(completeTail,true);
    const state:OwnerSessionIdentity["state"]=sawTail?(name?"named":"unnamed"):truncated?"truncated":name?"named":"unnamed";
    return{file:exact,state,...(id?{id}:{}),...(name?{name}:{}),label:name??id??exact,...(truncated?{truncated:true}:{})};
  }catch{return{file:exact,state:"unreadable",label:exact};}
}
function baseCleanupClass(registry: WorkerRegistry, worker: WorkerRegistryRecord, facts: Map<string, BeadsTaskFact | "missing" | "unavailable">): { kind: CleanupClass; reason: string } {
  if (worker.status !== "idle" || worker.operationKind || hasRunClaim(registry, worker.workerId)) return { kind: "active", reason: "Worker or lifecycle operation is active." };
  if (worker.recoveryError) return { kind: "recovery", reason: worker.recoveryError };
  if (hasUndelivered(registry, worker.workerId)) return { kind: "undelivered", reason: "A completion result is not durably delivered." };
  if (worker.taskIds.length === 0 || worker.taskIds.some((id) => facts.get(id) === "missing")) return { kind: "unknown:task_missing", reason: "An assigned personal Beads task is missing or mismatched." };
  if (worker.taskIds.some((id) => facts.get(id) === "unavailable" || !facts.has(id))) return { kind: "unknown:beads_unavailable", reason: "Central personal Beads facts are unavailable." };
  if (worker.taskIds.some((id) => (facts.get(id) as BeadsTaskFact).status !== "closed")) return { kind: "retained", reason: "At least one assigned task is open." };
  return { kind: "due", reason: "All assigned tasks are closed." };
}
export function classifyCleanupWorker(registry: WorkerRegistry, worker: WorkerRegistryRecord, facts: Map<string, BeadsTaskFact | "missing" | "unavailable">): CleanupWorkerItem {
  let { kind, reason } = baseCleanupClass(registry, worker, facts); let after: string | undefined;
  if (kind === "due" && worker.reviewedByWorkerId) {
    const reviewer = getWorker(registry, worker.reviewedByWorkerId); const reviewerClass = reviewer ? baseCleanupClass(registry, reviewer, facts).kind : "unknown:task_missing";
    if (reviewerClass === "due") { after = `reviewer ${worker.reviewedByWorkerId}`; reason = `All assigned tasks are closed; discard after reviewer ${worker.reviewedByWorkerId}.`; }
    else { kind = "leased"; reason = `Worker is leased by reviewer ${worker.reviewedByWorkerId}, which is not due.`; }
  }
  const taskFacts = worker.taskIds.map((id) => { const fact = facts.get(id); return { id, status: fact === "missing" ? "missing" : fact === "unavailable" || !fact ? "unavailable" : fact.status }; });
  let artifacts:string[]=[];let preservations:ReturnType<typeof preservationRecords>=[];let evidenceError:string|undefined;try{artifacts=unpreservedArtifacts(registry,worker);preservations=preservationRecords(registry,worker.workerId);}catch(error){evidenceError=`Cleanup evidence accounting failed: ${error instanceof Error?error.message:String(error)}`;kind="recovery";reason=evidenceError;}const pending=pendingResults(registry,worker.workerId);const pendingPreservationTotal=Number((registry.database.prepare("SELECT COUNT(*) AS count FROM preservation_records WHERE worker_id=? AND status='pending'").get(worker.workerId) as {count:number|bigint}).count);return { workerId: worker.workerId, ownerSession: worker.parentSessionFile, owner: ownerSessionIdentity(worker.parentSessionFile), role: worker.role, class: kind, reason, version: worker.version, ...(worker.latestRunId ? { latestRunId: worker.latestRunId } : {}), ...(worker.reviewedByWorkerId ? { reviewedByWorkerId: worker.reviewedByWorkerId } : {}), taskIds: worker.taskIds, taskFacts, unpreservedArtifacts: artifacts.slice(0,256),additionalUnpreservedArtifacts:Math.max(0,artifacts.length-256), pendingResults: pending.items,additionalPendingResults:pending.additional, preservations,additionalPendingPreservations:Math.max(0,pendingPreservationTotal-preservations.filter((record)=>record.status==="pending").length), ...(after ? { after } : {}), ...(worker.recoveryError||evidenceError ? { recoveryError: worker.recoveryError??evidenceError } : {}) };
}

type PreparedRow = { prepared_id: string; parent_session_file: string; status: string; task_ids_json: string; apply_nonce: string | null };
function listPreparedRows(registry: WorkerRegistry, parent: string | undefined, limit: number, offset: number): { rows: PreparedRow[]; total: number } {
  const total = Number(((parent ? registry.database.prepare("SELECT COUNT(*) AS count FROM prepared_sets WHERE parent_session_file=?").get(parent) : registry.database.prepare("SELECT COUNT(*) AS count FROM prepared_sets").get()) as { count: number }).count);
  const rows = (parent
    ? registry.database.prepare("SELECT prepared_id,parent_session_file,status,task_ids_json,apply_nonce FROM prepared_sets WHERE parent_session_file=? ORDER BY updated_at DESC,prepared_id LIMIT ? OFFSET ?").all(parent, limit, offset)
    : registry.database.prepare("SELECT prepared_id,parent_session_file,status,task_ids_json,apply_nonce FROM prepared_sets ORDER BY parent_session_file,updated_at DESC,prepared_id LIMIT ? OFFSET ?").all(limit, offset)) as PreparedRow[];
  return { rows, total };
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
  const lineage=preparedTaskLineage(registry,row),taskIds=lineage.taskIds,owner=ownerSessionIdentity(row.parent_session_file);const taskFacts=taskIds.map((id)=>{const fact=facts.get(id);return{id,status:fact==="missing"?"missing":fact==="unavailable"||!fact?"unavailable":fact.status};});const value=(className:PreparedCleanupItem["class"],reason:string):PreparedCleanupItem=>({preparedId:row.prepared_id,ownerSession:row.parent_session_file,owner,status:row.status,class:className,taskIds,taskFacts,reason});
  if(row.status==="discarding")return value("discarding","A committed discard must be finished.");
  if(row.apply_nonce!==null)return value("claimed","Prepared apply is claimed.");
  if(lineage.missingRepository||taskIds.length===0||taskFacts.some((fact)=>fact.status==="missing"))return value("explicit_decision","Task ownership is missing.");
  if(taskFacts.some((fact)=>fact.status==="unavailable"))return value("retained","Central personal Beads facts are unavailable.");
  if(taskFacts.some((fact)=>fact.status!=="closed"))return value("retained","An inherited task is open.");
  if(row.status==="partial")return value("partial","Application is partial and requires an explicit decision.");
  if(!["ready","resolution_required","failed"].includes(row.status))return value("explicit_decision",`Prepared status ${row.status} is not cleanup-eligible.`);
  return value("due","All inherited tasks are closed.");
}

export function preparedCleanupTaskIds(registry:WorkerRegistry,preparedIds:string[]):string[]{const rows=preparedIds.map((preparedId)=>{const row=registry.database.prepare("SELECT prepared_id,parent_session_file,status,task_ids_json,apply_nonce FROM prepared_sets WHERE prepared_id=?").get(preparedId) as PreparedRow|undefined;if(!row)throw new Error(`Unknown prepared set ${preparedId}.`);return row;});return[...new Set(rows.flatMap((row)=>preparedTaskLineage(registry,row).taskIds))];}
export function classifyPreparedCleanupIds(registry:WorkerRegistry,preparedIds:string[],facts:Map<string,BeadsTaskFact|"missing"|"unavailable">):PreparedCleanupItem[]{return preparedIds.map((preparedId)=>{const row=registry.database.prepare("SELECT prepared_id,parent_session_file,status,task_ids_json,apply_nonce FROM prepared_sets WHERE prepared_id=?").get(preparedId) as PreparedRow|undefined;if(!row)throw new Error(`Unknown prepared set ${preparedId}.`);return classifyPrepared(registry,row,facts);});}

export async function buildCleanupInventory(registry: WorkerRegistry, input: { parentSessionFile: string; allSessions: boolean; cwd: string; bdPath?: string; now?: Date; roots?: WorkerRoots; preparedRoot?: string; limit?: number; offset?: number; scanState?:CleanupScanState }): Promise<CleanupInventory> {
  const limit = Math.max(1, Math.min(100, input.limit ?? 100)); const offset = Math.max(0, input.offset ?? 0);
  const workerPage = input.allSessions ? listAllWorkers(registry, limit, offset) : listWorkers(registry, { parentSessionFile: input.parentSessionFile, limit, offset });
  const workers = workerPage.workers; const preparedPage = listPreparedRows(registry, input.allSessions ? undefined : input.parentSessionFile, limit, offset); const prepared = preparedPage.rows;
  const ids = [...new Set([...workers.flatMap((worker) => worker.taskIds), ...prepared.flatMap((row) => preparedTaskLineage(registry, row).taskIds)])];
  const facts = await readCleanupBeadsFacts(ids, { cwd: input.cwd, ...(input.bdPath ? { bdPath: input.bdPath } : {}) });
  const leftoverScan=input.allSessions&&input.roots?await scanCleanupLeftoversDetailed(registry,{roots:input.roots,preparedRoot:input.preparedRoot??defaultPreparedMergeRoot(),projectCwd:input.cwd,now:input.now,limit,state:input.scanState}):{items:[] as CleanupLeftover[],matched:0,partial:false,examined:0,roots:[] as Array<{root:string;examined:number;partial:boolean;after?:string}>,continuation:undefined};if(leftoverScan.items.length)persistCleanupLeftoverObservations(registry,leftoverScan.items,(input.now??new Date()).toISOString());
  const leftovers = leftoverScan.items; const partial = workerPage.total > offset + workers.length || preparedPage.total > offset + prepared.length || leftoverScan.partial;
  return { workers: workers.map((worker) => classifyCleanupWorker(registry, worker, facts)), prepared: prepared.map((row) => classifyPrepared(registry, row, facts)), leftovers, total: { workers: workerPage.total, prepared: preparedPage.total, leftovers: leftoverScan.matched }, scan:{partial,examinedWorkers:workers.length,totalWorkers:workerPage.total,examinedFilesystemEntries:leftoverScan.examined,roots:leftoverScan.roots,...(leftoverScan.continuation?{continuation:leftoverScan.continuation}:{})}, generatedAt: (input.now ?? new Date()).toISOString() };
}
export type PreservationResult = { preservationId: string; destination: string; items: string[]; entries: number; bytes: number };
type PreservationEntry = { path: string; type: "file" | "directory"; bytes: number; executable: boolean };
type WalkEntry = PreservationEntry & { source: string; device: number; inode: number };

export async function preserveWorkerArtifacts(registry: WorkerRegistry, roots: WorkerRoots, runtimeRoot: string, input: { workerId: string; destination: string; projectCwd: string; paths?: string[]; now?: Date; nonce?: string }): Promise<PreservationResult> {
  const worker = getWorker(registry, input.workerId); if (!worker) throw new Error(`Unknown worker ${input.workerId}.`);
  assertQuiescent(registry, worker, true);
  const paths = workerPaths(roots, worker.workerId); if (!existsSync(paths.stateDir)) throw new Error(`Worker state is missing for ${worker.workerId}; preservation requires recovery.`);
  const destination = resolveSafeDestination(input.destination, runtimeRoot, roots, worker.workspaceRoot, input.projectCwd);
  const selected = input.paths ? input.paths.map(normalizeRequiredWorkspacePointer) : reportedArtifacts(registry, worker);
  if (selected.length === 0) throw new Error("No existing worker artifacts were selected for preservation.");
  const items = collapseParents(selected); if (items.length !== selected.length && input.paths) throw new Error("Preservation paths must not overlap."); if (items.length > 32) throw new Error("Preservation selects more than 32 distinct artifact roots; provide a bounded parent directory selection.");
  if (items.includes("worker-preservation.json")) throw new Error("worker-preservation.json is reserved for the preservation manifest.");
  const now = input.now ?? new Date(); const nonce = input.nonce ?? randomUUID().replaceAll("-", "");
  const preservationId = `preservation_${nonce.slice(0, 24)}`; const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.worker-preserve-${nonce.slice(0, 24)}`);
  const lockPath = path.join(path.dirname(destination), `.${path.basename(destination)}.worker-preserve.lock`);
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });assertNoSymlinkAncestors(destination);
  const lock = acquirePreservationLock(lockPath, preservationId, destination, nonce);
  let publicationRenamed = false; let recordInserted = false;
  try {
    const pendingRows=registry.database.prepare("SELECT * FROM preservation_records WHERE worker_id=? AND status='pending' AND destination=? ORDER BY created_at DESC,preservation_id DESC LIMIT 257").all(worker.workerId,destination) as Array<Record<string,any>>;if(pendingRows.length>256)throw new Error("Pending preservation recovery exceeds the exact 256-record bound.");const priorPending=pendingRows.map((row)=>({id:row.preservation_id,status:row.status as "pending",destination:row.destination,tempPath:row.temp_path,...(row.latest_run_id===null?{}:{latestRunId:row.latest_run_id}),items:parseJson<string[]>(row.items_json),...(row.error===null?{}:{error:row.error})}));
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
    transaction(registry, () => registry.database.prepare(`INSERT INTO preservation_records(preservation_id,worker_id,status,destination,temp_path,latest_run_id,items_json,created_at,updated_at)
        VALUES(?,?,'pending',?,?,?,?,?,?)`).run(preservationId, worker.workerId, destination, tempPath, worker.latestRunId ?? null, JSON.stringify(items), now.toISOString(), now.toISOString())); recordInserted = true;
    if (existsSync(destination)) throw new Error(`Preservation destination already exists: ${destination}`);
    const entries = await collectPreservationEntries(worker.workspaceRoot, items);
    mkdirSync(tempPath, { recursive: false, mode: 0o700 });
    let bytes = 0;
    for (const entry of entries.filter((item) => item.type === "directory")) mkdirSync(path.join(tempPath, entry.path), { recursive: true, mode: 0o700 });
    const files = entries.filter((item) => item.type === "file");
    for (let offset = 0; offset < files.length; offset += 4) await Promise.all(files.slice(offset, offset + 4).map(async (entry) => { await copyVerifiedFile(entry, path.join(tempPath, entry.path)); bytes += entry.bytes; }));
    for (const entry of entries.filter((item) => item.type === "directory")) assertSourceIdentity(entry);
    const publicEntries = entries.map(({ source: _source, device: _device, inode: _inode, ...entry }) => entry);
    const manifest = { version: 1, preservedAt: now.toISOString(), workerId: worker.workerId, role: worker.role, taskIds: worker.taskIds, sourceWorkspace: realpathSync(worker.workspaceRoot), latestRunIdAtStart: worker.latestRunId, items, entries: publicEntries, totals: { entries: entries.length, bytes } };
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(tempPath, "worker-preservation.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 }));
    const current = getWorker(registry, worker.workerId); if (!current || current.latestRunId !== worker.latestRunId) throw new Error("Worker latest run changed during preservation.");
    assertQuiescent(registry, current, true);assertNoSymlinkAncestors(destination); if (existsSync(destination)) throw new Error(`Preservation destination appeared during publication: ${destination}`);
    const staged=lstatSync(tempPath);await execFileAsync("/bin/mv", ["-n", tempPath, destination], { maxBuffer: 64 * 1024 });
    if (existsSync(tempPath) || !existsSync(destination)) throw new Error(`Preservation destination appeared during atomic no-overwrite publication: ${destination}`);const published=lstatSync(destination);if(!published.isDirectory()||published.isSymbolicLink()||Number(published.dev)!==Number(staged.dev)||Number(published.ino)!==Number(staged.ino)){const nested=path.join(destination,path.basename(tempPath));try{const moved=lstatSync(nested);if(!moved.isSymbolicLink()&&Number(moved.dev)===Number(staged.dev)&&Number(moved.ino)===Number(staged.ino)&&!existsSync(tempPath))renameSync(nested,tempPath);}catch{}throw new Error(`Preservation destination won the atomic no-overwrite publication race: ${destination}`);}publicationRenamed = true;
    const changed = transaction(registry, () => registry.database.prepare("UPDATE preservation_records SET status='published',manifest_json=?,updated_at=? WHERE preservation_id=? AND status='pending'").run(JSON.stringify(manifest), new Date().toISOString(), preservationId));
    if (Number(changed.changes) !== 1) throw new Error("Pending preservation record changed during publication.");
    return { preservationId, destination, items, entries: entries.length, bytes };
  } catch (error) {
    if (publicationRenamed || (existsSync(destination) && !existsSync(tempPath) && recordInserted)) throw new Error(`Preservation publication requires exact pending-record recovery: ${error instanceof Error ? error.message : String(error)}`);
    let removed = false; try { rmSync(tempPath, { recursive: true, force: true }); removed = !existsSync(tempPath); } catch {}
    if (recordInserted) transaction(registry, () => registry.database.prepare("UPDATE preservation_records SET status='failed',error=?,updated_at=? WHERE preservation_id=? AND status='pending'").run(`${error instanceof Error ? error.message : String(error)}${removed ? "" : " (temporary path remains)"}`.slice(0, 2000), new Date().toISOString(), preservationId));
    throw error;
  } finally { releasePreservationLock(lockPath, lock); }
}
type PreservationLockIdentity = { device: number; inode: number; metadata: string };
function acquirePreservationLock(lockPath: string, preservationId: string, destination: string, nonce: string): PreservationLockIdentity {
  const processStartToken=asyncJobProcessStartToken(process.pid);if(typeof processStartToken!=="string")throw new Error("Cannot capture exact preservation-lock process identity.");
  const candidate=`${lockPath}.${nonce.slice(0,24)}`;const metadata=JSON.stringify({version:1,pid:process.pid,processStartToken,preservationId,destination});let fd:number|undefined;
  try{fd=openSync(candidate,fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL,0o600);writeFileSync(fd,metadata);closeSync(fd);fd=undefined;
    for(let attempt=0;attempt<2;attempt+=1){try{linkSync(candidate,lockPath);const info=lstatSync(lockPath);if(!info.isFile()||info.isSymbolicLink())throw new Error("Preservation publication lock is unsafe.");return{device:Number(info.dev),inode:Number(info.ino),metadata};}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;const info=lstatSync(lockPath);if(!info.isFile()||info.isSymbolicLink()||info.size>8192)throw new Error("Preservation publication lock is unsafe or ambiguous.");let owner:{pid?:unknown;processStartToken?:unknown};const ownerMetadata=readFileSync(lockPath,"utf8");try{owner=JSON.parse(ownerMetadata) as typeof owner;}catch{throw new Error("Preservation publication lock owner is unreadable.");}if(typeof owner.pid!=="number"||typeof owner.processStartToken!=="string")throw new Error("Preservation publication lock owner is invalid.");const current=asyncJobProcessStartToken(owner.pid);let dead=current!==undefined&&current!==owner.processStartToken;if(current===owner.processStartToken)dead=false;if(current===undefined){try{process.kill(owner.pid,0);dead=false;}catch(killError){dead=(killError as NodeJS.ErrnoException).code==="ESRCH";}}if(!dead)throw new Error("Preservation destination is locked by a live or ambiguous publisher.");const stable=readFileSync(lockPath,"utf8");if(stable!==ownerMetadata)throw new Error("Preservation publication lock changed during stale-owner recovery.");const again=lstatSync(lockPath);if(!again.isFile()||again.isSymbolicLink()||Number(again.dev)!==Number(info.dev)||Number(again.ino)!==Number(info.ino))throw new Error("Preservation publication lock changed during stale-owner recovery.");unlinkSync(lockPath);}
    }throw new Error("Preservation publication lock could not be acquired.");
  }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(candidate);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
}
function releasePreservationLock(lockPath:string,identity:PreservationLockIdentity):void{try{const info=lstatSync(lockPath);if(!info.isFile()||info.isSymbolicLink()||info.size>8192||readFileSync(lockPath,"utf8")!==identity.metadata)return;const again=lstatSync(lockPath);if(Number(again.dev)===Number(info.dev)&&Number(again.ino)===Number(info.ino))unlinkSync(lockPath);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}

async function verifyPublishedPreservation(destination: string, worker: WorkerRegistryRecord, items: string[]): Promise<{ manifest: Record<string, unknown>; entries: number; bytes: number }> {
  const manifestPath = path.join(destination, "worker-preservation.json"); const info = lstatSync(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error("Existing preservation manifest is missing, unsafe, or oversized.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>;
  if (manifest.version !== 1 || manifest.workerId !== worker.workerId || manifest.latestRunIdAtStart !== worker.latestRunId || JSON.stringify(manifest.items) !== JSON.stringify(items) || !Array.isArray(manifest.entries)) throw new Error("Existing preservation manifest does not match this exact worker run and item set.");
  const current = (await collectPreservationEntries(worker.workspaceRoot, items)).map(({ source: _source, device: _device, inode: _inode, ...entry }) => entry);
  const target = (await collectPreservationEntries(destination, items)).map(({ source: _source, device: _device, inode: _inode, ...entry }) => entry); const expected = manifest.entries as PreservationEntry[];
  if (JSON.stringify(current) !== JSON.stringify(expected) || JSON.stringify(target) !== JSON.stringify(expected)) throw new Error("Existing preservation tree does not match the pending publication manifest.");
  for (const entry of expected.filter((item) => item.type === "file")) { const [sourceHash, targetHash] = await Promise.all([hashFile(sourcePathNoFollow(worker.workspaceRoot, entry.path)), hashFile(sourcePathNoFollow(destination, entry.path))]); if (sourceHash !== targetHash) throw new Error(`Existing preservation file does not match its source: ${entry.path}`); }
  const bytes = expected.reduce((total, entry) => total + (entry.type === "file" ? entry.bytes : 0), 0); return { manifest, entries: expected.length, bytes };
}

function assertQuiescent(registry: WorkerRegistry, worker: WorkerRegistryRecord, allowReviewLease = false): void {
  if (worker.status !== "idle" || worker.activeRunId || worker.operationKind || hasRunClaim(registry, worker.workerId)) throw new Error(`Worker ${worker.workerId} is not quiescent.`);
  if (!allowReviewLease && worker.reviewedByWorkerId) throw new Error(`Worker ${worker.workerId} has a review lease.`);
}
function resolveSafeDestination(destination: string, runtimeRoot: string, roots: WorkerRoots, workspace: string, projectCwd:string): string {
  if (!path.isAbsolute(destination) || Buffer.byteLength(destination) > 4096 || destination.includes("\0")) throw new Error("Preservation destination must be an absolute path of at most 4096 bytes.");
  const resolved = resolveNearestExisting(destination);assertNoSymlinkAncestors(resolved);
  const components=resolved.split(path.sep).filter(Boolean).map(asciiPathFold);if(components.includes(".git"))throw new Error("Preservation destination cannot contain a resolved .git component.");if(components.includes(".pi"))throw new Error("Preservation destination cannot contain a case-folded .pi component.");
  const home = homedir();
  const sensitive = [runtimeRoot, roots.stateRoot, roots.workspaceRoot, workspace,path.join(projectCwd,".pi"),path.join(projectCwd,".pi","extensions"), path.join(home, ".pi"), path.join(home, ".ssh"), path.join(home, ".aws"), path.join(home, ".gnupg"), path.join(home, ".config"), path.join(home, ".docker"), path.join(home, ".kube"), path.join(home, ".local", "share", "agent"), process.env.XDG_CONFIG_HOME, process.env.AWS_SHARED_CREDENTIALS_FILE, process.env.AWS_CONFIG_FILE, process.env.KUBECONFIG, process.env.DOCKER_CONFIG, process.env.NPM_CONFIG_USERCONFIG, process.env.BEADS_DIR].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const forbidden of sensitive) { const absolute=path.resolve(forbidden),canonical = resolveNearestExisting(absolute); if (within(resolved, canonical)) throw new Error("Preservation destination is inside managed worker or sensitive storage."); }
  if(existingAncestorIdentityOverlap(resolved,sensitive))throw new Error("Preservation destination aliases managed worker or sensitive storage by filesystem identity.");
  return resolved;
}
export function existingAncestorIdentityOverlap(destination:string,forbiddenRoots:string[],identity:(value:string)=>{dev:number|bigint;ino:number|bigint}=statSync):boolean{const ancestors=existingAncestorPaths(destination).map((value)=>{const info=identity(value);return{device:Number(info.dev),inode:Number(info.ino)}});for(const root of forbiddenRoots){if(!existsSync(root))continue;const info=identity(root);if(ancestors.some((item)=>item.device===Number(info.dev)&&item.inode===Number(info.ino)))return true;}return false;}
function existingAncestorPaths(value:string):string[]{let cursor=path.resolve(value);while(!existsSync(cursor)){const parent=path.dirname(cursor);if(parent===cursor)return[];cursor=parent;}const output:string[]=[];while(true){output.push(cursor);const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}return output;}
function assertNoSymlinkAncestors(value:string):void{const resolved=path.resolve(value);const parsed=path.parse(resolved);let cursor=parsed.root;for(const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,component);try{const info=lstatSync(cursor);if(info.isSymbolicLink())throw new Error(`Preservation destination has a symlink ancestor: ${cursor}`);if(!info.isDirectory()&&cursor!==resolved)throw new Error(`Preservation destination ancestor is not a directory: ${cursor}`);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}}}
function resolveNearestExisting(value:string):string{let cursor=path.resolve(value);const suffix:string[]=[];while(!existsSync(cursor)){const parent=path.dirname(cursor);if(parent===cursor)break;suffix.unshift(path.basename(cursor));cursor=parent;}const real=realpathSync(cursor),info=statSync(real);if(!info.isDirectory()&&suffix.length)throw new Error("Preservation destination ancestor is not a directory.");return path.join(real,...suffix);}
function assertPreservationTemporaryPath(destination: string, tempPath: string): void { const prefix = `.${path.basename(destination)}.worker-preserve-`; if (path.dirname(tempPath) !== path.dirname(destination) || !path.basename(tempPath).startsWith(prefix) || path.basename(tempPath).length !== prefix.length + 24) throw new Error("Pending preservation temporary path is inconsistent with its trusted destination."); }
function asciiPathFold(value:string):string{return value.replace(/[A-Z]/g,(character)=>character.toLowerCase());}
function within(candidate:string,root:string):boolean{const relative=path.relative(asciiPathFold(root),asciiPathFold(candidate));return relative===""||(!relative.startsWith("..")&&!path.isAbsolute(relative));}
function normalizeWorkspacePointer(value: string): string | undefined { try { return normalizeRequiredWorkspacePointer(value); } catch { return undefined; } }
function normalizeRequiredWorkspacePointer(value: string): string { if (Buffer.byteLength(value) > 4096 || value.includes("\0")) throw new Error("Invalid preservation path."); const candidate = value.startsWith("/workspace/") ? value.slice(11) : value; if (path.isAbsolute(candidate)) throw new Error(`Preservation path must be workspace-relative: ${value}`); const normalized = path.posix.normalize(candidate.replaceAll(path.sep, "/")); if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new Error(`Preservation path escapes the workspace: ${value}`); return normalized; }
function collapseParents(values: string[]): string[] { const sorted = [...new Set(values)].sort(); return sorted.filter((value, index) => !sorted.slice(0, index).some((parent) => value.startsWith(`${parent}/`))); }

async function collectPreservationEntries(workspace: string, items: string[]): Promise<WalkEntry[]> {
  const root = realpathSync(workspace); const rootInfo = lstatSync(root); if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Worker workspace root is not an ordinary directory.");
  const entries: WalkEntry[] = []; let totalBytes = 0; const pending = [...items].reverse();
  while (pending.length) {
    const relative = pending.pop()!; if (relative.split("/").some((part) => part.toLowerCase() === ".git")) throw new Error(`Preservation refuses nested .git content: ${relative}`);
    const source = sourcePathNoFollow(root, relative); const info = await lstatAsync(source);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error(`Preservation refuses symlinks and special files: ${relative}`);
    if (info.isDirectory() && existsSync(path.join(source, "HEAD")) && existsSync(path.join(source, "objects")) && existsSync(path.join(source, "refs"))) throw new Error(`Preservation refuses Git repositories: ${relative}`);
    if (entries.length >= MAX_PRESERVATION_ENTRIES) throw new Error(`Preservation exceeds ${MAX_PRESERVATION_ENTRIES} entries.`);
    if (info.isFile()) { totalBytes += info.size; if (totalBytes > MAX_PRESERVATION_BYTES) throw new Error("Preservation exceeds the 1 GiB byte bound."); }
    entries.push({ path: relative, type: info.isDirectory() ? "directory" : "file", bytes: info.isFile() ? info.size : 0, executable: Boolean(info.mode & 0o111), source, device: info.dev, inode: info.ino });
    if (info.isDirectory()) { const names: string[] = []; const dir = await opendirAsync(source); try { for await (const child of dir) {if(entries.length+names.length>=MAX_PRESERVATION_ENTRIES)throw new Error(`Preservation exceeds ${MAX_PRESERVATION_ENTRIES} entries.`);names.push(child.name);} } finally { try { await dir.close(); } catch {} } names.sort().reverse(); for (const name of names) pending.push(path.posix.join(relative, name)); }
    if (entries.length % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return entries;
}
function sourcePathNoFollow(workspace: string, relative: string): string { const root = realpathSync(workspace); let cursor = root; for (const component of relative.split("/")) { if (!component || component === "." || component === "..") throw new Error(`Preservation path escapes the workspace: ${relative}`); cursor = path.join(cursor, component); const info = lstatSync(cursor); if (info.isSymbolicLink()) throw new Error(`Preservation refuses symlink ancestors: ${relative}`); } if (!within(cursor, root)) throw new Error(`Preservation path escapes the workspace: ${relative}`); return cursor; }
function noFollowReadStream(value: string) { const fd = openSync(value, fsConstants.O_RDONLY | ((fsConstants as any).O_NOFOLLOW ?? 0)); return createReadStream(value, { fd, autoClose: true }); }
async function hashFile(value: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of noFollowReadStream(value)) hash.update(chunk as Buffer); return hash.digest("hex"); }
function assertSourceIdentity(entry: WalkEntry): void { const info = lstatSync(entry.source); if ((entry.type === "file" ? !info.isFile() : !info.isDirectory()) || info.isSymbolicLink() || info.dev !== entry.device || info.ino !== entry.inode || (entry.type === "file" && info.size !== entry.bytes)) throw new Error(`Artifact changed during preservation: ${entry.path}`); }
async function copyVerifiedFile(entry: WalkEntry, destination: string): Promise<void> { mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 }); assertSourceIdentity(entry); await pipeline(noFollowReadStream(entry.source), createWriteStream(destination, { flags: "wx", mode: entry.executable ? 0o700 : 0o600 })); const [sourceHash, destinationHash] = await Promise.all([hashFile(entry.source), hashFile(destination)]); assertSourceIdentity(entry); if (sourceHash !== destinationHash) throw new Error(`Artifact changed or failed verification during preservation: ${entry.path}`); }
export type HostLogPlan = { deletable: Array<{ path: string; device: number; inode: number; metaPath:string; metaDevice:number; metaInode:number; metaSize:number; metaHash:string }>; absent: string[]; skipped: string[]; leftovers: Array<{ path: string; reason: string }> };
export function planSettledWorkerHostLogs(registry: WorkerRegistry, worker: WorkerRegistryRecord): HostLogPlan {
  if (worker.status !== "idle" || worker.activeRunId) throw new Error(`Worker ${worker.workerId} is not idle for host-log cleanup.`);
  const runs = workerRunsBounded(registry, worker.workerId); if (runs.some((run) => run.status !== "settled")) throw new Error(`Worker ${worker.workerId} has an unsettled retained run.`);
  const result: HostLogPlan = { deletable: [], absent: [], skipped: [], leftovers: [] };
  for (const run of runs) {
    if (!run.jobId || !run.stdoutLog || !run.stderrLog) { result.skipped.push(run.runId); continue; }
    const directory = path.dirname(run.stdoutLog); const pseudo = path.basename(directory) !== run.jobId && path.basename(run.stdoutLog).startsWith("launch-") && path.basename(run.stderrLog).startsWith("launch-");
    if (pseudo) { result.skipped.push(run.runId); continue; }
    try {
      if (path.basename(directory) !== run.jobId || path.dirname(run.stderrLog) !== directory) throw new Error("registered log paths do not identify the exact job directory");
      if (!existsSync(directory)) { result.absent.push(directory); continue; }
      const directoryInfo = lstatSync(directory); if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("host-log path is not an ordinary directory");
      const metaPath = path.join(directory, "meta.json"); const metaInfo = lstatSync(metaPath); if (!metaInfo.isFile() || metaInfo.isSymbolicLink() || metaInfo.size > 1024 * 1024) throw new Error("host-log metadata is unsafe or oversized");
      const metaText=readFileSync(metaPath,"utf8");const meta = JSON.parse(metaText) as Record<string, unknown>;
      if (meta.jobId !== run.jobId || meta.command !== `Pi worker host ${worker.workerId}/${run.runId}` || path.resolve(String(meta.stdoutLog ?? "")) !== path.resolve(run.stdoutLog) || path.resolve(String(meta.stderrLog ?? "")) !== path.resolve(run.stderrLog)) throw new Error("host-log metadata identity mismatch");
      const status = String(meta.status); if (!["exited","failed","cancelled","unknown","running"].includes(status)) throw new Error("host-log status is invalid");
      if (status === "running" || status === "unknown") { if (typeof meta.pid !== "number" || typeof meta.processToken !== "string") throw new Error("unsettled host-log process identity is incomplete"); let alive = true; try { alive = isAsyncJobExecutionAlive(meta.pid, meta.processToken); } catch { alive = true; } if (alive) throw new Error("worker host is still live or liveness is ambiguous"); }
      result.deletable.push({ path: directory, device: Number(directoryInfo.dev), inode: Number(directoryInfo.ino),metaPath,metaDevice:Number(metaInfo.dev),metaInode:Number(metaInfo.ino),metaSize:Number(metaInfo.size),metaHash:createHash("sha256").update(metaText).digest("hex") });
    } catch (error) { result.leftovers.push({ path: directory, reason: error instanceof Error ? error.message : String(error) }); }
  }
  return result;
}
export function deletePlannedWorkerHostLogs(plan: HostLogPlan): string[] {
  const appeared=plan.absent.find((directory)=>existsSync(directory));if(appeared)throw new Error(`A worker host-log directory appeared after preflight: ${appeared}`);
  if(plan.leftovers.length)throw new Error(`Worker host logs could not be deleted safely: ${plan.leftovers.map((item)=>`${item.path}: ${item.reason}`).join("; ")}`);
  const deleted:string[]=[];
  for(const item of plan.deletable){
    if(!existsSync(item.path)){deleted.push(item.path);continue;}
    const directory=lstatSync(item.path);if(!directory.isDirectory()||directory.isSymbolicLink()||Number(directory.dev)!==item.device||Number(directory.ino)!==item.inode)throw new Error(`Worker host log identity changed before irreversible deletion: ${item.path}`);
    const metadata=lstatSync(item.metaPath);if(!metadata.isFile()||metadata.isSymbolicLink()||Number(metadata.dev)!==item.metaDevice||Number(metadata.ino)!==item.metaInode||Number(metadata.size)!==item.metaSize)throw new Error(`Worker host-log metadata changed before irreversible deletion: ${item.path}`);
    const metaHash=createHash("sha256").update(readFileSync(item.metaPath)).digest("hex"),metadataAfter=lstatSync(item.metaPath);if(metaHash!==item.metaHash||!metadataAfter.isFile()||metadataAfter.isSymbolicLink()||Number(metadataAfter.dev)!==item.metaDevice||Number(metadataAfter.ino)!==item.metaInode||Number(metadataAfter.size)!==item.metaSize)throw new Error(`Worker host-log metadata changed before irreversible deletion: ${item.path}`);
    rmSync(item.path,{recursive:true,force:true});if(existsSync(item.path))throw new Error(`Worker host log remains after deletion: ${item.path}`);deleted.push(item.path);
  }
  return deleted;
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
    const undelivered = registry.database.prepare("SELECT delivery_id,state FROM deliveries WHERE worker_id=? AND state!='delivered' ORDER BY created_at LIMIT 1").get(worker.workerId) as { delivery_id: string; state: string } | undefined;
    if (undelivered) failures.push(`Worker ${worker.workerId} has ${undelivered.state} delivery ${undelivered.delivery_id}; use cleanup_preview/cleanup_apply for explicit takeover.`);
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
    if (row.status !== "discarding") { const changed = registry.database.prepare("UPDATE prepared_sets SET status='discarding',updated_at=? WHERE prepared_id=? AND parent_session_file=? AND apply_nonce IS NULL AND status=?").run(now, preparedId, parentSessionFile, row.status); if (Number(changed.changes) !== 1) throw new Error(`Prepared set ${preparedId} changed during discard.`); }
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

function exactWorkerRows(registry: WorkerRegistry, workerIds: string[]): WorkerRegistryRecord[] { return workerIds.map((workerId) => { const worker=getWorker(registry,workerId); if(!worker) throw new Error(`Unknown worker ${workerId}.`); return worker; }); }
function leaseClosure(registry: WorkerRegistry, workerIds: string[]): string[] {
  const selected=new Set(workerIds); let changed=true; while(changed){ changed=false; for(const worker of exactWorkerRows(registry,[...selected])) { if(worker.reviewedByWorkerId && !selected.has(worker.reviewedByWorkerId)){selected.add(worker.reviewedByWorkerId);changed=true;} const subject=registry.database.prepare("SELECT worker_id FROM workers WHERE reviewed_by_worker_id=?").get(worker.workerId) as {worker_id:string}|undefined;if(subject){const bindingRunId=worker.activeRunId??worker.latestRunId;const run=bindingRunId?getWorkerRun(registry,worker.workerId,bindingRunId):undefined;const binding=run?.binding;if(worker.role!=="review"||!binding||!("reviewedWorkerId" in binding)||binding.reviewedWorkerId!==subject.worker_id)throw new Error(`Reviewer ${worker.workerId} has an inconsistent subject lease.`);if(!selected.has(subject.worker_id)){selected.add(subject.worker_id);changed=true;}} } }
  if(selected.size>32) throw new Error("Lease-connected cleanup selection exceeds 32 workers."); return [...selected];
}
export async function createCleanupSnapshot(registry: WorkerRegistry, input: { parentSessionFile: string; workerIds?: string[]; preparedIds?: string[]; leftoverIds?: string[]; cwd: string; roots: WorkerRoots; preparedRoot: string; bdPath?: string; now?: Date; ownerAuthority: (owner: string) => CleanupOwnerAuthority }): Promise<PersistedCleanupPreview> {
  const requestedWorkers=input.workerIds??[]; const preparedIds=input.preparedIds??[]; const leftoverIds=input.leftoverIds??[]; if(!requestedWorkers.length&&!preparedIds.length&&!leftoverIds.length) throw new Error("cleanup_preview requires at least one exact worker, prepared-set, or leftover ID.");
  const workerIds=leaseClosure(registry,requestedWorkers); const workerRows=exactWorkerRows(registry,workerIds); const preparedRows=preparedIds.map((preparedId)=>{ const row=registry.database.prepare("SELECT prepared_id,parent_session_file,status,task_ids_json,apply_nonce FROM prepared_sets WHERE prepared_id=?").get(preparedId) as PreparedRow|undefined; if(!row) throw new Error(`Unknown prepared set ${preparedId}.`); return row; });
  const taskIds=[...new Set([...workerRows.flatMap((worker)=>worker.taskIds),...preparedRows.flatMap((row)=>preparedTaskLineage(registry,row).taskIds)])]; const facts=await readCleanupBeadsFacts(taskIds,{cwd:input.cwd,...(input.bdPath?{bdPath:input.bdPath}:{})});
  const currentParent=resolveNearestExisting(input.parentSessionFile);
  const workers:CleanupSnapshotWorker[]=workerRows.map((worker)=>{ const runClaims=registry.database.prepare("SELECT run_id,claim_kind,claim_nonce FROM runs WHERE worker_id=? AND claim_kind IS NOT NULL ORDER BY run_id LIMIT 257").all(worker.workerId) as Array<{run_id:string;claim_kind:string;claim_nonce:string|null}>;if(runClaims.length>256)throw new Error(`Worker ${worker.workerId} lifecycle claims exceed the exact preview bound.`); return { item:classifyCleanupWorker(registry,worker,facts),status:worker.status,...(worker.operationKind?{operationKind:worker.operationKind}:{}),...(worker.operationNonce?{operationNonce:worker.operationNonce}:{}),runClaims:runClaims.map((row)=>({runId:row.run_id,claimKind:row.claim_kind,...(row.claim_nonce?{claimNonce:row.claim_nonce}:{})})),authority:input.ownerAuthority(worker.parentSessionFile),runtime:worker.runtime??{} }; });
  for(const worker of workers)if(worker.item.ownerSession===currentParent&&worker.item.pendingResults.length)throw new Error(`Current-session worker ${worker.item.workerId} has non-delivered results and is not cleanup-eligible.`);
  const prepared:CleanupSnapshotPrepared[]=preparedRows.map((row)=>({...classifyPrepared(registry,row,facts),...(row.apply_nonce?{applyNonce:row.apply_nonce}:{}),authority:input.ownerAuthority(row.parent_session_file)}));
  const leftovers=observedCleanupLeftovers(registry,leftoverIds);await preflightCleanupLeftovers(registry,leftovers,{roots:input.roots,preparedRoot:input.preparedRoot,projectCwd:input.cwd,now:input.now});const leftoverScan={partial:false,examined:leftovers.length,roots:[] as Array<{root:string;examined:number;partial:boolean}>};
  const snapshot:CleanupSnapshot={version:2,parentSessionFile:currentParent,createdAt:(input.now??new Date()).toISOString(),workers:workers.sort((a,b)=>a.item.workerId.localeCompare(b.item.workerId)),prepared:prepared.sort((a,b)=>a.preparedId.localeCompare(b.preparedId)),leftovers:leftovers.sort((a,b)=>a.leftoverId.localeCompare(b.leftoverId)),scan:{partial:leftoverScan.partial,examinedWorkers:workerRows.length,totalWorkers:workerRows.length,examinedFilesystemEntries:leftoverScan.examined,roots:leftoverScan.roots}};
  const token=`cleanup_${createHash("sha256").update(randomUUID()+cleanupHash(snapshot)).digest("hex").slice(0,48)}`; const snapshotHash=cleanupHash({...snapshot,createdAt:""});
  transaction(registry,()=>{ registry.database.prepare("UPDATE cleanup_snapshots SET consumed_at=? WHERE parent_session_file=? AND consumed_at IS NULL").run(snapshot.createdAt,snapshot.parentSessionFile); registry.database.prepare("INSERT INTO cleanup_snapshots(token,parent_session_file,snapshot_json,snapshot_hash,created_at) VALUES(?,?,?,?,?)").run(token,snapshot.parentSessionFile,JSON.stringify(snapshot),snapshotHash,snapshot.createdAt);pruneCleanupControlRowsInTransaction(registry); });
  return {token,snapshotHash,snapshot};
}
export function loadCleanupSnapshot(registry: WorkerRegistry,parentSessionFile:string,token:string):PersistedCleanupPreview { const row=registry.database.prepare("SELECT snapshot_json,snapshot_hash,consumed_at FROM cleanup_snapshots WHERE token=? AND parent_session_file=?").get(token,resolveNearestExisting(parentSessionFile)) as {snapshot_json:string;snapshot_hash:string;consumed_at:string|null}|undefined; if(!row)throw new Error("Unknown cleanup snapshot token.");if(row.consumed_at)throw new Error("Cleanup snapshot token was already consumed.");return {token,snapshotHash:row.snapshot_hash,snapshot:parseJson<CleanupSnapshot>(row.snapshot_json)}; }
export function consumeCleanupSnapshot(registry:WorkerRegistry,parentSessionFile:string,token:string,expectedHash:string,now:string):void { const result=transaction(registry,()=>{const changed=registry.database.prepare("UPDATE cleanup_snapshots SET consumed_at=? WHERE token=? AND parent_session_file=? AND snapshot_hash=? AND consumed_at IS NULL").run(now,token,resolveNearestExisting(parentSessionFile),expectedHash);pruneCleanupControlRowsInTransaction(registry);return changed;});if(Number(result.changes)!==1)throw new Error("Cleanup snapshot changed or was already consumed."); }
export function invalidateCleanupSnapshot(registry:WorkerRegistry,parentSessionFile:string,token:string,now:string):void{transaction(registry,()=>{registry.database.prepare("UPDATE cleanup_snapshots SET consumed_at=? WHERE token=? AND parent_session_file=? AND consumed_at IS NULL").run(now,token,resolveNearestExisting(parentSessionFile));pruneCleanupControlRowsInTransaction(registry);});}
export async function revalidateCleanupSnapshot(registry:WorkerRegistry,preview:PersistedCleanupPreview,input:{cwd:string;roots:WorkerRoots;preparedRoot:string;bdPath?:string;now?:Date;ownerAuthority:(owner:string)=>CleanupOwnerAuthority}):Promise<PersistedCleanupPreview>{ const current=await createCleanupSnapshotUnstored(registry,{...input,parentSessionFile:preview.snapshot.parentSessionFile,workerIds:preview.snapshot.workers.map((item)=>item.item.workerId),preparedIds:preview.snapshot.prepared.map((item)=>item.preparedId),leftoverIds:preview.snapshot.leftovers.map((item)=>item.leftoverId)}); if(current.snapshotHash!==preview.snapshotHash)throw new Error("Cleanup snapshot is stale; request a new cleanup_preview.");return {...current,token:preview.token}; }
async function createCleanupSnapshotUnstored(registry:WorkerRegistry,input:{parentSessionFile:string;workerIds:string[];preparedIds:string[];leftoverIds:string[];cwd:string;roots:WorkerRoots;preparedRoot:string;bdPath?:string;now?:Date;ownerAuthority:(owner:string)=>CleanupOwnerAuthority}):Promise<PersistedCleanupPreview>{
  const workerRows=exactWorkerRows(registry,input.workerIds); const preparedRows=input.preparedIds.map((preparedId)=>{const row=registry.database.prepare("SELECT prepared_id,parent_session_file,status,task_ids_json,apply_nonce FROM prepared_sets WHERE prepared_id=?").get(preparedId) as PreparedRow|undefined;if(!row)throw new Error(`Unknown prepared set ${preparedId}.`);return row;}); const taskIds=[...new Set([...workerRows.flatMap((w)=>w.taskIds),...preparedRows.flatMap((r)=>preparedTaskLineage(registry,r).taskIds)])]; const facts=await readCleanupBeadsFacts(taskIds,{cwd:input.cwd,...(input.bdPath?{bdPath:input.bdPath}:{})});
  const workers=workerRows.map((worker)=>{const runClaims=registry.database.prepare("SELECT run_id,claim_kind,claim_nonce FROM runs WHERE worker_id=? AND claim_kind IS NOT NULL ORDER BY run_id LIMIT 257").all(worker.workerId) as Array<{run_id:string;claim_kind:string;claim_nonce:string|null}>;if(runClaims.length>256)throw new Error(`Worker ${worker.workerId} lifecycle claims exceed the exact preview bound.`);return {item:classifyCleanupWorker(registry,worker,facts),status:worker.status,...(worker.operationKind?{operationKind:worker.operationKind}:{}),...(worker.operationNonce?{operationNonce:worker.operationNonce}:{}),runClaims:runClaims.map((r)=>({runId:r.run_id,claimKind:r.claim_kind,...(r.claim_nonce?{claimNonce:r.claim_nonce}:{})})),authority:input.ownerAuthority(worker.parentSessionFile),runtime:worker.runtime??{}} satisfies CleanupSnapshotWorker;});
  const currentParent=resolveNearestExisting(input.parentSessionFile);for(const worker of workers)if(worker.item.ownerSession===currentParent&&worker.item.pendingResults.length)throw new Error(`Current-session worker ${worker.item.workerId} has non-delivered results and is not cleanup-eligible.`);
  const prepared=preparedRows.map((row)=>({...classifyPrepared(registry,row,facts),...(row.apply_nonce?{applyNonce:row.apply_nonce}:{}),authority:input.ownerAuthority(row.parent_session_file)})); const leftovers=observedCleanupLeftovers(registry,input.leftoverIds);await preflightCleanupLeftovers(registry,leftovers,{roots:input.roots,preparedRoot:input.preparedRoot,projectCwd:input.cwd,now:input.now});const scan={partial:false,examined:leftovers.length,roots:[] as Array<{root:string;examined:number;partial:boolean}>}; const snapshot:CleanupSnapshot={version:2,parentSessionFile:currentParent,createdAt:"",workers:workers.sort((a,b)=>a.item.workerId.localeCompare(b.item.workerId)),prepared:prepared.sort((a,b)=>a.preparedId.localeCompare(b.preparedId)),leftovers:leftovers.sort((a,b)=>a.leftoverId.localeCompare(b.leftoverId)),scan:{partial:scan.partial,examinedWorkers:workerRows.length,totalWorkers:workerRows.length,examinedFilesystemEntries:scan.examined,roots:scan.roots}};return {token:"",snapshotHash:cleanupHash(snapshot),snapshot};
}

export function adoptCleanupWorkers(registry:WorkerRegistry,input:{snapshots:CleanupSnapshotWorker[];newParentSessionFile:string;claimWorkerIds:string[];nonce:string;now:string;pendingAcknowledged:Set<string>;claimedAcknowledged:Set<string>;recoveryAcknowledged?:Set<string>;consent?:{token:string;snapshotHash:string;openTaskAbandonmentAcknowledged:string[];artifactLossAcknowledged:string[];pendingDeliveryTakeoverAcknowledged:string[];claimedDeliveryTakeoverAcknowledged:string[];recoveryAcknowledged:string[]};ownerAuthority:(owner:string)=>CleanupOwnerAuthority}):void { transaction(registry,()=>{ const selected=new Set(input.snapshots.map((s)=>s.item.workerId)); for(const snap of input.snapshots){if(snap.item.additionalPendingResults||snap.item.additionalUnpreservedArtifacts||snap.item.additionalPendingPreservations)throw new Error(`Worker ${snap.item.workerId} cleanup evidence exceeds the exact preview bound.`);const authority=input.ownerAuthority(snap.item.ownerSession);if(JSON.stringify(authority)!==JSON.stringify(snap.authority))throw new Error(`Owner authority for ${snap.item.workerId} changed before adoption.`);if(snap.item.ownerSession!==path.resolve(input.newParentSessionFile)&&!["dead","retired","missing"].includes(authority.state))throw new Error(`Owner of ${snap.item.workerId} is live or ambiguous.`);const row=registry.database.prepare("SELECT parent_session_file,status,latest_run_id,version,operation_kind,recovery_error,reviewed_by_worker_id,runtime_json FROM workers WHERE worker_id=?").get(snap.item.workerId) as {parent_session_file:string;status:string;latest_run_id:string|null;version:number;operation_kind:string|null;recovery_error:string|null;reviewed_by_worker_id:string|null;runtime_json:string}|undefined;if(!row||row.parent_session_file!==snap.item.ownerSession||row.version!==snap.item.version||row.latest_run_id!==(snap.item.latestRunId??null)||row.status!=="idle"||row.operation_kind||(row.recovery_error!==null&&(row.recovery_error!==snap.item.recoveryError||!input.recoveryAcknowledged?.has(snap.item.workerId)))||row.reviewed_by_worker_id!==(snap.item.reviewedByWorkerId??null)||(row.reviewed_by_worker_id&&!selected.has(row.reviewed_by_worker_id))||row.runtime_json!==JSON.stringify(snap.runtime))throw new Error(`Worker ${snap.item.workerId} changed before adoption.`);if(registry.database.prepare("SELECT 1 FROM runs WHERE worker_id=? AND claim_kind IS NOT NULL LIMIT 1").get(snap.item.workerId))throw new Error(`Worker ${snap.item.workerId} has a lifecycle claim.`);const deliveries=registry.database.prepare("SELECT d.delivery_id,d.run_id,d.state,d.runtime_generation,d.send_started_at,r.outcome,r.summary FROM deliveries d JOIN runs r ON r.run_id=d.run_id WHERE d.worker_id=? AND d.state!='delivered' ORDER BY d.created_at,d.delivery_id").all(snap.item.workerId) as Array<{delivery_id:string;run_id:string;state:string;runtime_generation:number|null;send_started_at:string|null;outcome:string|null;summary:string|null}>;if(JSON.stringify(deliveries.map((d)=>({deliveryId:d.delivery_id,runId:d.run_id,state:d.state,...(d.runtime_generation===null?{}:{runtimeGeneration:d.runtime_generation}),...(d.send_started_at===null?{}:{sendStartedAt:d.send_started_at}),...(d.outcome?{outcome:d.outcome}:{}),...(d.summary?{summary:boundedSummary(d.summary)}:{})})))!==JSON.stringify(snap.item.pendingResults))throw new Error(`Worker ${snap.item.workerId} delivery evidence changed.`);for(const delivery of deliveries){const acknowledged=delivery.state==="pending"?input.pendingAcknowledged.has(snap.item.workerId):input.claimedAcknowledged.has(snap.item.workerId);if(!acknowledged)throw new Error(`Worker ${snap.item.workerId} ${delivery.state} delivery lacks exact takeover acknowledgement.`);const changed=delivery.state==="pending"?registry.database.prepare("UPDATE deliveries SET state='delivered',delivered_at=?,runtime_generation=NULL WHERE delivery_id=? AND state='pending'").run(input.now,delivery.delivery_id):registry.database.prepare("UPDATE deliveries SET state='delivered',delivered_at=?,runtime_generation=NULL WHERE delivery_id=? AND state='claimed' AND runtime_generation=?").run(input.now,delivery.delivery_id,delivery.runtime_generation);if(Number(changed.changes)!==1)throw new Error(`Delivery ${delivery.delivery_id} changed during takeover.`);}const runtime={...parseJson<Record<string,unknown>>(row.runtime_json),adoptedFromSession:row.parent_session_file,adoptedAt:input.now,...(input.consent?{cleanupConsent:{...input.consent,workerId:snap.item.workerId,taskFacts:snap.item.taskFacts,recoveryError:snap.item.recoveryError??null}}:{})};const claim=input.claimWorkerIds.includes(snap.item.workerId);if(claim&&row.reviewed_by_worker_id)throw new Error(`Leased subject ${snap.item.workerId} cannot be claimed before its reviewer is discarded.`);const changed=registry.database.prepare("UPDATE workers SET parent_session_file=?,operation_kind=?,operation_nonce=?,recovery_error=?,runtime_json=?,version=version+1,updated_at=? WHERE worker_id=? AND parent_session_file=? AND version=? AND status='idle' AND operation_kind IS NULL AND recovery_error IS ?").run(resolveNearestExisting(input.newParentSessionFile),claim?"discard":null,claim?input.nonce:null,claim?null:row.recovery_error,JSON.stringify(runtime),input.now,snap.item.workerId,row.parent_session_file,row.version,row.recovery_error);if(Number(changed.changes)!==1)throw new Error(`Worker ${snap.item.workerId} changed during adoption.`);} }); }

export function adoptPreparedSetDiscard(registry: WorkerRegistry, input: { preparedId: string; expectedOwner: string; newParentSessionFile: string; now: string; expectedAuthority:CleanupOwnerAuthority; ownerAuthority:(owner:string)=>CleanupOwnerAuthority }): void {
  if (!PREPARED_ID.test(input.preparedId)) throw new Error(`Invalid prepared set ID: ${input.preparedId}`);
  transaction(registry, () => {
    const authority=input.ownerAuthority(input.expectedOwner);if(JSON.stringify(authority)!==JSON.stringify(input.expectedAuthority)||!["dead","retired","missing"].includes(authority.state))throw new Error(`Prepared-set owner authority changed or remains live/ambiguous.`);
    const changed = registry.database.prepare(`UPDATE prepared_sets SET parent_session_file=?,status='discarding',updated_at=?
      WHERE prepared_id=? AND parent_session_file=? AND apply_nonce IS NULL AND status IN ('ready','resolution_required','failed','partial')`).run(input.newParentSessionFile, input.now, input.preparedId, input.expectedOwner);
    if (Number(changed.changes) !== 1) throw new Error(`Prepared set ${input.preparedId} is not safely adoptable for discard.`);
  });
}

export type CleanupLeftover = { leftoverId: string; kind: "worker_root" | "worker_trash" | "prepared_root" | "worker_host_log" | "cleanup_trash"; id: string; path: string; eligible: boolean; reason: string; device: number; inode: number; mtimeMs: number };
export type CleanupRootCursor={position:number;complete:boolean;missing?:boolean;device?:number;inode?:number;mtimeMs?:number;ctimeMs?:number};
export type CleanupScanState={version:2;scopeHash:string;matched:number;positions:Record<string,CleanupRootCursor>};
const LEFTOVER_MIN_AGE_MS=24*60*60*1000;
const LEFTOVER_ROOT_PAGE=5_000;
const LEFTOVER_ROOT_DEADLINE_MS=10_000;
type CleanupLeftoverClaim={claimId:string;sourceLeftoverId:string;sourceKind:Exclude<CleanupLeftover["kind"],"cleanup_trash">;originalId:string;entryName:string;sourcePath:string;trashPath:string;rootPath:string;device:number;inode:number;nonce:string;ownerPid:number;ownerStartToken:string;createdAt:string};
function leftoverIdentity(kind:CleanupLeftover["kind"],id:string,candidate:string,device:number,inode:number):string{return `leftover_${createHash("sha256").update(`${kind}\0${id}\0${candidate}\0${device}\0${inode}`).digest("hex").slice(0,24)}`;}
function leftoverRecord(kind:CleanupLeftover["kind"],id:string,candidate:string,info:{dev:number|bigint;ino:number|bigint;mtimeMs:number|bigint},eligible:boolean,reason:string):CleanupLeftover{const device=Number(info.dev),inode=Number(info.ino),mtimeMs=Number(info.mtimeMs);return{leftoverId:leftoverIdentity(kind,id,candidate,device,inode),kind,id,path:candidate,eligible,reason,device,inode,mtimeMs};}
function scanScope(input:{roots:WorkerRoots;preparedRoot:string;projectCwd:string}):{roots:string[];scopeHash:string}{const roots=[path.resolve(input.roots.stateRoot),path.resolve(input.roots.workspaceRoot),path.resolve(input.preparedRoot),path.join(path.resolve(input.projectCwd),".pi","async-shell","jobs")];return{roots,scopeHash:cleanupHash(roots.map((root)=>asciiPathFold(resolveNearestExisting(root))))};}
function cleanupClaimRow(row:Record<string,unknown>):CleanupLeftoverClaim{return{claimId:String(row.claim_id),sourceLeftoverId:String(row.source_leftover_id),sourceKind:String(row.source_kind) as CleanupLeftoverClaim["sourceKind"],originalId:String(row.original_id),entryName:String(row.entry_name),sourcePath:String(row.source_path),trashPath:String(row.trash_path),rootPath:String(row.root_path),device:Number(row.device),inode:Number(row.inode),nonce:String(row.nonce),ownerPid:Number(row.owner_pid),ownerStartToken:String(row.owner_start_token),createdAt:String(row.created_at)};}
function cleanupClaimForTrash(registry:WorkerRegistry,trashPath:string):CleanupLeftoverClaim|undefined{const row=registry.database.prepare("SELECT * FROM cleanup_leftover_claims WHERE trash_path=?").get(path.resolve(trashPath)) as Record<string,unknown>|undefined;return row?cleanupClaimRow(row):undefined;}
function cleanupTrashCandidate(registry:WorkerRegistry,candidate:string,info:{dev:number|bigint;ino:number|bigint;mtimeMs:number|bigint}):CleanupLeftover{
  const suffix=/\.cleanup-([a-f0-9]{24})$/.exec(path.basename(candidate)),entryName=suffix?path.basename(candidate).slice(0,-suffix[0].length):"",claim=cleanupClaimForTrash(registry,candidate);let id=entryName,eligible=false,reason="Cleanup trash lacks exact host-owned claim evidence.";
  if(suffix&&claim&&claim.nonce===suffix[1]&&claim.trashPath===path.resolve(candidate)&&claim.sourcePath===path.resolve(candidate.slice(0,-suffix[0].length))&&claim.rootPath===path.dirname(claim.sourcePath)&&claim.entryName===entryName&&claim.device===Number(info.dev)&&claim.inode===Number(info.ino)&&claim.sourceLeftoverId===leftoverIdentity(claim.sourceKind,claim.originalId,claim.sourcePath,claim.device,claim.inode)&&!existsSync(claim.sourcePath)){id=claim.originalId;eligible=true;reason="Interrupted explicit cleanup trash retains exact host-owned claim evidence.";}
  return leftoverRecord("cleanup_trash",id,candidate,info,eligible,reason);
}
function workerRootCandidate(registry:WorkerRegistry,name:string,candidate:string,info:any,nowMs:number):CleanupLeftover|undefined{const cleanupAt=name.lastIndexOf(".cleanup-");if(cleanupAt>0)return cleanupTrashCandidate(registry,candidate,info);const discardAt=name.indexOf(".discard-"),workerId=discardAt<0?name:name.slice(0,discardAt);if(!isWorkerId(workerId)||getWorker(registry,workerId))return;const oldEnough=nowMs-Number(info.mtimeMs)>=LEFTOVER_MIN_AGE_MS;return leftoverRecord(discardAt<0?"worker_root":"worker_trash",workerId,candidate,info,oldEnough,oldEnough?"Unregistered worker directory passed the 24-hour age guard.":"Unregistered worker directory is younger than 24 hours.");}
function preparedRootCandidate(registry:WorkerRegistry,name:string,candidate:string,info:any,nowMs:number):CleanupLeftover|undefined{const cleanupAt=name.lastIndexOf(".cleanup-");if(cleanupAt>0)return cleanupTrashCandidate(registry,candidate,info);if(!/^prepared_[0-9a-f]{24}$/.test(name)||registry.database.prepare("SELECT 1 FROM prepared_sets WHERE prepared_id=?").get(name))return;const oldEnough=nowMs-Number(info.mtimeMs)>=LEFTOVER_MIN_AGE_MS;return leftoverRecord("prepared_root",name,candidate,info,oldEnough,oldEnough?"Unregistered prepared directory passed the 24-hour age guard.":"Unregistered prepared directory is younger than 24 hours.");}
async function hostLogCandidate(registry:WorkerRegistry,name:string,directory:string,info:any,nowMs:number):Promise<CleanupLeftover|undefined>{const cleanupAt=name.lastIndexOf(".cleanup-");if(cleanupAt>0)return cleanupTrashCandidate(registry,directory,info);let meta:Record<string,unknown>;try{const metaPath=path.join(directory,"meta.json"),metadata=await lstatAsync(metaPath);if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>1024*1024)return;meta=JSON.parse(await readFileAsync(metaPath,"utf8")) as Record<string,unknown>;}catch{return;}const match=typeof meta.command==="string"?/^Pi worker host (worker_[A-Za-z0-9][A-Za-z0-9_-]{0,127})\/(run_[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(meta.command):null;if(!match||meta.jobId!==name||getWorker(registry,match[1]!))return;const pathsMatch=path.resolve(String(meta.stdoutLog??""))===path.join(directory,"stdout.log")&&path.resolve(String(meta.stderrLog??""))===path.join(directory,"stderr.log");let eligible=false,reason="Historical worker-host log failed its exact identity guard.";const age=nowMs-Number(info.mtimeMs);if(!pathsMatch)reason="Historical worker-host log paths do not match the exact directory.";else if(age<LEFTOVER_MIN_AGE_MS)reason="Historical worker-host log is younger than 24 hours.";else if(["exited","failed","cancelled"].includes(String(meta.status))){eligible=true;reason="Unregistered settled worker-host log passed identity and age guards.";}else if(["unknown","running"].includes(String(meta.status))&&typeof meta.pid==="number"&&typeof meta.processToken==="string"){let alive=true;try{alive=isAsyncJobExecutionAlive(meta.pid,meta.processToken);}catch{}if(!alive){eligible=true;reason="Unregistered stale worker-host log has a provably dead process identity.";}else reason="Worker-host process identity is live or ambiguous.";}return leftoverRecord("worker_host_log",name,directory,info,eligible,reason);}
function rootCursorIdentity(root:string):CleanupRootCursor{try{const info=lstatSync(root);if(!info.isDirectory()||info.isSymbolicLink())throw new Error(`Cleanup scan root is not an ordinary directory: ${root}`);return{position:0,complete:false,device:Number(info.dev),inode:Number(info.ino),mtimeMs:Number(info.mtimeMs),ctimeMs:Number(info.ctimeMs)};}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return{position:0,complete:true,missing:true};throw error;}}
function assertRootCursorStable(root:string,prior:CleanupRootCursor,current:CleanupRootCursor):void{if(prior.missing!==current.missing||prior.device!==current.device||prior.inode!==current.inode||prior.mtimeMs!==current.mtimeMs||prior.ctimeMs!==current.ctimeMs)throw new Error(`Cleanup scan cursor was invalidated by directory changes: ${root}`);}
/** Async, per-root resumable accounting. Directory positions are bound to root identity and name-change metadata. */
async function scanCleanupLeftoversDetailed(registry:WorkerRegistry,input:{roots:WorkerRoots;preparedRoot:string;projectCwd:string;now?:Date;limit?:number;state?:CleanupScanState}):Promise<{items:CleanupLeftover[];matched:number;partial:boolean;examined:number;roots:Array<{root:string;examined:number;partial:boolean;position?:number}>;continuation?:CleanupScanState}>{
  const nowMs=(input.now??new Date()).getTime(),limit=Math.max(1,Math.min(100,input.limit??100)),scope=scanScope(input);if(input.state&&(input.state.version!==2||input.state.scopeHash!==scope.scopeHash))throw new Error("Cleanup scan cursor scope or version changed.");const state:CleanupScanState=input.state?JSON.parse(JSON.stringify(input.state)):{version:2,scopeHash:scope.scopeHash,matched:0,positions:{}};const output:CleanupLeftover[]=[],rootStats:Array<{root:string;examined:number;partial:boolean;position?:number}>=[];
  const visit=async(root:string,index:number):Promise<void>=>{const currentIdentity=rootCursorIdentity(root),prior=state.positions[root];if(prior)assertRootCursorStable(root,prior,currentIdentity);const cursor=prior??currentIdentity;if(cursor.complete){state.positions[root]={...cursor};rootStats.push({root,examined:0,partial:false,position:cursor.position});return;}let examined=0,seen=0,stopped=false,deadline:number|undefined=cursor.position===0?Date.now()+LEFTOVER_ROOT_DEADLINE_MS:undefined;const dir=await opendirAsync(root);try{for await(const entry of dir){if(seen<cursor.position){seen+=1;if(seen%1024===0)await new Promise<void>((resolve)=>setImmediate(resolve));continue;}deadline??=Date.now()+LEFTOVER_ROOT_DEADLINE_MS;if(examined>=LEFTOVER_ROOT_PAGE||Date.now()>=deadline||output.length>=limit){stopped=true;break;}seen+=1;cursor.position=seen;if(!entry.isDirectory()||entry.isSymbolicLink())continue;const candidate=path.join(root,entry.name);examined+=1;try{const info=await lstatAsync(candidate);if(!info.isDirectory()||info.isSymbolicLink())continue;let item:CleanupLeftover|undefined;if(index===0||index===1)item=workerRootCandidate(registry,entry.name,candidate,info,nowMs);else if(index===2)item=preparedRootCandidate(registry,entry.name,candidate,info,nowMs);else item=await hostLogCandidate(registry,entry.name,candidate,info,nowMs);if(item){state.matched+=1;output.push(item);}}catch{cursor.position-=1;stopped=true;break;}if(examined%128===0)await new Promise<void>((resolve)=>setImmediate(resolve));}}finally{try{await dir.close();}catch{}}
    const ending=rootCursorIdentity(root);assertRootCursorStable(root,currentIdentity,ending);cursor.complete=!stopped;state.positions[root]={...cursor};rootStats.push({root,examined,partial:stopped,position:cursor.position});};
  for(let index=0;index<scope.roots.length;index+=1){const root=scope.roots[index]!;if(index===1&&asciiPathFold(root)===asciiPathFold(scope.roots[0]!)){const shared=state.positions[scope.roots[0]!]??rootCursorIdentity(scope.roots[0]!);state.positions[root]={...shared};rootStats.push({root,examined:0,partial:!shared.complete,position:shared.position});continue;}await visit(root,index);}
  const partial=scope.roots.some((root)=>!state.positions[root]?.complete);return{items:output,matched:state.matched,partial,examined:rootStats.reduce((sum,item)=>sum+item.examined,0),roots:rootStats,...(partial?{continuation:state}:{})};
}
function pruneCleanupControlRowsInTransaction(registry:WorkerRegistry):void{
  registry.database.exec("DELETE FROM cleanup_snapshots WHERE consumed_at IS NOT NULL AND token NOT IN (SELECT token FROM cleanup_snapshots WHERE consumed_at IS NOT NULL ORDER BY consumed_at DESC,token DESC LIMIT 256)");
  registry.database.exec("DELETE FROM cleanup_scan_cursors WHERE consumed_at IS NOT NULL AND token NOT IN (SELECT token FROM cleanup_scan_cursors WHERE consumed_at IS NOT NULL ORDER BY consumed_at DESC,token DESC LIMIT 256)");
  registry.database.exec("DELETE FROM cleanup_leftover_observations WHERE leftover_id IN (SELECT leftover_id FROM cleanup_leftover_observations ORDER BY observed_at DESC,leftover_id DESC LIMIT -1 OFFSET 50000)");
}
function persistCleanupLeftoverObservations(registry:WorkerRegistry,items:CleanupLeftover[],observedAt:string):void{transaction(registry,()=>{const put=registry.database.prepare("INSERT INTO cleanup_leftover_observations(leftover_id,record_json,observed_at) VALUES(?,?,?) ON CONFLICT(leftover_id) DO UPDATE SET record_json=excluded.record_json,observed_at=excluded.observed_at");for(const item of items)put.run(item.leftoverId,JSON.stringify(item),observedAt);pruneCleanupControlRowsInTransaction(registry);});}
function observedCleanupLeftovers(registry:WorkerRegistry,ids:string[]):CleanupLeftover[]{return ids.map((id)=>{const row=registry.database.prepare("SELECT record_json FROM cleanup_leftover_observations WHERE leftover_id=?").get(id) as {record_json:string}|undefined;if(!row)throw new Error(`Unknown cleanup leftover ${id}; resume cleanup_inventory until it is observed.`);return parseJson<CleanupLeftover>(row.record_json);});}
export function loadCleanupScanCursor(registry:WorkerRegistry,parentSessionFile:string,token:string):CleanupScanState{const row=registry.database.prepare("SELECT state_json,consumed_at FROM cleanup_scan_cursors WHERE token=? AND parent_session_file=?").get(token,resolveNearestExisting(parentSessionFile)) as {state_json:string;consumed_at:string|null}|undefined;if(!row)throw new Error("Unknown cleanup scan cursor.");if(row.consumed_at)throw new Error("Cleanup scan cursor was already consumed or invalidated.");const state=parseJson<CleanupScanState>(row.state_json);if(state.version!==2)throw new Error("Cleanup scan cursor version is obsolete.");return state;}
export function invalidateCleanupScanCursor(registry:WorkerRegistry,parentSessionFile:string,token:string,now:string):void{transaction(registry,()=>{registry.database.prepare("UPDATE cleanup_scan_cursors SET consumed_at=? WHERE token=? AND parent_session_file=? AND consumed_at IS NULL").run(now,token,resolveNearestExisting(parentSessionFile));pruneCleanupControlRowsInTransaction(registry);});}
export function advanceCleanupScanCursor(registry:WorkerRegistry,parentSessionFile:string,priorToken:string|undefined,state:CleanupScanState|undefined,now:string):string|undefined{return transaction(registry,()=>{const parent=resolveNearestExisting(parentSessionFile);if(priorToken){const consumed=registry.database.prepare("UPDATE cleanup_scan_cursors SET consumed_at=? WHERE token=? AND parent_session_file=? AND consumed_at IS NULL").run(now,priorToken,parent);if(Number(consumed.changes)!==1)throw new Error("Cleanup scan cursor changed or was consumed.");}else registry.database.prepare("UPDATE cleanup_scan_cursors SET consumed_at=? WHERE parent_session_file=? AND consumed_at IS NULL").run(now,parent);let token:string|undefined;if(state){token=`cleanup_scan_${createHash("sha256").update(randomUUID()+JSON.stringify(state)).digest("hex").slice(0,48)}`;registry.database.prepare("INSERT INTO cleanup_scan_cursors(token,parent_session_file,state_json,created_at) VALUES(?,?,?,?)").run(token,parent,JSON.stringify(state),now);}pruneCleanupControlRowsInTransaction(registry);return token;});}
export async function scanCleanupLeftovers(registry:WorkerRegistry,input:{roots:WorkerRoots;preparedRoot:string;projectCwd:string;now?:Date}):Promise<CleanupLeftover[]>{const items:CleanupLeftover[]=[];let state:CleanupScanState|undefined;do{const page=await scanCleanupLeftoversDetailed(registry,{...input,limit:Math.max(1,100-items.length),state});items.push(...page.items);state=page.continuation;}while(state&&items.length<100);return items;}
async function inspectCleanupLeftover(registry:WorkerRegistry,expected:CleanupLeftover,input:{roots:WorkerRoots;preparedRoot:string;projectCwd:string;now?:Date}):Promise<CleanupLeftover>{const info=await lstatAsync(expected.path);if(!info.isDirectory()||info.isSymbolicLink()||Number(info.dev)!==expected.device||Number(info.ino)!==expected.inode)throw new Error(`Cleanup leftover identity changed: ${expected.path}`);const nowMs=(input.now??new Date()).getTime(),name=path.basename(expected.path);let current:CleanupLeftover|undefined;if(expected.kind==="cleanup_trash")current=cleanupTrashCandidate(registry,expected.path,info);else if(expected.kind==="worker_host_log")current=await hostLogCandidate(registry,name,expected.path,info,nowMs);else if(expected.kind==="prepared_root")current=preparedRootCandidate(registry,name,expected.path,info,nowMs);else current=workerRootCandidate(registry,name,expected.path,info,nowMs);if(!current||JSON.stringify(current)!==JSON.stringify(expected)||!current.eligible)throw new Error(`Cleanup leftover changed or is no longer eligible: ${expected.path}`);return current;}
export async function preflightCleanupLeftovers(registry:WorkerRegistry,expected:CleanupLeftover[],input:{roots:WorkerRoots;preparedRoot:string;projectCwd:string;now?:Date}):Promise<void>{for(const item of expected)await inspectCleanupLeftover(registry,item,input);}
function cleanupClaimOwnerIsDead(claim:CleanupLeftoverClaim):boolean{const observed=asyncJobProcessStartToken(claim.ownerPid);if(observed!==undefined)return observed!==claim.ownerStartToken;try{process.kill(claim.ownerPid,0);return false;}catch(error){return(error as NodeJS.ErrnoException).code==="ESRCH";}}
function sourceRootForLeftover(item:CleanupLeftover,input:{roots:WorkerRoots;preparedRoot:string;projectCwd:string}):string{const parent=path.resolve(path.dirname(item.path)),root=scanScope(input).roots.find((candidate)=>asciiPathFold(path.resolve(candidate))===asciiPathFold(parent));if(!root)throw new Error(`Cleanup leftover is not an immediate child of an authoritative root: ${item.path}`);return path.resolve(root);}
function beginCleanupLeftoverClaim(registry:WorkerRegistry,item:CleanupLeftover,input:{roots:WorkerRoots;preparedRoot:string;projectCwd:string;nonce:string;now:Date}):CleanupLeftoverClaim{
  if(item.kind==="cleanup_trash")throw new Error("Cleanup trash must resume its existing host claim.");const sourceKind=item.kind,sourcePath=path.resolve(item.path),entryName=path.basename(sourcePath),rootPath=sourceRootForLeftover(item,input),trashPath=`${sourcePath}.cleanup-${input.nonce}`,ownerStartToken=asyncJobProcessStartToken(process.pid);if(!ownerStartToken)throw new Error("Cannot capture exact cleanup-claim process identity.");
  return transaction(registry,()=>{const existingRow=registry.database.prepare("SELECT * FROM cleanup_leftover_claims WHERE source_path=? OR trash_path=?").get(sourcePath,trashPath) as Record<string,unknown>|undefined;if(existingRow){const existing=cleanupClaimRow(existingRow);if(existsSync(existing.trashPath)||!existsSync(existing.sourcePath)||!cleanupClaimOwnerIsDead(existing))throw new Error("Cleanup leftover is already claimed by a live, ambiguous, or committed operation.");registry.database.prepare("DELETE FROM cleanup_leftover_claims WHERE claim_id=?").run(existing.claimId);}const claim:CleanupLeftoverClaim={claimId:`cleanup_claim_${createHash("sha256").update(randomUUID()+item.leftoverId).digest("hex").slice(0,48)}`,sourceLeftoverId:item.leftoverId,sourceKind,originalId:item.id,entryName,sourcePath,trashPath,rootPath,device:item.device,inode:item.inode,nonce:input.nonce,ownerPid:process.pid,ownerStartToken,createdAt:input.now.toISOString()};registry.database.prepare("INSERT INTO cleanup_leftover_claims(claim_id,source_leftover_id,source_kind,original_id,entry_name,source_path,trash_path,root_path,device,inode,nonce,owner_pid,owner_start_token,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(claim.claimId,claim.sourceLeftoverId,claim.sourceKind,claim.originalId,claim.entryName,claim.sourcePath,claim.trashPath,claim.rootPath,claim.device,claim.inode,claim.nonce,claim.ownerPid,claim.ownerStartToken,claim.createdAt);return claim;});
}
function exactCleanupTrashClaim(registry:WorkerRegistry,item:CleanupLeftover):CleanupLeftoverClaim{const claim=cleanupClaimForTrash(registry,item.path);if(!claim||claim.originalId!==item.id||claim.device!==item.device||claim.inode!==item.inode||claim.trashPath!==path.resolve(item.path)||claim.sourceLeftoverId!==leftoverIdentity(claim.sourceKind,claim.originalId,claim.sourcePath,claim.device,claim.inode))throw new Error("Cleanup trash host claim changed.");return claim;}
function finishCleanupLeftoverClaim(registry:WorkerRegistry,claim:CleanupLeftoverClaim):void{const changed=transaction(registry,()=>registry.database.prepare("DELETE FROM cleanup_leftover_claims WHERE claim_id=? AND trash_path=? AND device=? AND inode=?").run(claim.claimId,claim.trashPath,claim.device,claim.inode));if(Number(changed.changes)!==1)throw new Error("Cleanup leftover claim changed before completion.");}
function releaseUncommittedCleanupLeftoverClaim(registry:WorkerRegistry,claim:CleanupLeftoverClaim):void{transaction(registry,()=>registry.database.prepare("DELETE FROM cleanup_leftover_claims WHERE claim_id=? AND source_path=? AND trash_path=?").run(claim.claimId,claim.sourcePath,claim.trashPath));}
export async function deleteCleanupLeftovers(registry:WorkerRegistry,expected:CleanupLeftover[],input:{roots:WorkerRoots;preparedRoot:string;projectCwd:string;now?:Date;nonce?:string;prevalidated?:boolean;afterLeftoverClaim?:(item:CleanupLeftover,trashPath:string)=>void;removeClaimedTrash?:(trashPath:string)=>void}):Promise<Array<{id:string;status:"discarded"|"failed";reason?:string}>>{
  if(!input.prevalidated)await preflightCleanupLeftovers(registry,expected,input);const batchNonce=input.nonce??randomUUID().replaceAll("-","").slice(0,24),results:Array<{id:string;status:"discarded"|"failed";reason?:string}>=[];
  for(const [index,item] of expected.entries()){let claim:CleanupLeftoverClaim|undefined,renamed=false;try{const info=await lstatAsync(item.path);if(!info.isDirectory()||info.isSymbolicLink()||Number(info.dev)!==item.device||Number(info.ino)!==item.inode)throw new Error("identity changed");if(item.kind==="cleanup_trash")claim=exactCleanupTrashClaim(registry,item);else{const nonce=createHash("sha256").update(`${batchNonce}\0${index}\0${item.leftoverId}`).digest("hex").slice(0,24);claim=beginCleanupLeftoverClaim(registry,item,{...input,nonce,now:input.now??new Date()});if(existsSync(claim.trashPath))throw new Error("cleanup trash path already exists");renameSync(claim.sourcePath,claim.trashPath);renamed=true;const moved=lstatSync(claim.trashPath);if(Number(moved.dev)!==item.device||Number(moved.ino)!==item.inode)throw new Error("identity changed during claim");}input.afterLeftoverClaim?.(item,claim.trashPath);(input.removeClaimedTrash??((trashPath:string)=>rmSync(trashPath,{recursive:true,force:true})))(claim.trashPath);if(existsSync(claim.trashPath))throw new Error("cleanup trash remains");finishCleanupLeftoverClaim(registry,claim);results.push({id:item.leftoverId,status:"discarded"});}catch(error){if(claim&&!renamed&&item.kind!=="cleanup_trash"&&existsSync(claim.sourcePath)&&!existsSync(claim.trashPath))try{releaseUncommittedCleanupLeftoverClaim(registry,claim);}catch{}results.push({id:item.leftoverId,status:"failed",reason:error instanceof Error?error.message:String(error)});}}
  return results;
}
export async function deleteCleanupLeftover(registry: WorkerRegistry, expected: CleanupLeftover, input: { roots: WorkerRoots; preparedRoot: string; projectCwd: string; now?: Date; afterLeftoverClaim?:(item:CleanupLeftover,trashPath:string)=>void;removeClaimedTrash?:(trashPath:string)=>void }): Promise<void> { const [result]=await deleteCleanupLeftovers(registry,[expected],input); if(result?.status==="failed") throw new Error(result.reason); }
