import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gitCommand } from "../_shared/git-process.js";
import { formatModelName } from "../_shared/model-spec.js";
import { selectDistinctReviewer } from "./models.js";
import { spawnOrchestratedAgent } from "./spawn.js";

export type WriterReviewVerdict = "approve" | "request_changes" | "unparseable" | "failed";

export type WriterReviewReport = {
  status: WriterReviewVerdict;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  output?: string;
  durationMs?: number;
  deniedCalls?: string[];
  error?: string;
};

export type WriterReviewInput = {
  worktreePath: string;
  branch: string;
  baseCommit: string;
  task: string;
  writerOutput: string;
  writerModel: Model<Api>;
  reviewerSpecs: string[];
  tools: string[];
  shellTools: string[];
  guidance?: string;
  maxOutputChars: number;
  maxDiffChars?: number;
  signal?: AbortSignal;
};

const DEFAULT_MAX_DIFF_CHARS = 60_000;

export async function reviewWriterBranch(
  context: Pick<ExtensionContext, "modelRegistry" | "ui">,
  input: WriterReviewInput
): Promise<WriterReviewReport> {
  let reviewer;
  try {
    reviewer = selectDistinctReviewer(context.modelRegistry, input.reviewerSpecs, input.writerModel);
  } catch (error) {
    return { status: "failed", error: errorMessage(error) };
  }

  let diff: string;
  let diffStat: string;
  try {
    diff = (await gitCommand(input.worktreePath, ["diff", `${input.baseCommit}..HEAD`, "--"])).stdout;
    diffStat = (await gitCommand(input.worktreePath, ["diff", "--stat", `${input.baseCommit}..HEAD`, "--"])).stdout.trim();
  } catch (error) {
    return { status: "failed", error: `Could not compute branch diff for review: ${errorMessage(error)}` };
  }

  try {
    const result = await spawnOrchestratedAgent(context, {
      cwd: input.worktreePath,
      task: buildWriterReviewTask({
        task: input.task,
        writerOutput: input.writerOutput,
        branch: input.branch,
        baseCommit: input.baseCommit,
        diffStat,
        diff,
        maxDiffChars: input.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS
      }),
      role: "reviewer",
      model: reviewer.model,
      thinkingLevel: reviewer.thinkingLevel,
      tools: [...input.tools, ...input.shellTools],
      guidance: input.guidance,
      maxOutputChars: input.maxOutputChars,
      signal: input.signal
    });
    return {
      status: parseReviewVerdict(result.output) ?? "unparseable",
      model: result.model,
      thinkingLevel: result.thinkingLevel,
      output: result.output,
      durationMs: result.durationMs,
      deniedCalls: result.deniedCalls
    };
  } catch (error) {
    return {
      status: "failed",
      model: formatModelName(reviewer.model),
      thinkingLevel: reviewer.thinkingLevel,
      error: errorMessage(error)
    };
  }
}

export function buildWriterReviewTask(input: {
  task: string;
  writerOutput: string;
  branch: string;
  baseCommit: string;
  diffStat: string;
  diff: string;
  maxDiffChars: number;
}): string {
  const truncatedDiff = input.diff.length <= input.maxDiffChars
    ? input.diff
    : `${input.diff.slice(0, input.maxDiffChars)}\n[Diff truncated: ${input.diff.length - input.maxDiffChars} characters omitted. Use read-only tools to inspect the remaining files.]`;
  return [
    "Independently review another agent's change before it can be integrated.",
    "",
    `Branch: ${input.branch} (base ${input.baseCommit})`,
    "Your working directory is the writer's isolated worktree at the reviewed state.",
    "",
    "## Task the writer was given",
    input.task.trim(),
    "",
    "## Writer's handoff",
    input.writerOutput.trim() || "(no handoff text)",
    "",
    "## Diff stat",
    input.diffStat || "(empty)",
    "",
    "## Diff",
    "```diff",
    truncatedDiff.trim(),
    "```",
    "",
    "## Review instructions",
    "- Verify correctness against the task, scope discipline (no unrelated changes), risks, and missing tests/validation.",
    "- Use the read-only tools to inspect surrounding code in this worktree; do not trust the handoff over the diff.",
    "- Report concrete findings with file paths. Distinguish blocking issues from suggestions.",
    "- End your reply with exactly one final line: `VERDICT: approve` or `VERDICT: request_changes`."
  ].join("\n");
}

export function parseReviewVerdict(output: string): "approve" | "request_changes" | undefined {
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^\s*\**\s*VERDICT\s*:\s*(approve|request[\s_-]?changes)\s*\**\s*$/i);
    if (match) {
      return match[1].toLowerCase().startsWith("approve") ? "approve" : "request_changes";
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
