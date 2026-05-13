# @akoumjian/pi-tools

Reusable extensions for the [Pi coding agent](https://pi.dev/). The package focuses on compact agent-oriented tooling: async shell jobs, batch-native file tools, safety review hooks, web research helpers, review workflows, and TUI display improvements.

## What is included

`package.json#pi.extensions` defines the load order:

- `tui-scrollback` — strips terminal clear-scrollback escapes during Pi TUI redraws.
- `tmux-scrollback` — keeps Pi output on tmux's main screen and lets tmux own scrollback/copy mode.
- `tool-safety` — optional model/human review for risky tool calls.
- `async-shell` — async-first shell tools: `shell_start`, `shell_status`, `shell_tail`, and `shell_cancel`.
- `native-tools` — batch-native `search_many`, `read_many`, `write_many`, and `edit_many`, plus strict replacement of stock single-file/shell tools.
- `mutation-review` — optional pre-write/pre-edit reviewer with cached apply support through `apply_reviewed_mutation`.
- `searxng-search` — `searxng_search` for explicitly configured self-hosted SearXNG instances.
- `web-fetch` — `web_fetch_many` for safe HTTP(S) fetch/cache/extract workflows.
- `file-open` — `/file:open` picker for recent transcript file references, opened with `$VISUAL`, `$EDITOR`, or `hx`.
- `theme-preview` — `/themes:preview [theme-name]` live theme showcase and selector.
- `review-subagent` — `/review`, `/review:status`, and `/review:cancel` reviewer workflow.
- `tool-display` — optional display overrides, disabled by default.

## Install

From a git checkout or git URL:

```bash
pi install git:https://github.com/akoumjian/pi-tools.git
```

For local development:

```bash
git clone https://github.com/akoumjian/pi-tools.git
cd pi-tools
npm install
npm run validate
```

This package is source-distributed for Pi package installs. `private: true` remains set in `package.json` to prevent accidental npm publication; remove it only as part of a deliberate npm release.

## Configuration

Reusable defaults live under `config/`:

- `tool-safety-settings.json` → `tool-safety-policy.md`
- `mutation-review-settings.json` → `mutation-review-guidance.md`
- `review-subagent-settings.json` → `review-subagent-guidance.md`
- `tool-display-settings.json`
- `file-open-settings.json`
- `searxng.env.example`

These defaults intentionally do not include personal provider/model choices, trusted workspace roots, auth files, themes, or global profile settings.

Config lookup prefers:

1. `PI_TOOLS_CONFIG_DIR`
2. an enclosing profile `config/pi-tools/` directory
3. package defaults under `config/`
4. a current-working-directory `config/` fallback for project-local experiments

Environment variables such as `PI_TOOL_SAFETY_APPROVAL_MODEL` and `PI_TOOL_SAFETY_TRUSTED_WORKSPACE` override file settings for the values they control.

Model-backed features are opt-in. Use setup commands such as `/safety:setup`, `/mutation:setup`, and `/review:setup` to choose local/default review models for a machine or profile.

## Async Shell

Use `shell_start` for shell work. It accepts only `commands: [...]`; use one item for a single command and multiple items for independent commands that can run concurrently. Each command item must include its own `command` and `cwd`:

```json
{
  "commands": [
    { "command": "npm test", "cwd": ".", "job_name": "tests" }
  ]
}
```

Each command gets a durable job id, metadata, and stdout/stderr logs under `.pi/async-shell/`. `shell_start` uses one fixed 6-second in-band grace period for quick commands. Jobs that do not finish in-band continue in the background and, by default, append a short completion notice when they exit.

There is no polling/wait tool. Continue useful work while jobs run. If there is no useful work, stop after reporting that jobs are running. Completion notices are intentionally brief and do not trigger a new assistant turn; use `shell_tail` for output, `shell_status` for inspection, and `shell_cancel` to stop a job.

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
npm run validate
npm run check
npm test
npm run dev:pi:reset       # create or recreate .pi/dev-agent/ with a minimal seed
npm run dev:pi:status      # show isolated dev-agent settings
npm run dev:pi -- --no-session -p '/native:status'
```

`npm run dev:pi` runs Pi with `PI_CODING_AGENT_DIR=$PWD/.pi/dev-agent`, so experiments, sessions, auth, and setup-command writes do not touch your normal `~/.pi/agent` profile. Copy auth into `.pi/dev-agent/auth.json` only when real model calls are needed for a smoke test.

## Release checklist

Before changing repository visibility or publishing elsewhere:

1. Run `npm run validate`.
2. Run a tracked-source scan for private paths, profile assets, credentials, and internal project names.
3. Check `npm pack --dry-run --json` to confirm only intended files ship.
4. Choose and add a license if public reuse is intended.
5. If prior private history contains sensitive/internal material, publish from a clean history or explicitly rewrite history before making the repository public.
