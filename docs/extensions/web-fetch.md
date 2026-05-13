# web-fetch

## Purpose

Safe, batched HTTP(S) fetch with caching, readability extraction, and a handoff to [`document_parse`](tool-display.md) for non-HTML payloads. The tool is designed for online research workflows where you want to fetch a few candidate sources concurrently, get readable Markdown for HTML pages, and save PDFs/Office docs/images for follow-up parsing.

Network safety constraints are built in: the tool refuses non-HTTP(S) schemes, localhost, and private/internal-network addresses before issuing the request.

## Provides

- LLM-callable tool: `web_fetch_many`.
- `/fetch:status` command — reports the cache root, its access state, runtime deps loaded (Readability/JSDOM/Turndown), and the network safety policy.

## Tool schema

```ts
web_fetch_many({
  urls: [
    {
      url: string,                                // HTTP(S); refuses localhost/private networks
      label?: string,                             // short source label for citations
      mode?: "auto" | "html" | "download",        // default "auto"; auto extracts HTML and downloads non-HTML
      maxBytes?: number,                          // 1024..50 MiB, default 10 MiB
      timeoutSeconds?: number                      // 1..120, default 20
    },
    ...
  ],
  concurrency?: number                            // 1..8, default 4
})
```

- `urls.minItems: 1`, `urls.maxItems: 12`.
- `mode: "auto"` classifies the response by Content-Type and content sniffing.
- `mode: "html"` always runs the readability extractor.
- `mode: "download"` always saves the bytes to a file (text/HTML still gets saved as a download, not extracted).

## Behavior

For each URL:

1. **Validate.** Reject non-HTTP(S) URLs, IP literals in private ranges (`10/8`, `172.16/12`, `192.168/16`, IPv6 `fc00::/7`, link-local, loopback), and hostnames that resolve to such addresses. This check runs before fetch.
2. **Fetch with manual redirects.** Follow up to 5 redirects, send `User-Agent: PiWebFetch/0.1` and a permissive Accept header.
3. **Read bytes** under the `maxBytes` cap. Body reads stop and `truncated: true` is recorded when the cap is hit.
4. **Classify response.** Content-Type plus extension sniffing decide `html` vs `text` vs `download`. `mode` can force the classification.
5. **HTML branch.** Parse with JSDOM, extract with `@mozilla/readability`, convert to Markdown with Turndown, save both raw HTML (`source.html`) and extracted Markdown (`extracted.md`) under the cache directory, and return a short preview.
6. **Download branch.** Save raw bytes to the cache directory with a content-derived filename (Content-Disposition → URL basename → fallback by Content-Type). Optionally emit a `documentParseHint` pointing at the saved file when the content type is one `document_parse` can handle (PDF, Office, images, etc.).
7. **Errors** are encoded into the per-URL result with `status: "error"` and a one-line `error` message rather than throwing.

All URL fetches run in parallel up to `concurrency`.

## Result shape

```ts
{
  content: [{ type: "text", text: "<combined per-URL preview/citation block>" }],
  details: {
    cacheRoot: string,                             // ".pi/web-fetch" under the active cwd
    results: [
      {
        url: string,
        label?: string,
        finalUrl?: string,                         // after redirects
        fetchedAt: string,                         // ISO timestamp
        status: "ok" | "error",
        kind?: "html" | "text" | "download",
        httpStatus?: number,
        contentType?: string,
        title?: string,
        description?: string,
        bytes?: number,
        sourcePath?: string,                       // .pi/web-fetch/.../source.html
        textPath?: string,                         // .pi/web-fetch/.../extracted.md
        downloadedPath?: string,                   // for downloads
        documentParseHint?: {                      // for non-HTML when applicable
          tool: "document_parse",
          path: string,
          reason: string
        },
        preview?: string,                           // first ~4 KB / ~80 lines
        truncated?: boolean,
        error?: string
      },
      ...
    ]
  }
}
```

## Cache layout

Under `.pi/web-fetch/<yyyymmddhhmmss>_<index>_<sha-prefix>/`:

- `source.html` for HTML mode
- `extracted.md` for HTML mode
- A single downloaded file with its inferred filename for download mode

Directory creation is recursive. Cache writes fail loudly when permissions or disk space prevent saving.

## TUI rendering

- Call row: `⏺ Fetch(<compact-url-1>, <compact-url-2>, +<N>)…`
- Result row: `⎿ <ok> ok[, <err> error(s)] · <kind-summary>` (success-colored when all OK, error-colored when any failed).
- Error row: `⎿ error: <one-line truncated content>` for catastrophic tool errors (e.g. schema validation).

## Setup

None. The tool uses Node's global `fetch`. No API keys are required.

If you want to verify the cache state, run `/fetch:status`.

## Notes

- For agent workflows, use `searxng_search` first to discover URLs, then `web_fetch_many` for retrieval. After `web_fetch_many` fetches HTML, follow up with `read_many` on `textPath` when the preview is not enough. After `web_fetch_many` fetches PDFs, Office documents, spreadsheets, or images, follow up with `document_parse` on `downloadedPath`.
- The redirect limit and `User-Agent` are intentionally fixed; if you need a custom UA, plumb it through `mode: "download"` plus a `shell_start` `curl` call instead.
- Tests cover URL safety, HTML extraction, redirect handling, and download/document-parse hints (`tests/web-fetch.test.ts`).
