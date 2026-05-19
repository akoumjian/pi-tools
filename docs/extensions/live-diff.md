# live-diff

## Purpose

`live-diff` keeps Pi usable while Hunk runs in a side window. Pi tracks tool-edited repos/files, opens or reuses the current Pi session's remembered Hunk view for the active repo, returns stable Hunk `sessionId`s, and can follow recent edits with debounced Hunk navigation.

## Tools

- `hunk_session` — agent-facing tool to get or create this Pi session's current Hunk session and return its `sessionId`. Use it to show the user Hunk diffs or before direct `hunk session ...` CLI control. Because Hunk sessions are created by `hunk diff --watch`, creating one may also open the configured visible window. Optional `file` plus `newLine`, `oldLine`, or `hunk` focuses the repo-wide session after it is ready.

## Commands

- `/hunk:setup` — save local defaults such as Hunk path, launcher, follow delay, and whether agent launches are allowed.
- `/hunk:doctor` — check Hunk, launcher, skill file, and session API reachability.
- `/hunk:status` — show active repo, touched repos, remembered Hunk views, follow state, and settings.
- `/hunk:switch [<repo>|--repo <path>|--auto]` — pin the active repo, list touched repos, or return to automatic repo selection.
- `/hunk:open [--repo <path>] [--launcher auto|iterm|manual] [--dry-run]` — open or print repo-wide `hunk diff --watch` for the active repo.
- `/hunk:close [--repo <path>]` — forget Pi's remembered Hunk view for a repo; close the terminal pane manually if needed.
- `/hunk:follow on|off|status [--delay-ms <ms>]` — move an open Hunk view to recently edited files after a quiet period.
- `/hunk:guidance status|print|install|remove [--dry-run]` — manage the optional `# Code Review Guidance` snippet in the global Pi `AGENTS.md` for the current `PI_CODING_AGENT_DIR`.
- `/hunk:focus` — focus an existing Hunk session on a file/line/hunk.

## Skill

- `hunk-review` — “Show and annotate diffs for review to the user in an interactive window using hunk.”

## Agent guidance

Use `hunk_session` when the purpose is to show the user meaningful diffs in a visible review/learning window or when you need the current `sessionId` before direct Hunk CLI steering. When you already know the file to show, pass `file` with `newLine`, `oldLine`, or `hunk` so Pi opens/refreshes the repo-wide session and focuses it safely. After the tool returns, use the `hunk-review` skill or direct `hunk session navigate ...` commands for further steering, passing the returned `sessionId` positionally. `/hunk:*` slash commands are user-facing controls.

## Behavior

1. Successful `write_many`, `edit_many`, stock `write`/`edit`, and `apply_reviewed_mutation` results add touched paths to hidden live-diff session state.
2. Paths resolve to the nearest `.jj`, `.git`, or `.hg` repo root.
3. `hunk_session` and `/hunk:open` use repo-wide `hunk diff --watch`. Pi reuses a Hunk session only when the current Pi session already remembers that exact `sessionId` and Hunk still reports it for the same repo; otherwise it creates a new session instead of silently claiming an old daemon-visible repo session. Reusing a remembered session refreshes the repo-wide source and may overwrite custom sources or pathspecs on that session. Tool focus params use `hunk session navigate`, never pathspec reloads.
4. Successful agent tools require a discovered `sessionId`; if Pi cannot launch/discover one, the tool fails loudly rather than returning ambiguous state.
5. `/hunk:switch <repo>` pins subsequent commands and follow behavior to that repo until `/hunk:switch --auto`.
6. `/hunk:follow on` debounces tool-result updates, then runs `hunk session navigate` for the latest edited file in a remembered Hunk session, targeting its remembered `sessionId` when available. If navigation reports that the file is missing from a stale/narrow session, Pi refreshes the repo-wide source before retrying.
7. If no launched Hunk view is remembered, follow mode warns quietly and records state but does not open panes by itself.

## Setup

Install Hunk manually first:

```bash
npm i -g hunkdiff
# or
brew install modem-dev/tap/hunk
```

Then verify:

```text
/hunk:doctor
```

Optional local defaults:

```text
/hunk:setup --hunk-bin /absolute/path/to/hunk --launcher auto --follow-delay-ms 1200 --allow-agent-launch on
```

Package defaults live in [`config/live-diff-settings.json`](../../config/live-diff-settings.json). The optional AGENTS snippet is saved separately in [`config/live-diff-code-review-guidance.md`](../../config/live-diff-code-review-guidance.md).

To print or install that snippet into the global Pi `AGENTS.md` for the current agent dir:

```text
/hunk:guidance print
/hunk:guidance install --dry-run
/hunk:guidance install
```

`/hunk:guidance install` appends or updates a package-marked block and tells you to run `/reload` or restart Pi. `/hunk:guidance remove` only removes the package-marked block; it leaves unmarked/manual guidance alone. Per-machine setup writes Pi agent files and should not be committed.

## Notes

- This extension does not auto-install Hunk.
- Direct/same-terminal interactive Hunk is intentionally avoided; Pi should remain usable.
- `launcher:auto` uses iTerm2 only when `$ITERM_SESSION_ID` is present on macOS; otherwise user-facing `/hunk:open` prints a manual command.
- Agent Hunk launches are allowed by default and can be disabled with `/hunk:setup --allow-agent-launch off`.
- Follow mode intentionally debounces navigation so active edits do not thrash the Hunk view.
- `/hunk:focus` resolves an exact Hunk session through the Hunk CLI and requires the configured Hunk binary/session API to be reachable; it does not fall back to ambiguous `--repo` navigation.
