# searxng-search

## Purpose

Give the agent web search through an explicitly configured self-hosted [SearXNG](https://docs.searxng.org/) instance. Public instances are intentionally not the default: SearXNG public-endpoint usage policies vary, and agents fetching automatically should run their own instance. The extension ships a `/searxng:setup` helper that writes a local Docker Compose helper under `~/.pi/agent/services/searxng/` with a random secret and only starts Docker when you ask for it.

## Provides

- LLM-callable tool: `searxng_search`.
- Commands:
  - `/searxng:setup [--dry-run] [--start] [--force] [--dir <path>] [--port <1-65535>]`
  - `/searxng:status`
- Example env file: [`config/searxng.env.example`](../../config/searxng.env.example).

## Tool schema

```ts
searxng_search({
  query: string,
  results?: number,                  // 1..20, default 8; maximum returned results
  page?: number,                     // >= 1, default 1; one-indexed page
  language?: string,                 // default "en-US"; SearXNG language/locale
  categories?: string,               // default "general"; e.g. general, news, science, it
  timeRange?: "day" | "month" | "year" // optional freshness filter
})
```

## Behavior

1. Endpoint resolution order:
   1. `SEARXNG_URL` environment variable.
   2. `~/.pi/agent/extensions/akoumjian-tools/searxng-settings.json` (written by `/searxng:setup`).
   3. Unconfigured → the tool throws an actionable error that points at `/searxng:setup` and `SEARXNG_URL`.
2. Builds `${baseUrl}/search?q=...&format=json&pageno=...&language=...&categories=...&safesearch=1[&time_range=...]`.
3. Sends `Accept: application/json`. If `SEARXNG_API_KEY` is set in the environment, also sends `Authorization: Bearer ${SEARXNG_API_KEY}`.
4. Honors the agent's `AbortSignal` and a hard 12-second request timeout (via `AbortSignal.any([signal, timeout])`).
5. Truncates results to `results` (default 8) and returns each entry's `title`, `url`, snippet, and `engine` tag.

## Result shape

```ts
{
  content: [{ type: "text", text: "1. ...\n2. ..." }],
  details: {
    query: string,
    resultCount: number,
    page: number,
    baseUrl: string
  }
}
```

## TUI rendering

- Call row: `⏺ Search("<truncated-query>")…`
- Result row: `⎿ <count> results · "<truncated-query>"`, success-colored when results > 0, muted when 0.
- Error row (since the recent renderer hardening): `⎿ error: <one-line truncated content>`.

## /searxng:setup behavior

Writes three files under `~/.pi/agent/services/searxng/` (or `--dir <path>`):

- `compose.yaml` — a `searxng` service bound to `127.0.0.1:${SEARXNG_PORT:-8080}` plus a `valkey` Redis backend, with explicit named volumes for cache and Redis state. Reads `SEARXNG_BASE_URL` and `SEARXNG_SECRET` from `.env`.
- `settings.yml` — SearXNG settings with a random 64-hex-character `secret_key`, `formats: [html, json]`, `safe_search: 1`, `autocomplete: ""`, no plugins enabled.
- `.env` — `SEARXNG_PORT`, `SEARXNG_BASE_URL`, and the secret in plain text. Local-only; do not commit.

Extra behavior:

- Without `--start`, only files are written.
- `--dry-run` reports what would change without writing anything.
- `--force` overwrites existing files after backing them up with a timestamp suffix (`.bak-YYYY-MM-DDTHH-MM-SS-MSZ`).
- `--port` accepts 1..65535 and updates `compose.yaml`/`.env` consistently.
- If `docker` or `docker compose` is missing, `--start` is skipped with a remediation message; setup still writes the files.
- On success, the setup writes a per-machine marker at `~/.pi/agent/extensions/akoumjian-tools/searxng-settings.json` so the `searxng_search` tool can detect a configured endpoint.

## /searxng:status behavior

Probes the resolved endpoint with `${baseUrl}/search?q=pi-status-check&format=json...` under a 3-second timeout. Reports:

- Configured URL and source.
- HTTP status or unreachability reason.
- The number of results returned by the probe.
- A concrete remediation step (`/searxng:setup --start` / `SEARXNG_URL=...`).

## Setup

Pick one:

- Run `/searxng:setup --dry-run`, then `/searxng:setup --start` to get a local Docker Compose stack.
- Or set `SEARXNG_URL=https://your.searxng.host` in your shell (and `SEARXNG_API_KEY=...` if needed) and restart Pi.

Verify with `/searxng:status`. Once `Status: reachable JSON search endpoint` is reported, `searxng_search` is usable. Models should use it for web discovery, then pass promising URLs to [`web_fetch_many`](web-fetch.md) for full retrieval workflows. If the endpoint is unconfigured or unreachable, report that `/searxng:setup` or `SEARXNG_URL` is needed rather than guessing results.

## Notes

- Do not point the agent at public SearXNG instances unless you have explicit permission; many limit automated traffic.
- The local helper binds to `127.0.0.1` only. If you intentionally need a remote bind, edit `compose.yaml` after running setup and re-run with `--force` only when you are ready to overwrite.
- Tests cover endpoint resolution, status diagnostics, and compact renderers (`tests/searxng-search.test.ts`).
