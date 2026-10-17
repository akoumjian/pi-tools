import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { WorkerRepositoryResult } from "./registry.js";
import { canonicalPathWithin, canonicalRepository, createTrustedGitOperation, trustedGit, type TrustedGitOperation } from "./trusted-git.js";

export type RepositorySnapshot = { path: string; commit: string; dirty: boolean };
export type DiscoveredWorkerRepository = { absolute: string; relative: string; issues?: string[] };

export function snapshotWorkerRepositories(workspaceRoot: string): RepositorySnapshot[] {
  const operation = createTrustedGitOperation(); return discoverWorkerRepositories(workspaceRoot, operation).map((item) => inspect(item.absolute, item.relative, operation, item.issues));
}

export function inventoryWorkerRepositories(input: {
  workspaceRoot: string; workerId: string; runId: string; reported: string[]; before?: RepositorySnapshot[];
}): { repositories: WorkerRepositoryResult[]; errors: string[] } {
  const errors: string[] = [];
  const operation = createTrustedGitOperation();
  const reported = new Set<string>();
  for (const value of input.reported) {
    try {
      const exact = canonicalPathWithin(input.workspaceRoot, path.resolve(input.workspaceRoot, value));
      reported.add(path.relative(realpathSync(input.workspaceRoot), exact).split(path.sep).join("/"));
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  const before = new Map((input.before ?? []).map((item) => [item.path, item]));
  const repositories = discoverWorkerRepositories(input.workspaceRoot, operation).map(({ absolute, relative, issues: discoveryIssues }): WorkerRepositoryResult => {
    const issues: string[] = [...(discoveryIssues ?? [])];
    let commit = ""; let dirty = true; let source: string | undefined;
    try {
      if (discoveryIssues?.length) throw new Error("Repository policy/path validation failed during discovery.");
      const exact = canonicalRepository(absolute, true, operation);
      commit = trustedGit(exact, ["rev-parse", "HEAD"], { operation }).trim();
      dirty = trustedGit(exact, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"], { operation }).trim() !== "";
      try { source = trustedGit(exact, ["remote", "get-url", "origin"], { operation }).trim() || undefined; } catch {}
    } catch (error) { const message = error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512); if (!issues.includes(message)) issues.push(message); }
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

export function discoverWorkerRepositories(workspaceRoot: string, operation: TrustedGitOperation = createTrustedGitOperation()): DiscoveredWorkerRepository[] {
  const root = realpathSync(workspaceRoot);
  if (!statSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return [];
  const found: DiscoveredWorkerRepository[] = []; const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (queue.length && found.length < 128) {
    const current = queue.shift()!; if (current.depth > 8) continue;
    let entries; try { entries = readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    if (current.depth > 0 && entries.some((entry) => entry.name === ".git" && !entry.isSymbolicLink())) {
      const relative = path.relative(root, current.directory).split(path.sep).join("/");
      try {
        const raw = canonicalPathWithin(root, current.directory);
        try {
          const absolute = canonicalRepository(raw, true, operation);
          canonicalPathWithin(root, absolute);
          found.push({ absolute, relative });
        } catch (error) {
          found.push({ absolute: raw, relative, issues: [`Repository policy validation failed: ${error instanceof Error ? error.message.slice(0, 448) : String(error).slice(0, 448)}`] });
        }
      } catch (error) {
        found.push({ absolute: current.directory, relative, issues: [`Repository path validation failed: ${error instanceof Error ? error.message.slice(0, 448) : String(error).slice(0, 448)}`] });
      }
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git" || entry.name === ".pi" || entry.name === "node_modules") continue;
      queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return found.sort((a, b) => a.relative.localeCompare(b.relative));
}

export function inspectInterruptedGitState(workspaceRoot: string): string[] {
  const warnings: string[] = []; const operation = createTrustedGitOperation();
  for (const repository of discoverWorkerRepositories(workspaceRoot, operation)) {
    if (repository.issues?.length) { warnings.push(...repository.issues.map((issue) => `${repository.relative}: ${issue}`)); continue; }
    try {
      const status = trustedGit(repository.absolute, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"], { operation }).trim();
      const gitDir = trustedGit(repository.absolute, ["rev-parse", "--path-format=absolute", "--git-dir"], { operation }).trim();
      const commonDir = trustedGit(repository.absolute, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { operation }).trim();
      const states = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge"]
        .filter((name) => existsSync(path.join(gitDir, name)));
      const locks = [path.join(gitDir, "index.lock"), path.join(commonDir, "packed-refs.lock"), path.join(commonDir, "config.lock")]
        .filter(existsSync).map((file) => path.basename(file));
      if (status) warnings.push(`${repository.relative}: retained working tree or index changes require inspection.`);
      if (states.length) warnings.push(`${repository.relative}: interrupted Git state is present (${states.join(", ")}).`);
      if (locks.length) warnings.push(`${repository.relative}: retained Git lock files require ownership verification (${locks.join(", ")}).`);
    } catch (error) { warnings.push(`${repository.relative}: interrupted Git state inspection failed: ${error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256)}`); }
  }
  return warnings.slice(0, 64);
}

function inspect(absolute: string, relative: string, operation: TrustedGitOperation, issues?: string[]): RepositorySnapshot {
  if (issues?.length) return { path: relative, commit: "unknown", dirty: true };
  try { return { path: relative, commit: trustedGit(absolute, ["rev-parse", "HEAD"], { operation }).trim(), dirty: trustedGit(absolute, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"], { operation }).trim() !== "" }; }
  catch { return { path: relative, commit: "unknown", dirty: true }; }
}
