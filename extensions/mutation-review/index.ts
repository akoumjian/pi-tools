import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Api, type AssistantMessage, type Model, type Static, type TextContent, type ToolCall } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  defineTool,
  withFileMutationQueue,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type LoadExtensionsResult,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolDefinition,
  type ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import {
  applyExactReplacements,
  nativeEditMutationEntryId,
  nativeEditMutationEntryIds,
  nativeWriteMutationEntryId,
  nativeWriteMutationEntryIds,
  resolveNativeToolPath,
  type EditManyInput,
  type WriteManyInput
} from "../native-tools/index.js";
import { serializeRecentMessages } from "../review-subagent/index.js";
import {
  formatModelName,
  normalizeThinkingLevel,
  resolveExtensionModel,
  type ExtensionModelRegistry,
  type ResolvedExtensionModel
} from "../_shared/model-spec.js";
import { withChildAgentSession } from "../_shared/child-agent-session.js";
import { formatConfigPath, readPiToolsJsonConfigSource, readPiToolsReferencedTextConfig, writeAgentExtensionConfig, type PiToolsJsonConfig } from "../_shared/config.js";
import { registerCommandWithAliases } from "../_shared/deprecated-command.js";
import { guidedModelSetupUsage, parseGuidedModelSetupArgs, readSetupGuidance } from "../_shared/setup-command.js";

const STATUS_KEY = "mutation-review";
const DECISION_TOOL_NAME = "submit_mutation_review";
const APPLY_REVIEWED_MUTATION_TOOL_NAME = "apply_reviewed_mutation";
const MUTATION_APPLY_COMMAND_NAME = "mutation:apply";
const MUTATION_REVIEW_SETUP_COMMAND_NAME = "mutation:setup";
const MUTATION_REVIEW_STATUS_COMMAND_NAME = "mutation:status";
const MUTATION_REVIEW_MODEL_COMMAND_NAME = "mutation:model";
const MUTATION_REVIEW_TOGGLE_COMMAND_NAME = "mutation:toggle";
const MUTATION_REVIEW_EXTENSION_PATH_PATTERN = /(?:^|[/\\])extensions[/\\]mutation-review[/\\]index\.(?:ts|js)$/;
const MUTATION_REVIEW_CONFIG_FILE = "mutation-review-settings.json";

export type MutationReviewSettings = {
  defaultModel?: string;
  guidance?: string;
  guidanceFile?: string;
  thinkingLevel: ThinkingLevel;
  maxRecentMessages: number;
  maxTranscriptChars: number;
  maxDiffChars: number;
  maxOutputTokens: number;
  tools: string[];
  reviewedTools: string[];
};

type MutationKind = "create" | "overwrite" | "replace";

export type FileMutationOperation = {
  id: string;
  kind: MutationKind;
  path: string;
  resolvedPath: string;
  before?: string;
  after: string;
  diff: string;
  beforeHash?: string;
  afterHash: string;
};

export type FileMutationProposal = {
  toolName: string;
  toolCallId: string;
  cwd: string;
  operations: FileMutationOperation[];
  fingerprint: string;
  rawInput: unknown;
};

export type MutationReviewEvidence = {
  path: string;
  lineRange?: string;
  symbol?: string;
  reason: string;
};

export type MutationReviewDecision = {
  decision: "allow" | "block";
  confidence: "low" | "medium" | "high";
  summary: string;
  evidence: MutationReviewEvidence[];
  blockedMutationIds: string[];
  suggestedPath?: string;
};

export type MutationReviewRunResult = {
  decision: MutationReviewDecision;
  model: string;
  thinkingLevel: ThinkingLevel;
  toolCallCount: number;
  durationMs: number;
};

type WriteLikeInput = {
  path: string;
  content: string;
};

type EditLikeInput = {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
};

export type ApplyReviewedMutationFileDetails = {
  id: string;
  path: string;
  resolvedPath: string;
  kind: MutationKind;
  bytes: number;
  lines: number;
  beforeHash?: string;
  afterHash: string;
};

export type ApplyReviewedMutationDetails = {
  id: string;
  fingerprint: string;
  toolName: string;
  toolCallId: string;
  files: ApplyReviewedMutationFileDetails[];
};

export type PendingReviewedMutation = {
  id: string;
  scopeId: string;
  createdAt: string;
  proposal: FileMutationProposal;
  review?: MutationReviewRunResult;
  failure?: string;
};

type PendingReviewedMutationSource =
  | { review: MutationReviewRunResult; failure?: undefined }
  | { review?: undefined; failure: string };

const EvidenceParams = Type.Object({
  path: Type.String({ minLength: 1, description: "Existing file path that supports the reuse/consolidation finding." }),
  lineRange: Type.Optional(Type.String({ description: "Relevant line range, for example 10-25." })),
  symbol: Type.Optional(Type.String({ description: "Relevant existing function, constant, type, class, or module name; include it when known." })),
  reason: Type.String({ minLength: 1, description: "Why this existing code is relevant to the proposed mutation." })
}, { additionalProperties: false });

const SubmitMutationReviewParams = Type.Object({
  decision: Type.Union([Type.Literal("allow"), Type.Literal("block")], {
    description: "allow unless concrete existing code should be reused."
  }),
  confidence: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
    description: "Use block only with high confidence."
  }),
  summary: Type.String({ minLength: 1, description: "One-sentence decision." }),
  evidence: Type.Array(EvidenceParams, {
    description: "Existing code evidence for block; empty for allow."
  }),
  blockedMutationIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "For block decisions, proposed mutation ids to block, such as m_ab12cd34ef56. Empty or omit for allow. Include only affected ids."
  })),
  suggestedPath: Type.Optional(Type.String({ description: "Concrete reuse/consolidation path." }))
}, { additionalProperties: false });

const ApplyReviewedMutationParams = Type.Object({
  id: Type.String({ minLength: 1, description: "Pending mutation-review id, for example mr_ab12cd34." })
}, { additionalProperties: false });

type SubmitMutationReviewInput = Static<typeof SubmitMutationReviewParams>;
type ApplyReviewedMutationInput = Static<typeof ApplyReviewedMutationParams>;

const reviewerSystemPrompt = `You are a fast file-mutation reuse reviewer.

Decide whether the proposed edit/write should reuse existing code instead of adding duplicate code.

Rules:
- Do not modify files.
- Use block only with high confidence and concrete existing code evidence; otherwise allow.
- For tests, block only when the same public API, input category, and assertion already exist. Shared setup or possible parameterization is not enough.
- Judge only reuse/duplication. Do not block for correctness, behavior-change, dead-code, style, naming, or architecture concerns unless concrete duplicate existing code is the reason to reuse.
- Never answer with plain text like "Decision: block"; the final action must be exactly one ${DECISION_TOOL_NAME} call.`;

type PartialMutationReviewToolResult = {
  pendingId: string;
  fingerprint: string;
  review: MutationReviewRunResult;
  blockedOperations: FileMutationOperation[];
  allowedOperations: FileMutationOperation[];
};

const pendingReviewedMutationsByScope = new Map<string, Map<string, PendingReviewedMutation>>();
const partialMutationReviewResultsByScope = new Map<string, Map<string, PartialMutationReviewToolResult>>();
let runtimeMutationReviewEnabled = true;
let runtimeMutationReviewModelOverride: string | undefined;
let mutationReviewUnconfiguredWarningShown = false;

export default function mutationReviewExtension(api: ExtensionAPI): void {
  registerApplyReviewedMutationTool(api);
  registerMutationApplyCommand(api);
  registerMutationReviewSetupCommand(api);
  registerMutationReviewStatusCommand(api);
  registerMutationReviewModelCommand(api);
  registerMutationReviewToggleCommand(api);
  api.on("session_start", (_event, context) => {
    ensureApplyReviewedMutationToolActive(api);
    mutationReviewUnconfiguredWarningShown = false;
    notifyMutationReviewUnconfiguredOnce(context);
  });
  api.on("before_agent_start", () => ensureApplyReviewedMutationToolActive(api));
  api.on("session_shutdown", (event, context) => {
    if (event.reason !== "reload") {
      clearMutationReviewStateForContext(context);
    }
  });
  api.on("tool_call", async (event, context) => reviewMutationToolCall(event, context));
  api.on("tool_result", (event, context) => annotatePartialMutationReviewResult(event, context));
}

async function reviewMutationToolCall(event: ToolCallEvent, context: ExtensionContext): Promise<ToolCallEventResult | undefined> {
  if (!runtimeMutationReviewEnabled) {
    return undefined;
  }

  const rawSettings = readMutationReviewSettings();
  const settings = getEffectiveMutationReviewSettings(rawSettings);
  if (!isMutationReviewConfigured(settings)) {
    notifyMutationReviewUnconfiguredOnce(context);
    return undefined;
  }

  if (!settings.reviewedTools.includes(event.toolName)) {
    return undefined;
  }

  const proposal = await extractFileMutationProposal(context, event);
  if (!proposal || proposal.operations.length === 0) {
    return undefined;
  }

  const pending = findPendingReviewedMutation(context, proposal.fingerprint);
  if (pending) {
    return {
      block: true,
      reason: buildAlreadyPendingBlockReason(pending)
    };
  }

  context.ui.setStatus(STATUS_KEY, `mutation review · ${event.toolName}`);
  try {
    const review = await runMutationReviewSubagent(context, proposal, settings);
    const blockedOperations = blockedOperationsForDecision(proposal, review.decision);
    if (blockedOperations.length === 0) {
      return undefined;
    }

    const blockedProposal = proposalForOperations(proposal, blockedOperations);
    const blocked = rememberPendingReviewedMutation(context, blockedProposal, { review });
    if (blockedOperations.length === proposal.operations.length) {
      return {
        block: true,
        reason: buildReuseBlockReason(blockedProposal, review, blocked.id)
      };
    }

    const blockedIds = new Set(blockedOperations.map((operation) => operation.id));
    const allowedOperations = proposal.operations.filter((operation) => !blockedIds.has(operation.id));
    retainAllowedMutationEntries(event, new Set(allowedOperations.map((operation) => operation.id)));
    rememberPartialMutationReviewResult(context, event.toolCallId, {
      pendingId: blocked.id,
      fingerprint: blockedProposal.fingerprint,
      review,
      blockedOperations,
      allowedOperations
    });
    return undefined;
  } catch (error) {
    const blocked = rememberPendingReviewedMutation(context, proposal, { failure: errorMessage(error) });
    return {
      block: true,
      reason: buildReviewFailureReason(proposal, error, blocked.id)
    };
  } finally {
    context.ui.setStatus(STATUS_KEY, undefined);
  }
}

function registerApplyReviewedMutationTool(api: ExtensionAPI): void {
  api.registerTool(defineTool({
    name: APPLY_REVIEWED_MUTATION_TOOL_NAME,
    label: "Apply Reviewed Mutation",
    description: "Apply a previously blocked mutation-review edit/write by id after validating the files still match their before-review hashes.",
    promptSnippet: "Apply a blocked mutation-review edit/write by id after hash validation.",
    promptGuidelines: [
      `Use ${APPLY_REVIEWED_MUTATION_TOOL_NAME} only when mutation-review blocked an edit/write and you decide to apply that exact original mutation. Pass the id from the block message.`
    ],
    parameters: ApplyReviewedMutationParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: ApplyReviewedMutationInput, _signal, _onUpdate, context): Promise<AgentToolResult<ApplyReviewedMutationDetails>> {
      return applyReviewedMutation(context, params.id);
    }
  }));
}

function ensureApplyReviewedMutationToolActive(api: ExtensionAPI): void {
  const activeTools = api.getActiveTools();
  if (!activeTools.includes(APPLY_REVIEWED_MUTATION_TOOL_NAME)) {
    api.setActiveTools([...activeTools, APPLY_REVIEWED_MUTATION_TOOL_NAME]);
  }
}

function registerMutationApplyCommand(api: ExtensionAPI): void {
  registerCommandWithAliases(
    api,
    MUTATION_APPLY_COMMAND_NAME,
    {
      description: "Apply a pending mutation-review edit/write by id after hash validation.",
      handler: async (args, context) => {
        const id = firstToken(args);
        if (!id) {
          const ids = listPendingReviewedMutationIds(context);
          context.ui.notify(ids.length === 0 ? "No pending mutation-review ids in this session." : `Pending mutation-review ids: ${ids.join(", ")}`, "info");
          return;
        }

        try {
          const result = await applyReviewedMutation(context, id);
          context.ui.notify(firstResultLine(result), "info");
        } catch (error) {
          context.ui.notify(errorMessage(error), "error");
        }
      }
    },
    []
  );
}

function registerMutationReviewSetupCommand(api: ExtensionAPI): void {
  registerCommandWithAliases(
    api,
    MUTATION_REVIEW_SETUP_COMMAND_NAME,
    {
      description: "Persist the mutation-review reviewer model for this machine (usage: /mutation:setup provider/model[:thinking])",
      handler: async (args, context) => {
        handleMutationReviewSetupCommand(args, context);
      }
    },
    []
  );
}

function registerMutationReviewStatusCommand(api: ExtensionAPI): void {
  registerCommandWithAliases(
    api,
    MUTATION_REVIEW_STATUS_COMMAND_NAME,
    {
      description: "Show mutation-review runtime status and reviewer model configuration.",
      handler: async (_args, context) => {
        context.ui.notify(buildMutationReviewStatusText(context), "info");
      }
    },
    []
  );
}

function registerMutationReviewModelCommand(api: ExtensionAPI): void {
  registerCommandWithAliases(
    api,
    MUTATION_REVIEW_MODEL_COMMAND_NAME,
    {
      description: "Set or reset the runtime mutation-review reviewer model (usage: /mutation:model provider/model[:thinking] | reset)",
      handler: async (args, context) => {
        handleMutationReviewModelCommand(args, context);
      }
    },
    []
  );
}

function registerMutationReviewToggleCommand(api: ExtensionAPI): void {
  registerCommandWithAliases(
    api,
    MUTATION_REVIEW_TOGGLE_COMMAND_NAME,
    {
      description: "Enable, disable, or toggle runtime mutation-review enforcement (usage: /mutation:toggle [on|off])",
      handler: async (args, context) => {
        handleMutationReviewToggleCommand(args, context);
      }
    },
    []
  );
}

export async function applyReviewedMutation(context: ExtensionContext, id: string): Promise<AgentToolResult<ApplyReviewedMutationDetails>> {
  const pendingId = id.trim();
  if (!pendingId) {
    throw new Error("apply_reviewed_mutation requires a non-empty id.");
  }

  const pending = getPendingReviewedMutation(context, pendingId);
  if (!pending) {
    throw new Error(buildMissingPendingMutationMessage(context, pendingId));
  }

  const files = await withReviewedMutationQueues(pending.proposal.operations, async () => {
    await validateReviewedMutationBeforeHashes(pending);
    return Promise.all(pending.proposal.operations.map(writeReviewedMutationOperation));
  });

  deletePendingReviewedMutation(pending);

  return {
    content: [{
      type: "text",
      text: [
        `Applied reviewed mutation ${pending.id} (${files.length} file${files.length === 1 ? "" : "s"}).`,
        "Before-file hashes matched the reviewed state.",
        ...files.map((file) => `- ${file.id} ${file.path}: ${file.kind}, ${file.bytes} bytes`)
      ].join("\n")
    }],
    details: {
      id: pending.id,
      fingerprint: pending.proposal.fingerprint,
      toolName: pending.proposal.toolName,
      toolCallId: pending.proposal.toolCallId,
      files
    }
  };
}

export async function extractFileMutationProposal(context: ExtensionContext, event: ToolCallEvent): Promise<FileMutationProposal | undefined> {
  const operations = await extractMutationOperations(context, event);
  if (!operations || operations.every((operation) => operation.before === operation.after)) {
    return undefined;
  }

  const proposalWithoutFingerprint = {
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    cwd: context.cwd,
    operations,
    rawInput: cloneJson(event.input)
  };
  const fingerprint = fingerprintProposal(proposalWithoutFingerprint);

  return {
    ...proposalWithoutFingerprint,
    fingerprint
  };
}

async function extractMutationOperations(context: ExtensionContext, event: ToolCallEvent): Promise<FileMutationOperation[] | undefined> {
  if (event.toolName === "write_many" && isWriteManyInput(event.input)) {
    const entryIds = nativeWriteMutationEntryIds(event.input.writes);
    return Promise.all(event.input.writes.map((write, index) => buildWriteOperation(context, entryIds[index], write.path, write.content)));
  }

  if (event.toolName === "edit_many" && isEditManyInput(event.input)) {
    const entryIds = nativeEditMutationEntryIds(event.input.files);
    return Promise.all(event.input.files.map((file, index) => buildEditOperation(context, entryIds[index], file.path, file.edits)));
  }

  if (event.toolName === "write" && isWriteLikeInput(event.input)) {
    return [await buildWriteOperation(context, nativeWriteMutationEntryId(event.input), event.input.path, event.input.content)];
  }

  if (event.toolName === "edit" && isEditLikeInput(event.input)) {
    return [await buildEditOperation(context, nativeEditMutationEntryId(event.input), event.input.path, event.input.edits)];
  }

  return undefined;
}

async function buildWriteOperation(context: ExtensionContext, id: string, rawPath: string, content: string): Promise<FileMutationOperation> {
  const resolvedPath = resolveNativeToolPath(context.cwd, rawPath);
  const before = await readOptionalText(resolvedPath);
  const kind = before === undefined ? "create" : "overwrite";
  return buildOperation(id, kind, rawPath, resolvedPath, before, content);
}

async function buildEditOperation(
  context: ExtensionContext,
  id: string,
  rawPath: string,
  edits: Array<{ oldText: string; newText: string }>
): Promise<FileMutationOperation> {
  const resolvedPath = resolveNativeToolPath(context.cwd, rawPath);
  await access(resolvedPath, constants.R_OK | constants.W_OK);
  const before = await readFile(resolvedPath, "utf8");
  const after = applyExactReplacements(before, edits, rawPath).content;
  return buildOperation(id, "replace", rawPath, resolvedPath, before, after);
}

function buildOperation(id: string, kind: MutationKind, rawPath: string, resolvedPath: string, before: string | undefined, after: string): FileMutationOperation {
  return {
    id,
    kind,
    path: rawPath,
    resolvedPath,
    before,
    after,
    diff: buildUnifiedDiff(rawPath, before, after),
    beforeHash: before === undefined ? undefined : hashText(before),
    afterHash: hashText(after)
  };
}

export function blockedOperationsForDecision(proposal: FileMutationProposal, decision: MutationReviewDecision): FileMutationOperation[] {
  if (!shouldBlockMutation(decision)) {
    return [];
  }

  const requestedIds = normalizeBlockedMutationIds(decision.blockedMutationIds);
  const operationsById = new Map(proposal.operations.map((operation) => [operation.id, operation]));
  if (requestedIds.length > 0) {
    return requestedIds.flatMap((id) => {
      const operation = operationsById.get(id);
      return operation === undefined ? [] : [operation];
    });
  }

  if (proposal.operations.length === 1) {
    return proposal.operations;
  }

  return proposal.operations;
}

function proposalForOperations(proposal: FileMutationProposal, operations: FileMutationOperation[]): FileMutationProposal {
  const operationIds = new Set(operations.map((operation) => operation.id));
  const proposalWithoutFingerprint = {
    toolName: proposal.toolName,
    toolCallId: proposal.toolCallId,
    cwd: proposal.cwd,
    operations,
    rawInput: rawInputForMutationIds(proposal, operationIds)
  };
  return {
    ...proposalWithoutFingerprint,
    fingerprint: fingerprintProposal(proposalWithoutFingerprint)
  };
}

function rawInputForMutationIds(proposal: FileMutationProposal, operationIds: Set<string>): unknown {
  if (proposal.toolName === "write_many" && isWriteManyInput(proposal.rawInput)) {
    const entryIds = nativeWriteMutationEntryIds(proposal.rawInput.writes);
    return {
      writes: proposal.rawInput.writes.filter((_write, index) => operationIds.has(entryIds[index]))
    };
  }

  if (proposal.toolName === "edit_many" && isEditManyInput(proposal.rawInput)) {
    const entryIds = nativeEditMutationEntryIds(proposal.rawInput.files);
    return {
      files: proposal.rawInput.files.filter((_file, index) => operationIds.has(entryIds[index]))
    };
  }

  return proposal.rawInput;
}

export function retainAllowedMutationEntries(event: ToolCallEvent, allowedIds: Set<string>): void {
  if (event.toolName === "write_many" && isWriteManyInput(event.input)) {
    const entryIds = nativeWriteMutationEntryIds(event.input.writes);
    event.input.writes = event.input.writes.filter((_write, index) => allowedIds.has(entryIds[index]));
    return;
  }

  if (event.toolName === "edit_many" && isEditManyInput(event.input)) {
    const entryIds = nativeEditMutationEntryIds(event.input.files);
    event.input.files = event.input.files.filter((_file, index) => allowedIds.has(entryIds[index]));
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function readOptionalText(resolvedPath: string): Promise<string | undefined> {
  try {
    await access(resolvedPath, constants.R_OK);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  return readFile(resolvedPath, "utf8");
}

export function rememberPendingReviewedMutation(
  context: ExtensionContext,
  proposal: FileMutationProposal,
  source: PendingReviewedMutationSource
): PendingReviewedMutation {
  const scopeId = mutationReviewScopeId(context);
  const scope = getPendingReviewedMutationScope(scopeId);
  const existing = findPendingReviewedMutationInScope(scope, proposal.fingerprint);
  if (existing) {
    return existing;
  }

  const pending: PendingReviewedMutation = {
    id: allocatePendingMutationId(scope, proposal.fingerprint),
    scopeId,
    createdAt: new Date().toISOString(),
    proposal,
    ...source
  };
  scope.set(pending.id, pending);
  return pending;
}

function getPendingReviewedMutation(context: ExtensionContext, id: string): PendingReviewedMutation | undefined {
  return pendingReviewedMutationsByScope.get(mutationReviewScopeId(context))?.get(id);
}

function findPendingReviewedMutation(context: ExtensionContext, fingerprint: string): PendingReviewedMutation | undefined {
  const scope = pendingReviewedMutationsByScope.get(mutationReviewScopeId(context));
  return scope ? findPendingReviewedMutationInScope(scope, fingerprint) : undefined;
}

function findPendingReviewedMutationInScope(scope: Map<string, PendingReviewedMutation>, fingerprint: string): PendingReviewedMutation | undefined {
  for (const pending of scope.values()) {
    if (pending.proposal.fingerprint === fingerprint) {
      return pending;
    }
  }
  return undefined;
}

function getPendingReviewedMutationScope(scopeId: string): Map<string, PendingReviewedMutation> {
  const existing = pendingReviewedMutationsByScope.get(scopeId);
  if (existing) {
    return existing;
  }

  const scope = new Map<string, PendingReviewedMutation>();
  pendingReviewedMutationsByScope.set(scopeId, scope);
  return scope;
}

function allocatePendingMutationId(scope: Map<string, PendingReviewedMutation>, fingerprint: string): string {
  const preferred = pendingMutationIdForFingerprint(fingerprint);
  if (!scope.has(preferred)) {
    return preferred;
  }

  for (let length = 12; length <= 32; length += 4) {
    const id = `mr_${fingerprint.slice(0, length)}`;
    if (!scope.has(id)) {
      return id;
    }
  }

  let suffix = 2;
  while (scope.has(`${preferred}_${suffix}`)) {
    suffix += 1;
  }
  return `${preferred}_${suffix}`;
}

function pendingMutationIdForFingerprint(fingerprint: string): string {
  return `mr_${fingerprint.slice(0, 8)}`;
}

function mutationReviewScopeId(context: ExtensionContext): string {
  const sessionFile = context.sessionManager.getSessionFile();
  if (sessionFile) {
    return `file:${sessionFile}`;
  }
  return `memory:${context.cwd}:${context.sessionManager.getSessionId()}`;
}

function clearMutationReviewStateForContext(context: ExtensionContext): void {
  const scopeId = mutationReviewScopeId(context);
  pendingReviewedMutationsByScope.delete(scopeId);
  partialMutationReviewResultsByScope.delete(scopeId);
}

function rememberPartialMutationReviewResult(context: ExtensionContext, toolCallId: string, result: PartialMutationReviewToolResult): void {
  const scopeId = mutationReviewScopeId(context);
  const scope = partialMutationReviewResultsByScope.get(scopeId) ?? new Map<string, PartialMutationReviewToolResult>();
  scope.set(toolCallId, result);
  partialMutationReviewResultsByScope.set(scopeId, scope);
}

function takePartialMutationReviewResult(context: ExtensionContext, toolCallId: string): PartialMutationReviewToolResult | undefined {
  const scopeId = mutationReviewScopeId(context);
  const scope = partialMutationReviewResultsByScope.get(scopeId);
  const result = scope?.get(toolCallId);
  scope?.delete(toolCallId);
  if (scope?.size === 0) {
    partialMutationReviewResultsByScope.delete(scopeId);
  }
  return result;
}

function annotatePartialMutationReviewResult(event: ToolResultEvent, context: ExtensionContext): { content?: ToolResultEvent["content"]; details?: unknown; isError?: boolean } | undefined {
  if (event.toolName !== "write_many" && event.toolName !== "edit_many") {
    return undefined;
  }

  const partial = takePartialMutationReviewResult(context, event.toolCallId);
  if (partial === undefined) {
    return undefined;
  }

  const note = buildPartialMutationReviewNote(partial);
  return {
    content: [...event.content, { type: "text", text: note }],
    details: addPartialMutationReviewDetails(event.details, partial)
  };
}

function addPartialMutationReviewDetails(details: unknown, partial: PartialMutationReviewToolResult): unknown {
  const mutationReview = {
    pendingId: partial.pendingId,
    blocked: partial.blockedOperations.map((operation) => ({
      id: operation.id,
      path: operation.path,
      kind: operation.kind
    })),
    summary: partial.review.decision.summary
  };

  if (isRecord(details)) {
    return { ...details, mutationReview };
  }
  return { mutationReview };
}

function buildPartialMutationReviewNote(partial: PartialMutationReviewToolResult): string {
  const blockedCount = partial.blockedOperations.length;
  const allowedCount = partial.allowedOperations.length;
  return [
    `Mutation review skipped ${blockedCount} blocked mutation${blockedCount === 1 ? "" : "s"}; ${allowedCount} allowed mutation${allowedCount === 1 ? "" : "s"} executed.`,
    "",
    "Skipped mutations:",
    ...partial.blockedOperations.map((operation) => `- ${operation.id} ${operation.path} (${operation.kind})`),
    "",
    `Reviewer summary: ${partial.review.decision.summary}`,
    "",
    buildApplyReviewedMutationInstruction(partial.pendingId),
    "",
    `Reviewed mutation id: ${partial.pendingId}`,
    `Reviewed mutation fingerprint: ${partial.fingerprint.slice(0, 16)}`
  ].join("\n");
}

function listPendingReviewedMutationIds(context: ExtensionContext): string[] {
  return Array.from(pendingReviewedMutationsByScope.get(mutationReviewScopeId(context))?.keys() ?? []);
}

function buildMissingPendingMutationMessage(context: ExtensionContext, id: string): string {
  const ids = listPendingReviewedMutationIds(context);
  if (ids.length === 0) {
    return `No pending reviewed mutation found for ${id}. There are no pending mutation-review ids in this session.`;
  }
  return `No pending reviewed mutation found for ${id}. Pending ids in this session: ${ids.join(", ")}.`;
}

function deletePendingReviewedMutation(pending: PendingReviewedMutation): void {
  const scope = pendingReviewedMutationsByScope.get(pending.scopeId);
  scope?.delete(pending.id);
  if (scope?.size === 0) {
    pendingReviewedMutationsByScope.delete(pending.scopeId);
  }
}

async function withReviewedMutationQueues<T>(operations: FileMutationOperation[], run: () => Promise<T>): Promise<T> {
  const paths = uniqueStrings(operations.map((operation) => operation.resolvedPath)).sort();
  return withQueuedPaths(paths, run);
}

async function withQueuedPaths<T>(paths: string[], run: () => Promise<T>): Promise<T> {
  const [first, ...rest] = paths;
  if (!first) {
    return run();
  }
  return withFileMutationQueue(first, () => withQueuedPaths(rest, run));
}

async function validateReviewedMutationBeforeHashes(pending: PendingReviewedMutation): Promise<void> {
  await Promise.all(pending.proposal.operations.map((operation) => validateReviewedMutationOperation(pending.id, operation)));
}

async function validateReviewedMutationOperation(pendingId: string, operation: FileMutationOperation): Promise<void> {
  const current = await readOptionalText(operation.resolvedPath);
  if (operation.beforeHash === undefined) {
    if (current !== undefined) {
      throw new Error(`Cannot apply ${pendingId}: ${operation.path} did not exist during review, but it exists now (${shortHash(hashText(current))}).`);
    }
    return;
  }

  if (current === undefined) {
    throw new Error(`Cannot apply ${pendingId}: ${operation.path} existed during review but is missing now.`);
  }

  const currentHash = hashText(current);
  if (currentHash !== operation.beforeHash) {
    throw new Error(`Cannot apply ${pendingId}: ${operation.path} changed since review (expected ${shortHash(operation.beforeHash)}, found ${shortHash(currentHash)}).`);
  }
}

async function writeReviewedMutationOperation(operation: FileMutationOperation): Promise<ApplyReviewedMutationFileDetails> {
  await mkdir(path.dirname(operation.resolvedPath), { recursive: true });
  await writeFile(operation.resolvedPath, operation.after, "utf8");
  return {
    id: operation.id,
    path: operation.path,
    resolvedPath: operation.resolvedPath,
    kind: operation.kind,
    bytes: Buffer.byteLength(operation.after, "utf8"),
    lines: countLines(operation.after),
    beforeHash: operation.beforeHash,
    afterHash: operation.afterHash
  };
}

export async function runMutationReviewSubagent(
  context: ExtensionContext,
  proposal: FileMutationProposal,
  settings: MutationReviewSettings
): Promise<MutationReviewRunResult> {
  const startedAt = Date.now();
  let toolCallCount = 0;
  const decisionToolState = createDecisionTool();
  const childToolNames = uniqueStrings([...settings.tools, DECISION_TOOL_NAME]);
  const { model, thinkingLevel } = selectMutationReviewModel(context.modelRegistry, settings.defaultModel, context.model, settings.thinkingLevel);

  return withChildAgentSession(context, {
    cwd: context.cwd,
    model,
    thinkingLevel,
    tools: childToolNames,
    customTools: [decisionToolState.tool],
    systemPrompts: [reviewerSystemPrompt],
    extensionsOverride: omitMutationReviewExtension,
    extensionFactories: [createMutationReviewToolBudgetExtension()],
    onError: (error) => context.ui.notify(`Mutation review child extension error: ${error.error}`, "warning"),
    onEvent: (event) => {
      if (event.type === "tool_execution_start") {
        toolCallCount += 1;
        context.ui.setStatus(STATUS_KEY, `mutation review running · ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"} · ${event.toolName}`);
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        context.ui.setStatus(STATUS_KEY, `mutation review deciding · ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}`);
      }
    }
  }, async (session) => {
    await session.prompt(buildMutationReviewTask(context, proposal, settings), { source: "extension" });
    let finalAssistant = getFinalAssistant(session.messages);
    throwIfStoppedWithError(finalAssistant);

    let decision = decisionToolState.decision() ?? (finalAssistant ? recoverMutationReviewDecisionFromAssistant(finalAssistant, proposal) : undefined);
    if (!decision) {
      context.ui.setStatus(STATUS_KEY, `mutation review deciding · ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"} · structured decision retry`);
      await session.prompt(buildMutationReviewDecisionRepairTask(), { source: "extension" });
      finalAssistant = getFinalAssistant(session.messages);
      throwIfStoppedWithError(finalAssistant);
      decision = decisionToolState.decision() ?? (finalAssistant ? recoverMutationReviewDecisionFromAssistant(finalAssistant, proposal) : undefined);
    }

    if (!decision) {
      const finalText = finalAssistant ? assistantText(finalAssistant).trim() : "";
      const textSuffix = finalText ? ` Final assistant text: ${truncateText(finalText, 1200)}` : "";
      const toolSuffix = finalAssistant ? assistantToolCallSummary(finalAssistant) : "";
      const stopSuffix = finalAssistant ? ` Final assistant stopReason: ${finalAssistant.stopReason}.` : "";
      throw new Error(`Reviewer finished without calling ${DECISION_TOOL_NAME}.${stopSuffix}${textSuffix}${toolSuffix}`);
    }

    return {
      decision,
      model: formatModelName(model),
      thinkingLevel,
      toolCallCount,
      durationMs: Date.now() - startedAt
    };
  });
}

export function createMutationReviewToolBudgetExtension(): (api: ExtensionAPI) => void {
  return (api: ExtensionAPI) => {
    const counts = new Map<string, number>();
    api.on("tool_call", (event) => {
      if (event.toolName !== "search_many" && event.toolName !== "read_many") {
        return undefined;
      }

      const used = counts.get(event.toolName) ?? 0;
      if (used >= 1) {
        return {
          block: true,
          reason: `Mutation-review tool budget already used for ${event.toolName}; call ${DECISION_TOOL_NAME} with the best available evidence.`
        };
      }

      counts.set(event.toolName, used + 1);
      return undefined;
    });
  };
}

function createDecisionTool(): { tool: ToolDefinition; decision: () => MutationReviewDecision | undefined } {
  let submitted: MutationReviewDecision | undefined;
  const tool = defineTool({
    name: DECISION_TOOL_NAME,
    label: "Submit Mutation Review",
    description: "Submit the final file-mutation reuse/consolidation review decision. Call exactly once after repository inspection.",
    parameters: SubmitMutationReviewParams,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<{ content: TextContent[]; details: MutationReviewDecision; terminate: true }> {
      submitted = normalizeDecision(params);
      return {
        content: [{ type: "text", text: `Mutation review decision: ${submitted.decision}. ${submitted.summary}` }],
        details: submitted,
        terminate: true
      };
    }
  });

  return {
    tool: tool as ToolDefinition,
    decision: () => submitted
  };
}

function normalizeDecision(params: SubmitMutationReviewInput): MutationReviewDecision {
  const evidence = params.evidence.map((item) => ({
    path: item.path.trim(),
    lineRange: optionalTrim(item.lineRange),
    symbol: optionalTrim(item.symbol),
    reason: item.reason.trim()
  })).filter((item) => item.path && item.reason);

  return {
    decision: params.decision,
    confidence: params.confidence,
    summary: params.summary.trim(),
    evidence,
    blockedMutationIds: normalizeBlockedMutationIds(params.blockedMutationIds),
    suggestedPath: optionalTrim(params.suggestedPath)
  };
}

export function buildMutationReviewSearchHints(proposal: FileMutationProposal): string {
  const pathTerms = extractProposalPathTerms(proposal);
  const identifiers = extractProposalIdentifiers(proposal).slice(0, 24);
  const constants = identifiers.filter((identifier) => /^[A-Z][A-Z0-9_]{2,}$/.test(identifier)).slice(0, 12);
  const domainTerms = extractProposalDomainTerms(proposal, identifiers, pathTerms).slice(0, 28);
  const semanticTerms = new Set([
    ...extractProposalFileStemTerms(proposal),
    ...domainTerms.filter((term) => !pathTerms.includes(term)),
    ...constants.map((item) => item.toLowerCase())
  ]);
  const semanticPatterns = buildSemanticSearchPatterns(proposal, semanticTerms);

  return [
    identifiers.length > 0 ? `- Proposed identifiers/constants: ${identifiers.join(", ")}` : undefined,
    pathTerms.length > 0 ? `- Path/module terms: ${pathTerms.join(", ")}` : undefined,
    domainTerms.length > 0 ? `- Domain/docstring/code terms: ${domainTerms.join(", ")}` : undefined,
    constants.length > 0 ? `- Imported constants: ${constants.join(", ")}` : undefined,
    semanticPatterns.length > 0 ? `- Semantic search/file patterns: ${semanticPatterns.join("; ")}` : undefined
  ].filter((line): line is string => line !== undefined).join("\n");
}

function extractProposalPathTerms(proposal: FileMutationProposal): string[] {
  return uniqueStrings(proposal.operations.flatMap((operation) => {
    return operation.path
      .replace(/\.[^.]+$/, "")
      .split(/[\\/_.-]+/)
      .map((term) => term.toLowerCase())
      .filter(isUsefulSearchTerm);
  })).slice(0, 16);
}

function extractProposalFileStemTerms(proposal: FileMutationProposal): string[] {
  return uniqueStrings(proposal.operations.flatMap((operation) => {
    const normalizedPath = operation.path.replace(/\\/g, "/");
    const extension = path.posix.extname(normalizedPath);
    const stem = path.posix.basename(normalizedPath, extension);
    return stem
      .split(/[_-]+/)
      .map((term) => term.toLowerCase())
      .filter((term) => isUsefulSearchTerm(term) && (term.length > 2 || /\d/.test(term)));
  }));
}

function extractProposalIdentifiers(proposal: FileMutationProposal): string[] {
  const text = proposal.operations.map((operation) => operation.after).join("\n");
  const identifiers = Array.from(text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g), (match) => match[0])
    .filter((identifier) => !COMMON_IDENTIFIER_STOP_WORDS.has(identifier));
  return uniqueStrings(identifiers);
}

function extractProposalDomainTerms(proposal: FileMutationProposal, identifiers: string[], pathTerms: string[]): string[] {
  const rawWords = proposal.operations
    .map((operation) => operation.after)
    .join("\n")
    .match(/\b[A-Za-z][A-Za-z0-9_/-]{2,}\b/g) ?? [];
  const splitTerms = identifiers.flatMap(splitIdentifierSearchTerms);
  return uniqueStrings([...pathTerms, ...splitTerms, ...rawWords.map(normalizeDomainSearchTerm)])
    .filter((term) => isUsefulSearchTerm(term) && !COMMON_DOMAIN_STOP_WORDS.has(term));
}

function buildSemanticSearchPatterns(proposal: FileMutationProposal, terms: Set<string>): string[] {
  const actionTerms = searchActionTerms(terms).slice(0, 4);
  const objectTerms = searchObjectTerms(terms).slice(0, 8);
  const filePatterns = buildGenericCanonicalFilePatterns(proposal, objectTerms).slice(0, 8);
  const contentPatterns = [
    ...actionObjectSearchPatterns(actionTerms, objectTerms),
    ...objectPairSearchPatterns(objectTerms)
  ].slice(0, 8);

  return uniqueStrings([...filePatterns, ...contentPatterns]);
}

function searchActionTerms(terms: Set<string>): string[] {
  return GENERIC_SEARCH_ACTION_TERMS.filter((term) => terms.has(term) || terms.has(`${term}s`) || terms.has(`${term}ing`));
}

function searchObjectTerms(terms: Set<string>): string[] {
  return Array.from(terms)
    .map(singularizeSearchTerm)
    .filter((term) => isUsefulSearchTerm(term) && !term.includes("_") && !GENERIC_SEARCH_TERM_STOP_WORDS.has(term))
    .filter((term) => !GENERIC_SEARCH_ACTION_TERM_SET.has(term));
}

function actionObjectSearchPatterns(actionTerms: string[], objectTerms: string[]): string[] {
  return actionTerms.slice(0, 3).flatMap((action) => {
    return objectTerms.slice(0, 6).map((object) => `${regexSafeTerm(action)}.*${regexSafeTerm(object)}|${regexSafeTerm(object)}.*${regexSafeTerm(action)}`);
  });
}

function objectPairSearchPatterns(objectTerms: string[]): string[] {
  const selected = objectTerms.slice(0, 6);
  const patterns: string[] = [];
  for (let leftIndex = 0; leftIndex < selected.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < selected.length; rightIndex += 1) {
      patterns.push(`${regexSafeTerm(selected[leftIndex])}.*${regexSafeTerm(selected[rightIndex])}|${regexSafeTerm(selected[rightIndex])}.*${regexSafeTerm(selected[leftIndex])}`);
    }
  }
  return patterns.slice(0, 8);
}

function buildGenericCanonicalFilePatterns(proposal: FileMutationProposal, objectTerms: string[]): string[] {
  const patterns: string[] = [];

  for (const operation of proposal.operations) {
    const normalizedPath = operation.path.replace(/\\/g, "/");
    const directory = path.posix.dirname(normalizedPath);
    const operationExtension = path.posix.extname(normalizedPath);
    if (directory === "." || operationExtension === "") {
      continue;
    }

    for (const term of objectTerms.slice(0, 6)) {
      patterns.push(`files: ${directory}/*${globSafeTerm(term)}*${operationExtension}`);
    }
    patterns.push(`files: ${directory}/*${operationExtension}`);
  }

  const extension = firstOperationExtension(proposal);
  for (const term of objectTerms.slice(0, 6)) {
    patterns.push(`files: **/*${globSafeTerm(term)}*${extension}`);
  }
  return patterns;
}

function firstOperationExtension(proposal: FileMutationProposal): string {
  for (const operation of proposal.operations) {
    const extension = path.posix.extname(operation.path.replace(/\\/g, "/"));
    if (extension !== "") {
      return extension;
    }
  }
  return "";
}

function singularizeSearchTerm(term: string): string {
  return term.endsWith("s") && term.length > 3 ? term.slice(0, -1) : term;
}

function regexSafeTerm(term: string): string {
  return term.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function globSafeTerm(term: string): string {
  return term.replace(/[^A-Za-z0-9_-]/g, "");
}

function splitIdentifierSearchTerms(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/_+/)
    .map((term) => term.toLowerCase())
    .filter(isUsefulSearchTerm);
}

function normalizeDomainSearchTerm(term: string): string {
  return term.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

function isUsefulSearchTerm(term: string): boolean {
  return term.length >= 2 && !/^\d+$/.test(term);
}

const COMMON_IDENTIFIER_STOP_WORDS = new Set([
  "ArrayLike",
  "False",
  "None",
  "True",
  "annotations",
  "astype",
  "const",
  "def",
  "dtype",
  "float",
  "float64",
  "from",
  "import",
  "int",
  "npt",
  "np",
  "return",
  "str"
]);

const COMMON_DOMAIN_STOP_WORDS = new Set([
  "and",
  "are",
  "array",
  "arrays",
  "dtype",
  "false",
  "from",
  "into",
  "npt",
  "numpy",
  "return",
  "returns",
  "the",
  "true",
  "with"
]);

const GENERIC_SEARCH_ACTION_TERMS = [
  "add",
  "apply",
  "build",
  "calculate",
  "check",
  "compute",
  "convert",
  "create",
  "format",
  "load",
  "map",
  "normalize",
  "pad",
  "parse",
  "process",
  "read",
  "save",
  "scale",
  "serialize",
  "transform",
  "update",
  "validate",
  "write"
];

const GENERIC_SEARCH_ACTION_TERM_SET = new Set<string>(GENERIC_SEARCH_ACTION_TERMS);

const GENERIC_SEARCH_TERM_STOP_WORDS = new Set([
  ...COMMON_DOMAIN_STOP_WORDS,
  "app",
  "class",
  "common",
  "constant",
  "constants",
  "core",
  "data",
  "def",
  "file",
  "files",
  "error",
  "function",
  "helper",
  "helpers",
  "import",
  "index",
  "lib",
  "main",
  "module",
  "modules",
  "new",
  "object",
  "objects",
  "old",
  "parameter",
  "parameters",
  "row",
  "rows",
  "self",
  "source",
  "src",
  "spec",
  "sum",
  "test",
  "tests",
  "to",
  "updated",
  "value",
  "values"
]);

export function recoverMutationReviewDecisionFromAssistant(message: AssistantMessage, proposal?: FileMutationProposal): MutationReviewDecision | undefined {
  return recoverMutationReviewDecisionFromToolCalls(message, proposal)
    ?? recoverMutationReviewDecisionFromText(assistantText(message), proposal);
}

function recoverMutationReviewDecisionFromToolCalls(message: AssistantMessage, proposal?: FileMutationProposal): MutationReviewDecision | undefined {
  for (const toolCall of assistantToolCalls(message).reverse()) {
    if (toolCall.name !== DECISION_TOOL_NAME) {
      continue;
    }

    const input = coerceSubmitMutationReviewInput(toolCall.arguments);
    if (!input) {
      continue;
    }

    const decision = normalizeDecision(input);
    if (decision.decision === "block" && !hasRecoveredEvidence(decision, proposal)) {
      continue;
    }
    return decision;
  }

  return undefined;
}

function coerceSubmitMutationReviewInput(value: unknown): SubmitMutationReviewInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const decision = coerceReviewDecision(value.decision);
  const confidence = coerceReviewConfidence(value.confidence);
  const summary = typeof value.summary === "string" ? value.summary : undefined;
  if (!decision || !confidence || !summary) {
    return undefined;
  }

  return {
    decision,
    confidence,
    summary,
    evidence: coerceReviewEvidence(value.evidence),
    blockedMutationIds: coerceBlockedMutationIds(value.blockedMutationIds ?? value.blockedIds ?? value.mutationIds),
    suggestedPath: typeof value.suggestedPath === "string" ? value.suggestedPath : undefined
  };
}

function coerceReviewDecision(value: unknown): SubmitMutationReviewInput["decision"] | undefined {
  if (value !== "allow" && value !== "block") {
    return undefined;
  }
  return value;
}

function coerceReviewConfidence(value: unknown): SubmitMutationReviewInput["confidence"] | undefined {
  if (value !== "low" && value !== "medium" && value !== "high") {
    return undefined;
  }
  return value;
}

function coerceBlockedMutationIds(value: unknown): SubmitMutationReviewInput["blockedMutationIds"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return normalizeBlockedMutationIds(value.filter((item): item is string => typeof item === "string"));
}

function normalizeBlockedMutationIds(ids: string[] | undefined): string[] {
  return uniqueStrings((ids ?? []).map((id) => id.trim().toLowerCase()).filter(Boolean));
}

function coerceReviewEvidence(value: unknown): SubmitMutationReviewInput["evidence"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.reason !== "string") {
      return [];
    }
    return [{
      path: item.path,
      lineRange: typeof item.lineRange === "string" ? item.lineRange : undefined,
      symbol: typeof item.symbol === "string" ? item.symbol : undefined,
      reason: item.reason
    }];
  });
}

export function recoverMutationReviewDecisionFromText(text: string, proposal?: FileMutationProposal): MutationReviewDecision | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const decision = parseRecoveredDecision(trimmed);
  if (!decision) {
    return undefined;
  }

  const summary = summarizeRecoveredDecisionText(trimmed, decision);
  const confidence = inferRecoveredConfidence(trimmed, decision);
  if (decision === "allow") {
    return {
      decision,
      confidence,
      summary,
      evidence: [],
      blockedMutationIds: []
    };
  }

  const evidence = extractRecoveredEvidence(trimmed, proposal, summary);
  if (evidence.length === 0) {
    return undefined;
  }

  return {
    decision,
    confidence,
    summary,
    evidence,
    blockedMutationIds: recoverBlockedMutationIds(trimmed, proposal),
    suggestedPath: summary
  };
}

function parseRecoveredDecision(text: string): MutationReviewDecision["decision"] | undefined {
  const match = text.match(/(?:^|\n)\s*(?:decision|verdict)\s*[:=-]\s*[*_`]*\s*(allow|block)\b\s*[*_`]*/i);
  const value = match?.[1]?.toLowerCase();
  if (value !== "allow" && value !== "block") {
    return undefined;
  }
  return value;
}

function inferRecoveredConfidence(text: string, decision: MutationReviewDecision["decision"]): MutationReviewDecision["confidence"] {
  if (/\b(?:confidence\s*[:=-]\s*[*_`]*\s*high|high[- ]confidence|highly confident)\b/i.test(text)) {
    return "high";
  }
  if (/\bconfidence\s*[:=-]\s*[*_`]*\s*medium\b|\bmedium[- ]confidence\b/i.test(text)) {
    return "medium";
  }
  if (/\bconfidence\s*[:=-]\s*[*_`]*\s*low\b|\blow[- ]confidence\b/i.test(text)) {
    return "low";
  }
  return decision === "allow" ? "low" : "medium";
}

function summarizeRecoveredDecisionText(text: string, decision: MutationReviewDecision["decision"]): string {
  const withoutDecisionLine = text
    .replace(/(?:^|\n)\s*(?:decision|verdict)\s*[:=-].*(?:\n|$)/i, "\n")
    .trim();
  const firstParagraph = withoutDecisionLine.split(/\n\s*\n/).map((item) => item.trim()).find(Boolean);
  return truncateSingleLine(stripLightMarkdown(firstParagraph ?? text), 360) || `Recovered ${decision} decision from reviewer final text.`;
}

type RecoveredPathCandidate = {
  path: string;
  lineRange?: string;
};

function extractRecoveredEvidence(text: string, proposal: FileMutationProposal | undefined, summary: string): MutationReviewEvidence[] {
  const paths = uniqueRecoveredPaths([
    ...extractBacktickPathCandidates(text),
    ...extractRawPathCandidates(text)
  ]).filter((candidate) => !isProposedMutationPath(candidate.path, proposal));
  const symbols = extractRecoveredSymbols(text);
  const symbol = symbols.length > 0 ? symbols.slice(0, 4).join(", ") : undefined;

  return paths.slice(0, 4).map((candidate) => ({
    path: candidate.path,
    lineRange: candidate.lineRange,
    symbol,
    reason: summary
  }));
}

function recoverBlockedMutationIds(text: string, proposal: FileMutationProposal | undefined): string[] {
  const mentioned = uniqueStrings(Array.from(text.matchAll(/\bm(?:_[a-f0-9]{6,64}|\d+)\b/gi), (match) => (match[0] ?? "").toLowerCase()));
  const validIds = new Set(proposal?.operations.map((operation) => operation.id) ?? []);
  const recovered = mentioned.filter((id) => validIds.has(id));
  if (recovered.length > 0) {
    return recovered;
  }
  const onlyOperationId = proposal?.operations.length === 1 ? proposal.operations[0].id : undefined;
  return onlyOperationId ? [onlyOperationId] : [];
}

function extractBacktickPathCandidates(text: string): RecoveredPathCandidate[] {
  return Array.from(text.matchAll(/`([^`]+)`/g))
    .map((match) => parseRecoveredPathCandidate(match[1] ?? ""))
    .filter((candidate): candidate is RecoveredPathCandidate => candidate !== undefined);
}

function extractRawPathCandidates(text: string): RecoveredPathCandidate[] {
  return Array.from(text.matchAll(/\b(?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+(?::\d+(?:-\d+)?)?\b/g))
    .map((match) => parseRecoveredPathCandidate(match[0] ?? ""))
    .filter((candidate): candidate is RecoveredPathCandidate => candidate !== undefined);
}

function parseRecoveredPathCandidate(value: string): RecoveredPathCandidate | undefined {
  const cleaned = value.trim().replace(/^["'`(]+|["'`),.;]+$/g, "");
  const match = cleaned.match(/^(.+\.[A-Za-z0-9]+)(?::(\d+(?:-\d+)?))?$/);
  const recoveredPath = match?.[1];
  if (!recoveredPath || !recoveredPath.includes("/")) {
    return undefined;
  }
  return {
    path: recoveredPath,
    lineRange: optionalTrim(match?.[2])
  };
}

function uniqueRecoveredPaths(paths: RecoveredPathCandidate[]): RecoveredPathCandidate[] {
  const seen = new Set<string>();
  return paths.filter((candidate) => {
    const key = `${candidate.path}:${candidate.lineRange ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isProposedMutationPath(pathCandidate: string, proposal: FileMutationProposal | undefined): boolean {
  return proposal?.operations.some((operation) => {
    return pathCandidate === operation.path
      || pathCandidate === operation.resolvedPath
      || pathCandidate.endsWith(`/${operation.path}`);
  }) ?? false;
}

function hasRecoveredEvidence(decision: MutationReviewDecision, proposal: FileMutationProposal | undefined): boolean {
  return decision.evidence.some((item) => !isProposedMutationPath(item.path, proposal));
}

function extractRecoveredSymbols(text: string): string[] {
  const candidates = Array.from(text.matchAll(/`([^`]+)`/g))
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => value && !value.includes("/") && !/^.+\.[A-Za-z0-9]+$/.test(value))
    .filter((value) => /^[A-Za-z_][A-Za-z0-9_$.:-]*$/.test(value));
  return uniqueStrings(candidates);
}

function throwIfStoppedWithError(finalAssistant: AssistantMessage | undefined): void {
  if (finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted") {
    throw new Error(finalAssistant.errorMessage ?? `Reviewer stopped with ${finalAssistant.stopReason}`);
  }
}

function buildMutationReviewDecisionRepairTask(): string {
  return [
    `Your previous mutation-review response did not complete a ${DECISION_TOOL_NAME} tool call.`,
    `Call ${DECISION_TOOL_NAME} now with the best decision from the evidence already gathered.`,
    "Do not search, read, or write prose."
  ].join("\n");
}

function buildMutationReviewTask(context: ExtensionContext, proposal: FileMutationProposal, settings: MutationReviewSettings): string {
  const parentContext = buildParentContext(context, settings);
  return [
    "Review the proposed mutation below.",
    `Keep the ${DECISION_TOOL_NAME} summary and suggestedPath under ${settings.maxOutputTokens} tokens.`,
    "",
    "## Current working directory",
    proposal.cwd,
    "",
    "## Parent session recent context",
    parentContext,
    "",
    "## Proposed mutation",
    formatProposalSummary(proposal),
    "",
    "## Search expansion hints",
    buildMutationReviewSearchHints(proposal),
    "",
    "## Proposed diff",
    truncateText(proposal.operations.map(formatOperationDiff).join("\n\n"), settings.maxDiffChars),
    "",
    ...formatMutationReviewGuidance(settings.guidance),
    "## Review procedure",
    "Run at most one batched search_many call and optionally one batched read_many call for the strongest hits.",
    "The search_many call must include exact proposed names plus broader semantic aliases from path, imports, constants, docstrings, and domain terms; do not search only new identifiers.",
    "Search specific semantic API aliases and likely canonical modules before noisy raw constant occurrences; if a files search finds a likely canonical module or a search hit imports/calls a reusable helper, read the defining helper file before allowing or citing only callers.",
    "For block decisions, include concrete evidence paths and existing symbols when known; put only affected proposed mutation ids in blockedMutationIds, and use all ids only when every mutation should be blocked.",
    `Then make exactly one ${DECISION_TOOL_NAME} tool call. Do not reply with prose.`
  ].join("\n");
}

function formatMutationReviewGuidance(guidance: string | undefined): string[] {
  if (!guidance?.trim()) {
    return [];
  }
  return [
    "## Custom reviewer guidance",
    truncateText(guidance, 6000),
    ""
  ];
}

function buildParentContext(context: ExtensionContext, settings: MutationReviewSettings): string {
  const entries = context.sessionManager.getEntries();
  const leafId = context.sessionManager.getLeafId();
  const sessionContext = buildSessionContext(entries, leafId);
  const messages = convertToLlm(sessionContext.messages);
  return serializeRecentMessages(messages, settings.maxRecentMessages, settings.maxTranscriptChars);
}

function formatProposalSummary(proposal: FileMutationProposal): string {
  const files = proposal.operations.map((operation) => `- ${operation.id} ${operation.kind} ${operation.path} (${operation.afterHash.slice(0, 12)})`);
  return [`Tool: ${proposal.toolName}`, `Tool call: ${proposal.toolCallId}`, "Files:", ...files].join("\n");
}

function formatOperationDiff(operation: FileMutationOperation): string {
  return [`### ${operation.id} ${operation.path} (${operation.kind})`, operation.diff].join("\n");
}

export function buildReuseBlockReason(
  proposal: FileMutationProposal,
  review: MutationReviewRunResult,
  pendingId = pendingMutationIdForFingerprint(proposal.fingerprint)
): string {
  const decision = review.decision;
  return [
    "File mutation was not applied.",
    "",
    "A separate mutation-review agent found a high-confidence reuse/consolidation opportunity in the existing codebase.",
    "",
    `Reviewer model: ${review.model}`,
    `Reviewer tool calls: ${review.toolCallCount}`,
    `Confidence: ${decision.confidence}`,
    "",
    `Blocked mutations:\n${proposal.operations.map(formatBlockedOperation).join("\n")}`,
    "",
    "Summary:",
    decision.summary,
    "",
    decision.evidence.length > 0 ? `Evidence:\n${decision.evidence.map(formatEvidence).join("\n")}` : "Evidence: (none provided)",
    "",
    decision.suggestedPath ? `Suggested consolidation path:\n${decision.suggestedPath}` : undefined,
    "",
    buildApplyReviewedMutationInstruction(pendingId),
    "",
    `Reviewed mutation id: ${pendingId}`,
    `Reviewed mutation fingerprint: ${proposal.fingerprint.slice(0, 16)}`
  ].filter((line): line is string => line !== undefined).join("\n");
}

function buildReviewFailureReason(proposal: FileMutationProposal, error: unknown, pendingId: string): string {
  return [
    "File mutation was not applied because the mutation-review agent did not complete a structured decision.",
    "",
    `Failure: ${errorMessage(error)}`,
    "",
    buildApplyReviewedMutationInstruction(pendingId),
    "",
    `Reviewed mutation id: ${pendingId}`,
    `Reviewed mutation fingerprint: ${proposal.fingerprint.slice(0, 16)}`
  ].join("\n");
}

function buildAlreadyPendingBlockReason(pending: PendingReviewedMutation): string {
  return [
    "File mutation was not applied.",
    "",
    `This exact edit/write is already pending as ${pending.id}; it was not re-reviewed.`,
    "",
    pending.review ? `Original reviewer summary:\n${pending.review.decision.summary}` : undefined,
    pending.failure ? `Original review failure:\n${pending.failure}` : undefined,
    "",
    buildApplyReviewedMutationInstruction(pending.id),
    "",
    `Reviewed mutation id: ${pending.id}`,
    `Reviewed mutation fingerprint: ${pending.proposal.fingerprint.slice(0, 16)}`
  ].filter((line): line is string => line !== undefined).join("\n");
}

function buildApplyReviewedMutationInstruction(pendingId: string): string {
  return `To apply the original reviewed mutation without repeating the large edit/write arguments, call ${APPLY_REVIEWED_MUTATION_TOOL_NAME} with {"id":"${pendingId}"}. It validates the files still match their before-review hashes before writing. To change course, reuse the existing code or submit revised edit/write arguments; revised mutations are reviewed again.`;
}

function formatBlockedOperation(operation: FileMutationOperation): string {
  return `- ${operation.id} ${operation.path} (${operation.kind})`;
}

function formatEvidence(evidence: MutationReviewEvidence): string {
  const location = [evidence.path, evidence.lineRange].filter(Boolean).join(":");
  const symbol = evidence.symbol ? ` ${evidence.symbol}` : "";
  return `- ${location}${symbol}: ${evidence.reason}`;
}

export function readMutationReviewSettings(): MutationReviewSettings {
  const defaults: MutationReviewSettings = {
    defaultModel: undefined,
    guidance: undefined,
    thinkingLevel: "low",
    maxRecentMessages: 8,
    maxTranscriptChars: 8000,
    maxDiffChars: 24000,
    maxOutputTokens: 600,
    tools: ["search_many", "read_many"],
    reviewedTools: ["edit_many", "write_many", "edit", "write"]
  };

  const parsed = readPiToolsJsonConfigSource(MUTATION_REVIEW_CONFIG_FILE, import.meta.url);
  const configData = parsed?.data ?? {};
  const guidance = readMutationReviewGuidanceConfig(configData, parsed);
  return normalizeMutationReviewSettings({ ...defaults, ...configData, guidance } as MutationReviewSettings);
}

function readMutationReviewGuidanceConfig(configData: Record<string, unknown>, config: PiToolsJsonConfig | undefined): string | undefined {
  const inlineGuidance = typeof configData.guidance === "string" && configData.guidance.trim() ? configData.guidance : undefined;
  const guidanceFile = typeof configData.guidanceFile === "string" && configData.guidanceFile.trim() ? configData.guidanceFile.trim() : undefined;
  if (inlineGuidance !== undefined && guidanceFile !== undefined) {
    const source = config ? formatConfigPath(config.path) : MUTATION_REVIEW_CONFIG_FILE;
    throw new Error(`${source} must set either guidance or guidanceFile, not both.`);
  }
  if (guidanceFile === undefined) {
    return inlineGuidance;
  }
  if (!config) {
    throw new Error(`${MUTATION_REVIEW_CONFIG_FILE} guidanceFile requires a settings file.`);
  }
  return readPiToolsReferencedTextConfig(guidanceFile, config.path, config.source).text;
}

function normalizeMutationReviewSettings(settings: MutationReviewSettings): MutationReviewSettings {
  return {
    defaultModel: typeof settings.defaultModel === "string" && settings.defaultModel.trim() ? settings.defaultModel.trim() : undefined,
    guidance: typeof settings.guidance === "string" && settings.guidance.trim() ? settings.guidance.trim() : undefined,
    guidanceFile: typeof settings.guidanceFile === "string" && settings.guidanceFile.trim() ? settings.guidanceFile.trim() : undefined,
    thinkingLevel: normalizeThinkingLevel(settings.thinkingLevel, "low"),
    maxRecentMessages: positiveInteger(settings.maxRecentMessages, 8),
    maxTranscriptChars: positiveInteger(settings.maxTranscriptChars, 8000),
    maxDiffChars: positiveInteger(settings.maxDiffChars, 24000),
    maxOutputTokens: positiveInteger(settings.maxOutputTokens, 600),
    tools: nonEmptyStringList(settings.tools, ["search_many", "read_many"]),
    reviewedTools: nonEmptyStringList(settings.reviewedTools, ["edit_many", "write_many", "edit", "write"])
  };
}

export function setRuntimeMutationReviewEnabled(enabled: boolean): void {
  runtimeMutationReviewEnabled = enabled;
}

export function setRuntimeMutationReviewModelOverride(model: string | undefined): void {
  runtimeMutationReviewModelOverride = model;
}

function getEffectiveMutationReviewSettings(settings: MutationReviewSettings): MutationReviewSettings {
  return runtimeMutationReviewModelOverride ? { ...settings, defaultModel: runtimeMutationReviewModelOverride } : settings;
}

function isMutationReviewConfigured(settings: MutationReviewSettings): boolean {
  return typeof settings.defaultModel === "string" && settings.defaultModel.trim().length > 0;
}

function notifyMutationReviewUnconfiguredOnce(context: Pick<ExtensionContext, "hasUI" | "ui">): void {
  if (mutationReviewUnconfiguredWarningShown || context.hasUI === false || isMutationReviewConfigured(getEffectiveMutationReviewSettings(readMutationReviewSettings()))) {
    return;
  }
  mutationReviewUnconfiguredWarningShown = true;
  context.ui.notify("Mutation-review is disabled until a reviewer model is configured. Run /mutation:setup provider/model[:thinking].", "warning");
}

function handleMutationReviewSetupCommand(rawArgs: string, context: ExtensionContext): void {
  let args: ReturnType<typeof parseGuidedModelSetupArgs>;
  try {
    args = parseGuidedModelSetupArgs(rawArgs, "/mutation:setup");
  } catch (error) {
    context.ui.notify(`${errorMessage(error)}\n${mutationReviewSetupUsage()}`, "error");
    return;
  }

  if (args.help || !args.modelSpec) {
    context.ui.notify(`${mutationReviewSetupUsage()}\n\n${buildMutationReviewStatusText(context)}`, "info");
    return;
  }

  const settings = readMutationReviewSettings();
  try {
    const guidance = readSetupGuidance(args, context.cwd);
    const clearGuidance = args.clearGuidance === true;
    const { model, thinkingLevel } = selectMutationReviewModel(context.modelRegistry, args.modelSpec, context.model, settings.thinkingLevel);
    const configPath = writeAgentExtensionConfig(MUTATION_REVIEW_CONFIG_FILE, serializeMutationReviewSettings(settings, formatModelName(model), thinkingLevel, guidance, clearGuidance));
    setRuntimeMutationReviewModelOverride(undefined);
    context.ui.notify([
      `Mutation-review setup saved ${formatModelName(model)} with ${thinkingLevel} thinking.`,
      `Config: ${configPath}`,
      ...(clearGuidance ? ["Reviewer guidance: cleared"] : guidance === undefined ? [] : ["Reviewer guidance: saved"])
    ].join("\n"), "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.ui.notify(`Mutation-review setup did not write config: ${message}`, "error");
  }
}

function mutationReviewSetupUsage(): string {
  return guidedModelSetupUsage("/mutation:setup");
}

function handleMutationReviewModelCommand(rawArgs: string, context: ExtensionContext): void {
  const args = rawArgs.trim();
  if (!args) {
    context.ui.notify(`${mutationReviewModelUsage()}\n\n${buildMutationReviewStatusText(context)}`, "info");
    return;
  }

  if (args === "reset" || args === "default" || args === "clear") {
    setRuntimeMutationReviewModelOverride(undefined);
    context.ui.notify(`Mutation-review reviewer model reset to config value.\n\n${buildMutationReviewStatusText(context)}`, "info");
    return;
  }

  const settings = readMutationReviewSettings();
  try {
    const { model, thinkingLevel } = selectMutationReviewModel(context.modelRegistry, args, context.model, settings.thinkingLevel);
    setRuntimeMutationReviewModelOverride(args);
    context.ui.notify(`Mutation-review reviewer model set to ${formatModelName(model)} with ${thinkingLevel} thinking for this extension runtime.`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.ui.notify(`Mutation-review reviewer model was not changed: ${message}`, "error");
  }
}

function mutationReviewModelUsage(): string {
  return "Usage: /mutation:model provider/model[:thinking] | reset";
}

function handleMutationReviewToggleCommand(rawArgs: string, context: ExtensionContext): void {
  const args = rawArgs.trim().toLowerCase();
  const enabled = parseMutationReviewToggleArg(args);
  if (enabled === undefined) {
    context.ui.notify(mutationReviewToggleUsage(), "error");
    return;
  }

  setRuntimeMutationReviewEnabled(enabled);
  const state = enabled ? "enabled" : "disabled";
  context.ui.notify(`Mutation-review enforcement ${state} for this extension runtime.\n\n${buildMutationReviewStatusText(context)}`, enabled ? "info" : "warning");
}

function parseMutationReviewToggleArg(args: string): boolean | undefined {
  if (!args) {
    return !runtimeMutationReviewEnabled;
  }
  if (args === "on" || args === "enable" || args === "enabled" || args === "true") {
    return true;
  }
  if (args === "off" || args === "disable" || args === "disabled" || args === "false") {
    return false;
  }
  return undefined;
}

function mutationReviewToggleUsage(): string {
  return "Usage: /mutation:toggle [on|off]";
}

export function buildMutationReviewStatusText(context: Pick<ExtensionContext, "model" | "modelRegistry">): string {
  const settings = readMutationReviewSettings();
  const effective = getEffectiveMutationReviewSettings(settings);
  let selected: string;
  try {
    const { model, thinkingLevel } = selectMutationReviewModel(context.modelRegistry, effective.defaultModel, context.model, effective.thinkingLevel);
    selected = `${formatModelName(model)} · thinking ${thinkingLevel}`;
  } catch (error) {
    selected = `unavailable · ${error instanceof Error ? error.message : String(error)}`;
  }

  return [
    "Mutation-review reviewer",
    `Enforcement: ${runtimeMutationReviewEnabled ? (isMutationReviewConfigured(effective) ? "enabled" : "disabled until setup") : "disabled"}`,
    `Configuration: ${isMutationReviewConfigured(effective) ? "configured" : "missing; run /mutation:setup provider/model[:thinking]"}`,
    `Effective source: ${runtimeMutationReviewModelOverride ? "runtime override" : "config/current model"}`,
    `Effective model: ${selected}`,
    `Runtime override: ${runtimeMutationReviewModelOverride ?? "none"}`,
    `Config model: ${settings.defaultModel ?? "current model"}`,
    `Reviewer guidance: ${effective.guidance ? "configured" : "none"}`,
    `Reviewed tools: ${effective.reviewedTools.join(", ")}`,
    `Reviewer tools: ${effective.tools.join(", ")}`
  ].join("\n");
}

function serializeMutationReviewSettings(
  settings: MutationReviewSettings,
  defaultModel: string,
  thinkingLevel: ThinkingLevel,
  guidance: string | undefined,
  clearGuidance = false
): Record<string, unknown> {
  const effectiveGuidance = clearGuidance ? undefined : normalizeMutationReviewGuidanceForConfig(guidance ?? settings.guidance);
  return {
    defaultModel,
    ...(effectiveGuidance ? { guidance: effectiveGuidance } : {}),
    thinkingLevel,
    maxRecentMessages: settings.maxRecentMessages,
    maxTranscriptChars: settings.maxTranscriptChars,
    maxDiffChars: settings.maxDiffChars,
    maxOutputTokens: settings.maxOutputTokens,
    tools: settings.tools,
    reviewedTools: settings.reviewedTools
  };
}

function normalizeMutationReviewGuidanceForConfig(guidance: string | undefined): string | undefined {
  const trimmed = guidance?.trim();
  return trimmed ? `${trimmed}\n` : undefined;
}

export function selectMutationReviewModel(
  registry: ExtensionModelRegistry,
  requested: string | undefined,
  currentModel: Model<Api> | undefined,
  fallbackThinkingLevel: ThinkingLevel = "off"
): ResolvedExtensionModel {
  return resolveExtensionModel({
    registry,
    requested,
    currentModel,
    fallbackThinkingLevel,
    label: "Mutation review",
    noModelMessage: "No mutation review model configured. Run /mutation:setup provider/model[:thinking]."
  });
}

function omitMutationReviewExtension(result: LoadExtensionsResult): LoadExtensionsResult {
  return {
    ...result,
    extensions: result.extensions.filter((extension) => !MUTATION_REVIEW_EXTENSION_PATH_PATTERN.test(extension.resolvedPath))
  };
}

export function fingerprintProposal(proposal: Omit<FileMutationProposal, "fingerprint">): string {
  return hashText(stableStringify({
    version: 1,
    toolName: proposal.toolName,
    cwd: proposal.cwd,
    rawInput: proposal.rawInput,
    operations: proposal.operations.map((operation) => ({
      kind: operation.kind,
      path: operation.path,
      resolvedPath: operation.resolvedPath,
      beforeHash: operation.beforeHash,
      afterHash: operation.afterHash
    }))
  }));
}

function shouldBlockMutation(decision: MutationReviewDecision): boolean {
  return decision.decision === "block" && decision.confidence === "high" && decision.evidence.length > 0;
}

function buildUnifiedDiff(displayPath: string, before: string | undefined, after: string): string {
  const beforeLines = before === undefined ? [] : splitLines(before);
  const afterLines = splitLines(after);
  if (before !== undefined && before === after) {
    return `--- a/${displayPath}\n+++ b/${displayPath}\n(no changes)`;
  }

  const prefix = commonPrefixLength(beforeLines, afterLines);
  const suffix = commonSuffixLength(beforeLines, afterLines, prefix);
  const contextLines = 3;
  const beforeStart = Math.max(0, prefix - contextLines);
  const afterStart = Math.max(0, prefix - contextLines);
  const beforeEnd = Math.min(beforeLines.length, beforeLines.length - suffix + contextLines);
  const afterEnd = Math.min(afterLines.length, afterLines.length - suffix + contextLines);
  const beforeSpan = beforeLines.slice(beforeStart, beforeEnd);
  const afterSpan = afterLines.slice(afterStart, afterEnd);
  const beforeChangedStart = prefix - beforeStart;
  const beforeChangedEnd = beforeSpan.length - Math.max(0, suffix - (beforeLines.length - beforeEnd));
  const afterChangedStart = prefix - afterStart;
  const afterChangedEnd = afterSpan.length - Math.max(0, suffix - (afterLines.length - afterEnd));

  const lines = [
    `--- ${before === undefined ? "/dev/null" : `a/${displayPath}`}`,
    `+++ b/${displayPath}`,
    `@@ -${beforeStart + 1},${beforeSpan.length} +${afterStart + 1},${afterSpan.length} @@`
  ];

  for (let index = 0; index < beforeChangedStart; index += 1) {
    lines.push(` ${beforeSpan[index]}`);
  }
  for (let index = beforeChangedStart; index < beforeChangedEnd; index += 1) {
    lines.push(`-${beforeSpan[index]}`);
  }
  for (let index = afterChangedStart; index < afterChangedEnd; index += 1) {
    lines.push(`+${afterSpan[index]}`);
  }
  for (let index = beforeChangedEnd; index < beforeSpan.length; index += 1) {
    lines.push(` ${beforeSpan[index]}`);
  }

  return lines.join("\n");
}

function splitLines(text: string): string[] {
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function commonPrefixLength(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }
  return length;
}

function commonSuffixLength(left: string[], right: string[], prefixLength: number): number {
  const maxLength = Math.min(left.length, right.length) - prefixLength;
  for (let offset = 0; offset < maxLength; offset += 1) {
    if (left[left.length - 1 - offset] !== right[right.length - 1 - offset]) {
      return offset;
    }
  }
  return maxLength;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function getFinalAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n\n");
}

function assistantToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter((item): item is ToolCall => item.type === "toolCall");
}

function assistantToolCallSummary(message: AssistantMessage): string {
  const toolCalls = assistantToolCalls(message);
  if (toolCalls.length === 0) {
    return "";
  }

  const summary = toolCalls
    .map((toolCall) => `${toolCall.name} ${truncateText(JSON.stringify(toolCall.arguments), 400)}`)
    .join("; ");
  return ` Final assistant tool calls: ${summary}`;
}

function isWriteManyInput(input: unknown): input is WriteManyInput {
  const record = asRecord(input);
  return Array.isArray(record?.writes) && record.writes.every((item) => {
    const write = asRecord(item);
    return typeof write?.path === "string" && typeof write.content === "string";
  });
}

function isEditManyInput(input: unknown): input is EditManyInput {
  const record = asRecord(input);
  return Array.isArray(record?.files) && record.files.every((item) => {
    const file = asRecord(item);
    return typeof file?.path === "string" && Array.isArray(file.edits) && file.edits.every(isReplacementRecord);
  });
}

function isWriteLikeInput(input: unknown): input is WriteLikeInput {
  const record = asRecord(input);
  return typeof record?.path === "string" && typeof record.content === "string";
}

function isEditLikeInput(input: unknown): input is EditLikeInput {
  const record = asRecord(input);
  return typeof record?.path === "string" && Array.isArray(record.edits) && record.edits.every(isReplacementRecord);
}

function isReplacementRecord(value: unknown): value is { oldText: string; newText: string } {
  const record = asRecord(value);
  return typeof record?.oldText === "string" && typeof record.newText === "string";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonEmptyStringList(value: string[], fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") && value.length > 0
    ? uniqueStrings(value.map((item) => item.trim()).filter(Boolean))
    : fallback;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function optionalTrim(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}


function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n...[truncated ${text.length - maxChars} chars]`;
}

function truncateSingleLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

function stripLightMarkdown(text: string): string {
  return text.replace(/[*`]+/g, "").trim();
}

function firstToken(text: string): string | undefined {
  return text.trim().split(/\s+/, 1)[0] || undefined;
}

function firstResultLine(result: AgentToolResult<unknown>): string {
  const text = result.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text.split(/\r?\n/, 1)[0] || "Applied reviewed mutation.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function countLines(text: string): number {
  return text.split("\n").length;
}
