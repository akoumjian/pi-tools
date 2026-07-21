import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ToolCallEvent, type ToolDefinition, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import mutationReviewExtension, {
  applyReviewedMutation,
  blockedOperationsForDecision,
  buildMutationReviewStatusText,
  buildMutationReviewSearchHints,
  buildReuseBlockReason,
  createMutationReviewToolBudgetExtension,
  extractFileMutationProposal,
  recoverMutationReviewDecisionFromAssistant,
  recoverMutationReviewDecisionFromText,
  readMutationReviewSettings,
  rememberPartialMutationReviewResult,
  rememberPendingReviewedMutation,
  retainAllowedMutationEntries,
  selectMutationReviewModel,
  setRuntimeMutationReviewEnabled,
  setRuntimeMutationReviewModelOverride,
  type FileMutationProposal,
  type MutationReviewRunResult
} from "../extensions/mutation-review/index.js";
import { nativeEditMutationEntryId, nativeWriteMutationEntryId } from "../extensions/native-tools/index.js";
import { RetainedToolOutputSchemas } from "../extensions/_shared/tool-output.js";

type FakeCommandOptions = {
  handler: (args: string, context: ExtensionContext) => Promise<void> | void;
};

type FakeApi = ExtensionAPI & {
  handlers: Map<string, Function[]>;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, FakeCommandOptions>;
};

function createContext(cwd: string): ExtensionContext {
  return { cwd, sessionManager: SessionManager.inMemory(cwd) } as unknown as ExtensionContext;
}

function createCommandContext(cwd = "/repo", models: Model<Api>[] = [fakeModel("openai-codex", "gpt-5.3-codex-spark")]) {
  const notifications: Array<{ message: string; type: string }> = [];
  return {
    notifications,
    context: {
      cwd,
      model: models[0],
      modelRegistry: fakeRegistry(models),
      sessionManager: SessionManager.inMemory(cwd),
      ui: {
        notify(message: string, type: string): void {
          notifications.push({ message, type });
        },
        setStatus(): void {}
      }
    } as unknown as ExtensionContext
  };
}

function createFakeApi(): FakeApi {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, FakeCommandOptions>();
  return {
    handlers,
    tools,
    commands,
    on(event: string, handler: Function): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: ToolDefinition): void {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, options: FakeCommandOptions): void {
      commands.set(name, options);
    }
  } as unknown as FakeApi;
}

async function withEnv(name: string, value: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mutation-review-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeModel(provider: string, id: string, reasoning = true): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: "https://example.invalid",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000
  } as Model<Api>;
}

function fakeRegistry(models: Model<Api>[], authed: Set<string> = new Set(models.map((model) => `${model.provider}/${model.id}`))) {
  return {
    hasConfiguredAuth(model: Model<Api>): boolean {
      return authed.has(`${model.provider}/${model.id}`);
    },
    getAll(): Model<Api>[] {
      return models;
    }
  };
}

function fakeReviewResult(): MutationReviewRunResult {
  return {
    model: "openai-codex/gpt-5.3-codex-spark",
    thinkingLevel: "low",
    toolCallCount: 2,
    durationMs: 1000,
    decision: {
      decision: "block",
      confidence: "high",
      summary: "Reuse existing code.",
      evidence: [{ path: "src/existing.ts", reason: "It already exists." }],
      blockedMutationIds: []
    }
  };
}

test("mutation review extension registers a tool_call hook and cached apply surface", () => {
  const api = createFakeApi();
  mutationReviewExtension(api);
  assert.equal(api.handlers.get("tool_call")?.length, 1);
  assert.equal(api.handlers.get("tool_result")?.length, 1);
  assert.ok(api.tools.has("apply_reviewed_mutation"));
  const applyTool = api.tools.get("apply_reviewed_mutation")!;
  assert.deepEqual(applyTool.promptGuidelines?.map((line) => line.split(":", 1)[0]), [
    "apply_reviewed_mutation use",
    "apply_reviewed_mutation input",
    "apply_reviewed_mutation output",
    "apply_reviewed_mutation constraints"
  ]);
  assert.match(applyTool.description, /Model-visible success output/);
  assert.match(JSON.stringify(applyTool.parameters), /not a mutation entry id/);
  assert.ok(api.commands.has("mutation:apply"));
  assert.ok(api.commands.has("mutation:setup"));
  assert.ok(api.commands.has("mutation:status"));
  assert.ok(api.commands.has("mutation:model"));
  assert.ok(api.commands.has("mutation:toggle"));
  assert.equal(api.commands.has("mutation-apply"), false, "deprecated kebab alias removed");
  assert.equal(api.commands.has("mutation-review-status"), false, "deprecated kebab alias removed");
  assert.equal(api.commands.has("mutation-review-model"), false, "deprecated kebab alias removed");
  assert.equal(api.commands.has("mutation-review-toggle"), false, "deprecated kebab alias removed");
});

test("tool_result middleware decorates partial-review execution errors with strict schema-compatible details", () => {
  const api = createFakeApi();
  mutationReviewExtension(api);
  const handler = api.handlers.get("tool_result")?.[0];
  assert.ok(handler);
  const context = createContext("/repo");
  const operation = {
    id: "m_0123456789ab",
    kind: "replace" as const,
    path: "src/blocked.ts",
    resolvedPath: "/repo/src/blocked.ts",
    after: "replacement\n",
    diff: "+replacement",
    afterHash: "a".repeat(64)
  };
  rememberPartialMutationReviewResult(context, "call-partial-error", {
    pendingId: "mr_01234567",
    fingerprint: "a".repeat(64),
    review: fakeReviewResult(),
    blockedOperations: [operation],
    allowedOperations: [{ ...operation, id: "m_abcdef012345", path: "src/allowed.ts", resolvedPath: "/repo/src/allowed.ts" }]
  });

  const result = handler({
    type: "tool_result",
    toolName: "write_many",
    toolCallId: "call-partial-error",
    input: {},
    content: [{ type: "text", text: "Tool failed" }],
    details: {},
    isError: true
  } as ToolResultEvent, context) as { content: Array<{ type: string; text: string }>; details: { mutationReview: { pendingId: string; blocked: Array<{ id: string }> } }; isError?: boolean };

  assert.equal(result.content.length, 2);
  assert.match(result.content[1]?.text ?? "", /Mutation review skipped 1 blocked mutation/);
  assert.equal(result.details.mutationReview.pendingId, "mr_01234567");
  assert.deepEqual(result.details.mutationReview.blocked.map((entry) => entry.id), ["m_0123456789ab"]);
  assert.equal("isError" in result, false, "middleware edits result content/details without inventing a raw execute-result field");
  assert.equal(Check(RetainedToolOutputSchemas.write_many, result), true, "actual middleware result matches the authoritative output contract");
  assert.equal(Check(RetainedToolOutputSchemas.write_many, {
    ...result,
    details: { ...result.details, unexpected: true }
  }), false, "mutation-only details remain closed to unknown fields");
});

test("mutation-review status reports runtime model override and enforcement state", () => {
  setRuntimeMutationReviewModelOverride(undefined);
  setRuntimeMutationReviewEnabled(true);
  const spark = fakeModel("openai-codex", "gpt-5.3-codex-spark");
  const claude = fakeModel("anthropic", "claude-opus-4-7");
  const { context } = createCommandContext("/repo", [spark, claude]);

  const unconfiguredStatus = buildMutationReviewStatusText(context);
  assert.match(unconfiguredStatus, /Enforcement: disabled until setup/);
  assert.match(unconfiguredStatus, /Configuration: missing/);
  assert.match(unconfiguredStatus, /Effective source: config\/current model/);
  setRuntimeMutationReviewModelOverride("anthropic/claude-opus-4-7:high");
  try {
    const status = buildMutationReviewStatusText(context);
    assert.match(status, /Enforcement: enabled/);
    assert.match(status, /Effective source: runtime override/);
    assert.match(status, /anthropic\/claude-opus-4-7/);
    assert.match(status, /thinking high/);
  } finally {
    setRuntimeMutationReviewModelOverride(undefined);
    setRuntimeMutationReviewEnabled(true);
  }
});

test("mutation-review-model command sets and resets a validated runtime reviewer model", async () => {
  setRuntimeMutationReviewModelOverride(undefined);
  setRuntimeMutationReviewEnabled(true);
  const api = createFakeApi();
  mutationReviewExtension(api);
  const { context, notifications } = createCommandContext("/repo", [
    fakeModel("openai-codex", "gpt-5.3-codex-spark"),
    fakeModel("anthropic", "claude-opus-4-7")
  ]);
  const modelCommand = api.commands.get("mutation:model");
  const statusCommand = api.commands.get("mutation:status");
  assert.ok(modelCommand);
  assert.ok(statusCommand);

  try {
    await modelCommand.handler("anthropic/claude-opus-4-7:high", context);
    await statusCommand.handler("", context);
    await modelCommand.handler("reset", context);
    await statusCommand.handler("", context);

    assert.match(notifications[0].message, /set to anthropic\/claude-opus-4-7/);
    assert.match(notifications[1].message, /Effective source: runtime override/);
    assert.match(notifications[2].message, /reset to config/);
    assert.match(notifications[3].message, /Effective source: config\/current model/);
  } finally {
    setRuntimeMutationReviewModelOverride(undefined);
    setRuntimeMutationReviewEnabled(true);
  }
});

test("mutation-review setup writes reviewer model config and reviewer guidance", async () => {
  setRuntimeMutationReviewModelOverride(undefined);
  setRuntimeMutationReviewEnabled(true);
  await withTempDir(async (dir) => {
    const agentDir = path.join(dir, "agent");
    const api = createFakeApi();
    mutationReviewExtension(api);
    const { context, notifications } = createCommandContext(dir, [
      fakeModel("openai-codex", "gpt-5.3-codex-spark"),
      fakeModel("anthropic", "claude-opus-4-7")
    ]);
    const setupCommand = api.commands.get("mutation:setup");
    const statusCommand = api.commands.get("mutation:status");
    assert.ok(setupCommand);
    assert.ok(statusCommand);

    await withEnv("PI_CODING_AGENT_DIR", agentDir, async () => {
      await withEnv("PI_TOOLS_CONFIG_DIR", undefined, async () => {
        await setupCommand.handler("anthropic/claude-opus-4-7:high --guidance Block only for concrete duplicate reusable code.", context);
        let config = JSON.parse(await readFile(path.join(agentDir, "extensions", "akoumjian-tools", "mutation-review-settings.json"), "utf8")) as Record<string, unknown>;
        assert.equal(config.guidance, "Block only for concrete duplicate reusable code.\n");

        await setupCommand.handler("anthropic/claude-opus-4-7:medium", context);
        config = JSON.parse(await readFile(path.join(agentDir, "extensions", "akoumjian-tools", "mutation-review-settings.json"), "utf8")) as Record<string, unknown>;
        assert.equal(config.guidance, "Block only for concrete duplicate reusable code.\n");

        await setupCommand.handler("anthropic/claude-opus-4-7:high --clear-guidance", context);
        await statusCommand.handler("", context);
      });
    });

    const configPath = path.join(agentDir, "extensions", "akoumjian-tools", "mutation-review-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(config.defaultModel, "anthropic/claude-opus-4-7");
    assert.equal(config.thinkingLevel, "high");
    assert.equal(config.guidance, undefined);
    assert.match(notifications[0].message, /Reviewer guidance: saved/);
    assert.doesNotMatch(notifications[1].message, /Reviewer guidance: saved/);
    assert.match(notifications[2].message, /Reviewer guidance: cleared/);
    assert.match(notifications[3].message, /Reviewer guidance: none/);
  });
});

test("mutation-review settings load reviewer guidance from markdown files", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "config");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "mutation-review-settings.json"), JSON.stringify({ guidanceFile: "guidance.md", thinkingLevel: "low" }), "utf8");
    await writeFile(path.join(configDir, "guidance.md"), "# Mutation Guidance\n\nPrefer concrete reuse evidence.\n", "utf8");

    await withEnv("PI_TOOLS_CONFIG_DIR", configDir, async () => {
      const settings = readMutationReviewSettings();
      assert.match(settings.guidance ?? "", /Prefer concrete reuse evidence/);
    });
  });
});

test("mutation-review-model command rejects unavailable models without changing the override", async () => {
  setRuntimeMutationReviewModelOverride(undefined);
  setRuntimeMutationReviewEnabled(true);
  const api = createFakeApi();
  mutationReviewExtension(api);
  const { context, notifications } = createCommandContext("/repo", [fakeModel("openai-codex", "gpt-5.3-codex-spark")]);
  const modelCommand = api.commands.get("mutation:model");
  assert.ok(modelCommand);

  await modelCommand.handler("anthropic/claude-opus-4-7:high", context);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /not changed/);
  assert.match(buildMutationReviewStatusText(context), /Effective source: config\/current model/);
});

test("mutation-review-toggle command changes runtime enforcement state", async () => {
  setRuntimeMutationReviewModelOverride(undefined);
  setRuntimeMutationReviewEnabled(true);
  const api = createFakeApi();
  mutationReviewExtension(api);
  const { context, notifications } = createCommandContext();
  const toggleCommand = api.commands.get("mutation:toggle");
  const statusCommand = api.commands.get("mutation:status");
  assert.ok(toggleCommand);
  assert.ok(statusCommand);

  try {
    await toggleCommand.handler("off", context);
    await statusCommand.handler("", context);
    await toggleCommand.handler("", context);
    await statusCommand.handler("", context);
    await toggleCommand.handler("maybe", context);

    assert.equal(notifications[0].type, "warning");
    assert.match(notifications[0].message, /disabled/);
    assert.match(notifications[1].message, /Enforcement: disabled/);
    assert.match(notifications[2].message, /enabled/);
    assert.match(notifications[3].message, /Enforcement: disabled until setup/);
    assert.equal(notifications[4].type, "error");
    assert.match(notifications[4].message, /Usage: \/mutation:toggle/);
  } finally {
    setRuntimeMutationReviewEnabled(true);
  }
});

test("disabled mutation-review enforcement bypasses reviewed tool calls", async () => {
  setRuntimeMutationReviewEnabled(false);
  const api = createFakeApi();
  mutationReviewExtension(api);
  const handler = api.handlers.get("tool_call")?.[0];
  assert.ok(handler);

  try {
    const result = await handler({
      type: "tool_call",
      toolName: "write_many",
      toolCallId: "disabled-call",
      input: { writes: [{ path: "new.ts", content: "export const value = 1;\n" }] }
    } as ToolCallEvent, createCommandContext().context);
    assert.equal(result, undefined);
  } finally {
    setRuntimeMutationReviewEnabled(true);
  }
});

test("mutation review child tool budget allows one search and one read call", () => {
  const api = createFakeApi();
  createMutationReviewToolBudgetExtension()(api);
  const [handler] = api.handlers.get("tool_call") ?? [];
  assert.ok(handler);

  const call = (toolName: string) => handler({ toolName } as ToolCallEvent);
  assert.equal(call("search_many"), undefined);
  assert.equal(call("read_many"), undefined);
  assert.equal(call("submit_mutation_review"), undefined);

  assert.deepEqual(call("search_many"), {
    block: true,
    reason: "Mutation-review tool budget already used for search_many; call submit_mutation_review with the best available evidence."
  });
  assert.deepEqual(call("read_many"), {
    block: true,
    reason: "Mutation-review tool budget already used for read_many; call submit_mutation_review with the best available evidence."
  });
});

test("extractFileMutationProposal plans write_many creates and overwrites without touching files", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "existing.ts"), "export const value = 1;\n", "utf8");
    const event = {
      type: "tool_call",
      toolName: "write_many",
      toolCallId: "call-1",
      input: {
        writes: [
          { path: "new.ts", content: "export const created = true;\n" },
          { path: "existing.ts", content: "export const value = 2;\n" }
        ]
      }
    } as ToolCallEvent;

    const proposal = await extractFileMutationProposal(createContext(dir), event);
    assert.ok(proposal);
    assert.equal(proposal.operations.length, 2);
    const newId = nativeWriteMutationEntryId({ path: "new.ts", content: "export const created = true;\n" });
    const existingId = nativeWriteMutationEntryId({ path: "existing.ts", content: "export const value = 2;\n" });
    assert.match(newId, /^m_[a-f0-9]{12}$/);
    assert.deepEqual(proposal.operations.map((operation) => operation.id), [newId, existingId]);
    assert.equal(proposal.operations[0].kind, "create");
    assert.equal(proposal.operations[1].kind, "overwrite");
    assert.match(proposal.operations[0].diff, /--- \/dev\/null/);
    assert.match(proposal.operations[0].diff, /\+export const created = true;/);
    assert.match(proposal.operations[1].diff, /-export const value = 1;/);
    assert.match(proposal.operations[1].diff, /\+export const value = 2;/);
    assert.equal(proposal.fingerprint.length, 64);
  });
});

test("extractFileMutationProposal returns undefined for no-op write_many", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "same.ts"), "same\n", "utf8");
    const proposal = await extractFileMutationProposal(createContext(dir), {
      type: "tool_call",
      toolName: "write_many",
      toolCallId: "call-1",
      input: { writes: [{ path: "same.ts", content: "same\n" }] }
    } as ToolCallEvent);

    assert.equal(proposal, undefined);
  });
});

test("extractFileMutationProposal uses native edit semantics for edit_many", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "edit.ts"), "const value = 1;\n", "utf8");
    const proposal = await extractFileMutationProposal(createContext(dir), {
      type: "tool_call",
      toolName: "edit_many",
      toolCallId: "call-2",
      input: {
        files: [{ path: "edit.ts", edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }] }]
      }
    } as ToolCallEvent);

    assert.ok(proposal);
    assert.equal(proposal.operations[0].id, nativeEditMutationEntryId({ path: "edit.ts", edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }] }));
    assert.equal(proposal.operations[0].kind, "replace");
    assert.equal(proposal.operations[0].after, "const value = 2;\n");
    assert.match(proposal.operations[0].diff, /-const value = 1;/);
    assert.match(proposal.operations[0].diff, /\+const value = 2;/);
  });
});

test("blockedOperationsForDecision targets only requested batch mutation ids", async () => {
  await withTempDir(async (dir) => {
    const proposal = await extractFileMutationProposal(createContext(dir), {
      type: "tool_call",
      toolName: "write_many",
      toolCallId: "call-partial",
      input: {
        writes: [
          { path: "allowed.ts", content: "export const allowed = true;\n" },
          { path: "blocked.ts", content: "export const duplicate = true;\n" }
        ]
      }
    } as ToolCallEvent);
    assert.ok(proposal);

    const blockedId = nativeWriteMutationEntryId({ path: "blocked.ts", content: "export const duplicate = true;\n" });
    const blocked = blockedOperationsForDecision(proposal, {
      decision: "block",
      confidence: "high",
      summary: "Only blocked.ts duplicates an existing helper.",
      evidence: [{ path: "src/existing.ts", reason: "Same behavior exists." }],
      blockedMutationIds: [blockedId]
    });

    assert.deepEqual(blocked.map((operation) => operation.id), [blockedId]);
    assert.deepEqual(blocked.map((operation) => operation.path), ["blocked.ts"]);
  });
});

test("retainAllowedMutationEntries removes blocked entries from batch tool input", () => {
  const event = {
    type: "tool_call",
    toolName: "write_many",
    toolCallId: "call-filter",
    input: {
      writes: [
        { path: "allowed.ts", content: "allowed\n" },
        { path: "blocked.ts", content: "blocked\n" }
      ]
    }
  } as ToolCallEvent;

  const allowedId = nativeWriteMutationEntryId({ path: "allowed.ts", content: "allowed\n" });
  const blockedId = nativeWriteMutationEntryId({ path: "blocked.ts", content: "blocked\n" });
  assert.notEqual(allowedId, blockedId);

  retainAllowedMutationEntries(event, new Set([allowedId]));

  const retainedWrites = (event.input as { writes: Array<{ path: string; content: string }> }).writes;
  assert.deepEqual(retainedWrites.map((write) => write.path), ["allowed.ts"]);
  assert.equal(nativeWriteMutationEntryId(retainedWrites[0]), allowedId);
});

test("buildMutationReviewSearchHints expands unit conversion proposals beyond exact names", () => {
  const hints = buildMutationReviewSearchHints({
    toolName: "write_many",
    toolCallId: "call-hints",
    cwd: "/repo",
    rawInput: {},
    fingerprint: "abc",
    operations: [{
      id: "m1",
      kind: "create",
      path: "src/geometry/state_units.py",
      resolvedPath: "/repo/src/geometry/state_units.py",
      after: `from sample_project.constants import KM_P_UNIT, S_P_DAY


def map_state_to_metric_units(state_rows):
    """Convert rows from AU/AU-day to km/km-s with a scale matrix."""
    return state_rows


def map_state_covariance_to_metric_units(covariance_rows):
    """Convert covariance tensors from AU/AU-day units to km/km-s units."""
    return covariance_rows
`,
      diff: "",
      afterHash: "hash"
    }]
  });

  assert.match(hints, /map_state_to_metric_units/);
  assert.match(hints, /convert\.\*state\|state\.\*convert/);
  assert.match(hints, /convert\.\*unit\|unit\.\*convert/);
  assert.match(hints, /covariance/);
  assert.match(hints, /src\/geometry\/\*unit\*\.py/);
  assert.doesNotMatch(hints, /convert_cartesian_values_au_to_km|coordinates\.units/);
});

test("buildMutationReviewSearchHints expands reduced chi2 proposals to residual helpers", () => {
  const hints = buildMutationReviewSearchHints({
    toolName: "edit_many",
    toolCallId: "call-chi2",
    cwd: "/repo",
    rawInput: {},
    fingerprint: "abc",
    operations: [{
      id: "m1",
      kind: "replace",
      path: "src/orbits/solver.py",
      resolvedPath: "/repo/src/orbits/solver.py",
      before: "",
      after: `def _reduced_chi2_from_residuals(residuals, parameters):
    return residuals.chi2.to_numpy().sum() / (residuals.dof.to_numpy().sum() - parameters)
`,
      diff: "",
      beforeHash: "before",
      afterHash: "after"
    }]
  });

  assert.match(hints, /reduced\.\*chi2\|chi2\.\*reduced/);
  assert.match(hints, /residual\.\*dof|dof\.\*residual|reduced\.\*residual/);
  assert.match(hints, /files: src\/orbits\/\*residual\*\.py/);
  assert.doesNotMatch(hints, /calculate_reduced_chi2|src\/geometry\/\*residual/);
});

test("buildMutationReviewSearchHints expands validation proposals to generic sibling-module searches", () => {
  const hints = buildMutationReviewSearchHints({
    toolName: "edit_many",
    toolCallId: "call-photometry",
    cwd: "/repo",
    rawInput: {},
    fingerprint: "abc",
    operations: [{
      id: "m1",
      kind: "replace",
      path: "src/photometry/absolute_magnitude.py",
      resolvedPath: "/repo/src/photometry/absolute_magnitude.py",
      before: "",
      after: `def _validate_absolute_magnitude_geometry(object_pos, observer_pos):
    raise ValueError("Invalid photometry geometry for H-G model")
`,
      diff: "",
      beforeHash: "before",
      afterHash: "after"
    }]
  });

  assert.match(hints, /validate\.\*geometry\|geometry\.\*validate/);
  assert.match(hints, /files: src\/photometry\/\*\.py/);
  assert.match(hints, /files: src\/photometry\/\*magnitude\*\.py/);
  assert.doesNotMatch(hints, /_validate_hg_geometry|photometry\.magnitude|calculate_apparent_magnitude/);
});

test("applyReviewedMutation applies cached mutation after validating before hashes", async () => {
  await withTempDir(async (dir) => {
    const context = createContext(dir);
    await writeFile(path.join(dir, "edit.ts"), "const value = 1;\n", "utf8");
    const proposal = await extractFileMutationProposal(context, {
      type: "tool_call",
      toolName: "edit_many",
      toolCallId: "call-apply",
      input: {
        files: [{ path: "edit.ts", edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }] }]
      }
    } as ToolCallEvent);
    assert.ok(proposal);

    const pending = rememberPendingReviewedMutation(context, proposal, { review: fakeReviewResult() });
    const result = await applyReviewedMutation(context, pending.id);

    assert.equal(await readFile(path.join(dir, "edit.ts"), "utf8"), "const value = 2;\n");
    assert.equal(result.details.id, pending.id);
    assert.equal(result.details.files[0].afterHash, proposal.operations[0].afterHash);
    await assert.rejects(() => applyReviewedMutation(context, pending.id), /No pending reviewed mutation/);
  });
});

test("applyReviewedMutation refuses stale files", async () => {
  await withTempDir(async (dir) => {
    const context = createContext(dir);
    await writeFile(path.join(dir, "edit.ts"), "const value = 1;\n", "utf8");
    const proposal = await extractFileMutationProposal(context, {
      type: "tool_call",
      toolName: "edit_many",
      toolCallId: "call-stale",
      input: {
        files: [{ path: "edit.ts", edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }] }]
      }
    } as ToolCallEvent);
    assert.ok(proposal);

    const pending = rememberPendingReviewedMutation(context, proposal, { review: fakeReviewResult() });
    await writeFile(path.join(dir, "edit.ts"), "const value = 3;\n", "utf8");

    await assert.rejects(() => applyReviewedMutation(context, pending.id), /changed since review/);
    assert.equal(await readFile(path.join(dir, "edit.ts"), "utf8"), "const value = 3;\n");
  });
});

test("recoverMutationReviewDecisionFromAssistant recovers a final submit tool call that did not execute", () => {
  const proposal = {
    operations: [{ id: "m1", path: "src/new.ts" }]
  } as FileMutationProposal;
  const decision = recoverMutationReviewDecisionFromAssistant({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call-submit",
      name: "submit_mutation_review",
      arguments: {
        decision: "block",
        confidence: "high",
        summary: "Existing helper should be reused.",
        evidence: [{
          path: "src/existing.ts",
          lineRange: "10-20",
          symbol: "existingHelper",
          reason: "Same behavior already exists."
        }],
        suggestedPath: "src/existing.ts"
      }
    }],
    api: "openai-responses",
    provider: "openai",
    model: "fake",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now()
  } as AssistantMessage, proposal);

  assert.equal(decision?.decision, "block");
  assert.equal(decision?.confidence, "high");
  assert.equal(decision?.evidence[0].path, "src/existing.ts");
  assert.deepEqual(decision?.blockedMutationIds, []);
});

test("recoverMutationReviewDecisionFromText converts explicit final prose block into structured decision", () => {
  const proposal = {
    operations: [{ id: "m_ab12cd34ef56", path: "src/geometry/state_metric.py", resolvedPath: "/repo/src/geometry/state_metric.py" }]
  } as FileMutationProposal;
  const decision = recoverMutationReviewDecisionFromText(`Decision: **block**

Block m_ab12cd34ef56 because a high-confidence reusable implementation already exists in \`src/geometry/units.py\` (\`convert_cartesian_values_au_to_km\`, \`convert_cartesian_covariance_au_to_km\`), which already performs the same AU/AU-day → km/km-s state and covariance scaling.`, proposal);

  assert.ok(decision);
  assert.equal(decision.decision, "block");
  assert.equal(decision.confidence, "high");
  assert.equal(decision.evidence[0]?.path, "src/geometry/units.py");
  assert.equal(decision.evidence[0]?.symbol, "convert_cartesian_values_au_to_km, convert_cartesian_covariance_au_to_km");
  assert.deepEqual(decision.blockedMutationIds, ["m_ab12cd34ef56"]);
  assert.doesNotMatch(decision.summary, /^Decision/i);
});

test("recoverMutationReviewDecisionFromText converts explicit final prose allow into structured decision", () => {
  const decision = recoverMutationReviewDecisionFromText(`Verdict: allow

No existing helper covers the new edge-case assertion.`);

  assert.ok(decision);
  assert.equal(decision.decision, "allow");
  assert.equal(decision.evidence.length, 0);
  assert.deepEqual(decision.blockedMutationIds, []);
  assert.equal(decision.summary, "No existing helper covers the new edge-case assertion.");
});

test("recoverMutationReviewDecisionFromText ignores ambiguous prose without a decision prefix", () => {
  assert.equal(recoverMutationReviewDecisionFromText("This probably should block because src/existing.ts exists."), undefined);
});

test("selectMutationReviewModel resolves configured models and auth", () => {
  const gpt = fakeModel("openai-codex", "gpt-5.3-codex");
  const spark = fakeModel("openai-codex", "gpt-5.3-codex-spark");
  const registry = fakeRegistry([gpt, spark], new Set(["openai-codex/gpt-5.3-codex"]));

  assert.deepEqual(selectMutationReviewModel(registry, "openai-codex/gpt-5.3-codex", spark, "low"), { model: gpt, thinkingLevel: "low" });
  assert.throws(() => selectMutationReviewModel(registry, "openai-codex/gpt-5.3-codex-spark", gpt), /no configured auth/);
  assert.throws(() => selectMutationReviewModel(registry, "missing-format", gpt), /not found/);
});

test("buildReuseBlockReason tells the agent how to consolidate or apply cached mutation", () => {
  const reason = buildReuseBlockReason({
    toolName: "edit_many",
    toolCallId: "call-1",
    cwd: "/repo",
    rawInput: {},
    fingerprint: "abcdef1234567890abcdef1234567890",
    operations: []
  }, {
    model: "openai-codex/gpt-5.3-codex",
    thinkingLevel: "high",
    toolCallCount: 2,
    durationMs: 1000,
    decision: {
      decision: "block",
      confidence: "high",
      summary: "Reuse the existing parser helper.",
      evidence: [{ path: "src/parser.ts", lineRange: "10-20", symbol: "parseThing", reason: "It already implements the proposed normalization." }],
      blockedMutationIds: ["m1"],
      suggestedPath: "Import parseThing instead of adding a second parser."
    }
  });

  assert.match(reason, /File mutation was not applied/);
  assert.match(reason, /src\/parser.ts:10-20 parseThing/);
  assert.match(reason, /apply_reviewed_mutation/);
  assert.match(reason, /Reviewed mutation id: mr_/);
  assert.doesNotMatch(reason, /repeat the identical tool call/);
});
