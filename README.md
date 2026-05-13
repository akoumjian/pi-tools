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

## Documentation

- [`docs/README.md`](docs/README.md) is the index for deep-dive per-extension documentation.
- Each extension has its own file under `docs/extensions/`. Use those when you need exact tool schemas, behaviors, caps, result shapes, or rendering details.
- The sections below in this README are short overviews and pointers; the doc files are the source of truth for details.

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

**Setup.** Run `/safety:setup provider/model[:thinking]` once per machine. Optional `PI_TOOL_SAFETY_APPROVAL_MODEL` / `PI_TOOL_SAFETY_TRUSTED_WORKSPACE` env overrides.

---

### async-shell

[Full docs](docs/extensions/async-shell.md).

**Purpose.** Durable async shell jobs instead of blocking the agent. Each `shell_start` call accepts a list of commands; finished jobs return in-band within a fixed 6 s grace period, and background jobs deliver batched completion notices that resume the agent exactly once per batch.

**Provides.** `shell_start`, `shell_status`, `shell_tail`, `shell_cancel`; `/async:status`; durable per-job logs and metadata under `.pi/async-shell/jobs/<jobId>/`.

**Setup.** None. No polling/wait tool: continue useful work; completion notices will resume the agent.

---

### native-tools

[Full docs](docs/extensions/native-tools.md).

**Purpose.** Replace stock single-file `read`/`grep`/`find`/`write`/`edit` tools with batch-native equivalents. Strict-replacement enforcement removes banned tools and adds required replacements at session start.

**Provides.** `read_many`, `search_many`, `write_many`, `edit_many`; disabled `bash` stub redirecting to `shell_start`; `/native:status`; compact renderers with `⎿ error: …` fallback on validation/exec errors.

**Setup.** None. Automatic on load.

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

**Purpose.** Safe, batched HTTP(S) fetch with caching, readability extraction, and a `document_parse` handoff for non-HTML. Refuses private-network and localhost URLs.

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
