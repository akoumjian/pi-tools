# Live diff workflow plan

## Status

Prototype in progress. `extensions/live-diff` tracks Pi tool edits by repo, opens Hunk in a side window, supports active repo switching, and has a debounced follow mode that navigates an existing Hunk session toward recently edited files.

## Current command surface

```text
/hunk:setup [--hunk-bin <path>] [--launcher auto|iterm|manual] [--follow-delay-ms <ms>]
/hunk:doctor
/hunk:status
/hunk:switch [<repo>|--repo <path>|--auto]
/hunk:open [--repo <path>] [--launcher auto|iterm|manual] [--dry-run]
/hunk:close [--repo <path>]
/hunk:follow on|off|status [--delay-ms <ms>]
/hunk:guidance status|print|install|remove [--dry-run]
/hunk:focus <file[:line]> [--repo <path>] [--hunk <n>|--old-line <n>|--new-line <n>]
```

Slash commands are user-facing controls. The agent-facing tool is `hunk_session`, which gets or creates the current Pi session's Hunk session, returns its `sessionId`, and may open the user-visible Hunk side window when creation is needed. It can accept `file` plus `newLine`, `oldLine`, or `hunk` to focus the repo-wide session without narrowing its source. Direct `hunk session ...` CLI commands can use the returned `sessionId`.

## Product direction

Build Hunk-backed `live-diff` as orchestration around Hunk, not a replacement diff UI:

1. Keep Pi usable while Hunk runs elsewhere.
2. Infer touched child repos from Pi mutation tools when Pi starts from a parent directory.
3. Let the user switch the active edited repo explicitly.
4. Use `/hunk:open` and `/hunk:close` for the user-visible Hunk view lifecycle.
5. Offer `/hunk:follow on|off`: after tool edits settle, move Hunk to the edited file/hunk with a debounce.
6. Keep chat as the primary feedback loop; use sparse Hunk comments when persistent inline notes help review.
7. Keep agent-facing guidance short and stable for prompt caching. The bundled `hunk-review` skill plus `hunk_session` metadata explain the Hunk mental model, sessionId handoff, and direct `hunk session navigate ...` steering; user-specific usage cadence belongs in AGENTS.md and can be installed with `/hunk:guidance install`.

## Current behavior

- `tool_result` records successful `write_many`, `edit_many`, stock `write`/`edit`, and `apply_reviewed_mutation` paths.
- Touched files resolve to nearest `.jj`, `.git`, or `.hg` repo roots.
- `activeRepo` is automatic unless pinned by `/hunk:switch <repo>`.
- `/hunk:switch --auto` returns active repo selection to automatic mode.
- `hunk_session` and `/hunk:open` open repo-wide `hunk diff --watch` or reuse the exact Hunk `sessionId` remembered by the current Pi session; they do not silently claim unrelated old Hunk daemon sessions for the same repo. Touched-file tracking remains internal for repo inference and follow navigation. File/hunk focus is navigation, not pathspec reload.
- `/hunk:close` forgets Pi's remembered Hunk view for the repo; pane/process closing remains manual for now.
- `/hunk:follow on` debounces mutation results and runs `hunk session navigate` for the latest edited file in a remembered Hunk session, refreshing stale/narrow sessions back to repo-wide before retrying navigation when needed.
- Follow mode does not open panes by itself; the user can open Hunk with `/hunk:open`, and the agent can get/create or show Hunk with `hunk_session`.

## Multi-repo policy

Default to one primary Hunk view. When multiple repos are touched:

- Track all touched repos.
- Show them in `/hunk:status`.
- Use the active/pinned repo for commands without `--repo`.
- Let the user switch with `/hunk:switch <repo>`.

Future optional policy: ask or auto-open additional Hunk sessions for each touched repo with a small cap, but avoid pane spam by default.

## Follow-mode hardening still needed

- Verify Hunk navigation behavior for new files and line ranges from `edit_many`.
- Track Hunk session identity more robustly for explicit attach/reveal workflows without silently claiming unowned daemon sessions.
- Smoke-test iTerm2 interactive split launch and direct `hunk session *` navigation in the standalone sandbox.

Implemented hardening: follow mode now warns once when no launched Hunk view is remembered for the target repo and unrefs the debounce timer so noninteractive runs can exit cleanly.

## Testing workflow

Use isolated environments before active-profile install:

```bash
npm run dev:pi:reset
npm run dev:pi:status
npm run dev:pi -- --no-session
```

Standalone sandbox:

```bash
/Users/aleck/Code/pi-live-diff-sandbox/bin/pi-live-diff --no-session
```

Validation targets:

```bash
npm run check
npm test -- --test-name-pattern live-diff
npm test -- --test-name-pattern conventions
git diff --check
npm run validate
```
