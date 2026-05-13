import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import searxngSearchExtension, { buildSearxngStatusText } from "../extensions/searxng-search/index.js";

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

  assert.ok(api.registeredTools.some((tool) => tool.name === "searxng_search"));
  assert.ok(api.commands.has("searxng:status"));
  assert.ok(api.commands.has("searxng:setup"));
  assert.equal(api.commands.has("searxng-status"), false, "deprecated kebab alias removed");
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
