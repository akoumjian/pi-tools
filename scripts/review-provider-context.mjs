#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamOpenAICodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const fixedNow = "2000-01-02T12:00:00.000Z";
process.env.TZ = "UTC";
installFixedClock();
const defaultOutputDir = path.join(repoRoot, "docs", "generated", "provider-context-review");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outputDir = outIndex === -1 ? defaultOutputDir : path.resolve(args[outIndex + 1] ?? "");
const stdoutOnly = args.includes("--stdout");

const extensionPaths = [
  "extensions/async-shell/index.ts",
  "extensions/native-tools/index.ts",
  "extensions/mutation-review/index.ts",
  "extensions/searxng-search/index.ts",
  "extensions/web-fetch/index.ts",
  "extensions/tool-display/index.ts",
  "extensions/orchestrator/index.ts"
].map((entry) => path.join(repoRoot, entry));

const loaded = await discoverAndLoadExtensions(extensionPaths, repoRoot, "/tmp/pi-tools-provider-context-agent");
if (loaded.errors.length > 0) {
  throw new Error(`Could not load review extensions:\n${loaded.errors.map((error) => `${error.path}: ${error.error}`).join("\n")}`);
}

const definitions = loaded.extensions.flatMap((extension) =>
  Array.from(extension.tools.values()).map((registered) => registered.definition)
);
const banned = new Set(["bash", "read", "write", "edit"]);
const tools = definitions.filter((tool) => !banned.has(tool.name));
const selectedTools = tools.map((tool) => tool.name);
const toolSnippets = Object.fromEntries(tools.flatMap((tool) => tool.promptSnippet ? [[tool.name, tool.promptSnippet]] : []));
const promptGuidelines = tools.flatMap((tool) => tool.promptGuidelines ?? []);
const skills = [{
  name: "fixture-skill",
  description: "SENTINEL_SKILL_DESCRIPTION",
  filePath: "/review/skills/fixture-skill/SKILL.md",
  baseDir: "/review/skills/fixture-skill",
  disableModelInvocation: false,
  sourceInfo: { path: "<fixture-skill>", source: "fixture", scope: "temporary", origin: "top-level" }
}];
const promptOptions = {
  cwd: "/review/workspace",
  selectedTools,
  toolSnippets,
  promptGuidelines,
  appendSystemPrompt: "SENTINEL_APPEND_SYSTEM_PROMPT\nSENTINEL_CHILD_ROLE_AND_CONFINEMENT",
  contextFiles: [{ path: "/review/workspace/AGENTS.md", content: "SENTINEL_AGENTS_CONTENT\nAvailable tools: Guidelines: Current date:" }],
  skills
};

// buildSystemPrompt is not a public export in Pi 0.78/0.79. This test/review
// command deliberately imports the installed builder by file URL so snapshots
// fail when Pi changes its actual rendered prompt contract.
const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", codingAgentEntry));
const basePrompt = buildSystemPrompt(promptOptions).replaceAll(repoRoot, "/review/pi-tools");
const nativeExtension = loaded.extensions.find((extension) => extension.resolvedPath.endsWith("/extensions/native-tools/index.ts"));
const promptAdapter = nativeExtension?.handlers.get("before_agent_start")?.[0];
if (promptAdapter === undefined) {
  throw new Error("native-tools before_agent_start prompt adapter was not registered");
}
const adapted = await promptAdapter({
  type: "before_agent_start",
  prompt: "SENTINEL_USER_PROMPT",
  systemPrompt: basePrompt,
  systemPromptOptions: promptOptions
}, {});
const systemPrompt = adapted?.systemPrompt ?? basePrompt;

const providerTools = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters
}));

const resultContracts = {
  shell_start: {
    success: "content identifies every jobId/status/cwd/stdout_log/stderr_log/output-byte count; quick failures include actionable exit/error state without raw-output dumps",
    progress: "partial content reports per-job startup/completion metadata during the fixed grace period",
    error: "schema/spawn failures are model-visible per command; total tool failure throws",
    details: "internal job records and bounded render diagnostics; providers must rely on content",
    content: "all ids/log paths and shell_read/search/read next actions needed by the model"
  },
  shell_status: {
    success: "content reports one job's metadata/log paths/diagnostic tail or a bounded recent-job list",
    progress: "not applicable: status inspection is a single bounded host read",
    error: "unknown jobId and invalid input are model-visible errors",
    details: "internal structured job metadata used by compact rendering",
    content: "job health, ids, paths, output-byte counts, and output-reading next action"
  },
  shell_read: {
    success: "content reports selected stream/log path/window/preview lines/truncation and nextOffset",
    progress: "not applicable: each call reads one immutable log window",
    error: "unknown job/stream/range and unreadable-log failures are model-visible",
    details: "internal stream windows and job metadata",
    content: "exact tail/range data plus continuation offset and truncation state"
  },
  shell_cancel: {
    success: "content identifies jobId, requested signal, resulting state, log paths, and bounded final output",
    progress: "not applicable: cancellation is one signal operation",
    error: "unknown/already-terminal jobs and signal failures are model-visible",
    details: "internal updated job and final output record",
    content: "cancellation outcome and where/how to inspect remaining output"
  },
  read_many: {
    success: "content groups exact UTF-8 text ranges and directly attaches byte-detected supported images in input order without another model call",
    progress: "not applicable: independent text/image reads and image processing complete as one batch",
    error: "any path/range/read failure, unsupported binary, image range, image-count/aggregate-payload limit, image-processing failure, or non-vision model rejects the batch; no sibling success result is delivered",
    details: "internal discriminated text range/truncation or image MIME/byte/attachment metadata",
    content: "known path, text range and nextOffset, plus ordered text image summaries and provider-visible image content"
  },
  search_many: {
    success: "content groups rg-backed file/content matches with line/column context and caps",
    progress: "not applicable: bounded searches complete as one batch",
    error: "any search validation/rg failure rejects the batch as a model-visible error; no sibling success result is delivered",
    details: "internal query metadata, exit status, and truncation",
    content: "query identity, matches, explicit truncation, and narrow/raise-cap next action"
  },
  write_many: {
    success: "content identifies every mutation id/path/byte count; line counts remain internal details",
    progress: "not applicable: queued file mutations return after the batch settles",
    error: "validation/path/write failure rejects the batch even if an earlier queued write already applied; mutation-review blocks expose ids/reasons/apply-or-revise action",
    details: "internal mutation entries and review annotations",
    content: "all model-needed mutation ids, paths, byte counts, blocked ids, and next action"
  },
  edit_many: {
    success: "content identifies every mutation id/path/replacement count; ranges remain internal details",
    progress: "not applicable: exact replacements return after the queued batch settles",
    error: "missing/non-unique/overlapping edit failure rejects the batch even if an earlier queued file edit already applied; mutation-review blocks expose paths/ids/reasons",
    details: "internal mutation entries, ranges, and review annotations",
    content: "all model-needed ids, paths, replacement counts, blocked ids, and apply-or-revise action"
  },
  apply_reviewed_mutation: {
    success: "content identifies reviewed id and every applied mutation id/path/kind/byte count",
    progress: "not applicable: cached proposal validation/application is atomic from the caller's perspective",
    error: "missing/stale/hash-mismatched ids fail visibly before writing and explain revision",
    details: "internal applied mutation records",
    content: "review id, mutation ids/paths, validation failure, and next action"
  },
  searxng_search: {
    success: "content lists ranked title/URL/snippet/engine results",
    progress: "not applicable: one bounded search request",
    error: "configuration/network/HTTP/parse errors identify /searxng:setup or SEARXNG_URL action",
    details: "internal query, result-count, page, and base-URL metadata",
    content: "source candidates and web_fetch_many next action"
  },
  web_fetch_many: {
    success: "content reports each URL/final URL/status/HTTP/content metadata/citation/preview/saved paths/handoff",
    progress: "not applicable: concurrent URL items settle into one bounded batch result",
    error: "per-URL refusal/network/size/parse failures remain visible beside successful siblings",
    details: "internal cached-fetch records",
    content: "all citation paths, truncation/errors, and read_many/document_parse next actions"
  },
  document_parse: {
    success: "content reports outputPath/format/page count and optional nonzero screenshot count/paths/warnings",
    progress: "parser progress is host-controlled; no stable model-visible partial contract",
    error: "missing dependency/input/parse/OCR failures identify /docparser:doctor when applicable",
    details: "internal LiteParse output metadata used by display rendering",
    content: "saved output/screenshot paths and read_many/visual-inspection next actions"
  },
  orchestrate: {
    success: "content reports every task id/role/status/routes; completed tasks add model/thinking/duration/tool calls/output and writer worktree/review data",
    progress: "partial content reports completed/total tasks and bounded writer/provider/git-setup status",
    error: "per-task preflight/provider/task/worktree/reviewer failures include route classifications and actionable disposition",
    details: "internal structured run/config/results mirror; providers must rely on content",
    content: "all route attempts, errors, branch/path/commit/files, review attempts/verdicts, and reconcile next action"
  },
  reconcile: {
    success: "content reports integration branch, folds/skips/overlaps/validation, optional merge commit/cleanup, and declined integration path",
    progress: "not applicable: deterministic folds culminate in one human gate and final report",
    error: "dirty parent, invalid/moved branches, conflicts and validation failures are reported without force merge",
    details: "internal structured reconciliation report",
    content: "all branch ids, skip reasons, validation state, user decision, and declined/manual-review integration path"
  }
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const internalToolResult = {
  role: "toolResult",
  toolCallId: "call_fixture_read_many",
  toolName: "read_many",
  content: [
    { type: "text", text: "SENTINEL_RESULT_CONTENT\n[truncated by lines; continue with offset=42]" },
    { type: "image", data: "U0VOVElORUxfSU1BR0VfQllURVM=", mimeType: "image/png" }
  ],
  details: { internalOnlySentinel: "SENTINEL_INTERNAL_DETAILS", nextOffset: 42 },
  isError: false,
  timestamp: 0
};
const messages = [
  { role: "user", content: "SENTINEL_USER_PROMPT", timestamp: 0 },
  {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_fixture_read_many", name: "read_many", arguments: { files: [{ path: "fixture.txt" }] } }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.5",
    usage,
    stopReason: "toolUse",
    timestamp: 0
  },
  internalToolResult
];
const context = { systemPrompt, messages, tools: providerTools };
const fakeJwt = [
  "e30",
  Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" } })).toString("base64url"),
  "fixture-signature"
].join(".");

async function capturePayload(streamFunction, model, apiKey, options = {}) {
  if (!model) throw new Error("Review model definition was not found in @earendil-works/pi-ai");
  let payload;
  const controller = new AbortController();
  const stream = streamFunction(model, context, {
    apiKey,
    signal: controller.signal,
    maxRetries: 0,
    ...options,
    onPayload(candidate) {
      payload = candidate;
      controller.abort();
    }
  });
  for await (const _event of stream) {
    // Payload capture aborts before network I/O; consume the terminal event.
  }
  if (payload === undefined) throw new Error(`Provider ${model.provider} did not expose a payload`);
  return payload;
}

const openaiPayload = await capturePayload(
  streamOpenAICodexResponses,
  getModel("openai-codex", "gpt-5.5"),
  fakeJwt,
  { transport: "sse" }
);
const anthropicPayload = await capturePayload(
  streamAnthropic,
  getModel("anthropic", "claude-sonnet-4-5"),
  "fixture-api-key"
);

function installFixedClock() {
  const NativeDate = globalThis.Date;
  const fixedEpochMs = NativeDate.parse(fixedNow);
  globalThis.Date = class FixedDate extends NativeDate {
    constructor(...dateArgs) {
      super(...(dateArgs.length === 0 ? [fixedEpochMs] : dateArgs));
    }
    static now() {
      return fixedEpochMs;
    }
  };
}

function normalize(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

function promptSchema(tool, boundary) {
  const prefix = `${tool.name} ${boundary}: JSON Schema: `;
  const matches = (tool.promptGuidelines ?? []).filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) throw new Error(`${tool.name} must have exactly one ${boundary} JSON Schema guideline`);
  const schemaText = matches[0].slice(prefix.length);
  const schema = JSON.parse(schemaText);
  if (schemaText !== JSON.stringify(schema)) throw new Error(`${tool.name} ${boundary} schema guideline is not minified JSON`);
  return schema;
}

const normalizedTools = tools.map((tool) => {
  const resultContract = resultContracts[tool.name];
  if (!resultContract) throw new Error(`Review artifact has no explicit result contract for ${tool.name}`);
  promptSchema(tool, "output");
  return normalize({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    parameters: tool.parameters,
    executionMode: tool.executionMode,
    renderShell: tool.renderShell,
    fieldAudit: {
      name: auditValue(tool.name, "Every provider tool requires a stable name."),
      label: auditValue(tool.label, "Every TUI-visible tool requires a label."),
      description: auditValue(tool.description, "Every provider declaration requires a complete behavior contract."),
      promptSnippet: auditValue(tool.promptSnippet, "Active tools require an Available tools entry."),
      promptGuidelines: auditValue(tool.promptGuidelines, "Active tools require named use/input/output/constraints guidance."),
      parameters: auditValue(tool.parameters, "Every provider declaration requires an input schema."),
      executionMode: auditValue(tool.executionMode, "Not applicable when Pi's default execution mode is the intended behavior."),
      prepareArguments: auditValue(tool.prepareArguments, "Not applicable: this tool has no legacy stored-argument shape to migrate."),
      execute: auditValue(tool.execute, "Every tool requires host execution."),
      renderShell: auditValue(tool.renderShell, "Not applicable: Pi's default tool-row shell is intended."),
      renderCall: auditValue(tool.renderCall, "Not applicable: Pi's fallback call renderer is sufficient."),
      renderResult: auditValue(tool.renderResult, "Not applicable: Pi's fallback result renderer is sufficient.")
    },
    resultContract
  });
});
function auditValue(value, absentReason) {
  if (value === undefined) return { status: "not_applicable", reason: absentReason };
  if (typeof value === "function") return { status: "reviewed", representation: "implemented function; body intentionally omitted from the JSON artifact" };
  return { status: "reviewed", representation: "serialized in this activeTools entry" };
}

const renderedProjectContext = extractRenderedSection(
  systemPrompt,
  /<project_context>[\s\S]*?<\/project_context>/g,
  "rendered project/AGENTS context"
);
const renderedSkillCatalog = extractRenderedSection(
  systemPrompt,
  /The following skills provide specialized instructions[\s\S]*?<\/available_skills>/g,
  "rendered skill catalog"
);
function extractRenderedSection(prompt, pattern, label) {
  const matches = [...prompt.matchAll(pattern)].map((match) => match[0]);
  if (matches.length === 0) throw new Error(`Could not locate ${label} in rendered system prompt`);
  return matches.join("\n\n");
}

const artifact = normalize({
  generatedBy: "npm run review:provider-context",
  renderedProjectContext,
  renderedSkillCatalog,
  systemPrompt,
  activeTools: normalizedTools,
  providerPayloads: {
    openaiCodexResponses: openaiPayload,
    anthropicMessages: anthropicPayload
  },
  toolResultVisibility: {
    internalPiMessage: internalToolResult,
    note: "Provider payloads contain SENTINEL_RESULT_CONTENT and the synthetic image attachment but must not contain SENTINEL_INTERNAL_DETAILS."
  }
});
const json = `${JSON.stringify(artifact, null, 2)}\n`;
const markdown = [
  "# Provider context review",
  "",
  "Generated by `npm run review:provider-context`. All context is synthetic and the clock is fixed; no auth, real AGENTS, or session content is included. Provider payload hooks are captured before network I/O.",
  "",
  "## Rendered project context",
  "",
  "```text",
  artifact.renderedProjectContext,
  "```",
  "",
  "## Rendered skill catalog",
  "",
  "```text",
  artifact.renderedSkillCatalog,
  "```",
  "",
  "## Rendered system prompt",
  "",
  "```text",
  artifact.systemPrompt,
  "```",
  "",
  "## Active tool definitions and prompt columns",
  "",
  "```json",
  JSON.stringify(artifact.activeTools, null, 2),
  "```",
  "",
  "## OpenAI Codex Responses request payload",
  "",
  "```json",
  JSON.stringify(artifact.providerPayloads.openaiCodexResponses, null, 2),
  "```",
  "",
  "## Anthropic Messages request payload",
  "",
  "```json",
  JSON.stringify(artifact.providerPayloads.anthropicMessages, null, 2),
  "```",
  "",
  "## Tool result visibility",
  "",
  "```json",
  JSON.stringify(artifact.toolResultVisibility, null, 2),
  "```",
  ""
].join("\n");

if (stdoutOnly) {
  process.stdout.write(markdown);
} else {
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "provider-context-review.md"), markdown),
    writeFile(path.join(outputDir, "provider-context-review.json"), json)
  ]);
  process.stdout.write(`${path.join(outputDir, "provider-context-review.md")}\n${path.join(outputDir, "provider-context-review.json")}\n`);
}
