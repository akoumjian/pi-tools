import { gitCommand } from "../_shared/git-process.js";
import {
  changedFilesForBranch,
  findCandidateOverlaps,
  foldCandidate,
  orderReconcileCandidates,
  type CandidateOverlap,
  type FoldCandidateResult,
  type ValidationCommand
} from "./reconcile.js";
import type { OrchestratorSettings } from "./settings.js";
import { createManagedWorktree, finalizeManagedWorktree, removeManagedWorktree, sanitizeId } from "./worktree.js";

const PI_STATE_EXCLUDE = ["--", ".", ":(exclude).pi"];

export type ReconcileInput = {
  parentCwd: string;
  branches: string[];
  settings: Pick<OrchestratorSettings, "validation">;
  confirm: (title: string, message: string) => Promise<boolean>;
  runId?: string;
};

export type ReconcileSkip = {
  branch: string;
  status: FoldCandidateResult["status"] | "invalid";
  reason: string;
};

export type ReconcileReport = {
  status: "merged" | "declined" | "nothing_merged";
  integrationBranch?: string;
  integrationPath?: string;
  mergeCommit?: string;
  folded: Array<{ branch: string; changedFiles: string[] }>;
  skipped: ReconcileSkip[];
  overlaps: CandidateOverlap[];
  validation: "passed-per-fold" | "unvalidated";
  cleanedBranches: string[];
};

export async function runReconcile(input: ReconcileInput): Promise<ReconcileReport> {
  const { settings } = input;
  const branches = [...new Set(input.branches.map((branch) => branch.trim()).filter(Boolean))];
  if (branches.length === 0) throw new Error("Reconcile requires at least one orch/* branch.");
  for (const branch of branches) {
    if (!branch.startsWith("orch/")) {
      throw new Error(`Reconcile only integrates orchestrator branches (orch/*); refused: ${branch}`);
    }
  }

  const repoRoot = (await gitCommand(input.parentCwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const parentStatus = (await gitCommand(repoRoot, ["status", "--porcelain", "--untracked-files=normal", ...PI_STATE_EXCLUDE])).stdout.trim();
  if (parentStatus) {
    throw new Error(`Reconcile requires a clean parent checkout before integration:\n${parentStatus}`);
  }
  const parentHead = (await gitCommand(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();

  const candidates: Array<{ branch: string; changedFiles: string[] }> = [];
  const skipped: ReconcileSkip[] = [];
  for (const branch of branches) {
    const exists = await gitCommand(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true });
    if (exists.code !== 0) {
      skipped.push({ branch, status: "invalid", reason: "Branch does not exist." });
      continue;
    }
    const base = (await gitCommand(repoRoot, ["merge-base", parentHead, branch])).stdout.trim();
    candidates.push({ branch, changedFiles: await changedFilesForBranch(repoRoot, base, branch) });
  }
  if (candidates.length === 0) {
    return {
      status: "nothing_merged",
      folded: [],
      skipped,
      overlaps: [],
      validation: settings.validation ? "passed-per-fold" : "unvalidated",
      cleanedBranches: []
    };
  }

  const overlaps = findCandidateOverlaps(candidates);
  const ordered = orderReconcileCandidates(candidates);
  const validation: ValidationCommand | undefined = settings.validation
    ? { command: settings.validation.command, args: settings.validation.args, timeoutMs: settings.validation.timeoutMs }
    : undefined;

  const integration = await createManagedWorktree({
    cwd: repoRoot,
    runId: input.runId ?? `r${Date.now().toString(36)}`,
    taskId: "integration"
  });

  const folded: Array<{ branch: string; changedFiles: string[] }> = [];
  try {
    for (const candidate of ordered) {
      const result = await foldCandidate(integration.path, candidate.branch, validation);
      if (result.status === "merged") {
        folded.push(candidate);
      } else {
        skipped.push({
          branch: candidate.branch,
          status: result.status,
          reason: result.error ?? (result.status === "conflict" ? `Merge conflict against the integration branch:\n${result.probe.output.slice(0, 2_000)}` : `Fold failed with ${result.status}.`)
        });
      }
    }

    if (folded.length === 0) {
      await removeManagedWorktree(integration);
      return {
        status: "nothing_merged",
        folded,
        skipped,
        overlaps,
        validation: validation ? "passed-per-fold" : "unvalidated",
        cleanedBranches: []
      };
    }

    const approved = await input.confirm(
      "Merge orchestrator integration branch?",
      buildMergeGateMessage(integration.branch, folded, skipped, overlaps, validation !== undefined)
    );
    if (!approved) {
      await finalizeManagedWorktree(integration);
      return {
        status: "declined",
        integrationBranch: integration.branch,
        integrationPath: integration.path,
        folded,
        skipped,
        overlaps,
        validation: validation ? "passed-per-fold" : "unvalidated",
        cleanedBranches: []
      };
    }

    const headNow = (await gitCommand(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    if (headNow !== parentHead) {
      await finalizeManagedWorktree(integration);
      throw new Error(`Parent HEAD moved during reconcile (${parentHead.slice(0, 12)} -> ${headNow.slice(0, 12)}); integration branch ${integration.branch} was kept for manual merge.`);
    }

    const merge = await gitCommand(repoRoot, ["merge", "--no-ff", "--no-edit", integration.branch], { allowFailure: true });
    if (merge.code !== 0) {
      await gitCommand(repoRoot, ["merge", "--abort"], { allowFailure: true });
      await finalizeManagedWorktree(integration);
      throw new Error(`Merging ${integration.branch} into the parent branch failed: ${merge.stderr.trim() || merge.stdout.trim()}. Integration branch kept for manual inspection.`);
    }
    const mergeCommit = (await gitCommand(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();

    const cleanedBranches: string[] = [];
    for (const candidate of folded) {
      await removeBranchAndWorktree(repoRoot, candidate.branch);
      cleanedBranches.push(candidate.branch);
    }
    await removeManagedWorktree(integration);

    return {
      status: "merged",
      integrationBranch: integration.branch,
      integrationPath: integration.path,
      mergeCommit,
      folded,
      skipped,
      overlaps,
      validation: validation ? "passed-per-fold" : "unvalidated",
      cleanedBranches
    };
  } catch (error) {
    // Deterministic failures above already finalized/kept the integration worktree.
    throw error;
  }
}

export function buildMergeGateMessage(
  integrationBranch: string,
  folded: Array<{ branch: string; changedFiles: string[] }>,
  skipped: ReconcileSkip[],
  overlaps: CandidateOverlap[],
  validated: boolean
): string {
  const lines = [
    `Integration branch ${integrationBranch} is built and ${validated ? "validated after every fold" : "UNVALIDATED (no validation command configured)"}.`,
    "",
    `Folded (${folded.length}):`,
    ...folded.map((entry) => `- ${entry.branch}: ${entry.changedFiles.join(", ") || "(no files reported)"}`)
  ];
  if (skipped.length > 0) {
    lines.push("", `Skipped (${skipped.length}):`, ...skipped.map((entry) => `- ${entry.branch} [${entry.status}] ${firstLine(entry.reason)}`));
  }
  if (overlaps.length > 0) {
    lines.push("", "Changed-file overlaps:", ...overlaps.map((overlap) => `- ${overlap.left} ↔ ${overlap.right}: ${overlap.files.join(", ")}`));
  }
  lines.push("", "Approve to merge into the current branch; folded writer branches and worktrees are then removed. Decline to keep the integration branch for manual review.");
  return lines.join("\n");
}

async function removeBranchAndWorktree(repoRoot: string, branch: string): Promise<void> {
  if (!branch.startsWith("orch/")) throw new Error(`Refusing to clean non-orchestrator branch: ${branch}`);
  const worktreePath = await findWorktreeForBranch(repoRoot, branch);
  if (worktreePath) {
    await gitCommand(repoRoot, ["worktree", "unlock", worktreePath], { allowFailure: true });
    await gitCommand(repoRoot, ["worktree", "remove", "--force", worktreePath], { allowFailure: true });
  }
  await gitCommand(repoRoot, ["branch", "-D", branch]);
}

export async function findWorktreeForBranch(repoRoot: string, branch: string): Promise<string | undefined> {
  const output = (await gitCommand(repoRoot, ["worktree", "list", "--porcelain"])).stdout;
  let currentPath: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ") && line.slice("branch ".length).trim() === `refs/heads/${branch}`) return currentPath;
  }
  return undefined;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value;
}

export function sanitizeReconcileRunId(value: string): string {
  return sanitizeId(value, "run");
}
