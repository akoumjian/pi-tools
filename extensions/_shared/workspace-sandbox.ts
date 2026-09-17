import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export type WorkspaceSandboxProcess = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  profile: string;
  workspaceRoot: string;
};

export function prepareWorkspaceSandboxProcess(input: {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  workspaceRoot: string;
}): WorkspaceSandboxProcess {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) {
    throw new Error("Managed worker shell confinement requires macOS /usr/bin/sandbox-exec.");
  }
  const workspaceRoot = realpathSync(input.workspaceRoot);
  verifyWorkspaceRuntimeDirectories(workspaceRoot);
  const profile = buildWorkspaceSandboxProfile({
    workspaceRoot,
    home: input.env.HOME ?? homedir(),
    agentDir: input.env.PI_CODING_AGENT_DIR,
    workerStateRoot: input.env.PI_WORKER_STATE_ROOT,
    parentContextSnapshot: input.env.PI_WORKER_PARENT_CONTEXT_SNAPSHOT
  });
  const env = buildWorkspaceSandboxEnvironment(input.env, workspaceRoot);
  return {
    executable: SANDBOX_EXEC,
    args: ["-p", profile, input.executable, ...input.args],
    env,
    profile,
    workspaceRoot
  };
}

export function buildWorkspaceSandboxEnvironment(
  source: NodeJS.ProcessEnv,
  workspaceRoot: string
): NodeJS.ProcessEnv {
  const root = path.resolve(workspaceRoot);
  const allowed = new Set([
    "HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "TERM", "COLORTERM", "CI",
    "NO_COLOR", "FORCE_COLOR", "PI_WORKER_ID", "PI_WORKER_RUN_ID", "PI_WORKER_WORKSPACE_ROOT", "PI_WORKER_JOB_TOKEN"
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (allowed.has(name) || name.startsWith("LC_"))) env[name] = value;
  }

  const cacheRoot = path.join(root, "cache");
  const tempRoot = path.join(root, "tmp");
  const configRoot = path.join(cacheRoot, "config");
  const dataRoot = path.join(cacheRoot, "data");
  const stateRoot = path.join(cacheRoot, "state");
  env.TMPDIR = tempRoot;
  env.XDG_CACHE_HOME = cacheRoot;
  env.XDG_CONFIG_HOME = configRoot;
  env.XDG_DATA_HOME = dataRoot;
  env.XDG_STATE_HOME = stateRoot;
  env.npm_config_cache = path.join(cacheRoot, "npm");
  env.PIP_CACHE_DIR = path.join(cacheRoot, "pip");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "Never";
  return env;
}

export function buildWorkspaceSandboxProfile(input: {
  workspaceRoot: string;
  home: string;
  agentDir?: string;
  workerStateRoot?: string;
  parentContextSnapshot?: string;
}): string {
  const root = path.resolve(input.workspaceRoot);
  const home = path.resolve(input.home);
  const credentialDirectories = canonicalSensitivePaths([
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, ".config", "gcloud"),
    path.join(home, ".config", "gh"),
    path.join(home, ".docker"),
    path.join(home, ".codex"),
    path.join(home, ".claude"),
    path.join(home, ".terraform.d"),
    path.join(home, ".gnupg"),
    path.join(home, ".kube"),
    path.join(home, ".config", "hub"),
    path.join(home, ".config", "op"),
    path.join(home, ".config", "1Password"),
    path.join(home, ".pi", "agent"),
    ...sensitiveDirectoryPaths(input.agentDir, home),
    ...workerStateReadDenials(input.workerStateRoot, root),
    ...siblingWorkspaceReadDenials(input.workerStateRoot, root),
    path.join(home, "Library", "Keychains"),
    path.join(home, "Library", "Cookies"),
    path.join(home, "Library", "Safari"),
    path.join(home, "Library", "Application Support", "gh"),
    path.join(home, "Library", "Application Support", "Google", "Chrome"),
    path.join(home, "Library", "Application Support", "Firefox")
  ]);
  const credentialFiles = canonicalSensitivePaths([
    path.join(home, ".pi", "agent", "auth.json"),
    path.join(home, ".git-credentials"),
    path.join(home, ".netrc"),
    path.join(home, ".npmrc"),
    path.join(home, ".pypirc"),
    path.join(home, ".zshenv"),
    path.join(home, ".zprofile"),
    path.join(home, ".zshrc"),
    path.join(home, ".profile"),
    path.join(home, ".bash_profile"),
    path.join(home, ".bashrc"),
    path.join(home, ".zsh_history"),
    path.join(home, ".bash_history"),
    path.join(home, ".python_history"),
    path.join(home, ".node_repl_history"),
    path.join(home, ".lesshst"),
    path.join(home, ".psql_history"),
    path.join(home, ".mysql_history"),
    path.join(home, ".cargo", "credentials"),
    path.join(home, ".cargo", "credentials.toml"),
    path.join(home, ".config", "git", "credentials"),
    path.join(home, ".pgpass"),
    path.join(home, ".my.cnf"),
    path.join(home, ".vault-token"),
    path.join(home, ".m2", "settings.xml"),
    path.join(home, ".gradle", "gradle.properties")
  ]);
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath "${sandboxQuote(root)}"))`,
    '(allow file-write* (literal "/dev/null"))',
    '(deny process-exec (literal "/usr/bin/security"))',
    '(deny process-exec (literal "/bin/launchctl"))',
    '(deny process-exec (literal "/usr/bin/open"))',
    '(deny process-exec (literal "/usr/bin/osascript"))',
    '(deny process-exec (literal "/usr/bin/defaults"))',
    '(deny process-exec (literal "/usr/bin/crontab"))',
    '(deny process-exec (literal "/usr/bin/at"))',
    '(deny process-exec (literal "/usr/bin/pbcopy"))',
    '(deny process-exec (literal "/bin/ps"))',
    '(deny process-exec (literal "/usr/bin/ps"))',
    '(deny process-exec (literal "/usr/libexec/git-core/git-credential-osxkeychain"))',
    '(deny mach-lookup (global-name-regex #"^com\\.apple\\.securityd"))',
    '(deny mach-lookup (global-name-regex #"^com\\.apple\\.(xpc\\.launchd|launchd)"))',
    '(deny mach-lookup (global-name-regex #"^com\\.apple\\.(coreservices\\.(launchservicesd|appleevents)|cfprefsd\\.|pasteboard\\.)"))',
    '(deny appleevent-send)',
    '(deny network-outbound (remote unix-socket))',
    '(deny process-info*)',
    '(allow process-info* (target self))',
    '(allow process-info-codesignature)',
    ...credentialDirectories.map((directory) => `(deny file-read* (subpath "${sandboxQuote(directory)}"))`),
    ...credentialFiles.map((file) => `(deny file-read* (literal "${sandboxQuote(file)}"))`),
    `(allow file-read* (subpath "${sandboxQuote(root)}"))`,
    ...(input.parentContextSnapshot
      ? [`(allow file-read* (literal "${sandboxQuote(path.resolve(input.parentContextSnapshot))}"))`]
      : [])
  ].join(" ");
}

function workerStateReadDenials(workerStateRoot: string | undefined, workspaceRoot: string): string[] {
  if (!workerStateRoot?.trim()) return [];
  const state = path.resolve(workerStateRoot);
  const workersRoot = path.dirname(state);
  const parentContainsWorkspace = workspaceRoot === workersRoot || workspaceRoot.startsWith(`${workersRoot}${path.sep}`);
  return parentContainsWorkspace ? [state] : [state, workersRoot];
}

function siblingWorkspaceReadDenials(workerStateRoot: string | undefined, workspaceRoot: string): string[] {
  if (!workerStateRoot?.trim()) return [];
  const workersRoot = path.dirname(path.resolve(workerStateRoot));
  if (path.basename(workersRoot) !== "workers") return [];
  return [path.dirname(workspaceRoot)];
}

function sensitiveDirectoryPaths(configured: string | undefined, home: string): string[] {
  if (!configured?.trim()) return [];
  const expanded = configured === "~"
    ? home
    : configured.startsWith("~/")
      ? path.join(home, configured.slice(2))
      : configured;
  return [path.resolve(expanded)];
}

function canonicalSensitivePaths(paths: string[]): string[] {
  const protectedPaths = new Set<string>();
  for (const value of paths) {
    const resolved = path.resolve(value);
    protectedPaths.add(resolved);
    try {
      protectedPaths.add(realpathSync(resolved));
    } catch {}
  }
  return [...protectedPaths];
}

function verifyWorkspaceRuntimeDirectories(workspaceRoot: string): void {
  for (const directory of [
    workspaceRoot,
    path.join(workspaceRoot, "cache"),
    path.join(workspaceRoot, "cache", "config"),
    path.join(workspaceRoot, "cache", "data"),
    path.join(workspaceRoot, "cache", "state"),
    path.join(workspaceRoot, "tmp")
  ]) {
    if (!lstatSync(directory).isDirectory()) {
      throw new Error(`Managed worker runtime path is not a directory: ${directory}`);
    }
    const real = realpathSync(directory);
    if (real !== workspaceRoot && !real.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error(`Managed worker runtime path escapes the workspace: ${directory}`);
    }
  }
}

function sandboxQuote(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
