import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel as clampModelThinkingLevel, type Api, type Model } from "@earendil-works/pi-ai";

export type ExtensionModelRegistry = {
  hasConfiguredAuth(model: Model<Api>): boolean;
  getAll(): Model<Api>[];
  refresh?(): void | Promise<void>;
};

export type ResolvedExtensionModel = {
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
};

export type ResolveExtensionModelOptions = {
  registry: ExtensionModelRegistry;
  requested?: string;
  currentModel?: Model<Api>;
  fallbackThinkingLevel: ThinkingLevel;
  label: string;
  noModelMessage: string;
};

export type ParsedModelThinkingPair = {
  model: string;
  thinkingLevel: ThinkingLevel;
};

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isValidThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function normalizeThinkingLevel(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return isValidThinkingLevel(value) ? value : fallback;
}

export function formatModelName(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function resolveExtensionModel(options: ResolveExtensionModelOptions): ResolvedExtensionModel {
  const requested = options.requested?.trim();
  if (!requested && options.currentModel) {
    assertConfiguredAuth(options.registry, options.currentModel, `Current model`);
    return {
      model: options.currentModel,
      thinkingLevel: clampModelThinkingLevel(options.currentModel, options.fallbackThinkingLevel)
    };
  }

  if (!requested) {
    throw new Error(options.noModelMessage);
  }

  const availableModels = options.registry.getAll();
  const resolved = parseModelPattern(requested, availableModels);
  if (!resolved.model) {
    throw new Error(formatModelNotFoundError(options.label, requested, availableModels));
  }

  assertConfiguredAuth(options.registry, resolved.model, `${options.label} model`);
  return {
    model: resolved.model,
    thinkingLevel: clampModelThinkingLevel(resolved.model, resolved.thinkingLevel ?? options.fallbackThinkingLevel)
  };
}

export function parseModelThinkingPair(spec: string): ParsedModelThinkingPair {
  const parsed = parseOptionalModelThinkingPair(spec);
  if (parsed) {
    return parsed;
  }

  const trimmed = spec.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) {
    throw new Error(`Model/thinking pair must use model:thinking format, got: ${spec}`);
  }

  const thinkingLevel = trimmed.slice(colon + 1);
  if (!isValidThinkingLevel(thinkingLevel)) {
    throw new Error(`Invalid thinking level ${thinkingLevel}. Expected one of: ${THINKING_LEVELS.join(", ")}`);
  }

  throw new Error(`Model/thinking pair must include a model before :${thinkingLevel}.`);
}

export function parseOptionalModelThinkingPair(spec: string): ParsedModelThinkingPair | undefined {
  const trimmed = spec.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) {
    return undefined;
  }

  const thinkingLevel = trimmed.slice(colon + 1);
  if (!isValidThinkingLevel(thinkingLevel)) {
    return undefined;
  }

  const model = trimmed.slice(0, colon).trim();
  return model ? { model, thinkingLevel } : undefined;
}

function assertConfiguredAuth(registry: ExtensionModelRegistry, model: Model<Api>, label: string): void {
  if (!registry.hasConfiguredAuth(model)) {
    throw new Error(`${label} has no configured auth: ${formatModelName(model)}`);
  }
}

type ParseModelPatternResult = {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
};

function parseModelPattern(pattern: string, availableModels: Model<Api>[]): ParseModelPatternResult {
  const exactMatch = tryMatchModel(pattern, availableModels);
  if (exactMatch) {
    return { model: exactMatch };
  }

  const lastColonIndex = pattern.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return {};
  }

  const prefix = pattern.substring(0, lastColonIndex);
  const suffix = pattern.substring(lastColonIndex + 1);
  if (!isValidThinkingLevel(suffix)) {
    return {};
  }

  const result = parseModelPattern(prefix, availableModels);
  return result.model ? { model: result.model, thinkingLevel: suffix } : result;
}

function formatModelNotFoundError(label: string, requested: string, availableModels: Model<Api>[]): string {
  const parsed = parseOptionalModelThinkingPair(requested);
  const requestedModel = parsed?.model ?? requested;
  const thinking = parsed ? ` (thinking ${parsed.thinkingLevel} from suffix :${parsed.thinkingLevel})` : "";
  const diagnostics = formatAvailableModelsDiagnostic(requestedModel, availableModels);
  return `${label} model not found: ${requestedModel}${thinking}. ${diagnostics}. If model config changed recently, run /reload or restart Pi so the model registry refreshes.`;
}

function formatAvailableModelsDiagnostic(requestedModel: string, availableModels: Model<Api>[]): string {
  const total = availableModels.length;
  const provider = requestedProvider(requestedModel);
  if (provider) {
    const providerModels = availableModels.filter((model) => model.provider.toLowerCase() === provider.toLowerCase());
    if (providerModels.length > 0) {
      return `Registry has ${total} models. Available ${provider} models (${providerModels.length}): ${sampleModelNames(providerModels)}`;
    }

    return `Registry has ${total} models. No models are registered for provider ${provider}. Available providers: ${sampleProviderNames(availableModels)}`;
  }

  return `Registry has ${total} models. Available examples: ${sampleModelNames(availableModels)}`;
}

function requestedProvider(modelReference: string): string | undefined {
  const slash = modelReference.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  return modelReference.slice(0, slash).trim() || undefined;
}

function sampleModelNames(models: Model<Api>[], max = 16): string {
  const names = models.map(formatModelName).sort((left, right) => left.localeCompare(right));
  const sample = names.slice(0, max).join(", ");
  return names.length > max ? `${sample}, ...` : sample || "none";
}

function sampleProviderNames(models: Model<Api>[], max = 16): string {
  const names = Array.from(new Set(models.map((model) => model.provider))).sort((left, right) => left.localeCompare(right));
  const sample = names.slice(0, max).join(", ");
  return names.length > max ? `${sample}, ...` : sample || "none";
}

function tryMatchModel(modelPattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
  if (exactMatch) {
    return exactMatch;
  }

  const normalizedPattern = modelPattern.toLowerCase();
  const matches = availableModels.filter((model) =>
    model.id.toLowerCase().includes(normalizedPattern) || model.name?.toLowerCase().includes(normalizedPattern)
  );
  if (matches.length === 0) {
    return undefined;
  }

  const aliases = matches.filter((model) => isAlias(model.id));
  if (aliases.length > 0) {
    return aliases.sort(compareModelIdsDescending)[0];
  }

  return matches.sort(compareModelIdsDescending)[0];
}

function findExactModelReferenceMatch(modelReference: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) {
    return undefined;
  }

  const normalizedReference = trimmedReference.toLowerCase();
  const canonicalMatches = availableModels.filter((model) => formatModelName(model).toLowerCase() === normalizedReference);
  if (canonicalMatches.length === 1) {
    return canonicalMatches[0];
  }
  if (canonicalMatches.length > 1) {
    return undefined;
  }

  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.substring(0, slashIndex).trim();
    const modelId = trimmedReference.substring(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter((model) =>
        model.provider.toLowerCase() === provider.toLowerCase() && model.id.toLowerCase() === modelId.toLowerCase()
      );
      if (providerMatches.length === 1) {
        return providerMatches[0];
      }
      if (providerMatches.length > 1) {
        return undefined;
      }
    }
  }

  const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function isAlias(id: string): boolean {
  return !/-\d{8}$/.test(id);
}

function compareModelIdsDescending(left: Model<Api>, right: Model<Api>): number {
  return right.id.localeCompare(left.id);
}
