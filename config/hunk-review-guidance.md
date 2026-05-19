# Code Review Guidance

- Use hunk related tools and skills to provide the user a way to view code diffs and point to implementation specifics
- Use the `hunk-review` skill when you need Hunk CLI navigation or comment details.
- Use `hunk_session` to show the user meaningful code-change progress, implementation milestones, or specific changed code while continuing to explain in chat, or when you need this Pi session's Hunk `sessionId` for direct `hunk session ...` commands.
- Prefer natural checkpoints: multi-file changes, API, logic, or config changes, risky edits, or moments where pointing at code would make the explanation clearer. Skip Hunk for trivial edits.
- When the relevant file is already known, pass `file` plus `newLine`, `oldLine`, or `hunk` to `hunk_session`; otherwise use direct `hunk session navigate <sessionId> ...` commands to point the visible window at relevant files or lines.
- Keep the Hunk source broad; do not use `hunk session reload ... -- diff -- <file>` to focus a file.
