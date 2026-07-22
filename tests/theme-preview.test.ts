import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import themePreviewExtension, {
  buildThemePreviewLines,
  buildThemePreviewUsage,
  handleThemePreviewCommand,
  parseThemePreviewArgs,
  PI_THEME_BG_TOKENS,
  PI_THEME_FG_TOKENS,
  resolveThemeIndex,
  type ThemePreviewRenderState
} from "../extensions/theme-preview/index.js";

type ThemeBgColor = Parameters<Theme["bg"]>[0];

type FakeCommand = {
  description?: string;
  handler: (args: string, context: ExtensionCommandContext) => Promise<void>;
};

type FakeApi = ExtensionAPI & {
  commands: Map<string, FakeCommand>;
};

type FakeUi = ExtensionUIContext & {
  notifications: Array<{ message: string; type?: "info" | "warning" | "error" }>;
};

const plainTheme = {
  fg(_color: ThemeColor, text: string): string {
    return text;
  },
  bg(_color: ThemeBgColor, text: string): string {
    return text;
  },
  bold(text: string): string {
    return text;
  },
  italic(text: string): string {
    return text;
  },
  underline(text: string): string {
    return text;
  },
  strikethrough(text: string): string {
    return text;
  },
  getThinkingBorderColor(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): (text: string) => string {
    return (text: string) => `${level}:${text}`;
  },
  getBashModeBorderColor(): (text: string) => string {
    return (text: string) => `bash:${text}`;
  }
};

function createFakeApi(): FakeApi {
  const commands = new Map<string, FakeCommand>();
  return {
    commands,
    registerCommand(name: string, command: FakeCommand): void {
      commands.set(name, command);
    },
    on(): void {},
    registerTool(): void {},
    registerMessageRenderer(): void {},
    registerShortcut(): void {},
    registerFlag(): void {},
    getFlag(): undefined {
      return undefined;
    },
    sendMessage(): void {},
    sendUserMessage(): void {},
    appendEntry(): void {},
    setSessionName(): void {},
    getSessionName(): undefined {
      return undefined;
    },
    setLabel(): void {},
    async exec() {
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    getActiveTools(): string[] {
      return [];
    },
    getAllTools(): [] {
      return [];
    },
    setActiveTools(): void {},
    getCommands(): [] {
      return [];
    },
    async setModel(): Promise<boolean> {
      return true;
    },
    getThinkingLevel() {
      return "off";
    },
    setThinkingLevel(): void {},
    registerProvider(): void {},
    unregisterProvider(): void {},
    events: { on(): void {}, off(): void {}, emit(): void {}, removeAllListeners(): void {} }
  } as unknown as FakeApi;
}

function createFakeUi(): FakeUi {
  const notifications: FakeUi["notifications"] = [];
  return {
    notifications,
    async select(): Promise<string | undefined> {
      return undefined;
    },
    async confirm(): Promise<boolean> {
      return false;
    },
    async input(): Promise<string | undefined> {
      return undefined;
    },
    notify(message: string, type?: "info" | "warning" | "error"): void {
      notifications.push({ message, type });
    },
    onTerminalInput(): () => void {
      return () => {};
    },
    setStatus(): void {},
    setWorkingMessage(): void {},
    setWorkingVisible(): void {},
    setWorkingIndicator(): void {},
    setHiddenThinkingLabel(): void {},
    setWidget(): void {},
    setFooter(): void {},
    setHeader(): void {},
    setTitle(): void {},
    async custom(): Promise<never> {
      throw new Error("custom UI should not be opened in this test");
    },
    pasteToEditor(): void {},
    setEditorText(): void {},
    getEditorText(): string {
      return "";
    },
    async editor(): Promise<string | undefined> {
      return undefined;
    },
    addAutocompleteProvider(): void {},
    setEditorComponent(): void {},
    getEditorComponent(): undefined {
      return undefined;
    },
    theme: { name: "dark" } as Theme,
    getAllThemes(): Array<{ name: string; path: string | undefined }> {
      return [
        { name: "dark", path: "/themes/dark.json" },
        { name: "light", path: "/themes/light.json" }
      ];
    },
    getTheme(): Theme | undefined {
      return undefined;
    },
    setTheme(): { success: boolean } {
      return { success: true };
    },
    getToolsExpanded(): boolean {
      return false;
    },
    setToolsExpanded(): void {}
  } as FakeUi;
}

test("theme-preview registers its slash command", () => {
  const api = createFakeApi();

  themePreviewExtension(api);

  assert.ok(api.commands.has("themes:preview"));
  assert.equal(api.commands.has("theme-preview"), false, "deprecated kebab alias removed");
  assert.match(api.commands.get("themes:preview")?.description ?? "", /Preview and switch Pi themes/);
});

test("theme token inventory covers all 51 Pi theme colors", () => {
  const allTokens = [...PI_THEME_FG_TOKENS, ...PI_THEME_BG_TOKENS];

  assert.equal(PI_THEME_FG_TOKENS.length, 45);
  assert.equal(PI_THEME_BG_TOKENS.length, 6);
  assert.equal(new Set(allTokens).size, 51);
  assert.ok(PI_THEME_FG_TOKENS.includes("thinkingXhigh"));
  assert.ok(PI_THEME_BG_TOKENS.includes("toolErrorBg"));
});

test("theme preview render includes major themed surfaces and respects width", () => {
  const state: ThemePreviewRenderState = {
    themes: [
      { name: "dark", path: "/themes/dark.json" },
      { name: "aleck-neon-contrast", path: "/Users/example/.pi/agent/themes/aleck-neon-contrast.json" }
    ],
    selectedIndex: 1,
    originalThemeName: "dark"
  };
  const width = 72;

  const lines = buildThemePreviewLines(plainTheme, state, width, {
    markdownLines: ["# Markdown sample", "- list item", "> quote"],
    codeLines: ["type Result = { ok: boolean }", "return { ok: true };"]
  });
  const rendered = lines.join("\n");

  assert.match(rendered, /Pi Theme Preview/);
  assert.match(rendered, /aleck-neon-contrast/);
  assert.match(rendered, /Messages, selections, and status colors/);
  assert.match(rendered, /Tool panels/);
  assert.match(rendered, /Markdown/);
  assert.match(rendered, /Diff and syntax highlighting/);
  assert.match(rendered, /Thinking and shell borders/);
  assert.match(rendered, /Widget, status, footer, and overlay examples/);
  assert.match(rendered, /All 51 Pi color tokens/);
  assert.match(rendered, /thinkingXhigh/);
  assert.match(rendered, /toolErrorBg/);

  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, line);
  }
});

test("theme preview argument and theme resolution helpers are explicit", () => {
  const themes = [
    { name: "dark", path: undefined },
    { name: "light", path: undefined },
    { name: "aleck-neon-contrast", path: undefined }
  ];

  assert.deepEqual(parseThemePreviewArgs(""), { help: false });
  assert.deepEqual(parseThemePreviewArgs("--help"), { help: true });
  assert.deepEqual(parseThemePreviewArgs("aleck-neon-contrast"), { help: false, themeName: "aleck-neon-contrast" });
  assert.equal(resolveThemeIndex(themes, undefined, "light"), 1);
  assert.equal(resolveThemeIndex(themes, "ALECK-NEON-CONTRAST", undefined), 2);
  assert.throws(() => parseThemePreviewArgs("--unknown"), /Unknown option/);
  assert.throws(() => resolveThemeIndex(themes, "missing", undefined), /Unknown Pi theme/);
  assert.match(buildThemePreviewUsage(), /Usage: \/themes:preview/);
});

test("theme preview reports non-interactive mode without opening custom UI", async () => {
  const ui = createFakeUi();
  const context = { hasUI: false, ui } as unknown as ExtensionCommandContext;

  await handleThemePreviewCommand(context, "");

  assert.deepEqual(ui.notifications, [{ message: "/themes:preview requires interactive Pi UI mode.", type: "warning" }]);
});
