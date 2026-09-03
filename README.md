# @akoumjian/pi-tools

Reusable extensions for the [Pi coding agent](https://pi.dev/). The package focuses on compact agent-oriented tooling:

- async shell jobs with batched completion notices
- opt-in privacy-safe settled-run terminal notifications
- batch-native text/image file and search tools that replace stock single-file/shell tools
- safety review hooks (rule + model + human) and a mutation-review reviewer
- web research (SearXNG, web fetch with readability + document parse handoff)
- provider-safe resend of the current context after any failure or cancellation via `/retry`, plus bounded automatic retry of outage-class errors Pi core does not classify
- provider-free active-context clipboard snapshots via `/context:copy`
- robust chunked context compaction via `/compacter`
- a `/review` subagent workflow
- bounded reader/planner/writer orchestration with isolated worktrees and deterministic reconciliation
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

## Documentation

- [`docs/README.md`](docs/README.md) is the index for deep-dive per-extension documentation.
- Each extension has its own file under `docs/extensions/`. Use those when you need exact tool schemas, behaviors, caps, result shapes, or rendering details.
- The sections below in this README are short overviews and pointers; the doc files are the source of truth for details.
- Run `npm run review:provider-context` to regenerate sanitized review artifacts under `docs/generated/provider-context-review/`. They show the rendered Pi system prompt, each active tool's description/input schema/snippet/guidelines, an explicit reviewed-or-not-applicable audit for host tool fields, success/progress/error/content/details result contracts, exact OpenAI Codex Responses and Anthropic Messages request payloads captured before network I/O, and provider-visible tool-result content versus internal-only details.
- Every retained tool's system-prompt input and output contracts are complete minified JSON Schema. Input schemas serialize the same authoritative `parameters` objects used for provider declarations; output schemas come from the package's authoritative result-contract map and cover successful results plus Pi's generic runtime error result. Review tests prove both schemas reach the effective prompt, while representative result fixtures validate every output schema. OpenAI preserves input schemas exactly; Pi's Anthropic serializer removes only top-level `additionalProperties` and adds an empty `required` array when needed (nested closure constraints remain). Pi has no provider `outputSchema` field, so output schemas stay in prompt guidance and model-needed values stay in result `content` rather than internal `details`.

## Quick reference

Tools (LLM-callable):

- `shell_start`, `shell_status`, `shell_read`, `shell_cancel` — async shell jobs
- `read_many`, `search_many`, `write_many`, `edit_many` — batch-native file tools (`read_many` delivers UTF-8 text and supported filesystem images)
- `apply_reviewed_mutation` — cheap re-apply of a previously-reviewed edit/write
- `searxng_search` — search through a configured SearXNG instance
- `web_fetch_many` — fetch + cache + readability-extract URLs, hand off non-HTML to `document_parse`
- `document_parse` — parse PDFs, Office files, spreadsheets, images via LiteParse (opt-in display wrapper)
- `orchestrate` — run bounded reader/planner tasks and provider-aware confined writer tasks with explicit fallback/review attempts
- `reconcile` — deterministically fold reviewed `orch/*` branches and ask once before merging into the clean parent

Commands:

- `/scrollback:status`, `/tmux-scrollback:status`
- `/safety:setup`, `/safety:status`, `/safety:model`, `/safety:toggle`
- `/async:status`, `/async:view [job-id] [--stream both|stdout|stderr] [--tail 1..500] [--follow]`
- `/notify [on|off|status|test]`
- `/native:status`
- `/retry`
- `/context:copy [--raw]`
- `/compacter [--model provider/model] [instructions]`, `/compacter status|on|off|toggle`
- `/mutation:setup`, `/mutation:status`, `/mutation:model`, `/mutation:toggle`, `/mutation:apply`
- `/searxng:setup`, `/searxng:status`
- `/fetch:status`
- `/file:open`
- `/themes:preview [theme-name]`
- `/review`, `/review:setup`, `/review:status`, `/review:cancel`, `/review:send-last`
- `/docparser:doctor`
- `/orchestrator:setup`, `/orchestrator:status`

The load order in `package.json#pi.extensions` is intentional: terminal patches first, safety before async shell, completion-notifications after async shell so it can read completion barriers, native batch tools before manual-retry, manual-retry before context-export and compacter so both copied and summarized context use the same retry filtering, and optional display overrides last.

## Extensions

Each extension below documents what it does, what it provides, and how to set it up.

### tui-scrollback

[Full docs](docs/extensions/tui-scrollback.md).

**Purpose.** Preserve terminal scrollback during Pi TUI redraws by patching `ProcessTerminal.write` to strip the clear-scrollback escape sequence (`ESC [3J`).

**Provides.** Idempotent runtime patch; `/scrollback:status` diagnostics. No LLM tools, no setup.

---

### tmux-scrollback

[Full docs](docs/extensions/tmux-scrollback.md).

**Purpose.** Keep Pi output on tmux's main screen and let tmux own scrollback. Strips tmux-incompatible private-mode enables and emits a reset sequence on attach.

**Provides.** Idempotent runtime patch (inactive outside tmux); `/tmux-scrollback:status`. Recommended `tmux` options: `set -g extended-keys on` / `set -g extended-keys-format csi-u`.

---

### tool-safety

[Full docs](docs/extensions/tool-safety.md).

**Purpose.** Rule + model + human review gate for tool calls. Pi-host pre-classification is a routing hint; the loaded policy and configured approval-judge model are the source of truth for the final allow/review/deny.

**Provides.** `tool_call` handler that classifies via heuristics + approval model + human prompt; `/safety:setup`, `/safety:status`, `/safety:model`, `/safety:toggle`; default policy in [`config/tool-safety-policy.md`](config/tool-safety-policy.md).

**Setup.** Run `/safety:setup provider/model[:thinking]` once per machine. Optional `PI_TOOL_SAFETY_APPROVAL_MODEL` / `PI_TOOL_SAFETY_TRUSTED_WORKSPACE` env overrides. `reviewCriteria` defaults to `conservative`; personal profiles may opt into `production-or-unapproved-environment`, which re-evaluates shell actions and auto-allows non-environment actions and clearly non-production environment mutations before model review.

---

### async-shell

[Full docs](docs/extensions/async-shell.md).

**Purpose.** Durable async shell jobs instead of blocking the agent. Each `shell_start` call accepts a list of commands; finished jobs return in-band within a fixed 6 s grace period, and background jobs deliver batched completion notices that resume the agent exactly once per batch.

**Provides.** `shell_start`, `shell_status`, `shell_read`, `shell_cancel`; `/async:status`; and the interactive read-only `/async:view` selector/viewer for live or historical job output. Durable per-job logs and metadata remain under `.pi/async-shell/jobs/<jobId>/`. `shell_start` and completion notices point at `stdout_log`/`stderr_log` without embedding output samples; use `shell_read` tail mode for model inspection, or `/async:view` for provider-free human viewing. The viewer bounds reads to the existing 500-line/120 KB tail limits per stream, strips terminal control sequences for safe rendering, and closes without stopping jobs.

**Setup.** None. No polling/wait tool: continue useful work; completion notices will resume the agent.

---

### completion-notifications

[Full docs](docs/extensions/completion-notifications.md).

**Purpose.** Emit one generic terminal notification after an opted-in interactive run has settled successfully and at least 30 seconds elapsed. The extension makes no provider call, adds no session message, and includes no prompt, path, repository, session, model, or assistant content.

**Provides.** `/notify [on|off|status|test]`. Automatic notifications use `agent_settled`, require a final normal assistant stop, suppress headless/RPC/extension/error/abort/queued paths, and coordinate with related async-shell `notifyOnExit:true` jobs so one toast follows their completion delivery. Detached `notifyOnExit:false` jobs never block or get terminated.

**Setup.** Default off. Run `/notify on` in TUI mode to persist a per-machine opt-in; `/notify off` opts out and `/notify test` checks the detected transport. iTerm2 uses its documented OSC 9 path and requires Settings → Profiles → Terminal → Notification Center alerts; Ghostty/WezTerm/rxvt use OSC 777, Kitty uses OSC 99, and Windows Terminal uses a native toast. tmux, Zellij, Warp, non-TTY, and unknown hosts no-op conservatively without BEL or external fallback.

---

### native-tools

[Full docs](docs/extensions/native-tools.md).

**Purpose.** Replace stock single-file `read`/`grep`/`find`/`write`/`edit` tools with batch-native equivalents. `read_many` preserves text ranges and directly delivers byte-detected JPEG/PNG/GIF/WebP/BMP content to the active vision model; image ranges, unsupported binaries, and non-vision use fail loudly. Strict-replacement enforcement removes banned tools and adds required replacements at session start, while slim prompt guidance steers search-vs-read, edit-vs-write, shell log inspection, and research/document workflows.

**Provides.** `read_many`, `search_many`, `write_many`, `edit_many`; disabled `bash` stub redirecting to `shell_start`; `/native:status`; compact renderers with `⎿ error: …` fallback on validation/exec errors.

**Setup.** None. Automatic on load.

---

### manual-retry

[Full docs](docs/extensions/manual-retry.md).

**Purpose.** Resend the current context to the selected model after any settled failure or cancellation without duplicating user text, so recovery never needs `/tree`. The extension persists a hidden empty marker, filters retry markers, failed/aborted assistants, and their orphaned tool results from provider and compaction context, and starts a fresh normal run only when the persisted session is idle and queue-free. An explicit model switch before `/retry` is honored. After `agent_settled`, errors Pi core does not classify as transient but that are outage symptoms (bare `Not Found`/`Bad Gateway` reason phrases) are retried automatically with 2s/4s/8s backoff, bounded at three consecutive attempts.

**Provides.** `/retry`; bounded automatic retry; provider-context and pre-compaction filtering. Failed attempts and markers remain auditable in durable session history. This is an explicit provider-facing approximation, not Pi core's private unchanged-state retry transaction.

**Setup.** None. Fully restart Pi after installation or update.

---

### context-export

[Full docs](docs/extensions/context-export.md).

**Purpose.** Copy a deterministic, provider-free snapshot of the current active, compaction-aware Pi context directly to the system clipboard without adding a session message or writing a sidecar file.

**Provides.** `/context:copy [--raw]`. The default applies best-effort secret redaction and replaces hidden thinking, image bytes, and opaque signatures with metadata. Raw mode requires confirmation. Both modes include the effective system prompt, active model/thinking setting, active tool contracts, and active messages; neither claims to be an exact provider HTTP request body.

**Setup.** None. Interactive TUI only; uses Pi's cross-platform clipboard support and fails without truncation above 4 MiB.

---

### compacter

[Full docs](docs/extensions/compacter.md).

**Purpose.** Replace Pi's single-shot compaction summarizer with chunked recursive summarization through `session_before_compact`, preserving normal `CompactionEntry` behavior while avoiding over-large summarizer prompts.

**Provides.** `/compacter [--model provider/model] [instructions]` for manual chunked compaction; `/compacter status|on|off|toggle` for the runtime hook. No LLM tools, no default dedicated model.

**Setup.** None. Uses the active model by default; `--model` applies to one manual run only.

---

### mutation-review

[Full docs](docs/extensions/mutation-review.md).

**Purpose.** Pre-write/pre-edit reviewer focused on reuse: block only on cited evidence of duplication, otherwise allow. Caches blocked proposals so the agent can cheaply re-apply via `apply_reviewed_mutation` after addressing feedback.

**Provides.** `apply_reviewed_mutation` tool; `/mutation:setup`, `/mutation:status`, `/mutation:model`, `/mutation:toggle`, `/mutation:apply`; reviewer guidance in [`config/mutation-review-guidance.md`](config/mutation-review-guidance.md).

**Setup.** `/mutation:setup provider/model[:thinking]`. When no reviewer model is configured, the extension stays out of the way and warns once.

---

### searxng-search

[Full docs](docs/extensions/searxng-search.md).

**Purpose.** Web search via an explicitly configured self-hosted SearXNG instance. Public instances are intentionally not the default.

**Provides.** `searxng_search` tool; `/searxng:setup` (writes a local Docker Compose helper with a random secret; only starts containers with `--start`); `/searxng:status`; example env file in [`config/searxng.env.example`](config/searxng.env.example).

**Setup.** Run `/searxng:setup --dry-run` → `/searxng:setup --start`, or set `SEARXNG_URL=https://your.host`. Verify with `/searxng:status`.

---

### web-fetch

[Full docs](docs/extensions/web-fetch.md).

**Purpose.** Safe, batched HTTP(S) fetch with caching, readability extraction, and a `document_parse` handoff for non-HTML. Refuses private-network and localhost URLs. Use after `searxng_search` discovers candidate URLs.

**Provides.** `web_fetch_many` (1–12 URLs, modes `auto`/`html`/`download`, configurable byte/time caps, parallel up to 8); cached artifacts under `.pi/web-fetch/`; `/fetch:status`.

**Setup.** None.

---

### file-open

[Full docs](docs/extensions/file-open.md).

**Purpose.** Picker of recent file references discovered in the current transcript; opens the chosen file in `$VISUAL` / `$EDITOR` / `hx` with same-pane handoff.

**Provides.** `/file:open` command; optional keyboard shortcut via [`config/file-open-settings.json`](config/file-open-settings.json) (off by default to avoid stealing Pi's Ctrl+E).

**Setup.** Export `VISUAL`/`EDITOR` in your shell. Optional: set `"shortcut"` in `file-open-settings.json`.

---

### theme-preview

[Full docs](docs/extensions/theme-preview.md).

**Purpose.** Live Pi theme showcase and selector. Cycle themes with arrow keys, `Enter` to apply, `Esc`/`q` to restore the original.

**Provides.** `/themes:preview [theme-name]` command; renders all 51 Pi color tokens against representative surfaces.

**Setup.** None. Themes are discovered from Pi's theme registry.

---

### review-subagent

[Full docs](docs/extensions/review-subagent.md).

**Purpose.** Tool-using review subagent over recent main-agent context. Runs in its own session with a read-only tool allowlist, produces a structured critique, optionally sends back to the main agent.

**Provides.** `/review`, `/review:setup`, `/review:status`, `/review:cancel`, `/review:send-last`; reviewer guidance in [`config/review-subagent-guidance.md`](config/review-subagent-guidance.md); never modifies files.

**Setup.** Run `/review:setup provider/model[:thinking]` once per machine (typical: a strong reasoning model). Run `/review focus...` to review.

---

### orchestrator

[Full docs](docs/extensions/orchestrator.md).

**Purpose.** Delegate focused readers/planners and confined writers to isolated in-process sessions. Readers use bounded parallelism; writers use bounded provider-aware concurrency while git setup/reconciliation remain serial. Explicit fallback routes, independent reviewer attempts, worktree branches, commits, files, errors, and next actions are returned model-visibly.

**Provides.** `orchestrate`, `reconcile`; `/orchestrator:setup`, `/orchestrator:status`; managed `orch/*` worktrees, distinct-provider review, deterministic fold validation, and a final human merge gate.

**Setup.** Run `/orchestrator:setup --worker provider/model[:thinking] --reviewer other-provider/model[:thinking]` once per machine. `/orchestrator:status` shows routes, concurrency caps, fallback policy, tools, guidance, and validation.

---

### tool-display

[Full docs](docs/extensions/tool-display.md).

**Purpose.** Opt-in display wrapper for `document_parse`. Proxies through to LiteParse and, when enabled, replaces verbose rendering with a compact `Parse(...)` call row and a `⎿ pages · screenshots ...` result row.

**Provides.** `document_parse` tool registration; `/docparser:doctor` for host dependency diagnostics; compact renderers gated by `enableDisplayOverrides` in [`config/tool-display-settings.json`](config/tool-display-settings.json) (default `false`).

**Setup.** Run `/docparser:doctor` for LiteParse host deps. Set `enableDisplayOverrides: true` only if you want the compact rendering.

---

## Configuration

Reusable defaults live under `config/`:

- `tool-safety-settings.json` → `tool-safety-policy.md`
- `mutation-review-settings.json` → `mutation-review-guidance.md`
- `review-subagent-settings.json` → `review-subagent-guidance.md`
- `orchestrator-settings.json`
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
