import { Type, type Static } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { throwIfAborted } from "../_shared/cancellation.js";
import { formatConfigPath, readPiToolsJsonConfigSource } from "../_shared/config.js";
import { registerCommandWithAliases } from "../_shared/deprecated-command.js";
import { RetainedToolOutputSchemas } from "../_shared/tool-output.js";
import { inputJsonSchemaGuideline, outputJsonSchemaGuideline } from "../_shared/tool-prompt.js";
import { handleSearxngSetupCommand, SEARXNG_AGENT_CONFIG_FILE } from "./setup.js";

// Throttling: serialize searxng_search calls (one in flight at a time) and
// add a tool-call-level cooldown that grows after consecutive degraded
// zero-result queries (empty results while upstream engines are
// unresponsive/suspended, e.g. 429 / CAPTCHA on duckduckgo / brave).
// SearXNG suspends throttled engines reactively, so serializing closes the
// race where concurrent searches reach an engine before the first failure is
// recorded, without adding fixed idle time between healthy searches.
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;
// Consecutive degraded zero-result queries (empty results while at least one
// engine was unresponsive). A clean zero (all engines responded) resets it.
let degradedStreak = 0;
// FIFO one-search-at-a-time slot over the whole search (including fallback).
let searchInFlight = false;
let searchWaiters: SearchSlotWaiter[] = [];

type SearchSlotWaiter = {
  signal: AbortSignal | undefined;
  onGranted: () => void;
  onAbort: (() => void) | null;
  settled: boolean;
};

function currentBackoffMs(): number {
  if (degradedStreak === 0) return 0;
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (degradedStreak - 1));
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onDone = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onDone);
      resolve();
    };
    const timer = setTimeout(onDone, ms);
    if (signal) {
      if (signal.aborted) onDone();
      else signal.addEventListener("abort", onDone, { once: true });
    }
  });
}

// Reserve the single search slot. Granted immediately when idle; otherwise
// queued FIFO, and rejected early if the caller aborts while waiting. All
// slot mutations are synchronous, so waiters settle in order.
function waitForSearchSlot(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!searchInFlight) {
    searchInFlight = true;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: SearchSlotWaiter = { signal, onGranted: () => {}, onAbort: null, settled: false };
    const cleanup = (): void => {
      const index = searchWaiters.indexOf(waiter);
      if (index !== -1) searchWaiters.splice(index, 1);
      if (waiter.onAbort !== null) signal?.removeEventListener("abort", waiter.onAbort);
    };
    waiter.onGranted = (): void => {
      if (waiter.settled) return;
      waiter.settled = true;
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      if (waiter.settled) return;
      waiter.settled = true;
      cleanup();
      reject(new Error("SearXNG search aborted while waiting for the search slot."));
    };
    waiter.onAbort = onAbort;
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
    searchWaiters.push(waiter);
  });
}

// Release the slot: grant the next queued waiter, or go idle when none wait.
function releaseSearchSlot(): void {
  const next = searchWaiters.shift();
  if (next !== undefined) {
    next.onGranted();
  } else {
    searchInFlight = false;
  }
}

export function resetSearxngThrottleState(): void {
  degradedStreak = 0;
  searchInFlight = false;
  searchWaiters = [];
}

const SearchParams = Type.Object({
  query: Type.String({ minLength: 1, description: "Search query." }),
  results: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 8, description: "Maximum number of search results to return, from 1 to 20. Defaults to 8." })),
  page: Type.Optional(Type.Number({ minimum: 1, default: 1, description: "One-indexed SearXNG result page to fetch. Defaults to 1." })),
  language: Type.Optional(Type.String({ default: "en-US", description: "Search language/locale code understood by SearXNG, such as en-US. Defaults to en-US." })),
  categories: Type.Optional(Type.String({ default: "general", description: "SearXNG category list, such as general, news, science, or it. Defaults to general." })),
  timeRange: Type.Optional(Type.Union([
    Type.Literal("day"),
    Type.Literal("month"),
    Type.Literal("year")
  ], { description: "Optional freshness filter for SearXNG results." }))
}, { additionalProperties: false });

type SearchInput = Static<typeof SearchParams>;

type SearxngResult = {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
};

type SearxngResponse = {
  results?: SearxngResult[];
  // SearXNG reports throttled/failed engines as [["name", "reason"], ...]
  // (older versions used a plain list of names).
  unresponsive_engines?: unknown;
};

type SearchDetails = {
  query: string;
  resultCount: number;
  page: number;
  baseUrl: string;
  unresponsiveEngines?: string[];
};

type FetchLike = (input: URL | string, init?: RequestInit) => Promise<Response>;

type SearxngEndpoint = {
  configured: boolean;
  baseUrl?: string;
  source: string;
};

const searxngSearchTool = defineTool({
  name: "searxng_search",
  label: "SearXNG Search",
  description: "Search the web through a configured self-hosted SearXNG instance. Use for web discovery when SearXNG is configured; if it is unconfigured or unreachable, report that /searxng:setup or SEARXNG_URL is needed. Input supports query, result count, one-indexed page, language, categories, and optional day/month/year freshness. Model-visible output lists ranked titles, URLs, snippets, and engines; internal details record query, resultCount, page, baseUrl, and unresponsive engines. Searches run one at a time (queued FIFO) so concurrent calls cannot outrun SearXNG reactive engine suspension; when a query returns no results while engines are unresponsive (throttled), the next query waits a growing cooldown (2s, 4s, 8s, 16s, capped at 30s), while a clean zero with all engines responding does not back off; falls back from the default `general` category to `web` then `it` when the default category returns no results.",
  promptSnippet: "Discover current web sources with a configured SearXNG query; returns ranked titles, URLs, snippets, and engines for follow-up fetching.",
  promptGuidelines: [
    "searxng_search use: Use searxng_search for current web discovery and source candidates before web_fetch_many; it searches but does not retrieve complete source content.",
    inputJsonSchemaGuideline("searxng_search", SearchParams),
    outputJsonSchemaGuideline("searxng_search", RetainedToolOutputSchemas.searxng_search),
    "searxng_search constraints: Use promising URLs with web_fetch_many for complete retrieval. If SearXNG is unconfigured or unreachable, report the failure and direct the user to /searxng:setup or SEARXNG_URL instead of silently substituting another search path. Only result content is provider-visible; details are internal, and thrown errors use the host's out-of-band error result."
  ],
  parameters: SearchParams,
  executionMode: "parallel",
  renderShell: "self",
  async execute(_toolCallId, params, signal): Promise<AgentToolResult<SearchDetails>> {
    return search(params, signal);
  },
  renderCall(args, theme) {
    return new Text(claudeToolCall("WebSearch", quotePreview(args.query, 72), theme), 0, 0);
  },
  renderResult(result, options, theme, context) {
    if (context?.isError === true) {
      const text = result.content
        .map((item) => item.type === "text" ? item.text : "")
        .join("\n")
        .trim();
      const summary = text.length === 0
        ? "Tool failed."
        : (() => {
            const oneLine = text.replace(/\s+/g, " ").trim();
            return oneLine.length <= 160 ? oneLine : `${oneLine.slice(0, 157)}...`;
          })();
      return new Text(claudeToolResult(`error: ${summary}`, "error", theme), 0, 0);
    }

    if (options.isPartial) {
      return new Text(claudeToolResult("searching", "warning", theme), 0, 0);
    }

    const details = result.details;
    const count = details?.resultCount ?? 0;
    const query = details?.query === undefined ? "" : ` · ${quotePreview(details.query, 48)}`;
    return new Text(claudeToolResult(`${count} result${count === 1 ? "" : "s"}${query}`, count === 0 ? "muted" : "success", theme), 0, 0);
  }
});

export default function searxngSearchExtension(api: ExtensionAPI): void {
  registerCommandWithAliases(
    api,
    "searxng:status",
    {
      description: "Check configured SearXNG service reachability",
      handler: async (args, context) => {
        if (args.trim()) {
          context.ui.notify("Usage: /searxng:status", "warning");
          return;
        }
        const status = await buildSearxngStatusText();
        context.ui.notify(status.text, status.ok ? "info" : "warning");
      }
    },
    []
  );

  registerCommandWithAliases(
    api,
    "searxng:setup",
    {
      description: "Create and optionally start the local SearXNG Docker Compose helper",
      handler: async (args, context) => {
        await handleSearxngSetupCommand(args, context);
      }
    },
    []
  );

  api.registerTool(searxngSearchTool);
}

export type SearxngStatus = {
  ok: boolean;
  text: string;
};

type SearxngFetchOutcome = {
  results: SearxngResult[];
  unresponsiveEngines: string[];
};

// Reduce SearXNG's unresponsive_engines field (pairs of [name, reason], or
// plain names on older versions) to de-duplicated engine names.
function unresponsiveEngineNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = new Set<string>();
  for (const entry of raw) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].length > 0) {
      names.add(entry[0]);
    } else if (typeof entry === "string" && entry.length > 0) {
      names.add(entry);
    }
  }
  return [...names];
}

async function fetchSearxngResults(baseUrl: string, input: SearchInput, category: string, signal?: AbortSignal): Promise<SearxngFetchOutcome> {
  const url = searchUrl(baseUrl);
  url.searchParams.set("q", input.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", String(input.page ?? 1));
  url.searchParams.set("language", input.language ?? "en-US");
  url.searchParams.set("categories", category);
  url.searchParams.set("safesearch", "1");
  if (input.timeRange !== undefined) {
    url.searchParams.set("time_range", input.timeRange);
  }

  const timeoutSignal = AbortSignal.timeout(12000);
  const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetch(url, { headers: searxngHeaders(), signal: requestSignal });
  } catch (error) {
    throwIfAborted(signal);
    throw new Error(`SearXNG search failed for ${baseUrl}: ${errorMessage(error)}. Start the configured local SearXNG service, run /searxng:setup --start, or set SEARXNG_URL to a reachable JSON-enabled instance.`);
  }
  if (!response.ok) {
    throw new Error(`SearXNG search failed for ${baseUrl}: HTTP ${response.status} ${response.statusText}. Check that SearXNG JSON output is enabled and the service is reachable.`);
  }

  let body: SearxngResponse;
  try {
    body = (await response.json()) as SearxngResponse;
  } catch (error) {
    throwIfAborted(signal);
    throw new Error(`SearXNG search failed for ${baseUrl}: invalid JSON response (${errorMessage(error)}).`);
  }

  return {
    results: (body.results ?? []).slice(0, input.results ?? 8),
    unresponsiveEngines: unresponsiveEngineNames(body.unresponsive_engines)
  };
}

export async function search(input: SearchInput, signal?: AbortSignal): Promise<AgentToolResult<SearchDetails>> {
  throwIfAborted(signal);
  // Resolve configuration first so an unconfigured call fails fast without
  // queueing for the search slot.
  const baseUrl = searxngBaseUrl();

  // One search at a time: serializing closes the race where concurrent
  // searches reach an engine before SearXNG records its suspension.
  await waitForSearchSlot(signal);
  try {
    return await runSearch(input, baseUrl, signal);
  } finally {
    releaseSearchSlot();
  }
}

async function runSearch(input: SearchInput, baseUrl: string, signal?: AbortSignal): Promise<AgentToolResult<SearchDetails>> {
  // Tool-call-level cooldown: computed after acquiring the slot, so the
  // streak is deterministic once the previous search has finished.
  const backoffMs = currentBackoffMs();
  if (backoffMs > 0) {
    await abortableDelay(backoffMs, signal);
    throwIfAborted(signal);
  }

  // Category fallback: the default `general` category is frequently throttled
  // (upstream 429 / CAPTCHA on duckduckgo / brave). When `general` (or the
  // default) yields 0 results, fall back through web -> it (recorded
  // decision). The attempts run back-to-back: they target different engine
  // sets, so no artificial spacing is needed.
  const requestedCategory = input.categories ?? "general";
  const categoryChain = requestedCategory === "general" ? ["general", "web", "it"] : [requestedCategory];

  let results: SearxngResult[] = [];
  const unresponsiveEngines = new Set<string>();
  for (const category of categoryChain) {
    const outcome = await fetchSearxngResults(baseUrl, input, category, signal);
    for (const engine of outcome.unresponsiveEngines) {
      unresponsiveEngines.add(engine);
    }
    throwIfAborted(signal);
    if (outcome.results.length > 0) {
      results = outcome.results;
      break;
    }
  }
  const engineList = [...unresponsiveEngines];

  if (results.length === 0) {
    if (engineList.length === 0) {
      // Clean zero: every engine responded and none matched. Nothing to back
      // off from, so the streak resets.
      degradedStreak = 0;
      return {
        content: [{ type: "text", text: `No SearXNG results for: ${input.query} (tried categories: ${categoryChain.join(", ")}). All engines responded with no matches; no backoff applied.` }],
        details: { query: input.query, resultCount: 0, page: input.page ?? 1, baseUrl }
      };
    }
    // Degraded zero: at least one engine was unresponsive, so back off.
    degradedStreak += 1;
    const backoffSeconds = Math.round(currentBackoffMs() / 1000);
    return {
      content: [{ type: "text", text: `No SearXNG results for: ${input.query} (tried categories: ${categoryChain.join(", ")}; unresponsive engines: ${engineList.join(", ")}). Next query waits ${backoffSeconds}s before running (zero-result backoff, doubles per degraded zero, capped at ${MAX_BACKOFF_MS / 1000}s).` }],
      details: { query: input.query, resultCount: 0, page: input.page ?? 1, baseUrl, unresponsiveEngines: engineList }
    };
  }

  degradedStreak = 0;
  const text = results
    .map((result, index) => {
      const title = result.title ?? "(untitled)";
      const urlText = result.url ?? "(no url)";
      const snippet = result.content?.replace(/\s+/g, " ").trim() ?? "";
      const engine = result.engine === undefined ? "" : ` [${result.engine}]`;
      return `${index + 1}. ${title}${engine}\n${urlText}\n${snippet}`;
    })
    .join("\n\n");

  return {
    content: [{ type: "text", text }],
    details: {
      query: input.query,
      resultCount: results.length,
      page: input.page ?? 1,
      baseUrl,
      ...(engineList.length > 0 ? { unresponsiveEngines: engineList } : {})
    }
  };
}

type RenderTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

function claudeToolCall(name: string, summary: string, theme: RenderTheme): string {
  return theme.fg("toolTitle", `⏺ ${theme.bold(name)}(`) + theme.fg("accent", summary) + theme.fg("toolTitle", ")…");
}

function claudeToolResult(summary: string, color: string, theme: RenderTheme): string {
  return theme.fg("muted", "⎿ ") + theme.fg(color, summary);
}

export function searxngBaseUrl(): string {
  const endpoint = readSearxngEndpoint();
  if (!endpoint.baseUrl) {
    throw new Error(searxngUnconfiguredMessage(endpoint));
  }
  return endpoint.baseUrl;
}

export async function buildSearxngStatusText(fetchImpl: FetchLike = fetch): Promise<SearxngStatus> {
  const endpoint = readSearxngEndpoint();
  if (!endpoint.baseUrl) {
    return {
      ok: false,
      text: `SearXNG status\n\nConfigured URL: none\nSource: ${endpoint.source}\nStatus: not configured\nNext step: run /searxng:setup --dry-run, then /searxng:setup --start, or set SEARXNG_URL to a reachable JSON-enabled SearXNG instance before starting Pi.`
    };
  }

  const baseUrl = endpoint.baseUrl;
  let url: URL;
  try {
    url = searchUrl(baseUrl);
  } catch (error) {
    return {
      ok: false,
      text: `SearXNG status\n\nConfigured URL: ${baseUrl}\nSource: ${endpoint.source}\nStatus: invalid URL (${errorMessage(error)})\nNext step: run /searxng:setup or set SEARXNG_URL to a valid HTTP URL.`
    };
  }

  url.searchParams.set("q", "pi-status-check");
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", "1");
  url.searchParams.set("language", "en-US");
  url.searchParams.set("categories", "general");
  url.searchParams.set("safesearch", "1");

  try {
    const response = await fetchImpl(url, {
      headers: searxngHeaders(),
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) {
      return {
        ok: false,
        text: `SearXNG status\n\nConfigured URL: ${baseUrl}\nSource: ${endpoint.source}\nStatus: HTTP ${response.status} ${response.statusText}\nNext step: verify SearXNG is running, JSON output is enabled, and any SEARXNG_API_KEY is correct. If SearXNG is on a non-default port, run /searxng:setup --port <port> or set SEARXNG_URL before starting Pi.`
      };
    }
    const body = (await response.json()) as SearxngResponse;
    const resultCount = body.results?.length ?? 0;
    return {
      ok: true,
      text: `SearXNG status\n\nConfigured URL: ${baseUrl}\nSource: ${endpoint.source}\nStatus: reachable JSON search endpoint\nProbe results returned: ${resultCount}`
    };
  } catch (error) {
    return {
      ok: false,
      text: `SearXNG status\n\nConfigured URL: ${baseUrl}\nSource: ${endpoint.source}\nStatus: unreachable (${errorMessage(error)})\nNext step: start the configured local SearXNG service, run /searxng:setup --start, or set SEARXNG_URL to a reachable JSON-enabled instance before starting Pi.`
    };
  }
}

function readSearxngEndpoint(): SearxngEndpoint {
  const envUrl = process.env.SEARXNG_URL?.trim();
  if (envUrl) {
    return { configured: true, baseUrl: envUrl, source: "env:SEARXNG_URL" };
  }

  const config = readPiToolsJsonConfigSource(SEARXNG_AGENT_CONFIG_FILE, import.meta.url);
  if (!config) {
    return { configured: false, source: "none" };
  }

  const baseUrl = typeof config.data.baseUrl === "string" ? config.data.baseUrl.trim() : "";
  if (!baseUrl) {
    return { configured: false, source: `${config.source}:${formatConfigPath(config.path)}` };
  }

  return {
    configured: true,
    baseUrl,
    source: `${config.source}:${formatConfigPath(config.path)}`
  };
}

function searxngUnconfiguredMessage(endpoint: SearxngEndpoint): string {
  return `SearXNG search is not configured (source: ${endpoint.source}). Run /searxng:setup --dry-run, then /searxng:setup --start, or set SEARXNG_URL to a reachable JSON-enabled SearXNG instance before starting Pi.`;
}

function searchUrl(baseUrl: string): URL {
  return new URL("/search", baseUrl);
}

function searxngHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.SEARXNG_API_KEY !== undefined && process.env.SEARXNG_API_KEY !== "") {
    headers.authorization = `Bearer ${process.env.SEARXNG_API_KEY}`;
  }
  return headers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quotePreview(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  const truncated = oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, Math.max(0, maxLength - 3))}...`;
  return JSON.stringify(truncated);
}
