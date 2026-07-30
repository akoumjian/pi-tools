import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import webFetchExtension, { buildWebFetchStatusText, extractReadableHtml, isPrivateOrLocalHostname, webFetchMany } from "../extensions/web-fetch/index.js";

type FakeApi = ExtensionAPI & {
  registeredTools: ToolDefinition[];
  commands: Map<string, { description: string; handler: Function }>;
};

const renderTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text
};

function createContext(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

function createFakeApi(): FakeApi {
  const registeredTools: ToolDefinition[] = [];
  const commands = new Map<string, { description: string; handler: Function }>();
  const fake = {
    registeredTools,
    commands,
    registerCommand(name: string, command: { description: string; handler: Function }): void {
      commands.set(name, command);
    },
    registerTool(tool: ToolDefinition): void {
      registeredTools.push(tool);
    },
    on(): void {}
  };
  return fake as unknown as FakeApi;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-web-fetch-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function required<T>(value: T | undefined, name: string): T {
  assert.notEqual(value, undefined, name);
  if (value === undefined) {
    throw new Error(name);
  }
  return value;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return async (input, init) => handler(input instanceof URL ? input.href : String(input), init);
}

test("web_fetch_many extracts readable HTML to cached markdown", async () => {
  await withTempDir(async (dir) => {
    const html = [
      "<!doctype html>",
      "<html>",
      "<head><title>Research Note</title><meta name=\"description\" content=\"Concise description\"></head>",
      "<body>",
      "<nav>navigation noise</nav>",
      "<article>",
      "<h1>Research Note</h1>",
      "<p>First useful paragraph about alpha research.</p>",
      "<p>Second useful paragraph with source detail.</p>",
      "</article>",
      "</body>",
      "</html>"
    ].join("");

    const result = await webFetchMany(
      createContext(dir),
      { urls: [{ url: "https://example.com/post", label: "example" }] },
      fakeFetch(() => new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      }))
    );

    const item = required(result.details?.results[0], "first result");
    assert.equal(item.status, "ok");
    assert.equal(item.kind, "html");
    assert.equal(item.title, "Research Note");
    assert.equal(item.description, "Concise description");
    assert.match(item.sourcePath ?? "", /\.pi\/web-fetch\/.*\/source\.html$/);
    assert.match(item.textPath ?? "", /\.pi\/web-fetch\/.*\/extracted\.md$/);
    assert.match(item.preview ?? "", /First useful paragraph/);

    const markdown = await readFile(required(item.textPath, "textPath"), "utf8");
    assert.match(markdown, /^# Research Note/);
    assert.match(markdown, /Source: https:\/\/example\.com\/post/);
    assert.match(markdown, /Second useful paragraph/);

    const raw = await readFile(required(item.sourcePath, "sourcePath"), "utf8");
    assert.match(raw, /<article>/);
  });
});

test("web_fetch_many follows redirects and saves document downloads for document_parse", async () => {
  await withTempDir(async (dir) => {
    const seen: string[] = [];
    const result = await webFetchMany(
      createContext(dir),
      { urls: [{ url: "https://example.com/old-report" }] },
      fakeFetch((url) => {
        seen.push(url);
        if (url === "https://example.com/old-report") {
          return new Response(null, {
            status: 302,
            headers: { location: "/files/report.pdf" }
          });
        }
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": "attachment; filename=\"report.pdf\""
          }
        });
      })
    );

    assert.deepEqual(seen, ["https://example.com/old-report", "https://example.com/files/report.pdf"]);
    const item = required(result.details?.results[0], "first result");
    assert.equal(item.status, "ok");
    assert.equal(item.kind, "download");
    assert.equal(item.finalUrl, "https://example.com/files/report.pdf");
    assert.match(item.downloadedPath ?? "", /report\.pdf$/);
    assert.equal(item.documentParseHint?.tool, "document_parse");
    assert.equal(item.documentParseHint?.path, item.downloadedPath);
    const bytes = await readFile(required(item.downloadedPath, "downloadedPath"));
    assert.deepEqual([...bytes], [0x25, 0x50, 0x44, 0x46]);
  });
});

test("web_fetch_many reports actionable cache write failures", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, ".pi"), "not a directory", "utf8");

    const result = await webFetchMany(
      createContext(dir),
      { urls: [{ url: "https://example.com/post" }] },
      fakeFetch(() => new Response("<html><body><article>cached content</article></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      }))
    );

    const item = required(result.details?.results[0], "first result");
    assert.equal(item.status, "error");
    assert.match(item.error ?? "", /Failed to create web_fetch_many cache directory/);
    assert.match(item.error ?? "", /\.pi\/web-fetch permissions/);
    assert.match(item.error ?? "", /\/fetch:status/);
  });
});

test("web_fetch_many propagates parent interruption instead of returning per-item fetch errors", async () => {
  await withTempDir(async (dir) => {
    const controller = new AbortController();
    let called = false;
    const fetching = webFetchMany(
      createContext(dir),
      { urls: [{ url: "https://example.com/slow" }] },
      fakeFetch((_url, init) => {
        called = true;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
      controller.signal
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    await assert.rejects(fetching, { name: "AbortError" });
    assert.equal(called, true);
  });
});

test("web_fetch_many refuses local and private-network URLs before fetching", async () => {
  await withTempDir(async (dir) => {
    let called = false;
    const result = await webFetchMany(
      createContext(dir),
      { urls: [{ url: "http://127.0.0.1:8080/admin" }] },
      fakeFetch(() => {
        called = true;
        return new Response("should not be called");
      })
    );

    assert.equal(called, false);
    const item = required(result.details?.results[0], "first result");
    assert.equal(item.status, "error");
    assert.match(item.error ?? "", /private-network/);
  });

  assert.equal(isPrivateOrLocalHostname("localhost"), true);
  assert.equal(isPrivateOrLocalHostname("192.168.1.10"), true);
  assert.equal(isPrivateOrLocalHostname("example.com"), false);
});

test("web_fetch_many registers compact Pi renderers and status command", () => {
  const api = createFakeApi();
  webFetchExtension(api);
  const tool = required(api.registeredTools.find((registeredTool) => registeredTool.name === "web_fetch_many"), "web_fetch_many tool");

  assert.ok(api.commands.has("fetch:status"));
  assert.equal(api.commands.has("web-fetch-status"), false, "deprecated kebab alias removed");

  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
  assert.equal(tool.renderShell, "self");
  assert.match(tool.promptSnippet ?? "", /^Fetch and cache one or more urls/);
  assert.deepEqual(tool.promptGuidelines?.map((line) => line.split(":", 1)[0]), [
    "web_fetch_many use",
    "web_fetch_many input",
    "web_fetch_many output",
    "web_fetch_many constraints"
  ]);
  assert.match(tool.promptGuidelines?.join("\n") ?? "", /textPath/);
  assert.match(tool.promptGuidelines?.join("\n") ?? "", /downloadedPath/);
  assert.match(JSON.stringify(tool.parameters), /"default":"auto"/);
  assert.match(JSON.stringify(tool.parameters), /Defaults to auto/);

  const callText = tool.renderCall?.({
    urls: [
      { url: "https://example.com/article" },
      { url: "https://example.org/report.pdf" }
    ]
  } as never, renderTheme as never, {} as never).render(200).join("\n") ?? "";
  assert.match(callText, /⏺ Fetch\(example\.com\/article, example\.org\/report\.pdf\)/);

  const resultText = tool.renderResult?.({
    content: [{ type: "text", text: "full model-facing result" }],
    details: {
      cacheRoot: "/tmp/cache",
      results: [
        { url: "https://example.com/article", fetchedAt: "now", status: "ok", kind: "html" },
        { url: "https://example.org/report.pdf", fetchedAt: "now", status: "ok", kind: "download" }
      ]
    }
  } as never, { expanded: false, isPartial: false }, renderTheme as never, {} as never).render(200).join("\n") ?? "";
  assert.match(resultText, /⎿ 2 ok · 1 html, 1 download/);
  assert.doesNotMatch(resultText, /full model-facing result|https:\/\/example/);
});

test("web fetch status reports cache and safety constraints", async () => {
  await withTempDir(async (dir) => {
    const text = buildWebFetchStatusText(createContext(dir));
    assert.match(text, /Web fetch status/);
    assert.match(text, /Cache root:/);
    assert.match(text, /Runtime dependencies: Readability, JSDOM, and Turndown loaded/);
    assert.match(text, /refuses non-HTTP\(S\), localhost, and private-network URLs/);
  });
});

test("extractReadableHtml produces markdown from article content", () => {
  const extraction = extractReadableHtml(
    "<html><head><title>Title</title></head><body><article><h1>Title</h1><p>Body text.</p></article></body></html>",
    "https://example.com"
  );

  assert.equal(extraction.title, "Title");
  assert.match(extraction.markdown, /Body text\./);
});
