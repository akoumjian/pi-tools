import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

export default function workerMultiturnFauxProviderExtension(api: ExtensionAPI): void {
  const workspaceRoot = requiredEnvironment("PI_WORKER_WORKSPACE_ROOT");
  const source = "setTimeout(() => {}, 6500)";
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
    fauxAssistantMessage("The asynchronous command is still running; I will hand off after its completion follow-up."),
    fauxAssistantMessage(fauxToolCall("worker_handoff", {
      state: "assignment_complete",
      summary: "Completed handoff on the asynchronous follow-up turn.",
      taskUpdates: [{ taskId: "personal-worker-e2e", update: "Multiturn lifecycle passed." }],
      checks: [{ cwd: ".", command: "async follow-up", outcome: "passed" }]
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The multiturn handoff is durable.")
  ]);
  api.registerProvider(faux.provider);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Multiturn fixture requires ${name}.`);
  return value;
}
