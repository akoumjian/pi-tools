# native-tools

## Purpose

Replace Pi's stock single-file `read` / `grep` / `find` / `write` / `edit` tools with batch-native equivalents and steer the agent to use them. The batch tools dramatically cut tool-call chatter on multi-file workflows and integrate with [`mutation-review`](mutation-review.md) and [`async-shell`](async-shell.md) for the rest of the workflow surface.

The extension also enforces strict replacement: when active, the stock tools are removed from the active tool list and re-enabling them fails loudly. The disabled `bash` tool is left registered as a hard-fail with a message pointing at `shell_start`.

## Provides

LLM-callable tools:

- `read_many({ files: [{ path, offset?, limit? }, ...] })`
- `search_many({ searches: [{ kind, pattern?, path?, glob?, context?, maxResults?, ignoreCase?, literal? }, ...] })`
- `write_many({ writes: [{ path, content }, ...] })`
- `edit_many({ files: [{ path, edits: [{ oldText, newText }, ...] }, ...] })`
- `bash` (disabled stub) — always throws and redirects to `shell_start`.

Command:

- `/native:status` — reports active default tools, replacement state, and any banned stock tools still active.

Side effects:

- Strict-replacement policy enforcement at session start and on each `before_agent_start`. Banned stock tools (`bash`, `read`, `edit`, `write`) are removed and required replacements added; re-enabling a banned tool fails loudly.
- Slim system-prompt steering toward batch-native usage, including search/read distinction, edit/write distinction, async-shell log-path handling, and web/document retrieval workflows.
- Defensive renderers that produce compact `⎿ ...` summaries and a `⎿ error: ...` row on tool errors.

## Tool schemas

### read_many

```ts
read_many({
  files: [
    {
      path: string,                 // relative to active cwd or absolute
      offset?: number,              // 1-indexed line, for continuation
      limit?: number                // max lines from offset
    },
    ...
  ]                                // 1..24 items
})
```

- Use `offset`/`limit` to read precise ranges of large files.
- Omit `limit` to read from `offset` to end of file.
- For huge files, follow the `truncation.nextOffset` in the result to continue.

### search_many

```ts
search_many({
  searches: [
    {
      kind: "content" | "files",     // required
      pattern?: string,                // required when kind="content"
      path?: string,                   // default "."
      glob?: string,                   // rg --glob, e.g. "*.ts", "!dist/**"
      context?: number,                // 0..10, content only, default 0
      maxResults?: number,             // 1..1000, default 100
      ignoreCase?: boolean,            // content only
      literal?: boolean                // content only; rg --fixed-strings
    },
    ...
  ]                                  // 1..24 items
})
```

Backed by the `rg` binary. See the deep-dive in the README and the [example section below](#search_many-examples).

### write_many

```ts
write_many({
  writes: [
    { path: string, content: string },
    ...
  ]                                  // 1..24 items
})
```

- Creates or completely overwrites each file. Parent directories are created.
- Best for new files or wholesale rewrites. For surgical changes, prefer `edit_many`.
- Triggers `mutation-review` (when configured) before writes apply.

### edit_many

```ts
edit_many({
  files: [
    {
      path: string,
      edits: [
        { oldText: string, newText: string },
        ...                          // 1..50 edits per file
      ]
    },
    ...
  ]                                  // 1..24 files
})
```

- Each `oldText` must occur exactly once in the original file and must not overlap another replacement in the same file. Pre-validates before writing.
- Replacements are applied against the original file contents, not after earlier replacements.
- Triggers `mutation-review` (when configured) before edits apply.

## Model-facing steering

The slim prompt removes Pi's default `Available tools`/`Guidelines` prose and injects compact guidance instead:

- Use `search_many` for discovery and `read_many` directly for known paths/ranges.
- Batch independent `search_many`, `read_many`, and `shell_start` work into one call where possible.
- Use `edit_many` for precise existing-file edits and `write_many` for new files or complete overwrites.
- Treat async-shell completion notices as compact status plus log paths; use `shell_tail` for recent output and `search_many`/`read_many` on `stdout_log`/`stderr_log` for older or targeted output.
- Use `searxng_search` → `web_fetch_many` → `read_many`/`document_parse` for online and document research.

## Behavior

### read_many

- Reads each file with line-level pagination, returning the slice and a `truncation` block describing whether the read was capped by lines or bytes plus a `nextOffset` for continuation.
- File-by-file results, no truncation across files.

### search_many

- For each search item, builds an `rg` argv (always `--color never --no-messages`, plus `--glob`, `--ignore-case`, `--fixed-strings`, `--context`, etc. as requested).
- For `kind: "files"` it appends `--files <path>` (no pattern needed).
- For `kind: "content"` it appends `--line-number --column --no-heading <pattern> <path>`.
- Spawns `rg` with the active cwd, captures up to 120 KB of stdout per search; on overflow `rg` is `SIGTERM`'d and the result is marked truncated. Stderr is capped at 16 KB. After completion, the per-search output is further trimmed to `maxResults` lines.
- Exits other than 0 (match) or 1 (no match) throw with the captured stderr.

### write_many / edit_many

- Each file is processed sequentially under `withFileMutationQueue` (a Pi core helper that serializes mutations per file).
- `write_many` writes the new contents and reports byte/line counts.
- `edit_many` runs each replacement on the original file content (snapshot), validates exact-once occurrences and non-overlap, applies them, and reports per-edit line ranges in the diff.
- When `mutation-review` is configured and reviews the call, the result may include a `mutationReview` block describing which mutations were blocked, plus a pending review id. Use `apply_reviewed_mutation` to apply a previously-blocked mutation after acknowledgement.

## Strict replacement

At `session_start` and on each `before_agent_start`, the extension reconciles the active tool list:

- Removes banned stock tools (`bash`, `read`, `edit`, `write`).
- Adds required replacements (`shell_start`/`shell_status`/`shell_tail`/`shell_cancel`, `read_many`, `search_many`, `write_many`, `edit_many`).
- Optionally activates `web_fetch_many` when present.

If a profile or extension re-adds a banned stock tool, strict mode reports the conflict via `/native:status` and a one-shot session warning.

## Result shapes

```ts
// read_many
{
  details: {
    files: [
      {
        path, resolvedPath, offset,
        requestedLimit?,
        truncation: { truncated, truncatedBy: "lines" | "bytes" | null, totalLines, outputLines, totalBytes, outputBytes, nextOffset? },
        previewLines: string[]
      }, ...
    ]
  }
}

// search_many
{
  details: {
    searches: [
      {
        kind, path, resolvedPath, pattern?, glob?,
        context, maxResults, outputLines, truncated,
        exitCode, signal?, previewLines: string[]
      }, ...
    ]
  }
}

// write_many
{
  details: {
    files: [{ id, scopedId?, path, resolvedPath, bytes, lines }, ...],
    mutationReview?: { pendingId, blocked: [{ id, path, kind }], summary }
  }
}

// edit_many
{
  details: {
    files: [{ id, scopedId?, path, resolvedPath, replacements, ranges: [{ startLine, endLine }, ...], bytesBefore, bytesAfter }, ...],
    mutationReview?: { pendingId, blocked: [{ id, path, kind }], summary }
  }
}
```

## TUI rendering

- `⏺ Read(<files>) …` / `⏺ Search(<patterns>) …` / `⏺ Write(<files>) …` / `⏺ Edit(<files>) …` call rows.
- `⎿ Read <span>` / `⎿ <N> matches across <M> searches` / `⎿ Wrote <files>` / `⎿ Updated <files> with N edit(s)` result rows.
- Mutation-review partial blocks render as a separate `skipped <id> blocked by mutation review: <one-line reason>` row.
- All renderers go through a shared error helper that produces `⎿ error: <one-line summary>` on tool failure.

## search_many examples

```ts
// File discovery
search_many({ searches: [
  { kind: "files", path: ".", glob: "*.ts", maxResults: 200 }
] })

// Symbol references
search_many({ searches: [
  { kind: "content", pattern: "evaluateAsyncShellStart", path: "extensions", glob: "*.ts", context: 2, maxResults: 80 }
] })

// Multiple independent searches in one call
search_many({ searches: [
  { kind: "files", path: "extensions", glob: "*.ts" },
  { kind: "content", pattern: "registerCommandWithAliases", path: "extensions", glob: "*.ts", maxResults: 50 },
  { kind: "content", pattern: "renderToolResult", path: "tests", glob: "*.test.ts", maxResults: 50 }
] })
```

## Setup

None. The extension is automatic at load. Run `/native:status` to confirm strict replacement is in effect and required tools are active.

## Notes

- `read_many`, `search_many`, `write_many`, `edit_many` are designed to encourage batching. Pi's prompt steering tells the agent to prefer one call with a list over multiple single-item calls.
- For repository-scale discovery, `search_many` is the right entry point; `read_many` should be reserved for reading specific ranges discovered via search.
- Tests cover schemas, strict replacement, batch behavior, renderers (call/result/error), and integration with `mutation-review` (`tests/native-tools.test.ts`).
