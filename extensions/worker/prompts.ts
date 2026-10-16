import type { WorkerRole } from "./registry.js";

export type WorkerPromptInput = {
  workerId: string;
  runId: string;
  workspaceRoot: string;
  codeRoot: string;
  taskIds: string[];
  roleInstructions: string;
  instructions: string;
  parentContextPath?: string;
  reviewContextPath?: string;
  integrationContextPath?: string;
  resumed?: boolean;
  cancelledPreviously?: boolean;
};

export function renderWorkerRuntimePrompt(role: WorkerRole, input: WorkerPromptInput): string {
  const heading = input.resumed
    ? `You are worker ${input.workerId}, run ${input.runId}, resuming a prior ${role} session.`
    : `You are worker ${input.workerId}, run ${input.runId}, starting a ${role} session.`;
  const roleContext = role === "review"
    ? ["Review subject:", "/review/subject", "", "Review context:", input.reviewContextPath ?? "/review/context.json", "", "Your retained writable reports belong under /workspace. Writes under /review/subject are disposable."]
    : role === "integration"
      ? ["Integration context:", input.integrationContextPath ?? "/integration/context.json", "", input.resumed ? "The prepared repositories and prior integration work remain in your writable workspace. Use the updated integration context for any new additional inputs." : "The complete prepared repository set is already inside your writable workspace."]
      : input.parentContextPath ? ["Fresh parent context snapshot:", input.parentContextPath] : [];
  return [
    `${heading} You are running in a sandboxed environment with modified file access and permissions.`,
    "Writable workspace:", input.workspaceRoot,
    "", "General read-only access:", input.codeRoot,
    "", "The complete Code directory is available for your reference as needed.",
    "", "Assigned Beads tasks:", input.taskIds.join(", "),
    "", ...roleContext,
    ...(input.cancelledPreviously ? ["", "The previous run was cancelled. Inspect the retained workspace and any interrupted operations before continuing. Do not remove locks or abort Git state until you verify that no owning process remains."] : []),
    "", "Role instructions:", input.roleInstructions,
    "", "Parent instructions:", input.instructions
  ].join("\n");
}
