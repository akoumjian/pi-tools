import assert from "node:assert/strict";
import test from "node:test";
import { resetSearxngThrottleState, search } from "../extensions/searxng-search/index.js";

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

type SearchResult = Awaited<ReturnType<typeof search>>;

function searchText(result: SearchResult): string {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

function mockSearxngFetch(respond: (category: string) => { results: unknown[]; unresponsive_engines?: unknown }): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: URL | string) => {
    const category = new URL(String(input)).searchParams.get("categories") ?? "";
    calls.push(category);
    return new Response(JSON.stringify(respond(category)), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return calls;
}

test("searxng search falls back from general to web when general returns zero results", async () => {
  await withEnv("SEARXNG_URL", "http://127.0.0.1:8080", async () => {
    resetSearxngThrottleState();
    const calls = mockSearxngFetch((category) =>
      category === "general"
        ? { results: [] }
        : { results: [{ title: "web hit", url: "https://example.com", content: "from web" }] }
    );
    const result = await search({ query: "solar flares" });
    assert.deepEqual(calls, ["general", "web"]);
    assert.equal(result.details?.resultCount, 1);
    assert.match(searchText(result), /web hit/);
  });
});

test("searxng search does not fall back for an explicit non-general category", async () => {
  await withEnv("SEARXNG_URL", "http://127.0.0.1:8080", async () => {
    resetSearxngThrottleState();
    const calls = mockSearxngFetch(() => ({ results: [] }));
    const result = await search({ query: "headlines", categories: "news" });
    assert.deepEqual(calls, ["news"]);
    assert.equal(result.details?.resultCount, 0);
    assert.match(searchText(result), /All engines responded with no matches; no backoff applied/);
  });
});

test("searxng search reports degraded zeros with unresponsive engines and backoff", async () => {
  await withEnv("SEARXNG_URL", "http://127.0.0.1:8080", async () => {
    resetSearxngThrottleState();
    mockSearxngFetch(() => ({
      results: [],
      unresponsive_engines: [["brave", "Suspended: too many requests"], ["duckduckgo", "CAPTCHA"]]
    }));
    const result = await search({ query: "nothing matches" });
    assert.equal(result.details?.resultCount, 0);
    assert.deepEqual(result.details?.unresponsiveEngines, ["brave", "duckduckgo"]);
    assert.match(searchText(result), /unresponsive engines: brave, duckduckgo/);
    assert.match(searchText(result), /waits 2s before running/);
  });
});

test("searxng search applies the degraded-zero cooldown to the next call", async () => {
  await withEnv("SEARXNG_URL", "http://127.0.0.1:8080", async () => {
    resetSearxngThrottleState();
    mockSearxngFetch(() => ({ results: [], unresponsive_engines: [["brave", "CAPTCHA"]] }));
    await search({ query: "first degraded zero" });
    const startedAt = Date.now();
    const result = await search({ query: "second call waits" });
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 1900, `expected ~2s cooldown, got ${elapsedMs}ms`);
    assert.equal(result.details?.resultCount, 0);
  });
});

test("searxng search success resets the backoff streak", async () => {
  await withEnv("SEARXNG_URL", "http://127.0.0.1:8080", async () => {
    resetSearxngThrottleState();
    mockSearxngFetch(() => ({ results: [], unresponsive_engines: [["brave", "CAPTCHA"]] }));
    await search({ query: "degraded zero" });
    mockSearxngFetch(() => ({ results: [{ title: "hit", url: "https://example.com", content: "ok" }] }));
    const result = await search({ query: "success resets" });
    assert.equal(result.details?.resultCount, 1);
    const startedAt = Date.now();
    await search({ query: "no more cooldown" });
    assert.ok(Date.now() - startedAt < 1000, "success should reset the backoff");
  });
});

test("searxng search serializes concurrent searches", async () => {
  await withEnv("SEARXNG_URL", "http://127.0.0.1:8080", async () => {
    resetSearxngThrottleState();
    let inFlight = 0;
    let maxInFlight = 0;
    globalThis.fetch = (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return new Response(JSON.stringify({ results: [{ title: "hit", url: "https://example.com", content: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    const [first, second] = await Promise.all([search({ query: "one" }), search({ query: "two" })]);
    assert.equal(maxInFlight, 1, "concurrent searches must not overlap");
    assert.equal(first.details?.resultCount, 1);
    assert.equal(second.details?.resultCount, 1);
  });
});

test("searxng search aborts while waiting for the search slot", async () => {
  await withEnv("SEARXNG_URL", "http://127.0.0.1:8080", async () => {
    resetSearxngThrottleState();
    globalThis.fetch = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    const first = search({ query: "slow search" });
    const controller = new AbortController();
    const pending = search({ query: "aborted search" }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await assert.rejects(pending, /aborted while waiting for the search slot/);
    await first;
  });
});
