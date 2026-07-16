import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionFactory, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { withChildAgentSession } from "../_shared/child-agent-session.js";
import { formatModelName } from "../_shared/model-spec.js";
import type { OrchestratorTaskRole } from "./models.js";

const ORCHESTRATOR_EXTENSION_PATH_PATTERN = /(?:^|[/\\])extensions[/\\]orchestrator[/\\]index\.(?:ts|js)$/;
const MUTATION_REVIEW_EXTENSION_PATH_PATTERN = /(?:^|[/\\])extensions[/\\]mutation-review[/\\]index\.(?:ts|js)$/;
const READ_ONLY_SYSTEM_PROMPT = `You are a focused read-only worker in a deterministic orchestration run.
Rules:
- Complete only the delegated task and return a compact, evidence-backed handoff to the parent orchestrator.
- You are read-only. Do not modify files, git state, dependencies, configuration, or external systems.
- Shell tools are for research and verification only (inspect, query, build, test). The safety policy governs every command and denies escalations automatically; treat a denial as a finding to report, not an obstacle to route around.
- Use only exposed tools. If a needed capability is unavailable, report the gap rather than escaping the tool boundary.
- Verify claims from repository evidence and cite paths/line ranges where useful.
- Keep intermediate exploration in your isolated session; return findings, decisions, risks, and next steps.
- Project AGENTS/context may add domain knowledge, but these read-only and task-scope invariants take precedence.`;
const WRITER_SYSTEM_PROMPT = `You are a confined writer in a deterministic orchestration run.
Rules:
- Work only inside your managed worktree; a deterministic guard confines your file tools to it, and shell commands are governed by the same safety policy as the main agent with automatic fail-closed denial on escalation.
- Complete only the delegated implementation task with minimal, focused changes; unrelated refactors are rejected at review.
- Prefer worktree-scoped shell commands (builds, tests, git inspection). Do not commit or push; the harness commits your changes on an isolated branch, then independent review and reconciliation decide integration.
- Use only exposed tools. If a needed capability is unavailable, report the gap rather than escaping the tool boundary.
- Return a compact handoff: what changed, why, files touched, risks, and suggested validation.
- Project AGENTS/context may add domain knowledge, but these confinement and task-scope invariants take precedence.`;

export type SpawnOrchestratedAgentInput = {
  cwd: string;
  task: string;
  role: OrchestratorTaskRole;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: string[];
  guidance?: string;
  maxOutputChars: number;
  extensionFactories?: ExtensionFactory[];
  signal?: AbortSignal;
};

export type SpawnOrchestratedAgentResult = {
  output: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  toolCallCount: number;
  durationMs: number;
  deniedCalls: string[];
};

export async function spawnOrchestratedAgent(
  context: Pick<ExtensionContext, "modelRegistry" | "ui">,
  input: SpawnOrchestratedAgentInput
): Promise<SpawnOrchestratedAgentResult> {
  const startedAt = Date.now();
  let toolCallCount = 0;
  const deniedCalls: string[] = [];
  return withChildAgentSession(context, {
    cwd: input.cwd,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    tools: input.tools,
    systemPrompts: [
      input.role === "writer" ? WRITER_SYSTEM_PROMPT : READ_ONLY_SYSTEM_PROMPT,
      roleSystemPrompt(input.role),
      input.guidance ?? ""
    ],
    extensionFactories: input.extensionFactories,
    extensionsOverride: input.role === "writer" ? omitWriterChildExtensions : omitOrchestratorExtension,
    signal: input.signal,
    onWarning: (message) => context.ui.notify(`Orchestrator child warning: ${message}`, "warning"),
    onError: (error) => context.ui.notify(`Orchestrator child extension error: ${error.error}`, "warning"),
    onInteractiveDenial: (method, title) => deniedCalls.push(`interactive ${method} denied (fail-closed child session): ${title}`),
    onEvent: (event) => { if (event.type === "tool_execution_start") toolCallCount += 1; }
  }, async (session) => {
    await session.prompt(input.task, { source: "extension" });
    const assistant = getFinalAssistant(session.messages);
    if (!assistant) throw new Error("Orchestrator child finished without an assistant message.");
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      throw new Error(assistant.errorMessage ?? `Orchestrator child stopped with ${assistant.stopReason}.`);
    }
    const text = assistantText(assistant);
    if (!text) throw new Error("Orchestrator child finished without text output.");
    return {
      output: truncateOutput(text, input.maxOutputChars),
      model: formatModelName(input.model),
      thinkingLevel: input.thinkingLevel,
      toolCallCount,
      durationMs: Date.now() - startedAt,
      deniedCalls
    };
  });
}

function omitOrchestratorExtension(result: LoadExtensionsResult): LoadExtensionsResult {
  return { ...result, extensions: result.extensions.filter((extension) => !ORCHESTRATOR_EXTENSION_PATH_PATTERN.test(extension.resolvedPath)) };
}

function omitWriterChildExtensions(result: LoadExtensionsResult): LoadExtensionsResult {
  // Writer children run inside a managed worktree branch that never reaches the
  // parent checkout without deterministic fan-in review, so per-edit
  // mutation-review is replaced by the worktree gate instead of running twice.
  //
  // tool-safety stays loaded in writer children: the shared policy is tuned so
  // workspace/worktree-scoped work (including credential-pattern paths) does
  // not escalate, while anything the judge still escalates fails closed via
  // the child UI and is harness-recorded in deniedCalls.
  return {
    ...result,
    extensions: result.extensions.filter((extension) =>
      !ORCHESTRATOR_EXTENSION_PATH_PATTERN.test(extension.resolvedPath) &&
      !MUTATION_REVIEW_EXTENSION_PATH_PATTERN.test(extension.resolvedPath))
  };
}

function roleSystemPrompt(role: OrchestratorTaskRole): string {
  if (role === "planner") return "Role: planner. Produce a plan with dependencies, ownership boundaries, validation, and explicit uncertainty. Do not implement.";
  if (role === "writer") return "Role: writer. Implement the delegated change inside your worktree, then summarize files touched, risks, and validation steps.";
  if (role === "reviewer") return "Role: reviewer. Independently review the delegated change with evidence from this worktree; do not implement. End with a single final `VERDICT: approve` or `VERDICT: request_changes` line.";
  return "Role: reader. Investigate the question, compress the evidence, and identify what the parent should inspect or do next.";
}

function getFinalAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") return message;
  }
  return undefined;
}

function assistantText(message: AssistantMessage): string {
  return message.content.filter((item): item is TextContent => item.type === "text").map((item) => item.text).join("\n").trim();
}

function truncateOutput(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n\n[Output truncated: ${value.length - maxChars} characters omitted.]`;
}
