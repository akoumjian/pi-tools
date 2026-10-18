import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkerFauxProvider } from "./worker-faux-provider.js";

export default function workerPreflightFailureExtension(api: ExtensionAPI): void {
  const faux = createWorkerFauxProvider();
  api.registerProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Intentionally unavailable worker test credential",
        check: async () => undefined,
        resolve: async () => undefined
      }
    }
  });
}
