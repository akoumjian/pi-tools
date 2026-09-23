import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  assertChildAgentRouteAllowed,
  assertSubagentRouteAllowed,
  assertSubagentRouteSpecAllowed,
  parseModelThinkingPair,
  resolveExtensionModel
} from "../extensions/_shared/model-spec.js";

function fakeModel(
  provider: string,
  id: string,
  reasoning = true,
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"]
): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: "https://example.invalid",
    reasoning,
    thinkingLevelMap,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000
  } as Model<Api>;
}

function fakeRegistry(models: Model<Api>[], authed: Set<string> = new Set(models.map((model) => `${model.provider}/${model.id}`))) {
  return {
    hasConfiguredAuth(model: Model<Api>): boolean {
      return authed.has(`${model.provider}/${model.id}`);
    },
    getAll(): Model<Api>[] {
      return models;
    }
  };
}

test("resolveExtensionModel applies fallback thinking for plain provider/model specs", () => {
  const model = fakeModel("anthropic", "claude-opus-4-7", true, { xhigh: "xhigh" });
  const resolved = resolveExtensionModel({
    registry: fakeRegistry([model]),
    requested: "anthropic/claude-opus-4-7",
    fallbackThinkingLevel: "xhigh",
    label: "Review",
    noModelMessage: "missing"
  });

  assert.deepEqual(resolved, { model, thinkingLevel: "xhigh" });
});

test("resolveExtensionModel lets inline thinking override configured fallback", () => {
  const model = fakeModel("anthropic", "claude-opus-4-7", true, { max: "max" });
  const resolved = resolveExtensionModel({
    registry: fakeRegistry([model]),
    requested: "anthropic/claude-opus-4-7:max",
    fallbackThinkingLevel: "xhigh",
    label: "Review",
    noModelMessage: "missing"
  });

  assert.deepEqual(resolved, { model, thinkingLevel: "max" });
});

test("resolveExtensionModel clamps unavailable extended thinking levels using model metadata", () => {
  const xhighModel = fakeModel("anthropic", "claude-opus-4-7", true, { xhigh: "xhigh" });
  const standardModel = fakeModel("anthropic", "claude-opus-4-6");

  assert.equal(resolveExtensionModel({
    registry: fakeRegistry([xhighModel]),
    requested: "anthropic/claude-opus-4-7:max",
    fallbackThinkingLevel: "low",
    label: "Review",
    noModelMessage: "missing"
  }).thinkingLevel, "xhigh");

  assert.equal(resolveExtensionModel({
    registry: fakeRegistry([standardModel]),
    requested: "anthropic/claude-opus-4-6:xhigh",
    fallbackThinkingLevel: "low",
    label: "Review",
    noModelMessage: "missing"
  }).thinkingLevel, "high");
});

test("resolveExtensionModel supports bare model ids with inline thinking", () => {
  const model = fakeModel("anthropic", "claude-opus-4-7");
  const resolved = resolveExtensionModel({
    registry: fakeRegistry([model]),
    requested: "claude-opus-4-7:medium",
    fallbackThinkingLevel: "xhigh",
    label: "Review",
    noModelMessage: "missing"
  });

  assert.deepEqual(resolved, { model, thinkingLevel: "medium" });
});

test("resolveExtensionModel preserves colons inside model ids", () => {
  const exacto = fakeModel("openrouter", "foo:exacto");
  const registry = fakeRegistry([exacto]);

  assert.deepEqual(resolveExtensionModel({
    registry,
    requested: "openrouter/foo:exacto",
    fallbackThinkingLevel: "low",
    label: "Review",
    noModelMessage: "missing"
  }), { model: exacto, thinkingLevel: "low" });

  assert.deepEqual(resolveExtensionModel({
    registry,
    requested: "openrouter/foo:exacto:high",
    fallbackThinkingLevel: "low",
    label: "Review",
    noModelMessage: "missing"
  }), { model: exacto, thinkingLevel: "high" });
});

test("resolveExtensionModel clamps thinking to off for non-reasoning models", () => {
  const model = fakeModel("openai", "gpt-4o", false);
  const resolved = resolveExtensionModel({
    registry: fakeRegistry([model]),
    requested: "openai/gpt-4o:xhigh",
    fallbackThinkingLevel: "high",
    label: "Review",
    noModelMessage: "missing"
  });

  assert.deepEqual(resolved, { model, thinkingLevel: "off" });
});

test("resolveExtensionModel validates auth and missing models loudly", () => {
  const model = fakeModel("openai-codex", "gpt-5.3-codex-spark");
  const registry = fakeRegistry([model], new Set());

  assert.throws(() => resolveExtensionModel({
    registry,
    requested: "openai-codex/gpt-5.3-codex-spark",
    fallbackThinkingLevel: "low",
    label: "Mutation review",
    noModelMessage: "missing"
  }), /no configured auth/);

  assert.throws(() => resolveExtensionModel({
    registry,
    requested: "missing-format",
    fallbackThinkingLevel: "low",
    label: "Mutation review",
    noModelMessage: "missing"
  }), /not found/);
});

test("parseModelThinkingPair splits on the last colon and validates thinking", () => {
  assert.deepEqual(parseModelThinkingPair("openrouter/foo:exacto:high"), {
    model: "openrouter/foo:exacto",
    thinkingLevel: "high"
  });
  assert.throws(() => parseModelThinkingPair("openrouter/foo:exacto"), /Invalid thinking level exacto/);
  assert.throws(() => parseModelThinkingPair("openai/gpt-4o"), /model:thinking/);
});


test("subagent route policy rejects max and Claude Fable without false positives", () => {
  assert.throws(
    () => assertSubagentRouteSpecAllowed("openai-codex/gpt-6:max", "Worker route"),
    /capped at xhigh.*never clamped or substituted/
  );
  assert.throws(
    () => assertSubagentRouteAllowed({ provider: "anthropic", model: "claude-fable-5-1", thinkingLevel: "xhigh" }, "Review route"),
    /Claude Fable models cannot be used for subagents/
  );
  assert.throws(
    () => assertChildAgentRouteAllowed(fakeModel("anthropic", "claude-fable-5"), "low"),
    /non-Fable model/
  );
  for (const spec of [
    "vercel-ai-gateway/anthropic/claude-fable-5:xhigh",
    "amazon-bedrock/us.anthropic.claude-fable-5-20260901-v1:0:xhigh",
    "gateway/catalog/CLAUDE.FABLE_5:xhigh"
  ]) assert.throws(() => assertSubagentRouteSpecAllowed(spec), /Claude Fable/);
  assert.throws(
    () => assertChildAgentRouteAllowed(fakeModel("amazon-bedrock", "us.anthropic.claude-fable-5-20260901-v1:0"), "xhigh"),
    /Claude Fable/
  );
  assert.throws(
    () => assertChildAgentRouteAllowed({ ...fakeModel("amazon-bedrock", "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/profile-opaque"), name: "Claude Fable 5" }, "xhigh"),
    /Claude Fable/
  );
  assert.doesNotThrow(() => assertSubagentRouteAllowed({ provider: "anthropic", model: "claude-opus-5-5", thinkingLevel: "xhigh" }));
  assert.doesNotThrow(() => assertSubagentRouteAllowed({ provider: "example", model: "claude-fablet-5", thinkingLevel: "high" }));
  assert.doesNotThrow(() => assertSubagentRouteAllowed({ provider: "example", model: "my-fable-model", thinkingLevel: "off" }));
  assert.doesNotThrow(() => assertSubagentRouteAllowed({ provider: "example", model: "notclaude-fable-5", thinkingLevel: "off" }));
  assert.doesNotThrow(() => assertSubagentRouteAllowed({ provider: "example", model: "vendor/claude-fablet-5", thinkingLevel: "off" }));
});
