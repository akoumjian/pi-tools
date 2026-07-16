import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAllowedRootExtension } from "./confine.js";
import { changedFilesForBranch } from "./reconcile.js";
import { spawnOrchestratedAgent, type SpawnOrchestratedAgentResult } from "./spawn.js";
import {
  commitAllWorktreeChanges,
  createManagedWorktree,
  finalizeManagedWorktree,
  type ManagedWorktree
} from "./worktree.js";

export type WriterTaskInput = {
  parentCwd: string;
  runId: string;
  taskId: string;
  task: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: string[];
  shellTools: string[];
  guidance?: string;
  maxOutputChars: number;
  signal?: AbortSignal;
};

export type WriterWorktreeReport = {
  branch: string;
  path: string;
  baseCommit: string;
  action: "removed" | "kept";
};

export type WriterTaskOutcome = SpawnOrchestratedAgentResult & {
  worktree: WriterWorktreeReport;
  commit?: string;
  changedFiles: string[];
};

export async function runWriterTask(
  context: Pick<ExtensionContext, "modelRegistry" | "ui">,
  input: WriterTaskInput
): Promise<WriterTaskOutcome> {
  const worktree = await createManagedWorktree({
    cwd: input.parentCwd,
    runId: input.runId,
    taskId: input.taskId
  });

  const confinementDenials: string[] = [];
  let result: SpawnOrchestratedAgentResult;
  try {
    result = await spawnOrchestratedAgent(context, {
      cwd: worktree.path,
      task: input.task,
      role: "writer",
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      tools: [...input.tools, ...input.shellTools],
      guidance: input.guidance,
      maxOutputChars: input.maxOutputChars,
      extensionFactories: [
        createAllowedRootExtension(
          worktree.path,
          (_toolName, reason) => confinementDenials.push(reason),
          input.shellTools
        )
      ],
      signal: input.signal
    });
  } catch (error) {
    const disposition = await salvageFailedWriterWorktree(worktree, input);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(disposition ? `${message} ${disposition}` : message);
  }

  const commit = await commitAllWorktreeChanges(worktree, writerCommitMessage(input, "completed"));
  const changedFiles = commit ? await changedFilesForBranch(worktree.path, worktree.baseCommit, "HEAD") : [];
  const finalized = await finalizeManagedWorktree(worktree);
  return {
    ...result,
    deniedCalls: [...result.deniedCalls, ...confinementDenials],
    ...(commit ? { commit } : {}),
    changedFiles,
    worktree: {
      branch: worktree.branch,
      path: worktree.path,
      baseCommit: worktree.baseCommit,
      action: finalized.action
    }
  };
}

async function salvageFailedWriterWorktree(worktree: ManagedWorktree, input: WriterTaskInput): Promise<string | undefined> {
  try {
    await commitAllWorktreeChanges(worktree, writerCommitMessage(input, "partial, writer failed"));
    const finalized = await finalizeManagedWorktree(worktree);
    return finalized.action === "kept"
      ? `Partial writes were committed and kept on ${worktree.branch} at ${worktree.path}.`
      : `The clean worktree and branch ${worktree.branch} were removed.`;
  } catch (cleanupError) {
    const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    return `Worktree cleanup also failed for ${worktree.path}: ${message}`;
  }
}

function writerCommitMessage(input: WriterTaskInput, status: string): string {
  const summary = input.task.split(/\r?\n/, 1)[0]?.trim().slice(0, 72) || input.taskId;
  return `orchestrator ${input.runId}/${input.taskId} (${status}): ${summary}`;
}
