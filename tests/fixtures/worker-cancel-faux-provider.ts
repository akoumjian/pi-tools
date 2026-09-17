import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

export default function workerCancelFauxProviderExtension(api: ExtensionAPI): void {
  const workspaceRoot = requiredEnvironment("PI_WORKER_WORKSPACE_ROOT");
  const marker = `${workspaceRoot}/owned-shell.pid`;
  const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const faux = fauxProvider({
    api: "worker-cancel-faux-api",
    provider: "worker-cancel-faux",
    models: [{
      id: "worker-cancel-faux-1",
      name: "Worker Cancel Faux Model",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 16_384
    }]
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("shell_start", {
      commands: [{
        command: `node -e ${JSON.stringify(source)}`,
        cwd: workspaceRoot,
        job_name: "owned cancellation probe",
        notifyOnExit: false
      }]
    }), { stopReason: "toolUse" })
  ]);
  api.registerProvider(faux.provider);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Cancellation fixture requires ${name}.`);
  return value;
}
