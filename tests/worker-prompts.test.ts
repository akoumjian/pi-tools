import assert from "node:assert/strict";
import test from "node:test";
import { renderWorkerRuntimePrompt } from "../extensions/worker/prompts.js";
const base = { workerId: "worker_1", runId: "run_2", workspaceRoot: "/workspace", codeRoot: "/code", taskIds: ["personal-test"], roleInstructions: "Do the role.", instructions: "Do the assignment." };
test("role prompts preserve exact session identity and authority context", () => {
  const work = renderWorkerRuntimePrompt("work", base); assert.match(work, /starting a work session/); assert.match(work, /Assigned Beads tasks:\npersonal-test/);
  const review = renderWorkerRuntimePrompt("review", { ...base, reviewContextPath: "/review/context.json" }); assert.match(review, /\/review\/subject/); assert.match(review, /disposable/);
  const integration = renderWorkerRuntimePrompt("integration", { ...base, resumed: true, integrationContextPath: "/integration/context.json" }); assert.match(integration, /resuming a prior integration session/); assert.match(integration, /prior integration work remain/); assert.doesNotMatch(integration, /fork/);
});
test("cancelled resume adds a trusted recovery warning", () => { assert.match(renderWorkerRuntimePrompt("work", { ...base, resumed: true, cancelledPreviously: true }), /Do not remove locks/); });
