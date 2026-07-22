import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseModelThinkingPair, resolveExtensionModel } from "../extensions/_shared/model-spec.js";

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
