# @akoumjian/pi-tools

Reusable extensions for the [Pi coding agent](https://pi.dev/). The package focuses on compact agent-oriented tooling:

- async shell jobs with batched completion notices
- batch-native file and search tools that replace stock single-file/shell tools
- safety review hooks (rule + model + human) and a mutation-review reviewer
- web research (SearXNG, web fetch with readability + document parse handoff)
- a `/review` subagent workflow
- TUI niceties: tmux/scrollback compatibility, theme preview, compact tool renderers, file-reference picker

Profile-specific assets (personal AGENTS context, auth, model defaults, themes) live in a separate consumer package or local Pi profile, not in this repository.

## Install

From a git URL:

```bash
pi install git:https://github.com/akoumjian/pi-tools.git
```

From a local checkout:

```bash
git clone https://github.com/akoumjian/pi-tools.git
cd pi-tools
npm install
npm run validate
```

Fully restart Pi after installing or updating the package so the new extension code is loaded.

### Update an installed git dependency

For consumers that already lock the package via a git URL (e.g. `"@akoumjian/pi-tools": "git+ssh://git@github.com/akoumjian/pi-tools.git"`), use:

```bash
npm update @akoumjian/pi-tools
```

Do not use `npm install @akoumjian/pi-tools@<git+ssh url>`: that form rewrites `package.json` to the `github:owner/repo` shorthand and breaks namespace-form conventions. `npm update` re-resolves the existing git ref to the latest commit and updates only `package-lock.json`.

## Quick reference

Tools (LLM-callable):

- `shell_start`, `shell_status`, `shell_tail`, `shell_cancel` — async shell jobs
- `read_many`, `search_many`, `write_many`, `edit_many` — batch-native file tools
- `apply_reviewed_mutation` — cheap re-apply of a previously-reviewed edit/write
- `searxng_search` — search through a configured SearXNG instance
- `web_fetch_many` — fetch + cache + readability-extract URLs, hand off non-HTML to `document_parse`
- `document_parse` — parse PDFs, Office files, spreadsheets, images via LiteParse (opt-in display wrapper)

Commands:

- `/scrollback:status`, `/tmux-scrollback:status`
- `/safety:setup`, `/safety:status`, `/safety:model`, `/safety:toggle`
- `/async:status`
- `/native:status`
- `/mutation:setup`, `/mutation:status`, `/mutation:model`, `/mutation:toggle`, `/mutation:apply`
- `/searxng:setup`, `/searxng:status`
- `/fetch:status`
- `/file:open`
- `/themes:preview [theme-name]`
- `/review`, `/review:setup`, `/review:status`, `/review:cancel`, `/review:send-last`
- `/docparser:doctor`

The load order in `package.json#pi.extensions` is intentional: terminal patches first, safety before async shell, native batch tools before mutation-review, optional display overrides last.

## Extensions

Each extension below documents what it does, what it provides, and how to set it up.

### tui-scrollback

**Purpose.** Preserve terminal scrollback during Pi TUI redraws by patching `ProcessTerminal.write` to strip the clear-scrollback escape sequence (`ESC [3J`). Without it, every full redraw can erase your prior terminal output.

**Provides.**
- Idempotent runtime patch installed at extension load.
- `/scrollback:status` to show whether the patch is active and how many sequences have been stripped.

**Setup.** None. Loads first so the patch applies before any redraws.

---

### tmux-scrollback

**Purpose.** Keep Pi output on tmux's main screen and let tmux own scrollback and copy mode. Pi's default TUI behavior conflicts with several tmux private modes (alternate screen, mouse tracking variants); this extension strips those enables and emits a reset sequence on attach.

**Provides.**
- Idempotent runtime patch installed at extension load. Inactive when `TMUX` is not set.
- `/tmux-scrollback:status` for diagnostics.

**Setup.** None. Recommended tmux options for best results:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

Pi will warn on startup if these are not set.

---

### tool-safety

**Purpose.** Optional model + human review gate for tool calls. Pi-host pre-classification is a routing hint; the loaded policy and the configured approval model are the source of truth for the final allow/review/deny decision.

**Provides.**
- `tool_call` event handler that classifies actions as `allow` / `review` / `deny` using:
  1. Built-in heuristics for credentials, shared infrastructure, history rewrites, etc.
  2. A configurable approval-judge model (`approvalModel`) for ambiguous cases.
  3. Human review prompts when policy or the approval model says `review`.
- Commands:
  - `/safety:setup provider/model[:thinking]` — persist the approval judge model for this machine/profile.
  - `/safety:status` — show the current policy file, approval model, and runtime overrides.
  - `/safety:model provider/model[:thinking] | reset` — override the approval model for this session.
  - `/safety:toggle [on|off]` — enable/disable runtime enforcement (the policy and approval judge still load, but no review/deny is applied).
- Default policy text in [`config/tool-safety-policy.md`](config/tool-safety-policy.md).

**Setup.**

1. Pick a model that can act as the approval judge (reasoning-friendly, cheap, fast). Run:
   ```text
   /safety:setup provider/model[:thinking]
   ```
   This writes the chosen model into your Pi profile's tool-safety settings.
2. Optional environment overrides:
   - `PI_TOOL_SAFETY_APPROVAL_MODEL=provider/model[:thinking]`
   - `PI_TOOL_SAFETY_TRUSTED_WORKSPACE=/path/to/repo` (treats this path as the active workspace for routing decisions).
3. Run `/safety:status` after restart to confirm the policy file, approval model, and trusted workspace are correct.

The package default policy is in [`config/tool-safety-policy.md`](config/tool-safety-policy.md). Override it by placing your own `tool-safety-settings.json` + `tool-safety-policy.md` in a higher-priority config directory (see [Configuration](#configuration)).

---

### async-shell

**Purpose.** Run shell commands as durable async jobs instead of blocking the agent. Each `shell_start` call accepts a list of commands; the call returns within a fixed 6-second in-band grace period, and any unfinished jobs continue in the background and deliver compact completion notices.

**Provides.**
- Tools:
  - `shell_start({ commands: [{ command, cwd, job_name?, shell?, notifyOnExit? }, ...], tailLines? })`
  - `shell_status({ jobId? })`
  - `shell_tail({ jobId, stream?, lines?, maxChars? })`
  - `shell_cancel({ jobId, signal? })`
- Durable per-job logs and metadata under `.pi/async-shell/jobs/<jobId>/`.
- Batched completion notices: multiple ready completions are coalesced (~100 ms debounce) and delivered as one custom message that triggers exactly one assistant turn.
- `/async:status` for storage and recent-job diagnostics.

**Setup.** None required. There is no polling or wait tool: continue useful work while jobs run, and rely on completion notices to resume.

Key behaviors:
- `shell_start` is the preferred shell surface. Independent commands should be grouped in one call.
- `notifyOnExit: false` suppresses the completion notice for that command.
- `shell_tail` / `shell_status` are for inspection after a notice, not for polling.

---

### native-tools

**Purpose.** Replace Pi's stock single-file `read`, `grep`/`find`, `write`, `edit` tools with batch-native equivalents and steer the agent toward them. This dramatically reduces tool-call chatter for multi-file workflows.

**Provides.**
- `read_many({ files: [{ path, offset?, limit? }, ...] })`
- `search_many({ searches: [{ kind, pattern?, path?, glob?, context?, maxResults?, ignoreCase?, literal? }, ...] })`
- `write_many({ writes: [{ path, content }, ...] })`
- `edit_many({ files: [{ path, edits: [{ oldText, newText }, ...] }, ...] })`
- Strict-replacement enforcement: when active, the stock `read`/`grep`/`find`/`write`/`edit` tools are disabled and re-enabling them fails loudly.
- Compact, defensive renderers that show one-line summaries instead of dumping raw output, including a `⎿ error: ...` row when arguments fail validation.
- `/native:status` to show which native tools are loaded and which stock tools were replaced.

**Setup.** None. The replacement is automatic on load. To inspect, run `/native:status`.

---

### mutation-review

**Purpose.** Optional reviewer that inspects pending file mutations (`write_many`, `edit_many`, and stock `write`/`edit`) for reuse opportunities and obvious problems before they apply. Blocks the call with concrete guidance when it has cited evidence; allows otherwise. Caches the original mutation so the agent can cheaply re-apply it via `apply_reviewed_mutation` after addressing the feedback.

**Provides.**
- Pre-tool-call review using a configured reviewer model.
- `apply_reviewed_mutation({ id })` tool to re-apply the cached original after acknowledgement.
- Commands:
  - `/mutation:setup provider/model[:thinking]`
  - `/mutation:status`
  - `/mutation:model provider/model[:thinking] | reset`
  - `/mutation:toggle [on|off]`
  - `/mutation:apply <id>` (manual re-apply path)
- Reviewer guidance: [`config/mutation-review-guidance.md`](config/mutation-review-guidance.md).
- Tunable transcript/diff caps and reviewer tool allowlist in [`config/mutation-review-settings.json`](config/mutation-review-settings.json) (defaults: `search_many`, `read_many`; reviewedTools: `edit_many`, `write_many`, `edit`, `write`).

**Setup.**

1. Run `/mutation:setup provider/model[:thinking]` to persist the reviewer model.
2. `/mutation:status` shows the active reviewer, guidance source, tool allowlist, and runtime state.
3. To disable temporarily: `/mutation:toggle off`.

Reviewer defaults are conservative: block only on cited reuse/correctness evidence, otherwise allow.

---

### searxng-search

**Purpose.** Web search via an explicitly configured self-hosted SearXNG instance. Public instances are not recommended for agent use.

**Provides.**
- Tool: `searxng_search({ query, results?, page?, language?, categories?, timeRange? })`.
- Commands:
  - `/searxng:setup` — create and optionally start a local SearXNG Docker Compose helper. Supports flags such as `--port`, `--start`, `--dry-run`.
  - `/searxng:status` — probe configured endpoint reachability and JSON output.
- Example env file: [`config/searxng.env.example`](config/searxng.env.example).

**Setup.**

1. Either run `/searxng:setup --dry-run` then `/searxng:setup --start` for a Docker-Compose helper, or set `SEARXNG_URL=https://your.searxng.host` to point at an existing instance. Optional `SEARXNG_API_KEY` for protected deployments.
2. Verify with `/searxng:status` — it must report `Status: ok` and a reachable JSON endpoint.
3. Pi must be (re)started after changing environment variables.

---

### web-fetch

**Purpose.** Safe, batched HTTP(S) fetch with caching, readability extraction, and a handoff hint to `document_parse` for non-HTML payloads. Refuses private-network and localhost URLs.

**Provides.**
- Tool: `web_fetch_many({ urls: [{ url, label?, mode?, maxBytes?, timeoutSeconds? }, ...], concurrency? })`. `mode` is `auto`, `html`, or `download`.
- Cached artifacts under `.pi/web-fetch/`. HTML pages produce both raw source and readability-extracted Markdown/text.
- `documentParseHint` on the result when the content type is best handled by `document_parse`.
- `/fetch:status` for cache and dependency diagnostics.

**Setup.** None. Reads built-in `fetch`; no API key required.

---

### file-open

**Purpose.** Picker that lists recent file references discovered in the current chat/tool-result transcript and opens the chosen file in your terminal editor with same-pane handoff.

**Provides.**
- `/file:open` command. Opens with `$VISUAL`, then `$EDITOR`, then `hx`.
- Optional keyboard shortcut via [`config/file-open-settings.json`](config/file-open-settings.json) (`"shortcut": "ctrl+e"` or similar). Default is no shortcut to avoid stealing Pi's default Ctrl+E binding.

**Setup.**

1. Export an editor in your shell, e.g. add to `~/.zshrc`:
   ```bash
   export VISUAL="hx"
   export EDITOR="hx"
   ```
   Re-source or restart your shell.
2. (Optional) Set `"shortcut"` in `file-open-settings.json` to bind a key.

---

### theme-preview

**Purpose.** Live theme showcase and selector inside Pi's TUI. Lets you preview each registered theme's tool/result/markdown/code rendering and either apply it or revert.

**Provides.**
- `/themes:preview [theme-name]` command. Arrow keys to cycle; `Enter` to apply; `Esc` to cancel.
- Renders all 51 Pi color tokens against representative surfaces (markdown, code, tool calls/results, error/success rows, hidden-thinking labels, etc.).

**Setup.** None. Themes are discovered from Pi's theme registry; vendored themes are not included in this package.

---

### review-subagent

**Purpose.** Spawn an in-process tool-using review subagent over recent main-agent context. The reviewer runs its own session with a restricted read-only tool allowlist, produces a critique, and optionally sends it back to the main agent.

**Provides.**
- Commands:
  - `/review [--model provider/model[:thinking]] [--send|--no-send] [focus]`
  - `/review:setup provider/model[:thinking]`
  - `/review:status`
  - `/review:cancel`
  - `/review:send-last`
- Default reviewer tool allowlist: `search_many`, `read_many`, `searxng_search`, `web_fetch_many`, `document_parse`, `shell_start`, `shell_status`, `shell_tail`, `shell_cancel`. Configured in [`config/review-subagent-settings.json`](config/review-subagent-settings.json).
- Reviewer guidance: [`config/review-subagent-guidance.md`](config/review-subagent-guidance.md).
- Background-safe: the critique renders as a custom message; if the main agent is still active, display is deferred until it goes idle.

**Setup.**

1. Run `/review:setup provider/model[:thinking]` to persist the reviewer model (typical choice: a strong reasoning model).
2. `/review:status` shows the active reviewer, guidance source, tool allowlist, and any in-flight run.
3. Run `/review focus text...` to start a review; pass `--send` to auto-send the critique back to the main agent without confirmation.

The reviewer never calls write/edit tools, never installs dependencies, and only runs shell for read-only inspection/validation commands.

---

### tool-display

**Purpose.** Optional opt-in display wrapper for `document_parse` (and any future bundled tool wrappers). Provides a compact `Parse(...)` call row, a single-line success/error result, and proxies through to LiteParse's tool implementation.

**Provides.**
- Tool: `document_parse({ path, format?, targetPages?, screenshotPages?, ocr?, ocrLanguage?, ocrLanguages?, ocrServerUrl?, numWorkers?, maxPages?, dpi?, preciseBoundingBox?, preserveSmallText?, preserveLayoutAlignmentAcrossPages? })`.
- `/docparser:doctor` command (registered unconditionally) for diagnosing missing host parser dependencies.
- Custom renderers are off by default. Toggle in [`config/tool-display-settings.json`](config/tool-display-settings.json):
  ```json
  { "enableDisplayOverrides": true }
  ```

**Setup.**

1. Run `/docparser:doctor` if you intend to parse PDFs/Office files/images. It checks for system dependencies (e.g. Tesseract, libreoffice/soffice, image tools).
2. Set `enableDisplayOverrides` to `true` only if you want the compact `Parse(...)` rendering; otherwise the wrapper is transparent and Pi's default rendering applies.

---

## Configuration

Reusable defaults live under `config/`:

- `tool-safety-settings.json` → `tool-safety-policy.md`
- `mutation-review-settings.json` → `mutation-review-guidance.md`
- `review-subagent-settings.json` → `review-subagent-guidance.md`
- `tool-display-settings.json`
- `file-open-settings.json`
- `searxng.env.example`

These defaults intentionally do not include personal provider/model choices, trusted workspace roots, auth files, themes, or global profile settings.

Config lookup order, highest priority first:

1. `PI_TOOLS_CONFIG_DIR` (explicit override)
2. An enclosing Pi profile's `config/pi-tools/` directory
3. Package defaults under `config/`
4. The current working directory's `config/` directory (project-local experiments)

Environment overrides for individual values:

- `PI_TOOL_SAFETY_APPROVAL_MODEL` — overrides the configured approval model.
- `PI_TOOL_SAFETY_TRUSTED_WORKSPACE` — treats a path as the active trusted workspace.
- `SEARXNG_URL`, `SEARXNG_API_KEY` — explicit SearXNG endpoint.
- `VISUAL`, `EDITOR` — used by `/file:open` for editor handoff.

Model-backed features are opt-in and per-machine: nothing here automatically chooses a provider for you. Run the `*:setup` commands once per machine/profile to pick local/default models.

## Public package boundary

Keep this repository reusable and profile-neutral. Do not add:

- personal `AGENTS.md` or `CLAUDE.md` context
- auth files, tokens, local service secrets, or real `.env` files
- personal model/provider defaults
- trusted workspace paths
- private project fixtures or customer/internal code snippets
- vendored personal themes or machine-specific settings templates

Profile-specific assets belong in a separate private Pi profile package or local Pi configuration.

## Development

```bash
npm install
npm run validate        # tsc --noEmit + tests + git diff --check
npm run check           # tsc --noEmit only
npm test                # node --test on the compiled test build
npm run dev:pi:reset    # create or recreate .pi/dev-agent/ with a minimal seed
npm run dev:pi:status   # show isolated dev-agent settings
npm run dev:pi -- --no-session -p '/native:status'
```

`npm run dev:pi` runs Pi with `PI_CODING_AGENT_DIR=$PWD/.pi/dev-agent`, so experiments, sessions, auth, and setup-command writes do not touch your normal `~/.pi/agent` profile. Copy auth into `.pi/dev-agent/auth.json` only when real model calls are needed for a smoke test.

## Release checklist

Before changing repository visibility or publishing elsewhere:

1. Run `npm run validate`.
2. Run a tracked-source scan for private paths, profile assets, credentials, and internal project names.
3. Check `npm pack --dry-run --json` to confirm only intended files ship (currently 30 entries; LICENSE included; tests/eval excluded).
4. Confirm a license is in place (this package is MIT).
5. If prior private history contains sensitive/internal material, publish from a clean history or explicitly rewrite history before making the repository public.
