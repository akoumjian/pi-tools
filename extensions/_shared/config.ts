import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

/**
 * Subdirectory under Pi's `~/.pi/agent/` where `:setup` commands write
 * per-machine configuration for `@akoumjian/pi-tools` extensions. The
 * `extensions/` ancestor directory is the convention pi-show-diffs uses.
 */
export const AGENT_EXTENSION_CONFIG_SUBDIR = path.join("extensions", "akoumjian-tools");

export type ConfigPath = string | URL;
export type PiToolsConfigSource = "env" | "agent" | "profile" | "package" | "cwd";

export type PiToolsConfigCandidate = {
  path: ConfigPath;
  source: PiToolsConfigSource;
};

export type PiToolsJsonConfig = {
  path: ConfigPath;
  source: PiToolsConfigSource;
  data: Record<string, unknown>;
};

export type PiToolsTextConfig = {
  path: ConfigPath;
  source: PiToolsConfigSource;
  text: string;
};

export function findPiToolsConfigFile(fileName: string, fromMetaUrl: string): ConfigPath | undefined {
  return findPiToolsConfigSource(fileName, fromMetaUrl)?.path;
}

export function findPiToolsConfigSource(fileName: string, fromMetaUrl: string): PiToolsConfigCandidate | undefined {
  return piToolsConfigCandidates(fileName, fromMetaUrl).find((candidate) => existsSync(candidate.path));
}

export function readPiToolsJsonConfig(fileName: string, fromMetaUrl: string): Record<string, unknown> | undefined {
  return readPiToolsJsonConfigSource(fileName, fromMetaUrl)?.data;
}

export function readPiToolsJsonConfigSource(fileName: string, fromMetaUrl: string): PiToolsJsonConfig | undefined {
  const config = findPiToolsConfigSource(fileName, fromMetaUrl);
  if (!config) return undefined;

  const parsed = JSON.parse(readFileSync(config.path, "utf8")) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(`${formatConfigPath(config.path)} must contain a JSON object.`);
  }
  return { ...config, data: parsed };
}

export function readPiToolsTextConfig(fileName: string, fromMetaUrl: string): string | undefined {
  return readPiToolsTextConfigSource(fileName, fromMetaUrl)?.text;
}

export function readPiToolsTextConfigSource(fileName: string, fromMetaUrl: string): PiToolsTextConfig | undefined {
  const config = findPiToolsConfigSource(fileName, fromMetaUrl);
  return config ? { ...config, text: readFileSync(config.path, "utf8") } : undefined;
}

export function readPiToolsReferencedTextConfig(reference: string, baseConfigPath: ConfigPath, source: PiToolsConfigSource): PiToolsTextConfig {
  const resolvedPath = resolvePiToolsConfigReference(reference, baseConfigPath);
  return { path: resolvedPath, source, text: readFileSync(resolvedPath, "utf8") };
}

export function resolvePiToolsConfigReference(reference: string, baseConfigPath: ConfigPath): ConfigPath {
  const trimmed = reference.trim();
  if (!trimmed) {
    throw new Error("Config file reference must not be empty.");
  }

  const expanded = expandHome(trimmed);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }

  if (baseConfigPath instanceof URL) {
    return new URL(expanded, baseConfigPath);
  }

  return path.resolve(path.dirname(baseConfigPath), expanded);
}

export function piToolsConfigCandidates(fileName: string, fromMetaUrl: string): PiToolsConfigCandidate[] {
  return uniqueConfigPaths([
    ...envConfigCandidates(fileName),
    ...agentConfigCandidates(fileName),
    ...profileConfigCandidates(fileName, fromMetaUrl),
    { path: new URL(`../../config/${fileName}`, fromMetaUrl), source: "package" },
    { path: path.join(process.cwd(), "config", fileName), source: "cwd" }
  ]);
}

/**
 * Resolve the canonical per-machine config path for a pi-tools extension.
 * `:setup` commands write here; the lookup chain reads here before falling
 * back to profile defaults.
 */
export function agentExtensionConfigDir(): string {
  return path.join(getAgentDir(), AGENT_EXTENSION_CONFIG_SUBDIR);
}

export function agentExtensionConfigPath(fileName: string): string {
  return path.join(agentExtensionConfigDir(), fileName);
}

/**
 * Write a per-machine config JSON file, creating the directory if needed.
 * Returns the absolute path written.
 */
export function writeAgentExtensionConfig(fileName: string, value: unknown): string {
  return writeAgentExtensionTextConfig(fileName, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeAgentExtensionTextConfig(fileName: string, content: string): string {
  const dir = agentExtensionConfigDir();
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, fileName);
  writeFileSync(dest, content, "utf8");
  return dest;
}

export function removeAgentExtensionConfig(fileName: string): { path: string; removed: boolean } {
  const dest = agentExtensionConfigPath(fileName);
  if (!existsSync(dest)) {
    return { path: dest, removed: false };
  }

  unlinkSync(dest);
  return { path: dest, removed: true };
}

export function agentExtensionConfigExists(fileName: string): boolean {
  return existsSync(agentExtensionConfigPath(fileName));
}

function envConfigCandidates(fileName: string): PiToolsConfigCandidate[] {
  const configDir = process.env.PI_TOOLS_CONFIG_DIR?.trim();
  return configDir ? [{ path: path.join(expandHome(configDir), fileName), source: "env" }] : [];
}

function agentConfigCandidates(fileName: string): PiToolsConfigCandidate[] {
  try {
    return [{ path: agentExtensionConfigPath(fileName), source: "agent" }];
  } catch {
    return [];
  }
}

function profileConfigCandidates(fileName: string, fromMetaUrl: string): PiToolsConfigCandidate[] {
  const startDir = path.dirname(fileURLToPath(fromMetaUrl));
  const candidates: PiToolsConfigCandidate[] = [];

  for (let dir = startDir; ; dir = path.dirname(dir)) {
    candidates.push({ path: path.join(dir, "config", "pi-tools", fileName), source: "profile" });
    if (path.dirname(dir) === dir) break;
  }

  return candidates;
}

function uniqueConfigPaths(candidates: PiToolsConfigCandidate[]): PiToolsConfigCandidate[] {
  const seen = new Set<string>();
  const unique: PiToolsConfigCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.path instanceof URL ? candidate.path.href : path.resolve(candidate.path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function formatConfigPath(configPath: ConfigPath): string {
  return configPath instanceof URL ? fileURLToPath(configPath) : configPath;
}
