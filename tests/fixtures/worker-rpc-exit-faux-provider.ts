import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkerFauxProvider } from "./worker-faux-provider.js";

export default function workerRpcExitFauxProviderExtension(api: ExtensionAPI): void {
  const faux = createWorkerFauxProvider();
  faux.setResponses([
    () => {
      setTimeout(() => process.exit(23), 50);
      return new Promise<never>(() => {});
    }
  ]);
  api.registerProvider(faux.provider);
}
