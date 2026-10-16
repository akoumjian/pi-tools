import type { WorkerRole } from "./registry.js";

export type MountedInput = { sourcePath: string; mountedPath: string; type: "file" | "directory" };
export type WorkerPromptInput = {
  workerId: string; runId: string; workspaceRoot: string; codeRoot: string; taskIds: string[];
  roleInstructions: string; instructions?: string; repositoryBaselines?: Array<{ path: string; resolvedCommit: string }>;
  additionalInputs?: MountedInput[]; reviewSubjectPath?: string; reviewContextPath?: string; integrationContextPath?: string;
  resumed?: boolean; cancelledPreviously?: boolean;
};

export function renderWorkerRuntimePrompt(role: WorkerRole, input: WorkerPromptInput): string {
  const common = input.resumed
    ? `You are worker ${input.workerId}, run ${input.runId}, resuming a prior ${role === "work" ? "session" : `${role} session`}. You are running in a sandboxed environment with modified file access and permissions.`
    : role === "work"
      ? `You are worker ${input.workerId}, run ${input.runId}, forked from a parent session. You are running in a sandboxed environment with modified file access and permissions.`
      : role === "review"
        ? `You are worker ${input.workerId}, run ${input.runId}, starting an independent review. You are running in a sandboxed environment with modified file access and permissions.`
        : `You are worker ${input.workerId}, run ${input.runId}, starting repository integration. You are running in a sandboxed environment with modified file access and permissions.`;
  const lines = [common, "", "Writable workspace:", input.workspaceRoot, "", "General read-only access:", input.codeRoot, "", "The complete Code directory is available for your reference as needed."];
  if (role !== "review") lines.push("", "Assigned Beads tasks:", input.taskIds.join(", "));
  if (role === "review") {
    lines.push("", "Reviewed workspace:", input.reviewSubjectPath ?? "/review/subject", "", "Review context:", input.reviewContextPath ?? "/review/context.json", "");
    lines.push(input.resumed
      ? "The reviewed workspace is a fresh writable disposable view of the same reviewed run. Changes from prior review overlays are not retained; reports and other files in your own writable workspace remain available."
      : "The reviewed workspace is a writable disposable view. Changes there do not modify the original worker workspace and are removed when this review run settles. Write retained review reports in your own writable workspace.");
  }
  if (role === "integration") {
    lines.push("", "Integration context:", input.integrationContextPath ?? "/integration/context.json", "");
    lines.push(input.resumed
      ? "The prepared repositories and prior integration work remain in your writable workspace. Use the updated integration context for any new additional inputs."
      : "Resolve the complete prepared repository set described in the integration context. The prepared repositories are already located inside your writable workspace. Conflict details are recorded in the integration context, and each affected repository remains in the ordinary Git conflict state produced by `worker_merge_test`.");
  }
  if (input.cancelledPreviously) lines.push("", "The previous run was cancelled. Inspect the retained workspace and any interrupted operations before continuing. Do not remove locks or abort Git state until you verify that no owning process remains.");
  lines.push("", "Role instructions:", input.roleInstructions);
  if (input.instructions !== undefined) lines.push("", role === "work" && !input.resumed ? "Assignment:" : role === "review" && !input.resumed ? "Parent review instructions:" : role === "integration" && !input.resumed ? "Parent integration instructions:" : "Parent instructions:", input.instructions);
  if (!input.resumed && role === "work" && input.repositoryBaselines?.length) {
    lines.push("", "Repository baselines:", ...input.repositoryBaselines.map((baseline) => `- ${baseline.path} at ${baseline.resolvedCommit}`), "", "These baselines identify exact source revisions relevant to the assignment. They do not populate the workspace.");
  }
  if (input.resumed && role === "work" && input.additionalInputs?.length) {
    lines.push("", "Additional read-only inputs:", ...input.additionalInputs.map((item) => `- ${item.sourcePath} -> ${item.mountedPath} (${item.type})`));
  }
  return lines.join("\n");
}
