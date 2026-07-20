import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
  withFileMutationQueue
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerCommandWithAliases } from "../_shared/deprecated-command.js";

type TruncationDetails = {
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
  nextOffset?: number;
};

type ReadFileDetails = {
  path: string;
  resolvedPath: string;
  offset: number;
  requestedLimit?: number;
  truncation: TruncationDetails;
  previewLines: string[];
};

type ReadFileResult = ReadFileDetails & {
  content: string;
};

type ReadManyDetails = {
  files: ReadFileDetails[];
};

type SearchKind = "content" | "files";

type SearchResultDetails = {
  kind: SearchKind;
  path: string;
  resolvedPath: string;
  pattern?: string;
  glob?: string;
  context: number;
  maxResults: number;
  outputLines: number;
  truncated: boolean;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  previewLines: string[];
};

type SearchResult = SearchResultDetails & {
  output: string;
};

type SearchManyDetails = {
  searches: SearchResultDetails[];
};

type LineRange = {
  startLine: number;
  endLine: number;
};

type RgResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  truncated: boolean;
};

type WriteFileDetails = {
  id: string;
  scopedId?: string;
  path: string;
  resolvedPath: string;
  bytes: number;
  lines: number;
};

type MutationReviewPartialDetails = {
  pendingId: string;
  blocked: Array<{
    id: string;
    path: string;
    kind: string;
  }>;
  summary: string;
};

type WriteManyDetails = {
  files: WriteFileDetails[];
  mutationReview?: MutationReviewPartialDetails;
};

type EditFileDetails = {
  id: string;
  scopedId?: string;
  path: string;
  resolvedPath: string;
  replacements: number;
  ranges: LineRange[];
  bytesBefore: number;
  bytesAfter: number;
};

type EditManyDetails = {
  files: EditFileDetails[];
  mutationReview?: MutationReviewPartialDetails;
};

type Replacement = {
  oldText: string;
  newText: string;
};

type PlannedReplacement = Replacement & {
  start: number;
  end: number;
};

type ReplacementResult = {
  content: string;
  ranges: LineRange[];
};

const MAX_SEARCH_BYTES = 120 * 1024;
const MAX_SEARCH_STDERR_BYTES = 16 * 1024;
const MAX_BATCH_ITEMS = 24;

const ReadItem = Type.Object({
  path: Type.String({
    minLength: 1,
    description: "File path to read, relative to the active Pi cwd or absolute."
  }),
  offset: Type.Optional(Type.Number({
    minimum: 1,
    description: "1-indexed line number to start from. Use returned nextOffset to continue a truncated file."
  })),
  limit: Type.Optional(Type.Number({
    minimum: 1,
    description: "Maximum lines to read from this file. Omit to read from offset through the end of the file."
  }))
}, { additionalProperties: false });

const ReadManyParams = Type.Object({
  files: Type.Array(ReadItem, {
    minItems: 1,
    maxItems: MAX_BATCH_ITEMS,
    description: "List of files to read in one call. Use one item for a single file. Independent reads run in parallel."
  })
}, { additionalProperties: false });

const SearchItem = Type.Object({
  kind: Type.Union([Type.Literal("content"), Type.Literal("files")], {
    description: "Search kind. Use content for rg text search with line numbers; use files for rg --files file discovery."
  }),
  pattern: Type.Optional(Type.String({
    minLength: 1,
    description: "Text or regex pattern for kind=content. Required for content searches; omit for kind=files."
  })),
  path: Type.Optional(Type.String({
    minLength: 1,
    description: "Directory or file to search, relative to the active Pi cwd or absolute. Defaults to '.'."
  })),
  glob: Type.Optional(Type.String({
    minLength: 1,
    description: "Optional rg glob such as '*.ts', 'src/**', or '!dist/**'."
  })),
  context: Type.Optional(Type.Number({
    minimum: 0,
    maximum: 10,
    default: 0,
    description: "Context lines before and after each content match."
  })),
  maxResults: Type.Optional(Type.Number({
    minimum: 1,
    maximum: 1000,
    default: 100,
    description: "Maximum output lines returned for this search after rg completes or output is capped."
  })),
  ignoreCase: Type.Optional(Type.Boolean({
    default: false,
    description: "Use case-insensitive content search."
  })),
  literal: Type.Optional(Type.Boolean({
    default: false,
    description: "Treat pattern as literal text instead of a regex for content search."
  }))
}, { additionalProperties: false });

const SearchManyParams = Type.Object({
  searches: Type.Array(SearchItem, {
    minItems: 1,
    maxItems: MAX_BATCH_ITEMS,
    description: "List of rg-backed searches to run in one call. Use search_many before read_many when discovering files, symbols, definitions, references, or where relevant code lives."
  })
}, { additionalProperties: false });

const WriteItem = Type.Object({
  path: Type.String({
    minLength: 1,
    description: "File path to create or overwrite, relative to the active Pi cwd or absolute."
  }),
  content: Type.String({
    description: "Complete file contents to write."
  })
}, { additionalProperties: false });

const WriteManyParams = Type.Object({
  writes: Type.Array(WriteItem, {
    minItems: 1,
    maxItems: MAX_BATCH_ITEMS,
    description: "List of complete-file writes to perform in one call. Use one item for a single write."
  })
}, { additionalProperties: false });

const ReplacementItem = Type.Object({
  oldText: Type.String({
    minLength: 1,
    description: "Exact text to replace. It must occur exactly once in the original file and must not overlap another replacement in the same file."
  }),
  newText: Type.String({
    description: "Replacement text."
  })
}, { additionalProperties: false });

const EditFileItem = Type.Object({
  path: Type.String({
    minLength: 1,
    description: "Existing file path to edit, relative to the active Pi cwd or absolute."
  }),
  edits: Type.Array(ReplacementItem, {
    minItems: 1,
    maxItems: 50,
    description: "Exact replacements for this file. All oldText matches are found in the original file, not after earlier replacements."
  })
}, { additionalProperties: false });

const EditManyParams = Type.Object({
  files: Type.Array(EditFileItem, {
    minItems: 1,
    maxItems: MAX_BATCH_ITEMS,
    description: "List of files to edit in one call. Use one item for a single file. Independent files run in parallel."
  })
}, { additionalProperties: false });

const BashParams = Type.Object({
  command: Type.String({ description: "Disabled. Use shell_start with commands: [...] instead." }),
  timeout: Type.Optional(Type.Number({ description: "Disabled. shell_start uses a fixed short quick-command wait and async completion notices for unfinished jobs." }))
}, { additionalProperties: false });

export type ReadManyInput = Static<typeof ReadManyParams>;
export type SearchManyInput = Static<typeof SearchManyParams>;
export type WriteManyInput = Static<typeof WriteManyParams>;
export type EditManyInput = Static<typeof EditManyParams>;

export type NativeMutationEntry =
  | { kind: "write"; path: string; content: string }
  | { kind: "edit"; path: string; edits: Array<{ oldText: string; newText: string }> };

const BANNED_DEFAULT_TOOL_NAMES = ["bash", "read", "edit", "write"] as const;
const STOCK_TOOL_REPLACEMENT_GROUPS = [
  {
    stockTool: "bash",
    replacementTools: ["shell_start", "shell_status", "shell_read", "shell_cancel"]
  },
  {
    stockTool: "read",
    replacementTools: ["read_many", "search_many"]
  },
  {
    stockTool: "write",
    replacementTools: ["write_many"]
  },
  {
    stockTool: "edit",
    replacementTools: ["edit_many"]
  }
] as const;
const OPTIONAL_DEFAULT_TOOL_NAMES = ["web_fetch_many"] as const;
const DEFAULT_ACTIVE_TOOL_NAMES = [
  "read_many",
  "search_many",
  "write_many",
  "edit_many",
  "web_fetch_many",
  "shell_start",
  "shell_status",
  "shell_read",
  "shell_cancel"
] as const;

export type DefaultToolPolicyReport = {
  ok: boolean;
  changed: boolean;
  activeBefore: string[];
  activeAfter: string[];
  availableTools: string[];
  removedBannedTools: string[];
  addedReplacementTools: string[];
  bannedActiveAfter: string[];
  missingReplacementTools: string[];
};

type DefaultToolPolicyOptions = {
  strict?: boolean;
  notifyWhenChanged?: boolean;
  context?: Pick<ExtensionContext, "hasUI" | "ui">;
};

let strictReplacementNotificationShown = false;

export default function nativeToolsExtension(api: ExtensionAPI): void {
  registerDisabledBashTool(api);
  registerBatchTools(api);
  registerNativeToolsStatusCommand(api);
  registerDefaultToolPolicy(api);
  registerStockToolGuard(api);
  registerPromptAdapter(api);
}

function registerDisabledBashTool(api: ExtensionAPI): void {
  api.registerTool(defineTool({
    name: "bash",
    label: "bash disabled",
    description: "Disabled in this setup. Use shell_start with commands: [...] for all shell work; it returns a separate jobId for each command and can auto-resume the agent when jobs finish.",
    parameters: BashParams,
    executionMode: "parallel",
    async execute() {
      throw new Error("The bash tool is disabled in this Pi setup. Use shell_start with commands: [...] instead.");
    }
  }));
}

function registerBatchTools(api: ExtensionAPI): void {
  api.registerTool(defineTool({
    name: "read_many",
    label: "Read Many",
    description: [
      "Read known text file ranges in one parallel-capable tool call. Always pass files: [...]; use a one-item list for a single text file when batch shape is convenient. Batch independent file reads together instead of making serial read_many calls.",
      "Do not use read_many to discover files, scan a repository, or load many large files speculatively. Use search_many first for structured rg-backed file discovery/content search, or shell_start with rg/rg --files/find/git grep when custom shell inspection is needed.",
      "Each item accepts { path, offset?, limit? }. Omit limit when full remaining file contents are actually needed. Output is grouped by file. Result details shape: { files: [{ path, resolvedPath, offset, requestedLimit?, truncation: { truncated, truncatedBy, totalLines, outputLines, totalBytes, outputBytes, nextOffset? } }] }.",
      "Use offset as a 1-indexed starting line and limit as the maximum lines for that file. For huge files, continue with the returned nextOffset."
    ].join(" "),
    promptSnippet: "Read known text file paths and ranges in one batched files:[...] call; returns grouped content and continuation offsets.",
    promptGuidelines: [
      "read_many use: Use read_many for known text file paths or ranges; use search_many first for repository, file, symbol, definition, reference, call-site, or likely edit-location discovery.",
      "read_many input: Schema: closed { files: closed { path: string(minLength=1), offset?: number(min=1), limit?: number(min=1) }[1..24] }. Batch independent known files/ranges together. Offsets are 1-indexed; omit limit only when the complete remainder is actually needed.",
      "read_many output: Schema: { content: text(file count plus, per file, path, returned start-end/total lines, requested text, and nextOffset? when truncated), details: { files: [{ path, resolvedPath, offset, requestedLimit?, truncation: { truncated, truncatedBy: \"lines\" | \"bytes\" | null, totalLines, outputLines, totalBytes, outputBytes, nextOffset? }, previewLines }] }, isError?: boolean }. Only content is provider-visible.",
      "read_many constraints: Do not speculatively scan or load many large files, and do not make serial single-file read_many calls when one batched call can cover independent reads."
    ],
    parameters: ReadManyParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_toolCallId, params, _signal, _onUpdate, context): Promise<AgentToolResult<ReadManyDetails>> {
      return readMany(context, params);
    },
    renderCall(args, theme) {
      return renderReadManyCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderReadManyResult(result, options, theme, context);
    }
  }));

  api.registerTool(defineTool({
    name: "search_many",
    label: "Search Many",
    description: [
      "Run structured ripgrep searches in one parallel-capable tool call. Prefer this before read_many when discovering files, symbols, definitions, references, call sites, or likely edit locations. Put independent searches in one searches array instead of making serial search_many calls.",
      "Each item accepts { kind, pattern?, path?, glob?, context?, maxResults?, ignoreCase?, literal? }. Use kind='content' for rg text search with line/column numbers; use kind='files' for rg --files file discovery. path defaults to '.'.",
      "Examples: { kind: 'files', path: '.', glob: '*.ts', maxResults: 200 }; { kind: 'content', pattern: 'evaluateAsyncShellStart', path: 'extensions', glob: '*.ts', context: 2, maxResults: 80 }.",
      "Result details shape: { searches: [{ kind, path, resolvedPath, pattern?, glob?, context, maxResults, outputLines, truncated, exitCode, signal? }] }. After search_many identifies specific paths and line ranges, use read_many with offset/limit to inspect only the needed regions."
    ].join(" "),
    promptSnippet: "Discover files and search repository content with one batched searches:[...] ripgrep call; returns grouped matches and truncation notices.",
    promptGuidelines: [
      "search_many use: Prefer search_many before read_many when discovering files, symbols, definitions, references, call sites, or likely edit locations; inspect the narrowed known paths/ranges with read_many afterward.",
      "search_many input: Schema: closed { searches: closed { kind: \"content\" | \"files\", pattern?: string(minLength=1), path?: string(minLength=1), glob?: string(minLength=1), context?: number(0..10, default=0), maxResults?: number(1..1000, default=100), ignoreCase?: boolean(default=false), literal?: boolean(default=false) }[1..24] }; pattern is required for content and omitted for files, and path defaults to \".\" at execution. Batch independent searches.",
      "search_many output: Schema: { content: text(search count plus grouped index/kind/pattern/path/glob?/returned-line-count/rg-output-or-no-matches and explicit truncation notice), details: { searches: [{ kind, path, resolvedPath, pattern?, glob?, context, maxResults, outputLines, truncated, exitCode, signal?, previewLines }] }, isError?: boolean }. Only content is provider-visible; narrow or raise maxResults before reading identified ranges.",
      "search_many constraints: Use structured search_many for normal discovery instead of serial shell searches; use shell_start only when custom rg/find/git-grep inspection is actually needed."
    ],
    parameters: SearchManyParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_toolCallId, params, _signal, _onUpdate, context): Promise<AgentToolResult<SearchManyDetails>> {
      return searchMany(context, params);
    },
    renderCall(args, theme) {
      return renderSearchManyCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderSearchManyResult(result, options, theme, context);
    }
  }));

  api.registerTool(defineTool({
    name: "write_many",
    label: "Write Many",
    description: [
      "Create or completely overwrite multiple files in one parallel-capable tool call. Always pass writes: [...]; use a one-item list for a single full-file write.",
      "Each item accepts { path, content }. Parent directories are created. Do not use this for small edits to existing files; use edit_many.",
      "Result details shape: { files: [{ id, scopedId?, path, resolvedPath, bytes, lines }] }, where id is a short content-derived mutation entry id."
    ].join(" "),
    promptSnippet: "Create or completely overwrite files with one batched writes:[...] call; returns mutation ids, paths, byte counts, and line counts.",
    promptGuidelines: [
      "write_many use: Use write_many for new files or intentional complete-file overwrites; use edit_many for small or precise changes to existing files.",
      "write_many input: Schema: closed { writes: closed { path: string(minLength=1), content: string }[1..24] }. Batch independent complete-file writes; content is the entire resulting file and parent directories are created.",
      "write_many output: Schema: { content: text(written file count plus each mutation id/path/byte count, or partial-review blocked ids/paths/kinds, reviewer summary, pending id/fingerprint, and apply-or-revise guidance), details: { files: [{ id, scopedId?, path, resolvedPath, bytes, lines }], mutationReview?: { pendingId, blocked: [{ id, path, kind }], summary } }, isError?: boolean }. Only content is provider-visible; line counts/resolved paths remain internal.",
      "write_many constraints: Do not use write_many for a small edit to an existing file, and do not repeat a blocked large mutation when apply_reviewed_mutation can use its pending id."
    ],
    parameters: WriteManyParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(toolCallId, params, _signal, _onUpdate, context): Promise<AgentToolResult<WriteManyDetails>> {
      return writeMany(context, params, toolCallId);
    },
    renderCall(args, theme) {
      return renderWriteManyCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderWriteManyResult(result, options, theme, context);
    }
  }));

  api.registerTool(defineTool({
    name: "edit_many",
    label: "Edit Many",
    description: [
      "Edit multiple existing files in one parallel-capable tool call. Always pass files: [...]; use a one-item list for a single file when batch shape is convenient.",
      "Each file item accepts { path, edits: [{ oldText, newText }] }. Every oldText must occur exactly once in that file's original content; replacements in the same file must not overlap.",
      "Use for precise changes across files. Result details shape: { files: [{ id, scopedId?, path, resolvedPath, replacements, ranges: [{ startLine, endLine }], bytesBefore, bytesAfter }] }, where id is a short content-derived mutation entry id."
    ].join(" "),
    promptSnippet: "Apply exact text replacements across existing files with one batched files:[...] call; returns mutation ids, paths, replacement counts, and ranges.",
    promptGuidelines: [
      "edit_many use: Use edit_many for precise exact-text changes to existing files; use write_many only for new files or complete overwrites.",
      "edit_many input: Schema: closed { files: closed { path: string(minLength=1), edits: closed { oldText: string(minLength=1), newText: string }[1..50] }[1..24] }. Batch independent files; each oldText must occur exactly once in the original file and same-file replacements must not overlap.",
      "edit_many output: Schema: { content: text(edited file count plus each mutation id/path/replacement count, or partial-review blocked ids/paths/kinds, reviewer summary, pending id/fingerprint, and apply-or-revise guidance), details: { files: [{ id, scopedId?, path, resolvedPath, replacements, ranges: [{ startLine, endLine }], bytesBefore, bytesAfter }], mutationReview?: { pendingId, blocked: [{ id, path, kind }], summary } }, isError?: boolean }. Only content is provider-visible; ranges/byte counts/resolved paths remain internal.",
      "edit_many constraints: Keep replacements exact and non-overlapping, and do not repeat a blocked large mutation when apply_reviewed_mutation can use its pending id."
    ],
    parameters: EditManyParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(toolCallId, params, _signal, _onUpdate, context): Promise<AgentToolResult<EditManyDetails>> {
      return editMany(context, params, toolCallId);
    },
    renderCall(args, theme) {
      return renderEditManyCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderEditManyResult(result, options, theme, context);
    }
  }));
}

function registerNativeToolsStatusCommand(api: ExtensionAPI): void {
  registerCommandWithAliases(
    api,
    "native:status",
    {
      description: "Show native/batch tool replacement status",
      handler: async (_args, context) => {
        context.ui.notify(buildNativeToolsStatusText(api), nativeToolPolicyReport(api).ok ? "info" : "error");
      }
    },
    []
  );
}

function registerDefaultToolPolicy(api: ExtensionAPI): void {
  api.on("session_start", (_event, context) => {
    strictReplacementNotificationShown = false;
    enforceDefaultTools(api, { strict: true, notifyWhenChanged: true, context });
  });

  api.on("session_tree", (_event, context) => {
    enforceDefaultTools(api, { strict: true, notifyWhenChanged: true, context });
  });

  // input runs before Pi expands skills/templates and snapshots the base prompt.
  // Reconcile here so selectedTools, snippets, guidelines, and provider tools agree
  // for the same turn rather than mutating the tool set in before_agent_start.
  api.on("input", (_event, context) => {
    enforceDefaultTools(api, { strict: true, notifyWhenChanged: true, context });
  });
}

function registerStockToolGuard(api: ExtensionAPI): void {
  const replacements: Record<string, string> = {
    bash: "shell_start",
    read: "search_many or read_many",
    write: "write_many",
    edit: "edit_many"
  };
  api.on("tool_call", (event) => {
    const replacement = replacements[event.toolName];
    if (replacement === undefined) {
      return undefined;
    }
    return {
      block: true,
      reason: `The stock ${event.toolName} tool is disabled in this setup. Use ${replacement} instead.`
    };
  });
}

function registerPromptAdapter(api: ExtensionAPI): void {
  api.on("before_agent_start", (event) => {
    const systemPrompt = buildNativeToolsSystemPrompt(event.systemPrompt, event.systemPromptOptions.skills ?? []);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });
}

export function enforceDefaultTools(api: ExtensionAPI, options: DefaultToolPolicyOptions = {}): DefaultToolPolicyReport {
  const activeBefore = api.getActiveTools();
  const availableTools = api.getAllTools().map((tool) => tool.name);
  const available = new Set(availableTools);
  const banned = new Set<string>(BANNED_DEFAULT_TOOL_NAMES);
  const wanted = activeBefore.filter((toolName) => !banned.has(toolName));

  for (const toolName of DEFAULT_ACTIVE_TOOL_NAMES) {
    if (available.has(toolName) && !wanted.includes(toolName)) {
      wanted.push(toolName);
    }
  }

  if (wanted.join("\0") !== activeBefore.join("\0")) {
    api.setActiveTools(wanted);
  }

  const activeAfter = api.getActiveTools();
  const report = buildDefaultToolPolicyReport(activeBefore, activeAfter, availableTools);
  if (options.notifyWhenChanged === true) {
    notifyStrictReplacementApplied(report, options.context);
  }
  if (options.strict === true && !report.ok) {
    throw new Error(defaultToolPolicyError(report));
  }
  return report;
}

export function nativeToolPolicyReport(api: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">): DefaultToolPolicyReport {
  return buildDefaultToolPolicyReport(api.getActiveTools(), api.getActiveTools(), api.getAllTools().map((tool) => tool.name));
}

function buildDefaultToolPolicyReport(activeBefore: string[], activeAfter: string[], availableTools: string[]): DefaultToolPolicyReport {
  const activeBeforeSet = new Set(activeBefore);
  const activeAfterSet = new Set(activeAfter);
  const available = new Set(availableTools);
  const removedBannedTools = BANNED_DEFAULT_TOOL_NAMES.filter((toolName) => activeBeforeSet.has(toolName) && !activeAfterSet.has(toolName));
  const addedReplacementTools = DEFAULT_ACTIVE_TOOL_NAMES.filter((toolName) => !activeBeforeSet.has(toolName) && activeAfterSet.has(toolName));
  const bannedActiveAfter = BANNED_DEFAULT_TOOL_NAMES.filter((toolName) => activeAfterSet.has(toolName));
  const missingReplacementTools = requiredReplacementToolsForActiveStockTools(activeBefore, activeAfter)
    .filter((toolName) => !available.has(toolName));
  return {
    ok: bannedActiveAfter.length === 0 && missingReplacementTools.length === 0,
    changed: activeBefore.join("\0") !== activeAfter.join("\0"),
    activeBefore,
    activeAfter,
    availableTools,
    removedBannedTools,
    addedReplacementTools,
    bannedActiveAfter,
    missingReplacementTools
  };
}

function requiredReplacementToolsForActiveStockTools(activeBefore: string[], activeAfter: string[]): string[] {
  const active = new Set([...activeBefore, ...activeAfter]);
  const required: string[] = [];
  for (const group of STOCK_TOOL_REPLACEMENT_GROUPS) {
    if (!active.has(group.stockTool)) {
      continue;
    }
    for (const toolName of group.replacementTools) {
      if (!required.includes(toolName)) {
        required.push(toolName);
      }
    }
  }
  return required;
}

function notifyStrictReplacementApplied(report: DefaultToolPolicyReport, context: Pick<ExtensionContext, "hasUI" | "ui"> | undefined): void {
  if (!report.changed || strictReplacementNotificationShown || context?.hasUI !== true) {
    return;
  }
  strictReplacementNotificationShown = true;
  const removed = report.removedBannedTools.length > 0 ? `removed ${report.removedBannedTools.join(", ")}` : "no banned tools removed";
  const added = report.addedReplacementTools.length > 0 ? `activated ${report.addedReplacementTools.join(", ")}` : "no replacements activated";
  context.ui.notify(`Native tools strict replacement applied: ${removed}; ${added}.`, "info");
}

function defaultToolPolicyError(report: DefaultToolPolicyReport): string {
  const details = [
    report.bannedActiveAfter.length > 0 ? `banned stock tools still active: ${report.bannedActiveAfter.join(", ")}` : undefined,
    report.missingReplacementTools.length > 0 ? `required replacement tools missing: ${report.missingReplacementTools.join(", ")}` : undefined
  ].filter((line): line is string => line !== undefined);
  return [
    "Native tools strict replacement failed.",
    ...details,
    "Expected stock bash/read/write/edit to be inactive. Replacement tools are required only for stock capabilities that were active in this profile: bash -> shell_*, read -> read_many/search_many, write -> write_many, edit -> edit_many.",
    "Run /native:status and /profile:doctor, then /reload after fixing package registration or extension filters."
  ].join(" ");
}

export function buildNativeToolsStatusText(api: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">): string {
  const report = nativeToolPolicyReport(api);
  return [
    "Native tools status",
    "",
    `Strict replacement: ${report.ok ? "ok" : "failed"}`,
    `Active banned stock tools: ${report.bannedActiveAfter.length === 0 ? "none" : report.bannedActiveAfter.join(", ")}`,
    `Missing required replacements: ${report.missingReplacementTools.length === 0 ? "none" : report.missingReplacementTools.join(", ")}`,
    `Active file/shell tools: ${formatToolList(report.activeAfter.filter((toolName) => BANNED_DEFAULT_TOOL_NAMES.includes(toolName as never) || DEFAULT_ACTIVE_TOOL_NAMES.includes(toolName as never)))}`,
    "",
    report.ok
      ? "Replacement policy is satisfied. Use the active shell_*/read_many/search_many/write_many/edit_many replacements instead of stock single-file tools."
      : "Fix package registration or package filters, then run /reload. The native-tools extension expects @akoumjian/pi-tools async-shell and batch tools to load together for any enabled stock capabilities."
  ].join("\n");
}

function formatToolList(toolNames: string[]): string {
  return toolNames.length === 0 ? "none" : toolNames.join(", ");
}

export function buildNativeToolsSystemPrompt(prompt: string, skills: Skill[]): string {
  return addSkillsForReadMany(prompt, skills);
}

function addSkillsForReadMany(prompt: string, skills: Skill[]): string {
  const skillsPrompt = formatSkillsForReadManyPrompt(skills);
  if (skillsPrompt === "") {
    return prompt;
  }

  return `${prompt}${skillsPrompt}`;
}

export function formatSkillsForReadManyPrompt(skills: Skill[]): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return "";
  }

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use read_many with files: [{ path: <skill location> }] to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>"
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function readMany(context: ExtensionContext, input: ReadManyInput): Promise<AgentToolResult<ReadManyDetails>> {
  const results = await Promise.all(input.files.map((item) => readOne(context, item)));
  const details = results.map(({ content: _content, ...detail }) => detail);
  const text = [
    `Read ${results.length} file${results.length === 1 ? "" : "s"}.`,
    "",
    results.map((file) => formatReadFile(file)).join("\n\n")
  ].join("\n");

  return {
    content: [{ type: "text", text }],
    details: { files: details }
  };
}

export async function searchMany(context: ExtensionContext, input: SearchManyInput): Promise<AgentToolResult<SearchManyDetails>> {
  const results = await Promise.all(input.searches.map((item) => searchOne(context, item)));
  const details = results.map(({ output: _output, ...detail }) => detail);
  const text = [
    `Completed ${results.length} search${results.length === 1 ? "" : "es"}.`,
    "",
    results.map((result, index) => formatSearchResult(index + 1, result)).join("\n\n")
  ].join("\n");

  return {
    content: [{ type: "text", text }],
    details: { searches: details }
  };
}

async function searchOne(context: ExtensionContext, item: SearchManyInput["searches"][number]): Promise<SearchResult> {
  const kind = item.kind as SearchKind;
  const searchPath = item.path ?? ".";
  const resolvedPath = resolvePath(context.cwd, searchPath);
  const contextLines = kind === "content" ? item.context ?? 0 : 0;
  const maxResults = item.maxResults ?? 100;
  const args = buildRgArgs(context.cwd, item, resolvedPath, contextLines);
  const run = await runRg(context.cwd, args);

  if (!run.truncated && run.exitCode !== 0 && run.exitCode !== 1) {
    throw new Error(`rg failed for ${searchPath}: ${run.stderr || `exit code ${run.exitCode}`}`);
  }

  const output = limitSearchOutput(run.stdout, maxResults);
  return {
    kind,
    path: searchPath,
    resolvedPath,
    pattern: item.pattern,
    glob: item.glob,
    context: contextLines,
    maxResults,
    outputLines: output.outputLines,
    truncated: run.truncated || output.truncated,
    exitCode: run.exitCode,
    signal: run.signal,
    previewLines: previewLines(output.text, 3),
    output: output.text
  };
}

function buildRgArgs(
  cwd: string,
  item: SearchManyInput["searches"][number],
  resolvedPath: string,
  contextLines: number
): string[] {
  const pathArg = searchPathArgument(cwd, resolvedPath);
  const args = ["--color", "never", "--no-messages"];

  if (item.glob !== undefined) {
    args.push("--glob", item.glob);
  }

  if (item.kind === "files") {
    return [...args, "--files", pathArg];
  }

  if (item.pattern === undefined) {
    throw new Error("search_many content searches require pattern.");
  }

  if (item.ignoreCase === true) {
    args.push("--ignore-case");
  }
  if (item.literal === true) {
    args.push("--fixed-strings");
  }
  if (contextLines > 0) {
    args.push("--context", String(contextLines));
  }

  return [
    ...args,
    "--line-number",
    "--column",
    "--no-heading",
    item.pattern,
    pathArg
  ];
}

function searchPathArgument(cwd: string, resolvedPath: string): string {
  const relative = path.relative(cwd, resolvedPath);
  if (relative === "") {
    return ".";
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative;
  }
  return resolvedPath;
}

function runRg(cwd: string, args: string[]): Promise<RgResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let spawnError: Error | undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = MAX_SEARCH_BYTES - stdoutBytes;
      if (remaining <= 0) {
        truncated = true;
        child.kill("SIGTERM");
        return;
      }

      const next = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stdout.push(next);
      stdoutBytes += next.length;
      if (next.length < chunk.length) {
        truncated = true;
        child.kill("SIGTERM");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = MAX_SEARCH_STDERR_BYTES - stderrBytes;
      if (remaining <= 0) {
        return;
      }

      const next = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderr.push(next);
      stderrBytes += next.length;
    });

    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", (exitCode, signal) => {
      if (spawnError !== undefined) {
        reject(new Error(`Failed to run rg. Install ripgrep or use shell_start for custom search: ${spawnError.message}`));
        return;
      }

      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
        exitCode,
        signal,
        truncated
      });
    });
  });
}

function limitSearchOutput(output: string, maxResults: number): { text: string; outputLines: number; truncated: boolean } {
  const trimmed = output.trimEnd();
  if (trimmed === "") {
    return { text: "", outputLines: 0, truncated: false };
  }

  const lines = trimmed.split(/\r?\n/);
  const shown = lines.slice(0, maxResults);
  return {
    text: shown.join("\n"),
    outputLines: shown.length,
    truncated: shown.length < lines.length
  };
}

function formatSearchResult(index: number, result: SearchResult): string {
  const label = result.kind === "files"
    ? `files in ${result.path}`
    : `content ${JSON.stringify(result.pattern)} in ${result.path}`;
  const glob = result.glob === undefined ? "" : ` glob ${JSON.stringify(result.glob)}`;
  const truncated = result.truncated ? `\n[truncated; narrow the search or raise maxResults up to 1000]` : "";
  const output = result.output === "" ? "(no matches)" : result.output;

  return `--- search ${index}: ${label}${glob} (${result.outputLines} line${result.outputLines === 1 ? "" : "s"}) ---\n${output}${truncated}`;
}

async function readOne(context: ExtensionContext, item: ReadManyInput["files"][number]): Promise<ReadFileResult> {
  const resolvedPath = resolvePath(context.cwd, item.path);
  await access(resolvedPath, constants.R_OK);

  const content = await readFile(resolvedPath, "utf8");
  const lines = content.split("\n");
  const totalLines = lines.length;
  const offset = item.offset ?? 1;
  if (offset > totalLines) {
    throw new Error(`Offset ${offset} is beyond end of file ${item.path} (${totalLines} lines total).`);
  }

  const start = offset - 1;
  const selected = item.limit === undefined ? lines.slice(start) : lines.slice(start, start + item.limit);
  const outputContent = selected.join("\n");
  const truncated = buildReadTruncation(selected, outputContent, totalLines, Buffer.byteLength(content, "utf8"), start);

  return {
    path: item.path,
    resolvedPath,
    offset,
    requestedLimit: item.limit,
    truncation: truncated,
    previewLines: previewLines(outputContent, 2),
    content: outputContent
  };
}

function formatReadFile(file: ReadFileResult): string {
  const startLine = file.offset;
  const endLine = file.offset + file.truncation.outputLines - 1;
  const header = `--- ${file.path} (lines ${startLine}-${Math.max(startLine, endLine)} of ${file.truncation.totalLines}) ---`;
  const continuation = file.truncation.nextOffset === undefined
    ? ""
    : `\n[truncated by ${file.truncation.truncatedBy}; continue with offset=${file.truncation.nextOffset}]`;

  return `${header}\n${file.content}${continuation}`;
}

function buildReadTruncation(selected: string[], outputContent: string, totalLines: number, totalBytes: number, startIndex: number): TruncationDetails {
  const outputLines = selected.length;
  const hasMoreFileLines = startIndex + outputLines < totalLines;

  return {
    truncated: hasMoreFileLines,
    truncatedBy: hasMoreFileLines ? "lines" : null,
    totalLines,
    outputLines,
    totalBytes,
    outputBytes: Buffer.byteLength(outputContent, "utf8"),
    nextOffset: hasMoreFileLines ? startIndex + outputLines + 1 : undefined
  };
}

const NATIVE_MUTATION_ENTRY_ID_HASH_LENGTH = 12;

export function nativeMutationEntryId(entry: NativeMutationEntry): string {
  return `m_${hashNativeMutationEntry(entry).slice(0, NATIVE_MUTATION_ENTRY_ID_HASH_LENGTH)}`;
}

export function nativeWriteMutationEntryId(write: WriteManyInput["writes"][number]): string {
  return nativeMutationEntryId({ kind: "write", path: write.path, content: write.content });
}

export function nativeWriteMutationEntryIds(writes: WriteManyInput["writes"]): string[] {
  return assertUniqueNativeMutationEntryIds(writes.map(nativeWriteMutationEntryId));
}

export function nativeEditMutationEntryId(file: EditManyInput["files"][number]): string {
  return nativeMutationEntryId({ kind: "edit", path: file.path, edits: file.edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText })) });
}

export function nativeEditMutationEntryIds(files: EditManyInput["files"]): string[] {
  return assertUniqueNativeMutationEntryIds(files.map(nativeEditMutationEntryId));
}

export function scopedNativeMutationEntryId(toolCallId: string, entryId: string): string {
  return `${toolCallId}:${entryId}`;
}

function assertUniqueNativeMutationEntryIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = ids.find((id) => {
    if (seen.has(id)) {
      return true;
    }
    seen.add(id);
    return false;
  });
  if (duplicate !== undefined) {
    throw new Error(`Native mutation entry id collision for ${duplicate}.`);
  }
  return ids;
}

function hashNativeMutationEntry(entry: NativeMutationEntry): string {
  return createHash("sha256").update(stableStringifyNativeMutationEntry({ version: 1, ...entry })).digest("hex");
}

function stableStringifyNativeMutationEntry(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringifyNativeMutationEntry).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringifyNativeMutationEntry(record[key])}`).join(",")}}`;
}

export async function writeMany(context: ExtensionContext, input: WriteManyInput, toolCallId?: string): Promise<AgentToolResult<WriteManyDetails>> {
  assertUniquePaths(context, input.writes.map((item) => item.path), "write_many");
  const entryIds = nativeWriteMutationEntryIds(input.writes);
  const files = await Promise.all(input.writes.map((item, index) => writeOne(context, item, entryIds[index], toolCallId)));

  return {
    content: [{ type: "text", text: [`Wrote ${files.length} file${files.length === 1 ? "" : "s"}.`, ...files.map((file) => `- ${file.id} ${file.path}: ${file.bytes} bytes`)].join("\n") }],
    details: { files }
  };
}

async function writeOne(context: ExtensionContext, item: WriteManyInput["writes"][number], id: string, toolCallId: string | undefined): Promise<WriteFileDetails> {
  return withMutationEntryErrorContext(id, item.path, async () => {
    const resolvedPath = resolvePath(context.cwd, item.path);
    await withFileMutationQueue(resolvedPath, async () => {
      await mkdir(path.dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, item.content, "utf8");
    });

    return {
      id,
      scopedId: toolCallId === undefined ? undefined : scopedNativeMutationEntryId(toolCallId, id),
      path: item.path,
      resolvedPath,
      bytes: Buffer.byteLength(item.content, "utf8"),
      lines: countLines(item.content)
    };
  });
}

export async function editMany(context: ExtensionContext, input: EditManyInput, toolCallId?: string): Promise<AgentToolResult<EditManyDetails>> {
  assertUniquePaths(context, input.files.map((item) => item.path), "edit_many");
  const entryIds = nativeEditMutationEntryIds(input.files);
  const files = await Promise.all(input.files.map((item, index) => editOne(context, item, entryIds[index], toolCallId)));

  return {
    content: [{ type: "text", text: [`Edited ${files.length} file${files.length === 1 ? "" : "s"}.`, ...files.map((file) => `- ${file.id} ${file.path}: replaced ${file.replacements} block(s)`)].join("\n") }],
    details: { files }
  };
}

async function editOne(context: ExtensionContext, item: EditManyInput["files"][number], id: string, toolCallId: string | undefined): Promise<EditFileDetails> {
  return withMutationEntryErrorContext(id, item.path, async () => {
    const resolvedPath = resolvePath(context.cwd, item.path);

    return withFileMutationQueue(resolvedPath, async () => {
      const original = await readFile(resolvedPath, "utf8");
      const edited = applyExactReplacements(original, item.edits, item.path);
      await writeFile(resolvedPath, edited.content, "utf8");

      return {
        id,
        scopedId: toolCallId === undefined ? undefined : scopedNativeMutationEntryId(toolCallId, id),
        path: item.path,
        resolvedPath,
        replacements: item.edits.length,
        ranges: edited.ranges,
        bytesBefore: Buffer.byteLength(original, "utf8"),
        bytesAfter: Buffer.byteLength(edited.content, "utf8")
      };
    });
  });
}

async function withMutationEntryErrorContext<T>(id: string, rawPath: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${id} ${rawPath}: ${nativeToolErrorMessage(error)}`);
  }
}

function nativeToolErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function applyExactReplacements(original: string, edits: Replacement[], displayPath: string): ReplacementResult {
  const { bom, body } = stripBom(original);
  const lineEnding = detectLineEnding(body);
  const normalized = normalizeLineEndings(body);
  const planned = edits.map((edit) => planReplacement(normalized, normalizeReplacement(edit), displayPath));
  planned.sort((left, right) => left.start - right.start);

  for (let index = 1; index < planned.length; index += 1) {
    if (planned[index].start < planned[index - 1].end) {
      throw new Error(`Overlapping edits for ${displayPath}. Merge nearby replacements into one edit.`);
    }
  }

  const lineStarts = buildLineStarts(normalized);
  const ranges = planned.map((edit) => lineRangeForSpan(lineStarts, edit.start, edit.end));
  let cursor = 0;
  let next = "";
  for (const edit of planned) {
    next += normalized.slice(cursor, edit.start);
    next += edit.newText;
    cursor = edit.end;
  }
  next += normalized.slice(cursor);

  return {
    content: bom + restoreLineEndings(next, lineEnding),
    ranges
  };
}

function planReplacement(content: string, edit: Replacement, displayPath: string): PlannedReplacement {
  const first = content.indexOf(edit.oldText);
  if (first === -1) {
    throw new Error(`oldText was not found in ${displayPath}: ${previewText(edit.oldText)}`);
  }

  const second = content.indexOf(edit.oldText, first + edit.oldText.length);
  if (second !== -1) {
    throw new Error(`oldText is not unique in ${displayPath}: ${previewText(edit.oldText)}`);
  }

  return {
    ...edit,
    start: first,
    end: first + edit.oldText.length
  };
}

function normalizeReplacement(edit: Replacement): Replacement {
  return {
    oldText: normalizeLineEndings(edit.oldText),
    newText: normalizeLineEndings(edit.newText)
  };
}

function stripBom(content: string): { bom: string; body: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", body: content.slice(1) }
    : { bom: "", body: content };
}

function detectLineEnding(content: string): "\n" | "\r\n" | "\r" {
  if (content.includes("\r\n")) {
    return "\r\n";
  }
  if (content.includes("\r")) {
    return "\r";
  }
  return "\n";
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(content: string, lineEnding: "\n" | "\r\n" | "\r"): string {
  return lineEnding === "\n" ? content : content.replace(/\n/g, lineEnding);
}

function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineRangeForSpan(lineStarts: number[], start: number, end: number): LineRange {
  const endOffset = Math.max(start, end - 1);
  return {
    startLine: lineNumberForOffset(lineStarts, start),
    endLine: lineNumberForOffset(lineStarts, endOffset)
  };
}

function lineNumberForOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    if (lineStarts[midpoint] <= offset) {
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return Math.max(1, high + 1);
}

function assertUniquePaths(context: ExtensionContext, paths: string[], toolName: string): void {
  const seen = new Set<string>();
  for (const rawPath of paths) {
    const resolvedPath = resolvePath(context.cwd, rawPath);
    if (seen.has(resolvedPath)) {
      throw new Error(`${toolName} received the same resolved path more than once: ${rawPath}`);
    }
    seen.add(resolvedPath);
  }
}

export function resolveNativeToolPath(cwd: string, rawPath: string): string {
  const normalized = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  return path.resolve(cwd, expandHome(normalized));
}

function resolvePath(cwd: string, rawPath: string): string {
  return resolveNativeToolPath(cwd, rawPath);
}

function expandHome(rawPath: string): string {
  if (rawPath === "~") {
    return process.env.HOME ?? rawPath;
  }
  if (rawPath.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", rawPath.slice(2));
  }
  return rawPath;
}

type RenderTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type RenderOptions = {
  expanded: boolean;
  isPartial?: boolean;
};

type RenderContext = {
  isError: boolean;
};

function renderReadManyCall(args: ReadManyInput, theme: RenderTheme): Text {
  return new Text(claudeToolCall("Read", summarizeItems(args.files.map(formatReadRequest), 3), theme), 0, 0);
}

function renderReadManyResult(result: AgentToolResult<ReadManyDetails>, options: RenderOptions, theme: RenderTheme, context?: RenderContext): Text {
  const error = renderNativeToolError(result, theme, context);
  if (error) {
    return error;
  }

  if (options.isPartial) {
    return new Text(claudeToolResult("Reading...", theme), 0, 0);
  }

  const files = result.details?.files ?? [];
  return new Text(claudeToolResult(`Read ${summarizeItems(files.map(formatReadResultSpan), 3)}`, theme), 0, 0);
}

function renderSearchManyCall(args: SearchManyInput, theme: RenderTheme): Text {
  return new Text(claudeToolCall("Search", summarizeItems(args.searches.map(formatSearchRequest), 3), theme), 0, 0);
}

function renderSearchManyResult(result: AgentToolResult<SearchManyDetails>, options: RenderOptions, theme: RenderTheme, context?: RenderContext): Text {
  const error = renderNativeToolError(result, theme, context);
  if (error) {
    return error;
  }

  if (options.isPartial) {
    return new Text(claudeToolResult("Searching...", theme), 0, 0);
  }

  const searches = result.details?.searches ?? [];
  const lineCount = searches.reduce((total, search) => total + search.outputLines, 0);
  let text = claudeToolResult(`Found ${lineCount} ${lineCount === 1 ? "line" : "lines"} across ${searches.length} ${searches.length === 1 ? "search" : "searches"}`, theme);
  if (searches.some((search) => search.truncated)) {
    text += theme.fg("warning", " (truncated)");
  }
  return new Text(text, 0, 0);
}

function renderWriteManyCall(args: WriteManyInput, theme: RenderTheme): Text {
  return new Text(claudeToolCall("Write", summarizeItems(args.writes.map(formatWriteRequest), 3), theme), 0, 0);
}

function renderWriteManyResult(result: AgentToolResult<WriteManyDetails>, options: RenderOptions, theme: RenderTheme, context?: RenderContext): Text {
  const error = renderNativeToolError(result, theme, context);
  if (error) {
    return error;
  }

  if (options.isPartial) {
    return new Text(claudeToolResult("Writing...", theme), 0, 0);
  }

  const files = result.details?.files ?? [];
  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  return new Text(claudeToolResult(`Wrote ${summarizeItems(files.map(formatWriteResultSpan), 3)} (${formatBytes(bytes)})${formatMutationReviewSuffix(result.details?.mutationReview)}`, theme), 0, 0);
}

function renderEditManyCall(args: EditManyInput, theme: RenderTheme): Text {
  const editCount = args.files.reduce((total, file) => total + file.edits.length, 0);
  const summary = `${summarizeItems(args.files.map((file) => `${compactPath(file.path)} (${file.edits.length})`), 3)}; ${editCount} edit${editCount === 1 ? "" : "s"}`;
  return new Text(claudeToolCall("Update", summary, theme), 0, 0);
}

function renderEditManyResult(result: AgentToolResult<EditManyDetails>, options: RenderOptions, theme: RenderTheme, context?: RenderContext): Text {
  const error = renderNativeToolError(result, theme, context);
  if (error) {
    return error;
  }

  if (options.isPartial) {
    return new Text(claudeToolResult("Updating...", theme), 0, 0);
  }

  const files = result.details?.files ?? [];
  const editCount = files.reduce((total, file) => total + file.replacements, 0);
  return new Text(claudeToolResult(`Updated ${summarizeItems(files.map(formatEditResultSpan), 3)} with ${editCount} edit${editCount === 1 ? "" : "s"}${formatMutationReviewSuffix(result.details?.mutationReview)}`, theme), 0, 0);
}

function renderNativeToolError(result: AgentToolResult<unknown>, theme: RenderTheme, context?: RenderContext): Text | undefined {
  if (context?.isError !== true) {
    return undefined;
  }
  return new Text(theme.fg("muted", "⎿ ") + theme.fg("error", summarizeNativeToolError(result)), 0, 0);
}

function summarizeNativeToolError(result: AgentToolResult<unknown>): string {
  const text = result.content
    .map((item) => item.type === "text" ? item.text : "")
    .join("\n")
    .trim();
  if (text.includes("File mutation was not applied")) {
    return summarizeMutationReviewBlock(text);
  }
  return `Error: ${truncateOneLine(text || "Tool failed.", 160)}`;
}

function summarizeMutationReviewBlock(text: string): string {
  const mutationReviewId = text.match(/\bmr_[A-Za-z0-9_-]+\b/)?.[0];
  const idSuffix = mutationReviewId ? ` (${mutationReviewId})` : "";
  const summary = extractMutationReviewBlockSummary(text);
  if (summary) {
    return `Blocked by mutation-review${idSuffix}: ${summary}`;
  }
  return `Blocked by mutation-review${idSuffix}`;
}

function extractMutationReviewBlockSummary(text: string): string | undefined {
  const patterns: RegExp[] = [
    /\nSummary:\n([^\n]+)/,
    /\nOriginal reviewer summary:\n([^\n]+)/,
    /\nOriginal review failure:\n([^\n]+)/,
    /\nFailure:\s*([^\n]+)/
  ];
  for (const pattern of patterns) {
    const candidate = text.match(pattern)?.[1]?.trim();
    if (candidate) {
      return truncateOneLine(candidate, 140);
    }
  }
  return undefined;
}

function claudeToolCall(name: string, summary: string, theme: RenderTheme): string {
  return theme.fg("toolTitle", `⏺ ${theme.bold(name)}(`) + theme.fg("accent", summary) + theme.fg("toolTitle", ")…");
}

function claudeToolResult(summary: string, theme: RenderTheme): string {
  return theme.fg("muted", "⎿ ") + theme.fg("success", summary);
}

function summarizeItems(items: string[], limit: number): string {
  const visible = items.slice(0, limit).join(", ");
  const hidden = items.length - Math.min(items.length, limit);
  return hidden > 0 ? `${visible}, +${hidden}` : visible;
}

function formatReadRequest(file: ReadManyInput["files"][number]): string {
  const offset = file.offset ?? 1;
  return file.limit === undefined
    ? `${compactPath(file.path)}:${offset}+`
    : `${compactPath(file.path)}:${offset}:${offset + file.limit - 1}`;
}

function formatReadResultSpan(file: ReadFileDetails): string {
  const start = file.offset;
  const end = Math.max(start, file.offset + file.truncation.outputLines - 1);
  return `${compactPath(file.path)}:${start}:${end}`;
}

function formatWriteRequest(write: WriteManyInput["writes"][number]): string {
  return `${compactPath(write.path)}:1:${countLines(write.content)}`;
}

function formatWriteResultSpan(file: WriteFileDetails): string {
  return `${file.id} ${compactPath(file.path)}:1:${file.lines}`;
}

function formatEditResultSpan(file: EditFileDetails): string {
  const range = mergeRanges(file.ranges);
  if (range === undefined) {
    return `${file.id} ${compactPath(file.path)}`;
  }
  return `${file.id} ${compactPath(file.path)}:${range.startLine}:${range.endLine}`;
}

function formatMutationReviewSuffix(details: MutationReviewPartialDetails | undefined): string {
  if (details === undefined || details.blocked.length === 0) {
    return "";
  }
  const ids = details.blocked.map((item) => item.id).join(", ");
  const summary = details.summary ? `: ${truncateOneLine(details.summary, 120)}` : "";
  return `; skipped ${ids} by mutation review${summary}`;
}

function formatSearchRequest(search: SearchManyInput["searches"][number] | SearchResultDetails): string {
  const target = formatSearchTarget(search.path ?? ".", search.glob);
  if (search.kind === "files") {
    return `files in ${target}`;
  }
  return `${quotePreview(search.pattern ?? "<missing pattern>", 48)} in ${target}`;
}

function formatSearchTarget(searchPath: string, glob: string | undefined): string {
  const target = compactPath(searchPath);
  return glob === undefined ? target : `${target} glob ${quotePreview(glob, 48)}`;
}

function previewLines(text: string, limit: number): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, limit);
}

function compactPath(rawPath: string): string {
  return truncateMiddle(rawPath.replace(/\\/g, "/"), 56);
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

function quotePreview(text: string, maxLength: number): string {
  return JSON.stringify(truncateOneLine(text, maxLength));
}

function truncateOneLine(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function countLines(text: string): number {
  return text.split("\n").length;
}

function mergeRanges(ranges: LineRange[]): LineRange | undefined {
  if (ranges.length === 0) {
    return undefined;
  }

  return {
    startLine: Math.min(...ranges.map((range) => range.startLine)),
    endLine: Math.max(...ranges.map((range) => range.endLine))
  };
}

function previewText(text: string): string {
  return JSON.stringify(text.length > 120 ? `${text.slice(0, 117)}...` : text);
}
