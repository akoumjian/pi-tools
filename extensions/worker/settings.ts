import { readFileSync } from "node:fs";
import type { ConfigPath } from "../_shared/config.js";
import { formatConfigPath, readPiToolsJsonConfigSource } from "../_shared/config.js";
import { assertSubagentRouteSpecAllowed } from "../_shared/model-spec.js";
import type { WorkerRole } from "./registry.js";

export const WORKER_CONFIG_FILE = "worker-settings.json";
export type WorkerModelPreferences = Record<WorkerRole, string[]>;
export type WorkerSettings = {
  modelPreferences: WorkerModelPreferences;
  configSource: string;
};

export function readWorkerSettings(settingsPath?: ConfigPath): WorkerSettings {
  if (settingsPath !== undefined) return normalizeWorkerSettings(JSON.parse(readFileSync(settingsPath, "utf8")) as unknown, formatConfigPath(settingsPath));
  const config = readPiToolsJsonConfigSource(WORKER_CONFIG_FILE, import.meta.url);
  if (!config) throw new Error(`${WORKER_CONFIG_FILE} was not found. Configure modelPreferences.`);
  return normalizeWorkerSettings(config.data, `${config.source}:${formatConfigPath(config.path)}`);
}

export function normalizeWorkerSettings(value: unknown, configSource: string): WorkerSettings {
  if (!isRecord(value)) throw new Error(`${configSource} must contain a JSON object.`);
  const unsupported = Object.keys(value).filter((key) => key !== "modelPreferences");
  if (unsupported.length) throw new Error(`${configSource} contains unsupported worker setting${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.`);
  if (!isRecord(value.modelPreferences)) throw new Error(`${configSource} must define modelPreferences for work, review, and integration.`);
  const roles: WorkerRole[] = ["work", "review", "integration"];
  const preferences = Object.fromEntries(roles.map((role) => [role, normalizeSelections((value.modelPreferences as Record<string, unknown>)[role], role, configSource)])) as WorkerModelPreferences;
  const extraRoles = Object.keys(value.modelPreferences).filter((role) => !roles.includes(role as WorkerRole));
  if (extraRoles.length) throw new Error(`${configSource} modelPreferences contains unsupported roles: ${extraRoles.join(", ")}.`);
  return { modelPreferences: preferences, configSource };
}

export function preferredWorkerModel(role: WorkerRole, explicit?: string, settings = readWorkerSettings()): string[] {
  if (explicit !== undefined) return [normalizeSelection(explicit, `${settings.configSource} explicit modelSelection`)];
  return [...settings.modelPreferences[role]];
}

function normalizeSelections(value: unknown, role: WorkerRole, source: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) throw new Error(`${source} modelPreferences.${role} must contain 1-8 exact selections.`);
  const selections = value.map((item, index) => normalizeSelection(item, `${source} modelPreferences.${role}[${index}]`));
  if (new Set(selections).size !== selections.length) throw new Error(`${source} modelPreferences.${role} contains duplicates.`);
  return selections;
}
function normalizeSelection(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value.trim()) > 512 || !/^[^\s/:]+\/[^\s]+:(?:off|minimal|low|medium|high|xhigh)$/.test(value.trim())) throw new Error(`${label} must be an exact provider/model:thinking selection of at most 512 UTF-8 bytes.`);
  const selection = value.trim(); assertSubagentRouteSpecAllowed(selection, label); return selection;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
