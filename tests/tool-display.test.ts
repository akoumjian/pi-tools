import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import searxngSearchExtension from "../extensions/searxng-search/index.js";
import toolDisplayExtension, { adaptDocumentParseResultHandoff, createDocumentParseTool, readToolDisplaySettings } from "../extensions/tool-display/index.js";

type FakeHandler = (event: unknown, context: unknown) => void;

type FakeApi = ExtensionAPI & {
  registeredTools: ToolDefinition[];
  commands: Map<string, { description?: string; handler: Function }>;
  handlers: Map<string, FakeHandler[]>;
};

const renderTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text
};

function createFakeApi(): FakeApi {
  const registeredTools: ToolDefinition[] = [];
  const commands = new Map<string, { description?: string; handler: Function }>();
  const handlers = new Map<string, FakeHandler[]>();
  const fake = {
    registeredTools,
    commands,
    handlers,
    registerTool(tool: ToolDefinition): void {
      registeredTools.push(tool);
    },
    registerCommand(name: string, command: { description?: string; handler: Function }): void {
      commands.set(name, command);
    },
    on(event: string, handler: FakeHandler): void {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    }
  };
  return fake as unknown as FakeApi;
}

function required<T>(value: T | undefined, name: string): T {
  assert.notEqual(value, undefined, name);
  if (value === undefined) {
    throw new Error(name);
  }
  return value;
}

test("searxng_search renders compactly without search snippets", () => {
  const api = createFakeApi();
  searxngSearchExtension(api);
  const tool = required(api.registeredTools.find((registeredTool) => registeredTool.name === "searxng_search"), "searxng_search tool");

  assert.equal(tool.renderShell, "self");
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");

  const callText = tool.renderCall?.({ query: "asteroid institute research" } as never, renderTheme as never, {} as never).render(200).join("\n") ?? "";
  assert.match(callText, /⏺ WebSearch\("asteroid institute research"\)/);

  const resultText = tool.renderResult?.({
    content: [{ type: "text", text: "1. Verbose title\nhttps://example.com\nLong snippet that should not display" }],
    details: {
      query: "asteroid institute research",
      resultCount: 8,
      page: 1,
      baseUrl: "http://127.0.0.1:8080"
    }
  } as never, { expanded: false, isPartial: false }, renderTheme as never, {} as never).render(200).join("\n") ?? "";
  assert.match(resultText, /⎿ 8 results · "asteroid institute research"/);
  assert.doesNotMatch(resultText, /Verbose title|Long snippet|https:\/\/example\.com/);
});

test("document_parse display override is available as an explicit opt-in", () => {
  const tool = createDocumentParseTool({ enableDisplayOverrides: true });

  assert.equal(tool.renderShell, "self");
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
  assert.deepEqual(tool.promptGuidelines?.map((line) => line.split(":", 1)[0]), [
    "document_parse use",
    "document_parse input",
    "document_parse output",
    "document_parse constraints"
  ]);
  assert.match(tool.promptGuidelines?.join("\n") ?? "", /read_many/);
  assert.match(tool.promptGuidelines?.join("\n") ?? "", /outputPath/);
  assert.match(tool.promptGuidelines?.join("\n") ?? "", /\/docparser:doctor/);
  assert.doesNotMatch(tool.promptGuidelines?.join("\n") ?? "", /this tool/i);

  const callText = tool.renderCall?.({
    path: "/var/folders/example/report.pdf",
    targetPages: "1-2",
    format: "text"
  } as never, renderTheme as never, {} as never).render(200).join("\n") ?? "";
  assert.match(callText, /⏺ Parse\(/);
  assert.match(callText, /report\.pdf/);
  assert.match(callText, /pages 1-2/);

  const partialText = tool.renderResult?.({
    content: [{ type: "text", text: "Checking host dependencies..." }],
    details: {}
  } as never, { expanded: false, isPartial: true }, renderTheme as never, {} as never).render(200).join("\n") ?? "";
  assert.match(partialText, /⎿ checking dependencies/);

  const resultText = tool.renderResult?.({
    content: [{ type: "text", text: "Parsed document: report.pdf\nPreview:\nVery long parsed document text that should not display" }],
    details: {
      sourcePath: "report.pdf",
      resolvedPath: "/tmp/report.pdf",
      outputFormat: "text",
      outputPath: "/var/folders/g_/tmp/pi-document-parse-Sfn5XH/parsed.txt",
      outputDir: "/var/folders/g_/tmp/pi-document-parse-Sfn5XH",
      pageCount: 12,
      screenshotCount: 0
    }
  } as never, { expanded: false, isPartial: false }, renderTheme as never, {} as never).render(200).join("\n") ?? "";
  assert.match(resultText, /⎿ 12 pages · text · .*parsed\.txt/);
  assert.doesNotMatch(resultText, /Very long parsed document text|Preview:/);
});

test("document_parse wrapper replaces the disabled stock-read truncation handoff", () => {
  const result = adaptDocumentParseResultHandoff({
    content: [{ type: "text", text: "Preview truncated. Use read on /tmp/parsed.txt for the full parsed output." }],
    details: {
      sourcePath: "input.pdf",
      resolvedPath: "/tmp/input.pdf",
      outputFormat: "text",
      outputPath: "/tmp/parsed.txt",
      outputDir: "/tmp",
      pageCount: 1,
      screenshotCount: 0
    }
  });

  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /Use read_many with files: \[\{ path: "\/tmp\/parsed\.txt" \}\]/);
  assert.doesNotMatch(text, /Use read on/);
});

test("tool display extension defaults display overrides off and leaves hidden thinking labels to Pi defaults", () => {
  const api = createFakeApi();
  toolDisplayExtension(api);
  const tool = required(api.registeredTools.find((registeredTool) => registeredTool.name === "document_parse"), "document_parse tool");

  assert.equal(readToolDisplaySettings().enableDisplayOverrides, false);
  assert.equal(tool.renderShell, undefined);
  assert.equal(tool.renderCall, undefined);
  assert.equal(tool.renderResult, undefined);
  assert.match(tool.promptGuidelines?.join("\n") ?? "", /read_many/);
  assert.ok(api.commands.has("docparser:doctor"));
  assert.match(api.commands.get("docparser:doctor")?.description ?? "", /document_parse host dependencies/);
  assert.equal(api.handlers.has("session_start"), false);
  assert.equal(api.handlers.has("session_tree"), false);
  assert.equal(api.handlers.has("message_update"), false);
  assert.equal(api.handlers.has("message_end"), false);
  assert.equal(api.handlers.has("agent_end"), false);
});

test("package manifest loads document_parse wrapper without stock tool conflict", async () => {
  const { join } = await import("node:path");
  const { readFile } = await import("node:fs/promises");
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
    pi?: { extensions?: string[] };
  };
  const extensions = packageJson.pi?.extensions ?? [];

  assert.ok(extensions.includes("extensions/tool-display/index.ts"));
  assert.ok(!extensions.includes("node_modules/pi-docparser/extensions/docparser/index.ts"));
});
