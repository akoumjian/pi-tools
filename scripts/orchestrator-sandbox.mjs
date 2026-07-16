#!/usr/bin/env node
// scripts/orchestrator-sandbox.mjs
//
// Isolated sandbox for testing the `orchestrator` extension WITHOUT touching
// ~/.pi/agent or any real working repository. Mirrors scripts/fleet-sandbox.mjs,
// but adds a throwaway git clone as the work target because the orchestrator
// mutates git (worktrees / branches / merges).
//
// Everything lives OUTSIDE this repo under
// ~/.local/share/agent/orchestrator-sandbox/:
//   agent/         -> PI_CODING_AGENT_DIR (isolated settings/sessions; the real
//                     auth.json + models.json are symlinked in so live turns work)
//   scratch-repo/  -> a throwaway git clone the orchestrator operates on
//   worktrees/     -> ORCHESTRATOR_WORKTREE_ROOT for writer/integration worktrees
//
// The orchestrator extension is loaded ad hoc via `-e` and is NOT expected to be
// registered in package.json until it is proven.
//
// Usage:
//   node scripts/orchestrator-sandbox.mjs setup
//   node scripts/orchestrator-sandbox.mjs repo [<path-or-url>]   # clone work target (default: this repo)
//   node scripts/orchestrator-sandbox.mjs pi [pi args...]        # interactive Pi inside the scratch repo
//   node scripts/orchestrator-sandbox.mjs status | reset | path
//
// Safety: reads real auth/models via symlink (never writes them); all mutable
// state is outside the repo; a failed run is discarded with `reset`.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandboxRoot = join(homedir(), ".local", "share", "agent", "orchestrator-sandbox");
const agentDir = join(sandboxRoot, "agent");
const sessionsDir = join(agentDir, "sessions");
const settingsPath = join(agentDir, "settings.json");
const scratchRepo = join(sandboxRoot, "scratch-repo");
const worktreesRoot = join(sandboxRoot, "worktrees");
const orchExt = join(repoRoot, "extensions", "orchestrator", "index.ts");
const realAgentDir = join(homedir(), ".pi", "agent");

const sub = process.argv[2];
const rest = process.argv.slice(3);

switch (sub) {
  case "setup":
    ensureSetup();
    process.stdout.write(`Sandbox ready at ${sandboxRoot}\nNext: node scripts/orchestrator-sandbox.mjs repo [<path-or-url>]\n`);
    break;
  case "reset":
    rmSync(sandboxRoot, { recursive: true, force: true });
    ensureSetup();
    process.stdout.write(`Reset sandbox at ${sandboxRoot}\n`);
    break;
  case "status":
    status();
    break;
  case "path":
    process.stdout.write(`${sandboxRoot}\n`);
    break;
  case "repo":
    ensureSetup();
    cloneRepo(rest[0]);
    break;
  case "pi":
    ensureSetup();
    launchPi(rest);
    break;
  default:
    process.stderr.write("usage: orchestrator-sandbox.mjs setup | repo [src] | pi [args] | status | reset | path\n");
    process.exit(sub ? 1 : 0);
}

function ensureSetup() {
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  if (!existsSync(settingsPath)) writeFileSync(settingsPath, seedSettings());
  // Read-only reuse of real provider config + auth so sandbox turns can run.
  linkReal("auth.json");
  linkReal("models.json");
}

function seedSettings() {
  const settings = {
    packages: [repoRoot], // load the profile (tool-safety, native-tools, ...) for a realistic env
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.6-luna", // cheap by default; override per run with --model
    defaultThinkingLevel: "high",
    enabledModels: [
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-sol",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-fable-5"
    ],
    hideThinkingBlock: true,
    enableInstallTelemetry: false
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function linkReal(name) {
  const target = join(realAgentDir, name);
  const link = join(agentDir, name);
  if (!existsSync(target)) return; // nothing to link; live turns may then need manual auth
  try {
    lstatSync(link);
    unlinkSync(link);
  } catch {
    /* no existing link */
  }
  symlinkSync(target, link);
}

function cloneRepo(source) {
  const src = source ? resolveCloneSource(source) : repoRoot;
  if (existsSync(scratchRepo)) {
    process.stderr.write(`scratch repo already exists at ${scratchRepo}; run 'reset' to recreate.\n`);
    return;
  }
  const res = spawnSync("git", ["clone", "--no-hardlinks", src, scratchRepo], { stdio: "inherit" });
  if (res.status !== 0) {
    process.stderr.write("git clone failed\n");
    process.exit(res.status ?? 1);
  }
  process.stdout.write(`Cloned ${src} -> ${scratchRepo}\n`);
}

function resolveCloneSource(source) {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(source) ? source : resolve(source);
}

function launchPi(args) {
  if (!existsSync(scratchRepo)) {
    process.stderr.write("no scratch repo yet; run: node scripts/orchestrator-sandbox.mjs repo [<path-or-url>]\n");
    process.exit(1);
  }
  const hasExt = existsSync(orchExt);
  if (!hasExt) {
    process.stderr.write(`[orch-sandbox] orchestrator extension not built yet (${orchExt}); launching profile only.\n`);
  }
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    ORCHESTRATOR_WORKTREE_ROOT: worktreesRoot
  };
  const piArgs = hasExt ? ["-e", orchExt, ...args] : [...args];
  if (process.stderr.isTTY) {
    process.stderr.write(`[orch-sandbox] PI_CODING_AGENT_DIR=${agentDir}\n[orch-sandbox] cwd=${scratchRepo}\n`);
  }
  const child = spawn("pi", piArgs, { stdio: "inherit", cwd: scratchRepo, env });
  child.on("error", (err) => {
    process.stderr.write(`[orch-sandbox] failed to launch pi: ${err.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

function status() {
  process.stdout.write(`Sandbox root: ${sandboxRoot}\n`);
  for (const [label, p] of [
    ["agent dir", agentDir],
    ["scratch repo", scratchRepo],
    ["worktrees root", worktreesRoot],
    ["orchestrator ext", orchExt]
  ]) {
    process.stdout.write(`  ${label}: ${existsSync(p) ? "present" : "missing"}  (${p})\n`);
  }
  process.stdout.write(`  auth linked:   ${existsSync(join(agentDir, "auth.json"))}\n`);
  process.stdout.write(`  models linked: ${existsSync(join(agentDir, "models.json"))}\n`);
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
      process.stdout.write(`  default model: ${parsed.defaultProvider}/${parsed.defaultModel} @ ${parsed.defaultThinkingLevel}\n`);
    } catch {
      process.stdout.write("  settings present but unparseable\n");
    }
  }
}
