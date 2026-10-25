import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderWorkerRuntimePrompt } from "../extensions/worker/prompts.js";
const base = { workerId: "worker_1", runId: "run_2", workspaceRoot: "/workspace", codeRoot: "/code", taskIds: ["personal-test"], roleInstructions: "Do the role.", instructions: "Do the assignment." };

test("work start prompt matches the approved structure exactly", () => {
  assert.equal(renderWorkerRuntimePrompt("work", { ...base, repositoryBaselines: [{ path: "/code/project", resolvedCommit: "abc" }] }), `You are worker worker_1, run run_2, forked from a parent session. You are running in a sandboxed environment with modified file access and permissions.

Writable workspace:
/workspace

General read-only access:
/code

The complete Code directory is available for your reference as needed.

Assigned Beads tasks:
personal-test

Role instructions:
Do the role.

Assignment:
Do the assignment.

Provenance-only repository baselines:
- parent-observed /code/project at abc

These entries are provenance only. Their paths are not mounted into the worker and may be unreachable here; they do not populate the workspace.`);
});

test("work resume prompt retains exact session semantics and lists additional inputs", () => {
  const prompt = renderWorkerRuntimePrompt("work", { ...base, resumed: true, additionalInputs: [{ sourcePath: "/host/spec", mountedPath: "/inputs/01-spec", type: "file" }] });
  assert.match(prompt, /^You are worker worker_1, run run_2, resuming a prior session\./); assert.match(prompt, /Parent instructions:\nDo the assignment\./); assert.match(prompt, /- \/host\/spec -> \/inputs\/01-spec \(file\)/); assert.doesNotMatch(prompt, /snapshot|refork/i);
});

test("review start and resume prompts are independent and name only trusted launch paths", () => {
  const start = renderWorkerRuntimePrompt("review", { ...base, instructions: undefined, reviewSubjectPath: "/review/subject", reviewContextPath: "/review/context.json" });
  assert.match(start, /^You are worker worker_1, run run_2, starting an independent review\./); assert.match(start, /Reviewed workspace:\n\/review\/subject/); assert.match(start, /reviewed workspace is read-only.*separate writable reviewer workspace/i); assert.doesNotMatch(start, /Assigned Beads|Parent review instructions|artifacts\//);
  const resume = renderWorkerRuntimePrompt("review", { ...base, resumed: true, reviewSubjectPath: "/review/subject", reviewContextPath: "/review/context.json" });
  assert.match(resume, /resuming a prior review session/); assert.match(resume, /reviewed workspace remains read-only.*retained writable reviewer workspace/i); assert.match(resume, /Parent instructions:/); assert.doesNotMatch(resume, /fork/);
});

test("integration prompts include ordinary conflict-state and retained-repository guidance", () => {
  const start = renderWorkerRuntimePrompt("integration", { ...base, integrationContextPath: "/worker/integration-context.json" }); assert.match(start, /starting repository integration/); assert.match(start, /ordinary Git conflict state produced by `worker_merge_test`/);
  const resume = renderWorkerRuntimePrompt("integration", { ...base, resumed: true, integrationContextPath: "/worker/integration-context.json" }); assert.match(resume, /prepared repositories and prior integration work remain/); assert.doesNotMatch(resume, /fork|snapshot/i);
});

test("cancelled resume adds only the trusted interrupted-operation warning", () => { assert.match(renderWorkerRuntimePrompt("work", { ...base, resumed: true, cancelledPreviously: true }), /Do not remove locks or abort Git state/); });

test("approved role instruction files contain no shell choreography or hard-coded launch paths", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "worker-roles");
  for (const role of ["work", "review", "integration"]) { const text = readFileSync(path.join(root, `${role}.md`), "utf8"); assert.match(text, new RegExp(`^# ${role[0]!.toUpperCase()}${role.slice(1)}-Role Instructions`)); assert.doesNotMatch(text, /shell_(?:status|read|cancel)|owned asynchronous|wait for|\/review\/subject|\/integration\/context/); }
});
