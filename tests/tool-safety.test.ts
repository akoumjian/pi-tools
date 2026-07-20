import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import toolSafetyExtension, {
  applyModelApproval,
  buildHumanReviewConfirmOptions,
  buildHumanReviewPrompt,
  buildToolSafetyStatusText,
  configuredApprovalModel,
  classifyPath,
  evaluateDocumentParse,
  evaluateAsyncShellStart,
  evaluateBash,
  evaluatePathMutations,
  evaluatePathReads,
  evaluateReadOnlyOrchestrate,
  evaluateWebFetchMany,
  parseApprovalModelPreference,
  resolveApprovalModelPreference,
  resolveTrustedWorkspaceRoot,
  setRuntimeApprovalModelPreference,
  setRuntimeToolSafetyEnabled
} from "../extensions/tool-safety/index.js";

function toolCall(toolName: string, input: unknown): ToolCallEvent {
  return {
    type: "tool_call",
    toolName,
    input
  } as ToolCallEvent;
}

function context(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

function trustedWorkspaceFixtureRoot(): string {
  return path.join(process.env.HOME ?? "/tmp", "Code");
}

function trustedWorkspacePath(...parts: string[]): string {
  return path.join(trustedWorkspaceFixtureRoot(), ...parts);
}

function shellCommand(command: string, cwd = "."): { command: string; cwd: string } {
  return { command, cwd };
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

function withTrustedWorkspaceRoot<T>(run: () => T): T {
  const previous = process.env.PI_TOOL_SAFETY_TRUSTED_WORKSPACE;
  process.env.PI_TOOL_SAFETY_TRUSTED_WORKSPACE = trustedWorkspaceFixtureRoot();
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.PI_TOOL_SAFETY_TRUSTED_WORKSPACE;
    } else {
      process.env.PI_TOOL_SAFETY_TRUSTED_WORKSPACE = previous;
    }
  }
}

type FakeToolSafetyApi = ExtensionAPI & {
  commands: Map<string, (args: string, context: unknown) => Promise<void> | void>;
  handlers: Map<string, Function[]>;
};

function createToolSafetyApi(): FakeToolSafetyApi {
  const commands = new Map<string, (args: string, context: unknown) => Promise<void> | void>();
  const handlers = new Map<string, Function[]>();
  return {
    commands,
    handlers,
    registerCommand(name: string, options: { handler: (args: string, context: unknown) => Promise<void> | void }): void {
      commands.set(name, options.handler);
    },
    on(event: string, handler: Function): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }
  } as unknown as FakeToolSafetyApi;
}

function fakeToolSafetyCommandContext(models: Model<Api>[] = [fakeModel("openai-codex", "gpt-5.3-codex-spark")]) {
  const notifications: Array<{ message: string; type: string }> = [];
  return {
    notifications,
    context: {
      cwd: "/repo",
      modelRegistry: fakeRegistry(models),
      ui: {
        notify(message: string, type: string): void {
          notifications.push({ message, type });
        }
      }
    }
  };
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

function fakeRegistry(
  models: Model<Api>[],
  authed: Set<string> = new Set(models.map((model) => `${model.provider}/${model.id}`)),
  refresh?: () => void
) {
  const registry = {
    hasConfiguredAuth(model: Model<Api>): boolean {
      return authed.has(`${model.provider}/${model.id}`);
    },
    getAll(): Model<Api>[] {
      return models;
    }
  };

  return refresh ? { ...registry, refresh } : registry;
}

function refreshingFakeRegistry(initialModels: Model<Api>[], refreshedModels: Model<Api>[]) {
  let models = initialModels;
  let refreshCount = 0;
  return {
    get refreshCount(): number {
      return refreshCount;
    },
    hasConfiguredAuth(model: Model<Api>): boolean {
      return refreshedModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id);
    },
    getAll(): Model<Api>[] {
      return models;
    },
    refresh(): void {
      refreshCount += 1;
      models = refreshedModels;
    }
  };
}

test("tool-safety approval model parsing preserves default low thinking for string config", () => {
  const model = fakeModel("openai-codex", "gpt-5.3-codex-spark");
  const preference = parseApprovalModelPreference("openai-codex/gpt-5.3-codex-spark");
  assert.deepEqual(preference, { model: "openai-codex/gpt-5.3-codex-spark" });

  const selection = resolveApprovalModelPreference(preference, fakeRegistry([model]));
  assert.deepEqual(selection, {
    model,
    modelName: "openai-codex/gpt-5.3-codex-spark",
    thinkingLevel: "low"
  });
});

test("tool-safety approval model supports inline thinking suffixes", () => {
  const model = fakeModel("openai-codex", "gpt-5.3-codex-spark");
  const preference = parseApprovalModelPreference("openai-codex/gpt-5.3-codex-spark:high");
  assert.deepEqual(preference, { model: "openai-codex/gpt-5.3-codex-spark", thinkingLevel: "high" });

  const selection = resolveApprovalModelPreference(preference, fakeRegistry([model]));
  assert.deepEqual(selection, {
    model,
    modelName: "openai-codex/gpt-5.3-codex-spark",
    thinkingLevel: "high"
  });
});

test("tool-safety approval model resolves review model with medium thinking", () => {
  const model = fakeModel("openai", "review-model");
  const preference = parseApprovalModelPreference("openai/review-model:medium");
  assert.deepEqual(preference, { model: "openai/review-model", thinkingLevel: "medium" });

  const selection = resolveApprovalModelPreference(preference, fakeRegistry([model]));
  assert.deepEqual(selection, {
    model,
    modelName: "openai/review-model",
    thinkingLevel: "medium"
  });
});

test("tool-safety approval model object config clamps non-reasoning models to off", () => {
  const model = fakeModel("openai", "gpt-4o", false);
  const preference = parseApprovalModelPreference({ model: "openai/gpt-4o", thinkingLevel: "high" });
  assert.deepEqual(preference, { model: "openai/gpt-4o", thinkingLevel: "high" });

  const selection = resolveApprovalModelPreference(preference, fakeRegistry([model]));
  assert.deepEqual(selection, {
    model,
    modelName: "openai/gpt-4o",
    thinkingLevel: "off"
  });
});

test("tool-safety approval model env override beats file config", () => {
  assert.deepEqual(configuredApprovalModel("openai/gpt-4o", "anthropic/claude-opus-4-7:high"), {
    model: "anthropic/claude-opus-4-7",
    thinkingLevel: "high"
  });
});

test("tool-safety trusted workspace root is config and env driven", () => {
  assert.equal(resolveTrustedWorkspaceRoot(undefined, ""), undefined);
  assert.equal(resolveTrustedWorkspaceRoot("/tmp/from-file", ""), path.resolve("/tmp/from-file"));
  assert.equal(resolveTrustedWorkspaceRoot("/tmp/from-file", "/tmp/from-env"), path.resolve("/tmp/from-env"));
  assert.equal(resolveTrustedWorkspaceRoot("~/workspace", ""), process.env.HOME ? path.join(process.env.HOME, "workspace") : undefined);
});

test("file mutations outside the project are reviewed when no trusted workspace root is configured", () => {
  const decision = evaluatePathMutations(
    [trustedWorkspacePath("other-project", "notes.md")],
    context(trustedWorkspacePath("example")),
    "edit_many",
    ""
  );

  assert.equal(decision.action, "review");
  assert.equal(decision.risk, "high");
  assert.equal(decision.ruleId, "external-path");
});

test("tool-safety status reports config model and runtime overrides", () => {
  setRuntimeApprovalModelPreference(undefined);
  setRuntimeToolSafetyEnabled(true);
  const spark = fakeModel("openai-codex", "gpt-5.3-codex-spark");
  const claude = fakeModel("anthropic", "claude-opus-4-7");
  const registry = fakeRegistry([spark, claude]);

  const initialStatus = buildToolSafetyStatusText({ modelRegistry: registry } as never);
  assert.match(initialStatus, /Enforcement: enabled/);
  assert.match(initialStatus, /Effective source: config\/env/);
  assert.match(initialStatus, /Trusted workspace root:/);
  setRuntimeApprovalModelPreference({ model: "anthropic/claude-opus-4-7:high" });
  try {
    const status = buildToolSafetyStatusText({ modelRegistry: registry } as never);
    assert.match(status, /Effective source: runtime override/);
    assert.match(status, /anthropic\/claude-opus-4-7/);
    assert.match(status, /thinking high/);
  } finally {
    setRuntimeApprovalModelPreference(undefined);
    setRuntimeToolSafetyEnabled(true);
  }
});

test("tool-safety warns once per session start when the approval model remains unavailable", async () => {
  setRuntimeApprovalModelPreference({ model: "openai/review-model", thinkingLevel: "medium" });
  setRuntimeToolSafetyEnabled(true);
  const api = createToolSafetyApi();
  toolSafetyExtension(api);
  const handler = api.handlers.get("session_start")?.[0];
  assert.ok(handler);
  const { context, notifications } = fakeToolSafetyCommandContext([fakeModel("openai-codex", "gpt-5.3-codex-spark")]);

  try {
    await handler({ type: "session_start", reason: "startup" }, { ...context, hasUI: true });
    await handler({ type: "session_start", reason: "resume" }, { ...context, hasUI: true });

    assert.equal(notifications.length, 2);
    assert.equal(notifications[0].type, "warning");
    assert.match(notifications[0].message, /approval model is unavailable/);
    assert.match(notifications[0].message, /review-model/);
    assert.match(notifications[0].message, /Registry has/);
    assert.match(notifications[0].message, /run \/reload or restart Pi/);
  } finally {
    setRuntimeApprovalModelPreference(undefined);
    setRuntimeToolSafetyEnabled(true);
  }
});

test("tool-safety refreshes a stale registry before warning that the approval model is unavailable", async () => {
  setRuntimeApprovalModelPreference({ model: "openai/review-model", thinkingLevel: "medium" });
  setRuntimeToolSafetyEnabled(true);
  const api = createToolSafetyApi();
  toolSafetyExtension(api);
  const handler = api.handlers.get("session_start")?.[0];
  assert.ok(handler);
  const reviewModel = fakeModel("openai", "review-model");
  const registry = refreshingFakeRegistry([fakeModel("openai-codex", "gpt-5.3-codex-spark")], [reviewModel]);
  const notifications: Array<{ message: string; type: string }> = [];
  const context = {
    modelRegistry: registry,
    ui: {
      notify(message: string, type: string): void {
        notifications.push({ message, type });
      }
    }
  };

  try {
    await handler({ type: "session_start", reason: "startup" }, { ...context, hasUI: true });

    assert.equal(registry.refreshCount, 1);
    assert.equal(notifications.length, 0);
    assert.match(buildToolSafetyStatusText(context as never), /openai\/review-model/);
    assert.match(buildToolSafetyStatusText(context as never), /thinking medium/);
  } finally {
    setRuntimeApprovalModelPreference(undefined);
    setRuntimeToolSafetyEnabled(true);
  }
});

test("tool-safety-toggle command changes runtime enforcement state", async () => {
  setRuntimeApprovalModelPreference(undefined);
  setRuntimeToolSafetyEnabled(true);
  const api = createToolSafetyApi();
  toolSafetyExtension(api);
  const { context, notifications } = fakeToolSafetyCommandContext();
  assert.ok(api.commands.has("safety:setup"));
  const toggleCommand = api.commands.get("safety:toggle");
  const statusCommand = api.commands.get("safety:status");
  assert.ok(toggleCommand);
  assert.ok(statusCommand);

  try {
    await toggleCommand("off", context);
    await statusCommand("", context);
    await toggleCommand("", context);
    await statusCommand("", context);
    await toggleCommand("maybe", context);

    assert.equal(notifications[0].type, "warning");
    assert.match(notifications[0].message, /disabled/);
    assert.match(notifications[1].message, /Enforcement: disabled/);
    assert.match(notifications[2].message, /enabled/);
    assert.match(notifications[3].message, /Enforcement: enabled/);
    assert.equal(notifications[4].type, "error");
    assert.match(notifications[4].message, /Usage: \/safety:toggle/);
  } finally {
    setRuntimeToolSafetyEnabled(true);
  }
});

test("disabled tool-safety enforcement bypasses tool_call review", async () => {
  setRuntimeToolSafetyEnabled(false);
  const api = createToolSafetyApi();
  toolSafetyExtension(api);
  const handler = api.handlers.get("tool_call")?.[0];
  assert.ok(handler);

  try {
    const result = await handler(
      toolCall("shell_start", { commands: [shellCommand("rm -rf ~")] }),
      fakeToolSafetyCommandContext().context
    );
    assert.equal(result, undefined);
  } finally {
    setRuntimeToolSafetyEnabled(true);
  }
});

test("tool-safety-model command sets and resets a validated runtime approval model", async () => {
  setRuntimeApprovalModelPreference(undefined);
  setRuntimeToolSafetyEnabled(true);
  const api = createToolSafetyApi();
  toolSafetyExtension(api);
  const { context, notifications } = fakeToolSafetyCommandContext([
    fakeModel("openai-codex", "gpt-5.3-codex-spark"),
    fakeModel("anthropic", "claude-opus-4-7")
  ]);
  const modelCommand = api.commands.get("safety:model");
  const statusCommand = api.commands.get("safety:status");
  assert.ok(modelCommand);
  assert.ok(statusCommand);

  try {
    await modelCommand("anthropic/claude-opus-4-7:high", context);
    await statusCommand("", context);
    await modelCommand("reset", context);
    await statusCommand("", context);

    assert.match(notifications[0].message, /set to anthropic\/claude-opus-4-7/);
    assert.match(notifications[1].message, /Effective source: runtime override/);
    assert.match(notifications[2].message, /reset to config\/env/);
    assert.match(notifications[3].message, /Effective source: config\/env/);
  } finally {
    setRuntimeApprovalModelPreference(undefined);
    setRuntimeToolSafetyEnabled(true);
  }
});

test("tool-safety-model command rejects unavailable models without changing the override", async () => {
  setRuntimeApprovalModelPreference(undefined);
  setRuntimeToolSafetyEnabled(true);
  const api = createToolSafetyApi();
  toolSafetyExtension(api);
  const { context, notifications } = fakeToolSafetyCommandContext([fakeModel("openai-codex", "gpt-5.3-codex-spark")]);
  const modelCommand = api.commands.get("safety:model");
  assert.ok(modelCommand);

  await modelCommand("anthropic/claude-opus-4-7:high", context);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /not changed/);
  assert.match(buildToolSafetyStatusText(context as never), /Effective source: config\/env/);
});

test("human review prompt is a minimal snippet without policy text", () => {
  const prompt = buildHumanReviewPrompt(
    toolCall("shell_start", {
      commands: [
        shellCommand("npm install"),
        shellCommand("git push origin main")
      ]
    }),
    {
      action: "review",
      risk: "medium",
      confidence: "high",
      ruleId: "package-install+model-review",
      reason: "Dependency install needs confirmation.",
      tags: ["dependencies"]
    }
  );

  assert.equal(prompt.title, "Approve shell_start?");
  assert.match(prompt.message, /risk: medium · confidence: high/);
  assert.match(prompt.message, /^1\. \[cwd \.\] npm install$/m);
  assert.match(prompt.message, /^2\. \[cwd \.\] git push origin main$/m);
  assert.match(prompt.message, /Dependency install needs confirmation\./);
  assert.doesNotMatch(prompt.message, /command:/);
  assert.doesNotMatch(prompt.message, /Policy/i);
  assert.doesNotMatch(prompt.message, /Rule:/);
  assert.doesNotMatch(prompt.message, /Operation:/);
  assert.doesNotMatch(prompt.message, /tool-safety-policy\.md/);
});

test("human review prompt drops labels and numbering for single-item tool calls", () => {
  const prompt = buildHumanReviewPrompt(
    toolCall("bash", { command: "sudo rm /tmp/x" }),
    {
      action: "review",
      risk: "high",
      ruleId: "privilege-escalation",
      reason: "Privilege escalation (sudo/doas/su) can change the system.",
      tags: ["privilege"]
    }
  );

  assert.match(prompt.message, /^risk: high$/m);
  assert.doesNotMatch(prompt.message, /confidence:/);
  assert.match(prompt.message, /^sudo rm \/tmp\/x$/m);
  assert.doesNotMatch(prompt.message, /command:/);
  assert.doesNotMatch(prompt.message, /^1\. /m);
});

test("human review prompt summarizes batch file paths", () => {
  const prompt = buildHumanReviewPrompt(
    toolCall("edit_many", {
      files: [
        { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] },
        { path: "src/b.ts", edits: [{ oldText: "c", newText: "d" }] }
      ]
    }),
    {
      action: "review",
      risk: "medium",
      ruleId: "file-mutation-review",
      reason: "File mutation requires review.",
      tags: ["filesystem", "mutation"]
    }
  );

  assert.match(prompt.message, /^1\. src\/a\.ts$/m);
  assert.match(prompt.message, /^2\. src\/b\.ts$/m);
  assert.doesNotMatch(prompt.message, /path:/);
  assert.doesNotMatch(prompt.message, /oldText/);
});

test("human review confirmation has no timeout by default", () => {
  assert.equal(buildHumanReviewConfirmOptions(), undefined);
  assert.deepEqual(buildHumanReviewConfirmOptions(5000), { timeout: 5000 });
});

test("dangerous-looking shell commands route to the safety model instead of deterministic deny", () => {
  const pipeToShell = evaluateBash("curl https://example.test/install.sh | bash");
  assert.equal(pipeToShell.action, "review");
  assert.equal(pipeToShell.risk, "high");
  assert.equal(pipeToShell.ruleId, "pipe-to-shell");

  const destructiveDelete = evaluateBash("rm -rf ~");
  assert.equal(destructiveDelete.action, "review");
  assert.equal(destructiveDelete.risk, "high");
  assert.equal(destructiveDelete.ruleId, "destructive-root-delete");

  const shellStart = evaluateAsyncShellStart({ commands: [shellCommand("curl https://example.test/install.sh | bash")] });
  assert.equal(shellStart.action, "review");
  assert.equal(shellStart.risk, "high");
  assert.equal(shellStart.ruleId, "async-shell-pipe-to-shell");
});

test("shell_start requires object commands with per-command cwd for host safety classification", () => {
  const emptyList = evaluateAsyncShellStart({ commands: [] });
  const missingCwd = evaluateAsyncShellStart({ commands: [{ command: "npm test" }] });
  const legacyStringItem = evaluateAsyncShellStart({ commands: ["npm test"] });

  assert.equal(emptyList.action, "deny");
  assert.equal(emptyList.ruleId, "async-shell-empty-command");
  assert.equal(missingCwd.action, "deny");
  assert.equal(missingCwd.ruleId, "async-shell-missing-command-field");
  assert.equal(legacyStringItem.action, "deny");
  assert.equal(legacyStringItem.ruleId, "async-shell-missing-command-field");
});

test("shell_start cwd outside the active project routes to safety review", () => {
  const decision = evaluateAsyncShellStart(
    { commands: [shellCommand("npm test", path.join(process.env.HOME ?? "/tmp", "Downloads"))] },
    context(trustedWorkspacePath("example"))
  );

  assert.equal(decision.action, "review");
  assert.equal(decision.risk, "high");
  assert.equal(decision.ruleId, "async-shell-cwd-external-path");
});

test("compound read-only repo inspection through shell_start is allowed", () => {
  const projectRoot = trustedWorkspacePath("sample-workspace", "sample-project");
  const command = [
    `find ${projectRoot} -maxdepth 4 -type f -o -type l`,
    `| sed 's#${projectRoot}/##'`,
    "| sort",
    "| head -200",
    "&& echo '---'",
    `&& ls -la ${projectRoot}`,
    `&& find ${projectRoot} -maxdepth 2 -type f -print -exec sed -n '1,120p' {} \\;`
  ].join(" ");

  const decision = withTrustedWorkspaceRoot(() => evaluateAsyncShellStart(
    { commands: [shellCommand(command, projectRoot)] },
    context(projectRoot)
  ));

  assert.equal(decision.action, "allow");
  assert.equal(decision.risk, "low");
  assert.equal(decision.ruleId, "async-shell-read-only");
});

test("shell commands that explicitly name credential paths still route to safety model", () => {
  const decision = evaluateAsyncShellStart({
    commands: [shellCommand(`sed -n '1,120p' ${trustedWorkspacePath("example", ".env")}`)]
  });

  assert.equal(decision.action, "review");
  assert.equal(decision.risk, "high");
  assert.equal(decision.ruleId, "async-shell-secret-command-path");
});

test("credential-looking paths route to the safety model instead of deterministic deny", () => {
  const decision = classifyPath(".env", context(trustedWorkspacePath("example")));

  assert.equal(decision.action, "review");
  assert.equal(decision.risk, "high");
  assert.equal(decision.ruleId, "secret-path");
});

test("trusted workspace file mutations are allowed like Claude auto-mode", () => {
  const decision = withTrustedWorkspaceRoot(() => evaluatePathMutations(
    ["src/a.ts", trustedWorkspacePath("other-project", "notes.md")],
    context(trustedWorkspacePath("example")),
    "edit_many"
  ));

  assert.equal(decision.action, "allow");
  assert.equal(decision.risk, "low");
  assert.equal(decision.ruleId, "trusted-workspace-file-mutation");
});

test("external file mutations still require review", () => {
  const decision = evaluatePathMutations(
    [path.join(process.env.HOME ?? "/tmp", "Desktop", "outside.txt")],
    context(trustedWorkspacePath("example")),
    "write_many"
  );

  assert.equal(decision.action, "review");
  assert.equal(decision.risk, "high");
  assert.equal(decision.ruleId, "external-path");
});

test("Claude auto-mode local development shell commands are allowed", () => {
  const commands = [
    "npm install",
    "npm test",
    "pnpm run lint",
    "cargo check --all-targets",
    `PROJECT_USE_NATIVE_BACKEND=1 PYTHONPATH=${trustedWorkspacePath("sample-project", "src")} pdm run pytest --benchmark-skip`,
    "git commit -m 'checkpoint'",
    "git push origin HEAD:blog-engineering",
    "git push origin main",
    "git push origin HEAD:main",
    "git status --short && git commit -m 'Omit RSS route when blog is disabled' && git push origin HEAD:blog-engineering",
    "printf 'ok\\n'"
  ];

  for (const command of commands) {
    const decision = withTrustedWorkspaceRoot(() => evaluateAsyncShellStart(
      { commands: [shellCommand(command)] },
      context(trustedWorkspacePath("example"))
    ));
    assert.equal(decision.action, "allow", command);
  }
});

test("destructive or hard-to-undo git pushes still route to review", () => {
  const commands = [
    "git push origin production",
    "git push origin HEAD:release/2026-05",
    "git push --force origin HEAD:blog-engineering",
    "git push origin --delete blog-engineering",
    "git push --tags"
  ];

  for (const command of commands) {
    const decision = evaluateAsyncShellStart({ commands: [shellCommand(command)] });
    assert.equal(decision.action, "review", command);
  }
});

test("deploy-looking local scripts still route to review", () => {
  const decision = evaluateAsyncShellStart({ commands: [shellCommand("npm run deploy")] });

  assert.equal(decision.action, "review");
  assert.equal(decision.ruleId, "async-shell-bash-default-review");
});

test("compound dependency commands with unclassified external actions still route to review", () => {
  const decision = evaluateAsyncShellStart({ commands: [shellCommand("npm install && curl https://example.com/script")] });

  assert.equal(decision.action, "review");
  assert.equal(decision.ruleId, "async-shell-bash-default-review");
});

test("safety model allow is no longer downgraded to human review by host risk", () => {
  const decision = applyModelApproval(
    {
      action: "review",
      risk: "high",
      ruleId: "pipe-to-shell",
      reason: "Pipe-to-shell installer can execute arbitrary remote code.",
      tags: ["network", "execution"]
    },
    {
      action: "allow",
      risk: "high",
      confidence: "high",
      reason: "The user explicitly requested this exact local installer command.",
      model: "openai-codex/gpt-5.3-codex-spark",
      raw: "{}"
    }
  );

  assert.equal(decision.action, "allow");
  assert.equal(decision.ruleId, "pipe-to-shell+model-allow");
  assert.equal(decision.confidence, "high");
  assert.equal(decision.reason, "The user explicitly requested this exact local installer command.");
});

test("web_fetch_many public HTTP URLs are allowed", () => {
  const decision = evaluateWebFetchMany({
    urls: [
      { url: "https://example.com/article" },
      { url: "https://www.example.org/report.pdf" }
    ]
  });

  assert.equal(decision.action, "allow");
  assert.equal(decision.risk, "low");
  assert.equal(decision.ruleId, "web-fetch-public-http");
});

test("web_fetch_many private or credentialed URLs require review", () => {
  const privateUrl = evaluateWebFetchMany({ urls: [{ url: "http://127.0.0.1:8080/admin" }] });
  assert.equal(privateUrl.action, "review");
  assert.equal(privateUrl.risk, "high");
  assert.equal(privateUrl.ruleId, "web-fetch-private-network");

  const credentialUrl = evaluateWebFetchMany({ urls: [{ url: "https://user:pass@example.com/report" }] });
  assert.equal(credentialUrl.action, "review");
  assert.equal(credentialUrl.risk, "high");
  assert.equal(credentialUrl.ruleId, "web-fetch-credential-url");
});

test("read-only orchestrate tasks are allowed but future writer shapes require review", () => {
  assert.deepEqual(evaluateReadOnlyOrchestrate({
    tasks: [
      { id: "read", task: "Inspect package metadata", role: "reader", model: "openai-codex/gpt-5.6-sol", thinkingLevel: "xhigh" },
      { id: "plan", task: "Plan validation", role: "planner" }
    ]
  }).action, "allow");
  assert.equal(evaluateReadOnlyOrchestrate({ tasks: [{ task: "Implement it", role: "worker" }] }).action, "review");
  assert.equal(evaluateReadOnlyOrchestrate({ tasks: [{ task: "Inspect", role: "reader", cwd: "/tmp" }] }).action, "review");
});

test("document_parse is treated as project-local read access", () => {
  const decision = evaluateDocumentParse(
    { path: ".pi/web-fetch/source/report.pdf" },
    context("/Users/example/Code/project")
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.risk, "low");
  assert.equal(decision.ruleId, "read-only-path");
});

test("tool-safety setup writes approval model config and natural-language policy guidance", async () => {
  setRuntimeApprovalModelPreference(undefined);
  setRuntimeToolSafetyEnabled(true);
  const root = await mkdtemp(path.join(tmpdir(), "pi-tool-safety-setup-"));
  const agentDir = path.join(root, "agent");
  const api = createToolSafetyApi();
  toolSafetyExtension(api);
  const { context, notifications } = fakeToolSafetyCommandContext([fakeModel("openai", "review-model")]);
  const setupCommand = api.commands.get("safety:setup");
  assert.ok(setupCommand);

  try {
    await withEnv("PI_CODING_AGENT_DIR", agentDir, async () => {
      await withEnv("PI_TOOLS_CONFIG_DIR", undefined, async () => {
        await setupCommand("openai/review-model:medium --guidance Allow routine local project work; review deploys.", context);
        await setupCommand("openai/review-model:medium --clear-guidance", context);
      });
    });

    const configPath = path.join(agentDir, "extensions", "akoumjian-tools", "tool-safety-settings.json");
    const policyPath = path.join(agentDir, "extensions", "akoumjian-tools", "tool-safety-policy.md");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(config.approvalModel, "openai/review-model:medium");
    await assert.rejects(readFile(policyPath, "utf8"), /ENOENT/);
    assert.match(notifications[0].message, /Policy guidance:/);
    assert.match(notifications[1].message, /Policy guidance: cleared/);
    assert.match(notifications[1].message, /Policy source:/);
  } finally {
    await rm(root, { recursive: true, force: true });
    setRuntimeApprovalModelPreference(undefined);
    setRuntimeToolSafetyEnabled(true);
  }
});

test("read-only external paths are allowed unless credential-like", () => {
  const tempRead = evaluatePathReads(
    ["/var/folders/g_/ng258nmx09v46x2jdlg8w33c0000gn/T/pi-document-parse-Sfn5XH/parsed.txt"],
    context("/Users/example/Code/project"),
    "read_many"
  );
  assert.equal(tempRead.action, "allow");
  assert.equal(tempRead.risk, "low");
  assert.equal(tempRead.ruleId, "read-only-path");

  const credentialRead = evaluatePathReads(
    ["/Users/example/.ssh/id_ed25519"],
    context("/Users/example/Code/project"),
    "read_many"
  );
  assert.equal(credentialRead.action, "review");
  assert.equal(credentialRead.risk, "high");
  assert.equal(credentialRead.ruleId, "secret-path");
});
