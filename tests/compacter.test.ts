import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkTexts,
  classifyAnthropicFailure,
  createSummarizationBudget,
  parseCompacterCommandArgs
} from "../extensions/compacter/index.js";

test("parseCompacterCommandArgs treats empty args as manual compaction", () => {
  assert.deepEqual(parseCompacterCommandArgs(""), { action: "run" });
});

test("parseCompacterCommandArgs supports model override and trailing instructions", () => {
  assert.deepEqual(parseCompacterCommandArgs("--model anthropic/claude-sonnet-4-6 focus on decisions"), {
    action: "run",
    model: "anthropic/claude-sonnet-4-6",
    instructions: "focus on decisions"
  });
  assert.deepEqual(parseCompacterCommandArgs("--model=anthropic/claude-opus-4-7 -- focus on errors"), {
    action: "run",
    model: "anthropic/claude-opus-4-7",
    instructions: "focus on errors"
  });
});

test("parseCompacterCommandArgs supports explicit management subcommands", () => {
  assert.deepEqual(parseCompacterCommandArgs("status"), { action: "status" });
  assert.deepEqual(parseCompacterCommandArgs("on"), { action: "on" });
  assert.deepEqual(parseCompacterCommandArgs("off"), { action: "off" });
  assert.deepEqual(parseCompacterCommandArgs("toggle"), { action: "toggle" });
  assert.throws(() => parseCompacterCommandArgs("status now"), /does not accept extra arguments/);
});

test("chunkTexts splits oversized text and keeps chunks within the token budget", () => {
  const chunks = chunkTexts(["a".repeat(100), "b".repeat(100), "c".repeat(100)], 25, "item");
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.tokens <= 35));
});

test("createSummarizationBudget leaves input budget below model context", () => {
  const budget = createSummarizationBudget({ contextWindow: 200_000, maxTokens: 16_384 }, 16_384);
  assert.equal(budget.finalMaxTokens, 13_107);
  assert.equal(budget.intermediateMaxTokens, 4_096);
  assert.equal(budget.chunkInputTokens, 40_000);
});

test("classifyAnthropicFailure distinguishes 429 usage limits from overloads", () => {
  assert.equal(
    classifyAnthropicFailure('429 {"error":{"type":"rate_limit_error","message":"usage limit exceeded"}}'),
    "Anthropic usage or quota limit (HTTP 429, not a server-busy 529)"
  );
  assert.equal(
    classifyAnthropicFailure('529 {"error":{"type":"overloaded_error","message":"Overloaded"}}'),
    "Anthropic temporary overload (normally HTTP 529)"
  );
  assert.equal(classifyAnthropicFailure("plain error"), undefined);
});
