# mutation-review

## Purpose

Optional reviewer that inspects pending file mutations (`write_many`, `edit_many`, and stock `write`/`edit`) before they apply. The reviewer asks one focused question: *does this mutation duplicate existing concrete code I can cite, and should it reuse it instead?* It blocks only with cited evidence and high confidence; otherwise it allows. When it blocks, the original mutation is cached and can be cheaply re-applied via `apply_reviewed_mutation` after the agent addresses the feedback.

## Provides

LLM-callable tools:

- `apply_reviewed_mutation({ id })` — apply a previously-blocked mutation by its `mr_...` id after acknowledgement.

Commands:

- `/mutation:setup provider/model[:thinking]`
- `/mutation:status`
- `/mutation:model provider/model[:thinking] | reset`
- `/mutation:toggle [on|off]`
- `/mutation:apply <id>` — user-driven manual apply path.

Config:

- [`config/mutation-review-settings.json`](../../config/mutation-review-settings.json) — reviewer model, thinking level, context caps, tool allowlist for the reviewer session, and which tools are reviewed.
- [`config/mutation-review-guidance.md`](../../config/mutation-review-guidance.md) — conservative-by-default reviewer guidance.

Side effects:

- Subscribes to `tool_call` to gate `reviewedTools`.
- Subscribes to `tool_result` to annotate partial-block results.
- Maintains in-memory pending-mutation state keyed by session scope.
- Ensures `apply_reviewed_mutation` stays in the active tool list across session lifecycle events.

## Behavior

1. When a `reviewedTools` call is about to execute (default: `edit_many`, `write_many`, `edit`, `write`), the extension:
   1. Extracts the file-mutation operations the call would perform, with stable per-operation ids and content hashes.
   2. Computes a `fingerprint` for the whole proposal.
2. If an identical fingerprint is already pending review for this session scope, the call is blocked with a message pointing at the pending id (use `apply_reviewed_mutation`).
3. Otherwise, the extension spawns an in-process child Pi session with:
   - A `submit_mutation_review` tool (the reviewer must end with exactly one call to this).
   - The reviewer system prompt plus your configured guidance.
   - A read-only tool allowlist (default: `search_many`, `read_many`).
   - Capped recent-message context and a configurable max diff size.
   - The parent agent's abort signal. A pre-aborted parent never starts the child; interruption aborts an active child and is awaited during teardown.
4. The reviewer either:
   - **allows** → the original mutation proceeds.
   - **blocks (full)** → the call is blocked, an `mr_...` id is generated, and the proposal is cached. The agent gets a structured reason with cited evidence and a suggested path.
   - **blocks (partial)** → the call still runs for allowed mutations; blocked ones are stripped out and cached separately. The tool result is annotated with a `mutationReview` block listing the blocked ids and a summary.
5. After fixing the underlying duplication or accepting the block, the agent (or a user via `/mutation:apply`) calls `apply_reviewed_mutation({ id })`. The extension verifies the target files still match the before-review hashes; if they do, it re-applies the cached mutation under the shared file queues. Agent-driven apply checks interruption after queue acquisition and immediately before writes; interrupted attempts keep the pending review id. If hashes have drifted (someone edited the files in between), the apply fails loudly with a remediation message.

## Tool schema

```ts
apply_reviewed_mutation({
  id: string   // e.g. "mr_ab12cd34", returned in the block reason or partial-result mutationReview block
})
```

Result details include:

```ts
{
  id, fingerprint, toolName, toolCallId,
  files: [
    { id, path, resolvedPath, kind: "create" | "overwrite" | "replace", bytes, lines, beforeHash?, afterHash }, ...
  ]
}
```

## Configuration

[`config/mutation-review-settings.json`](../../config/mutation-review-settings.json):

```json
{
  "guidanceFile": "mutation-review-guidance.md",
  "thinkingLevel": "low",
  "maxRecentMessages": 8,
  "maxTranscriptChars": 8000,
  "maxDiffChars": 24000,
  "maxOutputTokens": 600,
  "tools": ["search_many", "read_many"],
  "reviewedTools": ["edit_many", "write_many", "edit", "write"]
}
```

- `defaultModel` is set per-machine by `/mutation:setup`; the package default leaves it unset.
- `tools` is the reviewer-session allowlist. The reviewer cannot call write/edit tools.
- `reviewedTools` is the parent-session list of tool names the extension intercepts.

[`config/mutation-review-guidance.md`](../../config/mutation-review-guidance.md) is conservative by default: block only on cited reuse/correctness evidence; allow otherwise.

## Setup

1. Run `/mutation:setup provider/model[:thinking]` to pick a fast, cheap, reasoning-friendly reviewer model.
2. `/mutation:status` confirms the active reviewer model, guidance source, tool allowlist, reviewed tools, and any runtime overrides.
3. To temporarily disable: `/mutation:toggle off`.
4. To change reviewer mid-session without persisting: `/mutation:model provider/model[:thinking]`. `/mutation:model reset` clears the runtime override.

When the reviewer model isn't configured, the extension warns once per session start and otherwise stays out of the way (mutations are allowed through). This makes the feature safe to ship enabled by default with no model required.

## TUI rendering

- Bottom-status: a transient `mutation review · <toolName>` indicator while the reviewer runs.
- Blocked tool result: a succinct `⎿ File mutation was not applied. ... mr_<id>` row with the cited summary line. The full block reason and evidence are in the model-facing content.
- Partial blocks: existing native-tools result renderer adds a `skipped <id> blocked by mutation review: <one-line reason>` row.

## Notes

- The reviewer never modifies files, even though it could be configured with write tools. The default guidance and system prompt both forbid mutations.
- `apply_reviewed_mutation` is the cheap path: no re-review, no model call. Use it for trivial re-applies after a typo fix in the agent's reasoning. Use a fresh edit/write call when the content has materially changed.
- Block decisions are deterministic for the same proposal fingerprint within a session: a duplicate proposal is rejected immediately with a pointer to the pending id, not re-reviewed.
- Tests cover schema, fingerprinting, block/allow paths, partial-block annotation, apply hash validation, interrupted queued apply with pending-state preservation, and command lifecycle (`tests/mutation-review.test.ts`, `tests/cancellation.test.ts`).
