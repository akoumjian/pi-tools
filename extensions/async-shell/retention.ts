import type { Dirent } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isAsyncJobExecutionAlive } from "../_shared/async-job.js";

export type AsyncShellRetentionKind = "eligible" | "ineligible" | "pending" | "prune" | "unknown-leftover";

export type AsyncShellRetentionEntry = {
  name: string;
  kind: AsyncShellRetentionKind;
  bytes: number;
  reason: string;
  jobId?: string;
  status?: string;
};

export type AsyncShellRetentionTotals = {
  directories: number;
  bytes: number;
  eligible: { count: number; bytes: number };
  ineligible: { count: number; bytes: number };
  leftovers: { count: number; bytes: number };
  pending: { count: number; bytes: number };
  prune: { count: number; bytes: number };
  unknownLeftovers: { count: number; bytes: number };
};

export type AsyncShellRetentionSnapshot = {
  version: 1;
  root: string;
  scannedAt: string;
  durationMs: number;
  entries: AsyncShellRetentionEntry[];
  recentJobs: Record<string, unknown>[];
  totals: AsyncShellRetentionTotals;
};

export type AsyncShellRetentionProgress = {
  scanned: number;
  total: number;
};

const JOB_ID_PATTERN = /^job_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LEFTOVER_PATTERN = /^\.(pending|prune)-(job_[A-Za-z0-9][A-Za-z0-9_-]{0,127})-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const TERMINAL = new Set(["exited", "failed", "cancelled"]);
const SCAN_BATCH_SIZE = 256;

export function parseAsyncShellLeftoverName(name: string): { kind: "pending" | "prune"; jobId: string } | undefined {
  const match = LEFTOVER_PATTERN.exec(name);
  if (!match) return undefined;
  return { kind: match[1] as "pending" | "prune", jobId: match[2]! };
}

export function isCanonicalAsyncShellJobId(name: string): boolean {
  return JOB_ID_PATTERN.test(name);
}

export async function scanAsyncShellRetention(
  root: string,
  onProgress?: (progress: AsyncShellRetentionProgress) => void
): Promise<AsyncShellRetentionSnapshot> {
  const startedAt = Date.now();
  let dirents: Dirent<string>[];
  try {
    dirents = await readdir(root, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptySnapshot(root, startedAt);
    throw error;
  }
  const names = dirents
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  const entries: AsyncShellRetentionEntry[] = [];
  const recentJobs: Record<string, unknown>[] = [];
  for (let offset = 0; offset < names.length; offset += SCAN_BATCH_SIZE) {
    const chunk = names.slice(offset, offset + SCAN_BATCH_SIZE);
    const classified = await Promise.all(chunk.map((name) => classifyEntry(root, name)));
    for (const item of classified) {
      entries.push(item.entry);
      if (item.job !== undefined) recentJobs.push(item.job);
    }
    onProgress?.({ scanned: Math.min(offset + chunk.length, names.length), total: names.length });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  recentJobs.sort((left, right) => Date.parse(String(right.startedAt ?? "")) - Date.parse(String(left.startedAt ?? "")));
  return {
    version: 1,
    root,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    entries,
    recentJobs: recentJobs.slice(0, 100),
    totals: retentionTotals(entries)
  };
}

async function classifyEntry(root: string, name: string): Promise<{ entry: AsyncShellRetentionEntry; job?: Record<string, unknown> }> {
  const entryPath = path.join(root, name);
  const summary = await pathTreeSummary(entryPath);
  const bytes = summary.bytes;
  if (summary.info === undefined) {
    return { entry: { name, kind: "unknown-leftover", bytes, reason: `unavailable: ${summary.error ?? "unknown filesystem error"}` } };
  }
  if (summary.info.isSymbolicLink() || !summary.info.isDirectory()) {
    return { entry: { name, kind: "unknown-leftover", bytes, reason: "path is not an ordinary directory" } };
  }
  const leftover = parseAsyncShellLeftoverName(name);
  if (leftover) {
    return { entry: { name, kind: leftover.kind, jobId: leftover.jobId, bytes, reason: "interrupted lifecycle directory" } };
  }
  if (!isCanonicalAsyncShellJobId(name)) {
    return { entry: { name, kind: "unknown-leftover", bytes, reason: "unrecognized registry directory" } };
  }
  const job = await readJobMeta(root, name);
  if (!job) return { entry: { name, kind: "ineligible", jobId: name, bytes, reason: "metadata missing or invalid" } };
  const reason = ineligibleReason(job);
  return {
    entry: {
      name,
      kind: reason === undefined ? "eligible" : "ineligible",
      jobId: name,
      status: typeof job.status === "string" ? job.status : undefined,
      bytes,
      reason: reason ?? "terminal ordinary job with completed delivery evidence"
    },
    job
  };
}

async function readJobMeta(root: string, jobId: string): Promise<Record<string, unknown> | undefined> {
  const expectedLogDir = path.join(path.resolve(root), jobId);
  try {
    const raw = JSON.parse(await readFile(path.join(root, jobId, "meta.json"), "utf8")) as Record<string, unknown>;
    if (
      raw.jobId !== jobId ||
      typeof raw.command !== "string" ||
      typeof raw.cwd !== "string" ||
      path.resolve(String(raw.logDir ?? "")) !== expectedLogDir ||
      path.resolve(String(raw.stdoutLog ?? "")) !== path.join(expectedLogDir, "stdout.log") ||
      path.resolve(String(raw.stderrLog ?? "")) !== path.join(expectedLogDir, "stderr.log")
    ) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

function ineligibleReason(job: Record<string, unknown>): string | undefined {
  if (job.owner !== undefined) return "worker-owned";
  const status = typeof job.status === "string" ? job.status : "unknown";
  if (!TERMINAL.has(status)) return `non-terminal:${status}`;
  if (status === "unknown") return "unknown status";
  if (job.notifyOnExit === true && job.completionNotified !== true) return "undelivered completion";
  const pid = typeof job.pid === "number" ? job.pid : undefined;
  const token = typeof job.processToken === "string" ? job.processToken : undefined;
  if (isAsyncJobExecutionAlive(pid, token)) return "process identity still alive";
  return undefined;
}

type PathTreeSummary = {
  bytes: number;
  info?: Awaited<ReturnType<typeof lstat>>;
  error?: string;
};

async function pathTreeSummary(target: string): Promise<PathTreeSummary> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(target); } catch (error) { return { bytes: 0, error: errorMessage(error) }; }
  if (info.isSymbolicLink()) return { bytes: 0, info };
  if (!info.isDirectory()) return { bytes: info.isFile() ? info.size : 0, info };
  let children: Dirent<string>[];
  try { children = await readdir(target, { withFileTypes: true, encoding: "utf8" }); } catch (error) { return { bytes: 0, info, error: errorMessage(error) }; }
  const childSummaries = await Promise.all(children.map((child) => pathTreeSummary(path.join(target, child.name))));
  return { bytes: childSummaries.reduce((total, child) => total + child.bytes, 0), info };
}

function retentionTotals(entries: AsyncShellRetentionEntry[]): AsyncShellRetentionTotals {
  const totals: AsyncShellRetentionTotals = {
    directories: entries.length,
    bytes: 0,
    eligible: { count: 0, bytes: 0 },
    ineligible: { count: 0, bytes: 0 },
    leftovers: { count: 0, bytes: 0 },
    pending: { count: 0, bytes: 0 },
    prune: { count: 0, bytes: 0 },
    unknownLeftovers: { count: 0, bytes: 0 }
  };
  for (const entry of entries) {
    totals.bytes += entry.bytes;
    if (entry.kind === "eligible" || entry.kind === "ineligible") {
      totals[entry.kind].count += 1;
      totals[entry.kind].bytes += entry.bytes;
      continue;
    }
    totals.leftovers.count += 1;
    totals.leftovers.bytes += entry.bytes;
    const bucket = entry.kind === "pending" ? totals.pending : entry.kind === "prune" ? totals.prune : totals.unknownLeftovers;
    bucket.count += 1;
    bucket.bytes += entry.bytes;
  }
  return totals;
}

function emptySnapshot(root: string, startedAt: number): AsyncShellRetentionSnapshot {
  return { version: 1, root, scannedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, entries: [], recentJobs: [], totals: retentionTotals([]) };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
