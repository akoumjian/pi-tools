# file-open

## Purpose

Give you a fast keyboard-driven way to open a file referenced anywhere in the current Pi transcript (your messages, tool results, custom messages) without typing the path. The picker lists recent file references, you select one, and Pi hands the terminal to your editor in the same pane; when you exit the editor, Pi resumes.

## Provides

- `/file:open` command — opens the picker.
- Optional keyboard shortcut, off by default.
- Settings file [`config/file-open-settings.json`](../../config/file-open-settings.json):
  ```json
  {
    "shortcut": null,
    "maxReferences": 80
  }
  ```

No LLM-callable tools.

## Behavior

1. The command reads the current branch of the session manager and scans recent message/tool-result content for file references. References are extracted from:
   - Known path-shaped JSON keys in tool result details (`path`, `file`, `filePath`, `resolvedPath`, `sourcePath`, `textPath`, `downloadedPath`, `outputPath`, `screenshotPath`, `logPath`, `stdoutLog`, `stderrLog`, `cachePath`, `source`, etc.).
   - Plain text scanning for path-shaped tokens, including `file.ext:line[:col]` suffixes for Helix-style jump targets.
2. References are deduplicated and capped at `maxReferences` (default 80, max 200).
3. A select-list overlay opens with each reference. Selecting one:
   - Resolves `$VISUAL` first, then `$EDITOR`, then `hx`.
   - Suspends the Pi TUI with `ui.stop()`, runs the editor synchronously with inherited stdio (`spawnSync`), then resumes the TUI.
   - Returns to Pi with a notification confirming the file that was opened.
4. If no editor environment variable is set and `hx` is not on PATH, the picker reports an error.

The picker is only available when:

- Pi is running with an interactive UI (`context.hasUI === true`), and
- The agent is idle (`context.isIdle() === true`). The picker refuses to open mid-turn so you don't accidentally interrupt a streaming response.

## Setup

1. Set an editor in your shell environment. Example zsh:
   ```bash
   export VISUAL="hx"
   export EDITOR="hx"
   ```
   Re-source or restart your shell. Existing Pi sessions must be restarted to inherit the new environment.
2. Optional: bind a key to `/file:open` by editing `file-open-settings.json` and setting `"shortcut"` to a key id understood by Pi (e.g. `"ctrl+e"`). Default is `null` to avoid stealing Pi's built-in Ctrl+E.
3. Optional: raise `maxReferences` if you regularly want to pick from deeper transcript history. The hard cap is 200.

## Notes

- Reference extraction never opens or reads file contents; it only checks that each candidate path is a readable file on disk before showing it in the list. Missing files are skipped silently.
- The hand-off uses `ui.stop()` / `ui.start()`, the same pattern Pi uses for `app.editor.external`. Manual edits inside the editor are not seen by Pi's mutation-review hook — the editor is treated as a user action.
- Tests cover candidate scanning, settings parsing, and editor selection (`tests/file-open.test.ts`).
