import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext, Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, highlightCode } from "@mariozechner/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import { registerCommandWithAliases } from "../_shared/deprecated-command.js";

type ThemeBgColor = Parameters<Theme["bg"]>[0];

type PreviewTheme = Pick<
  Theme,
  "fg" | "bg" | "bold" | "italic" | "underline" | "strikethrough" | "getThinkingBorderColor" | "getBashModeBorderColor"
>;

type ThemeInfo = {
  name: string;
  path: string | undefined;
};

type ThemePreviewArgs = {
  help: boolean;
  themeName?: string;
};

type ThemePreviewResult = {
  action: "applied" | "cancelled";
  themeName: string;
};

export type ThemePreviewRenderState = {
  themes: ThemeInfo[];
  selectedIndex: number;
  originalThemeName?: string;
  error?: string;
};

type PreviewSamples = {
  markdownLines?: string[];
  codeLines?: string[];
};

type MutableThemePreviewState = ThemePreviewRenderState & {
  selectedIndex: number;
};

const STATUS_KEY = "theme-preview";
const WIDGET_KEY = "theme-preview";
const SAMPLE_MARKDOWN = `# Markdown sample

- **bold** and _italic_ text
- [link](https://pi.local) with \`inline code\`

> block quote with themed border`;
const SAMPLE_CODE = `type Result = { ok: boolean; value?: number };

export function score(items: string[]): Result {
  const total = items.length + 42;
  return { ok: total > 0, value: total };
}`;

export const PI_THEME_FG_TOKENS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode"
] satisfies ThemeColor[];

export const PI_THEME_BG_TOKENS = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg"
] satisfies ThemeBgColor[];

export default function themePreviewExtension(api: ExtensionAPI): void {
  registerCommandWithAliases(
    api,
    "themes:preview",
    {
      description: "Preview and switch Pi themes with a live themed TUI showcase (usage: /themes:preview [theme-name])",
      handler: async (args, context) => {
        await handleThemePreviewCommand(context, args);
      }
    },
    []
  );
}

export async function handleThemePreviewCommand(context: ExtensionCommandContext, rawArgs: string): Promise<void> {
  let args: ThemePreviewArgs;
  try {
    args = parseThemePreviewArgs(rawArgs);
  } catch (error) {
    context.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return;
  }

  if (args.help) {
    context.ui.notify(buildThemePreviewUsage(), "info");
    return;
  }

  if (!context.hasUI) {
    context.ui.notify("/themes:preview requires interactive Pi UI mode.", "warning");
    return;
  }

  const themes = context.ui.getAllThemes();
  if (themes.length === 0) {
    context.ui.notify("No Pi themes are available to preview. Run /profile:doctor or check theme discovery diagnostics.", "error");
    return;
  }

  let selectedIndex: number;
  try {
    selectedIndex = resolveThemeIndex(themes, args.themeName, context.ui.theme.name);
  } catch (error) {
    context.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return;
  }

  const originalThemeName = context.ui.theme.name;
  const originalTheme = originalThemeName ? context.ui.getTheme(originalThemeName) : undefined;
  const state: MutableThemePreviewState = {
    themes,
    selectedIndex,
    originalThemeName
  };

  context.ui.setWidget(WIDGET_KEY, (_tui, theme) => new ThemePreviewWidget(state, theme), { placement: "belowEditor" });

  try {
    const result = await context.ui.custom<ThemePreviewResult>((tui, _theme, _keybindings, done) => {
      return new ThemePreviewComponent(context.ui, tui, state, originalTheme, done);
    });

    if (result.action === "applied") {
      context.ui.notify(`Theme set to ${result.themeName}.`, "info");
      return;
    }

    context.ui.notify(`Theme preview cancelled; restored ${result.themeName}.`, "info");
  } finally {
    context.ui.setStatus(STATUS_KEY, undefined);
    context.ui.setWidget(WIDGET_KEY, undefined);
  }
}

export function parseThemePreviewArgs(rawArgs: string): ThemePreviewArgs {
  const trimmed = rawArgs.trim();
  if (!trimmed || trimmed === "--help" || trimmed === "-h") {
    return { help: trimmed === "--help" || trimmed === "-h" };
  }

  if (trimmed.startsWith("-")) {
    throw new Error(`${buildThemePreviewUsage()}\n\nUnknown option: ${trimmed}`);
  }

  return { help: false, themeName: trimmed };
}

export function buildThemePreviewUsage(): string {
  return [
    "Usage: /themes:preview [theme-name]",
    "",
    "Opens a live Pi TUI theme showcase. Cycle with ←/→, ↑/↓, h/l, p/n, or Space.",
    "Enter keeps the selected theme and writes it to Pi settings; Esc, Ctrl+C, or q restores the original theme."
  ].join("\n");
}

export function resolveThemeIndex(themes: ThemeInfo[], requestedThemeName: string | undefined, currentThemeName: string | undefined): number {
  if (themes.length === 0) {
    throw new Error("No Pi themes are available.");
  }

  const targetName = requestedThemeName ?? currentThemeName;
  if (!targetName) {
    return 0;
  }

  const exactIndex = themes.findIndex((theme) => theme.name === targetName);
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const caseInsensitiveIndex = themes.findIndex((theme) => theme.name.toLowerCase() === targetName.toLowerCase());
  if (caseInsensitiveIndex >= 0) {
    return caseInsensitiveIndex;
  }

  if (!requestedThemeName) {
    return 0;
  }

  const suggestions = themes
    .filter((theme) => theme.name.toLowerCase().includes(requestedThemeName.toLowerCase()))
    .slice(0, 8)
    .map((theme) => theme.name);
  const suggestionText = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
  throw new Error(`Unknown Pi theme: ${requestedThemeName}.${suggestionText}`);
}

export function buildThemePreviewLines(
  theme: PreviewTheme,
  state: ThemePreviewRenderState,
  width: number,
  samples: PreviewSamples = {}
): string[] {
  const safeWidth = Math.max(32, width);
  const selectedTheme = state.themes[state.selectedIndex];
  const lines: string[] = [];

  addTop(lines, theme, safeWidth);
  addLine(lines, theme, safeWidth, theme.fg("accent", theme.bold("Pi Theme Preview")), "borderAccent");
  addLine(
    lines,
    theme,
    safeWidth,
    `${theme.fg("toolTitle", selectedTheme?.name ?? "(missing theme)")} ${theme.fg("muted", `(${state.selectedIndex + 1}/${state.themes.length})`)}`,
    "borderAccent"
  );
  addLine(lines, theme, safeWidth, theme.fg("dim", selectedTheme?.path ?? "built-in or in-memory theme"), "borderAccent");
  addLine(lines, theme, safeWidth, theme.fg("dim", "←/→ cycle • Enter keep • Esc/q restore • Home/End jump"), "borderAccent");
  if (state.error) {
    addLine(lines, theme, safeWidth, theme.fg("error", state.error), "borderAccent");
  }
  addDivider(lines, theme, safeWidth);

  addMessagesSection(lines, theme, safeWidth);
  addToolSection(lines, theme, safeWidth);
  addMarkdownSection(lines, theme, safeWidth, samples.markdownLines ?? renderMarkdownSample(innerWidth(safeWidth)));
  addDiffAndSyntaxSection(lines, theme, safeWidth, samples.codeLines ?? renderCodeSample());
  addThinkingSection(lines, theme, safeWidth);
  addWidgetFooterSection(lines, theme, safeWidth);
  addTokenSection(lines, theme, safeWidth);

  addLine(lines, theme, safeWidth, theme.fg("dim", `Original theme: ${state.originalThemeName ?? "unknown/in-memory"}`), "borderMuted");
  addBottom(lines, theme, safeWidth);
  return lines.map((line) => truncateToWidth(line, safeWidth, "", false));
}

class ThemePreviewComponent implements Component {
  constructor(
    private readonly ui: ExtensionUIContext,
    private readonly tui: TUI,
    private readonly state: MutableThemePreviewState,
    private readonly originalTheme: Theme | undefined,
    private readonly done: (result: ThemePreviewResult) => void
  ) {
    this.previewSelectedTheme();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q" || data === "Q") {
      const restoredName = this.restoreOriginalTheme();
      this.done({ action: "cancelled", themeName: restoredName });
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      this.commitSelectedTheme();
      return;
    }

    if (matchesKey(data, Key.left) || matchesKey(data, Key.up) || data === "h" || data === "H" || data === "p" || data === "P") {
      this.move(-1);
      return;
    }

    if (
      matchesKey(data, Key.right) ||
      matchesKey(data, Key.down) ||
      matchesKey(data, Key.space) ||
      data === "l" ||
      data === "L" ||
      data === "n" ||
      data === "N"
    ) {
      this.move(1);
      return;
    }

    if (matchesKey(data, Key.home) || data === "g") {
      this.setIndex(0);
      return;
    }

    if (matchesKey(data, Key.end) || data === "G") {
      this.setIndex(this.state.themes.length - 1);
    }
  }

  render(width: number): string[] {
    return buildThemePreviewLines(this.ui.theme, this.state, width);
  }

  invalidate(): void {}

  private move(delta: number): void {
    const next = (this.state.selectedIndex + delta + this.state.themes.length) % this.state.themes.length;
    this.setIndex(next);
  }

  private setIndex(index: number): void {
    this.state.selectedIndex = Math.max(0, Math.min(index, this.state.themes.length - 1));
    this.previewSelectedTheme();
  }

  private previewSelectedTheme(): void {
    const selectedTheme = this.state.themes[this.state.selectedIndex];
    if (!selectedTheme) {
      this.state.error = "Selected theme index is out of range.";
      this.tui.requestRender();
      return;
    }

    const theme = this.ui.getTheme(selectedTheme.name);
    if (!theme) {
      this.state.error = `Theme could not be loaded: ${selectedTheme.name}`;
      this.tui.requestRender();
      return;
    }

    const result = this.ui.setTheme(theme);
    this.state.error = result.success ? undefined : (result.error ?? `Theme could not be loaded: ${selectedTheme.name}`);
    this.updateStatus();
    this.tui.requestRender();
  }

  private commitSelectedTheme(): void {
    const selectedTheme = this.state.themes[this.state.selectedIndex];
    if (!selectedTheme) {
      this.state.error = "Selected theme index is out of range.";
      this.tui.requestRender();
      return;
    }

    const result = this.ui.setTheme(selectedTheme.name);
    if (!result.success) {
      this.state.error = result.error ?? `Theme could not be applied: ${selectedTheme.name}`;
      this.tui.requestRender();
      return;
    }

    this.done({ action: "applied", themeName: selectedTheme.name });
  }

  private restoreOriginalTheme(): string {
    if (this.state.originalThemeName) {
      const result = this.ui.setTheme(this.state.originalThemeName);
      if (result.success) {
        return this.state.originalThemeName;
      }
    }

    if (this.originalTheme) {
      this.ui.setTheme(this.originalTheme);
      return this.originalTheme.name ?? "original in-memory theme";
    }

    return "original theme";
  }

  private updateStatus(): void {
    const selectedTheme = this.state.themes[this.state.selectedIndex];
    if (!selectedTheme) {
      this.ui.setStatus(STATUS_KEY, this.ui.theme.fg("error", "theme-preview: missing theme"));
      return;
    }

    this.ui.setStatus(
      STATUS_KEY,
      this.ui.theme.fg("accent", `theme ${this.state.selectedIndex + 1}/${this.state.themes.length}: ${selectedTheme.name}`)
    );
  }
}

class ThemePreviewWidget implements Component {
  constructor(
    private readonly state: MutableThemePreviewState,
    private readonly theme: Theme
  ) {}

  render(width: number): string[] {
    const selectedTheme = this.state.themes[this.state.selectedIndex];
    const text = selectedTheme
      ? `theme-preview widget sample: ${selectedTheme.name} (${this.state.selectedIndex + 1}/${this.state.themes.length})`
      : "theme-preview widget sample: no selected theme";
    return [truncateToWidth(this.theme.bg("customMessageBg", this.theme.fg("customMessageLabel", text)), width, "…", true)];
  }

  invalidate(): void {}
}

function addMessagesSection(lines: string[], theme: PreviewTheme, width: number): void {
  addSection(lines, theme, width, "Messages, selections, and status colors");
  addLine(
    lines,
    theme,
    width,
    `${theme.fg("userMessageText", "user ▸")} Ask Pi to inspect a file and summarize the result.`,
    "border",
    "userMessageBg"
  );
  addLine(
    lines,
    theme,
    width,
    `${theme.fg("customMessageLabel", "extension ▸")} ${theme.fg("customMessageText", "review-subagent report ready")}`,
    "border",
    "customMessageBg"
  );
  addLine(
    lines,
    theme,
    width,
    `${theme.fg("accent", "› selected row")} ${theme.fg("muted", "in a picker/list")}`,
    "borderMuted",
    "selectedBg"
  );
  addLine(
    lines,
    theme,
    width,
    [
      theme.fg("success", "✓ success"),
      theme.fg("warning", "⚠ warning"),
      theme.fg("error", "✗ error"),
      theme.fg("muted", "muted"),
      theme.fg("dim", "dim"),
      theme.fg("thinkingText", "thinking text")
    ].join("  ")
  );
}

function addToolSection(lines: string[], theme: PreviewTheme, width: number): void {
  addSection(lines, theme, width, "Tool panels");
  addLine(lines, theme, width, `${theme.fg("toolTitle", "shell_start")} ${theme.fg("toolOutput", "running npm run validate…")}`, "border", "toolPendingBg");
  addLine(lines, theme, width, `${theme.fg("toolTitle", "read_many")} ${theme.fg("success", "✓ read 3 files")}`, "border", "toolSuccessBg");
  addLine(lines, theme, width, `${theme.fg("toolTitle", "web_fetch_many")} ${theme.fg("error", "✗ refused private-network URL")}`, "border", "toolErrorBg");
}

function addMarkdownSection(lines: string[], theme: PreviewTheme, width: number, markdownLines: string[]): void {
  addSection(lines, theme, width, "Markdown");
  for (const line of markdownLines.slice(0, 7)) {
    addLine(lines, theme, width, line);
  }
}

function addDiffAndSyntaxSection(lines: string[], theme: PreviewTheme, width: number, codeLines: string[]): void {
  addSection(lines, theme, width, "Diff and syntax highlighting");
  addLine(lines, theme, width, theme.fg("toolDiffAdded", "+ added high-contrast theme token"));
  addLine(lines, theme, width, theme.fg("toolDiffRemoved", "- removed low-contrast fallback"));
  addLine(lines, theme, width, theme.fg("toolDiffContext", "  unchanged context line"));
  for (const line of codeLines.slice(0, 5)) {
    addLine(lines, theme, width, line);
  }
}

function addThinkingSection(lines: string[], theme: PreviewTheme, width: number): void {
  addSection(lines, theme, width, "Thinking and shell borders");
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
  addWrappedChips(
    lines,
    theme,
    width,
    levels.map((level) => theme.getThinkingBorderColor(level)(` ${level} `))
  );
  addLine(lines, theme, width, theme.getBashModeBorderColor()(" bash mode border for ! commands "));
}

function addWidgetFooterSection(lines: string[], theme: PreviewTheme, width: number): void {
  addSection(lines, theme, width, "Widget, status, footer, and overlay examples");
  addLine(lines, theme, width, `${theme.fg("customMessageLabel", "widget ▸")} live preview widget is installed below the editor`, "border", "customMessageBg");
  addLine(lines, theme, width, `${theme.fg("accent", "footer status ▸")} theme-preview status is active while this panel is open`);
  addLine(lines, theme, width, `${theme.fg("borderAccent", "╭─ overlay ─╮")} ${theme.fg("muted", "modal/overlay border sample")}`);
  addLine(lines, theme, width, `${theme.fg("borderAccent", "╰───────────╯")} ${theme.fg("dim", "rendered inside the custom TUI preview")}`);
}

function addTokenSection(lines: string[], theme: PreviewTheme, width: number): void {
  addSection(lines, theme, width, "All 51 Pi color tokens");
  addLine(lines, theme, width, theme.fg("muted", "Foreground/content tokens"));
  addWrappedChips(
    lines,
    theme,
    width,
    PI_THEME_FG_TOKENS.map((token) => theme.fg(token, token))
  );
  addLine(lines, theme, width, theme.fg("muted", "Background tokens"));
  addWrappedChips(
    lines,
    theme,
    width,
    PI_THEME_BG_TOKENS.map((token) => theme.bg(token, ` ${token} `))
  );
}

function renderMarkdownSample(width: number): string[] {
  const markdown = new Markdown(SAMPLE_MARKDOWN, 0, 0, getMarkdownTheme());
  return markdown.render(width);
}

function renderCodeSample(): string[] {
  return highlightCode(SAMPLE_CODE, "typescript");
}

function addSection(lines: string[], theme: PreviewTheme, width: number, title: string): void {
  addDivider(lines, theme, width);
  addLine(lines, theme, width, theme.fg("accent", theme.bold(title)), "borderAccent");
}

function addTop(lines: string[], theme: PreviewTheme, width: number): void {
  lines.push(theme.fg("borderAccent", `╭${"─".repeat(Math.max(0, width - 2))}╮`));
}

function addBottom(lines: string[], theme: PreviewTheme, width: number): void {
  lines.push(theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`));
}

function addDivider(lines: string[], theme: PreviewTheme, width: number): void {
  addLine(lines, theme, width, theme.fg("borderMuted", "─".repeat(innerWidth(width))), "borderMuted");
}

function addLine(
  lines: string[],
  theme: PreviewTheme,
  width: number,
  content = "",
  borderColor: ThemeColor = "border",
  backgroundColor?: ThemeBgColor
): void {
  const inner = truncateToWidth(content, innerWidth(width), "…", true);
  const body = backgroundColor ? theme.bg(backgroundColor, inner) : inner;
  lines.push(`${theme.fg(borderColor, "│")}${body}${theme.fg(borderColor, "│")}`);
}

function addWrappedChips(lines: string[], theme: PreviewTheme, width: number, chips: string[]): void {
  for (const row of wrapChips(chips, Math.max(1, innerWidth(width)))) {
    addLine(lines, theme, width, row);
  }
}

function wrapChips(chips: string[], width: number): string[] {
  const rows: string[] = [];
  let row = "";
  let rowWidth = 0;

  for (const chip of chips) {
    const prefix = row ? "  " : "";
    const chipWidth = visibleWidth(prefix) + visibleWidth(chip);
    if (row && rowWidth + chipWidth > width) {
      rows.push(row);
      row = chip;
      rowWidth = visibleWidth(chip);
      continue;
    }

    row += prefix + chip;
    rowWidth += chipWidth;
  }

  if (row) {
    rows.push(row);
  }

  return rows;
}

function innerWidth(width: number): number {
  return Math.max(0, width - 2);
}
