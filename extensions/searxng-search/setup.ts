/**
 * /searxng:setup implementation. Lifted from the personal aggregator's
 * setup-doctor extension so the searxng-search extension owns its own setup
 * lifecycle. Writes an idempotent local-only Docker Compose helper under
 * `~/.pi/agent/services/searxng/`, generates a random secret, and starts
 * Docker only when `--start` is explicit.
 *
 * Also writes a per-machine config marker at
 * `~/.pi/agent/extensions/akoumjian-tools/searxng-settings.json` so the
 * `searxng_search` tool can detect that the user has explicitly opted in.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { writeAgentExtensionConfig } from "../_shared/config.js";

export const SEARXNG_AGENT_CONFIG_FILE = "searxng-settings.json";
export const DEFAULT_SEARXNG_PORT = 8080;
const EXAMPLE_SEARXNG_SECRET = "replace-with-a-random-secret";
const LEGACY_SEARXNG_ENV_SECRET = "${SEARXNG_SECRET}";
const SEARXNG_SERVICE_RELATIVE_PATH = [".pi", "agent", "services", "searxng"] as const;

export type CommandResult = { status: number | null; signal?: NodeJS.Signals | null; stdout: string; stderr: string };
export type RunCommand = (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) => CommandResult;

export type SearxngSetupCommandOptions = { dryRun: boolean; force: boolean; start: boolean; help: boolean; serviceDir?: string; port?: number };
export type SearxngSetupAction = { status: "unchanged" | "changed" | "would-change" | "skipped" | "failed"; label: string; target?: string; detail: string };
export type SearxngSetupOptions = {
  homeDir?: string;
  serviceDir?: string;
  port?: number;
  dryRun?: boolean;
  force?: boolean;
  start?: boolean;
  now?: () => Date;
  secret?: string;
  runCommand?: RunCommand;
};
export type SearxngSetupReport = {
  serviceDir: string;
  baseUrl: string;
  port: number;
  dryRun: boolean;
  force: boolean;
  start: boolean;
  actions: SearxngSetupAction[];
};

export async function handleSearxngSetupCommand(args: string, context: ExtensionCommandContext): Promise<void> {
  let options: SearxngSetupCommandOptions;
  try {
    options = parseSearxngSetupCommandOptions(args);
  } catch (error) {
    context.ui.notify(`${errorMessage(error)}\n${searxngSetupUsage()}`, "warning");
    return;
  }
  if (options.help) {
    context.ui.notify(searxngSetupUsage(), "info");
    return;
  }

  try {
    const report = runSearxngSetup({
      dryRun: options.dryRun,
      force: options.force,
      start: options.start,
      serviceDir: options.serviceDir,
      port: options.port
    });

    if (!report.dryRun) {
      writeAgentExtensionConfig(SEARXNG_AGENT_CONFIG_FILE, {
        baseUrl: report.baseUrl,
        serviceDir: report.serviceDir,
        port: report.port,
        configuredAt: new Date().toISOString()
      });
    }

    context.ui.notify(
      formatSearxngSetupReport(report),
      report.actions.some((action) => action.status === "failed") ? "warning" : "info"
    );
  } catch (error) {
    context.ui.notify(`SearXNG setup failed: ${errorMessage(error)}`, "error");
  }
}

export function parseSearxngSetupCommandOptions(args: string): SearxngSetupCommandOptions {
  const parsed: SearxngSetupCommandOptions = { dryRun: false, force: false, start: false, help: false };
  const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--dry-run") { parsed.dryRun = true; continue; }
    if (token === "--force") { parsed.force = true; continue; }
    if (token === "--start") { parsed.start = true; continue; }
    if (token === "--help" || token === "-h") { parsed.help = true; continue; }
    if (token === "--dir") { parsed.serviceDir = requireOptionValue(tokens, index, token); index += 1; continue; }
    if (token === "--port") { parsed.port = parsePort(requireOptionValue(tokens, index, token)); index += 1; continue; }
    throw new Error(`Unknown /searxng:setup argument: ${token}`);
  }
  return parsed;
}

export function searxngSetupUsage(): string {
  return "Usage: /searxng:setup [--dry-run] [--start] [--force] [--dir <path>] [--port <1-65535>]\nCreates an explicit local-only Docker Compose SearXNG helper under ~/.pi/agent/services/searxng by default. It writes files only when requested and starts Docker only with --start.";
}

export function runSearxngSetup(options: SearxngSetupOptions = {}): SearxngSetupReport {
  const homeDir = options.homeDir ?? homedir();
  const serviceDir = resolveSetupPath(options.serviceDir ?? path.join(homeDir, ...SEARXNG_SERVICE_RELATIVE_PATH), homeDir);
  const port = options.port ?? DEFAULT_SEARXNG_PORT;
  const baseUrl = `http://127.0.0.1:${port}`;
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const start = options.start === true;
  const now = options.now ?? (() => new Date());
  const runCommand = options.runCommand ?? defaultRunCommand;
  const settingsPath = path.join(serviceDir, "settings.yml");
  const envPath = path.join(serviceDir, ".env");
  const secret = options.secret ?? readExistingSearxngSecret(settingsPath) ?? readExistingSearxngEnvSecret(envPath) ?? randomBytes(32).toString("hex");

  const actions: SearxngSetupAction[] = [
    writeSearxngSetupFile("compose.yaml", path.join(serviceDir, "compose.yaml"), searxngComposeYaml(), { dryRun, force, now }),
    writeSearxngSetupFile("settings.yml", settingsPath, searxngSettingsYaml(secret), { dryRun, force, now, replaceableLegacyContent: searxngSettingsYaml(LEGACY_SEARXNG_ENV_SECRET) }),
    writeSearxngEnvFile(envPath, port, secret, { dryRun, force, now })
  ];

  const dockerStatus = checkDockerCompose(runCommand);
  actions.push(dockerStatus.action);

  if (start) {
    const hasSkippedServiceFile = actions.some((action) => ["compose.yaml", "settings.yml", ".env"].includes(action.label) && action.status === "skipped");
    actions.push(hasSkippedServiceFile
      ? { status: "skipped", label: "Start service", target: serviceDir, detail: "Skipped because existing service files differ and were left untouched. Re-run with --force after reviewing them." }
      : startSearxngCompose({ serviceDir, dryRun, dockerReady: dockerStatus.ready, runCommand }));
  }

  return { serviceDir, baseUrl, port, dryRun, force, start, actions };
}

function resolveSetupPath(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/")) return path.resolve(homeDir, input.slice(2));
  return path.resolve(input);
}

function writeSearxngSetupFile(
  label: string,
  target: string,
  content: string,
  options: { dryRun: boolean; force: boolean; now: () => Date; replaceableLegacyContent?: string }
): SearxngSetupAction {
  const targetExists = existsSync(target);
  const existingContent = targetExists ? readFileSync(target, "utf8") : undefined;
  if (existingContent === content) {
    return { status: "unchanged", label, target, detail: "Already up to date." };
  }
  const canReplaceLegacy = existingContent !== undefined && existingContent === options.replaceableLegacyContent;
  if (targetExists && !options.force && !canReplaceLegacy) {
    return { status: "skipped", label, target, detail: "Existing file differs; left untouched. Re-run with --force to overwrite with a backup." };
  }
  if (options.dryRun) {
    return { status: "would-change", label, target, detail: targetExists ? "Would update existing file." : "Would create file." };
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const backupPath = targetExists ? backupSetupFile(target, options.now) : undefined;
  writeFileSync(target, content);
  return { status: "changed", label, target, detail: backupPath ? `Updated file; backup written to ${backupPath}.` : "Created file." };
}

function backupSetupFile(target: string, now: () => Date): string {
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${target}.bak-${stamp}`;
  renameSync(target, backupPath);
  return backupPath;
}

function readExistingSearxngSecret(settingsPath: string): string | undefined {
  if (!existsSync(settingsPath)) return undefined;
  const content = readFileSync(settingsPath, "utf8");
  const match = content.match(/^\s*secret_key:\s*["']?([^"'\n#]+)["']?\s*$/m);
  return normalizeExistingSearxngSecret(match?.[1]);
}

function readExistingSearxngEnvSecret(envPath: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  const env = parseEnvFile(readFileSync(envPath, "utf8"));
  return normalizeExistingSearxngSecret(env.SEARXNG_SECRET);
}

function normalizeExistingSearxngSecret(rawSecret: string | undefined): string | undefined {
  const secret = rawSecret?.trim();
  if (!secret || secret === LEGACY_SEARXNG_ENV_SECRET || secret === EXAMPLE_SEARXNG_SECRET) return undefined;
  return secret;
}

function writeSearxngEnvFile(
  target: string,
  port: number,
  secret: string,
  options: { dryRun: boolean; force: boolean; now: () => Date }
): SearxngSetupAction {
  const content = searxngEnvFile(port, secret);
  const targetExists = existsSync(target);
  const existingContent = targetExists ? readFileSync(target, "utf8") : undefined;
  if (existingContent === content) {
    return { status: "unchanged", label: ".env", target, detail: "Already up to date." };
  }
  if (existingContent !== undefined && !options.force && existingSearxngEnvMatchesPortAndSecret(existingContent, port, secret)) {
    return { status: "unchanged", label: ".env", target, detail: "Existing .env has matching port/base URL and secret; preserving it." };
  }
  return writeSearxngSetupFile(".env", target, content, options);
}

function existingSearxngEnvMatchesPortAndSecret(content: string, port: number, secret: string): boolean {
  const env = parseEnvFile(content);
  return env.SEARXNG_PORT === String(port) && env.SEARXNG_BASE_URL === `http://127.0.0.1:${port}/` && normalizeExistingSearxngSecret(env.SEARXNG_SECRET) === secret;
}

function parseEnvFile(content: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    entries[match[1]] = match[2];
  }
  return entries;
}

function checkDockerCompose(runCommand: RunCommand): { ready: boolean; action: SearxngSetupAction } {
  const docker = runCommand("docker", ["--version"], { timeoutMs: 5000 });
  if (docker.status !== 0) {
    return { ready: false, action: { status: "skipped", label: "Docker", detail: `Docker CLI not available (${commandError(docker) ?? "unknown error"}). Install Docker Desktop, Colima, or OrbStack before using --start.` } };
  }
  const compose = runCommand("docker", ["compose", "version"], { timeoutMs: 5000 });
  if (compose.status !== 0) {
    return { ready: false, action: { status: "skipped", label: "Docker Compose", detail: `docker compose is not available (${commandError(compose) ?? "unknown error"}). Install Docker Compose v2 before using --start.` } };
  }
  return { ready: true, action: { status: "unchanged", label: "Docker Compose", detail: "Docker and docker compose are available." } };
}

function startSearxngCompose(options: { serviceDir: string; dryRun: boolean; dockerReady: boolean; runCommand: RunCommand }): SearxngSetupAction {
  if (!options.dockerReady) return { status: "skipped", label: "Start service", target: options.serviceDir, detail: "Skipped because Docker Compose is not available." };
  if (options.dryRun) return { status: "would-change", label: "Start service", target: options.serviceDir, detail: "Would run `docker compose up -d`." };
  const result = options.runCommand("docker", ["compose", "up", "-d"], { cwd: options.serviceDir, timeoutMs: 120000 });
  if (result.status !== 0) return { status: "failed", label: "Start service", target: options.serviceDir, detail: `docker compose up -d failed: ${commandError(result) ?? "unknown error"}. ${result.stderr.trim()}`.trim() };
  return { status: "changed", label: "Start service", target: options.serviceDir, detail: "Ran `docker compose up -d`. Run /searxng:status after the container finishes warming up." };
}

export function searxngComposeYaml(): string {
  return [
    "services:",
    "  searxng:",
    "    image: docker.io/searxng/searxng:latest",
    "    restart: unless-stopped",
    "    ports:",
    '      - "127.0.0.1:${SEARXNG_PORT:-8080}:8080"',
    "    environment:",
    "      - SEARXNG_BASE_URL=${SEARXNG_BASE_URL:-http://127.0.0.1:8080/}",
    "      - SEARXNG_SECRET=${SEARXNG_SECRET:?set SEARXNG_SECRET in .env}",
    "    volumes:",
    "      - ./settings.yml:/etc/searxng/settings.yml:ro",
    "      - searxng-cache:/var/cache/searxng",
    "    depends_on:",
    "      - valkey",
    "",
    "  valkey:",
    "    image: docker.io/valkey/valkey:8-alpine",
    "    restart: unless-stopped",
    "    command: valkey-server --save 30 1 --loglevel warning",
    "    volumes:",
    "      - valkey-data:/data",
    "",
    "volumes:",
    "  searxng-cache:",
    "  valkey-data:",
    ""
  ].join("\n");
}

export function searxngSettingsYaml(secret: string): string {
  return [
    "use_default_settings: true",
    "",
    "server:",
    '  bind_address: "0.0.0.0"',
    "  port: 8080",
    `  secret_key: "${secret}"`,
    "  limiter: false",
    "  image_proxy: false",
    "",
    "search:",
    "  safe_search: 1",
    '  autocomplete: ""',
    "  formats:",
    "    - html",
    "    - json",
    "",
    "ui:",
    "  static_use_hash: true",
    "",
    "outgoing:",
    "  request_timeout: 8.0",
    "  max_request_timeout: 15.0",
    "",
    "redis:",
    '  url: "redis://valkey:6379/0"',
    "",
    "# Keep this local helper quiet: no metrics/telemetry plugins are enabled here.",
    "plugins: {}",
    ""
  ].join("\n");
}

function searxngEnvFile(port: number, secret: string): string {
  return [
    "# Generated by /searxng:setup. Keep this file local and do not commit it.",
    `SEARXNG_PORT=${port}`,
    `SEARXNG_BASE_URL=http://127.0.0.1:${port}/`,
    `SEARXNG_SECRET=${secret}`,
    ""
  ].join("\n");
}

export function formatSearxngSetupReport(report: SearxngSetupReport): string {
  const lines = [
    "SearXNG setup",
    "",
    `Directory: ${report.serviceDir}`,
    `URL: ${report.baseUrl}`,
    `Mode: ${report.dryRun ? "dry run" : "write"}${report.force ? ", force" : ""}${report.start ? ", start" : ""}`,
    "",
    "Actions",
    ...report.actions.map(formatSearxngSetupAction),
    "",
    "Next steps",
    report.start ? "- Run /searxng:status after the container warms up." : `- Start later with: cd ${report.serviceDir} && docker compose up -d`,
    ...(report.port === DEFAULT_SEARXNG_PORT ? [] : [`- /searxng:setup records ${report.baseUrl} for Pi; set SEARXNG_URL only when overriding the setup file without rerunning setup.`]),
    "- Keep the service bound to 127.0.0.1 unless you intentionally secure and expose it.",
    "- Use /searxng:status to verify JSON output, then use searxng_search for discovery and web_fetch_many for retrieval."
  ];
  return lines.join("\n");
}

function formatSearxngSetupAction(action: SearxngSetupAction): string {
  const marker = action.status === "changed" ? "✓" : action.status === "would-change" ? "•" : action.status === "failed" ? "✗" : action.status === "skipped" ? "-" : "✓";
  const target = action.target ? ` (${action.target})` : "";
  return `- ${marker} ${action.label}: ${action.detail}${target}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireOptionValue(tokens: string[], index: number, option: string): string {
  const value = tokens[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== raw) throw new Error(`Invalid SearXNG port: ${raw}`);
  return port;
}

function defaultRunCommand(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }): CommandResult {
  const result = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8", timeout: options?.timeoutMs });
  return { status: result.status ?? null, signal: result.signal ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function commandError(result: CommandResult): string | undefined {
  if (result.status === 0) return undefined;
  if (result.signal) return `terminated by signal ${result.signal}`;
  if (result.status === null) return "did not exit cleanly";
  return `exited with code ${result.status}`;
}
