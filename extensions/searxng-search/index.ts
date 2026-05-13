import { Type, type Static } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatConfigPath, readPiToolsJsonConfigSource } from "../_shared/config.js";
import { registerCommandWithAliases } from "../_shared/deprecated-command.js";
import { handleSearxngSetupCommand, SEARXNG_AGENT_CONFIG_FILE } from "./setup.js";

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
});

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
};

type SearchDetails = {
  query: string;
  resultCount: number;
  page: number;
  baseUrl: string;
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
  description: "Search the web through a configured self-hosted SearXNG instance. Use for web discovery when SearXNG is configured; if it is unconfigured or unreachable, report that /searxng:setup or SEARXNG_URL is needed.",
  promptSnippet: "Search the configured SearXNG instance for web discovery.",
  promptGuidelines: [
    "Use searxng_search for web discovery before web_fetch_many when the user needs current online information or source candidates."
  ],
  parameters: SearchParams,
  executionMode: "parallel",
  renderShell: "self",
  async execute(_toolCallId, params, signal): Promise<AgentToolResult<SearchDetails>> {
    return search(params, signal);
  },
  renderCall(args, theme) {
    return new Text(claudeToolCall("Search", quotePreview(args.query, 72), theme), 0, 0);
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

async function search(input: SearchInput, signal?: AbortSignal): Promise<AgentToolResult<SearchDetails>> {
  const baseUrl = searxngBaseUrl();

  const url = searchUrl(baseUrl);
  url.searchParams.set("q", input.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", String(input.page ?? 1));
  url.searchParams.set("language", input.language ?? "en-US");
  url.searchParams.set("categories", input.categories ?? "general");
  url.searchParams.set("safesearch", "1");
  if (input.timeRange !== undefined) {
    url.searchParams.set("time_range", input.timeRange);
  }

  const headers: Record<string, string> = {
    accept: "application/json"
  };
  if (process.env.SEARXNG_API_KEY !== undefined && process.env.SEARXNG_API_KEY !== "") {
    headers.authorization = `Bearer ${process.env.SEARXNG_API_KEY}`;
  }

  const timeoutSignal = AbortSignal.timeout(12000);
  const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: requestSignal
    });
  } catch (error) {
    throw new Error(`SearXNG search failed for ${baseUrl}: ${errorMessage(error)}. Start the configured local SearXNG service, run /searxng:setup --start, or set SEARXNG_URL to a reachable JSON-enabled instance.`);
  }

  if (!response.ok) {
    throw new Error(`SearXNG search failed for ${baseUrl}: HTTP ${response.status} ${response.statusText}. Check that SearXNG JSON output is enabled and the service is reachable.`);
  }

  const body = (await response.json()) as SearxngResponse;
  const results = (body.results ?? []).slice(0, input.results ?? 8);
  if (results.length === 0) {
    return {
      content: [{ type: "text", text: `No SearXNG results for: ${input.query}` }],
      details: {
        query: input.query,
        resultCount: 0,
        page: input.page ?? 1,
        baseUrl
      }
    };
  }

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
      baseUrl
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
