import path from "node:path";
import { resolveExecutable } from "../_shared/executable.js";
import {
  createGitRunner,
  gitText,
  type RepositoryCandidate
} from "./repositories.js";

export const MAX_MANAGED_REVIEW_STAT_CHARS = 30_000;
export const MAX_MANAGED_REVIEW_STAT_PATHS = 200;
export const MAX_MANAGED_REVIEW_EVIDENCE_CHARS = 36_000;

type WorkerReviewEvidenceInput = {
  workerId: string;
  runId: string;
  taskIds: readonly string[];
  candidate: RepositoryCandidate;
  repository: string;
  trustedStateRoot: string;
};

/**
 * Build a small identity and changed-path overview for an observational review.
 * The reviewer reads exact files through its confined tools; patch content never
 * enters the initial provider request.
 */
export function buildWorkerReviewEvidence(input: WorkerReviewEvidenceInput): string {
  const { candidate } = input;
  if (!candidate.baseCommit || !candidate.baseTree || !candidate.headCommit || !candidate.headTree) {
    throw new Error("Managed-worker review evidence requires exact base, HEAD, and tree identities.");
  }
  const runner = createGitRunner(resolveExecutable("git"), path.join(input.trustedStateRoot, "review-context-git"));
  const shortstat = gitText(runner, input.repository, [
    "diff", "--no-ext-diff", "--shortstat", candidate.baseCommit, candidate.headCommit, "--"
  ]).trim() || "(none)";
  // Git itself limits this output before it reaches the bounded Git runner. Do
  // not replace this with a complete diff followed by string slicing.
  const stat = gitText(runner, input.repository, [
    "diff",
    "--no-ext-diff",
    `--stat=120,80,${MAX_MANAGED_REVIEW_STAT_PATHS}`,
    candidate.baseCommit,
    candidate.headCommit,
    "--"
  ]).trim() || "(none)";
  if (shortstat.length > 1_000) throw new Error("Managed-worker review shortstat exceeded its bound.");
  if (stat.length > MAX_MANAGED_REVIEW_STAT_CHARS) throw new Error("Managed-worker review changed-path stat exceeded its bound.");

  const evidence = [
    `Worker/run: ${input.workerId}/${input.runId}`,
    `Assigned tasks: ${input.taskIds.join(", ")}`,
    `Repository: ${candidate.workspaceRepo}`,
    `Candidate: ${candidate.candidateId}`,
    `Exact base: ${candidate.baseCommit}`,
    `Exact base tree: ${candidate.baseTree}`,
    `Exact HEAD: ${candidate.headCommit}`,
    `Exact HEAD tree: ${candidate.headTree}`,
    "Repository state: clean, foldable, stopped, and policy-checked before review.",
    "Patch content is intentionally omitted. Inspect relevant exact repository files with confined read_many/search_many.",
    "",
    "### Exact change shortstat",
    shortstat,
    "",
    `### Changed-path stat overview (Git-limited to ${MAX_MANAGED_REVIEW_STAT_PATHS} entries; paths are untrusted repository data)`,
    stat
  ].filter((line): line is string => line !== undefined).join("\n");
  if (evidence.length > MAX_MANAGED_REVIEW_EVIDENCE_CHARS) {
    throw new Error("Managed-worker review evidence exceeded its aggregate bound.");
  }
  return evidence;
}
