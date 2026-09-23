import { readFileSync } from "node:fs";
import type { ConfigPath } from "../_shared/config.js";
import { formatConfigPath, readPiToolsJsonConfigSource } from "../_shared/config.js";

export const WORKER_CONFIG_FILE = "worker-settings.json";

export type WorkerSettings = {
  defaultRoute: string;
  reviewRoute?: string;
  configSource: string;
};

export function readWorkerSettings(settingsPath?: ConfigPath): WorkerSettings {
  if (settingsPath !== undefined) {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    return normalizeWorkerSettings(parsed, formatConfigPath(settingsPath));
  }

  const config = readPiToolsJsonConfigSource(WORKER_CONFIG_FILE, import.meta.url);
  if (!config) {
    throw new Error(`${WORKER_CONFIG_FILE} was not found. Configure defaultRoute or pass route explicitly.`);
  }
  return normalizeWorkerSettings(config.data, `${config.source}:${formatConfigPath(config.path)}`);
}

export function normalizeWorkerSettings(value: unknown, configSource: string): WorkerSettings {
  if (!isRecord(value)) {
    throw new Error(`${configSource} must contain a JSON object.`);
  }
  const unsupported = Object.keys(value).filter((key) => key !== "defaultRoute" && key !== "reviewRoute");
  if (unsupported.length > 0) {
    throw new Error(`${configSource} contains unsupported worker setting${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.`);
  }
  if (typeof value.defaultRoute !== "string" || value.defaultRoute.trim() === "") {
    throw new Error(`${configSource} must define non-empty string defaultRoute.`);
  }
  const defaultRoute = value.defaultRoute.trim();
  if (defaultRoute.length > 512) {
    throw new Error(`${configSource} defaultRoute must be at most 512 characters.`);
  }
  let reviewRoute: string | undefined;
  if (value.reviewRoute !== undefined) {
    if (typeof value.reviewRoute !== "string" || value.reviewRoute.trim() === "") {
      throw new Error(`${configSource} reviewRoute must be a non-empty model:thinking string when provided.`);
    }
    reviewRoute = value.reviewRoute.trim();
    if (reviewRoute.length > 512 || !/^[^\s/:]+\/[^\s]+:(?:off|minimal|low|medium|high|xhigh|max)$/.test(reviewRoute)) {
      throw new Error(`${configSource} reviewRoute must be an exact provider/model:thinking route of at most 512 characters.`);
    }
  }
  return { defaultRoute, ...(reviewRoute ? { reviewRoute } : {}), configSource };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
