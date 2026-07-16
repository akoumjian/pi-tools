import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  formatConfigPath,
  readPiToolsJsonConfigSource,
  readPiToolsReferencedTextConfig,
  type PiToolsJsonConfig
} from "../_shared/config.js";
import { isValidThinkingLevel } from "../_shared/model-spec.js";

export const ORCHESTRATOR_CONFIG_FILE = "orchestrator-settings.json";

export type OrchestratorModelSettings = {
  worker?: string;
  reader?: string;
  planner?: string;
  reviewers: string[];
};

export type OrchestratorValidationSettings = {
  command: string;
  args: string[];
  timeoutMs: number;
  maxRunsPerTask: number;
};

export type OrchestratorSettings = {
  models: OrchestratorModelSettings;
  guidance?: string;
  guidanceFile?: string;
  maxConcurrency: number;
  maxTasksPerRun: number;
  maxOutputCharsPerTask: number;
  readOnlyTools: string[];
  writeTools: string[];
  shellTools: string[];
  validation?: OrchestratorValidationSettings;
  configSource: string;
};

export type OrchestratorSetupArgs = {
  help: boolean;
  worker?: string;
  reader?: string;
  planner?: string;
  reviewers: string[];
  guidance?: string;
  guidanceFile?: string;
  clearGuidance: boolean;
};

const DEFAULT_READ_ONLY_TOOLS = ["search_many", "read_many"];
const DEFAULT_WRITE_TOOLS = ["edit_many", "write_many"];
const DEFAULT_SHELL_TOOLS = ["shell_start", "shell_status", "shell_read", "shell_cancel"];

export function readOrchestratorSettings(): OrchestratorSettings {
  const defaults: OrchestratorSettings = {
    models: { reviewers: [] },
    guidance: undefined,
    guidanceFile: undefined,
    maxConcurrency: 4,
    maxTasksPerRun: 8,
    maxOutputCharsPerTask: 50_000,
    readOnlyTools: [...DEFAULT_READ_ONLY_TOOLS],
    writeTools: [...DEFAULT_WRITE_TOOLS],
    shellTools: [...DEFAULT_SHELL_TOOLS],
    validation: undefined,
    configSource: "built-in defaults"
  };
  const parsed = readPiToolsJsonConfigSource(ORCHESTRATOR_CONFIG_FILE, import.meta.url);
  if (!parsed) return defaults;
  return normalizeSettings({
    ...defaults,
    ...parsed.data,
    models: normalizeModelSettings(parsed.data.models),
    guidance: readGuidance(parsed.data, parsed),
    validation: normalizeValidationSettings(parsed.data.validation),
    configSource: `${parsed.source}:${formatConfigPath(parsed.path)}`
  });
}

export function serializeOrchestratorSettings(
  settings: OrchestratorSettings,
  models: OrchestratorModelSettings,
  guidance: string | undefined,
  clearGuidance: boolean
): Record<string, unknown> {
  const effectiveGuidance = clearGuidance ? undefined : normalizeGuidance(guidance ?? settings.guidance);
  return {
    models: {
      ...(models.worker ? { worker: models.worker } : {}),
      ...(models.reader ? { reader: models.reader } : {}),
      ...(models.planner ? { planner: models.planner } : {}),
      reviewers: models.reviewers
    },
    ...(effectiveGuidance ? { guidance: effectiveGuidance } : {}),
    maxConcurrency: settings.maxConcurrency,
    maxTasksPerRun: settings.maxTasksPerRun,
    maxOutputCharsPerTask: settings.maxOutputCharsPerTask,
    readOnlyTools: settings.readOnlyTools,
    writeTools: settings.writeTools,
    shellTools: settings.shellTools,
    ...(settings.validation ? { validation: settings.validation } : {})
  };
}

export function parseOrchestratorSetupArgs(rawArgs: string): OrchestratorSetupArgs {
  const tokens = tokenizeSetupArgs(rawArgs);
  if (tokens.length === 0 || tokens[0] === "--help" || tokens[0] === "-h") {
    return { help: true, reviewers: [], clearGuidance: false };
  }
  const parsed: OrchestratorSetupArgs = { help: false, reviewers: [], clearGuidance: false };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--clear-guidance") {
      assertNoGuidanceConflict(parsed);
      parsed.clearGuidance = true;
      continue;
    }
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
    index += 1;
    if (token === "--worker") parsed.worker = value;
    else if (token === "--reader") parsed.reader = value;
    else if (token === "--planner") parsed.planner = value;
    else if (token === "--reviewer") parsed.reviewers.push(value);
    else if (token === "--guidance") {
      assertNoGuidanceConflict(parsed);
      parsed.guidance = normalizeGuidance(value);
    } else if (token === "--guidance-file") {
      assertNoGuidanceConflict(parsed);
      parsed.guidanceFile = value;
    } else throw new Error(`Unknown /orchestrator:setup argument: ${token}`);
  }
  return parsed;
}

export function orchestratorSetupUsage(): string {
  return [
    "Usage: /orchestrator:setup --worker provider/model[:thinking] --reviewer provider/model[:thinking] [--reviewer ...] [--reader provider/model[:thinking]] [--planner provider/model[:thinking]] [--guidance \"text\" | --guidance-file <path> | --clear-guidance]",
    "First setup requires a worker and at least one reviewer from a different provider. Later runs may update one route while preserving the rest."
  ].join("\n");
}

export function buildModelSpec(model: string, thinkingLevel: ThinkingLevel): string {
  return `${model}:${thinkingLevel}`;
}

function normalizeSettings(settings: OrchestratorSettings): OrchestratorSettings {
  return {
    models: settings.models,
    guidance: normalizeGuidance(settings.guidance),
    guidanceFile: optionalString(settings.guidanceFile),
    maxConcurrency: positiveInteger(settings.maxConcurrency, 4),
    maxTasksPerRun: positiveInteger(settings.maxTasksPerRun, 8),
    maxOutputCharsPerTask: positiveInteger(settings.maxOutputCharsPerTask, 50_000),
    readOnlyTools: uniqueStrings(settings.readOnlyTools.length > 0 ? settings.readOnlyTools : DEFAULT_READ_ONLY_TOOLS),
    writeTools: uniqueStrings(Array.isArray(settings.writeTools) && settings.writeTools.length > 0 ? settings.writeTools : DEFAULT_WRITE_TOOLS),
    // An explicit empty array disables child shell; absence uses the default.
    shellTools: Array.isArray(settings.shellTools) ? uniqueStrings(settings.shellTools) : [...DEFAULT_SHELL_TOOLS],
    validation: settings.validation,
    configSource: settings.configSource
  };
}

function normalizeModelSettings(value: unknown): OrchestratorModelSettings {
  if (!isObject(value)) return { reviewers: [] };
  return {
    worker: optionalString(value.worker),
    reader: optionalString(value.reader),
    planner: optionalString(value.planner),
    reviewers: Array.isArray(value.reviewers)
      ? uniqueStrings(value.reviewers.filter((item): item is string => typeof item === "string"))
      : []
  };
}

function normalizeValidationSettings(value: unknown): OrchestratorValidationSettings | undefined {
  if (!isObject(value)) return undefined;
  const command = optionalString(value.command);
  if (!command) return undefined;
  return {
    command,
    args: Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [],
    timeoutMs: positiveInteger(value.timeoutMs, 600_000),
    maxRunsPerTask: positiveInteger(value.maxRunsPerTask, 5)
  };
}

function readGuidance(data: Record<string, unknown>, config: PiToolsJsonConfig): string | undefined {
  const inline = optionalString(data.guidance);
  const file = optionalString(data.guidanceFile);
  if (inline && file) throw new Error(`${formatConfigPath(config.path)} must set either guidance or guidanceFile, not both.`);
  return file ? readPiToolsReferencedTextConfig(file, config.path, config.source).text : inline;
}

function tokenizeSetupArgs(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  let escaping = false;
  for (const char of value.trim()) {
    if (escaping) { current += char; escaping = false; continue; }
    if (char === "\\") { escaping = true; continue; }
    if (quote) { if (char === quote) quote = undefined; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("Unterminated quoted setup argument.");
  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function assertNoGuidanceConflict(args: OrchestratorSetupArgs): void {
  if (args.guidance !== undefined || args.guidanceFile !== undefined || args.clearGuidance) {
    throw new Error("/orchestrator:setup accepts only one guidance input.");
  }
}

function normalizeGuidance(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? `${trimmed}\n` : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
