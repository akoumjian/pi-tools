# manual-retry

## Purpose

Resend Pi's current provider context to the selected model after a failed or cancelled attempt without adding or repeating a user message, so recovery never requires `/tree` navigation. Two entry points share one mechanism:

- `/retry` — explicit, available from any settled failure or cancellation.
- Automatic retry — bounded, for a short list of outage-class provider errors that Pi core's own transient classifier does not retry.

This is an extension-owned, provider-facing approximation: it starts a fresh normal agent run rather than invoking Pi core's private `Agent.continue()` retry transaction. The provider payload is the current context minus the failed attempts, which is what a user resending from `/tree` would achieve without the duplicated user text.

## Provides

- `/retry`
- A `context` hook that removes retry markers, errored/aborted assistant attempts, and any tool results that answered a removed attempt before every main provider request.
- A `session_before_compact` hook that applies the same filtering before Compacter or Pi's default summarizer sees compaction input.
- An `agent_settled` hook that performs the bounded automatic retry.

No LLM-callable tool, model side call, provider override, or Pi fork change is involved.

## Eligibility

Retry (manual or automatic) fails closed unless all of the following are true:

1. The command runs in TUI or RPC mode. Print and JSON modes cannot await extension-initiated `sendMessage` work, so they reject the command.
2. The session is persisted, idle, and has no queued steering or follow-up messages.
3. A model is selected.
4. After retry filtering, the provider-visible context still owes a model response: its last message is a user message, tool results, a summary, or a custom message. The only refusals are a completed assistant response (`stopReason: "stop"`) — there is nothing to retry — and an assistant turn whose tool calls have no results.

The retried tail may be an assistant error of any class (transient or not), a cancelled assistant attempt, or a cancelled tool phase whose tool results are already recorded. Model, thinking-level, and compaction changes after the failure do not block `/retry`: switching model during a provider outage and then running `/retry` is the intended recovery path, and the marker records the model the context was sent to.

## Behavior

When eligible, retry synchronously submits exactly one hidden custom message:

```json
{
  "customType": "manual-provider-retry",
  "content": [],
  "display": false,
  "details": {
    "version": 2,
    "attempt": 1,
    "trigger": "manual",
    "kind": "error",
    "errorMessage": "Not Found",
    "failedAssistantEntryId": "…",
    "failedAt": 0,
    "api": "…",
    "provider": "…",
    "model": "…",
    "requestedAt": "…"
  }
}
```

`trigger` is `manual` or `automatic`. `kind` is `error`, `aborted`, or `continuation` (the context tail already owes a response, for example tool results recorded before a cancellation). `api`/`provider`/`model` name the model the context is resent to. `attempt` is the session branch's monotonically increasing retry ordinal.

It uses `{ "triggerTurn": true, "deliverAs": "followUp" }`. Because eligibility and the final idle/queue checks contain no asynchronous gap, the marker is sent only from the validated idle state. No duplicate user text or model-visible retry instruction is added.

The marker and every failed attempt remain in durable session history. Before provider serialization, the context hook removes all `manual-provider-retry` custom messages, assistant messages whose stop reason is `error` or `aborted`, and tool results whose `toolCallId` belongs to a removed assistant. Filtering occurs before provider dispatch, so it also covers `pi-messages` and extension-registered providers that otherwise receive context messages verbatim.

## Automatic retry

Pi core auto-retries errors matching its transient classifier (`isRetryableAssistantError`: overload, rate limit, 429/5xx, connection and timeout failures). Some outage symptoms fall outside it — notably the bare HTTP reason phrases `Not Found` and `Bad Gateway` that the OpenAI Codex SSE path surfaces when the provider edge answers an empty-body HTTP error. After `agent_settled`, when the settled tail is an assistant error that core did **not** classify as transient and that matches `AUTOMATIC_RETRY_ERROR_PATTERNS`, the extension:

1. notifies `Automatic retry n/3 in Ns after error "…"`;
2. waits 2s, 4s, then 8s for consecutive attempts;
3. re-validates that the session is still idle, queue-free, and that the leaf entry is unchanged — any new prompt or activity during the backoff cancels the retry silently;
4. dispatches the same marker with `trigger: "automatic"`.

Consecutive automatic attempts are bounded at 3, counted from the persisted automatic markers in the trailing run of marker/failed-attempt entries, so the bound survives reload. A new user message or an explicit `/retry` starts a fresh chain. When the bound is reached a warning names the last error and points to `/retry`. Cancellations, quota/billing errors, and errors core already retried are never retried automatically.

## Compaction and reload

The extension must load before `compacter`. Its `session_before_compact` handler mutates `messagesToSummarize` and `turnPrefixMessages` before Compacter runs, preventing markers and failed attempts from entering the summary while preserving them in the JSONL history.

Filtering and bounds are derived from persisted message types and marker details, with no in-memory retry state. They therefore survive `/reload`, resume, and process restart. Existing compaction summaries are not rewritten.

## Cancellation and queues

The fresh run uses Pi's normal cancellation and tool lifecycle. If the retry run is aborted, the aborted assistant remains durable but is excluded from later provider context, and `/retry` can be used again. Active runs and pending queues are rejected; the command never calls `waitForIdle()` because waiting could silently run against a later state.

## Setup

None. Fully restart Pi after package installation or update so the extension and its load order are active.

## Limitations

- This is not byte-identical active-state retry and does not call `Agent.continue()`.
- The fresh run uses the current normal system prompt, tools, extension lifecycle, provider cache behavior, and runtime configuration.
- Regenerating a *completed* assistant response is intentionally out of scope; `/retry` refuses when the last response finished normally.
- Print and JSON command modes are intentionally unsupported because `ExtensionAPI.sendMessage()` is asynchronous and has no awaitable completion contract.
- The automatic pattern list is built in and deliberately short; it supplements, and never overrides, Pi core's classifier.
