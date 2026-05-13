#!/usr/bin/env node
// scripts/dev-pi.mjs
//
// Run `pi` against an isolated `<repo>/.pi/dev-agent/` directory so development
// work never touches the real `~/.pi/agent/` settings, sessions, or auth.
//
// Usage:
//   node scripts/dev-pi.mjs [pi args...]   # default: ensure seed, then run pi
//   node scripts/dev-pi.mjs reset           # delete and re-seed .pi/dev-agent
//   node scripts/dev-pi.mjs status          # show dev agent dir state
//   node scripts/dev-pi.mjs path            # print resolved dev agent dir path
//
// All other arguments after the optional sub-command are forwarded to `pi`.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devAgentDir = resolve(repoRoot, ".pi/dev-agent");
const settingsPath = resolve(devAgentDir, "settings.json");
const authPath = resolve(devAgentDir, "auth.json");
const sessionsDir = resolve(devAgentDir, "sessions");

const sub = process.argv[2];
const forwardedArgs = process.argv.slice(isSubcommand(sub) ? 3 : 2);

if (sub === "reset") {
  reset();
} else if (sub === "status") {
  printStatus();
} else if (sub === "path") {
  process.stdout.write(`${devAgentDir}\n`);
} else {
  ensureSeed();
  startPi(forwardedArgs);
}

function isSubcommand(value) {
  return value === "reset" || value === "status" || value === "path";
}

function ensureSeed() {
  if (!existsSync(devAgentDir)) mkdirSync(devAgentDir, { recursive: true });
  if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });
  if (!existsSync(settingsPath)) writeFileSync(settingsPath, defaultSettingsJson());
  if (!existsSync(authPath)) writeFileSync(authPath, "{}\n");
}

function reset() {
  if (existsSync(devAgentDir)) rmSync(devAgentDir, { recursive: true, force: true });
  ensureSeed();
  process.stdout.write(`Reset dev agent dir at ${devAgentDir}\n`);
}

function printStatus() {
  process.stdout.write(`Dev agent dir: ${devAgentDir}\n`);
  process.stdout.write(`Exists: ${existsSync(devAgentDir)}\n`);
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      process.stdout.write(`Settings file present but unparseable: ${settingsPath}\n`);
      return;
    }
    process.stdout.write("Settings:\n");
    process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
  }
  process.stdout.write(`Auth file present: ${existsSync(authPath)}\n`);
  process.stdout.write(`PI_CODING_AGENT_DIR=${devAgentDir}\n`);
}

function defaultSettingsJson() {
  const settings = {
    packages: [repoRoot],
    hideThinkingBlock: true,
    enableInstallTelemetry: false
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function startPi(args) {
  const localBinDir = resolve(repoRoot, "node_modules", ".bin");
  const localPi = resolve(localBinDir, "pi");
  const env = { ...process.env, PI_CODING_AGENT_DIR: devAgentDir };
  if (existsSync(localPi)) {
    env.PATH = `${localBinDir}${delimiter}${process.env.PATH ?? ""}`;
    if (process.stderr.isTTY) {
      process.stderr.write(`[dev-pi] using local pi: ${localPi}\n`);
    }
  }
  if (process.stderr.isTTY) {
    process.stderr.write(`[dev-pi] PI_CODING_AGENT_DIR=${devAgentDir}\n`);
  }
  const child = spawn("pi", args, { stdio: "inherit", env });
  child.on("error", (err) => {
    process.stderr.write(`[dev-pi] failed to launch pi: ${err.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}
