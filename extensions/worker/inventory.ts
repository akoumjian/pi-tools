import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { WorkerRepositoryResult } from "./registry.js";
import { canonicalPathWithin, canonicalRepository, trustedGit } from "./trusted-git.js";

export type RepositorySnapshot = { path: string; commit: string; dirty: boolean };

export function snapshotWorkerRepositories(workspaceRoot: string): RepositorySnapshot[] {
  return discoverWorkerRepositories(workspaceRoot).map((item) => inspect(item.absolute, item.relative));
}

export function inventoryWorkerRepositories(input: {
  workspaceRoot: string; workerId: string; runId: string; reported: string[]; before?: RepositorySnapshot[];
}): { repositories: WorkerRepositoryResult[]; errors: string[] } {
  const errors: string[] = [];
  const reported = new Set<string>();
  for (const value of input.reported) {
    try {
      const exact = canonicalPathWithin(input.workspaceRoot, path.resolve(input.workspaceRoot, value));
      reported.add(path.relative(realpathSync(input.workspaceRoot), exact).split(path.sep).join("/"));
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  const before = new Map((input.before ?? []).map((item) => [item.path, item]));
  const repositories = discoverWorkerRepositories(input.workspaceRoot).map(({ absolute, relative }): WorkerRepositoryResult => {
    const issues: string[] = [];
    let commit = ""; let dirty = true; let source: string | undefined;
    try {
      const exact = canonicalRepository(absolute);
      commit = trustedGit(exact, ["rev-parse", "HEAD"]).trim();
      dirty = trustedGit(exact, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"]).trim() !== "";
      try { source = trustedGit(exact, ["remote", "get-url", "origin"]).trim() || undefined; } catch {}
    } catch (error) { issues.push(error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512)); }
    const previous = before.get(relative);
    const changed = previous === undefined || previous.commit !== commit || previous.dirty !== dirty;
    const wasReported = reported.has(relative);
    const candidateId = `candidate_${createHash("sha256").update(`${input.workerId}\0${input.runId}\0${relative}\0${commit}`).digest("hex").slice(0, 24)}`;
    if (!wasReported && changed) issues.push("Changed repository was not reported by worker_result_submit.");
    if (wasReported && !changed) issues.push("Reported repository did not change during this run.");
    return { candidateId, path: relative, commit: commit || "unknown", ...(source ? { source } : {}), reported: wasReported, changed, dirty, eligible: wasReported && changed && !dirty && Boolean(commit), ...(issues.length ? { issues } : {}) };
  });
  for (const relative of reported) if (!repositories.some((item) => item.path === relative)) errors.push(`Reported repository was not found by independent workspace scan: ${relative}.`);
  return { repositories, errors };
}

function discoverWorkerRepositories(workspaceRoot: string): Array<{ absolute: string; relative: string }> {
  const root = realpathSync(workspaceRoot);
  if (!statSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return [];
  const found: Array<{ absolute: string; relative: string }> = []; const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (queue.length && found.length < 128) {
    const current = queue.shift()!; if (current.depth > 8) continue;
    let entries; try { entries = readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    if (current.depth > 0 && entries.some((entry) => entry.name === ".git" && !entry.isSymbolicLink())) {
      try {
        const absolute = canonicalRepository(current.directory);
        canonicalPathWithin(root, absolute);
        found.push({ absolute, relative: path.relative(root, absolute).split(path.sep).join("/") });
      } catch {}
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git" || entry.name === ".pi" || entry.name === "node_modules") continue;
      queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return found.sort((a, b) => a.relative.localeCompare(b.relative));
}

function inspect(absolute: string, relative: string): RepositorySnapshot {
  try { return { path: relative, commit: trustedGit(absolute, ["rev-parse", "HEAD"]).trim(), dirty: trustedGit(absolute, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"]).trim() !== "" }; }
  catch { return { path: relative, commit: "unknown", dirty: true }; }
}
