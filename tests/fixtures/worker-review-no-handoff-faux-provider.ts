import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

export default function workerReviewNoHandoffFauxProviderExtension(api: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "worker-review-no-handoff-faux-api",
    provider: "worker-review-no-handoff-faux",
    models: [{ id: "worker-review-no-handoff-faux-1", name: "Worker Review No-Handoff Faux Model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 16_384 }]
  });
  faux.setResponses([
    fauxAssistantMessage("I omitted the typed result on the initial review turn."),
    fauxAssistantMessage("I also ignored the bounded typed-result repair instruction.")
  ]);
  api.registerProvider(faux.provider);
}
