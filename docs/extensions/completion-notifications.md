# completion-notifications

## Purpose

Emit one privacy-safe terminal notification after a genuinely settled, successful, long-running interactive Pi task. The extension is opt-in and default-off. It makes no provider call, adds no session/model-context message, reads no prompt content for delivery, and does not affect async-shell job lifetime.

## Provides

- `/notify status` (also `/notify`)
- `/notify on`
- `/notify off`
- `/notify test`

There is no LLM-callable tool. Notifications are emitted only from interactive TUI sessions.

## Eligibility

A normal automatic notification requires all of the following:

1. `completion-notifications-settings.json#enabled` is `true`.
2. The session run originated from interactive user input. RPC, print/JSON, and extension-originated runs do not independently notify.
3. Pi emits `agent_settled`, which is after automatic retry, compaction, and queued steering/follow-up continuations have finished.
4. The final assistant message has `stopReason: "stop"`. Error, aborted, length-limited, tool-use, or missing terminal assistant outcomes are suppressed.
5. At least 30 seconds elapsed since the interactive run began. The threshold is fixed rather than configurable.
6. The context is idle and has no pending messages.
7. A tested terminal transport is detected.
8. Related async-shell completion delivery has settled as described below.

Repeated `agent_end` events from automatic retries or continuations remain one tracked run. Only the final `agent_settled` can notify, so retries and intermediate compaction phases do not produce duplicate alerts.

## Async-shell coordination

The extension queries in-memory async-shell provenance for `notifyOnExit:true` jobs started by the same session during the tracked run.

- A still-running job or a job whose async-shell follow-up has been queued defers the notification.
- Completion custom messages are matched by their canonical job IDs. Multiple jobs or batches produce one final toast only after every related completion follow-up settles successfully.
- A completion already delivered inside the original run does not add another wait.
- Jobs that completed in-band, were cancelled through async-shell, or whose completion was explicitly observed do not block. If one leaves a previously created barrier, it is pruned on the next settled run; the extension intentionally creates no polling timer.
- `notifyOnExit:false` jobs are intentionally detached from completion delivery: they never block the toast and are never cancelled or terminated by this extension.
- New interactive work supersedes an older deferred toast.
- A failed/aborted related completion follow-up suppresses the deferred toast rather than claiming success.

This coordination is read-only. Async-shell remains the sole owner of durable jobs, canonical logs, and model-visible completion follow-ups.

## Privacy

Automatic and test notifications use exactly:

- title: `Pi`
- body: `Ready for input`

The iTerm2 OSC 9 protocol has one message field, so it combines those fixed values as `Pi: Ready for input`. Prompt text, assistant text, repository/path, session title, model/provider, tool output, job command, and filenames are never included. The command status is shown only through Pi's user UI and is not injected into session/model context.

## Transports

Exactly one transport is selected; there is no BEL fallback and no fan-out to multiple host integrations.

- iTerm2 (`TERM_PROGRAM=iTerm.app`): documented proprietary OSC 9.
- Ghostty, WezTerm, and rxvt/urxvt: OSC 777.
- Kitty: OSC 99.
- Windows Terminal on Windows or WSL: native PowerShell toast using fixed generic strings.
- tmux and Zellij: conservative no-op because passthrough is not assumed.
- Warp: conservative no-op so host integration remains authoritative.
- non-TTY or unknown terminals: conservative no-op.

`/notify status` reports the detected transport and reason for any no-op. `/notify test` explicitly attempts the detected transport even while automatic notifications are disabled; it never starts a provider turn.

For iTerm2, enable **Settings → Profiles → Terminal → Notification Center alerts** and ensure its **Filter Alerts** rules allow proprietary escape-sequence notifications. macOS System Settings must also allow notifications for iTerm2. The protocol choice follows [iTerm2's proprietary escape-code documentation](https://iterm2.com/documentation-escape-codes.html), which specifies `OSC 9 ; message ST`.

## Settings

Reusable package default:

```json
{
  "enabled": false
}
```

Lookup follows the standard pi-tools chain: `PI_TOOLS_CONFIG_DIR`, per-machine config under the active Pi agent directory, enclosing profile override, package default, then cwd fallback. `/notify on` and `/notify off` write only `{ "enabled": boolean }` to the per-machine pi-tools config directory, which has higher precedence than profile/package defaults.

## Lifecycle and failure behavior

- Session start/shutdown clears transient run/deferred state without touching jobs.
- Unsupported transports and delivery errors are no-ops recorded in `/notify status`.
- Notifications do not retry through a second transport.
- There are no timers, persistent notification queues, provider calls, session entries, sidecars, or notification logs.
- Existing Pi sessions must `/reload` or restart after installation or update.
