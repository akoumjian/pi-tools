import { createHash } from "node:crypto";
import { existsSync, lstatSync, opendirSync, realpathSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { WorkerRepositoryResult } from "./registry.js";
import { canonicalPathWithin, canonicalRepository, createTrustedGitOperation, trustedGit, type TrustedGitOperation } from "./trusted-git.js";

const MAX_REPOSITORIES = 128;
const MAX_DISCOVERY_DIRECTORIES = 4096;
const MAX_DIRECTORY_ENTRIES = 8192;
const MAX_INVENTORY_GIT_OUTPUT = 1024 * 1024;
const MAX_REMOTE_OUTPUT = 64 * 1024;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export type RepositorySnapshot = { path: string; commit: string; dirty: boolean };
export type DiscoveredWorkerRepository = { absolute: string; relative: string; identity?: string; issues?: string[] };
export type InventoryDependencies = { afterHeadRead?: (repository: string, commit: string, tree: string) => void };
type ScanDiagnostics = { complete: boolean; limitations: string[] };
type RepositoryHead = { commit: string; tree: string };

export function snapshotWorkerRepositories(workspaceRoot: string): RepositorySnapshot[] {
  const operation = createTrustedGitOperation();
  return discoverWorkerRepositories(workspaceRoot, operation).map((item) => inspectSnapshot(item.absolute, item.relative, operation, item.issues));
}

export function inventoryWorkerRepositories(input: {
  workspaceRoot: string; workerId: string; runId: string; reported: string[]; before?: RepositorySnapshot[];
}, dependencies: InventoryDependencies = {}): { repositories: WorkerRepositoryResult[]; errors: string[] } {
  const errors: string[] = [];
  const operation = createTrustedGitOperation();
  const root = realpathSync(input.workspaceRoot);
  const reported = new Map<string, string>();
  for (const value of input.reported) {
    try {
      const exact = canonicalPathWithin(root, path.resolve(root, value));
      const relative = path.relative(root, exact).split(path.sep).join("/");
      const identity = pathIdentity(exact);
      const existing = reported.get(identity);
      if (existing !== undefined && existing !== relative) errors.push(`Reported repository aliases resolve to one physical directory: ${safeInventoryText(existing)} and ${safeInventoryText(relative)}.`);
      reported.set(identity, relative);
    } catch (error) { errors.push(safeInventoryText(error instanceof Error ? error.message : String(error))); }
  }
  const before = new Map((input.before ?? []).map((item) => [item.path, item]));
  const diagnostics: ScanDiagnostics = { complete: true, limitations: [] };
  const discovered = discoverWorkerRepositories(root, operation, diagnostics);
  if (!diagnostics.complete) errors.push(...diagnostics.limitations.map(safeInventoryText));
  const repositories = discovered.map(({ absolute, relative, identity, issues: discoveryIssues }): WorkerRepositoryResult => {
    const issues: string[] = [...(discoveryIssues ?? [])];
    if (!diagnostics.complete) issues.push("Independent repository scan was incomplete.");
    if (hasTerminalControls(relative)) issues.push("Repository path contains terminal-control characters.");
    let commit = ""; let dirty = true; let source: string | undefined;
    try {
      if (discoveryIssues?.length) throw new Error("Repository policy/path validation failed during discovery.");
      const exact = canonicalRepository(absolute, true, operation);
      if (!identity || pathIdentity(exact) !== identity) throw new Error("Repository physical identity changed during inventory.");
      const first = readHead(exact, operation);
      dependencies.afterHeadRead?.(exact, first.commit, first.tree);
      dirty = repositoryDirty(exact, operation);
      source = repositorySource(exact, operation);
      const second = readHead(exact, operation);
      if (pathIdentity(exact) !== identity) throw new Error("Repository physical identity changed during inventory.");
      if (first.commit !== second.commit || first.tree !== second.tree) throw new Error("Repository HEAD changed during inventory.");
      commit = first.commit;
    } catch (error) {
      commit = "";
      dirty = true;
      const message = safeInventoryText(error instanceof Error ? error.message : String(error)).slice(0, 512);
      if (!issues.includes(message)) issues.push(message);
    }
    const previous = before.get(relative);
    const changed = previous === undefined || previous.commit !== commit || previous.dirty !== dirty;
    const wasReported = identity !== undefined && reported.has(identity);
    const candidateId = `candidate_${createHash("sha256").update(`${input.workerId}\0${input.runId}\0${relative}\0${commit}`).digest("hex").slice(0, 24)}`;
    if (!wasReported && changed) issues.push("Changed repository was not reported by worker_result_submit.");
    if (wasReported && !changed) issues.push("Reported repository did not change during this run.");
    return { candidateId, path: relative, commit: commit || "unknown", ...(source ? { source } : {}), reported: wasReported, changed, dirty, eligible: wasReported && changed && !dirty && Boolean(commit) && diagnostics.complete && !hasTerminalControls(relative), ...(issues.length ? { issues: unique(issues) } : {}) };
  });
  const discoveredIdentities = new Set(discovered.flatMap((item) => item.identity === undefined ? [] : [item.identity]));
  for (const [identity, relative] of reported) if (!discoveredIdentities.has(identity)) errors.push(`Reported repository was not found by independent workspace scan: ${safeInventoryText(relative)}.`);
  return { repositories, errors: unique(errors).slice(0, 128) };
}

export function discoverWorkerRepositories(workspaceRoot: string, operation: TrustedGitOperation = createTrustedGitOperation(), diagnostics: ScanDiagnostics = { complete: true, limitations: [] }): DiscoveredWorkerRepository[] {
  const root = realpathSync(workspaceRoot);
  if (!statSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return [];
  const found: DiscoveredWorkerRepository[] = [];
  const identities = new Set<string>();
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  let cursor = 0;
  while (cursor < queue.length) {
    if (cursor >= MAX_DISCOVERY_DIRECTORIES) { markIncomplete(diagnostics, `Repository scan stopped after ${MAX_DISCOVERY_DIRECTORIES} directories.`); break; }
    if (found.length >= MAX_REPOSITORIES) { markIncomplete(diagnostics, `Repository scan stopped after ${MAX_REPOSITORIES} repositories.`); break; }
    const current = queue[cursor++]!;
    if (current.depth > 8) { markIncomplete(diagnostics, "Repository scan skipped directories below depth 8."); continue; }
    const entries = boundedDirectoryEntries(current.directory, diagnostics);
    if (entries === undefined) continue;
    if (current.depth > 0 && entries.some((entry) => entry.name === ".git" && !entry.isSymbolicLink())) {
      const relative = path.relative(root, current.directory).split(path.sep).join("/");
      try {
        const raw = canonicalPathWithin(root, current.directory);
        const identity = pathIdentity(raw);
        if (identities.has(identity)) continue;
        identities.add(identity);
        try {
          const absolute = canonicalRepository(raw, true, operation);
          canonicalPathWithin(root, absolute);
          if (pathIdentity(absolute) !== identity) throw new Error("Repository physical identity changed during discovery.");
          found.push({ absolute, relative, identity });
        } catch (error) {
          found.push({ absolute: raw, relative, identity, issues: [`Repository policy validation failed: ${safeInventoryText(error instanceof Error ? error.message : String(error)).slice(0, 448)}`] });
        }
      } catch (error) {
        found.push({ absolute: current.directory, relative, issues: [`Repository path validation failed: ${safeInventoryText(error instanceof Error ? error.message : String(error)).slice(0, 448)}`] });
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
  const warnings: string[] = []; const operation = createTrustedGitOperation(); const diagnostics: ScanDiagnostics = { complete: true, limitations: [] };
  for (const repository of discoverWorkerRepositories(workspaceRoot, operation, diagnostics)) {
    const relative = safeInventoryText(repository.relative);
    if (repository.issues?.length) { warnings.push(...repository.issues.map((issue) => `${relative}: ${safeInventoryText(issue)}`)); continue; }
    try {
      const status = trustedGit(repository.absolute, ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=all"], { operation, maxBuffer: MAX_INVENTORY_GIT_OUTPUT }).trim();
      const gitDir = trustedGit(repository.absolute, ["rev-parse", "--path-format=absolute", "--git-dir"], { operation, maxBuffer: 16 * 1024 }).trim();
      const commonDir = trustedGit(repository.absolute, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { operation, maxBuffer: 16 * 1024 }).trim();
      const states = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge"].filter((name) => existsSync(path.join(gitDir, name)));
      const locks = [path.join(gitDir, "index.lock"), path.join(commonDir, "packed-refs.lock"), path.join(commonDir, "config.lock")].filter(existsSync).map((file) => path.basename(file));
      if (status) warnings.push(`${relative}: retained working tree or index changes require inspection.`);
      if (states.length) warnings.push(`${relative}: interrupted Git state is present (${states.join(", ")}).`);
      if (locks.length) warnings.push(`${relative}: retained Git lock files require ownership verification (${locks.join(", ")}).`);
    } catch (error) { warnings.push(`${relative}: interrupted Git state inspection failed: ${safeInventoryText(error instanceof Error ? error.message : String(error)).slice(0, 256)}`); }
  }
  warnings.push(...diagnostics.limitations.map(safeInventoryText));
  return unique(warnings).slice(0, 64);
}

function inspectSnapshot(absolute: string, relative: string, operation: TrustedGitOperation, issues?: string[]): RepositorySnapshot {
  if (issues?.length) return { path: relative, commit: "unknown", dirty: true };
  try {
    const first = readHead(absolute, operation);
    const dirty = repositoryDirty(absolute, operation);
    const second = readHead(absolute, operation);
    return first.commit === second.commit && first.tree === second.tree ? { path: relative, commit: first.commit, dirty } : { path: relative, commit: "unknown", dirty: true };
  } catch { return { path: relative, commit: "unknown", dirty: true }; }
}

function readHead(repository: string, operation: TrustedGitOperation): RepositoryHead {
  const lines = trustedGit(repository, ["rev-parse", "HEAD^{commit}", "HEAD^{tree}"], { operation, maxBuffer: 16 * 1024 }).trim().split("\n");
  const [commit, tree] = lines;
  if (!commit || !tree || !/^[0-9a-f]{40,64}$/.test(commit) || !/^[0-9a-f]{40,64}$/.test(tree)) throw new Error("Repository HEAD commit/tree identity is invalid.");
  return { commit, tree };
}

function repositoryDirty(repository: string, operation: TrustedGitOperation): boolean {
  return trustedGit(repository, ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=all"], { operation, maxBuffer: MAX_INVENTORY_GIT_OUTPUT }).trim() !== "";
}

function repositorySource(repository: string, operation: TrustedGitOperation): string | undefined {
  try {
    const source = trustedGit(repository, ["remote", "get-url", "origin"], { operation, maxBuffer: MAX_REMOTE_OUTPUT }).trim();
    return source ? safeInventoryText(source).slice(0, 4096) : undefined;
  } catch { return undefined; }
}

function boundedDirectoryEntries(directory: string, diagnostics: ScanDiagnostics): Dirent[] | undefined {
  let dir;
  try { dir = opendirSync(directory); }
  catch (error) { markIncomplete(diagnostics, `Repository scan could not read one directory: ${safeInventoryText(error instanceof Error ? error.message : String(error)).slice(0, 256)}`); return undefined; }
  const entries: Dirent[] = [];
  try {
    while (true) {
      const entry = dir.readSync();
      if (!entry) break;
      if (entries.length >= MAX_DIRECTORY_ENTRIES) { markIncomplete(diagnostics, `Repository scan stopped reading a directory after ${MAX_DIRECTORY_ENTRIES} entries.`); break; }
      entries.push(entry);
    }
  } finally { dir.closeSync(); }
  return entries;
}

function pathIdentity(value: string): string {
  const exact = realpathSync(value);
  const metadata = statSync(exact);
  return `${metadata.dev}:${metadata.ino}`;
}
function markIncomplete(diagnostics: ScanDiagnostics, limitation: string): void { diagnostics.complete = false; if (diagnostics.limitations.length < 16 && !diagnostics.limitations.includes(limitation)) diagnostics.limitations.push(limitation); }
function hasTerminalControls(value: string): boolean { return /[\u0000-\u001f\u007f-\u009f]/.test(value) || BIDI_CONTROL.test(value); }
function safeInventoryText(value: string): string { BIDI_CONTROLS.lastIndex = 0; return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, "�").replace(BIDI_CONTROLS, "�"); }
function unique(values: string[]): string[] { return [...new Set(values)]; }
