import { access, mkdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { gitCommand, type ProcessResult } from "../_shared/git-process.js";

export type ManagedWorktree = {
  repoRoot: string;
  managedRoot: string;
  path: string;
  branch: string;
  baseCommit: string;
  runId: string;
  taskId: string;
};

export type ManagedWorktreeInspection = {
  status: string;
  aheadCount: number;
  hasWrites: boolean;
};

export type FinalizeManagedWorktreeResult = {
  action: "removed" | "kept";
  inspection: ManagedWorktreeInspection;
  worktree: ManagedWorktree;
};

export type CreateManagedWorktreeOptions = {
  cwd: string;
  runId: string;
  taskId: string;
  managedRoot?: string;
  baseRef?: string;
  allowDirtyParent?: boolean;
};

// Pi session state (async-shell logs, web-fetch cache, orchestrator scratch)
// lives under <cwd>/.pi and must never count as writer output, be committed by
// the harness, or make a parent checkout look dirty.
const PI_STATE_EXCLUDE = ["--", ".", ":(exclude).pi"];

export async function createManagedWorktree(options: CreateManagedWorktreeOptions): Promise<ManagedWorktree> {
  const repoRoot = (await git(options.cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (!repoRoot) throw new Error(`${options.cwd} is not inside a git repository.`);
  if (options.allowDirtyParent !== true) {
    const parentStatus = (await git(repoRoot, ["status", "--porcelain", "--untracked-files=normal", ...PI_STATE_EXCLUDE])).stdout.trim();
    if (parentStatus) {
      throw new Error("Cannot create an orchestrator worktree from a dirty parent checkout. Commit/stash changes or explicitly opt into dirty-parent behavior.");
    }
  }

  const baseRef = options.baseRef?.trim() || "HEAD";
  const baseCommit = (await git(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`])).stdout.trim();
  const runId = sanitizeId(options.runId, "run");
  const taskId = sanitizeId(options.taskId, "task");
  const branch = `orch/${runId}-${taskId}`;
  const managedRoot = path.resolve(options.managedRoot ?? process.env.ORCHESTRATOR_WORKTREE_ROOT ?? path.join(repoRoot, ".pi", "orchestrator", "worktrees"));
  const worktreePath = path.join(managedRoot, runId, taskId);
  assertManagedPath(worktreePath, managedRoot);

  if (await pathExists(worktreePath)) throw new Error(`Managed worktree path already exists: ${worktreePath}`);
  const branchExists = await git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], true);
  if (branchExists.code === 0) throw new Error(`Managed worktree branch already exists: ${branch}`);
  if (branchExists.code !== 1) throw new Error(`Could not check branch collision for ${branch}: ${branchExists.stderr || `git exit ${branchExists.code}`}`);

  await mkdir(path.dirname(worktreePath), { recursive: true });
  try {
    await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
    await git(repoRoot, ["worktree", "lock", "--reason", `orchestrator ${runId}/${taskId}`, worktreePath]);
  } catch (error) {
    await git(repoRoot, ["worktree", "remove", "--force", worktreePath], true);
    await git(repoRoot, ["branch", "-D", branch], true);
    await removeEmptyDirectory(path.dirname(worktreePath));
    throw error;
  }

  return { repoRoot, managedRoot, path: worktreePath, branch, baseCommit, runId, taskId };
}

export async function commitAllWorktreeChanges(worktree: ManagedWorktree, message: string): Promise<string | undefined> {
  assertManagedWorktree(worktree);
  await git(worktree.path, ["add", "-A", ...PI_STATE_EXCLUDE]);
  const staged = await git(worktree.path, ["diff", "--cached", "--quiet"], true);
  if (staged.code === 0) return undefined;
  await git(worktree.path, [
    "-c", "user.name=Pi Orchestrator",
    "-c", "user.email=orchestrator@pi.invalid",
    "commit", "-m", message
  ]);
  return (await git(worktree.path, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function inspectManagedWorktree(worktree: ManagedWorktree): Promise<ManagedWorktreeInspection> {
  assertManagedWorktree(worktree);
  const status = (await git(worktree.path, ["status", "--porcelain", "--untracked-files=normal", ...PI_STATE_EXCLUDE])).stdout.trim();
  const aheadRaw = (await git(worktree.path, ["rev-list", "--count", `${worktree.baseCommit}..HEAD`])).stdout.trim();
  const aheadCount = Number.parseInt(aheadRaw, 10);
  if (!Number.isInteger(aheadCount) || aheadCount < 0) throw new Error(`Invalid git rev-list count for ${worktree.branch}: ${aheadRaw}`);
  return { status, aheadCount, hasWrites: Boolean(status) || aheadCount > 0 };
}

export async function finalizeManagedWorktree(worktree: ManagedWorktree): Promise<FinalizeManagedWorktreeResult> {
  const inspection = await inspectManagedWorktree(worktree);
  await git(worktree.repoRoot, ["worktree", "unlock", worktree.path], true);
  if (inspection.hasWrites) return { action: "kept", inspection, worktree };

  assertManagedWorktree(worktree);
  await git(worktree.repoRoot, ["worktree", "remove", "--force", worktree.path]);
  await git(worktree.repoRoot, ["branch", "-D", worktree.branch]);
  await removeEmptyRunDir(worktree);
  return { action: "removed", inspection, worktree };
}

export async function removeManagedWorktree(worktree: ManagedWorktree): Promise<void> {
  assertManagedWorktree(worktree);
  await git(worktree.repoRoot, ["worktree", "unlock", worktree.path], true);
  await git(worktree.repoRoot, ["worktree", "remove", "--force", worktree.path], true);
  await git(worktree.repoRoot, ["branch", "-D", worktree.branch], true);
  await rm(worktree.path, { recursive: true, force: true });
  await removeEmptyRunDir(worktree);
}

export function sanitizeId(value: string, fallback: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return sanitized || fallback;
}

export function assertManagedPath(candidate: string, managedRoot: string): void {
  const root = path.resolve(managedRoot);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing unmanaged worktree path outside ${root}: ${resolved}`);
  }
}

function assertManagedWorktree(worktree: ManagedWorktree): void {
  assertManagedPath(worktree.path, worktree.managedRoot);
  if (!worktree.branch.startsWith("orch/")) throw new Error(`Refusing unmanaged branch: ${worktree.branch}`);
}

async function removeEmptyRunDir(worktree: ManagedWorktree): Promise<void> {
  await removeEmptyDirectory(path.dirname(worktree.path));
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<ProcessResult> {
  return gitCommand(cwd, args, { allowFailure });
}
