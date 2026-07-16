import { gitCommand, runProcess } from "../_shared/git-process.js";

export type ReconcileCandidate = {
  branch: string;
  changedFiles: string[];
};

export type CandidateOverlap = {
  left: string;
  right: string;
  files: string[];
};

export type MergeProbe = {
  clean: boolean;
  treeOid?: string;
  output: string;
  exitCode: number;
};

export type ValidationCommand = {
  command: string;
  args?: string[];
  timeoutMs?: number;
};

export type FoldCandidateResult = {
  status: "merged" | "conflict" | "validation_failed" | "merge_failed";
  branch: string;
  beforeCommit: string;
  afterCommit?: string;
  probe: MergeProbe;
  validation?: { code: number; stdout: string; stderr: string };
  error?: string;
};

export type InPlaceMergeResult = {
  status: "merged" | "conflict" | "failed";
  integrationCommit: string;
  conflictedFiles: string[];
  error?: string;
};

export type CompleteResolutionResult = {
  status: "completed" | "unresolved" | "validation_failed" | "commit_failed";
  conflictedFiles: string[];
  commit?: string;
  error?: string;
  validation?: { code: number; stdout: string; stderr: string };
};

export async function changedFilesForBranch(cwd: string, baseCommit: string, branch: string): Promise<string[]> {
  const result = await gitCommand(cwd, ["diff", "--name-only", `${baseCommit}..${branch}`, "--"]);
  return uniqueSortedLines(result.stdout);
}

export function orderReconcileCandidates(candidates: ReconcileCandidate[]): ReconcileCandidate[] {
  return [...candidates].sort((left, right) => {
    const bySize = left.changedFiles.length - right.changedFiles.length;
    return bySize !== 0 ? bySize : left.branch.localeCompare(right.branch);
  });
}

export function findCandidateOverlaps(candidates: ReconcileCandidate[]): CandidateOverlap[] {
  const overlaps: CandidateOverlap[] = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    const leftFiles = new Set(left.changedFiles);
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex];
      const files = right.changedFiles.filter((file) => leftFiles.has(file)).sort();
      if (files.length > 0) overlaps.push({ left: left.branch, right: right.branch, files });
    }
  }
  return overlaps;
}

export async function probeMerge(cwd: string, left: string, right: string): Promise<MergeProbe> {
  const result = await gitCommand(cwd, ["merge-tree", "--write-tree", "--messages", left, right], { allowFailure: true });
  const firstLine = result.stdout.split(/\r?\n/, 1)[0]?.trim();
  const treeOid = firstLine && /^[0-9a-f]{40,64}$/i.test(firstLine) ? firstLine : undefined;
  return {
    clean: result.code === 0,
    treeOid,
    output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
    exitCode: result.code
  };
}

export async function foldCandidate(
  integrationCwd: string,
  branch: string,
  validation?: ValidationCommand
): Promise<FoldCandidateResult> {
  const status = (await gitCommand(integrationCwd, ["status", "--porcelain", "--untracked-files=normal"])).stdout.trim();
  if (status) throw new Error(`Integration worktree must be clean before folding ${branch}: ${status}`);
  const beforeCommit = (await gitCommand(integrationCwd, ["rev-parse", "HEAD"])).stdout.trim();
  const candidateCommit = (await gitCommand(integrationCwd, ["rev-parse", "--verify", `${branch}^{commit}`])).stdout.trim();
  const probe = await probeMerge(integrationCwd, beforeCommit, candidateCommit);
  if (!probe.clean) return { status: "conflict", branch, beforeCommit, probe };

  const merge = await gitCommand(integrationCwd, ["merge", "--no-ff", "--no-edit", candidateCommit], { allowFailure: true });
  if (merge.code !== 0) {
    await gitCommand(integrationCwd, ["merge", "--abort"], { allowFailure: true });
    await gitCommand(integrationCwd, ["reset", "--hard", beforeCommit]);
    return {
      status: "merge_failed",
      branch,
      beforeCommit,
      probe,
      error: merge.stderr.trim() || merge.stdout.trim() || `git merge exited ${merge.code}`
    };
  }

  if (validation) {
    const result = await runProcess(validation.command, validation.args ?? [], integrationCwd, validation.timeoutMs ?? 120_000);
    const postValidationStatus = (await gitCommand(integrationCwd, ["status", "--porcelain", "--untracked-files=normal"])).stdout.trim();
    if (result.code !== 0 || postValidationStatus) {
      await gitCommand(integrationCwd, ["reset", "--hard", beforeCommit]);
      return {
        status: "validation_failed",
        branch,
        beforeCommit,
        probe,
        validation: result,
        error: postValidationStatus
          ? `Validation left the integration worktree dirty: ${postValidationStatus}`
          : `Validation command exited ${result.code}.`
      };
    }
  }

  const afterCommit = (await gitCommand(integrationCwd, ["rev-parse", "HEAD"])).stdout.trim();
  return { status: "merged", branch, beforeCommit, afterCommit, probe };
}

export async function mergeIntegrationIntoCandidate(candidateCwd: string, integrationRef: string): Promise<InPlaceMergeResult> {
  const status = (await gitCommand(candidateCwd, ["status", "--porcelain", "--untracked-files=normal"])).stdout.trim();
  if (status) throw new Error(`Candidate worktree must be clean before resolve-in-place: ${status}`);
  const integrationCommit = (await gitCommand(candidateCwd, ["rev-parse", "--verify", `${integrationRef}^{commit}`])).stdout.trim();
  const merge = await gitCommand(candidateCwd, ["merge", "--no-ff", "--no-edit", integrationCommit], { allowFailure: true });
  if (merge.code === 0) return { status: "merged", integrationCommit, conflictedFiles: [] };
  const conflictedFiles = uniqueSortedLines((await gitCommand(candidateCwd, ["diff", "--name-only", "--diff-filter=U"])).stdout);
  if (conflictedFiles.length > 0) return { status: "conflict", integrationCommit, conflictedFiles };
  await gitCommand(candidateCwd, ["merge", "--abort"], { allowFailure: true });
  return {
    status: "failed",
    integrationCommit,
    conflictedFiles: [],
    error: merge.stderr.trim() || merge.stdout.trim() || `git merge exited ${merge.code}`
  };
}

export async function completeInPlaceResolution(
  candidateCwd: string,
  validation?: ValidationCommand
): Promise<CompleteResolutionResult> {
  const mergeHead = await gitCommand(candidateCwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFailure: true });
  if (mergeHead.code !== 0) return { status: "unresolved", conflictedFiles: [], error: "No merge is in progress." };
  const conflictedFiles = uniqueSortedLines((await gitCommand(candidateCwd, ["diff", "--name-only", "--diff-filter=U"])).stdout);
  const diffCheck = await gitCommand(candidateCwd, ["diff", "--check"], { allowFailure: true });
  if (diffCheck.code !== 0) {
    return {
      status: "unresolved",
      conflictedFiles,
      error: diffCheck.stdout.trim() || diffCheck.stderr.trim() || "git diff --check found unresolved markers."
    };
  }

  await gitCommand(candidateCwd, ["add", "-A"]);
  const stagedConflicts = uniqueSortedLines((await gitCommand(candidateCwd, ["ls-files", "-u"])).stdout);
  if (stagedConflicts.length > 0) {
    return { status: "unresolved", conflictedFiles, error: "Unmerged index entries remain after staging the resolution." };
  }

  if (validation) {
    const result = await runProcess(validation.command, validation.args ?? [], candidateCwd, validation.timeoutMs ?? 120_000);
    if (result.code !== 0) {
      return {
        status: "validation_failed",
        conflictedFiles,
        validation: result,
        error: `Validation command exited ${result.code}.`
      };
    }
  }

  const commit = await gitCommand(candidateCwd, ["commit", "--no-edit"], { allowFailure: true });
  if (commit.code !== 0) {
    return {
      status: "commit_failed",
      conflictedFiles,
      error: commit.stderr.trim() || commit.stdout.trim() || `git commit exited ${commit.code}`
    };
  }
  return {
    status: "completed",
    conflictedFiles,
    commit: (await gitCommand(candidateCwd, ["rev-parse", "HEAD"])).stdout.trim()
  };
}

function uniqueSortedLines(value: string): string[] {
  return Array.from(new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))).sort();
}
