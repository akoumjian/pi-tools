import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { assertTrustedGitPolicy, canonicalRepository as trustedCanonicalRepository, createTrustedGitOperation, runTrustedGit, type TrustedGitOperation } from "./trusted-git.js";

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
  targetPrivateRef: string; candidatePrivateRef: string; mergeBase: string;
  conflicts?: Array<{ path: string; status: string }>; mergeMessages?: string[];
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
  trustedSet?: PreparedMergeSet;
};

export function defaultPreparedMergeRoot(home = homedir()): string {
  return path.join(home, ".local", "share", "agent", "worker-runtime", "prepared");
}

export function prepareWorkerMerges(parentSessionFile: string, inputs: WorkerMergeTestRepositoryInput[], options: MergeRuntimeOptions = {}): PreparedMergeSet {
  const operation = createTrustedGitOperation();
  const normalized = validateMergeInputs(inputs, options.targetRoot ?? path.join(homedir(), "Code"), operation);
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
      repositories.push(prepareOne(input, path.join(setRoot, id), options.sourceForCandidate, operation));
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
  const parsed = options.trustedSet ?? JSON.parse(readFileSync(path.join(path.resolve(options.preparedRoot ?? defaultPreparedMergeRoot()), preparedId, "prepared.json"), "utf8")) as PreparedMergeSet;
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

export function restoreConsumedPreparedMergeSet(parentSessionFile: string, preparedId: string, workerWorkspace: string, options: MergeRuntimeOptions = {}): void {
  const root = path.resolve(options.preparedRoot ?? defaultPreparedMergeRoot());
  const source = path.join(path.resolve(workerWorkspace), "prepared", preparedId);
  const destination = path.join(root, preparedId);
  if (!existsSync(source)) return;
  if (existsSync(destination)) throw new Error(`Cannot roll back consumed prepared set because destination exists: ${destination}.`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const set = options.trustedSet ?? JSON.parse(readFileSync(path.join(source, "prepared.json"), "utf8")) as PreparedMergeSet;
  if (set.preparedId !== preparedId || path.resolve(set.parentSessionFile) !== path.resolve(parentSessionFile)) throw new Error(`Prepared set ${preparedId} rollback parent mismatch.`);
  const restored = { ...set, repositories: set.repositories.map((item) => ({ ...item, preparedPath: path.join(destination, item.id) })) };
  delete restored.consumedByWorkerId;
  writeJson(path.join(source, "prepared.json"), restored);
  renameSync(source, destination);
}

export function applyPreparedWorkerMerges(parentSessionFile: string, preparedId: string, options: MergeRuntimeOptions = {}): WorkerMergeApplyResult {
  const set = readPreparedMergeSet(parentSessionFile, preparedId, options);
  if (!["ready", "partial", "failed"].includes(set.status)) throw new Error(`Prepared set ${preparedId} is not ready.`);
  const operation = createTrustedGitOperation();
  const byId = new Map(set.repositories.map((item) => [item.id, item]));
  const ordered = set.order.map((id) => byId.get(id)!);
  for (const repository of ordered) {
    if (!repository.desiredCommit) throw new Error(`Prepared repository ${repository.id} has no desired commit.`);
    assertTrustedGitPolicy(repository.targetRepo, operation);
    const targetCheckout = targetCheckoutPath(repository.targetRepo, repository.targetRef);
    if (targetCheckout) assertTargetClean(targetCheckout);
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
        const checkout = targetCheckoutPath(repository.targetRepo, repository.targetRef);
        if (checkout) git(checkout, ["-c", `branch.${repository.targetRef.slice("refs/heads/".length)}.mergeOptions=`, "merge", "--ff-only", repository.desiredCommit!]);
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
  if (path.basename(setRoot) === preparedId) rmSync(setRoot, { recursive: true, force: true });
  return { preparedId, status: "completed", repositories: results };
}

function prepareOne(input: Required<Pick<WorkerMergeTestRepositoryInput, "id" | "candidateRepo" | "candidateRef" | "targetRepo" | "targetRef" | "method" | "commitMessage">> & { dependsOn: string[] }, preparedPath: string, sourceResolver: MergeRuntimeOptions["sourceForCandidate"] | undefined, operation: TrustedGitOperation): PreparedMergeRepository {
  const branch = input.targetRef.slice("refs/heads/".length);
  assertTrustedGitPolicy(input.targetRepo, operation); assertTrustedGitPolicy(input.candidateRepo, operation);
  runGit(["clone", "--no-local", "--no-tags", "--single-branch", "--branch", branch, input.targetRepo, preparedPath]);
  const expectedCommit = git(preparedPath, ["rev-parse", "HEAD"]);
  const targetPrivateRef = "refs/worker/target"; const candidatePrivateRef = "refs/worker/candidate";
  git(preparedPath, ["update-ref", targetPrivateRef, expectedCommit]);
  assertSafeGitTree(preparedPath, expectedCommit, input.id, "target");
  git(preparedPath, ["checkout", "--detach", expectedCommit]);
  git(preparedPath, ["remote", "remove", "origin"]);
  const candidateCommit = git(input.candidateRepo, ["rev-parse", `${input.candidateRef}^{commit}`]);
  assertSafeGitTree(input.candidateRepo, candidateCommit, input.id, "candidate");
  assertNoCrossTreeSymlinkEscape(preparedPath, expectedCommit, input.candidateRepo, candidateCommit, input.id);
  git(preparedPath, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", input.candidateRepo, `${candidateCommit}:${candidatePrivateRef}`]);
  if (git(preparedPath, ["rev-parse", `${candidatePrivateRef}^{commit}`]) !== candidateCommit) throw new Error(`Candidate commit changed during preparation for ${input.id}.`);
  const mergeBase = git(preparedPath, ["merge-base", targetPrivateRef, candidatePrivateRef]);
  let status: PreparedMergeRepository["status"] = "ready";
  let desiredCommit: string | undefined;
  const identity = commitIdentity(preparedPath, expectedCommit);
  {
    try {
      if (input.method === "merge") runGitIn(preparedPath, ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "merge", "--no-edit", "--no-ff", "--no-commit", candidatePrivateRef]);
      else runGitIn(preparedPath, ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "merge", "--squash", candidatePrivateRef]);
    } catch {
      if (unmergedCount(preparedPath) === 0) throw new Error(`Git ${input.method} failed for ${input.id} without conflict state.`);
      status = "resolution_required";
    }
    if (status === "ready") {
      if (hasIndexChanges(preparedPath)) {
        runGitIn(preparedPath, ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "--no-verify", "-m", input.commitMessage]);
        desiredCommit = git(preparedPath, ["rev-parse", "HEAD"]);
      } else desiredCommit = expectedCommit;
    }
  }
  const conflicts = status === "resolution_required" ? conflictEvidence(preparedPath) : [];
  const overlapCount = conflicts.length;
  const mergeMessages = status === "resolution_required" ? boundedMergeMessages(preparedPath) : [];
  const provenance = sourceResolver?.(input.candidateRepo, candidateCommit) ?? {};
  return {
    id: input.id, candidateRepo: input.candidateRepo, candidateCommit, targetRepo: input.targetRepo, targetRef: input.targetRef,
    method: input.method, status, expectedCommit, ...(desiredCommit ? { desiredCommit } : {}), preparedPath, overlapCount, dependsOn: input.dependsOn,
    targetPrivateRef, candidatePrivateRef, mergeBase, ...(conflicts.length ? { conflicts } : {}), ...(mergeMessages.length ? { mergeMessages } : {}),
    ...(provenance.source ? { source: provenance.source } : {}), ...(provenance.warnings?.length ? { warnings: provenance.warnings } : {})
  };
}
function validateMergeInputs(inputs: WorkerMergeTestRepositoryInput[], targetRoot: string, operation: TrustedGitOperation) {
  if (inputs.length < 1 || inputs.length > 16) throw new Error("worker_merge_test requires 1 to 16 repositories.");
  const ids = new Set<string>();
  const targets = new Set<string>();
  const root = realpathSync(path.resolve(targetRoot));
  const normalized = inputs.map((item) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item.id) || ids.has(item.id)) throw new Error(`Invalid or duplicate repository id: ${item.id}.`);
    ids.add(item.id);
    if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(item.targetRef)) throw new Error(`Invalid targetRef for ${item.id}.`);
    if (!item.commitMessage || item.commitMessage.includes("\0") || Buffer.byteLength(item.commitMessage) > 16 * 1024) throw new Error(`Invalid commitMessage for ${item.id}.`);
    const dependsOn = item.dependsOn ?? [];
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Duplicate dependency for ${item.id}.`);
    const candidateRepo = canonicalRepository(item.candidateRepo, "candidateRepo", item.id, operation);
    const targetRepo = canonicalRepository(item.targetRepo, "targetRepo", item.id, operation);
    if (!strictlyWithin(root, targetRepo)) throw new Error(`Target repository ${targetRepo} is outside ${root}.`);
    const targetIdentity = realpathSync(git(targetRepo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    if (targets.has(targetIdentity)) throw new Error(`Physical target repository is duplicated: ${targetRepo}.`);
    targets.add(targetIdentity);
    return { ...item, candidateRepo, targetRepo, candidateRef: item.candidateRef ?? "HEAD", dependsOn: [...dependsOn] };
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
    const metadata = entry.slice(0, tab).split(" "); const file = entry.slice(tab + 1);
    if (metadata[0] === "160000") throw new Error(`${label} tree for ${id} contains an unsupported gitlink: ${file}.`);
    if (file.split("/").some((part) => part === ".git" || part === ".." || part === "")) throw new Error(`${label} tree for ${id} contains an unsafe path: ${file}.`);
  }
}
function canonicalRepository(value: string, field: string, id: string, operation: TrustedGitOperation): string {
  if (!value || Buffer.byteLength(value) > 4096) throw new Error(`${field} for ${id} is invalid.`);
  return trustedCanonicalRepository(value, true, operation);
}
function assertTargetClean(repo: string): void {
  if (git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") throw new Error(`Target repository is dirty: ${repo}.`);
}
function targetCheckoutPath(repo: string, targetRef: string): string | undefined {
  const records = runGit(["-C", repo, "worktree", "list", "--porcelain", "-z"]).split("\0");
  let worktree: string | undefined;
  for (const record of records) {
    if (record.startsWith("worktree ")) worktree = record.slice("worktree ".length);
    else if (record === `branch ${targetRef}` && worktree) return realpathSync(worktree);
    else if (record === "") worktree = undefined;
  }
  return undefined;
}
function commitIdentity(repo: string, commit: string): { name: string; email: string } {
  const value = runGit(["-C", repo, "show", "-s", "--format=%cn%x00%ce", commit]).trim();
  const [name, email] = value.split("\0");
  if (!name || !email || /[\r\n]/.test(name) || /[\r\n]/.test(email)) throw new Error("Target commit has no safe committer identity for prepared history.");
  return { name, email };
}
function unmergedCount(repo: string): number { return git(repo, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean).length; }
function hasIndexChanges(repo: string): boolean {
  try { runGitIn(repo, ["diff", "--cached", "--quiet"]); return false; } catch { return true; }
}
function git(repo: string, args: string[]): string { return runGit(["-C", repo, ...args]).trim(); }
function runGitIn(repo: string, args: string[]): string { return runGit(["-C", repo, ...args]); }
function runGit(args: string[]): string { return runTrustedGit(args); }
function gitSucceeds(repo: string, args: string[]): boolean { try { runGitIn(repo, args); return true; } catch { return false; } }
function treeEntries(repo: string, commit: string): Array<{ mode: string; path: string }> {
  return runGit(["-C", repo, "ls-tree", "-r", "-z", "--full-tree", commit]).split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t"); const meta = entry.slice(0, tab).split(" "); return { mode: meta[0]!, path: entry.slice(tab + 1) };
  });
}
function assertNoCrossTreeSymlinkEscape(targetRepo: string, targetCommit: string, candidateRepo: string, candidateCommit: string, id: string): void {
  const target = treeEntries(targetRepo, targetCommit); const candidate = treeEntries(candidateRepo, candidateCommit);
  for (const symlink of [...target, ...candidate].filter((entry) => entry.mode === "120000")) {
    if ([...target, ...candidate].some((entry) => entry.path.startsWith(`${symlink.path}/`))) throw new Error(`Repository ${id} has a cross-tree path below symlink ${symlink.path}.`);
  }
}
function conflictEvidence(repo: string): Array<{ path: string; status: string }> {
  return git(repo, ["status", "--porcelain=v1", "-z"]).split("\0").filter(Boolean).filter((line) => line.startsWith("UU ") || line.startsWith("AA ") || line.startsWith("DD ") || /^.U |^U. /.test(line)).slice(0, 256).map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
}
function boundedMergeMessages(repo: string): string[] {
  const gitDir = git(repo, ["rev-parse", "--path-format=absolute", "--git-dir"]); const files = ["MERGE_MSG", "SQUASH_MSG"];
  return files.flatMap((name) => { try { const text = readFileSync(path.join(gitDir, name), "utf8").slice(0, 4096).trim(); return text ? [text] : []; } catch { return []; } }).slice(0, 4);
}
function writeJson(file: string, value: unknown): void { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
function strictlyWithin(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
