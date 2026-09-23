import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { resolveExecutable } from "../_shared/executable.js";
import type { AcceptedWorkerHandoff } from "../_shared/worker-contract.js";

const REPOSITORY_INVENTORY_VERSION = 2;
const MAX_REPOSITORIES = 32;
const MAX_SCAN_ENTRIES = 20_000;
const MAX_SCAN_DEPTH = 12;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 1024;
const OID_PATTERN = /^[0-9a-f]{40,64}$/;

export type InitialRepositoryPin = {
  source: string;
  revision?: string;
  canonicalSource?: string;
  baseCommit?: string;
  baseTree?: string;
  status: "pinned" | "unresolved" | "unsupported";
  issue?: string;
};

export type RepositoryCandidate = {
  candidateId: string;
  workerId: string;
  runId: string;
  workspaceRepo: string;
  reported: boolean;
  purpose?: string;
  dependsOn: string[];
  source?: string;
  baseCommit?: string;
  baseTree?: string;
  headCommit?: string;
  headTree?: string;
  dirty: boolean;
  committedChanged: boolean;
  foldable: boolean;
  policyIssues: string[];
};

export type ReportedRepositoryIssue = {
  kind: "reported_missing" | "reported_not_repository";
  workspaceRepo: string;
};

export type RepositoryScanLimitation = "entry_limit" | "repository_limit" | "depth_limit" | "path_limit" | "unreadable_directory";

export type RepositoryScanCoverage = {
  complete: boolean;
  limitations: RepositoryScanLimitation[];
};

export type RepositoryInventory = {
  version: typeof REPOSITORY_INVENTORY_VERSION;
  workerId: string;
  runId: string;
  workspaceRoot: string;
  generatedAt: string;
  candidates: RepositoryCandidate[];
  reportedIssues: ReportedRepositoryIssue[];
  scanCoverage: RepositoryScanCoverage;
};

export type RepositoryCandidateSummary = {
  candidateId: string;
  workspaceRepo: string;
  reported: boolean;
  dirty: boolean;
  committedChanged: boolean;
  foldable: boolean;
  policyIssues: string[];
};

export type RepositoryInventorySummary = {
  inventoryFile: string;
  inventorySha256: string;
  candidateCount: number;
  foldableCount: number;
  reportedIssueCount: number;
  candidates: RepositoryCandidateSummary[];
  reportedIssues: ReportedRepositoryIssue[];
  scanCoverage: RepositoryScanCoverage;
};

export type GitRunner = {
  gitPath: string;
  env: NodeJS.ProcessEnv;
  templateDir: string;
};

type ReportedRepository = { purpose: string; dependsOn: string[] };

type ReportedRepositoryCollection = {
  reports: Map<string, ReportedRepository>;
  issues: ReportedRepositoryIssue[];
  repositoryPaths: string[];
};

type RepositoryInspection = {
  source?: string;
  baseCommit?: string;
  baseTree?: string;
  headCommit?: string;
  headTree?: string;
  dirty: boolean;
  committedChanged: boolean;
  foldable: boolean;
  policyIssues: string[];
};

export function pinInitialRepositories(
  requested: readonly { source: string; revision?: string }[],
  trustedStateRoot: string,
  gitPath = resolveExecutable("git")
): InitialRepositoryPin[] {
  const runner = createGitRunner(gitPath, trustedStateRoot);
  return requested.map((entry) => pinInitialRepository(entry, runner));
}

export function deriveRepositoryInventory(input: {
  workerId: string;
  runId: string;
  workspaceRoot: string;
  reposRoot: string;
  handoff: AcceptedWorkerHandoff;
  initialRepositories?: readonly InitialRepositoryPin[];
  generatedAt: string;
  trustedStateRoot: string;
  gitPath?: string;
}): RepositoryInventory {
  const workspaceRoot = requireCanonicalDirectory(input.workspaceRoot, "worker workspace");
  const reposRoot = requireCanonicalDirectory(input.reposRoot, "worker repositories");
  if (!isWithin(workspaceRoot, reposRoot)) {
    throw new Error("Worker repository root escapes the canonical workspace.");
  }
  const reported = reportedRepositories(input.handoff, workspaceRoot, reposRoot);
  const scan = discoverRepositories(reposRoot, workspaceRoot, reported.repositoryPaths);
  const runner = createGitRunner(input.gitPath ?? resolveExecutable("git"), input.trustedStateRoot);
  const candidates: RepositoryCandidate[] = [];
  const reportedIssues: ReportedRepositoryIssue[] = [...reported.issues];

  for (const repoPath of scan.repositories) {
    const workspaceRepo = relativeWorkspacePath(workspaceRoot, repoPath);
    const report = reported.reports.get(workspaceRepo);
    const inspection = inspectRepositorySafely(repoPath, input.initialRepositories ?? [], runner);
    const candidateId = repositoryCandidateId({
      workerId: input.workerId,
      runId: input.runId,
      workspaceRepo,
      baseCommit: inspection.baseCommit,
      headCommit: inspection.headCommit,
      headTree: inspection.headTree
    });
    candidates.push({
      candidateId,
      workerId: input.workerId,
      runId: input.runId,
      workspaceRepo,
      reported: report !== undefined,
      purpose: report?.purpose,
      dependsOn: [...(report?.dependsOn ?? [])],
      ...inspection
    });
  }

  candidates.sort((left, right) => compareText(left.workspaceRepo, right.workspaceRepo));
  reportedIssues.sort((left, right) => compareText(left.workspaceRepo, right.workspaceRepo) || compareText(left.kind, right.kind));
  return {
    version: REPOSITORY_INVENTORY_VERSION,
    workerId: input.workerId,
    runId: input.runId,
    workspaceRoot,
    generatedAt: input.generatedAt,
    candidates,
    reportedIssues,
    scanCoverage: scan.coverage
  };
}

export function persistRepositoryInventory(
  inventoryFile: string,
  inventory: RepositoryInventory
): RepositoryInventorySummary {
  const target = path.resolve(inventoryFile);
  if (!isRepositoryInventory(inventory)) {
    throw new Error("Refusing to persist an invalid worker repository inventory.");
  }
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  const summary = summarizeRepositoryInventory(target, serialized, inventory);
  if (!isRepositoryInventorySummary(summary, target)) {
    throw new Error("Refusing to persist an invalid worker repository inventory summary.");
  }
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, serialized, { mode: 0o600 });
  renameSync(temporary, target);
  return summary;
}

export function readRepositoryInventory(
  inventoryFile: string,
  expected: { workerId: string; runId: string; workspaceRoot: string; sha256?: string }
): RepositoryInventory {
  const target = path.resolve(inventoryFile);
  const metadata = lstatSync(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Worker repository inventory is not a regular file.");
  if (expected.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(expected.sha256)) {
    throw new Error("Worker repository inventory has an invalid expected hash.");
  }
  const raw = readFileSync(target, "utf8");
  if (expected.sha256 && sha256(raw) !== expected.sha256) {
    throw new Error("Worker repository inventory hash mismatch.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Worker repository inventory is not valid JSON.");
  }
  if (!isRepositoryInventory(value)) {
    throw new Error("Worker repository inventory failed strict validation.");
  }
  if (
    value.workerId !== expected.workerId ||
    value.runId !== expected.runId ||
    path.resolve(value.workspaceRoot) !== path.resolve(expected.workspaceRoot)
  ) {
    throw new Error("Worker repository inventory identity mismatch.");
  }
  return value;
}

function pinInitialRepository(
  entry: { source: string; revision?: string },
  runner: GitRunner
): InitialRepositoryPin {
  const source = entry.source.trim();
  const revision = entry.revision?.trim();
  if (!source) return { source, revision, status: "unsupported", issue: "blank_source" };
  if (containsCredentialUrl(source)) {
    return { source: redactSource(source), revision, status: "unsupported", issue: "credential_bearing_source" };
  }
  const local = localSourcePath(source);
  if (!local) return { source, revision, canonicalSource: normalizeSource(source), status: "unresolved", issue: "nonlocal_source" };
  try {
    const canonicalSource = requireCanonicalDirectory(local, "initial repository source");
    if (!isGitMarker(path.join(canonicalSource, ".git"))) {
      return { source, revision, canonicalSource, status: "unresolved", issue: "not_repository" };
    }
    const configIssues = repositoryPolicyIssues(canonicalSource, runner);
    if (configIssues.length > 0) {
      return { source, revision, canonicalSource, status: "unsupported", issue: configIssues[0] };
    }
    const baseCommit = gitText(runner, canonicalSource, ["rev-parse", "--verify", "--end-of-options", `${revision || "HEAD"}^{commit}`]).trim();
    const baseTree = gitText(runner, canonicalSource, ["rev-parse", "--verify", `${baseCommit}^{tree}`]).trim();
    if (!OID_PATTERN.test(baseCommit) || !OID_PATTERN.test(baseTree)) {
      return { source, revision, canonicalSource, status: "unresolved", issue: "invalid_base_identity" };
    }
    return { source, revision, canonicalSource, baseCommit, baseTree, status: "pinned" };
  } catch (error) {
    return { source, revision, status: "unresolved", issue: safeIssue(error) };
  }
}

function inspectRepositorySafely(
  repoPath: string,
  initialRepositories: readonly InitialRepositoryPin[],
  runner: GitRunner
): RepositoryInspection {
  try {
    return inspectRepository(repoPath, initialRepositories, runner);
  } catch (error) {
    return {
      dirty: true,
      committedChanged: false,
      foldable: false,
      policyIssues: [safeIssue(error)]
    };
  }
}

function inspectRepository(
  repoPath: string,
  initialRepositories: readonly InitialRepositoryPin[],
  runner: GitRunner
): RepositoryInspection {
  const policyIssues = repositoryPolicyIssues(repoPath, runner);
  if (policyIssues.length > 0) {
    return {
      dirty: true,
      committedChanged: false,
      foldable: false,
      policyIssues: boundedPolicyIssues(policyIssues)
    };
  }
  let source: string | undefined;
  let headCommit: string | undefined;
  let headTree: string | undefined;
  let dirty = true;

  const localConfig = readLocalConfig(repoPath, runner);
  const origin = localConfig.get("remote.origin.url")?.at(-1);
  if (origin && !containsCredentialUrl(origin) && origin.length <= 2048) source = normalizeSource(origin);
  else if (origin && containsCredentialUrl(origin)) policyIssues.push("credential_bearing_remote");
  else if (origin) policyIssues.push("remote_url_limit");

  const pin = matchInitialRepository(source, initialRepositories);
  try {
    headCommit = gitText(runner, repoPath, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    headTree = gitText(runner, repoPath, ["rev-parse", "--verify", `${headCommit}^{tree}`]).trim();
    if (!OID_PATTERN.test(headCommit) || !OID_PATTERN.test(headTree)) throw new Error("invalid_head_identity");
  } catch (error) {
    policyIssues.push(safeIssue(error));
  }

  const baseCommit = pin?.status === "pinned" ? pin.baseCommit : undefined;
  const baseTree = pin?.status === "pinned" ? pin.baseTree : undefined;
  if (pin && pin.status !== "pinned") {
    policyIssues.push(boundText(`initial_base_${pin.status}:${pin.issue ?? "unresolved"}`, 160));
  }
  if (!baseCommit) policyIssues.push("missing_base");
  if (baseCommit && !baseTree) policyIssues.push("missing_base_tree");
  if (headCommit && !headTree) policyIssues.push("missing_head_tree");
  const baseExists = Boolean(headCommit && baseCommit && objectExists(repoPath, baseCommit, runner));
  if (headCommit && baseCommit && !baseExists) policyIssues.push("base_object_missing");
  if (headCommit && baseCommit && baseExists && !isAncestor(repoPath, baseCommit, headCommit, runner)) {
    policyIssues.push("base_not_ancestor");
  }

  try {
    dirty = repositoryDirty(repoPath, runner);
  } catch (error) {
    policyIssues.push(safeIssue(error));
  }

  const committedChanged = Boolean(headCommit && baseCommit && baseExists && headCommit !== baseCommit);
  if (!committedChanged) policyIssues.push("no_committed_changes");
  const allIssues = [...new Set(policyIssues)].sort();
  const issues = allIssues.length <= 64 ? allIssues : [...allIssues.slice(0, 63), "policy_issues_truncated"];
  return {
    source,
    baseCommit,
    baseTree,
    headCommit,
    headTree,
    dirty,
    committedChanged,
    foldable: committedChanged && Boolean(headCommit && baseCommit && headTree && baseTree) && issues.length === 0,
    policyIssues: issues
  };
}

export function repositoryPolicyIssues(repoPath: string, runner: GitRunner): string[] {
  const issues: string[] = [];
  const gitMarker = path.join(repoPath, ".git");
  const marker = lstatSync(gitMarker);
  if (marker.isSymbolicLink()) issues.push("git_metadata_symlink");
  if (!marker.isDirectory()) issues.push("linked_or_indirect_gitdir");
  if (marker.isDirectory() && existsSync(path.join(gitMarker, "commondir"))) issues.push("linked_common_gitdir");
  if (marker.isDirectory()) issues.push(...gitMetadataIssues(gitMarker));
  if (issues.length > 0) return [...new Set(issues)].sort();
  const config = readLocalConfig(repoPath, runner);
  for (const key of config.keys()) {
    const lower = key.toLowerCase();
    if (
      lower === "core.hookspath" ||
      lower === "core.fsmonitor" ||
      lower === "core.sparsecheckout" ||
      lower === "core.sparsecheckoutcone" ||
      lower === "core.worktree" ||
      lower.startsWith("filter.") ||
      (lower.startsWith("diff.") && (lower.endsWith(".textconv") || lower.endsWith(".command"))) ||
      (lower.startsWith("merge.") && lower.endsWith(".driver")) ||
      lower.startsWith("include.") ||
      lower.startsWith("includeif.") ||
      lower.startsWith("extensions.") ||
      (lower.startsWith("remote.") && lower.endsWith(".promisor"))
    ) issues.push(`unsupported_config:${boundText(lower, 120)}`);
  }
  const repositoryFormat = config.get("core.repositoryformatversion")?.at(-1);
  if (repositoryFormat !== undefined && repositoryFormat !== "0") issues.push("unsupported_repository_format");
  if (issues.length > 0) return boundedPolicyIssues(issues);
  const gitDir = marker.isDirectory() ? gitMarker : undefined;
  if (gitDir) {
    if (existsSync(path.join(gitDir, "objects", "info", "alternates"))) issues.push("object_alternates");
    if (existsSync(path.join(gitDir, "info", "sparse-checkout"))) issues.push("sparse_checkout");
    const hooks = path.join(gitDir, "hooks");
    if (existsSync(hooks) && readdirSync(hooks).some((entry) => !entry.endsWith(".sample"))) issues.push("repository_hooks");
    if (existsSync(path.join(gitDir, "info", "attributes"))) issues.push("repository_attributes");
    if (existsSync(path.join(gitDir, "shallow"))) issues.push("shallow_repository");
  }
  if (issues.length > 0) return boundedPolicyIssues(issues);
  try {
    const attributes = parseNulPaths(gitBuffer(runner, repoPath, ["ls-files", "--cached", "--others", "-z", "--", ".gitattributes", "**/.gitattributes"]));
    if (attributes.length > 0) return ["repository_attributes"];
    const indexEntries = parseNulPaths(gitBuffer(runner, repoPath, ["ls-files", "-v", "-z"]));
    if (indexEntries.some((entry) => entry[0] === "S" || (entry[0] !== undefined && entry[0] >= "a" && entry[0] <= "z"))) return ["index_visibility_flags"];
    const gitlinks = gitText(runner, repoPath, ["ls-tree", "-r", "HEAD"]);
    if (gitlinks.split("\n").some((line) => line.startsWith("160000 "))) return ["gitlinks_or_submodules"];
    const replacements = gitText(runner, repoPath, ["for-each-ref", "--format=%(refname)", "refs/replace"]);
    if (replacements.trim()) return ["replace_refs"];
  } catch (error) {
    issues.push(safeIssue(error));
  }
  return boundedPolicyIssues(issues);
}

export function repositoryDirty(repoPath: string, runner: GitRunner): boolean {
  const trackedStatus = gitBuffer(runner, repoPath, ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=none"]);
  const untrackedStatus = gitBuffer(runner, repoPath, ["ls-files", "--others", "--directory", "-z"]);
  return trackedStatus.byteLength > 0 || untrackedStatus.byteLength > 0;
}

export function repositoryTreePolicyIssues(repoPath: string, commit: string, runner: GitRunner): string[] {
  if (!OID_PATTERN.test(commit)) return ["invalid_tree_commit"];
  try {
    const output = gitBuffer(runner, repoPath, ["ls-tree", "-r", "-z", "--full-tree", commit]);
    if (output.byteLength === 0) return [];
    if (output.at(-1) !== 0) throw new Error("malformed_tree_listing");
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(output); }
    catch { throw new Error("tree_listing_not_utf8"); }
    for (const entry of decoded.slice(0, -1).split("\0")) {
      const separator = entry.indexOf("\t");
      if (separator <= 0) throw new Error("malformed_tree_entry");
      const metadata = entry.slice(0, separator);
      const repositoryPath = entry.slice(separator + 1);
      const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/.exec(metadata);
      if (!match || !repositoryPath) throw new Error("malformed_tree_entry");
      const [mode, type] = [match[1], match[2]];
      const validEntry = (type === "blob" && (mode === "100644" || mode === "100755" || mode === "120000")) || (type === "commit" && mode === "160000") || (type === "tree" && mode === "040000");
      if (!validEntry) throw new Error("malformed_tree_entry");
      if (mode === "160000") return ["gitlinks_or_submodules"];
      const basename = repositoryPath.slice(repositoryPath.lastIndexOf("/") + 1);
      if (basename.toLowerCase() === ".gitattributes") return ["repository_attributes"];
    }
    return [];
  } catch (error) {
    return [safeIssue(error)];
  }
}

function gitMetadataIssues(gitDirectory: string): string[] {
  const root = path.resolve(gitDirectory);
  if (realpathSync(root) !== root) return ["git_metadata_alias"];
  const queue = [root];
  let scanned = 0;
  while (queue.length > 0) {
    const directory = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return ["git_metadata_unreadable"];
    }
    for (const entry of entries) {
      if (++scanned > MAX_SCAN_ENTRIES) return ["git_metadata_scan_limit"];
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) return ["git_metadata_symlink"];
      const metadata = lstatSync(child);
      if (entry.isDirectory()) queue.push(child);
      else if (!entry.isFile()) return ["git_metadata_special_file"];
      else {
        const relative = path.relative(root, child);
        const objectContent = relative.startsWith(`objects${path.sep}`);
        if (!objectContent && metadata.nlink !== 1) return ["git_metadata_hardlink"];
      }
    }
  }
  return [];
}

function discoverRepositories(
  reposRoot: string,
  workspaceRoot: string,
  reportedRepositoryPaths: readonly string[]
): { repositories: string[]; coverage: RepositoryScanCoverage } {
  const repositories = [...new Set(reportedRepositoryPaths)];
  const repositorySet = new Set(repositories);
  const limitations = new Set<RepositoryScanLimitation>();
  const queue: Array<{ directory: string; depth: number }> = [{ directory: reposRoot, depth: 0 }];
  let scanned = 0;
  let stop = false;
  while (queue.length > 0 && !stop) {
    const next = queue.shift()!;
    const marker = path.join(next.directory, ".git");
    if (existsSync(marker) && !repositorySet.has(next.directory)) {
      let validPath = true;
      try {
        relativeWorkspacePath(workspaceRoot, next.directory);
      } catch {
        limitations.add("path_limit");
        validPath = false;
      }
      if (validPath) {
        if (repositories.length >= MAX_REPOSITORIES) {
          limitations.add("repository_limit");
          break;
        }
        repositories.push(next.directory);
        repositorySet.add(next.directory);
      }
    }
    let entries;
    try {
      entries = readdirSync(next.directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
    } catch {
      limitations.add("unreadable_directory");
      continue;
    }
    for (const entry of entries) {
      if (++scanned > MAX_SCAN_ENTRIES) {
        limitations.add("entry_limit");
        stop = true;
        break;
      }
      if (entry.name === ".git" || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (next.depth >= MAX_SCAN_DEPTH) {
        limitations.add("depth_limit");
        continue;
      }
      queue.push({ directory: path.join(next.directory, entry.name), depth: next.depth + 1 });
    }
  }
  const orderedLimitations = [...limitations].sort(compareText);
  return {
    repositories: repositories.sort((left, right) => compareText(path.relative(workspaceRoot, left), path.relative(workspaceRoot, right))),
    coverage: { complete: orderedLimitations.length === 0, limitations: orderedLimitations }
  };
}

function reportedRepositories(
  handoff: AcceptedWorkerHandoff,
  workspaceRoot: string,
  reposRoot: string
): ReportedRepositoryCollection {
  const reports = new Map<string, ReportedRepository>();
  const issues: ReportedRepositoryIssue[] = [];
  const repositoryPaths: string[] = [];
  for (const report of handoff.handoff.repositories ?? []) {
    const issuePath = boundUtf8(report.workspaceRepo, MAX_PATH_BYTES);
    const absolute = path.resolve(workspaceRoot, report.workspaceRepo);
    if (!isWithin(reposRoot, absolute) || !existsSync(absolute)) {
      issues.push({ kind: existsSync(absolute) ? "reported_not_repository" : "reported_missing", workspaceRepo: issuePath });
      continue;
    }
    try {
      const metadata = lstatSync(absolute);
      const workspaceRepo = relativeWorkspacePath(workspaceRoot, absolute);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(absolute) !== absolute || !existsSync(path.join(absolute, ".git"))) {
        issues.push({ kind: "reported_not_repository", workspaceRepo: issuePath });
        continue;
      }
      reports.set(workspaceRepo, { purpose: report.purpose, dependsOn: [...(report.dependsOn ?? [])] });
      repositoryPaths.push(absolute);
    } catch {
      issues.push({ kind: "reported_not_repository", workspaceRepo: issuePath });
    }
  }
  return { reports, issues, repositoryPaths };
}

export function createGitRunner(gitPath: string, trustedStateRoot: string): GitRunner {
  const executable = realpathSync(gitPath);
  const home = path.join(path.resolve(trustedStateRoot), "git-home");
  const templateDir = path.join(home, "empty-template");
  mkdirSync(templateDir, { recursive: true, mode: 0o700 });
  return {
    gitPath: executable,
    templateDir,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: home,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/usr/bin/false",
      SSH_ASKPASS: "/usr/bin/false",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_EDITOR: "false",
      GIT_SEQUENCE_EDITOR: "false",
      GIT_SSH_COMMAND: "false",
      GIT_TEMPLATE_DIR: templateDir
    }
  };
}

export type GitRunOptions = {
  allowedStatuses?: readonly number[];
  deterministicCommitIdentity?: boolean;
};

export function runGit(
  runner: GitRunner,
  cwd: string,
  args: string[],
  options: GitRunOptions = {}
): { stdout: Buffer; status: number } {
  const common = [
    "--no-optional-locks",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.ignoreStat=false",
    "-c", "core.fileMode=true",
    "-c", "core.autocrlf=false",
    "-c", `core.worktree=${cwd}`,
    "-c", "core.bare=false",
    "-c", "credential.helper=",
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=0",
    "-c", "fetch.fsckObjects=true",
    "-c", "transfer.fsckObjects=true",
    "-c", "receive.fsckObjects=true",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "diff.external=",
    "-c", "core.attributesFile=/dev/null",
    "-c", "core.excludesFile=/dev/null"
  ];
  const gitDirectory = path.join(cwd, ".git");
  const commitEnvironment = options.deterministicCommitIdentity ? {
    GIT_AUTHOR_NAME: "Pi Worker Fold",
    GIT_AUTHOR_EMAIL: "worker-fold@localhost",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Pi Worker Fold",
    GIT_COMMITTER_EMAIL: "worker-fold@localhost",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z"
  } : {};
  const result = spawnSync(runner.gitPath, [...common, `--git-dir=${gitDirectory}`, `--work-tree=${cwd}`, ...args], {
    cwd,
    env: { ...runner.env, ...commitEnvironment, GIT_CEILING_DIRECTORIES: cwd },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    killSignal: "SIGKILL",
    maxBuffer: MAX_GIT_OUTPUT_BYTES
  });
  if (result.error) throw new Error(`git_spawn_failed:${boundText(result.error.message, 120)}`);
  const status = result.status ?? -1;
  if (!(options.allowedStatuses ?? [0]).includes(status)) throw new Error(`git_failed:${args[0] ?? "command"}`);
  const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  if (output.byteLength > MAX_GIT_OUTPUT_BYTES) throw new Error("git_output_limit");
  return { stdout: output, status };
}

export function runStandaloneGit(runner: GitRunner, cwd: string, args: string[]): Buffer {
  const common = [
    "--no-optional-locks",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.ignoreStat=false",
    "-c", "core.fileMode=true",
    "-c", "core.autocrlf=false",
    "-c", "credential.helper=",
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=0",
    "-c", "fetch.fsckObjects=true",
    "-c", "transfer.fsckObjects=true",
    "-c", "receive.fsckObjects=true",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "diff.external=",
    "-c", "core.attributesFile=/dev/null",
    "-c", "core.excludesFile=/dev/null"
  ];
  const result = spawnSync(runner.gitPath, [...common, ...args], {
    cwd,
    env: { ...runner.env, GIT_CEILING_DIRECTORIES: cwd },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    killSignal: "SIGKILL",
    maxBuffer: MAX_GIT_OUTPUT_BYTES
  });
  if (result.error) throw new Error(`git_spawn_failed:${boundText(result.error.message, 120)}`);
  if (result.status !== 0) throw new Error(`git_failed:${args[0] ?? "command"}`);
  const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  if (output.byteLength > MAX_GIT_OUTPUT_BYTES) throw new Error("git_output_limit");
  return output;
}

export function gitBuffer(runner: GitRunner, cwd: string, args: string[], options?: GitRunOptions): Buffer {
  return runGit(runner, cwd, args, options).stdout;
}

export function gitText(runner: GitRunner, cwd: string, args: string[], options?: GitRunOptions): string {
  const output = gitBuffer(runner, cwd, args, options).toString("utf8");
  if (output.includes("\uFFFD")) throw new Error("git_output_not_utf8");
  return output;
}

function readLocalConfig(repoPath: string, runner: GitRunner): Map<string, string[]> {
  const output = gitText(runner, repoPath, ["config", "--local", "--no-includes", "--null", "--list"]);
  const config = new Map<string, string[]>();
  for (const item of output.split("\0")) {
    if (!item) continue;
    const newline = item.indexOf("\n");
    if (newline <= 0) throw new Error("invalid_local_config_output");
    const key = item.slice(0, newline).toLowerCase();
    const value = item.slice(newline + 1);
    const values = config.get(key) ?? [];
    values.push(value);
    config.set(key, values);
  }
  return config;
}

function objectExists(repoPath: string, oid: string, runner: GitRunner): boolean {
  if (!OID_PATTERN.test(oid)) return false;
  try {
    gitBuffer(runner, repoPath, ["cat-file", "-e", `${oid}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function isAncestor(repoPath: string, baseCommit: string, headCommit: string, runner: GitRunner): boolean {
  try {
    gitBuffer(runner, repoPath, ["merge-base", "--is-ancestor", baseCommit, headCommit]);
    return true;
  } catch {
    return false;
  }
}

function parseNulPaths(output: Buffer): string[] {
  const text = output.toString("utf8");
  if (text.includes("\uFFFD")) throw new Error("git_path_not_utf8");
  return text.split("\0").filter(Boolean);
}

function matchInitialRepository(source: string | undefined, pins: readonly InitialRepositoryPin[]): InitialRepositoryPin | undefined {
  if (!source) return undefined;
  const normalized = normalizeSource(source);
  return pins.find((pin) => pin.canonicalSource === normalized || normalizeSource(pin.source) === normalized);
}

function localSourcePath(source: string): string | undefined {
  if (path.isAbsolute(source)) return path.resolve(source);
  if (source.startsWith("file://")) {
    try {
      const url = new URL(source);
      return path.resolve(decodeURIComponent(url.pathname));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function normalizeSource(source: string): string {
  const local = localSourcePath(source);
  if (local && existsSync(local)) {
    try { return realpathSync(local); } catch { return local; }
  }
  return source.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}

function containsCredentialUrl(source: string): boolean {
  try {
    const url = new URL(source);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

function redactSource(source: string): string {
  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    return boundText(url.toString(), 2048);
  } catch {
    return "redacted-source";
  }
}

function requireCanonicalDirectory(directory: string, label: string): string {
  const target = path.resolve(directory);
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a canonical directory.`);
  const canonical = realpathSync(target);
  if (canonical !== target) throw new Error(`${label} contains a path alias.`);
  return canonical;
}

function isGitMarker(marker: string): boolean {
  try {
    const stat = lstatSync(marker);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativeWorkspacePath(workspaceRoot: string, absolute: string): string {
  const relative = path.relative(workspaceRoot, absolute).replaceAll(path.sep, "/");
  if (!relative || relative === "." || relative.startsWith("../")) throw new Error("Repository path escapes the worker workspace.");
  if (Buffer.byteLength(relative, "utf8") > MAX_PATH_BYTES) throw new Error("Repository path exceeds the bounded identity limit.");
  return relative;
}

export function repositoryCandidateId(input: {
  workerId: string;
  runId: string;
  workspaceRepo: string;
  baseCommit?: string;
  headCommit?: string;
  headTree?: string;
}): string {
  const digest = createHash("sha256").update(JSON.stringify({ version: 1, ...input })).digest("hex");
  return `candidate_${digest.slice(0, 24)}`;
}

function summarizeRepositoryInventory(
  inventoryFile: string,
  serialized: string,
  inventory: RepositoryInventory
): RepositoryInventorySummary {
  return {
    inventoryFile,
    inventorySha256: sha256(serialized),
    candidateCount: inventory.candidates.length,
    foldableCount: inventory.candidates.filter((candidate) => candidate.foldable).length,
    reportedIssueCount: inventory.reportedIssues.length,
    candidates: inventory.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      workspaceRepo: candidate.workspaceRepo,
      reported: candidate.reported,
      dirty: candidate.dirty,
      committedChanged: candidate.committedChanged,
      foldable: candidate.foldable,
      policyIssues: [...candidate.policyIssues]
    })),
    reportedIssues: inventory.reportedIssues.map((item) => ({ ...item })),
    scanCoverage: {
      complete: inventory.scanCoverage.complete,
      limitations: [...inventory.scanCoverage.limitations]
    }
  };
}

export function isRepositoryInventorySummary(value: unknown, inventoryFile: string): value is RepositoryInventorySummary {
  if (
    !isRecord(value) ||
    value.inventoryFile !== path.resolve(inventoryFile) ||
    typeof value.inventorySha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.inventorySha256) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > MAX_REPOSITORIES ||
    !Array.isArray(value.reportedIssues) ||
    value.reportedIssues.length > 16 ||
    !isRepositoryScanCoverage(value.scanCoverage) ||
    value.candidateCount !== value.candidates.length ||
    value.reportedIssueCount !== value.reportedIssues.length
  ) return false;
  if (value.foldableCount !== value.candidates.filter((candidate) => isRecord(candidate) && candidate.foldable === true).length) return false;
  if (!value.candidates.every((candidate) =>
    isRecord(candidate) &&
    typeof candidate.candidateId === "string" && /^candidate_[0-9a-f]{24}$/.test(candidate.candidateId) &&
    typeof candidate.workspaceRepo === "string" && candidate.workspaceRepo.length > 0 && Buffer.byteLength(candidate.workspaceRepo, "utf8") <= MAX_PATH_BYTES &&
    typeof candidate.reported === "boolean" && typeof candidate.dirty === "boolean" && typeof candidate.committedChanged === "boolean" && typeof candidate.foldable === "boolean" &&
    Array.isArray(candidate.policyIssues) && candidate.policyIssues.length <= 64 && candidate.policyIssues.every((issue) => typeof issue === "string" && issue.length <= 160)
  )) return false;
  return value.reportedIssues.every((item) =>
    isRecord(item) &&
    ["reported_missing", "reported_not_repository"].includes(String(item.kind)) &&
    typeof item.workspaceRepo === "string" && item.workspaceRepo.length > 0 && Buffer.byteLength(item.workspaceRepo, "utf8") <= MAX_PATH_BYTES
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedPolicyIssues(issues: readonly string[]): string[] {
  const unique = [...new Set(issues)].sort();
  return unique.length <= 64 ? unique : [...unique.slice(0, 63), "policy_issues_truncated"];
}

function safeIssue(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundText(message.replace(/[^a-zA-Z0-9_.:-]+/g, "_"), 160) || "repository_inspection_failed";
}

function boundText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function boundUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && Buffer.byteLength(`${value.slice(0, end)}…`, "utf8") > maxBytes) end--;
  return `${value.slice(0, end)}…`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isRepositoryInventory(value: unknown): value is RepositoryInventory {
  if (
    !isRecord(value) ||
    value.version !== REPOSITORY_INVENTORY_VERSION ||
    typeof value.workerId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.workspaceRoot !== "string" ||
    typeof value.generatedAt !== "string" ||
    !Array.isArray(value.candidates) ||
    !Array.isArray(value.reportedIssues) ||
    !isRepositoryScanCoverage(value.scanCoverage)
  ) return false;
  if (value.candidates.length > MAX_REPOSITORIES || value.reportedIssues.length > 16) return false;
  return value.candidates.every((candidate) =>
    isRepositoryCandidate(candidate) && candidate.workerId === value.workerId && candidate.runId === value.runId
  ) && value.reportedIssues.every((item) =>
    isRecord(item) &&
    ["reported_missing", "reported_not_repository"].includes(String(item.kind)) &&
    typeof item.workspaceRepo === "string" && item.workspaceRepo.length > 0 && Buffer.byteLength(item.workspaceRepo, "utf8") <= MAX_PATH_BYTES
  );
}

function isRepositoryScanCoverage(value: unknown): value is RepositoryScanCoverage {
  return isRecord(value) &&
    typeof value.complete === "boolean" &&
    Array.isArray(value.limitations) &&
    value.limitations.length <= 5 &&
    value.limitations.every((item) => ["entry_limit", "repository_limit", "depth_limit", "path_limit", "unreadable_directory"].includes(String(item))) &&
    value.complete === (value.limitations.length === 0);
}

function isRepositoryCandidate(value: unknown): value is RepositoryCandidate {
  return isRecord(value) &&
    typeof value.candidateId === "string" && /^candidate_[0-9a-f]{24}$/.test(value.candidateId) &&
    typeof value.workerId === "string" && typeof value.runId === "string" && typeof value.workspaceRepo === "string" &&
    typeof value.reported === "boolean" && Array.isArray(value.dependsOn) && value.dependsOn.length <= 16 && value.dependsOn.every((item) => typeof item === "string" && item.length > 0 && item.length <= 1024) &&
    typeof value.dirty === "boolean" && typeof value.committedChanged === "boolean" && typeof value.foldable === "boolean" &&
    Array.isArray(value.policyIssues) && value.policyIssues.length <= 64 && value.policyIssues.every((item) => typeof item === "string" && item.length <= 160) &&
    optionalString(value.purpose) && optionalString(value.source) && optionalOid(value.baseCommit) && optionalOid(value.baseTree) && optionalOid(value.headCommit) && optionalOid(value.headTree) &&
    ((value.baseCommit === undefined) === (value.baseTree === undefined)) && ((value.headCommit === undefined) === (value.headTree === undefined));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalOid(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && OID_PATTERN.test(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
