import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const TRUSTED_CONFIG: Array<[string, string]> = [
  ["core.fsmonitor", "false"], ["core.hooksPath", "/dev/null"], ["core.sshCommand", "/usr/bin/false"],
  ["core.attributesFile", "/dev/null"], ["core.excludesFile", "/dev/null"], ["credential.helper", ""],
  ["commit.gpgSign", "false"], ["tag.gpgSign", "false"], ["merge.verifySignatures", "false"],
  ["merge.autoStash", "false"], ["diff.external", ""], ["extensions.worktreeConfig", "false"], ["submodule.recurse", "false"], ["fetch.recurseSubmodules", "false"], ["protocol.file.allow", "always"]
];

export function trustedGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false", GIT_PROTOCOL_FROM_USER: "0",
    GIT_OPTIONAL_LOCKS: "0", GIT_EXTERNAL_DIFF: ""
  };
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_COMMON_DIR; delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY; delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES; delete env.GIT_REPLACE_REF_BASE;
  return env;
}

export function trustedGitArgs(args: readonly string[]): string[] {
  return [...TRUSTED_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]), ...args];
}

export function runTrustedGit(args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): string {
  const execOptions: ExecFileSyncOptionsWithStringEncoding = {
    cwd: options.cwd, encoding: "utf8", env: trustedGitEnvironment(options.env), maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  };
  return execFileSync("git", trustedGitArgs(args), execOptions);
}

export type TrustedGitOperation = { readonly checkedRepositories: Set<string> };

/** Cache policy validation only for the bounded operation that owns this value. */
export function createTrustedGitOperation(): TrustedGitOperation {
  return { checkedRepositories: new Set<string>() };
}

export function trustedGit(repo: string, args: readonly string[], options: { checkPolicy?: boolean; maxBuffer?: number; operation?: TrustedGitOperation } = {}): string {
  const exact = canonicalRepository(repo, options.checkPolicy !== false, options.operation);
  return runTrustedGit(["-C", exact, ...args], { maxBuffer: options.maxBuffer });
}

export function canonicalRepository(value: string, checkPolicy = true, operation?: TrustedGitOperation): string {
  const exact = realpathSync(path.resolve(value));
  if (!statSync(exact).isDirectory()) throw new Error(`Git repository is not a directory: ${value}.`);
  runTrustedGit(["-C", exact, "rev-parse", "--git-dir"]);
  if (checkPolicy) assertTrustedGitPolicy(exact, operation);
  return exact;
}

export function assertTrustedGitPolicy(repository: string, operation?: TrustedGitOperation): void {
  const exact = realpathSync(repository);
  if (operation?.checkedRepositories.has(exact)) return;
  const keys = runTrustedGit(["-C", exact, "config", "--local", "--no-includes", "--name-only", "--null", "--list"])
    .split("\0").filter(Boolean).map((key) => key.toLocaleLowerCase("en-US"));
  const unsafe = keys.filter(unsafeConfigKey);
  if (unsafe.length) throw new Error(`Repository has prohibited executable or ambient Git configuration: ${[...new Set(unsafe)].sort().join(", ")}.`);
  const common = runTrustedGit(["-C", exact, "rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  const commonExact = realpathSync(common);
  const gitDir = realpathSync(runTrustedGit(["-C", exact, "rev-parse", "--path-format=absolute", "--git-dir"]).trim());
  if (gitDir !== commonExact) throw new Error("Linked Git worktrees and per-worktree configuration are unsupported.");
  for (const relative of ["info/grafts", "shallow"]) {
    const candidate = path.join(commonExact, relative);
    if (existsSync(candidate) && lstatSync(candidate).isFile()) throw new Error(`Repository uses unsupported Git history metadata: ${relative}.`);
  }
  if (runTrustedGit(["-C", exact, "ls-files", "--stage"]).split("\n").some((line) => line.startsWith("160000 "))) throw new Error("Repository contains unsupported gitlinks/submodules.");
  if (runTrustedGit(["-C", exact, "for-each-ref", "--format=%(refname)", "refs/replace"]).trim()) {
    throw new Error("Repository contains prohibited replace refs.");
  }
  operation?.checkedRepositories.add(exact);
}

function unsafeConfigKey(key: string): boolean {
  return key === "extensions.worktreeconfig" || key === "core.worktree" || key.startsWith("extensions.") || key === "core.fsmonitor" || key === "core.hookspath" || key === "core.sshcommand" || key === "core.gitproxy" ||
    key === "core.attributesfile" || key === "core.excludesfile" || key === "diff.external" || key === "gpg.program" ||
    key.startsWith("include.") || key.startsWith("includeif.") || key.startsWith("filter.") || key.startsWith("credential.") ||
    /^diff\..+\.(command|textconv)$/.test(key) || /^merge\..+\.driver$/.test(key) || /^remote\..+\.(uploadpack|receivepack|proxy)$/.test(key) ||
    /^url\..+\.(insteadof|pushinsteadof)$/.test(key) || /^submodule\..+\.(update|url)$/.test(key) || key.startsWith("protocol.");
}

export function canonicalPathWithin(rootValue: string, candidateValue: string, options: { allowRoot?: boolean; rejectLeafSymlink?: boolean } = {}): string {
  const root = realpathSync(path.resolve(rootValue));
  const lexical = path.resolve(candidateValue);
  if (!existsSync(lexical)) throw new Error(`Path does not exist: ${candidateValue}.`);
  if (options.rejectLeafSymlink !== false && lstatSync(lexical).isSymbolicLink()) throw new Error(`Symbolic-link path is not accepted: ${candidateValue}.`);
  const exact = realpathSync(lexical);
  const relative = path.relative(root, exact);
  if ((!options.allowRoot && relative === "") || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path resolves outside ${root}: ${candidateValue}.`);
  }
  return exact;
}
