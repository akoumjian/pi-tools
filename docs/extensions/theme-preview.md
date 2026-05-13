# theme-preview

## Purpose

Live theme showcase and selector inside Pi's TUI. Lets you cycle through every registered Pi theme and preview how tool calls, results, markdown, code, thinking blocks, errors, and other Pi surfaces will render under each. Apply with Enter; cancel and restore the original with Esc/q.

## Provides

- `/themes:preview [theme-name]` command — opens the preview overlay, optionally seeded with `theme-name` as the starting theme.
- Renders against all 51 Pi color tokens, including the 6 background tokens.

No LLM-callable tools, no settings file, no shortcut.

## Behavior

When the command opens it:

1. Lists all themes from `context.ui.getAllThemes()` (Pi's theme registry, which `pi-tools` does not contribute to).
2. Resolves the starting index from the argument:
   - Exact match wins.
   - Case-insensitive match is the second priority.
   - An ambiguous or missing name produces a fuzzy "Did you mean: …?" suggestion and the preview opens at index 0.
3. Saves the current theme as the "original" to restore on cancel.
4. Installs a custom widget below the editor showing the showcase: a title block, the selected theme name and source path, and rendered samples of:
   - Tool call/result rows (pending, success, error)
   - Markdown and inline code
   - Diff and syntax highlighting
   - Thinking-level labels (off/minimal/low/medium/high/xhigh)
   - User and custom messages
   - All `theme.fg(token, ...)` and `theme.bg(token, ...)` tokens
5. Listens for input:
   - `←`/`→`, `↑`/`↓`, `h`/`l`, `p`/`n`, `Space` — cycle
   - `Home`/`End` — jump
   - `Enter` — keep selection (writes to Pi settings)
   - `Esc`, `Ctrl+C`, `q`, `Q` — restore original theme and exit

The widget is removed and status cleared in a `finally` block so the TUI always returns to a clean state.

## Setup

None. The preview discovers Pi themes; this package does not vendor themes (they belong in a consumer profile).

## Notes

- The preview only works in interactive Pi UI mode. Print/RPC modes return a warning notification.
- The exhaustive token list is also asserted by `tests/theme-preview.test.ts` so theme palettes stay aligned with Pi's actual token set.
