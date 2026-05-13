import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { agentExtensionConfigPath, findPiToolsConfigFile, findPiToolsConfigSource, readPiToolsJsonConfig, readPiToolsJsonConfigSource, readPiToolsReferencedTextConfig, readPiToolsTextConfigSource, removeAgentExtensionConfig, resolvePiToolsConfigReference, writeAgentExtensionConfig, writeAgentExtensionTextConfig } from "../extensions/_shared/config.js";
import { parseGuidedModelSetupArgs, readSetupGuidance } from "../extensions/_shared/setup-command.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-tools-config-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(filePath: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

test("pi tools config lookup prefers explicit env directory before profile and package defaults", async () => {
  await withTempRoot(async (root) => {
    const extensionPath = path.join(root, "packages", "pi-tools", "extensions", "demo", "index.ts");
    const fromMetaUrl = pathToFileURL(extensionPath).href;
    const envDir = path.join(root, "env-config");
    await writeJson(path.join(root, "config", "pi-tools", "example.json"), { source: "profile" });
    await writeJson(path.join(root, "packages", "pi-tools", "config", "example.json"), { source: "package" });
    await writeJson(path.join(envDir, "example.json"), { source: "env" });

    await withEnv("PI_TOOLS_CONFIG_DIR", envDir, async () => {
      assert.equal(findPiToolsConfigFile("example.json", fromMetaUrl), path.join(envDir, "example.json"));
      assert.deepEqual(readPiToolsJsonConfig("example.json", fromMetaUrl), { source: "env" });
      assert.equal(findPiToolsConfigSource("example.json", fromMetaUrl)?.source, "env");
      assert.equal(readPiToolsJsonConfigSource("example.json", fromMetaUrl)?.source, "env");
    });
  });
});

test("pi tools config lookup uses per-machine agent config before profile defaults", async () => {
  await withTempRoot(async (root) => {
    const extensionPath = path.join(root, "packages", "pi-tools", "extensions", "demo", "index.ts");
    const fromMetaUrl = pathToFileURL(extensionPath).href;
    const agentDir = path.join(root, "agent-dir");
    await writeJson(path.join(root, "config", "pi-tools", "example.json"), { source: "profile" });

    await withEnv("PI_TOOLS_CONFIG_DIR", undefined, async () => {
      await withEnv("PI_CODING_AGENT_DIR", agentDir, async () => {
        const written = writeAgentExtensionConfig("example.json", { source: "agent" });
        assert.equal(written, agentExtensionConfigPath("example.json"));
        assert.equal(findPiToolsConfigFile("example.json", fromMetaUrl), written);
        assert.deepEqual(readPiToolsJsonConfig("example.json", fromMetaUrl), { source: "agent" });
        assert.equal(findPiToolsConfigSource("example.json", fromMetaUrl)?.source, "agent");
      });
    });
  });
});

test("pi tools agent config helpers write and read text files", async () => {
  await withTempRoot(async (root) => {
    const extensionPath = path.join(root, "packages", "pi-tools", "extensions", "demo", "index.ts");
    const fromMetaUrl = pathToFileURL(extensionPath).href;
    const agentDir = path.join(root, "agent-dir");

    await withEnv("PI_TOOLS_CONFIG_DIR", undefined, async () => {
      await withEnv("PI_CODING_AGENT_DIR", agentDir, async () => {
        const written = writeAgentExtensionTextConfig("example.md", "hello guidance\n");
        assert.equal(written, agentExtensionConfigPath("example.md"));
        assert.equal(await readFile(written, "utf8"), "hello guidance\n");
        const config = readPiToolsTextConfigSource("example.md", fromMetaUrl);
        assert.equal(config?.source, "agent");
        assert.equal(config?.text, "hello guidance\n");

        const removed = removeAgentExtensionConfig("example.md");
        assert.deepEqual(removed, { path: written, removed: true });
        assert.equal(readPiToolsTextConfigSource("example.md", fromMetaUrl), undefined);
        assert.equal(removeAgentExtensionConfig("example.md").removed, false);
      });
    });
  });
});

test("pi tools config references resolve markdown paths relative to settings files", async () => {
  await withTempRoot(async (root) => {
    const settingsPath = path.join(root, "config", "example-settings.json");
    const guidancePath = path.join(root, "config", "guidance.md");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(guidancePath, "Referenced guidance.\n", "utf8");

    const resolved = resolvePiToolsConfigReference("guidance.md", settingsPath);
    assert.equal(resolved, guidancePath);
    assert.equal(resolvePiToolsConfigReference("guidance.md", pathToFileURL(settingsPath)).toString(), pathToFileURL(guidancePath).toString());

    const config = readPiToolsReferencedTextConfig("guidance.md", settingsPath, "profile");
    assert.equal(config.path, guidancePath);
    assert.equal(config.source, "profile");
    assert.equal(config.text, "Referenced guidance.\n");
  });
});

test("guided setup argument parser accepts inline and file-backed guidance", async () => {
  await withTempRoot(async (root) => {
    const guidancePath = path.join(root, "guidance.md");
    await writeFile(guidancePath, "Prefer safe local work.\n", "utf8");

    const inline = parseGuidedModelSetupArgs("openai-codex/model:low --guidance Prefer local validation over deploys.", "/safety:setup");
    assert.deepEqual(inline, {
      help: false,
      modelSpec: "openai-codex/model:low",
      guidance: "Prefer local validation over deploys."
    });
    assert.equal(readSetupGuidance(inline, root), "Prefer local validation over deploys.\n");

    const fromFile = parseGuidedModelSetupArgs(`anthropic/claude --guidance-file ${guidancePath}`, "/mutation:setup");
    assert.equal(fromFile.modelSpec, "anthropic/claude");
    assert.equal(readSetupGuidance(fromFile, root), "Prefer safe local work.\n");

    const clear = parseGuidedModelSetupArgs("anthropic/claude --clear-guidance", "/mutation:setup");
    assert.deepEqual(clear, { help: false, modelSpec: "anthropic/claude", clearGuidance: true });
    assert.throws(() => parseGuidedModelSetupArgs("model --clear-guidance --guidance keep both", "/safety:setup"), /accepts only one guidance input/);
    assert.throws(() => parseGuidedModelSetupArgs("model --guidance-file one --guidance-file two", "/safety:setup"), /accepts only one guidance input/);
  });
});

test("pi tools config lookup uses an enclosing profile config before package defaults", async () => {
  await withTempRoot(async (root) => {
    const extensionPath = path.join(root, "packages", "pi-tools", "extensions", "demo", "index.ts");
    const fromMetaUrl = pathToFileURL(extensionPath).href;
    const profilePath = path.join(root, "config", "pi-tools", "example.json");
    await writeJson(profilePath, { source: "profile" });
    await writeJson(path.join(root, "packages", "pi-tools", "config", "example.json"), { source: "package" });

    await withEnv("PI_TOOLS_CONFIG_DIR", undefined, async () => {
      assert.equal(findPiToolsConfigFile("example.json", fromMetaUrl), profilePath);
      assert.deepEqual(readPiToolsJsonConfig("example.json", fromMetaUrl), { source: "profile" });
      assert.equal(findPiToolsConfigSource("example.json", fromMetaUrl)?.source, "profile");
    });
  });
});

test("pi tools config lookup reports package defaults before cwd fallback", async () => {
  await withTempRoot(async (root) => {
    const extensionPath = path.join(root, "packages", "pi-tools", "extensions", "demo", "index.ts");
    const fromMetaUrl = pathToFileURL(extensionPath).href;
    const packagePath = path.join(root, "packages", "pi-tools", "config", "example.json");
    await writeJson(packagePath, { source: "package" });

    await withEnv("PI_TOOLS_CONFIG_DIR", undefined, async () => {
      const previousCwd = process.cwd();
      try {
        process.chdir(root);
        await writeJson(path.join(root, "config", "example.json"), { source: "cwd" });
        assert.equal(findPiToolsConfigFile("example.json", fromMetaUrl)?.toString(), pathToFileURL(packagePath).href);
        assert.equal(findPiToolsConfigSource("example.json", fromMetaUrl)?.source, "package");
      } finally {
        process.chdir(previousCwd);
      }
    });
  });
});

test("pi tools config lookup uses cwd fallback when no env profile or package config exists", async () => {
  await withTempRoot(async (root) => {
    const extensionPath = path.join(root, "other", "extensions", "demo", "index.ts");
    const fromMetaUrl = pathToFileURL(extensionPath).href;
    const cwdPath = path.join(root, "config", "example.json");
    await writeJson(cwdPath, { source: "cwd" });

    await withEnv("PI_TOOLS_CONFIG_DIR", undefined, async () => {
      const previousCwd = process.cwd();
      try {
        process.chdir(root);
        assert.deepEqual(readPiToolsJsonConfig("example.json", fromMetaUrl), { source: "cwd" });
        assert.equal(findPiToolsConfigSource("example.json", fromMetaUrl)?.source, "cwd");
      } finally {
        process.chdir(previousCwd);
      }
    });
  });
});
