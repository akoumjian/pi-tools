import type { WorkerRole } from "./registry.js";

export type MountedInput = { sourcePath: string; mountedPath: string; type: "file" | "directory" };
export type WorkerPromptInput = {
  workerId: string; runId: string; workspaceRoot: string; codeRoot: string; taskIds: string[];
  roleInstructions: string; instructions?: string; repositoryBaselines?: Array<{ path: string; resolvedCommit: string }>;
  additionalInputs?: MountedInput[]; reviewSubjectPath?: string; reviewContextPath?: string; integrationContextPath?: string;
  resumed?: boolean; cancelledPreviously?: boolean;
  cacheLineageMarker?: string;
  interruptionWarnings?: string[]; runtimeChange?: string;
  initialSession?: boolean;
};

export function renderWorkerRuntimePrompt(role: WorkerRole, input: WorkerPromptInput): string {
  if (role === "review" && (!input.reviewSubjectPath || !input.reviewContextPath)) throw new Error("Review prompts require exact reviewed-workspace and context paths.");
  if (role === "integration" && !input.integrationContextPath) throw new Error("Integration prompts require an exact context path.");
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
    lines.push("", "Reviewed workspace:", input.reviewSubjectPath ?? "<missing reviewed workspace>", "", "Review context:", input.reviewContextPath ?? "<missing review context>", "");
    lines.push(input.resumed
      ? "The reviewed workspace remains read-only. Use your retained writable reviewer workspace for tests, copies, experiments, and reports."
      : "The reviewed workspace is read-only. Use your separate writable reviewer workspace for tests, copies, experiments, and retained review reports.");
  }
  if (role === "integration") {
    lines.push("", "Integration context:", input.integrationContextPath!, "");
    lines.push(input.resumed
      ? "The prepared repositories and prior integration work remain in your writable workspace. Use the updated integration context for any new additional inputs."
      : "Resolve the complete prepared repository set described in the integration context. The prepared repositories are already located inside your writable workspace. Conflict details are recorded in the integration context, and each affected repository remains in the ordinary Git conflict state produced by `worker_merge_test`.");
  }
  if (input.runtimeChange) lines.push("", "Runtime/tool contract change:", input.runtimeChange);
  if (input.cancelledPreviously) { lines.push("", "The previous run was cancelled or system-failed. Inspect the retained workspace and any interrupted operations before continuing. Do not remove locks or abort Git state until you verify that no owning process remains."); if (input.interruptionWarnings?.length) lines.push("", "Recorded interrupted-state warnings:", ...input.interruptionWarnings.map((warning) => `- ${warning}`)); }
  if (role === "work" && (!input.resumed || input.initialSession) && input.cacheLineageMarker) lines.push("", `Trusted cache-lineage initial assignment marker: ${input.cacheLineageMarker}. Preserve this exact marker in this initial assignment; do not repeat it.`);
  lines.push("", "Role instructions:", input.roleInstructions);
  if (input.instructions !== undefined) lines.push("", role === "work" && !input.resumed ? "Assignment:" : role === "review" && !input.resumed ? "Parent review instructions:" : role === "integration" && !input.resumed ? "Parent integration instructions:" : "Parent instructions:", input.instructions);
  if (!input.resumed && role === "work" && input.repositoryBaselines?.length) {
    lines.push("", "Provenance-only repository baselines:", ...input.repositoryBaselines.map((baseline) => `- parent-observed ${baseline.path} at ${baseline.resolvedCommit}`), "", "These entries are provenance only. Their paths are not mounted into the worker and may be unreachable here; they do not populate the workspace.");
  }
  if (input.resumed && role === "work" && input.additionalInputs?.length) {
    lines.push("", "Additional read-only inputs:", ...input.additionalInputs.map((item) => `- ${item.sourcePath} -> ${item.mountedPath} (${item.type})`));
  }
  return lines.join("\n");
}
