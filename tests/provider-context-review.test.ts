import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const retainedToolNames = [
  "shell_start",
  "shell_status",
  "shell_read",
  "shell_cancel",
  "read_many",
  "search_many",
  "write_many",
  "edit_many",
  "apply_reviewed_mutation",
  "searxng_search",
  "web_fetch_many",
  "document_parse",
  "orchestrate",
  "reconcile"
] as const;

const outputContractFragments: Record<string, string[]> = {
  shell_start: ["content: text", "details: { jobs:", "no stdout/stderr samples"],
  shell_status: ["{ job: JobMeta", "{ jobs: JobMeta[] }"],
  shell_read: ["streams:", "range mode also includes total lines and nextOffset?"],
  shell_cancel: ["job: JobMeta", "output: { stdout: string, stderr: string }"],
  read_many: ["truncatedBy: \"lines\" | \"bytes\" | null", "nextOffset?"],
  search_many: ["searches:", "outputLines", "exitCode"],
  write_many: ["bytes, lines", "mutationReview?", "line counts/resolved paths remain internal"],
  edit_many: ["ranges: [{ startLine, endLine }]", "ranges/byte counts/resolved paths remain internal"],
  apply_reviewed_mutation: ["fingerprint", "beforeHash?", "afterHash"],
  searxng_search: ["title/engine?/URL/normalized-snippet", "resultCount", "baseUrl"],
  web_fetch_many: ["cacheRoot", "documentParseHint?", "preview?"],
  document_parse: ["outputPath", "optional nonzero screenshot", "warnings?"],
  orchestrate: ["failed tasks include actionable error", "routeAttempts", "review?"],
  reconcile: ["integration path when declined", "folded:", "overlaps:"]
};

function anthropicWireSchema(parameters: unknown): unknown {
  const schema = structuredClone(parameters) as Record<string, unknown>;
  delete schema.additionalProperties;
  schema.required ??= [];
  return schema;
}

type ReviewArtifact = {
  renderedProjectContext: string;
  renderedSkillCatalog: string;
  systemPrompt: string;
  activeTools: Array<{
    name: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    fieldAudit: Record<string, { status: "reviewed" | "not_applicable"; reason?: string; representation?: string }>;
    resultContract: Record<"success" | "progress" | "error" | "details" | "content", string>;
  }>;
  providerPayloads: {
    openaiCodexResponses: { instructions?: string; tools?: Array<{ name?: string; description?: string; parameters?: unknown }>; input?: unknown };
    anthropicMessages: { system?: unknown; tools?: Array<{ name?: string; description?: string; input_schema?: unknown }>; messages?: unknown };
  };
  toolResultVisibility: { internalPiMessage: { details?: unknown; content?: unknown }; note: string };
};

test("provider context review command renders sanitized prompt, tool declarations, and result visibility", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "pi-provider-context-review-"));
  try {
    const run = spawnSync(process.execPath, ["scripts/review-provider-context.mjs", "--out", out], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const jsonPath = path.join(out, "provider-context-review.json");
    const markdownPath = path.join(out, "provider-context-review.md");
    const firstJson = await readFile(jsonPath, "utf8");
    const firstMarkdown = await readFile(markdownPath, "utf8");
    assert.equal(
      firstJson,
      await readFile(path.join(process.cwd(), "docs/generated/provider-context-review/provider-context-review.json"), "utf8"),
      "checked-in JSON review must be freshly generated"
    );
    assert.equal(
      firstMarkdown,
      await readFile(path.join(process.cwd(), "docs/generated/provider-context-review/provider-context-review.md"), "utf8"),
      "checked-in Markdown review must be freshly generated"
    );
    const rerun = spawnSync(process.execPath, ["scripts/review-provider-context.mjs", "--out", out], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    assert.equal(await readFile(jsonPath, "utf8"), firstJson);
    assert.equal(await readFile(markdownPath, "utf8"), firstMarkdown);

    const artifact = JSON.parse(firstJson) as ReviewArtifact;
    const markdown = firstMarkdown;

    assert.match(artifact.renderedProjectContext, /^<project_context>/);
    assert.match(artifact.renderedProjectContext, /Project-specific instructions and guidelines:/);
    assert.match(artifact.renderedProjectContext, /<project_instructions path="\/review\/workspace\/AGENTS\.md">/);
    assert.match(artifact.renderedProjectContext, /SENTINEL_AGENTS_CONTENT/);
    assert.match(artifact.renderedProjectContext, /<\/project_context>$/);
    assert.match(artifact.renderedSkillCatalog, /The following skills provide specialized instructions/);
    assert.match(artifact.renderedSkillCatalog, /<name>fixture-skill<\/name>/);
    assert.match(artifact.renderedSkillCatalog, /<description>SENTINEL_SKILL_DESCRIPTION<\/description>/);
    assert.match(artifact.renderedSkillCatalog, /<location>\/review\/skills\/fixture-skill\/SKILL\.md<\/location>/);
    assert.match(artifact.systemPrompt, /SENTINEL_AGENTS_CONTENT/);
    assert.match(artifact.systemPrompt, /SENTINEL_APPEND_SYSTEM_PROMPT/);
    assert.match(artifact.systemPrompt, /SENTINEL_CHILD_ROLE_AND_CONFINEMENT/);
    assert.match(artifact.systemPrompt, /SENTINEL_SKILL_DESCRIPTION/);
    assert.match(artifact.systemPrompt, /Current date: 2000-01-02/);
    assert.match(artifact.systemPrompt, /Current working directory: \/review\/workspace/);
    assert.doesNotMatch(artifact.systemPrompt, /<DATE>|<repo>|\/Users\//);
    assert.match(artifact.systemPrompt, /read_many use:/);
    assert.match(artifact.systemPrompt, /orchestrate constraints:/);
    assert.doesNotMatch(artifact.systemPrompt, /Batch-native tool usage:/);
    assert.doesNotMatch(artifact.systemPrompt, /hunk_session/);

    const names = artifact.activeTools.map((tool) => tool.name);
    const sortedRetainedToolNames = [...retainedToolNames].sort();
    assert.deepEqual([...names].sort(), sortedRetainedToolNames, "review covers exactly the 14 retained custom tools");
    assert.deepEqual(Object.keys(outputContractFragments).sort(), sortedRetainedToolNames, "output contract fixtures cover every retained tool");
    assert.equal(names.includes("hunk_session"), false);
    assert.equal(names.includes("bash"), false);
    for (const tool of artifact.activeTools) {
      assert.ok(tool.description.length > 20, `${tool.name} provider description`);
      assert.ok((tool.promptSnippet ?? "").length > 20, `${tool.name} system snippet`);
      assert.ok((tool.promptGuidelines ?? []).length > 0, `${tool.name} system guidelines`);
      const guidelines = (tool.promptGuidelines ?? []).join("\n");
      assert.match(guidelines, new RegExp(`${tool.name} input: JSON Schema:`), `${tool.name} minified JSON Schema guideline`);
      assert.match(guidelines, new RegExp(`${tool.name} output: Schema:`), `${tool.name} literal output schema guideline`);
      assert.match(guidelines, /Only content is provider-visible/, `${tool.name} provider-visible output boundary`);
      const inputGuideline = (tool.promptGuidelines ?? []).find((line) => line.startsWith(`${tool.name} input:`)) ?? "";
      const inputPrefix = `${tool.name} input: JSON Schema: `;
      assert.ok(inputGuideline.startsWith(inputPrefix), `${tool.name} input guideline uses the JSON Schema boundary`);
      const schemaText = inputGuideline.slice(inputPrefix.length);
      const promptedSchema = JSON.parse(schemaText) as unknown;
      assert.equal(schemaText, JSON.stringify(promptedSchema), `${tool.name} input schema is minified JSON`);
      assert.deepEqual(promptedSchema, tool.parameters, `${tool.name} prompted input schema exactly matches its provider declaration`);
      assert.ok(artifact.systemPrompt.includes(inputGuideline), `${tool.name} complete input schema reaches the effective system prompt`);
      assert.doesNotMatch(inputGuideline, /Schema: closed/, `${tool.name} does not use informal schema shorthand`);
      const outputFragments = outputContractFragments[tool.name];
      assert.ok(outputFragments, `${tool.name} has an audited literal output contract fixture`);
      const outputGuideline = (tool.promptGuidelines ?? []).find((line) => line.startsWith(`${tool.name} output:`)) ?? "";
      for (const fragment of outputFragments) assert.ok(outputGuideline.includes(fragment), `${tool.name} output schema includes ${fragment}`);
      assert.match(JSON.stringify(tool.parameters), /properties/);
      assert.deepEqual(Object.keys(tool.resultContract).sort(), ["content", "details", "error", "progress", "success"]);
      assert.ok(Object.values(tool.resultContract).every((entry) => entry.length > 20), `${tool.name} result contract`);
      assert.deepEqual(Object.keys(tool.fieldAudit).sort(), [
        "description", "execute", "executionMode", "label", "name", "parameters", "prepareArguments",
        "promptGuidelines", "promptSnippet", "renderCall", "renderResult", "renderShell"
      ]);
      for (const [field, review] of Object.entries(tool.fieldAudit)) {
        assert.ok(review.status === "reviewed" || review.reason, `${tool.name}.${field} must be reviewed or carry a non-applicable reason`);
      }
    }

    const openaiTools = artifact.providerPayloads.openaiCodexResponses.tools ?? [];
    const anthropicTools = artifact.providerPayloads.anthropicMessages.tools ?? [];
    assert.deepEqual(openaiTools.map((tool) => tool.name), names);
    assert.deepEqual(anthropicTools.map((tool) => tool.name), names);
    assert.match(openaiTools.find((tool) => tool.name === "read_many")?.description ?? "", /known text file ranges/);
    for (const tool of artifact.activeTools) {
      assert.deepEqual(
        openaiTools.find((candidate) => candidate.name === tool.name)?.parameters,
        tool.parameters,
        `${tool.name} complete input schema reaches the OpenAI provider declaration`
      );
      assert.deepEqual(
        anthropicTools.find((candidate) => candidate.name === tool.name)?.input_schema,
        anthropicWireSchema(tool.parameters),
        `${tool.name} input schema reaches Anthropic with only Pi's expected top-level normalization`
      );
    }
    assert.match(JSON.stringify(openaiTools.find((tool) => tool.name === "read_many")?.parameters), /1-indexed line number/);
    assert.match(JSON.stringify(anthropicTools.find((tool) => tool.name === "read_many")?.input_schema), /1-indexed line number/);

    const openaiWire = JSON.stringify(artifact.providerPayloads.openaiCodexResponses);
    const anthropicWire = JSON.stringify(artifact.providerPayloads.anthropicMessages);
    assert.match(openaiWire, /SENTINEL_RESULT_CONTENT/);
    assert.match(anthropicWire, /SENTINEL_RESULT_CONTENT/);
    assert.doesNotMatch(openaiWire, /SENTINEL_INTERNAL_DETAILS/);
    assert.doesNotMatch(anthropicWire, /SENTINEL_INTERNAL_DETAILS/);
    assert.match(JSON.stringify(artifact.toolResultVisibility.internalPiMessage.details), /SENTINEL_INTERNAL_DETAILS/);

    assert.match(markdown, /## Rendered project context/);
    assert.match(markdown, /## Rendered skill catalog/);
    assert.ok(markdown.indexOf("## Rendered project context") < markdown.indexOf("## Rendered system prompt"));
    assert.ok(markdown.indexOf("## Rendered skill catalog") < markdown.indexOf("## Rendered system prompt"));
    assert.match(markdown, /## Rendered system prompt/);
    assert.match(markdown, /## OpenAI Codex Responses request payload/);
    assert.match(markdown, /## Anthropic Messages request payload/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
