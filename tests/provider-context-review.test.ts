import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

type ReviewArtifact = {
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
    const rerun = spawnSync(process.execPath, ["scripts/review-provider-context.mjs", "--out", out], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    assert.equal(await readFile(jsonPath, "utf8"), firstJson);
    assert.equal(await readFile(markdownPath, "utf8"), firstMarkdown);

    const artifact = JSON.parse(firstJson) as ReviewArtifact;
    const markdown = firstMarkdown;

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
    assert.ok(names.includes("read_many"));
    assert.ok(names.includes("orchestrate"));
    assert.ok(names.includes("reconcile"));
    assert.equal(names.includes("hunk_session"), false);
    assert.equal(names.includes("bash"), false);
    for (const tool of artifact.activeTools) {
      assert.ok(tool.description.length > 20, `${tool.name} provider description`);
      assert.ok((tool.promptSnippet ?? "").length > 20, `${tool.name} system snippet`);
      assert.ok((tool.promptGuidelines ?? []).length > 0, `${tool.name} system guidelines`);
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
    assert.match(JSON.stringify(openaiTools.find((tool) => tool.name === "read_many")?.parameters), /1-indexed line number/);
    assert.match(JSON.stringify(anthropicTools.find((tool) => tool.name === "read_many")?.input_schema), /1-indexed line number/);

    const openaiWire = JSON.stringify(artifact.providerPayloads.openaiCodexResponses);
    const anthropicWire = JSON.stringify(artifact.providerPayloads.anthropicMessages);
    assert.match(openaiWire, /SENTINEL_RESULT_CONTENT/);
    assert.match(anthropicWire, /SENTINEL_RESULT_CONTENT/);
    assert.doesNotMatch(openaiWire, /SENTINEL_INTERNAL_DETAILS/);
    assert.doesNotMatch(anthropicWire, /SENTINEL_INTERNAL_DETAILS/);
    assert.match(JSON.stringify(artifact.toolResultVisibility.internalPiMessage.details), /SENTINEL_INTERNAL_DETAILS/);

    assert.match(markdown, /## Rendered system prompt/);
    assert.match(markdown, /## OpenAI Codex Responses request payload/);
    assert.match(markdown, /## Anthropic Messages request payload/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
