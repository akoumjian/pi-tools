import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

export default function workerMultiturnFauxProviderExtension(api: ExtensionAPI): void {
  const workspaceRoot = requiredEnvironment("PI_WORKER_WORKSPACE_ROOT");
  const source = "setTimeout(() => {}, 9000)";
  const postIdleCommands = Array.from({ length: 12 }, (_, index) => ({
    command: `node -e ${JSON.stringify("setTimeout(() => {}, 300)")}`,
    cwd: workspaceRoot,
    job_name: `post-idle publication probe ${index + 1}`,
    notifyOnExit: false
  }));
  const faux = fauxProvider({
    api: "worker-multiturn-faux-api",
    provider: "worker-multiturn-faux",
    models: [{
      id: "worker-multiturn-faux-1",
      name: "Worker Multiturn Faux Model",
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
        job_name: "multiturn completion probe"
      }]
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The asynchronous command is still running; I will continue after its completion follow-up."),
    fauxAssistantMessage(fauxToolCall("shell_start", { commands: postIdleCommands }), { stopReason: "toolUse" }),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 750));
      return fauxAssistantMessage(fauxToolCall("worker_result_submit", {
        outcome: "completed",
        summary: "Completed handoff after atomically publishing a post-idle shell batch.",
        artifacts: []
      }), { stopReason: "toolUse" });
    },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return fauxAssistantMessage("The multiturn handoff is durable.");
    }
  ]);
  api.registerProvider(faux.provider);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Multiturn fixture requires ${name}.`);
  return value;
}
