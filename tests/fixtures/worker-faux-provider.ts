import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

const PROVIDER = "worker-faux";
const MODEL = "worker-faux-1";

export default function workerFauxProviderExtension(api: ExtensionAPI): void {
  const workspaceRoot = process.env.PI_WORKER_WORKSPACE_ROOT;
  if (!workspaceRoot) throw new Error("Worker faux provider requires PI_WORKER_WORKSPACE_ROOT.");
  const postHandoffMarker = `${workspaceRoot}/post-handoff-side-effect`;
  const faux = fauxProvider({
    api: "worker-faux-api",
    provider: PROVIDER,
    models: [{
      id: MODEL,
      name: "Worker Faux Model",
      reasoning: false,
      input: ["text"],
      contextWindow: 128_000,
      maxTokens: 16_384
    }]
  });
  faux.setResponses([
    (context) => {
      const serialized = JSON.stringify(context.messages);
      const toolNames = (context.tools ?? []).map((tool) => tool.name).sort();
      const checks = {
        exactParentContext: serialized.includes("PARENT_EXACT_MARKER"),
        workerPrompt: serialized.includes("WORKER_PROMPT_MARKER"),
        projectPoisonAbsent: !(context.systemPrompt ?? "").includes("WORKSPACE_SYSTEM_POISON") && !serialized.includes("WORKSPACE_SYSTEM_POISON"),
        exactTools: JSON.stringify(toolNames) === JSON.stringify(["shell_cancel", "shell_read", "shell_start", "shell_status", "worker_handoff", "worker_task_read", "worker_task_update"])
      };
      const passed = Object.values(checks).every(Boolean);
      return fauxAssistantMessage(fauxToolCall("worker_handoff", {
        state: passed ? "assignment_complete" : "failed",
        summary: passed ? "Fake provider verified the exact fork and isolated startup surface." : `Fake provider checks failed: ${JSON.stringify(checks)}`,
        taskUpdates: [{
          taskId: "personal-workere2e",
          update: JSON.stringify(checks)
        }],
        checks: [{
          cwd: ".",
          command: "fake-provider-startup-contract",
          outcome: passed ? "passed" : "failed"
        }]
      }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage(fauxToolCall("shell_start", {
      commands: [{ command: `printf escaped > ${JSON.stringify(postHandoffMarker)}`, cwd: workspaceRoot, notifyOnExit: false }]
    }), { stopReason: "toolUse" }),
    fauxAssistantMessage("The post-handoff shell attempt was rejected; the typed handoff can settle without later side effects.")
  ]);
  api.registerProvider(faux.provider);
}
