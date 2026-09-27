import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

export default function workerNoHandoffFauxProviderExtension(api: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "worker-no-handoff-faux-api",
    provider: "worker-no-handoff-faux",
    models: [{
      id: "worker-no-handoff-faux-1",
      name: "Worker No-Handoff Faux Model",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 16_384
    }]
  });
  faux.setResponses([
    fauxAssistantMessage("I am stopping without the required typed worker_handoff.")
  ]);
  api.registerProvider(faux.provider);
}
