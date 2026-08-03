# manual-retry

## Purpose

Provide an explicit `/retry` command for a fully settled transient provider failure without adding or repeating a user message. This is an extension-owned, provider-facing approximation: it starts a fresh normal agent run rather than invoking Pi core's private `Agent.continue()` retry transaction.

## Provides

- `/retry`
- A `context` hook that removes manual-retry markers and errored/aborted assistant attempts before every main provider request.
- A `session_before_compact` hook that applies the same filtering before Compacter or Pi's default summarizer sees compaction input.

No LLM-callable tool, model side call, provider override, or Pi fork change is involved.

## Eligibility

`/retry` fails closed unless all of the following are true:

1. The command runs in TUI or RPC mode. Print and JSON modes cannot await extension-initiated `sendMessage` work, so they reject the command.
2. The session is persisted, idle, and has no queued steering or follow-up messages.
3. The active provider context ends in an assistant message with `stopReason: "error"`.
4. Pi's shared `isRetryableAssistantError()` classifier identifies the error as transient (for example overload, rate limit, server, transport, timeout, or interrupted stream failures). Quota, billing, deterministic, successful, and user-aborted attempts are ineligible.
5. The currently selected API/provider/model matches the failed assistant attempt.
6. No model, thinking-level, compaction, branch-summary, provider-visible message, or dangling retry-marker state follows the failed assistant entry.

Labels, session names, and non-context custom state do not change provider identity and may follow the failure.

## Behavior

When eligible, `/retry` synchronously submits exactly one hidden custom message:

```json
{
  "customType": "manual-provider-retry",
  "content": [],
  "display": false,
  "details": {
    "version": 1,
    "attempt": 1,
    "failedAssistantEntryId": "…",
    "api": "…",
    "provider": "…",
    "model": "…",
    "failedAt": 0,
    "requestedAt": "…"
  }
}
```

It uses `{ "triggerTurn": true, "deliverAs": "followUp" }`. Because command eligibility and the final idle/queue checks contain no asynchronous gap, the marker is sent only from the validated idle state. No duplicate user text or model-visible retry instruction is added.

The marker and every failed attempt remain in durable session history. Before provider serialization, the context hook removes all `manual-provider-retry` custom messages and assistant messages whose stop reason is `error` or `aborted`. Filtering occurs before provider dispatch, so it also covers `pi-messages` and extension-registered providers that otherwise receive context messages verbatim.

Repeated retries are represented by repeated marker/failure pairs. `attempt` is the session branch's monotonically increasing manual-retry ordinal, not a counter reset for each unrelated failure. A marker without a subsequent completed assistant attempt is intentionally ineligible rather than silently stacking another marker.

## Compaction and reload

The extension must load before `compacter`. Its `session_before_compact` handler mutates `messagesToSummarize` and `turnPrefixMessages` before Compacter runs, preventing markers and failed attempts from entering the summary while preserving them in the JSONL history.

Filtering is derived from persisted message types and marker `customType`, with no in-memory retry state. It therefore survives `/reload`, resume, and process restart. Existing compaction summaries are not rewritten.

## Cancellation and queues

The fresh run uses Pi's normal cancellation and tool lifecycle. If the retry run is aborted, the aborted assistant remains durable but is excluded from later provider context. `/retry` does not retry aborted attempts. Active runs and pending queues are rejected; the command never calls `waitForIdle()` because waiting could silently run against a later state.

## Setup

None. Fully restart Pi after package installation or update so the extension and its load order are active.

## Limitations

- This is not byte-identical active-state retry and does not call `Agent.continue()`.
- The fresh run uses the current normal system prompt, tools, extension lifecycle, provider cache behavior, and runtime configuration.
- Print and JSON command modes are intentionally unsupported because `ExtensionAPI.sendMessage()` is asynchronous and has no awaitable completion contract.
- Branch-summary generation is outside this extension's compaction-only summarizer filter; a resulting `branch_summary` entry makes the prior failure ineligible.
- Exact unchanged-active-state retry still requires an official transactional core/API operation.
