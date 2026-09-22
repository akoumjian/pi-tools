import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { resolveExecutable } from "../_shared/executable.js";
import {
  createGitRunner,
  gitBuffer,
  gitText,
  repositoryPolicyIssues,
  runGit,
  runStandaloneGit,
  type RepositoryCandidate
} from "./repositories.js";

const PREPARED_FOLD_VERSION = 1;
const MAX_REPOSITORIES = 16;
const MAX_PATH_BYTES = 1024;
const MAX_PURPOSE_BYTES = 2000;
const MAX_CONFLICT_SUMMARY_BYTES = 4000;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const OID_PATTERN = /^[0-9a-f]{40,64}$/;
const CANDIDATE_ID_PATTERN = /^candidate_[0-9a-f]{24}$/;
const PREPARED_ID_PATTERN = /^prepared_[0-9a-f]{24}$/;
const TARGET_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,239}$/;

export type RepositoryFoldMethod = "merge" | "squash";

export type RepositoryChangeSetEntry = {
  candidateId: string;
  targetRepo: string;
  targetRef: string;
  purpose: string;
  method: RepositoryFoldMethod;
  dependsOn: string[];
};

export type RepositoryChangeSet = {
  repositories: RepositoryChangeSetEntry[];
};

export type ResolvedRepositoryCandidate = {
  candidate: RepositoryCandidate;
  workspaceRoot: string;
};

export type PreparedRepositoryFold = {
  candidateId: string;
  workerId: string;
  runId: string;
  workspaceRepo: string;
  candidateBaseCommit: string;
  candidateBaseTree: string;
  candidateHeadCommit: string;
  candidateHeadTree: string;
  candidateDirty: boolean;
  targetRepo: string;
  targetRef: string;
  targetExpectedCommit: string;
  targetExpectedTree: string;
  mergeBase: string;
  method: RepositoryFoldMethod;
  purpose: string;
  dependsOn: string[];
  status: "ready" | "resolution_required";
  desiredCommit?: string;
  desiredTree?: string;
  bundleFile: string;
  bundleSha256: string;
  viewPath: string;
};

export type FoldResolutionCase = {
  candidateId: string;
  targetRepo: string;
  targetRef: string;
  kind: "merge_conflict";
  summary: string;
};

export type PreparedWorkerFoldManifest = {
  version: typeof PREPARED_FOLD_VERSION;
  preparedId: string;
  manifestSha256: string;
  parentSessionFile: string;
  createdAt: string;
  status: "ready" | "resolution_required";
  order: string[];
  repositories: PreparedRepositoryFold[];
  overlaps: Array<{ targetRepo: string; candidateIds: string[]; pathCount: number }>;
  discrepancies: string[];
  resolutionCases: FoldResolutionCase[];
};

export type PreparedWorkerFoldSummary = {
  preparedId: string;
  manifestFile: string;
  manifestSha256: string;
  status: PreparedWorkerFoldManifest["status"];
  repositoryCount: number;
  resolutionCaseCount: number;
  overlapCount: number;
  repositories: Array<{
    candidateId: string;
    targetRepo: string;
    targetRef: string;
    method: RepositoryFoldMethod;
    status: PreparedRepositoryFold["status"];
    expectedCommit: string;
    desiredCommit?: string;
    viewPath: string;
  }>;
};

type PreparedManifestPayload = Omit<PreparedWorkerFoldManifest, "preparedId" | "manifestSha256">;

type TargetSnapshot = {
  targetRepo: string;
  targetRef: string;
  expectedCommit: string;
  expectedTree: string;
};

export function defaultWorkerFoldsRoot(stateRoot: string): string {
  return path.join(path.dirname(path.resolve(stateRoot)), "worker-folds");
}

export function prepareRepositoryChangeSet(input: {
  changeSet: RepositoryChangeSet;
  candidates: readonly ResolvedRepositoryCandidate[];
  parentSessionFile: string;
  foldsRoot: string;
  targetRoot: string;
  createdAt: string;
  gitPath?: string;
  isCancelled?: () => boolean;
}): { manifest: PreparedWorkerFoldManifest; summary: PreparedWorkerFoldSummary } {
  assertPreparationActive(input.isCancelled);
  const selections = validateChangeSet(input.changeSet);
  const order = dependencyOrder(selections);
  const candidateMap = new Map(input.candidates.map((item) => [item.candidate.candidateId, item]));
  for (const selection of selections) {
    if (!candidateMap.has(selection.candidateId)) throw new Error(`Unknown or unavailable worker repository candidate: ${selection.candidateId}`);
  }

  mkdirSync(input.foldsRoot, { recursive: true, mode: 0o700 });
  const foldsRoot = requireCanonicalDirectory(input.foldsRoot, "worker fold root");
  const targetRoot = requireCanonicalDirectory(input.targetRoot, "worker fold target root");
  const runner = createGitRunner(input.gitPath ?? resolveExecutable("git"), foldsRoot);
  const staging = path.join(foldsRoot, `.prepare-${process.pid}-${randomUUID()}`);
  mkdirSync(path.join(staging, "repositories"), { recursive: true, mode: 0o700 });

  const prepared: PreparedRepositoryFold[] = [];
  const resolutionCases: FoldResolutionCase[] = [];
  const overlaps: PreparedWorkerFoldManifest["overlaps"] = [];
  const snapshots: TargetSnapshot[] = [];
  try {
    for (let index = 0; index < order.length; index++) {
      assertPreparationActive(input.isCancelled);
      const candidateId = order[index]!;
      const selection = selections.find((item) => item.candidateId === candidateId)!;
      const resolved = candidateMap.get(candidateId)!;
      const candidate = revalidateCandidate(resolved, runner);
      const target = inspectTarget(selection, targetRoot, runner);
      if (snapshots.some((item) => item.targetRepo === target.targetRepo)) {
        throw new Error(`A prepared change set may select only one candidate per physical target repository: ${target.targetRepo}`);
      }
      snapshots.push(target);

      const repositoryDirectory = path.join(staging, "repositories", `${String(index + 1).padStart(2, "0")}-${candidateId}`);
      const viewDirectory = path.join(repositoryDirectory, "view");
      const bundleFile = path.join(repositoryDirectory, "candidate.bundle");
      const targetBundleFile = path.join(repositoryDirectory, "target.bundle");
      mkdirSync(repositoryDirectory, { recursive: true, mode: 0o700 });
      gitBuffer(runner, target.targetRepo, ["bundle", "create", targetBundleFile, target.targetRef]);
      if (statSync(targetBundleFile).size > MAX_BUNDLE_BYTES) throw new Error(`Target bundle exceeds ${MAX_BUNDLE_BYTES} bytes: ${target.targetRepo}`);
      runStandaloneGit(runner, repositoryDirectory, [
        "clone",
        "--no-checkout",
        "--no-tags",
        "--single-branch",
        "--branch",
        target.targetRef.slice("refs/heads/".length),
        targetBundleFile,
        viewDirectory
      ]);
      rmSync(targetBundleFile, { force: true });
      gitBuffer(runner, viewDirectory, ["reset", "--hard", target.expectedCommit]);

      gitBuffer(runner, candidate.repoPath, ["bundle", "create", bundleFile, "HEAD", `^${candidate.baseCommit}`]);
      const bundleSize = statSync(bundleFile).size;
      if (bundleSize > MAX_BUNDLE_BYTES) throw new Error(`Candidate bundle exceeds ${MAX_BUNDLE_BYTES} bytes: ${candidateId}`);
      const bundleSha256 = sha256(readFileSync(bundleFile));
      assertObject(viewDirectory, candidate.baseCommit, runner, `Candidate base is unavailable in target history: ${candidateId}`);
      gitBuffer(runner, viewDirectory, [
        "fetch",
        "--no-write-fetch-head",
        "--no-tags",
        "--no-recurse-submodules",
        bundleFile,
        "HEAD"
      ]);
      assertObject(viewDirectory, candidate.headCommit, runner, `Candidate head did not import into prepared view: ${candidateId}`);
      const mergeBase = gitText(runner, viewDirectory, ["merge-base", target.expectedCommit, candidate.headCommit]).trim();
      if (mergeBase !== candidate.baseCommit) {
        throw new Error(`Candidate base does not match the exact target merge base: ${candidateId}`);
      }
      const targetPaths = nulPaths(gitBuffer(runner, viewDirectory, ["diff", "--name-only", "-z", candidate.baseCommit, target.expectedCommit]));
      const candidatePaths = nulPaths(gitBuffer(runner, viewDirectory, ["diff", "--name-only", "-z", candidate.baseCommit, candidate.headCommit]));
      const targetPathSet = new Set(targetPaths);
      const overlapCount = candidatePaths.filter((item) => targetPathSet.has(item)).length;
      if (overlapCount > 0) overlaps.push({ targetRepo: target.targetRepo, candidateIds: [candidateId], pathCount: overlapCount });

      const merge = runGit(runner, viewDirectory, [
        "merge-tree",
        "--write-tree",
        "--messages",
        target.expectedCommit,
        candidate.headCommit
      ], { allowedStatuses: [0, 1] });
      const mergeOutput = decodeGitOutput(merge.stdout);
      const desiredTree = mergeOutput.split("\n", 1)[0]?.trim();
      if (!desiredTree || !OID_PATTERN.test(desiredTree)) throw new Error(`Git did not produce a bounded merge tree: ${candidateId}`);

      const relativeRoot = path.relative(staging, repositoryDirectory).split(path.sep).join("/");
      const record: PreparedRepositoryFold = {
        candidateId,
        workerId: candidate.workerId,
        runId: candidate.runId,
        workspaceRepo: candidate.workspaceRepo,
        candidateBaseCommit: candidate.baseCommit,
        candidateBaseTree: candidate.baseTree,
        candidateHeadCommit: candidate.headCommit,
        candidateHeadTree: candidate.headTree,
        candidateDirty: candidate.dirty,
        targetRepo: target.targetRepo,
        targetRef: target.targetRef,
        targetExpectedCommit: target.expectedCommit,
        targetExpectedTree: target.expectedTree,
        mergeBase,
        method: selection.method,
        purpose: selection.purpose,
        dependsOn: [...selection.dependsOn],
        status: merge.status === 0 ? "ready" : "resolution_required",
        bundleFile: `${relativeRoot}/candidate.bundle`,
        bundleSha256,
        viewPath: `${relativeRoot}/view`
      };

      if (merge.status === 0) {
        const commitArgs = ["commit-tree", desiredTree, "-p", target.expectedCommit];
        if (selection.method === "merge") commitArgs.push("-p", candidate.headCommit);
        commitArgs.push("-m", `Prepared ${selection.method} fold for ${candidateId}`);
        const desiredCommit = gitText(runner, viewDirectory, commitArgs, { deterministicCommitIdentity: true }).trim();
        if (!OID_PATTERN.test(desiredCommit)) throw new Error(`Git did not produce an exact desired commit: ${candidateId}`);
        const verifiedTree = gitText(runner, viewDirectory, ["rev-parse", `${desiredCommit}^{tree}`]).trim();
        if (verifiedTree !== desiredTree) throw new Error(`Prepared desired tree verification failed: ${candidateId}`);
        gitBuffer(runner, viewDirectory, ["reset", "--hard", desiredCommit]);
        record.desiredCommit = desiredCommit;
        record.desiredTree = desiredTree;
      } else {
        resolutionCases.push({
          candidateId,
          targetRepo: target.targetRepo,
          targetRef: target.targetRef,
          kind: "merge_conflict",
          summary: boundUtf8(mergeOutput, MAX_CONFLICT_SUMMARY_BYTES)
        });
      }
      prepared.push(record);
    }

    assertPreparationActive(input.isCancelled);
    for (const snapshot of snapshots) assertTargetUnchanged(snapshot, runner);
    for (const candidateId of order) revalidateCandidate(candidateMap.get(candidateId)!, runner);
    const payload: PreparedManifestPayload = {
      version: PREPARED_FOLD_VERSION,
      parentSessionFile: path.resolve(input.parentSessionFile),
      createdAt: input.createdAt,
      status: resolutionCases.length === 0 ? "ready" : "resolution_required",
      order,
      repositories: prepared,
      overlaps,
      discrepancies: [],
      resolutionCases
    };
    const manifestSha256 = sha256(Buffer.from(JSON.stringify(payload)));
    const preparedId = `prepared_${manifestSha256.slice(0, 24)}`;
    const manifest: PreparedWorkerFoldManifest = { ...payload, preparedId, manifestSha256 };
    if (!isPreparedWorkerFoldManifest(manifest)) throw new Error("Refusing to persist an invalid prepared worker fold manifest.");
    const manifestFile = path.join(staging, "manifest.json");
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    for (const repository of prepared) chmodSync(path.join(staging, repository.bundleFile), 0o400);
    chmodSync(manifestFile, 0o400);
    const finalDirectory = path.join(foldsRoot, preparedId);
    if (existsSync(finalDirectory)) throw new Error(`Prepared worker fold already exists: ${preparedId}`);
    renameSync(staging, finalDirectory);
    const finalManifestFile = path.join(finalDirectory, "manifest.json");
    return { manifest, summary: summarizePreparedFold(manifest, finalManifestFile) };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function readPreparedWorkerFold(
  foldsRoot: string,
  preparedId: string,
  expectedParentSessionFile?: string
): PreparedWorkerFoldManifest {
  if (!PREPARED_ID_PATTERN.test(preparedId)) throw new Error(`Invalid prepared worker fold ID: ${preparedId}`);
  const root = requireCanonicalDirectory(foldsRoot, "worker fold root");
  const directory = path.join(root, preparedId);
  const directoryMetadata = lstatSync(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || realpathSync(directory) !== directory) {
    throw new Error("Prepared worker fold directory is invalid.");
  }
  if ((directoryMetadata.mode & 0o077) !== 0) throw new Error("Prepared worker fold directory permissions are too broad.");
  const manifestFile = path.join(directory, "manifest.json");
  const metadata = lstatSync(manifestFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MANIFEST_BYTES) throw new Error("Prepared worker fold manifest is not a bounded regular file.");
  if ((metadata.mode & 0o077) !== 0 || (metadata.mode & 0o222) !== 0) throw new Error("Prepared worker fold manifest permissions are not immutable owner-only.");
  const parsed: unknown = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (!isPreparedWorkerFoldManifest(parsed)) throw new Error("Prepared worker fold manifest failed validation.");
  if (expectedParentSessionFile && path.resolve(parsed.parentSessionFile) !== path.resolve(expectedParentSessionFile)) {
    throw new Error(`Prepared worker fold ${preparedId} belongs to a different parent session.`);
  }
  const payload = manifestPayload(parsed);
  if (sha256(Buffer.from(JSON.stringify(payload))) !== parsed.manifestSha256) {
    throw new Error("Prepared worker fold manifest hash mismatch.");
  }
  if (`prepared_${parsed.manifestSha256.slice(0, 24)}` !== parsed.preparedId) {
    throw new Error("Prepared worker fold identity mismatch.");
  }
  const runner = createGitRunner(resolveExecutable("git"), root);
  for (const repository of parsed.repositories) {
    for (const relative of [repository.bundleFile, repository.viewPath]) {
      const resolved = path.resolve(directory, relative);
      if (!isWithin(directory, resolved) || !existsSync(resolved)) throw new Error("Prepared worker fold artifact is missing or escapes its directory.");
    }
    const bundle = path.resolve(directory, repository.bundleFile);
    const bundleMetadata = lstatSync(bundle);
    const repositoryDirectory = path.dirname(bundle);
    if (realpathSync(repositoryDirectory) !== repositoryDirectory) throw new Error("Prepared worker fold repository directory is invalid.");
    if (!bundleMetadata.isFile() || bundleMetadata.isSymbolicLink() || (bundleMetadata.mode & 0o077) !== 0 || (bundleMetadata.mode & 0o222) !== 0 || bundleMetadata.size > MAX_BUNDLE_BYTES || sha256(readFileSync(bundle)) !== repository.bundleSha256) {
      throw new Error("Prepared worker fold candidate bundle hash mismatch.");
    }
    const view = path.resolve(directory, repository.viewPath);
    const viewMetadata = lstatSync(view);
    if (!viewMetadata.isDirectory() || viewMetadata.isSymbolicLink() || realpathSync(view) !== view) {
      throw new Error("Prepared worker fold review view is invalid.");
    }
    if (repositoryPolicyIssues(view, runner).length > 0) throw new Error("Prepared worker fold review view has unsupported Git policy.");
    const expectedHead = repository.desiredCommit ?? repository.targetExpectedCommit;
    const head = gitText(runner, view, ["rev-parse", "HEAD^{commit}"]).trim();
    const tree = gitText(runner, view, ["rev-parse", "HEAD^{tree}"]).trim();
    const expectedTree = repository.desiredTree ?? repository.targetExpectedTree;
    const dirty = gitBuffer(runner, view, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "-z"]);
    if (head !== expectedHead || tree !== expectedTree || dirty.byteLength > 0) throw new Error("Prepared worker fold review view identity mismatch.");
  }
  return parsed;
}

function revalidateCandidate(resolved: ResolvedRepositoryCandidate, runner: ReturnType<typeof createGitRunner>): {
  repoPath: string;
  workerId: string;
  runId: string;
  workspaceRepo: string;
  baseCommit: string;
  baseTree: string;
  headCommit: string;
  headTree: string;
  dirty: boolean;
} {
  const candidate = resolved.candidate;
  if (!candidate.foldable || !candidate.baseCommit || !candidate.baseTree || !candidate.headCommit || !candidate.headTree) {
    throw new Error(`Worker repository candidate is not foldable: ${candidate.candidateId}`);
  }
  const workspaceRoot = requireCanonicalDirectory(resolved.workspaceRoot, "candidate workspace");
  const repoPath = path.resolve(workspaceRoot, candidate.workspaceRepo);
  if (!isWithin(workspaceRoot, repoPath) || !existsSync(repoPath) || realpathSync(repoPath) !== repoPath) {
    throw new Error(`Worker repository candidate path is stale: ${candidate.candidateId}`);
  }
  const policyIssues = repositoryPolicyIssues(repoPath, runner);
  if (policyIssues.length > 0) throw new Error(`Worker repository candidate policy changed: ${candidate.candidateId}`);
  const headCommit = gitText(runner, repoPath, ["rev-parse", "HEAD^{commit}"]).trim();
  const headTree = gitText(runner, repoPath, ["rev-parse", "HEAD^{tree}"]).trim();
  const baseTree = gitText(runner, repoPath, ["rev-parse", `${candidate.baseCommit}^{tree}`]).trim();
  const dirty = gitBuffer(runner, repoPath, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "-z"]).byteLength > 0;
  if (headCommit !== candidate.headCommit || headTree !== candidate.headTree || baseTree !== candidate.baseTree || dirty !== candidate.dirty) {
    throw new Error(`Worker repository candidate identity moved after handoff: ${candidate.candidateId}`);
  }
  gitBuffer(runner, repoPath, ["merge-base", "--is-ancestor", candidate.baseCommit, candidate.headCommit]);
  return {
    repoPath,
    workerId: candidate.workerId,
    runId: candidate.runId,
    workspaceRepo: candidate.workspaceRepo,
    baseCommit: candidate.baseCommit,
    baseTree: candidate.baseTree,
    headCommit,
    headTree,
    dirty
  };
}

function inspectTarget(
  selection: RepositoryChangeSetEntry,
  targetRoot: string,
  runner: ReturnType<typeof createGitRunner>
): TargetSnapshot {
  if (!path.isAbsolute(selection.targetRepo)) throw new Error(`Target repository path must be absolute: ${selection.targetRepo}`);
  const requested = path.resolve(selection.targetRepo);
  if (!existsSync(requested)) throw new Error(`Target repository does not exist: ${selection.targetRepo}`);
  const targetRepo = requireCanonicalDirectory(requested, "target repository");
  if (targetRepo === targetRoot || !isWithin(targetRoot, targetRepo)) {
    throw new Error(`Target repository must be below the configured local target root: ${selection.targetRepo}`);
  }
  if (!existsSync(path.join(targetRepo, ".git"))) throw new Error(`Target path is not a Git repository: ${selection.targetRepo}`);
  const policyIssues = repositoryPolicyIssues(targetRepo, runner);
  if (policyIssues.length > 0) throw new Error(`Target repository has unsupported Git policy: ${policyIssues.join(",")}`);
  if (gitBuffer(runner, targetRepo, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]).byteLength > 0) {
    throw new Error(`Target repository is dirty: ${targetRepo}`);
  }
  const worktrees = gitText(runner, targetRepo, ["worktree", "list", "--porcelain", "-z"])
    .split("\0")
    .filter((line) => line.startsWith("worktree "));
  if (worktrees.length !== 1) throw new Error(`Target repository has linked worktrees: ${targetRepo}`);
  const expectedCommit = gitText(runner, targetRepo, ["show-ref", "--verify", "--hash", selection.targetRef]).trim();
  if (!OID_PATTERN.test(expectedCommit)) throw new Error(`Target ref does not resolve to an exact commit: ${selection.targetRef}`);
  const commit = gitText(runner, targetRepo, ["rev-parse", `${selection.targetRef}^{commit}`]).trim();
  if (commit !== expectedCommit) throw new Error(`Target ref is not a direct commit ref: ${selection.targetRef}`);
  const expectedTree = gitText(runner, targetRepo, ["rev-parse", `${expectedCommit}^{tree}`]).trim();
  return { targetRepo, targetRef: selection.targetRef, expectedCommit, expectedTree };
}

function assertTargetUnchanged(snapshot: TargetSnapshot, runner: ReturnType<typeof createGitRunner>): void {
  const current = gitText(runner, snapshot.targetRepo, ["show-ref", "--verify", "--hash", snapshot.targetRef]).trim();
  const tree = gitText(runner, snapshot.targetRepo, ["rev-parse", `${current}^{tree}`]).trim();
  const status = gitBuffer(runner, snapshot.targetRepo, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  if (current !== snapshot.expectedCommit || tree !== snapshot.expectedTree || status.byteLength > 0) {
    throw new Error(`Target repository changed during preparation: ${snapshot.targetRepo}`);
  }
}

function assertPreparationActive(isCancelled: (() => boolean) | undefined): void {
  if (isCancelled?.()) throw new Error("Worker fold preparation was cancelled.");
}

function validateChangeSet(changeSet: RepositoryChangeSet): RepositoryChangeSetEntry[] {
  if (!isRecord(changeSet) || !hasOnlyKeys(changeSet, ["repositories"]) || !Array.isArray(changeSet.repositories) || changeSet.repositories.length < 1 || changeSet.repositories.length > MAX_REPOSITORIES) {
    throw new Error(`RepositoryChangeSet must contain 1..${MAX_REPOSITORIES} repositories.`);
  }
  const ids = new Set<string>();
  return changeSet.repositories.map((value) => {
    if (!isRecord(value) || Object.keys(value).some((key) => !["candidateId", "targetRepo", "targetRef", "purpose", "method", "dependsOn"].includes(key))) {
      throw new Error("RepositoryChangeSet contains an invalid repository mapping.");
    }
    if (typeof value.candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(value.candidateId) || ids.has(value.candidateId)) {
      throw new Error("RepositoryChangeSet candidate IDs must be unique canonical candidate IDs.");
    }
    ids.add(value.candidateId);
    if (typeof value.targetRepo !== "string" || Buffer.byteLength(value.targetRepo, "utf8") > MAX_PATH_BYTES) throw new Error("RepositoryChangeSet targetRepo is invalid.");
    if (typeof value.targetRef !== "string" || !TARGET_REF_PATTERN.test(value.targetRef) || value.targetRef.includes("..") || value.targetRef.endsWith(".")) {
      throw new Error("RepositoryChangeSet targetRef must be a canonical refs/heads/... ref.");
    }
    if (typeof value.purpose !== "string" || !value.purpose.trim() || Buffer.byteLength(value.purpose, "utf8") > MAX_PURPOSE_BYTES) throw new Error("RepositoryChangeSet purpose is invalid.");
    if (value.method !== "merge" && value.method !== "squash") throw new Error("RepositoryChangeSet method must be merge or squash.");
    if (!Array.isArray(value.dependsOn) || value.dependsOn.length > MAX_REPOSITORIES || value.dependsOn.some((item) => typeof item !== "string" || !CANDIDATE_ID_PATTERN.test(item))) {
      throw new Error("RepositoryChangeSet dependsOn is invalid.");
    }
    if (new Set(value.dependsOn).size !== value.dependsOn.length || value.dependsOn.includes(value.candidateId)) throw new Error("RepositoryChangeSet dependencies must be unique and may not self-reference.");
    return {
      candidateId: value.candidateId,
      targetRepo: value.targetRepo,
      targetRef: value.targetRef,
      purpose: value.purpose,
      method: value.method,
      dependsOn: [...value.dependsOn]
    };
  });
}

function dependencyOrder(selections: readonly RepositoryChangeSetEntry[]): string[] {
  const byId = new Map(selections.map((item) => [item.candidateId, item]));
  for (const selection of selections) {
    for (const dependency of selection.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`RepositoryChangeSet dependency is not selected: ${dependency}`);
    }
  }
  const remaining = new Map(selections.map((item) => [item.candidateId, new Set(item.dependsOn)]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id).sort();
    if (ready.length === 0) throw new Error("RepositoryChangeSet dependency graph contains a cycle.");
    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  return order;
}

function summarizePreparedFold(manifest: PreparedWorkerFoldManifest, manifestFile: string): PreparedWorkerFoldSummary {
  const directory = path.dirname(manifestFile);
  return {
    preparedId: manifest.preparedId,
    manifestFile,
    manifestSha256: manifest.manifestSha256,
    status: manifest.status,
    repositoryCount: manifest.repositories.length,
    resolutionCaseCount: manifest.resolutionCases.length,
    overlapCount: manifest.overlaps.length,
    repositories: manifest.repositories.map((item) => ({
      candidateId: item.candidateId,
      targetRepo: item.targetRepo,
      targetRef: item.targetRef,
      method: item.method,
      status: item.status,
      expectedCommit: item.targetExpectedCommit,
      desiredCommit: item.desiredCommit,
      viewPath: path.join(directory, item.viewPath)
    }))
  };
}

function manifestPayload(manifest: PreparedWorkerFoldManifest): PreparedManifestPayload {
  const { preparedId: _preparedId, manifestSha256: _manifestSha256, ...payload } = manifest;
  return payload;
}

function isPreparedWorkerFoldManifest(value: unknown): value is PreparedWorkerFoldManifest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "preparedId", "manifestSha256", "parentSessionFile", "createdAt", "status", "order", "repositories", "overlaps", "discrepancies", "resolutionCases"]) || value.version !== PREPARED_FOLD_VERSION || typeof value.preparedId !== "string" || !PREPARED_ID_PATTERN.test(value.preparedId) ||
      typeof value.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.manifestSha256) || typeof value.parentSessionFile !== "string" ||
      !path.isAbsolute(value.parentSessionFile) || Buffer.byteLength(value.parentSessionFile, "utf8") > 4096 || typeof value.createdAt !== "string" || value.createdAt.length > 128 || Number.isNaN(Date.parse(value.createdAt)) ||
      (value.status !== "ready" && value.status !== "resolution_required") ||
      !Array.isArray(value.order) || !Array.isArray(value.repositories) || value.repositories.length < 1 || value.repositories.length > MAX_REPOSITORIES ||
      !Array.isArray(value.overlaps) || !Array.isArray(value.discrepancies) || !Array.isArray(value.resolutionCases)) return false;
  const order = value.order as unknown[];
  const repositories = value.repositories as unknown[];
  const overlaps = value.overlaps as unknown[];
  const discrepancies = value.discrepancies as unknown[];
  const resolutionCases = value.resolutionCases as unknown[];
  if (order.length !== repositories.length || order.some((item) => typeof item !== "string" || !CANDIDATE_ID_PATTERN.test(item))) return false;
  if (new Set(order).size !== order.length) return false;
  if (overlaps.length > MAX_REPOSITORIES || discrepancies.length > 64 || resolutionCases.length > MAX_REPOSITORIES) return false;
  if (!overlaps.every(isPreparedOverlap) || discrepancies.some((item) => typeof item !== "string" || Buffer.byteLength(item, "utf8") > 512)) return false;
  if (!repositories.every(isPreparedRepositoryFold) || !resolutionCases.every(isResolutionCase)) return false;
  const preparedRepositories = repositories as PreparedRepositoryFold[];
  const cases = resolutionCases as FoldResolutionCase[];
  if (new Set(preparedRepositories.map((item) => item.candidateId)).size !== preparedRepositories.length || new Set(preparedRepositories.map((item) => item.targetRepo)).size !== preparedRepositories.length) return false;
  if (preparedRepositories.some((item) => !order.includes(item.candidateId))) return false;
  const requiredResolutionIds = preparedRepositories.filter((item) => item.status === "resolution_required").map((item) => item.candidateId).sort();
  if (JSON.stringify(requiredResolutionIds) !== JSON.stringify(cases.map((item) => item.candidateId).sort())) return false;
  return value.status === (cases.length === 0 ? "ready" : "resolution_required");
}

function isPreparedRepositoryFold(value: unknown): value is PreparedRepositoryFold {
  if (!isRecord(value) || !hasOnlyKeys(value, ["candidateId", "workerId", "runId", "workspaceRepo", "candidateBaseCommit", "candidateBaseTree", "candidateHeadCommit", "candidateHeadTree", "candidateDirty", "targetRepo", "targetRef", "targetExpectedCommit", "targetExpectedTree", "mergeBase", "method", "purpose", "dependsOn", "status", "desiredCommit", "desiredTree", "bundleFile", "bundleSha256", "viewPath"])) return false;
  const keys = ["candidateBaseCommit", "candidateBaseTree", "candidateHeadCommit", "candidateHeadTree", "targetExpectedCommit", "targetExpectedTree", "mergeBase"];
  if (keys.some((key) => typeof value[key] !== "string" || !OID_PATTERN.test(value[key] as string))) return false;
  if (typeof value.candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(value.candidateId) || typeof value.workerId !== "string" || !/^worker_[A-Za-z0-9_-]{1,120}$/.test(value.workerId) ||
      typeof value.runId !== "string" || !/^run_[A-Za-z0-9_-]{1,120}$/.test(value.runId) || typeof value.workspaceRepo !== "string" || !safeRelative(value.workspaceRepo) || typeof value.candidateDirty !== "boolean" ||
      typeof value.targetRepo !== "string" || !path.isAbsolute(value.targetRepo) || Buffer.byteLength(value.targetRepo, "utf8") > MAX_PATH_BYTES ||
      typeof value.targetRef !== "string" || !TARGET_REF_PATTERN.test(value.targetRef) || (value.method !== "merge" && value.method !== "squash") ||
      typeof value.purpose !== "string" || !value.purpose || Buffer.byteLength(value.purpose, "utf8") > MAX_PURPOSE_BYTES ||
      !Array.isArray(value.dependsOn) || value.dependsOn.length > MAX_REPOSITORIES || value.dependsOn.some((item) => typeof item !== "string" || !CANDIDATE_ID_PATTERN.test(item)) ||
      new Set(value.dependsOn).size !== value.dependsOn.length || value.dependsOn.includes(value.candidateId) ||
      (value.status !== "ready" && value.status !== "resolution_required") || typeof value.bundleFile !== "string" || !safeRelative(value.bundleFile) ||
      typeof value.bundleSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.bundleSha256) || typeof value.viewPath !== "string" || !safeRelative(value.viewPath)) return false;
  if (value.status === "ready") return typeof value.desiredCommit === "string" && OID_PATTERN.test(value.desiredCommit) && typeof value.desiredTree === "string" && OID_PATTERN.test(value.desiredTree);
  return value.desiredCommit === undefined && value.desiredTree === undefined;
}

function isPreparedOverlap(value: unknown): value is { targetRepo: string; candidateIds: string[]; pathCount: number } {
  if (!isRecord(value) || !hasOnlyKeys(value, ["targetRepo", "candidateIds", "pathCount"]) ||
      typeof value.targetRepo !== "string" || !path.isAbsolute(value.targetRepo) || Buffer.byteLength(value.targetRepo, "utf8") > MAX_PATH_BYTES ||
      !Array.isArray(value.candidateIds) || value.candidateIds.length < 1 || value.candidateIds.length > MAX_REPOSITORIES ||
      typeof value.pathCount !== "number" || !Number.isInteger(value.pathCount) || value.pathCount < 1 || value.pathCount > 1_000_000) return false;
  return value.candidateIds.every((item) => typeof item === "string" && CANDIDATE_ID_PATTERN.test(item)) && new Set(value.candidateIds).size === value.candidateIds.length;
}

function isResolutionCase(value: unknown): value is FoldResolutionCase {
  return isRecord(value) && hasOnlyKeys(value, ["candidateId", "targetRepo", "targetRef", "kind", "summary"]) && typeof value.candidateId === "string" && CANDIDATE_ID_PATTERN.test(value.candidateId) &&
    typeof value.targetRepo === "string" && path.isAbsolute(value.targetRepo) && typeof value.targetRef === "string" &&
    TARGET_REF_PATTERN.test(value.targetRef) && value.kind === "merge_conflict" && typeof value.summary === "string" && value.summary.length > 0 &&
    Buffer.byteLength(value.summary, "utf8") <= MAX_CONFLICT_SUMMARY_BYTES;
}

function assertObject(repoPath: string, oid: string, runner: ReturnType<typeof createGitRunner>, message: string): void {
  try {
    gitBuffer(runner, repoPath, ["cat-file", "-e", `${oid}^{commit}`]);
  } catch {
    throw new Error(message);
  }
}

function requireCanonicalDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  const canonical = realpathSync(resolved);
  if (canonical !== resolved) throw new Error(`${label} must use its canonical path.`);
  return canonical;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRelative(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !path.normalize(value).startsWith("..") && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES;
}

function nulPaths(output: Buffer): string[] {
  const text = decodeGitOutput(output);
  return text.split("\0").filter(Boolean);
}

function decodeGitOutput(output: Buffer): string {
  const text = output.toString("utf8");
  if (text.includes("\uFFFD")) throw new Error("git_output_not_utf8");
  return text;
}

function boundUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value.replace(/[\r\n]+/g, " ").trim(), "utf8");
  if (buffer.byteLength <= maxBytes) return buffer.toString("utf8");
  return buffer.subarray(0, Math.max(0, maxBytes - 3)).toString("utf8").replace(/\uFFFD+$/g, "") + "...";
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
