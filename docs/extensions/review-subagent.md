# review-subagent

## Purpose

Spawn an in-process tool-using review subagent over recent main-agent context. The subagent gets a fresh session, a read-only tool allowlist, and a critique system prompt. It produces a structured critique that renders as a custom message in the main window and can optionally be sent back to the main agent as a user message after confirmation.

This is independent from [`mutation-review`](mutation-review.md), which is a per-tool-call hook. `review-subagent` is a user-initiated workflow.

## Provides

No LLM-callable tools.

Commands:

- `/review [--model provider/model[:thinking]] [--send|--no-send] [focus text...]`
- `/review:setup provider/model[:thinking]`
- `/review:status`
- `/review:cancel`
- `/review:send-last`

Config:

- [`config/review-subagent-settings.json`](../../config/review-subagent-settings.json):
  ```json
  {
    "guidanceFile": "review-subagent-guidance.md",
    "thinkingLevel": "xhigh",
    "maxRecentMessages": 30,
    "maxTranscriptChars": 30000,
    "maxDiffChars": 50000,
    "maxOutputTokens": 6000,
    "commandTimeoutMs": 10000,
    "tools": [
      "search_many", "read_many",
      "searxng_search", "web_fetch_many", "document_parse",
      "shell_start", "shell_status", "shell_read", "shell_cancel"
    ]
  }
  ```
- [`config/review-subagent-guidance.md`](../../config/review-subagent-guidance.md) — package-default reviewer guidance.

Side effects:

- Registers a `review-subagent` custom-message renderer with structured critique formatting.
- Maintains review state per (cwd, session) scope: phase (`idle` / `running` / `awaiting-display` / `awaiting-confirm`), active run id, last completed review.
- Subscribes to `session_shutdown` to cancel an active run and clear state.

## /review behavior

1. Parse args: `--model`, `--send`, `--no-send`, and a free-form focus string. Reject conflicting flags.
2. Build the reviewer prompt: package system prompt (skeptical reviewer, no writes, tools-allowlisted) plus your configured guidance. Append the user-supplied focus and a bounded slice of the parent context: recent messages, current cwd state, git status/diff snapshot.
3. Launch a child Pi session via `createAgentSessionFromServices` with:
   - The configured reviewer model and thinking level (default `xhigh`).
   - The configured tool allowlist. Defaults include `search_many`, `read_many`, search/fetch/parse, and async-shell read-only commands.
   - The same tool-safety extension wired into the parent (so reviewer shell calls go through the same policy).
4. Stream the child session in the background. The phase becomes `running`, with a transient bottom-status indicator `review subagent running`.
5. When the child finishes:
   - On error or empty critique: report a failure notification; the review cannot be sent back.
   - On success: phase becomes `awaiting-display`. If the main agent is busy, display is deferred until idle; otherwise the critique is rendered immediately as a `review-subagent` custom message.
6. Send-back: if `--send` was passed, the critique is sent back to the main agent as a user message with `deliverAs: "followUp"`. If `--no-send` was passed, no prompt is shown. Otherwise the phase becomes `awaiting-confirm` and the user is asked. `/review:send-last` re-runs the send-back path for the most recent completed review.

Mid-flight, `/review:cancel` aborts the active run, cancels pending display/send-confirm phases, and clears state. `session_shutdown` triggers the same cleanup automatically.

## Reviewer constraints

From the system prompt:

- Never modify files. Even with write tools available, the reviewer must not call them.
- Prefer `search_many` and `read_many` for repository inspection. `searxng_search`/`web_fetch_many`/`document_parse` for external context.
- `shell_start` only for read-only inspection or short validation commands (tests, type checks, linters, git read commands, `rg`, `grep`, `find`, etc.). Pass `cwd` and `notifyOnExit: false`, and keep commands short.
- Do not install dependencies, deploy, push, commit, rewrite history, access credentials, or touch shared/production infrastructure.
- If tool-safety blocks a command, continue with safer alternatives and note the validation gap.

The final critique uses a fixed structure:

```
## Review Summary
## Findings        (Critical / High / Medium / Low)
## Validation Performed
## Open Questions / Gaps
## Suggested Next Steps
```

## TUI rendering

While running:

- Bottom status: `review subagent running` (cleared when finished or cancelled).

When the critique displays:

- A `review-subagent` custom message renders the structured critique with severity styling for findings, indented validation results, and a recent-tool-activity tail showing the last ~30 reviewer tool calls.
- The recent-tool-activity tail uses arrow/check/cross markers (`→`, `✓`, `✗`) per tool start/end event.

Send-back, if confirmed, posts the critique back to the main agent as a user message.

## Setup

1. Run `/review:setup provider/model[:thinking]` to pick a strong reasoning reviewer model.
2. (Optional) Edit `review-subagent-settings.json` to tune transcript/diff caps or the reviewer tool allowlist.
3. Run `/review:status` to confirm the reviewer model, guidance source, and active phase.
4. Run `/review [--send|--no-send] focus...` to start a review.

## Notes

- Defaults: thinking level `xhigh`, max ~6000 output tokens, ~30 recent messages, ~30 KB transcript, ~50 KB diff. Tune in the settings file for your model's context window and cost profile.
- Reviewer behavior is deliberately reactive: it does not see your `AGENTS.md`/`CLAUDE.md` profile context unless you've wired it into the project. The guidance file is the place to add organization-specific review priorities.
- Tests cover argument parsing, model selection, tool allowlist enforcement, deferred display, cancellation phases, send-back conditions, and message rendering (`tests/review-subagent.test.ts`).
