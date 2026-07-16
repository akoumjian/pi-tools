import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildWriterReviewTask, parseReviewVerdict, reviewWriterBranch } from "../extensions/orchestrator/review.js";

function fakeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000
  } as Model<Api>;
}

function fakeRegistry(models: Model<Api>[]) {
  return {
    hasConfiguredAuth(): boolean { return true; },
    getAll(): Model<Api>[] { return models; }
  };
}

test("review verdict parsing is strict, case-insensitive, and last-line wins", () => {
  assert.equal(parseReviewVerdict("Looks good.\nVERDICT: approve"), "approve");
  assert.equal(parseReviewVerdict("findings...\nverdict: REQUEST_CHANGES"), "request_changes");
  assert.equal(parseReviewVerdict("VERDICT: request changes"), "request_changes");
  assert.equal(parseReviewVerdict("**VERDICT: approve**"), "approve");
  assert.equal(parseReviewVerdict("early VERDICT: approve\nlater\nVERDICT: request_changes"), "request_changes");
  assert.equal(parseReviewVerdict("I approve of this change."), undefined);
  assert.equal(parseReviewVerdict("VERDICT: maybe"), undefined);
  assert.equal(parseReviewVerdict("the line `VERDICT: approve` must be final, inline mentions do not count"), undefined);
});

test("review task includes task, handoff, diff sections and truncates large diffs", () => {
  const task = buildWriterReviewTask({
    task: "Add input validation to the parser.",
    writerOutput: "Implemented validation in parser.ts.",
    branch: "orch/run-writer",
    baseCommit: "a".repeat(40),
    diffStat: "parser.ts | 10 +++++++---",
    diff: "x".repeat(100),
    maxDiffChars: 40
  });
  assert.match(task, /## Task the writer was given\nAdd input validation/);
  assert.match(task, /## Writer's handoff\nImplemented validation/);
  assert.match(task, /parser\.ts \| 10/);
  assert.match(task, /\[Diff truncated: 60 characters omitted/);
  assert.match(task, /VERDICT: approve` or `VERDICT: request_changes`/);
  assert.equal(task.includes("x".repeat(41)), false);
});

test("review fails closed before spawning when no independent provider exists", async () => {
  const writer = fakeModel("openai-codex", "gpt-5.6-sol");
  const sameProviderReviewer = fakeModel("openai-codex", "codex-auto-review");
  const context = {
    modelRegistry: fakeRegistry([writer, sameProviderReviewer]),
    ui: { notify(): void {} }
  } as unknown as Pick<ExtensionContext, "modelRegistry" | "ui">;
  const report = await reviewWriterBranch(context, {
    worktreePath: "/nonexistent/worktree",
    branch: "orch/run-task",
    baseCommit: "b".repeat(40),
    task: "task",
    writerOutput: "output",
    writerModel: writer,
    reviewerSpecs: ["openai-codex/codex-auto-review:xhigh"],
    tools: ["search_many", "read_many"],
    shellTools: ["shell_start"],
    maxOutputChars: 10_000
  });
  assert.equal(report.status, "failed");
  assert.match(report.error ?? "", /No independent reviewer.*openai-codex/);
});
