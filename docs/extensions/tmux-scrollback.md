# tmux-scrollback

## Purpose

Keep Pi output on tmux's main screen and let tmux own scrollback and copy mode. Pi's TUI normally requests several private terminal modes (alternate screen, several mouse-tracking variants) that conflict with tmux's own scrollback management and produce broken scrollback, lost output, or unreadable mouse-event noise. This extension strips those private-mode enables from terminal writes when running inside tmux and emits a reset sequence on attach so the terminal stays in a sensible state.

## Provides

- Idempotent runtime patch installed at extension load. Inactive when `TMUX` is not set in the environment.
- `/tmux-scrollback:status` — diagnostics: whether the patch is installed, whether it is currently active (i.e. inside tmux), install timestamp, and number of stripped private-mode enables.

No LLM-callable tools.

## Behavior

At load time the extension:

1. Patches `ProcessTerminal.write` to strip CSI private-mode enables for the following modes when inside tmux:
   - `47`, `1047`, `1048`, `1049` — alternate-screen variants.
   - `1000`, `1002`, `1003`, `1005`, `1006`, `1015` — mouse tracking variants.
2. Writes a reset sequence on attach that disables those modes if they were already enabled by an earlier process: `\x1b[?1000l\x1b[?1002l...`.
3. Counts each stripped enable for the status command.

Outside tmux, the patch is installed but inactive: it tracks state and reports `active: false`, and `write` is not modified.

## Setup

No configuration files. Recommended tmux options for the best experience:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

Without `extended-keys`, modified Enter and many keyboard shortcuts are mangled by tmux. Pi shows a one-time startup warning when these are not set.

If you remap Alt+Enter for fullscreen in Windows Terminal, follow Pi's `docs/terminal-setup.md` so the follow-up shortcut still reaches Pi.

## Notes

- Tests cover environment detection, stripping behavior inside tmux, and unrelated modes passing through untouched (`tests/tmux-scrollback.test.ts`).
- This extension and [`tui-scrollback`](tui-scrollback.md) coexist; both wrap `ProcessTerminal.write` with separate idempotent patches.
