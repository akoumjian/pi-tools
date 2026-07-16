import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import orchestratorExtension, { buildOrchestratorStatusText, mapWithConcurrencyLimit } from "../extensions/orchestrator/index.js";
import { canonicalModelSpec, resolveTaskModel, selectDistinctReviewer } from "../extensions/orchestrator/models.js";
import { parseOrchestratorSetupArgs, readOrchestratorSettings } from "../extensions/orchestrator/settings.js";

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

function fakeRegistry(models: Model<Api>[], authed = new Set(models.map((model) => `${model.provider}/${model.id}`))) {
  return {
    hasConfiguredAuth(model: Model<Api>): boolean {
      return authed.has(`${model.provider}/${model.id}`);
    },
    getAll(): Model<Api>[] {
      return models;
    }
  };
}

async function withEnv(name: string, value: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("orchestrator setup parser accepts role routes, reviewer pool, and quoted guidance", () => {
  const parsed = parseOrchestratorSetupArgs([
    "--worker openai-codex/gpt-5.6-sol:xhigh",
    "--reader openai-codex/gpt-5.6-sol:xhigh",
    "--planner anthropic/claude-fable-5:xhigh",
    "--reviewer anthropic/claude-opus-4-8:xhigh",
    "--reviewer anthropic/claude-fable-5:xhigh",
    "--guidance \"Prefer bounded fan-out and explicit evidence.\""
  ].join(" "));
  assert.equal(parsed.worker, "openai-codex/gpt-5.6-sol:xhigh");
  assert.equal(parsed.reader, "openai-codex/gpt-5.6-sol:xhigh");
  assert.equal(parsed.planner, "anthropic/claude-fable-5:xhigh");
  assert.deepEqual(parsed.reviewers, ["anthropic/claude-opus-4-8:xhigh", "anthropic/claude-fable-5:xhigh"]);
  assert.equal(parsed.guidance, "Prefer bounded fan-out and explicit evidence.\n");
});

test("orchestrator settings load extension-owned guidance without AGENTS dependency", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orchestrator-settings-"));
  try {
    await writeFile(path.join(root, "guidance.md"), "# Local guidance\n\nAvoid broad speculative tasks.\n", "utf8");
    await writeFile(path.join(root, "orchestrator-settings.json"), JSON.stringify({
      models: { worker: "openai-codex/gpt-5.6-sol:xhigh", reviewers: ["anthropic/claude-opus-4-8:xhigh"] },
      guidanceFile: "guidance.md",
      maxConcurrency: 2,
      validation: { command: "npm", args: ["run", "validate"] }
    }), "utf8");
    await withEnv("PI_TOOLS_CONFIG_DIR", root, async () => {
      const settings = readOrchestratorSettings();
      assert.equal(settings.models.worker, "openai-codex/gpt-5.6-sol:xhigh");
      assert.match(settings.guidance ?? "", /Avoid broad speculative tasks/);
      assert.equal(settings.maxConcurrency, 2);
      assert.deepEqual(settings.writeTools, ["edit_many", "write_many"]);
      assert.deepEqual(settings.shellTools, ["shell_start", "shell_status", "shell_read", "shell_cancel"]);
      assert.deepEqual(settings.validation, { command: "npm", args: ["run", "validate"], timeoutMs: 600_000, maxRunsPerTask: 5 });
      assert.equal(settings.writesEnabled, false);
      assert.equal(settings.dryRun, true);
      assert.match(buildOrchestratorStatusText(settings), /AGENTS\.md dependency: none/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task model routing honors per-task override and configured fallback", () => {
  const worker = fakeModel("openai-codex", "gpt-5.6-sol");
  const reader = fakeModel("openai-codex", "gpt-5.6-luna");
  const planner = fakeModel("anthropic", "claude-fable-5");
  const registry = fakeRegistry([worker, reader, planner]);
  const settings = {
    ...readOrchestratorSettings(),
    models: {
      worker: "openai-codex/gpt-5.6-sol:xhigh",
      reader: "openai-codex/gpt-5.6-sol:xhigh",
      planner: "anthropic/claude-fable-5:xhigh",
      reviewers: []
    }
  };
  assert.equal(canonicalModelSpec(resolveTaskModel(registry, settings, { role: "reader" }, worker)), "openai-codex/gpt-5.6-sol:xhigh");
  assert.equal(canonicalModelSpec(resolveTaskModel(registry, settings, {
    role: "reader",
    model: "openai-codex/gpt-5.6-sol",
    thinkingLevel: "xhigh"
  }, worker)), "openai-codex/gpt-5.6-sol:xhigh");
  assert.equal(canonicalModelSpec(resolveTaskModel(registry, settings, { role: "planner" }, worker)), "anthropic/claude-fable-5:xhigh");
  assert.equal(canonicalModelSpec(resolveTaskModel(registry, settings, { role: "writer" }, worker)), "openai-codex/gpt-5.6-sol:xhigh");
});

test("writer tasks are refused unless writesEnabled is on and dryRun is off", async () => {
  const tools: Array<{ execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, context: ExtensionContext) => Promise<unknown> }> = [];
  const api = {
    registerCommand(): void {},
    registerTool(tool: unknown): void { tools.push(tool as (typeof tools)[number]); },
    getAllTools: () => [{ name: "search_many" }, { name: "read_many" }, { name: "edit_many" }, { name: "write_many" }]
  } as unknown as ExtensionAPI;
  orchestratorExtension(api);
  const tool = tools[0];
  const context = {
    cwd: tmpdir(),
    modelRegistry: fakeRegistry([]),
    ui: { notify(): void {} }
  } as unknown as ExtensionContext;
  const params = { tasks: [{ task: "apply the focused fix", role: "writer" }] };

  const disabledRoot = await mkdtemp(path.join(tmpdir(), "pi-orchestrator-writer-disabled-"));
  const dryRunRoot = await mkdtemp(path.join(tmpdir(), "pi-orchestrator-writer-dryrun-"));
  try {
    await withEnv("PI_TOOLS_CONFIG_DIR", disabledRoot, async () => {
      await assert.rejects(() => tool.execute("t1", params, undefined, undefined, context), /writes are disabled/);
    });
    await writeFile(path.join(dryRunRoot, "orchestrator-settings.json"), JSON.stringify({
      models: { worker: "openai-codex/gpt-5.6-sol:xhigh", reviewers: ["anthropic/claude-opus-4-8:xhigh"] },
      writesEnabled: true,
      dryRun: true
    }), "utf8");
    await withEnv("PI_TOOLS_CONFIG_DIR", dryRunRoot, async () => {
      await assert.rejects(() => tool.execute("t2", params, undefined, undefined, context), /dryRun is enabled/);
    });
  } finally {
    await rm(disabledRoot, { recursive: true, force: true });
    await rm(dryRunRoot, { recursive: true, force: true });
  }
});

test("reviewer selection enforces a distinct provider", () => {
  const implementer = fakeModel("openai-codex", "gpt-5.6-sol");
  const sameProvider = fakeModel("openai-codex", "codex-auto-review");
  const independent = fakeModel("anthropic", "claude-opus-4-8");
  const registry = fakeRegistry([implementer, sameProvider, independent]);
  const selected = selectDistinctReviewer(registry, [
    "openai-codex/codex-auto-review:xhigh",
    "anthropic/claude-opus-4-8:xhigh"
  ], implementer);
  assert.equal(canonicalModelSpec(selected), "anthropic/claude-opus-4-8:xhigh");
  assert.throws(
    () => selectDistinctReviewer(registry, ["openai-codex/codex-auto-review:xhigh"], implementer),
    /No independent reviewer.*implementer provider openai-codex/
  );
});

test("bounded map preserves input order and never exceeds concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const values = await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(values, [2, 4, 6, 8, 10]);
  assert.equal(maxActive, 2);
});

test("setup writes machine-local config and rejects same-provider reviewer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orchestrator-setup-"));
  const agentDir = path.join(root, "agent");
  const worker = fakeModel("openai-codex", "gpt-5.6-sol");
  const reviewer = fakeModel("anthropic", "claude-opus-4-8");
  const planner = fakeModel("anthropic", "claude-fable-5");
  const sameProvider = fakeModel("openai-codex", "codex-auto-review");
  const commands = new Map<string, (args: string, context: ExtensionContext) => Promise<void> | void>();
  const tools: unknown[] = [];
  const api = {
    registerCommand(name: string, command: { handler: (args: string, context: ExtensionContext) => Promise<void> | void }): void {
      commands.set(name, command.handler);
    },
    registerTool(tool: unknown): void { tools.push(tool); }
  } as unknown as ExtensionAPI;
  orchestratorExtension(api);
  assert.ok(commands.has("orchestrator:setup"));
  assert.ok(commands.has("orchestrator:status"));
  assert.equal(tools.length, 1);
  const notifications: Array<{ message: string; type: string }> = [];
  const context = {
    cwd: root,
    model: worker,
    modelRegistry: fakeRegistry([worker, reviewer, planner, sameProvider]),
    ui: { notify(message: string, type: string): void { notifications.push({ message, type }); } }
  } as unknown as ExtensionContext;

  try {
    await withEnv("PI_CODING_AGENT_DIR", agentDir, async () => {
      await withEnv("PI_TOOLS_CONFIG_DIR", undefined, async () => {
        await commands.get("orchestrator:setup")!(
          "--worker openai-codex/gpt-5.6-sol:xhigh --reader openai-codex/gpt-5.6-sol:xhigh --planner anthropic/claude-fable-5:xhigh --reviewer anthropic/claude-opus-4-8:xhigh",
          context
        );
      });
    });
    const configPath = path.join(agentDir, "extensions", "akoumjian-tools", "orchestrator-settings.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as { models: { worker: string; reader: string; planner: string; reviewers: string[] }; dryRun: boolean; writesEnabled: boolean };
    assert.equal(config.models.worker, "openai-codex/gpt-5.6-sol:xhigh");
    assert.equal(config.models.reader, "openai-codex/gpt-5.6-sol:xhigh");
    assert.equal(config.models.planner, "anthropic/claude-fable-5:xhigh");
    assert.deepEqual(config.models.reviewers, ["anthropic/claude-opus-4-8:xhigh"]);
    assert.equal(config.dryRun, true);
    assert.equal(config.writesEnabled, false);
    assert.match(notifications[0].message, /Writes remain disabled/);

    await withEnv("PI_CODING_AGENT_DIR", path.join(root, "rejected-agent"), async () => {
      await withEnv("PI_TOOLS_CONFIG_DIR", undefined, async () => {
        await commands.get("orchestrator:setup")!(
          "--worker openai-codex/gpt-5.6-sol:xhigh --reviewer openai-codex/codex-auto-review:xhigh",
          context
        );
      });
    });
    assert.match(notifications.at(-1)?.message ?? "", /No independent reviewer.*implementer provider openai-codex/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
