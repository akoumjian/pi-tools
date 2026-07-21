import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";
import { Type, type Static } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { describePathAccess } from "../async-shell/index.js";
import { registerCommandWithAliases } from "../_shared/deprecated-command.js";
import { inputJsonSchemaGuideline } from "../_shared/tool-prompt.js";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 20;
const MAX_TIMEOUT_SECONDS = 120;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const MAX_REDIRECTS = 5;
const PREVIEW_MAX_CHARS = 4000;
const PREVIEW_MAX_LINES = 80;

const FetchUrlItem = Type.Object({
  url: Type.String({
    minLength: 1,
    description: "HTTP or HTTPS URL to fetch. Private-network and localhost URLs are refused by this tool."
  }),
  label: Type.Optional(Type.String({
    description: "Optional short source label for the fetched URL."
  })),
  mode: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("html"),
    Type.Literal("download")
  ], {
    default: "auto",
    description: "Fetch mode. Defaults to auto, which extracts readable HTML when possible and downloads non-HTML; html forces HTML extraction; download saves the response without readability extraction."
  })),
  maxBytes: Type.Optional(Type.Number({
    minimum: 1024,
    maximum: MAX_MAX_BYTES,
    default: DEFAULT_MAX_BYTES,
    description: "Maximum response bytes to read for this URL before failing."
  })),
  timeoutSeconds: Type.Optional(Type.Number({
    minimum: 1,
    maximum: MAX_TIMEOUT_SECONDS,
    default: DEFAULT_TIMEOUT_SECONDS,
    description: "Maximum seconds to spend fetching this URL, including redirects."
  }))
}, { additionalProperties: false });

const WebFetchManyParams = Type.Object({
  urls: Type.Array(FetchUrlItem, {
    minItems: 1,
    maxItems: 12,
    description: "List of URLs to fetch in one call. Use a one-item list for a single URL."
  }),
  concurrency: Type.Optional(Type.Number({
    minimum: 1,
    maximum: MAX_CONCURRENCY,
    default: DEFAULT_CONCURRENCY,
    description: "Maximum number of URLs to fetch concurrently."
  }))
}, { additionalProperties: false });

export type WebFetchManyInput = Static<typeof WebFetchManyParams>;

type FetchModeValue = "auto" | "html" | "download";
type WebFetchKind = "html" | "text" | "download";
type WebFetchStatus = "ok" | "error";
type FetchLike = (input: URL | string, init?: RequestInit) => Promise<Response>;

type DocumentParseHint = {
  tool: "document_parse";
  path: string;
  reason: string;
};

export type WebFetchResultDetails = {
  url: string;
  label?: string;
  finalUrl?: string;
  fetchedAt: string;
  status: WebFetchStatus;
  kind?: WebFetchKind;
  httpStatus?: number;
  contentType?: string;
  title?: string;
  description?: string;
  bytes?: number;
  sourcePath?: string;
  textPath?: string;
  downloadedPath?: string;
  documentParseHint?: DocumentParseHint;
  preview?: string;
  truncated?: boolean;
  error?: string;
};

type WebFetchManyDetails = {
  cacheRoot: string;
  results: WebFetchResultDetails[];
};

type FetchResponse = {
  response: Response;
  finalUrl: URL;
};

type HtmlExtraction = {
  title?: string;
  description?: string;
  markdown: string;
};

export default function webFetchExtension(api: ExtensionAPI): void {
  registerCommandWithAliases(
    api,
    "fetch:status",
    {
      description: "Show web-fetch cache and dependency diagnostics",
      handler: async (_args, context) => {
        context.ui.notify(buildWebFetchStatusText(context), "info");
      }
    },
    []
  );

  api.registerTool(defineTool({
    name: "web_fetch_many",
    label: "Web Fetch Many",
    description: [
      "Fetch and cache web URLs for online research. Always pass urls: [...]; use a one-item list for one URL and multiple items for independent URLs that can be fetched concurrently.",
      "Use searxng_search first to discover candidate URLs, then use web_fetch_many for the promising sources. The tool follows redirects, records final URLs, saves source artifacts under .pi/web-fetch/, and returns citation metadata.",
      "For HTML pages, mode='auto' extracts readable Markdown/text using a readability parser and saves both raw HTML and extracted text. For PDFs, Office files, spreadsheets, images, and other non-HTML files, it saves the file and returns a document_parse handoff hint when appropriate.",
      "Result details shape: { cacheRoot, results: [{ url, finalUrl, status, kind, httpStatus, contentType, title?, sourcePath?, textPath?, downloadedPath?, documentParseHint?, preview?, truncated?, error? }] }.",
      "This tool refuses non-HTTP(S), localhost, and private-network URLs. Use shell_start only when the user explicitly asks for a special network fetch that should go through safety review."
    ].join(" "),
    promptSnippet: "Fetch and cache one or more urls:[...], extracting readable HTML or saving non-HTML files; returns citations, previews, saved paths, and document-parse handoffs.",
    promptGuidelines: [
      "web_fetch_many use: Use searxng_search for discovery, then web_fetch_many for complete retrieval of promising public HTTP(S) sources.",
      inputJsonSchemaGuideline("web_fetch_many", WebFetchManyParams),
      "web_fetch_many output: Schema: { content: text(URL count plus per-result OK/ERROR, url/finalUrl?, label?, HTTP/content metadata, title?, sourcePath?, textPath?/downloadedPath?, document_parse handoff?, error?, preview?, and truncation notice?), details: { cacheRoot, results: [{ url, label?, finalUrl?, fetchedAt, status, kind?, httpStatus?, contentType?, title?, description?, bytes?, sourcePath?, textPath?, downloadedPath?, documentParseHint?: { tool, path, reason }, preview?, truncated?, error? }] }, isError?: boolean }. Only content is provider-visible; read textPath or parse downloadedPath when needed.",
      "web_fetch_many constraints: The tool refuses non-HTTP(S), localhost, and private-network URLs. Use shell_start for a special network fetch only when the user explicitly requests it and safety review permits it."
    ],
    parameters: WebFetchManyParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, context): Promise<AgentToolResult<WebFetchManyDetails>> {
      return webFetchMany(context, params, fetch, signal);
    },
    renderCall(args, theme) {
      return renderWebFetchCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderWebFetchResult(result, options, theme, context);
    }
  }));
}

export async function webFetchMany(
  context: ExtensionContext,
  input: WebFetchManyInput,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal
): Promise<AgentToolResult<WebFetchManyDetails>> {
  const cacheRoot = webFetchCacheRoot(context);
  const concurrency = clampInteger(input.concurrency ?? DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
  const results = await mapLimit(input.urls, concurrency, (item, index) => fetchOne(context, cacheRoot, item, index, fetchImpl, signal));

  return {
    content: [{ type: "text", text: formatWebFetchManyContent(results) }],
    details: {
      cacheRoot,
      results
    }
  };
}

export function buildWebFetchStatusText(context: Pick<ExtensionContext, "cwd">): string {
  const cacheRoot = webFetchCacheRoot(context);
  return [
    "Web fetch status",
    "",
    `Cache root: ${cacheRoot}`,
    `Cache root state: ${describePathAccess(cacheRoot)}`,
    "Runtime dependencies: Readability, JSDOM, and Turndown loaded",
    "Network safety: refuses non-HTTP(S), localhost, and private-network URLs before fetching",
    "Use searxng_search for discovery, then web_fetch_many for public source retrieval."
  ].join("\n");
}

function webFetchCacheRoot(context: Pick<ExtensionContext, "cwd">): string {
  return path.join(path.resolve(context.cwd ?? process.cwd()), ".pi", "web-fetch");
}

async function fetchOne(
  context: ExtensionContext,
  cacheRoot: string,
  item: WebFetchManyInput["urls"][number],
  index: number,
  fetchImpl: FetchLike,
  parentSignal?: AbortSignal
): Promise<WebFetchResultDetails> {
  const fetchedAt = new Date().toISOString();
  try {
    const url = validateFetchUrl(item.url);
    const maxBytes = clampInteger(item.maxBytes ?? DEFAULT_MAX_BYTES, 1024, MAX_MAX_BYTES);
    const timeoutSeconds = clampInteger(item.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 1, MAX_TIMEOUT_SECONDS);
    const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
    const requestSignal = parentSignal === undefined ? timeoutSignal : AbortSignal.any([parentSignal, timeoutSignal]);
    const { response, finalUrl } = await fetchWithRedirects(url, requestSignal, fetchImpl);
    const contentType = normalizeContentType(response.headers.get("content-type"));
    const base: WebFetchResultDetails = {
      url: item.url,
      label: item.label,
      finalUrl: finalUrl.href,
      fetchedAt,
      status: "ok",
      httpStatus: response.status,
      contentType
    };

    if (!response.ok) {
      return await httpErrorResult(base, response, maxBytes);
    }

    const bytes = await readResponseBytes(response, maxBytes);
    const cacheDir = await createCacheDir(cacheRoot, index, item.url);
    const mode = item.mode ?? "auto";
    const effectiveKind = classifyResponse(finalUrl, contentType, bytes, mode);

    if (effectiveKind === "html") {
      return await handleHtmlResponse(context, base, cacheDir, bytes, finalUrl, contentType);
    }

    return await handleDownloadResponse(base, cacheDir, bytes, finalUrl, response.headers, contentType, effectiveKind);
  } catch (error) {
    return {
      url: item.url,
      label: item.label,
      fetchedAt,
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function fetchWithRedirects(url: URL, signal: AbortSignal, fetchImpl: FetchLike): Promise<FetchResponse> {
  let current = url;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(current, {
      redirect: "manual",
      signal,
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/pdf;q=0.7,*/*;q=0.5",
        "user-agent": "PiWebFetch/0.1"
      }
    });

    if (!isRedirectStatus(response.status)) {
      return { response, finalUrl: current };
    }

    const location = response.headers.get("location");
    if (location === null || location.trim() === "") {
      return { response, finalUrl: current };
    }

    current = validateFetchUrl(new URL(location, current).href);
  }

  throw new Error(`Too many redirects after ${MAX_REDIRECTS} redirects.`);
}

async function httpErrorResult(base: WebFetchResultDetails, response: Response, maxBytes: number): Promise<WebFetchResultDetails> {
  let preview = "";
  try {
    const bytes = await readResponseBytes(response, Math.min(maxBytes, 8192));
    preview = decodeBytes(bytes, base.contentType);
  } catch {
    preview = "";
  }

  return {
    ...base,
    status: "error",
    preview: truncateText(preview).preview,
    error: `HTTP ${response.status} ${response.statusText}`.trim()
  };
}

async function handleHtmlResponse(
  context: ExtensionContext,
  base: WebFetchResultDetails,
  cacheDir: string,
  bytes: Uint8Array,
  finalUrl: URL,
  contentType: string | undefined
): Promise<WebFetchResultDetails> {
  const html = decodeBytes(bytes, contentType);
  const sourcePath = path.join(cacheDir, "source.html");
  const textPath = path.join(cacheDir, "extracted.md");
  const extraction = extractReadableHtml(html, finalUrl.href);
  const markdown = buildExtractedMarkdown(extraction, finalUrl.href);
  const preview = truncateText(markdown);

  await writeCacheFile(sourcePath, html, "utf8");
  await writeCacheFile(textPath, markdown, "utf8");

  return {
    ...base,
    kind: "html",
    title: extraction.title,
    description: extraction.description,
    bytes: bytes.byteLength,
    sourcePath,
    textPath,
    preview: preview.preview,
    truncated: preview.truncated
  };
}

async function handleDownloadResponse(
  base: WebFetchResultDetails,
  cacheDir: string,
  bytes: Uint8Array,
  finalUrl: URL,
  headers: Headers,
  contentType: string | undefined,
  kind: WebFetchKind
): Promise<WebFetchResultDetails> {
  const filename = filenameForDownload(finalUrl, headers, contentType, kind);
  const downloadedPath = path.join(cacheDir, filename);
  await writeCacheFile(downloadedPath, bytes);

  if (kind === "text") {
    const text = decodeBytes(bytes, contentType);
    const preview = truncateText(text);
    return {
      ...base,
      kind,
      bytes: bytes.byteLength,
      sourcePath: downloadedPath,
      textPath: downloadedPath,
      downloadedPath,
      preview: preview.preview,
      truncated: preview.truncated
    };
  }

  const documentParseHint = buildDocumentParseHint(downloadedPath, finalUrl, contentType);
  return {
    ...base,
    kind,
    bytes: bytes.byteLength,
    sourcePath: downloadedPath,
    downloadedPath,
    documentParseHint,
    preview: documentParseHint === undefined
      ? `Downloaded ${formatBytes(bytes.byteLength)} to ${downloadedPath}.`
      : `Downloaded ${formatBytes(bytes.byteLength)} to ${downloadedPath}. Use document_parse on this path when content inspection is needed.`,
    truncated: false
  };
}

export function extractReadableHtml(html: string, url: string): HtmlExtraction {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  const fallbackTitle = textOrUndefined(document.querySelector("title")?.textContent);
  const description = textOrUndefined(
    document.querySelector('meta[name="description"]')?.getAttribute("content")
      ?? document.querySelector('meta[property="og:description"]')?.getAttribute("content")
  );
  const reader = new Readability(document);
  const article = reader.parse();
  const title = textOrUndefined(article?.title) ?? fallbackTitle;
  const contentHtml = article?.content ?? document.body?.innerHTML ?? html;
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-"
  });
  turndown.remove(["script", "style", "noscript", "canvas", "iframe"]);
  turndown.remove((node) => node.nodeName.toLowerCase() === "svg");

  return {
    title,
    description,
    markdown: cleanupMarkdown(turndown.turndown(contentHtml))
  };
}

function buildExtractedMarkdown(extraction: HtmlExtraction, finalUrl: string): string {
  return [
    extraction.title === undefined ? undefined : `# ${extraction.title}`,
    `Source: ${finalUrl}`,
    extraction.description === undefined ? undefined : `Description: ${extraction.description}`,
    "",
    extraction.markdown
  ].filter((part): part is string => part !== undefined).join("\n").trim();
}

function classifyResponse(url: URL, contentType: string | undefined, bytes: Uint8Array, mode: FetchModeValue): WebFetchKind {
  if (mode === "download") {
    return isTextLikeContent(contentType, url) ? "text" : "download";
  }

  if (mode === "html") {
    return "html";
  }

  if (isHtmlContent(contentType) || looksLikeHtml(bytes)) {
    return "html";
  }

  if (isTextLikeContent(contentType, url)) {
    return "text";
  }

  return "download";
}

function isHtmlContent(contentType: string | undefined): boolean {
  return contentType !== undefined && /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType);
}

function isTextLikeContent(contentType: string | undefined, url: URL): boolean {
  if (contentType !== undefined && /^(?:text\/|application\/(?:json|xml|rss\+xml|atom\+xml|ld\+json)\b|application\/x-www-form-urlencoded\b)/i.test(contentType)) {
    return true;
  }

  return [".txt", ".md", ".markdown", ".json", ".xml", ".csv", ".tsv", ".rss", ".atom"].includes(path.extname(url.pathname).toLowerCase());
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const prefix = decodeBytes(bytes.slice(0, 512), "text/html").toLowerCase();
  return /<(?:!doctype html|html|head|body|article|main)\b/.test(prefix);
}

function buildDocumentParseHint(downloadedPath: string, finalUrl: URL, contentType: string | undefined): DocumentParseHint | undefined {
  if (!isDocumentParseCandidate(downloadedPath, contentType)) {
    return undefined;
  }

  return {
    tool: "document_parse",
    path: downloadedPath,
    reason: `Downloaded ${(contentType ?? path.extname(finalUrl.pathname).slice(1)) || "document"} content from ${finalUrl.href}.`
  };
}

function isDocumentParseCandidate(filePath: string, contentType: string | undefined): boolean {
  const extension = path.extname(filePath).toLowerCase();
  if ([".pdf", ".doc", ".docx", ".odt", ".rtf", ".ppt", ".pptx", ".odp", ".xls", ".xlsx", ".xlsm", ".ods", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".svg"].includes(extension)) {
    return true;
  }

  return contentType !== undefined && /\b(?:application\/pdf|application\/msword|application\/vnd\.|image\/)/i.test(contentType);
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Response exceeded maxBytes (${maxBytes}).`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validateFetchUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`web_fetch_many only supports http and https URLs: ${rawUrl}`);
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`web_fetch_many refuses URLs with embedded credentials: ${rawUrl}`);
  }

  if (isPrivateOrLocalHostname(parsed.hostname)) {
    throw new Error(`web_fetch_many refuses localhost and private-network URLs: ${rawUrl}`);
  }

  return parsed;
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(normalized);
  }

  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split(".").map((part) => Number.parseInt(part, 10));
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
}

function isPrivateIpv6(ip: string): boolean {
  return ip === "::"
    || ip === "::1"
    || ip.startsWith("fc")
    || ip.startsWith("fd")
    || /^fe[89ab]/.test(ip);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function decodeBytes(bytes: Uint8Array, contentType: string | undefined): string {
  const charset = charsetFromContentType(contentType) ?? "utf-8";
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function charsetFromContentType(contentType: string | undefined): string | undefined {
  return contentType?.match(/charset=([^;]+)/i)?.[1]?.trim().replace(/^"|"$/g, "");
}

function normalizeContentType(contentType: string | null): string | undefined {
  return contentType?.trim().toLowerCase() || undefined;
}

async function createCacheDir(cacheRoot: string, index: number, url: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
  const dir = path.join(cacheRoot, `${timestamp}_${String(index + 1).padStart(2, "0")}_${hash}`);
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw new Error(formatCacheAccessError("create", dir, error));
  }
  return dir;
}

async function writeCacheFile(filePath: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
  try {
    if (encoding === undefined) {
      await writeFile(filePath, data);
      return;
    }

    await writeFile(filePath, data, encoding);
  } catch (error) {
    throw new Error(formatCacheAccessError("write", filePath, error));
  }
}

function formatCacheAccessError(operation: "create" | "write", targetPath: string, error: unknown): string {
  const action = operation === "create" ? "create web_fetch_many cache directory" : "write web_fetch_many cache artifact";
  const reason = error instanceof Error ? error.message : String(error);
  return `Failed to ${action} ${targetPath}: ${reason}. Check .pi/web-fetch permissions and disk space, or run /fetch:status for cache diagnostics.`;
}

function filenameForDownload(url: URL, headers: Headers, contentType: string | undefined, kind: WebFetchKind): string {
  const fromDisposition = filenameFromContentDisposition(headers.get("content-disposition"));
  const fromUrl = safeBasename(decodeURIComponent(path.basename(url.pathname)));
  const fallback = kind === "text" ? "download.txt" : `download${extensionForContentType(contentType) ?? ""}`;
  const name = fromDisposition ?? fromUrl ?? fallback;
  if (path.extname(name) !== "") {
    return name;
  }
  return `${name}${extensionForContentType(contentType) ?? ""}`;
}

function filenameFromContentDisposition(disposition: string | null): string | undefined {
  if (disposition === null) {
    return undefined;
  }

  const encoded = disposition.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)?.[1];
  const plain = disposition.match(/filename\s*=\s*([^;]+)/i)?.[1];
  const raw = encoded ?? plain;
  if (raw === undefined) {
    return undefined;
  }

  try {
    return safeBasename(decodeURIComponent(raw.trim().replace(/^"|"$/g, "")));
  } catch {
    return safeBasename(raw.trim().replace(/^"|"$/g, ""));
  }
}

function safeBasename(value: string): string | undefined {
  const sanitized = value.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  if (sanitized === "" || sanitized === "." || sanitized === "..") {
    return undefined;
  }
  return sanitized.slice(0, 120);
}

function extensionForContentType(contentType: string | undefined): string | undefined {
  if (contentType === undefined) {
    return undefined;
  }

  const mediaType = contentType.split(";", 1)[0].trim();
  return {
    "application/pdf": ".pdf",
    "application/json": ".json",
    "application/xml": ".xml",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "text/tab-separated-values": ".tsv",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/tiff": ".tiff",
    "image/svg+xml": ".svg"
  }[mediaType];
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await run(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function formatWebFetchManyContent(results: WebFetchResultDetails[]): string {
  return [
    `Fetched ${results.length} URL${results.length === 1 ? "" : "s"}.`,
    "",
    results.map(formatWebFetchResultContent).join("\n\n")
  ].join("\n");
}

function formatWebFetchResultContent(result: WebFetchResultDetails, index: number): string {
  const lines = [
    `${index + 1}. ${result.status === "ok" ? "OK" : "ERROR"} ${result.url}`,
    result.finalUrl === undefined || result.finalUrl === result.url ? undefined : `Final URL: ${result.finalUrl}`,
    result.label === undefined ? undefined : `Label: ${result.label}`,
    result.httpStatus === undefined ? undefined : `HTTP status: ${result.httpStatus}`,
    result.contentType === undefined ? undefined : `Content type: ${result.contentType}`,
    result.title === undefined ? undefined : `Title: ${result.title}`,
    result.sourcePath === undefined ? undefined : `Source saved to: ${result.sourcePath}`,
    result.textPath === undefined ? undefined : `Extracted text saved to: ${result.textPath}`,
    result.downloadedPath === undefined ? undefined : `Downloaded file: ${result.downloadedPath}`,
    result.documentParseHint === undefined ? undefined : `Document parse hint: call ${result.documentParseHint.tool} with path ${result.documentParseHint.path}`,
    result.error === undefined ? undefined : `Error: ${result.error}`,
    result.preview === undefined || result.preview === "" ? undefined : `Preview:\n${result.preview}${result.truncated ? "\n[preview truncated; inspect saved path for full content]" : ""}`
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function truncateText(text: string, maxChars = PREVIEW_MAX_CHARS, maxLines = PREVIEW_MAX_LINES): { preview: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  const lineTruncated = lines.length > maxLines;
  let preview = lines.slice(0, maxLines).join("\n");
  const charTruncated = preview.length > maxChars;
  if (charTruncated) {
    preview = preview.slice(0, maxChars);
  }

  return {
    preview: preview.trim(),
    truncated: lineTruncated || charTruncated
  };
}

function cleanupMarkdown(markdown: string): string {
  return markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type RenderTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type RenderOptions = {
  expanded: boolean;
  isPartial?: boolean;
};

function renderWebFetchCall(args: WebFetchManyInput, theme: RenderTheme): Text {
  return new Text(claudeToolCall("Fetch", summarizeItems(args.urls.map((item) => compactUrl(item.url)), 3), theme), 0, 0);
}

type RenderContext = {
  isError?: boolean;
};

function renderToolErrorRow(result: AgentToolResult<unknown>, theme: RenderTheme, context: RenderContext | undefined): Text | undefined {
  if (context?.isError !== true) {
    return undefined;
  }
  const text = result.content
    .map((item) => item.type === "text" ? item.text : "")
    .join("\n")
    .trim();
  const summary = text.length === 0 ? "Tool failed." : truncateOneLineForError(text, 160);
  return new Text(claudeToolResult(`error: ${summary}`, "error", theme), 0, 0);
}

function truncateOneLineForError(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function renderWebFetchResult(result: AgentToolResult<WebFetchManyDetails>, options: RenderOptions, theme: RenderTheme, context?: RenderContext): Text {
  const errorRow = renderToolErrorRow(result, theme, context);
  if (errorRow !== undefined) {
    return errorRow;
  }

  if (options.isPartial) {
    return new Text(claudeToolResult("fetching", "warning", theme), 0, 0);
  }

  const results = result.details?.results ?? [];
  const errors = results.filter((item) => item.status === "error").length;
  const ok = results.length - errors;
  const kinds = summarizeKinds(results);
  const summary = errors === 0
    ? `${ok} ok${kinds}`
    : `${ok} ok, ${errors} error${errors === 1 ? "" : "s"}${kinds}`;
  return new Text(claudeToolResult(summary, errors > 0 ? "error" : "success", theme), 0, 0);
}

function summarizeKinds(results: WebFetchResultDetails[]): string {
  const counts = new Map<string, number>();
  for (const result of results) {
    if (result.status !== "ok" || result.kind === undefined) {
      continue;
    }
    counts.set(result.kind, (counts.get(result.kind) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return "";
  }

  const text = Array.from(counts.entries()).map(([kind, count]) => `${count} ${kind}`).join(", ");
  return ` · ${text}`;
}

function claudeToolCall(name: string, summary: string, theme: RenderTheme): string {
  return theme.fg("toolTitle", `⏺ ${theme.bold(name)}(`) + theme.fg("accent", summary) + theme.fg("toolTitle", ")…");
}

function claudeToolResult(summary: string, color: string, theme: RenderTheme): string {
  return theme.fg("muted", "⎿ ") + theme.fg(color, summary);
}

function summarizeItems(items: string[], limit: number): string {
  const visible = items.slice(0, limit).join(", ");
  const hidden = items.length - Math.min(items.length, limit);
  return hidden > 0 ? `${visible}, +${hidden}` : visible;
}

function compactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return truncateMiddle(`${url.hostname}${url.pathname}`, 70);
  } catch {
    return truncateMiddle(rawUrl, 70);
  }
}

function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const keep = maxLength - 3;
  const start = Math.ceil(keep * 0.55);
  const end = keep - start;
  return `${text.slice(0, start)}...${text.slice(text.length - end)}`;
}
