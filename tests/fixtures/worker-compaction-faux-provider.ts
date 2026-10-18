import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createWorkerFauxProvider } from "./worker-faux-provider.js";

export default function workerCompactionFauxProviderExtension(api: ExtensionAPI): void {
  const faux = createWorkerFauxProvider();
  faux.setResponses([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return fauxAssistantMessage("Compacted the inherited parent context.");
    },
    fauxAssistantMessage(fauxToolCall("worker_result_submit", {
      outcome: "completed",
      summary: "Completed after pre-prompt compaction.",
      artifacts: []
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The post-compaction handoff is durable.")
  ]);
  api.registerProvider(faux.provider);
}
