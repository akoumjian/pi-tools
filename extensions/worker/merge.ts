import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

export type WorkerMergeMethod = "merge" | "squash";
export type WorkerMergeTestRepositoryInput = {
  id: string;
  candidateRepo: string;
  candidateRef?: string;
  targetRepo: string;
  targetRef: string;
  method: WorkerMergeMethod;
  commitMessage: string;
  dependsOn?: string[];
};
export type ManagedCandidateSource = { workerId: string; runId?: string; latest: boolean };
export type PreparedMergeRepository = {
  id: string;
  candidateRepo: string;
  candidateCommit: string;
  targetRepo: string;
  targetRef: string;
  method: WorkerMergeMethod;
  status: "ready" | "resolution_required";
  expectedCommit: string;
  desiredCommit?: string;
  preparedPath: string;
  overlapCount: number;
  dependsOn: string[];
  source?: ManagedCandidateSource;
  warnings?: string[];
};
export type PreparedMergeSet = {
  version: 1;
  preparedId: string;
  parentSessionFile: string;
  status: "ready" | "resolution_required";
  order: string[];
  repositories: PreparedMergeRepository[];
  resolutionCases?: Array<{ id: string; summary: string }>;
  createdAt: string;
  consumedByWorkerId?: string;
};
export type WorkerMergeApplyResult = {
  preparedId: string;
  status: "completed" | "partial" | "failed";
  repositories: Array<{ id: string; targetRepo: string; targetRef: string; desiredCommit: string; status: "applied" | "pending" | "failed"; error?: string; warnings?: string[] }>;
  error?: string;
};

export type MergeRuntimeOptions = {
  preparedRoot?: string;
  targetRoot?: string;
  now?: () => Date;
  randomHex?: () => string;
  sourceForCandidate?: (candidateRepo: string, candidateCommit: string) => { source?: ManagedCandidateSource; warnings?: string[] };
};

export function defaultPreparedMergeRoot(home = homedir()): string {
  return path.join(home, ".local", "share", "agent", "worker-runtime", "prepared");
}

export function prepareWorkerMerges(parentSessionFile: string, inputs: WorkerMergeTestRepositoryInput[], options: MergeRuntimeOptions = {}): PreparedMergeSet {
  const normalized = validateMergeInputs(inputs, options.targetRoot ?? path.join(homedir(), "Code"));
  const order = topologicalOrder(normalized);
  const preparedId = `prepared_${(options.randomHex?.() ?? randomBytes(12).toString("hex")).slice(0, 24)}`;
  const root = path.resolve(options.preparedRoot ?? defaultPreparedMergeRoot());
  const setRoot = path.join(root, preparedId);
  if (existsSync(setRoot)) throw new Error(`Generated prepared set already exists: ${preparedId}.`);
  mkdirSync(setRoot, { recursive: true, mode: 0o700 });
  const repositories: PreparedMergeRepository[] = [];
  try {
    for (const id of order) {
      const input = normalized.find((item) => item.id === id)!;
      repositories.push(prepareOne(input, path.join(setRoot, id), options.sourceForCandidate));
    }
    const resolutionCases = repositories.filter((item) => item.status === "resolution_required").map((item) => ({ id: item.id, summary: `${item.overlapCount} unmerged path${item.overlapCount === 1 ? "" : "s"} require resolution.` }));
    const result: PreparedMergeSet = {
      version: 1, preparedId, parentSessionFile: path.resolve(parentSessionFile),
      status: resolutionCases.length === 0 ? "ready" : "resolution_required", order, repositories,
      ...(resolutionCases.length === 0 ? {} : { resolutionCases }),
      createdAt: (options.now?.() ?? new Date()).toISOString()
    };
    writeJson(path.join(setRoot, "prepared.json"), result);
    return result;
  } catch (error) {
    rmSync(setRoot, { recursive: true, force: true });
    throw error;
  }
}

export function readPreparedMergeSet(parentSessionFile: string, preparedId: string, options: MergeRuntimeOptions = {}): PreparedMergeSet {
  if (!/^prepared_[0-9a-f]{24}$/.test(preparedId)) throw new Error(`Invalid preparedId: ${preparedId}.`);
  const file = path.join(path.resolve(options.preparedRoot ?? defaultPreparedMergeRoot()), preparedId, "prepared.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as PreparedMergeSet;
  if (parsed.version !== 1 || parsed.preparedId !== preparedId) throw new Error(`Prepared set ${preparedId} has an unsupported format.`);
  if (path.resolve(parsed.parentSessionFile) !== path.resolve(parentSessionFile)) throw new Error(`Prepared set ${preparedId} belongs to another parent session.`);
  return parsed;
}

export function consumePreparedMergeSet(parentSessionFile: string, preparedId: string, workerId: string, workerWorkspace: string, options: MergeRuntimeOptions = {}): PreparedMergeSet {
  const set = readPreparedMergeSet(parentSessionFile, preparedId, options);
  if (set.status !== "resolution_required") throw new Error(`Prepared set ${preparedId} does not require integration.`);
  for (const repository of set.repositories) {
    const current = git(repository.targetRepo, ["rev-parse", repository.targetRef]);
    if (current !== repository.expectedCommit) throw new Error(`Target ${repository.id} moved from ${repository.expectedCommit} to ${current}; run worker_merge_test again before integration.`);
  }
  if (set.consumedByWorkerId !== undefined) throw new Error(`Prepared set ${preparedId} was already consumed by ${set.consumedByWorkerId}.`);
  const root = path.resolve(options.preparedRoot ?? defaultPreparedMergeRoot());
  const source = path.join(root, preparedId);
  const destinationRoot = path.join(path.resolve(workerWorkspace), "prepared");
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  const destination = path.join(destinationRoot, preparedId);
  if (existsSync(destination)) throw new Error(`Integration destination already exists: ${destination}.`);
  renameSync(source, destination);
  const moved: PreparedMergeSet = { ...set, repositories: set.repositories.map((item) => ({ ...item, preparedPath: path.join(destination, item.id) })), consumedByWorkerId: workerId };
  writeJson(path.join(destination, "prepared.json"), moved);
  return moved;
}

export function applyPreparedWorkerMerges(parentSessionFile: string, preparedId: string, options: MergeRuntimeOptions = {}): WorkerMergeApplyResult {
  const set = readPreparedMergeSet(parentSessionFile, preparedId, options);
  if (set.status !== "ready") throw new Error(`Prepared set ${preparedId} is not ready.`);
  const byId = new Map(set.repositories.map((item) => [item.id, item]));
  const ordered = set.order.map((id) => byId.get(id)!);
  for (const repository of ordered) {
    if (!repository.desiredCommit) throw new Error(`Prepared repository ${repository.id} has no desired commit.`);
    assertTargetClean(repository.targetRepo);
    const current = git(repository.targetRepo, ["rev-parse", repository.targetRef]);
    if (current !== repository.expectedCommit && current !== repository.desiredCommit) {
      throw new Error(`Target ${repository.id} moved from ${repository.expectedCommit} to ${current}; run worker_merge_test again.`);
    }
  }
  const results: WorkerMergeApplyResult["repositories"] = ordered.map((item) => {
    const refreshed = options.sourceForCandidate?.(item.candidateRepo, item.candidateCommit);
    const warnings = [...new Set([...(item.warnings ?? []), ...(refreshed?.warnings ?? [])])];
    return { id: item.id, targetRepo: item.targetRepo, targetRef: item.targetRef, desiredCommit: item.desiredCommit!, status: "pending", ...(warnings.length ? { warnings } : {}) };
  });
  for (let index = 0; index < ordered.length; index += 1) {
    const repository = ordered[index]!;
    const output = results[index]!;
    try {
      const current = git(repository.targetRepo, ["rev-parse", repository.targetRef]);
      if (current !== repository.desiredCommit) {
        git(repository.targetRepo, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", repository.preparedPath, repository.desiredCommit!]);
        const checkedOut = currentBranchRef(repository.targetRepo) === repository.targetRef;
        if (checkedOut) git(repository.targetRepo, ["-c", `branch.${repository.targetRef.slice("refs/heads/".length)}.mergeOptions=`, "merge", "--ff-only", repository.desiredCommit!]);
        else git(repository.targetRepo, ["update-ref", "--no-deref", repository.targetRef, repository.desiredCommit!, repository.expectedCommit]);
      }
      output.status = "applied";
    } catch (error) {
      output.status = "failed";
      output.error = error instanceof Error ? error.message : String(error);
      return { preparedId, status: index === 0 ? "failed" : "partial", repositories: results, error: output.error };
    }
  }
  const setRoot = path.dirname(path.resolve(ordered[0]?.preparedPath ?? path.join(options.preparedRoot ?? defaultPreparedMergeRoot(), preparedId, "placeholder")));
  if (path.basename(setRoot) === preparedId) {
    for (const repository of ordered) rmSync(repository.preparedPath, { recursive: true, force: true });
  }
  return { preparedId, status: "completed", repositories: results };
}

function prepareOne(input: Required<Pick<WorkerMergeTestRepositoryInput, "id" | "candidateRepo" | "candidateRef" | "targetRepo" | "targetRef" | "method" | "commitMessage">> & { dependsOn: string[] }, preparedPath: string, sourceResolver?: MergeRuntimeOptions["sourceForCandidate"]): PreparedMergeRepository {
  const branch = input.targetRef.slice("refs/heads/".length);
  runGit(["clone", "--no-local", "--no-tags", "--single-branch", "--branch", branch, input.targetRepo, preparedPath]);
  const expectedCommit = git(preparedPath, ["rev-parse", "HEAD"]);
  assertSafeGitTree(preparedPath, expectedCommit, input.id, "target");
  git(preparedPath, ["checkout", "--detach", expectedCommit]);
  git(preparedPath, ["remote", "remove", "origin"]);
  const candidateCommit = git(input.candidateRepo, ["rev-parse", `${input.candidateRef}^{commit}`]);
  assertSafeGitTree(input.candidateRepo, candidateCommit, input.id, "candidate");
  git(preparedPath, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", input.candidateRepo, `${candidateCommit}:refs/worker/candidate`]);
  if (git(preparedPath, ["rev-parse", "refs/worker/candidate^{commit}"]) !== candidateCommit) throw new Error(`Candidate commit changed during preparation for ${input.id}.`);
  let status: PreparedMergeRepository["status"] = "ready";
  try {
    if (input.method === "merge") {
      runGitIn(preparedPath, ["-c", "user.name=Managed Worker", "-c", "user.email=worker@localhost", "merge", "--no-edit", "--no-ff", "--no-commit", "refs/worker/candidate"]);
    } else {
      runGitIn(preparedPath, ["-c", "user.name=Managed Worker", "-c", "user.email=worker@localhost", "merge", "--squash", "refs/worker/candidate"]);
    }
  } catch {
    const overlapCount = unmergedCount(preparedPath);
    if (overlapCount === 0) throw new Error(`Git ${input.method} failed for ${input.id} without conflict state.`);
    status = "resolution_required";
  }
  let desiredCommit: string | undefined;
  const overlapCount = unmergedCount(preparedPath);
  if (status === "ready") {
    if (hasIndexChanges(preparedPath)) {
      runGitIn(preparedPath, ["-c", "user.name=Managed Worker", "-c", "user.email=worker@localhost", "commit", "--no-verify", "-m", input.commitMessage]);
      desiredCommit = git(preparedPath, ["rev-parse", "HEAD"]);
    } else {
      desiredCommit = expectedCommit;
    }
  }
  const provenance = sourceResolver?.(input.candidateRepo, candidateCommit) ?? {};
  return {
    id: input.id, candidateRepo: input.candidateRepo, candidateCommit, targetRepo: input.targetRepo, targetRef: input.targetRef,
    method: input.method, status, expectedCommit, ...(desiredCommit ? { desiredCommit } : {}), preparedPath, overlapCount, dependsOn: input.dependsOn,
    ...(provenance.source ? { source: provenance.source } : {}), ...(provenance.warnings?.length ? { warnings: provenance.warnings } : {})
  };
}

function validateMergeInputs(inputs: WorkerMergeTestRepositoryInput[], targetRoot: string) {
  if (inputs.length < 1 || inputs.length > 16) throw new Error("worker_merge_test requires 1 to 16 repositories.");
  const ids = new Set<string>();
  const targets = new Set<string>();
  const root = realpathSync(path.resolve(targetRoot));
  const normalized = inputs.map((item) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item.id) || ids.has(item.id)) throw new Error(`Invalid or duplicate repository id: ${item.id}.`);
    ids.add(item.id);
    if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(item.targetRef)) throw new Error(`Invalid targetRef for ${item.id}.`);
    if (!item.commitMessage || item.commitMessage.includes("\0") || Buffer.byteLength(item.commitMessage) > 16 * 1024) throw new Error(`Invalid commitMessage for ${item.id}.`);
    const candidateRepo = canonicalRepository(item.candidateRepo, "candidateRepo", item.id);
    const targetRepo = canonicalRepository(item.targetRepo, "targetRepo", item.id);
    if (!strictlyWithin(root, targetRepo)) throw new Error(`Target repository ${targetRepo} is outside ${root}.`);
    const targetIdentity = realpathSync(git(targetRepo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    if (targets.has(targetIdentity)) throw new Error(`Physical target repository is duplicated: ${targetRepo}.`);
    targets.add(targetIdentity);
    return { ...item, candidateRepo, targetRepo, candidateRef: item.candidateRef ?? "HEAD", dependsOn: [...new Set(item.dependsOn ?? [])] };
  });
  for (const item of normalized) for (const dependency of item.dependsOn) {
    if (dependency === item.id || !ids.has(dependency)) throw new Error(`Invalid dependency ${dependency} for ${item.id}.`);
  }
  topologicalOrder(normalized);
  return normalized;
}

function topologicalOrder(inputs: Array<{ id: string; dependsOn: string[] }>): string[] {
  const remaining = new Map(inputs.map((item) => [item.id, new Set(item.dependsOn)]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) => [...deps].every((id) => order.includes(id))).map(([id]) => id).sort();
    if (ready.length === 0) throw new Error("Repository dependency graph contains a cycle.");
    for (const id of ready) { order.push(id); remaining.delete(id); }
  }
  return order;
}

function assertSafeGitTree(repo: string, commit: string, id: string, label: string): void {
  const output = runGit(["-C", repo, "ls-tree", "-r", "-z", "--full-tree", commit]);
  for (const entry of output.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t"); if (tab < 0) throw new Error(`Invalid ${label} tree entry for ${id}.`);
    const metadata = entry.slice(0, tab).split(" "); const file = entry.slice(tab + 1); const base = path.posix.basename(file).normalize("NFC").toLocaleLowerCase("en-US");
    if (metadata[0] === "160000" || base === ".gitattributes" || base === ".gitmodules") throw new Error(`${label} tree for ${id} contains unsupported callback-bearing Git content: ${file}.`);
  }
}
function canonicalRepository(value: string, field: string, id: string): string {
  if (!value || Buffer.byteLength(value) > 4096) throw new Error(`${field} for ${id} is invalid.`);
  const exact = realpathSync(path.resolve(value));
  git(exact, ["rev-parse", "--git-dir"]);
  return exact;
}
function assertTargetClean(repo: string): void {
  if (git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") throw new Error(`Target repository is dirty: ${repo}.`);
}
function currentBranchRef(repo: string): string | undefined {
  try { return `refs/heads/${git(repo, ["symbolic-ref", "--short", "HEAD"])}`; } catch { return undefined; }
}
function unmergedCount(repo: string): number { return git(repo, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean).length; }
function hasIndexChanges(repo: string): boolean {
  try { runGitIn(repo, ["diff", "--cached", "--quiet"]); return false; } catch { return true; }
}
function git(repo: string, args: string[]): string { return runGit(["-C", repo, ...args]).trim(); }
function runGitIn(repo: string, args: string[]): string { return runGit(["-C", repo, ...args]); }
function runGit(args: string[]): string {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false", GIT_CONFIG_COUNT: "6", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null", GIT_CONFIG_KEY_1: "commit.gpgSign", GIT_CONFIG_VALUE_1: "false", GIT_CONFIG_KEY_2: "tag.gpgSign", GIT_CONFIG_VALUE_2: "false", GIT_CONFIG_KEY_3: "merge.autoStash", GIT_CONFIG_VALUE_3: "false", GIT_CONFIG_KEY_4: "merge.verifySignatures", GIT_CONFIG_VALUE_4: "false", GIT_CONFIG_KEY_5: "credential.helper", GIT_CONFIG_VALUE_5: "" };
  return execFileSync("git", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
}
function writeJson(file: string, value: unknown): void { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function strictlyWithin(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
