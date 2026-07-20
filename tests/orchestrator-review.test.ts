import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

test("reviewer pool advances after provider failure and records every attempt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orchestrator-review-fallback-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Review Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "review@example.invalid"], { cwd: root });
    await writeFile(path.join(root, "file.txt"), "before\n", "utf8");
    execFileSync("git", ["add", "file.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root });
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    await writeFile(path.join(root, "file.txt"), "after\n", "utf8");
    execFileSync("git", ["commit", "-am", "change"], { cwd: root });

    const writer = fakeModel("openai-codex", "writer");
    const reviewerOne = fakeModel("anthropic", "reviewer-one");
    const reviewerTwo = fakeModel("google", "reviewer-two");
    let calls = 0;
    const context = {
      modelRegistry: fakeRegistry([writer, reviewerOne, reviewerTwo]),
      ui: { notify(): void {} }
    } as unknown as Pick<ExtensionContext, "modelRegistry" | "ui">;
    const report = await reviewWriterBranch(context, {
      worktreePath: root,
      branch: "orch/run-task",
      baseCommit,
      task: "change the fixture",
      writerOutput: "changed file.txt",
      writerModel: writer,
      reviewerSpecs: ["anthropic/reviewer-one:xhigh", "google/reviewer-two:xhigh"],
      tools: ["search_many", "read_many"],
      shellTools: [],
      maxOutputChars: 10_000,
      spawn: async (_childContext, input) => {
        calls += 1;
        if (calls === 1) throw new Error("HTTP 429 rate limit");
        return {
          output: "Reviewed the diff.\nVERDICT: approve",
          model: `${input.model.provider}/${input.model.id}`,
          thinkingLevel: input.thinkingLevel,
          toolCallCount: 0,
          durationMs: 1,
          deniedCalls: []
        };
      }
    });
    assert.equal(report.status, "approve");
    assert.equal(calls, 2);
    assert.deepEqual(report.attempts.map((attempt) => attempt.status), ["failed", "approve"]);
    assert.match(report.attempts[0].error ?? "", /429/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
