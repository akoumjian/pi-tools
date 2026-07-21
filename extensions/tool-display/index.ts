import { readFileSync } from "node:fs";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionCommandContext, RegisteredCommand, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { findPiToolsConfigFile, readPiToolsJsonConfig } from "../_shared/config.js";
import { RetainedToolOutputSchemas } from "../_shared/tool-output.js";
import { inputJsonSchemaGuideline, outputJsonSchemaGuideline } from "../_shared/tool-prompt.js";

const DocumentParseSchema = Type.Object({
  path: Type.String({
    description: "Path to the document file to parse (PDF, DOCX, PPTX, XLSX, CSV, PNG, JPG, TIFF, WebP, etc.)"
  }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")], {
    default: "text",
    description: "Output format for the parsed document (default: text)"
  })),
  targetPages: Type.Optional(Type.String({
    description: 'Optional page selection for parsing, e.g. "1-5,10,15-20"'
  })),
  screenshotPages: Type.Optional(Type.String({
    description: 'Optional PDF page selection for screenshots, e.g. "1-3,8" or "all". Screenshots are generated only for PDF inputs and are saved as PNG files.'
  })),
  ocr: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("off")], {
    description: "OCR mode: auto uses LiteParse OCR behavior, off disables OCR for faster parsing"
  })),
  ocrLanguage: Type.Optional(Type.String({
    description: "Optional single OCR language code. Built-in Tesseract typically uses ISO 639-3 codes such as eng, deu, fra, jpn."
  })),
  ocrLanguages: Type.Optional(Type.Array(Type.String(), {
    minItems: 1,
    description: "Optional multiple OCR language codes."
  })),
  ocrServerUrl: Type.Optional(Type.String({
    description: "Optional HTTP OCR server URL implementing the LiteParse OCR API"
  })),
  numWorkers: Type.Optional(Type.Integer({
    minimum: 1,
    description: "Optional OCR worker count"
  })),
  maxPages: Type.Optional(Type.Integer({
    minimum: 1,
    description: "Maximum number of pages to parse"
  })),
  dpi: Type.Optional(Type.Integer({
    minimum: 72,
    description: "Rendering DPI for OCR and screenshots"
  })),
  preciseBoundingBox: Type.Optional(Type.Boolean({
    description: "Whether to compute precise bounding boxes"
  })),
  preserveSmallText: Type.Optional(Type.Boolean({
    description: "Whether to preserve very small text that would otherwise be filtered out"
  })),
  preserveLayoutAlignmentAcrossPages: Type.Optional(Type.Boolean({
    description: "Whether to preserve text alignment consistently across page boundaries"
  }))
}, { additionalProperties: false });

type DocumentParseInput = Static<typeof DocumentParseSchema>;

type DocumentParseDetails = {
  sourcePath: string;
  resolvedPath: string;
  outputFormat: "text" | "json";
  outputPath: string;
  outputDir: string;
  pageCount: number;
  screenshotCount: number;
  screenshotDir?: string;
  screenshotPathsPreview?: string[];
  warnings?: string[];
};

type RenderTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type RenderOptions = {
  expanded: boolean;
  isPartial?: boolean;
};

type DocparserToolModule = {
  registerDocumentParseTool(pi: ExtensionAPI): void;
};

type DocparserDoctorModule = {
  registerDoctorCommand(pi: ExtensionAPI): void;
};

type DeferredCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;

const DOCPARSER_DOCTOR_COMMAND_NAME = "docparser:doctor";

export type ToolDisplaySettings = {
  enableDisplayOverrides: boolean;
};

let originalDocumentParseToolPromise: Promise<ToolDefinition> | undefined;
let originalDocparserDoctorCommandPromise: Promise<DeferredCommand> | undefined;

export default function toolDisplayExtension(api: ExtensionAPI): void {
  registerDocumentParseDoctorCommand(api);
  api.registerTool(createDocumentParseTool(readToolDisplaySettings()));
}

export function createDocumentParseTool(settings: ToolDisplaySettings): ToolDefinition {
  const baseTool: ToolDefinition = {
    name: "document_parse",
    label: "Document Parse",
    description:
      "Parse local documents with bundled LiteParse support. Supports PDF, DOCX, PPTX, XLSX, CSV, and common images, with text/JSON output, page selection, OCR controls, bounding boxes, layout preservation, and optional PDF screenshots. Model-visible output reports the saved outputPath, format, page/screenshot counts, screenshot paths, and warnings; internal details include sourcePath, resolvedPath, outputDir, and the same handoff metadata.",
    promptSnippet:
      "Parse a local document path to saved text or JSON with page/OCR/layout options and optional PDF screenshots; returns outputPath and screenshot handoffs for read_many.",
    promptGuidelines: [
      "document_parse use: Use document_parse instead of composing LiteParse CLI commands when local PDF, DOCX, PPTX, XLSX, CSV, image OCR, layout, bounding-box, or screenshot extraction is needed.",
      inputJsonSchemaGuideline("document_parse", DocumentParseSchema),
      outputJsonSchemaGuideline("document_parse", RetainedToolOutputSchemas.document_parse),
      "document_parse constraints: Use read_many on outputPath or screenshots for complete content. Use document_parse for local image inspection in the current text-file-only read_many profile. If host parser dependencies are missing, direct the user to /docparser:doctor. Only result content is provider-visible; details are internal; progress and early cancellation may use empty details, and thrown errors use the host's out-of-band error result."
    ],
    parameters: DocumentParseSchema,
    executionMode: "parallel",
    async execute(toolCallId, params, signal, onUpdate, context): Promise<AgentToolResult<DocumentParseDetails>> {
      const original = await getOriginalDocumentParseTool();
      const result = await original.execute(toolCallId, params, signal, onUpdate as never, context) as AgentToolResult<DocumentParseDetails>;
      return adaptDocumentParseResultHandoff(result);
    }
  };

  if (!settings.enableDisplayOverrides) {
    return baseTool;
  }

  return {
    ...baseTool,
    renderShell: "self",
    renderCall(args, theme) {
      return new Text(claudeToolCall("Parse", formatDocumentParseCall(args as DocumentParseInput), theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return renderDocumentParseResult(result as AgentToolResult<DocumentParseDetails>, options as RenderOptions, theme, context as { isError?: boolean } | undefined);
    }
  };
}

export function adaptDocumentParseResultHandoff(result: AgentToolResult<DocumentParseDetails>): AgentToolResult<DocumentParseDetails> {
  return {
    ...result,
    content: result.content.map((part) => part.type === "text"
      ? {
          ...part,
          text: part.text.replace(
            /Preview truncated\. Use read on (.+) for the full parsed output\./g,
            'Preview truncated. Use read_many with files: [{ path: "$1" }] for the full parsed output.'
          )
        }
      : part)
  };
}

export function readToolDisplaySettings(settingsPath?: string | URL): ToolDisplaySettings {
  const resolvedPath = settingsPath ?? findPiToolsConfigFile("tool-display-settings.json", import.meta.url);
  if (resolvedPath === undefined) {
    throw new Error("config/tool-display-settings.json was not found.");
  }

  const parsed = settingsPath
    ? JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<ToolDisplaySettings>
    : readPiToolsJsonConfig("tool-display-settings.json", import.meta.url) as Partial<ToolDisplaySettings> | undefined;
  if (typeof parsed?.enableDisplayOverrides !== "boolean") {
    throw new Error(`${resolvedPath.toString()} must define boolean enableDisplayOverrides.`);
  }
  return { enableDisplayOverrides: parsed.enableDisplayOverrides };
}

function registerDocumentParseDoctorCommand(api: ExtensionAPI): void {
  api.registerCommand(DOCPARSER_DOCTOR_COMMAND_NAME, {
    description: "Diagnose document_parse host dependencies and optional setup steps",
    handler: async (args: string, context: ExtensionCommandContext): Promise<void> => {
      const command = await getOriginalDocparserDoctorCommand();
      await command.handler(args, context);
    }
  });
}

async function getOriginalDocumentParseTool(): Promise<ToolDefinition> {
  originalDocumentParseToolPromise ??= captureOriginalDocumentParseTool();
  return originalDocumentParseToolPromise;
}

async function captureOriginalDocumentParseTool(): Promise<ToolDefinition> {
  const modulePath = "pi-docparser/extensions/docparser/tool.ts";
  const module = await import(modulePath) as DocparserToolModule;
  let captured: ToolDefinition | undefined;
  module.registerDocumentParseTool({
    registerTool(tool: ToolDefinition): void {
      captured = tool;
    }
  } as ExtensionAPI);

  if (captured === undefined) {
    throw new Error("Failed to capture document_parse tool for display override.");
  }

  return captured;
}

async function getOriginalDocparserDoctorCommand(): Promise<DeferredCommand> {
  originalDocparserDoctorCommandPromise ??= captureOriginalDocparserDoctorCommand();
  return originalDocparserDoctorCommandPromise;
}

async function captureOriginalDocparserDoctorCommand(): Promise<DeferredCommand> {
  const modulePath = "pi-docparser/extensions/docparser/doctor.ts";
  const module = await import(modulePath) as DocparserDoctorModule;
  let captured: DeferredCommand | undefined;
  module.registerDoctorCommand({
    registerCommand(name: string, command: DeferredCommand): void {
      if (name === DOCPARSER_DOCTOR_COMMAND_NAME) {
        captured = command;
      }
    }
  } as ExtensionAPI);

  if (captured === undefined) {
    throw new Error("Failed to capture /docparser:doctor command from pi-docparser.");
  }

  return captured;
}

function renderDocumentParseResult(result: AgentToolResult<DocumentParseDetails>, options: RenderOptions, theme: RenderTheme, context?: { isError?: boolean }): Text {
  if (context?.isError === true) {
    const text = result.content
      .map((item) => item.type === "text" ? item.text : "")
      .join("\n")
      .trim();
    const oneLine = text.replace(/\s+/g, " ").trim();
    const summary = oneLine.length === 0 ? "Tool failed." : (oneLine.length <= 160 ? oneLine : `${oneLine.slice(0, 157)}...`);
    return new Text(claudeToolResult(`error: ${summary}`, "error", theme), 0, 0);
  }

  if (options.isPartial || result.details?.outputPath === undefined) {
    return new Text(claudeToolResult(compactProgressText(result), "warning", theme), 0, 0);
  }

  const details = result.details;
  const pieces = [
    `${details.pageCount} page${details.pageCount === 1 ? "" : "s"}`,
    details.outputFormat,
    compactPath(details.outputPath)
  ];
  if (details.screenshotCount > 0) {
    pieces.push(`${details.screenshotCount} screenshot${details.screenshotCount === 1 ? "" : "s"}`);
  }
  if ((details.warnings?.length ?? 0) > 0) {
    pieces.push(`${details.warnings?.length ?? 0} warning${details.warnings?.length === 1 ? "" : "s"}`);
  }

  return new Text(claudeToolResult(pieces.join(" · "), "success", theme), 0, 0);
}

function compactProgressText(result: AgentToolResult<DocumentParseDetails>): string {
  const text = result.content
    ?.map((item) => item.type === "text" ? item.text : "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase() ?? "";

  if (text.includes("dependenc")) {
    return "checking dependencies";
  }
  if (text.includes("liteparse")) {
    return "loading parser";
  }
  if (text.includes("screenshot")) {
    return "rendering screenshots";
  }
  if (text.includes("saved")) {
    return "saving parsed output";
  }
  if (text.includes("parse") || text.includes("parsing")) {
    return "parsing document";
  }
  if (text.includes("cancel")) {
    return "cancelled";
  }
  return "parsing document";
}

function formatDocumentParseCall(input: DocumentParseInput): string {
  const pieces = [compactPath(input.path)];
  if (input.targetPages !== undefined) {
    pieces.push(`pages ${input.targetPages}`);
  }
  if (input.screenshotPages !== undefined) {
    pieces.push(`screenshots ${input.screenshotPages}`);
  }
  if (input.format !== undefined) {
    pieces.push(input.format);
  }
  return pieces.join(" · ");
}

function claudeToolCall(name: string, summary: string, theme: RenderTheme): string {
  return theme.fg("toolTitle", `⏺ ${theme.bold(name)}(`) + theme.fg("accent", summary) + theme.fg("toolTitle", ")…");
}

function claudeToolResult(summary: string, color: string, theme: RenderTheme): string {
  return theme.fg("muted", "⎿ ") + theme.fg(color, summary);
}

function compactPath(rawPath: string): string {
  return truncateMiddle(rawPath.replace(/\\/g, "/"), 72);
}

function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const keep = maxLength - 3;
  const start = Math.ceil(keep * 0.55);
  const end = keep - start;
  return `${text.slice(0, start)}...${text.slice(text.length - end)}`;
}
