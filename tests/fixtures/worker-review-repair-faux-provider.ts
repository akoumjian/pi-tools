import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

export default function workerReviewRepairFauxProviderExtension(api: ExtensionAPI): void {
  const workspaceRoot = requiredEnvironment("PI_WORKER_WORKSPACE_ROOT");
  const report = path.join(workspaceRoot, "artifacts", "review-repair.md");
  mkdirSync(path.dirname(report), { recursive: true });
  writeFileSync(report, "# Review\n\nApproved after the bounded typed-result repair turn.\n");
  const faux = fauxProvider({
    api: "worker-review-repair-faux-api",
    provider: "worker-review-repair-faux",
    models: [{
      id: "worker-review-repair-faux-1",
      name: "Worker Review Repair Faux Model",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 16_384
    }]
  });
  faux.setResponses([
    fauxAssistantMessage("The candidate is approved, but I omitted the required typed submission."),
    (context) => {
      const repairRequested = JSON.stringify(context.messages).includes("Do not restate the verdict in prose");
      return fauxAssistantMessage(fauxToolCall("worker_result_submit", {
        outcome: repairRequested ? "approve" : "blocked",
        summary: repairRequested ? "Approved through the bounded typed-result repair turn." : "The repair instruction was missing.",
        artifacts: ["artifacts/review-repair.md"]
      }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("The typed review result is durable.")
  ]);
  api.registerProvider(faux.provider);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Review repair fixture requires ${name}.`);
  return value;
}
