import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  formatModelName,
  parseOptionalModelThinkingPair,
  resolveExtensionModel,
  type ExtensionModelRegistry,
  type ResolvedExtensionModel
} from "../_shared/model-spec.js";
import type { OrchestratorSettings } from "./settings.js";

export type OrchestratorTaskRole = "reader" | "planner" | "writer" | "reviewer";
export type ReadOnlyTaskRole = "reader" | "planner";
export type TaskModelRequest = {
  role: OrchestratorTaskRole;
  model?: string;
  fallbackModels?: string[];
  thinkingLevel?: ThinkingLevel;
};

export type RejectedModelRoute = {
  requested: string;
  error: string;
};

export type ResolvedTaskModelCandidates = {
  candidates: ResolvedExtensionModel[];
  rejected: RejectedModelRoute[];
};

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
    ? withThinkingOverride(request.model, request.thinkingLevel)
    : configured
      ? withThinkingOverride(configured, request.thinkingLevel)
      : undefined;
  return resolveExtensionModel({
    registry,
    requested,
    currentModel: requested ? undefined : currentModel,
    fallbackThinkingLevel: request.thinkingLevel ?? (request.role === "reader" ? "medium" : "xhigh"),
    label: `Orchestrator ${request.role}`,
    noModelMessage: `No ${request.role} model is configured. Run /orchestrator:setup or pass a per-task model.`
  });
}

export function resolveTaskModelCandidates(
  registry: ExtensionModelRegistry,
  settings: OrchestratorSettings,
  request: TaskModelRequest,
  currentModel?: Model<Api>
): ResolvedTaskModelCandidates {
  const candidates: ResolvedExtensionModel[] = [];
  const rejected: RejectedModelRoute[] = [];
  const routes: Array<{ requested?: string; label: string }> = [
    { requested: request.model, label: request.model ?? `configured ${request.role} route` },
    ...(request.fallbackModels ?? []).map((requested) => ({ requested, label: requested }))
  ];

  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index];
    try {
      const resolved = resolveTaskModel(registry, settings, {
        role: request.role,
        ...(route.requested ? { model: route.requested } : {}),
        thinkingLevel: request.thinkingLevel
      }, index === 0 ? currentModel : undefined);
      const key = canonicalModelSpec(resolved).toLowerCase();
      if (!candidates.some((candidate) => canonicalModelSpec(candidate).toLowerCase() === key)) candidates.push(resolved);
    } catch (error) {
      rejected.push({ requested: route.label, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (candidates.length === 0) {
    const detail = rejected.map((failure) => `${failure.requested}: ${failure.error}`).join("; ");
    throw new Error(`No usable ${request.role} model route is available.${detail ? ` Routes rejected: ${detail}` : ""}`);
  }
  return { candidates, rejected };
}

export function listDistinctReviewers(
  registry: ExtensionModelRegistry,
  reviewerSpecs: string[],
  implementer: Pick<Model<Api>, "provider">
): { candidates: ResolvedExtensionModel[]; rejected: RejectedModelRoute[] } {
  const candidates: ResolvedExtensionModel[] = [];
  const rejected: RejectedModelRoute[] = [];
  for (const requested of reviewerSpecs) {
    try {
      const resolved = resolveExtensionModel({
        registry,
        requested,
        fallbackThinkingLevel: "xhigh",
        label: "Orchestrator reviewer",
        noModelMessage: "No reviewer model is configured."
      });
      if (resolved.model.provider.toLowerCase() === implementer.provider.toLowerCase()) {
        rejected.push({ requested, error: `${formatModelName(resolved.model)} uses implementer provider ${implementer.provider}` });
        continue;
      }
      const key = canonicalModelSpec(resolved).toLowerCase();
      if (!candidates.some((candidate) => canonicalModelSpec(candidate).toLowerCase() === key)) candidates.push(resolved);
    } catch (error) {
      rejected.push({ requested, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { candidates, rejected };
}

export function selectDistinctReviewer(
  registry: ExtensionModelRegistry,
  reviewerSpecs: string[],
  implementer: Pick<Model<Api>, "provider">
): ResolvedExtensionModel {
  const { candidates, rejected } = listDistinctReviewers(registry, reviewerSpecs, implementer);
  if (candidates[0]) return candidates[0];
  const detail = rejected.length > 0 ? ` Candidates rejected: ${rejected.map((failure) => failure.error).join("; ")}.` : "";
  throw new Error(`No independent reviewer is available for implementer provider ${implementer.provider}.${detail}`);
}

export function canonicalModelSpec(resolved: ResolvedExtensionModel): string {
  return `${formatModelName(resolved.model)}:${resolved.thinkingLevel}`;
}

function withThinkingOverride(model: string, thinkingLevel: ThinkingLevel | undefined): string {
  if (!thinkingLevel) return model;
  const parsed = parseOptionalModelThinkingPair(model);
  return `${parsed?.model ?? model}:${thinkingLevel}`;
}
