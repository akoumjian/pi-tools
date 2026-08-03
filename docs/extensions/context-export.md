# context-export

## Purpose

Copy the current session's active, compaction-aware Pi context directly to the system clipboard for local inspection or explicit sharing. The command is provider-free: it makes no model call, appends no session entry, injects no model-visible message, and writes no temporary or persistent sidecar file.

## Provides

- `/context:copy`
- `/context:copy --raw`

There is no LLM-callable tool or automatic background behavior. The command is available only in interactive TUI mode so the clipboard target and raw-mode confirmation remain user-visible.

## Snapshot scope

The snapshot is a deterministic, newline-terminated JSON document with format kind `pi-current-context` and version `1`. It contains:

- the effective system prompt returned by Pi;
- active API, provider, model, and thinking level;
- current context-usage metadata when Pi can provide it;
- active tool names, descriptions, and authoritative input schemas in active-tool order;
- active compaction-aware messages, including compaction and branch summaries and provider-visible custom messages after Pi conversion;
- session ID, working directory, message count, and whether the active branch is compacted.

The command uses `buildContextEntries()` rather than full persisted history. Entries replaced by a durable compaction summary and entries outside the current branch are excluded. The package's manual-retry markers and failed/aborted assistant attempts receive the same filtering as normal provider and compaction paths.

This is a structured Pi-context diagnostic, not a replay artifact or exact provider request. Provider adapters may normalize IDs, signatures, schemas, images, and message fields. Other installed extensions may also transform context before a later request. Use the package's network-blocked provider-context review harness when exact synthetic provider payload inspection is required.

## Default privacy behavior

`/context:copy` uses a best-effort redacted mode:

- exact values from secret-like environment variables are masked when they appear in prompt or message text;
- common credential assignments, authorization headers, credential-bearing URLs, private-key blocks, and common token forms are masked;
- structured tool-call fields with secret-like names are masked;
- hidden thinking is replaced by an omitted block with its character count;
- image base64 is replaced by MIME type and base64 character count;
- response, text, thought, and thinking signatures are removed or replaced with `[REDACTED]`;
- internal-only tool-result `details`, usage accounting, and diagnostics are not exported.

Tool input schemas are not key-redacted because fields such as `token` can be legitimate schema contracts. Redaction is intentionally described as best-effort rather than safe anonymization: source text, prompts, paths, tool output, and other private material remain part of the requested context. Review the clipboard content before sharing it, and remember that clipboard managers may retain it.

## Raw mode

`/context:copy --raw` first shows an interactive confirmation. If accepted, it preserves prompt/message text, hidden thinking, image base64, provider signatures, response IDs, and tool-call arguments. It still omits internal-only tool-result details and does not claim provider-wire equivalence.

Cancelling the confirmation copies nothing. The command rechecks idle and queue state after confirmation; if the session changed while the dialog was open, it fails without touching the clipboard.

## Size, lifecycle, and failure behavior

- Maximum serialized UTF-8 payload: 4 MiB.
- Oversized snapshots fail before clipboard access; they are never truncated.
- Active streaming and queued steering/follow-up messages fail closed rather than waiting or capturing a moving target.
- An empty session is valid and copies its system prompt, model metadata, and active tools with an empty message list.
- Unknown arguments show `Usage: /context:copy [--raw]`.
- Clipboard failures are reported through a user-only notification and do not create session state.

Clipboard writing delegates to Pi's supported `copyToClipboard()` utility, which handles native macOS/Windows access, platform tools on macOS/Linux/Windows/Termux, and OSC 52 fallback where available. The extension does not add a second clipboard implementation or fallback file.

## Setup

None. Fully restart Pi after package installation or update so the extension is loaded.
