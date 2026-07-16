import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  formatModelName,
  resolveExtensionModel,
  type ExtensionModelRegistry,
  type ResolvedExtensionModel
} from "../_shared/model-spec.js";
import type { OrchestratorSettings } from "./settings.js";

export type OrchestratorTaskRole = "reader" | "planner" | "writer" | "reviewer";
export type ReadOnlyTaskRole = "reader" | "planner";
export type TaskModelRequest = { role: OrchestratorTaskRole; model?: string; thinkingLevel?: ThinkingLevel };

export function resolveTaskModel(
  registry: ExtensionModelRegistry,
  settings: OrchestratorSettings,
  request: TaskModelRequest,
  currentModel?: Model<Api>
): ResolvedExtensionModel {
  const configured = request.role === "planner"
    ? settings.models.planner
    : request.role === "writer"
      ? settings.models.worker
      : settings.models.reader ?? settings.models.worker;
  const requested = request.model
    ? request.thinkingLevel ? `${request.model}:${request.thinkingLevel}` : request.model
    : configured;
  return resolveExtensionModel({
    registry,
    requested,
    currentModel: requested ? undefined : currentModel,
    fallbackThinkingLevel: request.role === "reader" ? "medium" : "xhigh",
    label: `Orchestrator ${request.role}`,
    noModelMessage: `No ${request.role} model is configured. Run /orchestrator:setup or pass a per-task model.`
  });
}

export function selectDistinctReviewer(
  registry: ExtensionModelRegistry,
  reviewerSpecs: string[],
  implementer: Pick<Model<Api>, "provider">
): ResolvedExtensionModel {
  const errors: string[] = [];
  for (const requested of reviewerSpecs) {
    try {
      const resolved = resolveExtensionModel({
        registry,
        requested,
        fallbackThinkingLevel: "xhigh",
        label: "Orchestrator reviewer",
        noModelMessage: "No reviewer model is configured."
      });
      if (resolved.model.provider.toLowerCase() !== implementer.provider.toLowerCase()) return resolved;
      errors.push(`${formatModelName(resolved.model)} uses implementer provider ${implementer.provider}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const detail = errors.length > 0 ? ` Candidates rejected: ${errors.join("; ")}.` : "";
  throw new Error(`No independent reviewer is available for implementer provider ${implementer.provider}.${detail}`);
}

export function canonicalModelSpec(resolved: ResolvedExtensionModel): string {
  return `${formatModelName(resolved.model)}:${resolved.thinkingLevel}`;
}
