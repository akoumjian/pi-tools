import { readFileSync } from "node:fs";
import type { ConfigPath } from "../_shared/config.js";
import { formatConfigPath, readPiToolsJsonConfigSource } from "../_shared/config.js";
import { assertSubagentRouteSpecAllowed } from "../_shared/model-spec.js";

export const WORKER_CONFIG_FILE = "worker-settings.json";

export type WorkerSettings = {
  defaultRoute: string;
  reviewRoute?: string;
  reviewRateLimitFallbackRoute?: string;
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
  const supported = new Set(["defaultRoute", "reviewRoute", "reviewRateLimitFallbackRoute"]);
  const unsupported = Object.keys(value).filter((key) => !supported.has(key));
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
  assertSubagentRouteSpecAllowed(defaultRoute, `${configSource} defaultRoute`);

  const reviewRoute = optionalExactReviewRoute(value.reviewRoute, "reviewRoute", configSource);
  const reviewRateLimitFallbackRoute = optionalExactReviewRoute(
    value.reviewRateLimitFallbackRoute,
    "reviewRateLimitFallbackRoute",
    configSource
  );
  if (reviewRateLimitFallbackRoute && !reviewRoute) {
    throw new Error(`${configSource} reviewRateLimitFallbackRoute requires reviewRoute.`);
  }
  if (reviewRoute && reviewRateLimitFallbackRoute) {
    const primaryProvider = routeProvider(reviewRoute);
    const fallbackProvider = routeProvider(reviewRateLimitFallbackRoute);
    if (primaryProvider !== fallbackProvider) {
      throw new Error(`${configSource} managed-worker review primary and rate-limit fallback routes must use the same exact provider.`);
    }
    if (reviewRoute === reviewRateLimitFallbackRoute) {
      throw new Error(`${configSource} managed-worker review rate-limit fallback route must differ from the primary route.`);
    }
  }

  return {
    defaultRoute,
    ...(reviewRoute ? { reviewRoute } : {}),
    ...(reviewRateLimitFallbackRoute ? { reviewRateLimitFallbackRoute } : {}),
    configSource
  };
}

function optionalExactReviewRoute(value: unknown, field: string, configSource: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${configSource} ${field} must be a non-empty provider/model:thinking string when provided.`);
  }
  const route = value.trim();
  if (route.length > 512 || !/^[^\s/:]+\/[^\s]+:(?:off|minimal|low|medium|high|xhigh|max)$/.test(route)) {
    throw new Error(`${configSource} ${field} must be an exact provider/model:thinking route of at most 512 characters.`);
  }
  assertSubagentRouteSpecAllowed(route, `${configSource} ${field}`);
  return route;
}

function routeProvider(route: string): string {
  return route.slice(0, route.indexOf("/"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
