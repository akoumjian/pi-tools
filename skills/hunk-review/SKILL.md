---
name: hunk-review
description: Show and annotate diffs for review to the user in an interactive window using hunk.
---

# Hunk Review

Hunk is the shared visual diff surface: Pi keeps working in chat while the user can inspect changes in an interactive side window.

Use `hunk_session` when you want to show the user diffs or need this Pi session's Hunk `sessionId` for direct CLI control. Creating a session may open the visible Hunk window. Keep the session source broad and use navigation to focus a file or hunk. Do not run `hunk session reload` with pathspecs such as `-- diff -- <file>`; Pi's tools manage source refresh. The tool returns a `sessionId` for commands like:

```bash
hunk session navigate <sessionId> --file src/App.tsx --new-line 42 --json
```

Common CLI capabilities:

- `hunk session context <sessionId> --json` — see the current focus.
- `hunk session review <sessionId> --json` — see files and hunks.
- `hunk session navigate <sessionId> --file <path> --new-line <n>` — move the visible view.
- `hunk session comment add <sessionId> --file <path> --new-line <n> --summary "..."` — add a sparse persistent note.
- `hunk session comment list <sessionId>` / `comment clear <sessionId> --yes` — manage notes.

Follow mode is controlled with `/hunk:follow on|off|status`; it debounces recent tool edits and moves an open Hunk session to the latest edited file. Ask the user to enable it when they want automatic navigation.

Keep chat as the main explanation channel. Add Hunk comments only for sparse notes that should stay attached to code.
