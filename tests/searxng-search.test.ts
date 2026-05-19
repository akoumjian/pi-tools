import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import searxngSearchExtension, { buildSearxngStatusText } from "../extensions/searxng-search/index.js";
import { DEFAULT_SEARXNG_PORT, runSearxngSetup, searxngComposeYaml } from "../extensions/searxng-search/setup.js";

type FakeApi = ExtensionAPI & {
  registeredTools: ToolDefinition[];
  commands: Map<string, { description: string; handler: Function }>;
};

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

function required<T>(value: T | undefined, name: string): T {
  assert.notEqual(value, undefined, name);
  if (value === undefined) {
    throw new Error(name);
  }
  return value;
}

function createFakeApi(): FakeApi {
  const registeredTools: ToolDefinition[] = [];
  const commands = new Map<string, { description: string; handler: Function }>();
  return {
    registeredTools,
    commands,
    registerCommand(name: string, command: { description: string; handler: Function }): void {
      commands.set(name, command);
    },
    registerTool(tool: ToolDefinition): void {
      registeredTools.push(tool);
    }
  } as unknown as FakeApi;
}

test("searxng extension registers search tool and status command", () => {
  const api = createFakeApi();
  searxngSearchExtension(api);

  const tool = required(api.registeredTools.find((registeredTool) => registeredTool.name === "searxng_search"), "searxng_search tool");
  assert.match(tool.description, /if it is unconfigured or unreachable/);
  assert.match(tool.promptSnippet ?? "", /^Search the configured SearXNG instance/);
  assert.match(tool.promptGuidelines?.join("\n") ?? "", /Use searxng_search for web discovery before web_fetch_many/);
  const schemaText = JSON.stringify(tool.parameters);
  assert.match(schemaText, /Maximum number of search results/);
  assert.match(schemaText, /Optional freshness filter/);
  assert.ok(api.commands.has("searxng:status"));
  assert.ok(api.commands.has("searxng:setup"));
  assert.equal(api.commands.has("searxng-status"), false, "deprecated kebab alias removed");
});

test("searxng setup defaults to less common local port", () => {
  const report = runSearxngSetup({
    homeDir: "/tmp/pi-home",
    dryRun: true,
    runCommand: () => ({ status: 0, stdout: "", stderr: "" })
  });

  assert.equal(DEFAULT_SEARXNG_PORT, 18888);
  assert.equal(report.port, 18888);
  assert.equal(report.baseUrl, "http://127.0.0.1:18888");
  assert.match(searxngComposeYaml(), /127\.0\.0\.1:\$\{SEARXNG_PORT:-18888\}:8080/);
  assert.match(searxngComposeYaml(), /SEARXNG_BASE_URL=\$\{SEARXNG_BASE_URL:-http:\/\/127\.0\.0\.1:18888\/\}/);
});

test("searxng status reports reachable JSON endpoint", async () => {
  await withEnv("SEARXNG_URL", "http://127.0.0.1:8080", async () => {
    const status = await buildSearxngStatusText(async () => new Response(JSON.stringify({ results: [{ title: "ok" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    assert.equal(status.ok, true);
    assert.match(status.text, /Source: env:SEARXNG_URL/);
    assert.match(status.text, /reachable JSON search endpoint/);
    assert.match(status.text, /Probe results returned: 1/);
  });
});

test("searxng status reports remediation for unreachable service", async () => {
  await withEnv("SEARXNG_URL", "http://127.0.0.1:8080", async () => {
    const status = await buildSearxngStatusText(async () => {
      throw new Error("connection refused");
    });

    assert.equal(status.ok, false);
    assert.match(status.text, /unreachable/);
    assert.match(status.text, /run \/searxng:setup --start/);
  });
});

test("searxng status refuses unconfigured standalone installs", async () => {
  const configDir = await mkdtemp(path.join(tmpdir(), "pi-searxng-config-"));
  try {
    await writeFile(path.join(configDir, "searxng-settings.json"), "{}\n");
    await withEnv("SEARXNG_URL", undefined, async () => {
      await withEnv("PI_TOOLS_CONFIG_DIR", configDir, async () => {
        const status = await buildSearxngStatusText(async () => {
          throw new Error("fetch should not be called when unconfigured");
        });

        assert.equal(status.ok, false);
        assert.match(status.text, /Status: not configured/);
        assert.match(status.text, /\/searxng:setup --dry-run/);
      });
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
