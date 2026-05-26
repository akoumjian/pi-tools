# pi-tools docs

Deep-dive documentation for each extension shipped by `@akoumjian/pi-tools`. The top-level [`README.md`](../README.md) has a short overview and quick reference; the files here go into purpose, schema, behavior, caps, result shape, rendering, and setup for each extension.

Planning docs:

- [Hunk review workflow](plans/hunk-review-workflow.md) — Hunk-backed side-by-side diff review plan/prototype notes.

Index (extensions load in this order; see `package.json#pi.extensions`):

1. [tui-scrollback](extensions/tui-scrollback.md) — preserve terminal scrollback across Pi redraws.
2. [tmux-scrollback](extensions/tmux-scrollback.md) — tmux-friendly terminal mode handling.
3. [tool-safety](extensions/tool-safety.md) — rule + model + human review gate for tool calls.
4. [async-shell](extensions/async-shell.md) — durable async shell jobs with batched completion notices.
5. [native-tools](extensions/native-tools.md) — batch-native `read_many`, `search_many`, `write_many`, `edit_many` and strict-replacement.
6. [compacter](extensions/compacter.md) — robust chunked replacement for Pi compaction with `/compacter` controls.
7. [mutation-review](extensions/mutation-review.md) — file-mutation reuse reviewer with cached re-apply via `apply_reviewed_mutation`.
8. [hunk-review](extensions/hunk-review.md) — Hunk-backed live diff tracking, agent-opened review windows, repo switching, open/close controls, and follow mode.
9. [searxng-search](extensions/searxng-search.md) — `searxng_search` against a configured self-hosted SearXNG instance.
10. [web-fetch](extensions/web-fetch.md) — `web_fetch_many` for safe HTTP(S) fetch + cache + readability extraction.
11. [file-open](extensions/file-open.md) — `/file:open` picker for recent transcript file references.
12. [theme-preview](extensions/theme-preview.md) — `/themes:preview` live theme showcase.
13. [review-subagent](extensions/review-subagent.md) — `/review` tool-using review subagent workflow.
14. [tool-display](extensions/tool-display.md) — opt-in display wrapper for `document_parse`.

## Conventions used in these docs

Each extension doc follows the same outline:

- **Purpose** — what problem the extension solves.
- **Provides** — tools, commands, shortcuts, and side effects (event hooks, runtime patches).
- **Tool schemas** — explicit parameter shapes for any LLM-callable tools, with caps and defaults.
- **Behavior** — step-by-step description of what happens when the tool/command runs.
- **Result shape** — `details` payload returned to the LLM (and used by renderers).
- **TUI rendering** — call/result row format and error handling.
- **Setup** — commands, env vars, files, prerequisites.
- **Notes / gotchas** — anything non-obvious worth knowing.

Profile-specific assets (personal `AGENTS.md`, auth, model defaults, themes) live outside this package; see [the public package boundary section in the top-level README](../README.md#public-package-boundary).
