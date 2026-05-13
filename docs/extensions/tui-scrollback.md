# tui-scrollback

## Purpose

Preserve terminal scrollback across Pi TUI redraws. Pi's TUI sometimes emits `ESC [3J` (clear scrollback) as part of its repaint sequence; on many terminals that erases prior output, including everything you've scrolled back to read. This extension patches `ProcessTerminal.write` so the sequence is stripped before being sent to the terminal.

## Provides

- A runtime patch installed at extension load (idempotent across multiple loads).
- `/scrollback:status` — reports whether the patch is active and how many sequences have been stripped since install.

No LLM-callable tools.

## Behavior

- At load time, the extension finds the `ProcessTerminal` prototype's `write` method and wraps it. The wrapper strips occurrences of `\x1b[3J` from any string written to the terminal and increments a counter.
- The patch is installed exactly once per prototype using a `WeakMap` of patch state. Re-loading the extension does not double-wrap.
- Counter and install timestamp are exposed via the status command.

The patch deliberately strips only the clear-scrollback escape. All other terminal sequences pass through unchanged.

## Setup

None. The extension loads first in the `package.json#pi.extensions` order so the patch is in place before any redraws happen.

Windows Terminal, Apple Terminal, iTerm, kitty, WezTerm, and Alacritty all respect the patched behavior. If you observe scrollback being cleared anyway, your terminal may be sending a separate full-clear sequence; run `/scrollback:status` to confirm the patch is active.

## Notes

- The companion [`tmux-scrollback`](tmux-scrollback.md) extension handles tmux-specific alternate-screen and mouse-tracking conflicts and complements this one.
- Tests cover idempotent patching and exact-sequence stripping; see `tests/tui-scrollback.test.ts`.
