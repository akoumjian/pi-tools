import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
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
  isRepositoryInventory,
  repositoryCandidateId,
  repositoryDirty,
  repositoryPolicyIssues,
  repositoryTreePolicyIssues,
  runGit,
  runStandaloneGit,
  type ReportedRepositoryIssue,
  type RepositoryCandidate,
  type RepositoryScanCoverage
} from "./repositories.js";

const PREPARED_FOLD_VERSION = 1;
const MAX_REPOSITORIES = 16;
const MAX_PATH_BYTES = 1024;
const MAX_PURPOSE_BYTES = 2000;
const MAX_CONFLICT_SUMMARY_BYTES = 4000;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_BUNDLE_HEADER_BYTES = 64 * 1024;
const OID_PATTERN = /^[0-9a-f]{40,64}$/;
const CANDIDATE_ID_PATTERN = /^candidate_[0-9a-f]{24}$/;
const PREPARED_ID_PATTERN = /^prepared_[0-9a-f]{24}$/;
const TARGET_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,239}$/;
const ARTIFACT_REFS = {
  target: "refs/worker-fold/target",
  candidate: "refs/worker-fold/candidate",
  desired: "refs/worker-fold/desired"
} as const;

export type RepositoryFoldMethod = "merge" | "squash";

export type RepositoryChangeSetEntry = {
  candidateId: string;
  targetRepo: string;
  targetRef: string;
  purpose: string;
  method: RepositoryFoldMethod;
  dependsOn: string[];
};

export type RepositoryChangeSet = { repositories: RepositoryChangeSetEntry[] };

export type CandidateInventoryProvenance = {
  inventoryFile: string;
  inventorySha256: string;
  reportedIssues: ReportedRepositoryIssue[];
  scanCoverage: RepositoryScanCoverage;
};

export type ResolvedRepositoryCandidate = {
  candidate: RepositoryCandidate;
  workspaceRoot: string;
  inventory: CandidateInventoryProvenance;
};

export type PreparedObjectArtifact = {
  file: string;
  sha256: string;
  heads: {
    target: { ref: typeof ARTIFACT_REFS.target; oid: string };
    candidate: { ref: typeof ARTIFACT_REFS.candidate; oid: string };
    desired?: { ref: typeof ARTIFACT_REFS.desired; oid: string };
  };
  prerequisites: string[];
};

export type PreparedRepositoryFold = {
  candidateId: string;
  workerId: string;
  runId: string;
  workspaceRepo: string;
  candidateReported: boolean;
  candidateSource?: string;
  candidateBaseCommit: string;
  candidateBaseTree: string;
  candidateHeadCommit: string;
  candidateHeadTree: string;
  candidateDirty: boolean;
  candidateInventory: CandidateInventoryProvenance;
  targetRepo: string;
  targetRef: string;
  targetGitDevice: string;
  targetGitInode: string;
  targetExpectedCommit: string;
  targetExpectedTree: string;
  mergeBase: string;
  method: RepositoryFoldMethod;
  purpose: string;
  dependsOn: string[];
  status: "ready" | "resolution_required";
  desiredCommit?: string;
  desiredTree?: string;
  artifact: PreparedObjectArtifact;
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
    artifactFile: string;
    viewPath: string;
  }>;
};

type PreparedManifestPayload = Omit<PreparedWorkerFoldManifest, "preparedId" | "manifestSha256">;
type TargetSnapshot = {
  targetRepo: string;
  targetRef: string;
  gitDevice: string;
  gitInode: string;
  expectedCommit: string;
  expectedTree: string;
};
type CandidateSnapshot = ReturnType<typeof revalidateCandidate>;
type BundleEvidence = { heads: Map<string, string>; prerequisites: string[] };

type PrepareTestHooks = {
  afterTargetReset?(viewPath: string): void;
  beforeCandidateSourceBundle?(repoPath: string): void;
  afterCandidateSourceBundle?(repoPath: string): void;
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
  testHooks?: PrepareTestHooks;
}): { manifest: PreparedWorkerFoldManifest; summary: PreparedWorkerFoldSummary } {
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
  const targetSnapshots: TargetSnapshot[] = [];
  const physicalTargets = new Set<string>();
  try {
    for (let index = 0; index < order.length; index++) {
      const candidateId = order[index]!;
      const selection = selections.find((item) => item.candidateId === candidateId)!;
      const resolved = candidateMap.get(candidateId)!;
      const candidate = revalidateCandidate(resolved, runner);
      const target = inspectTarget(selection, targetRoot, runner);
      const physicalTarget = `${target.gitDevice}:${target.gitInode}`;
      if (physicalTargets.has(physicalTarget)) {
        throw new Error(`A prepared change set may select only one candidate per physical target repository: ${target.targetRepo}`);
      }
      physicalTargets.add(physicalTarget);
      targetSnapshots.push(target);

      const relativeRoot = `repositories/${String(index + 1).padStart(2, "0")}-${candidateId}`;
      const repositoryDirectory = path.join(staging, relativeRoot);
      const viewDirectory = path.join(repositoryDirectory, "view");
      const targetSourceBundle = path.join(repositoryDirectory, "target-source.bundle");
      const candidateSourceBundle = path.join(repositoryDirectory, "candidate-source.bundle");
      const artifactFile = path.join(repositoryDirectory, "prepared-objects.bundle");
      const inventoryArtifactFile = path.join(repositoryDirectory, "candidate-inventory.json");
      mkdirSync(repositoryDirectory, { recursive: true, mode: 0o700 });
      const preparedInventory = persistInventoryProvenance(resolved.inventory, inventoryArtifactFile, `${relativeRoot}/candidate-inventory.json`);

      gitBuffer(runner, target.targetRepo, ["bundle", "create", targetSourceBundle, target.targetRef]);
      assertBoundedRegularFile(targetSourceBundle, "Target source bundle");
      verifyBundle(runner, target.targetRepo, targetSourceBundle);
      runStandaloneGit(runner, repositoryDirectory, [
        "clone", "--no-checkout", "--no-tags", "--single-branch",
        `--template=${runner.templateDir}`,
        "--branch", target.targetRef.slice("refs/heads/".length),
        targetSourceBundle, viewDirectory
      ]);
      rmSync(targetSourceBundle, { force: true });
      assertObject(viewDirectory, target.expectedCommit, runner, `Exact target commit did not import into prepared view: ${candidateId}`);
      gitBuffer(runner, viewDirectory, ["reset", "--hard", target.expectedCommit]);
      input.testHooks?.afterTargetReset?.(viewDirectory);
      assertViewPolicy(viewDirectory, target.expectedCommit, runner, `target ${candidateId}`);

      input.testHooks?.beforeCandidateSourceBundle?.(candidate.repoPath);
      gitBuffer(runner, candidate.repoPath, ["bundle", "create", candidateSourceBundle, "--all", "HEAD"]);
      input.testHooks?.afterCandidateSourceBundle?.(candidate.repoPath);
      assertBoundedRegularFile(candidateSourceBundle, "Candidate source bundle");
      const candidateSource = verifyBundle(runner, candidate.repoPath, candidateSourceBundle);
      const sourceRefspecs = [...candidateSource.heads.keys()].sort().map((ref, sourceIndex) => `${ref}:refs/worker-fold/source/${sourceIndex}`);
      if (sourceRefspecs.length === 0) throw new Error(`Candidate source bundle advertises no heads: ${candidateId}`);
      gitBuffer(runner, viewDirectory, ["fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", candidateSourceBundle, ...sourceRefspecs]);
      rmSync(candidateSourceBundle, { force: true });
      assertObject(viewDirectory, candidate.headCommit, runner, `Exact candidate head did not import into prepared view: ${candidateId}`);
      assertObject(viewDirectory, candidate.baseCommit, runner, `Candidate base is unavailable in target history: ${candidateId}`);

      const mergeBase = gitText(runner, viewDirectory, ["merge-base", target.expectedCommit, candidate.headCommit]).trim();
      if (mergeBase !== candidate.baseCommit) throw new Error(`Candidate base does not match the exact target merge base: ${candidateId}`);
      const targetPaths = nulPaths(gitBuffer(runner, viewDirectory, ["diff", "--name-only", "-z", candidate.baseCommit, target.expectedCommit]));
      const candidatePaths = nulPaths(gitBuffer(runner, viewDirectory, ["diff", "--name-only", "-z", candidate.baseCommit, candidate.headCommit]));
      const targetPathSet = new Set(targetPaths);
      const overlapCount = candidatePaths.filter((item) => targetPathSet.has(item)).length;
      if (overlapCount > 0) overlaps.push({ targetRepo: target.targetRepo, candidateIds: [candidateId], pathCount: overlapCount });

      const merge = runGit(runner, viewDirectory, ["merge-tree", "--write-tree", "--messages", target.expectedCommit, candidate.headCommit], { allowedStatuses: [0, 1] });
      const mergeOutput = decodeGitOutput(merge.stdout);
      const desiredTree = mergeOutput.split("\n", 1)[0]?.trim();
      if (!desiredTree || !OID_PATTERN.test(desiredTree)) throw new Error(`Git did not produce a bounded merge tree: ${candidateId}`);

      let desiredCommit: string | undefined;
      if (merge.status === 0) {
        const commitArgs = ["commit-tree", desiredTree, "-p", target.expectedCommit];
        if (selection.method === "merge") commitArgs.push("-p", candidate.headCommit);
        commitArgs.push("-m", syntheticCommitMessage(selection, candidate));
        desiredCommit = gitText(runner, viewDirectory, commitArgs, { deterministicCommitIdentity: true }).trim();
        if (!OID_PATTERN.test(desiredCommit)) throw new Error(`Git did not produce an exact desired commit: ${candidateId}`);
        const verifiedTree = gitText(runner, viewDirectory, ["rev-parse", `${desiredCommit}^{tree}`]).trim();
        if (verifiedTree !== desiredTree) throw new Error(`Prepared desired tree verification failed: ${candidateId}`);
        gitBuffer(runner, viewDirectory, ["reset", "--hard", desiredCommit]);
        assertViewPolicy(viewDirectory, desiredCommit, runner, `desired ${candidateId}`);
      } else {
        resolutionCases.push({ candidateId, targetRepo: target.targetRepo, targetRef: target.targetRef, kind: "merge_conflict", summary: boundUtf8(mergeOutput, MAX_CONFLICT_SUMMARY_BYTES) });
      }

      gitBuffer(runner, viewDirectory, ["update-ref", ARTIFACT_REFS.target, target.expectedCommit]);
      gitBuffer(runner, viewDirectory, ["update-ref", ARTIFACT_REFS.candidate, candidate.headCommit]);
      if (desiredCommit) gitBuffer(runner, viewDirectory, ["update-ref", ARTIFACT_REFS.desired, desiredCommit]);
      const artifactRefs = [ARTIFACT_REFS.target, ARTIFACT_REFS.candidate, ...(desiredCommit ? [ARTIFACT_REFS.desired] : [])];
      gitBuffer(runner, viewDirectory, ["bundle", "create", artifactFile, ...artifactRefs]);
      assertBoundedRegularFile(artifactFile, "Prepared object artifact");
      const expectedHeads = new Map<string, string>([
        [ARTIFACT_REFS.target, target.expectedCommit],
        [ARTIFACT_REFS.candidate, candidate.headCommit],
        ...(desiredCommit ? [[ARTIFACT_REFS.desired, desiredCommit] as [string, string]] : [])
      ]);
      const artifactEvidence = verifyBundle(runner, viewDirectory, artifactFile, expectedHeads, []);
      const artifactSha256 = sha256(readFileSync(artifactFile));
      fsyncPath(artifactFile);
      chmodSync(artifactFile, 0o400);
      fsyncPath(artifactFile);

      prepared.push({
        candidateId,
        workerId: candidate.workerId,
        runId: candidate.runId,
        workspaceRepo: candidate.workspaceRepo,
        candidateReported: candidate.reported,
        candidateSource: candidate.source,
        candidateBaseCommit: candidate.baseCommit,
        candidateBaseTree: candidate.baseTree,
        candidateHeadCommit: candidate.headCommit,
        candidateHeadTree: candidate.headTree,
        candidateDirty: candidate.dirty,
        candidateInventory: preparedInventory,
        targetRepo: target.targetRepo,
        targetRef: target.targetRef,
        targetGitDevice: target.gitDevice,
        targetGitInode: target.gitInode,
        targetExpectedCommit: target.expectedCommit,
        targetExpectedTree: target.expectedTree,
        mergeBase,
        method: selection.method,
        purpose: selection.purpose,
        dependsOn: [...selection.dependsOn],
        status: desiredCommit ? "ready" : "resolution_required",
        desiredCommit,
        desiredTree: desiredCommit ? desiredTree : undefined,
        artifact: {
          file: `${relativeRoot}/prepared-objects.bundle`,
          sha256: artifactSha256,
          heads: {
            target: { ref: ARTIFACT_REFS.target, oid: target.expectedCommit },
            candidate: { ref: ARTIFACT_REFS.candidate, oid: candidate.headCommit },
            desired: desiredCommit ? { ref: ARTIFACT_REFS.desired, oid: desiredCommit } : undefined
          },
          prerequisites: artifactEvidence.prerequisites
        },
        viewPath: `${relativeRoot}/view`
      });
    }

    for (const snapshot of targetSnapshots) assertTargetUnchanged(snapshot, runner);
    for (const candidateId of order) revalidateCandidate(candidateMap.get(candidateId)!, runner);
    const payload: PreparedManifestPayload = {
      version: PREPARED_FOLD_VERSION,
      parentSessionFile: path.resolve(input.parentSessionFile),
      createdAt: input.createdAt,
      status: resolutionCases.length === 0 ? "ready" : "resolution_required",
      order,
      repositories: prepared,
      overlaps,
      resolutionCases
    };
    const manifestSha256 = sha256(Buffer.from(JSON.stringify(payload)));
    const preparedId = `prepared_${manifestSha256.slice(0, 24)}`;
    const manifest: PreparedWorkerFoldManifest = { ...payload, preparedId, manifestSha256 };
    if (!isPreparedWorkerFoldManifest(manifest)) throw new Error("Refusing to persist an invalid prepared worker fold manifest.");
    const manifestFile = path.join(staging, "manifest.json");
    const descriptor = openSync(manifestFile, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(manifestFile, 0o400);
    fsyncPath(manifestFile);
    for (const repository of prepared) fsyncDirectory(path.dirname(path.join(staging, repository.artifact.file)));
    fsyncDirectory(path.join(staging, "repositories"));
    fsyncDirectory(staging);
    const finalDirectory = path.join(foldsRoot, preparedId);
    if (existsSync(finalDirectory)) throw new Error(`Prepared worker fold already exists: ${preparedId}; retry with a fresh preparation timestamp after inspecting existing state.`);
    renameSync(staging, finalDirectory);
    fsyncDirectory(foldsRoot);
    const finalManifestFile = path.join(finalDirectory, "manifest.json");
    return { manifest, summary: summarizePreparedFold(manifest, finalManifestFile) };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function readPreparedWorkerFold(foldsRoot: string, preparedId: string, expectedParentSessionFile?: string): PreparedWorkerFoldManifest {
  if (!PREPARED_ID_PATTERN.test(preparedId)) throw new Error(`Invalid prepared worker fold ID: ${preparedId}`);
  const root = requireCanonicalDirectory(foldsRoot, "worker fold root");
  const directory = path.join(root, preparedId);
  const directoryMetadata = lstatSync(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || realpathSync(directory) !== directory || (directoryMetadata.mode & 0o077) !== 0) {
    throw new Error("Prepared worker fold directory is invalid.");
  }
  const manifestFile = path.join(directory, "manifest.json");
  const metadata = lstatSync(manifestFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_MANIFEST_BYTES || (metadata.mode & 0o077) !== 0 || (metadata.mode & 0o222) !== 0) {
    throw new Error("Prepared worker fold manifest is not an immutable owner-only bounded file.");
  }
  const parsed: unknown = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (!isPreparedWorkerFoldManifest(parsed)) throw new Error("Prepared worker fold manifest failed validation.");
  if (expectedParentSessionFile && path.resolve(parsed.parentSessionFile) !== path.resolve(expectedParentSessionFile)) throw new Error(`Prepared worker fold ${preparedId} belongs to a different parent session.`);
  const payload = manifestPayload(parsed);
  if (sha256(Buffer.from(JSON.stringify(payload))) !== parsed.manifestSha256) throw new Error("Prepared worker fold manifest hash mismatch.");
  if (`prepared_${parsed.manifestSha256.slice(0, 24)}` !== parsed.preparedId) throw new Error("Prepared worker fold identity mismatch.");

  const runner = createGitRunner(resolveExecutable("git"), root);
  for (const repository of parsed.repositories) {
    verifyCandidateIdentity(repository);
    verifyInventoryProvenance(directory, repository.candidateInventory, repository);
    const artifact = path.resolve(directory, repository.artifact.file);
    if (!isWithin(directory, artifact) || !existsSync(artifact)) throw new Error("Prepared worker fold artifact is missing or escapes its directory.");
    const artifactMetadata = lstatSync(artifact);
    if (!artifactMetadata.isFile() || artifactMetadata.isSymbolicLink() || artifactMetadata.nlink !== 1 || artifactMetadata.size > MAX_BUNDLE_BYTES || (artifactMetadata.mode & 0o077) !== 0 || (artifactMetadata.mode & 0o222) !== 0 || sha256(readFileSync(artifact)) !== repository.artifact.sha256) {
      throw new Error("Prepared worker fold object artifact failed immutable file or hash validation.");
    }
    const verifyDirectory = path.join(root, `.verify-${process.pid}-${randomUUID()}`);
    mkdirSync(verifyDirectory, { mode: 0o700 });
    const verifyRepo = path.join(verifyDirectory, "repo");
    try {
      runStandaloneGit(runner, verifyDirectory, ["init", "--initial-branch=main", `--template=${runner.templateDir}`, verifyRepo]);
      const expectedHeads = artifactHeadMap(repository.artifact);
      verifyBundle(runner, verifyRepo, artifact, expectedHeads, repository.artifact.prerequisites);
      const refspecs = [...expectedHeads.keys()].sort().map((ref) => `${ref}:${ref}`);
      gitBuffer(runner, verifyRepo, ["fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", artifact, ...refspecs]);
      verifyPreparedObjects(repository, verifyRepo, runner);
    } finally {
      rmSync(verifyDirectory, { recursive: true, force: true });
    }
  }
  return parsed;
}

function revalidateCandidate(resolved: ResolvedRepositoryCandidate, runner: ReturnType<typeof createGitRunner>) {
  const candidate = resolved.candidate;
  if (!candidate.foldable || !candidate.baseCommit || !candidate.baseTree || !candidate.headCommit || !candidate.headTree) throw new Error(`Worker repository candidate is not foldable: ${candidate.candidateId}`);
  const workspaceRoot = requireCanonicalDirectory(resolved.workspaceRoot, "candidate workspace");
  const repoPath = path.resolve(workspaceRoot, candidate.workspaceRepo);
  if (!isWithin(workspaceRoot, repoPath) || !existsSync(repoPath) || realpathSync(repoPath) !== repoPath) throw new Error(`Worker repository candidate path is stale: ${candidate.candidateId}`);
  const policyIssues = [...repositoryPolicyIssues(repoPath, runner), ...repositoryTreePolicyIssues(repoPath, candidate.headCommit, runner)];
  if (policyIssues.length > 0) throw new Error(`Worker repository candidate policy changed: ${candidate.candidateId} (${policyIssues.join(",")})`);
  const headCommit = gitText(runner, repoPath, ["rev-parse", "HEAD^{commit}"]).trim();
  const headTree = gitText(runner, repoPath, ["rev-parse", "HEAD^{tree}"]).trim();
  const baseTree = gitText(runner, repoPath, ["rev-parse", `${candidate.baseCommit}^{tree}`]).trim();
  const dirty = repositoryDirty(repoPath, runner);
  if (headCommit !== candidate.headCommit || headTree !== candidate.headTree || baseTree !== candidate.baseTree || dirty !== candidate.dirty) throw new Error(`Worker repository candidate identity moved after handoff: ${candidate.candidateId}`);
  gitBuffer(runner, repoPath, ["merge-base", "--is-ancestor", candidate.baseCommit, candidate.headCommit]);
  const recomputed = repositoryCandidateId({ workerId: candidate.workerId, runId: candidate.runId, workspaceRepo: candidate.workspaceRepo, baseCommit: candidate.baseCommit, headCommit: candidate.headCommit, headTree: candidate.headTree });
  if (recomputed !== candidate.candidateId) throw new Error(`Worker repository candidate ID does not bind its exact identities: ${candidate.candidateId}`);
  return {
    repoPath,
    workerId: candidate.workerId,
    runId: candidate.runId,
    workspaceRepo: candidate.workspaceRepo,
    reported: candidate.reported,
    source: candidate.source,
    baseCommit: candidate.baseCommit,
    baseTree: candidate.baseTree,
    headCommit,
    headTree,
    dirty
  };
}

function inspectTarget(selection: RepositoryChangeSetEntry, targetRoot: string, runner: ReturnType<typeof createGitRunner>): TargetSnapshot {
  if (!path.isAbsolute(selection.targetRepo)) throw new Error(`Target repository path must be absolute: ${selection.targetRepo}`);
  const requested = path.resolve(selection.targetRepo);
  if (!existsSync(requested)) throw new Error(`Target repository does not exist: ${selection.targetRepo}`);
  const targetRepo = requireCanonicalDirectory(requested, "target repository");
  if (targetRepo === targetRoot || !isWithin(targetRoot, targetRepo)) throw new Error(`Target repository must be below the accepted local target root: ${selection.targetRepo}`);
  const gitMarker = path.join(targetRepo, ".git");
  if (!existsSync(gitMarker)) throw new Error(`Target path is not a Git repository: ${selection.targetRepo}`);
  const marker = statSync(gitMarker, { bigint: true });
  const gitDevice = marker.dev.toString();
  const gitInode = marker.ino.toString();
  const policyIssues = repositoryPolicyIssues(targetRepo, runner);
  if (policyIssues.length > 0) throw new Error(`Target repository has unsupported Git policy: ${policyIssues.join(",")}`);
  if (gitBuffer(runner, targetRepo, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]).byteLength > 0) throw new Error(`Target repository is dirty: ${targetRepo}`);
  const worktrees = gitText(runner, targetRepo, ["worktree", "list", "--porcelain", "-z"]).split("\0").filter((line) => line.startsWith("worktree "));
  if (worktrees.length !== 1) throw new Error(`Target repository has linked worktrees: ${targetRepo}`);
  const expectedCommit = gitText(runner, targetRepo, ["show-ref", "--verify", "--hash", selection.targetRef]).trim();
  if (!OID_PATTERN.test(expectedCommit)) throw new Error(`Target ref does not resolve to an exact commit: ${selection.targetRef}`);
  const commit = gitText(runner, targetRepo, ["rev-parse", `${selection.targetRef}^{commit}`]).trim();
  if (commit !== expectedCommit) throw new Error(`Target ref is not a direct commit ref: ${selection.targetRef}`);
  const expectedTree = gitText(runner, targetRepo, ["rev-parse", `${expectedCommit}^{tree}`]).trim();
  const exactPolicy = repositoryTreePolicyIssues(targetRepo, expectedCommit, runner);
  if (exactPolicy.length > 0) throw new Error(`Target ref has unsupported exact-tree policy: ${exactPolicy.join(",")}`);
  return { targetRepo, targetRef: selection.targetRef, gitDevice, gitInode, expectedCommit, expectedTree };
}

function assertTargetUnchanged(snapshot: TargetSnapshot, runner: ReturnType<typeof createGitRunner>): void {
  const marker = statSync(path.join(snapshot.targetRepo, ".git"), { bigint: true });
  const current = gitText(runner, snapshot.targetRepo, ["show-ref", "--verify", "--hash", snapshot.targetRef]).trim();
  const tree = gitText(runner, snapshot.targetRepo, ["rev-parse", `${current}^{tree}`]).trim();
  const status = gitBuffer(runner, snapshot.targetRepo, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  if (marker.dev.toString() !== snapshot.gitDevice || marker.ino.toString() !== snapshot.gitInode || current !== snapshot.expectedCommit || tree !== snapshot.expectedTree || status.byteLength > 0) throw new Error(`Target repository changed during preparation: ${snapshot.targetRepo}`);
}

function assertViewPolicy(repoPath: string, exactCommit: string, runner: ReturnType<typeof createGitRunner>, label: string): void {
  try {
    const issues = [...repositoryPolicyIssues(repoPath, runner), ...repositoryTreePolicyIssues(repoPath, exactCommit, runner)];
    const dirty = repositoryDirty(repoPath, runner);
    if (issues.length > 0 || dirty) throw new Error(issues.length ? issues.join(",") : "dirty_view");
  } catch (error) {
    throw new Error(`Prepared ${label} view failed policy or clean-state validation: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function verifyPreparedObjects(repository: PreparedRepositoryFold, repoPath: string, runner: ReturnType<typeof createGitRunner>): void {
  const targetTree = gitText(runner, repoPath, ["rev-parse", `${repository.targetExpectedCommit}^{tree}`]).trim();
  const candidateTree = gitText(runner, repoPath, ["rev-parse", `${repository.candidateHeadCommit}^{tree}`]).trim();
  const baseTree = gitText(runner, repoPath, ["rev-parse", `${repository.candidateBaseCommit}^{tree}`]).trim();
  const mergeBase = gitText(runner, repoPath, ["merge-base", repository.targetExpectedCommit, repository.candidateHeadCommit]).trim();
  if (targetTree !== repository.targetExpectedTree || candidateTree !== repository.candidateHeadTree || baseTree !== repository.candidateBaseTree || mergeBase !== repository.mergeBase || mergeBase !== repository.candidateBaseCommit) throw new Error("Prepared worker fold exact input identity verification failed.");
  if (repositoryTreePolicyIssues(repoPath, repository.targetExpectedCommit, runner).length || repositoryTreePolicyIssues(repoPath, repository.candidateHeadCommit, runner).length) throw new Error("Prepared worker fold object artifact contains unsupported exact-tree policy.");
  if (repository.status === "ready") {
    if (!repository.desiredCommit || !repository.desiredTree) throw new Error("Prepared ready repository is missing desired identity.");
    const desiredTree = gitText(runner, repoPath, ["rev-parse", `${repository.desiredCommit}^{tree}`]).trim();
    const parents = gitText(runner, repoPath, ["rev-list", "--parents", "-n", "1", repository.desiredCommit]).trim().split(/\s+/).slice(1);
    const expectedParents = repository.method === "merge" ? [repository.targetExpectedCommit, repository.candidateHeadCommit] : [repository.targetExpectedCommit];
    if (desiredTree !== repository.desiredTree || JSON.stringify(parents) !== JSON.stringify(expectedParents)) throw new Error("Prepared desired commit tree or parent shape mismatch.");
    if (repositoryTreePolicyIssues(repoPath, repository.desiredCommit, runner).length) throw new Error("Prepared desired commit has unsupported exact-tree policy.");
  }
}

function verifyCandidateIdentity(repository: PreparedRepositoryFold): void {
  const candidateId = repositoryCandidateId({ workerId: repository.workerId, runId: repository.runId, workspaceRepo: repository.workspaceRepo, baseCommit: repository.candidateBaseCommit, headCommit: repository.candidateHeadCommit, headTree: repository.candidateHeadTree });
  if (candidateId !== repository.candidateId) throw new Error("Prepared worker fold candidate identity mismatch.");
}

function persistInventoryProvenance(source: CandidateInventoryProvenance, destination: string, relativeFile: string): CandidateInventoryProvenance {
  const metadata = lstatSync(source.inventoryFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_MANIFEST_BYTES) throw new Error("Worker repository candidate inventory provenance is not a bounded single-link file.");
  const content = readFileSync(source.inventoryFile);
  if (sha256(content) !== source.inventorySha256) throw new Error("Worker repository candidate inventory provenance hash mismatch.");
  writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
  fsyncPath(destination);
  chmodSync(destination, 0o400);
  fsyncPath(destination);
  return { ...cloneInventoryProvenance(source), inventoryFile: relativeFile };
}

function verifyInventoryProvenance(preparedDirectory: string, provenance: CandidateInventoryProvenance, repository: PreparedRepositoryFold): void {
  const inventoryFile = path.resolve(preparedDirectory, provenance.inventoryFile);
  if (!isWithin(preparedDirectory, inventoryFile)) throw new Error("Prepared worker fold candidate inventory provenance escapes its directory.");
  const metadata = lstatSync(inventoryFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_MANIFEST_BYTES || (metadata.mode & 0o077) !== 0 || (metadata.mode & 0o222) !== 0) throw new Error("Prepared worker fold candidate inventory provenance is not an immutable owner-only bounded file.");
  const content = readFileSync(inventoryFile);
  if (sha256(content) !== provenance.inventorySha256) throw new Error("Prepared worker fold candidate inventory provenance hash mismatch.");
  let inventory: unknown;
  try { inventory = JSON.parse(content.toString("utf8")) as unknown; } catch { throw new Error("Prepared worker fold candidate inventory provenance is not valid JSON."); }
  if (!isRepositoryInventory(inventory) || inventory.workerId !== repository.workerId || inventory.runId !== repository.runId) throw new Error("Prepared worker fold candidate inventory provenance failed strict identity validation.");
  if (JSON.stringify(inventory.reportedIssues) !== JSON.stringify(provenance.reportedIssues) || JSON.stringify(inventory.scanCoverage) !== JSON.stringify(provenance.scanCoverage)) throw new Error("Prepared worker fold candidate inventory evidence mismatch.");
  const candidate = inventory.candidates.find((item) => item.candidateId === repository.candidateId);
  if (!candidate || candidate.workerId !== repository.workerId || candidate.runId !== repository.runId || candidate.workspaceRepo !== repository.workspaceRepo || candidate.reported !== repository.candidateReported || candidate.source !== repository.candidateSource || candidate.baseCommit !== repository.candidateBaseCommit || candidate.baseTree !== repository.candidateBaseTree || candidate.headCommit !== repository.candidateHeadCommit || candidate.headTree !== repository.candidateHeadTree || candidate.dirty !== repository.candidateDirty || !candidate.foldable) throw new Error("Prepared worker fold candidate facts do not match immutable inventory provenance.");
}

function verifyBundle(
  runner: ReturnType<typeof createGitRunner>,
  repoPath: string,
  bundleFile: string,
  expectedHeads?: ReadonlyMap<string, string>,
  expectedPrerequisites?: readonly string[]
): BundleEvidence {
  gitBuffer(runner, repoPath, ["bundle", "verify", bundleFile]);
  const listed = new Map<string, string>();
  for (const line of gitText(runner, repoPath, ["bundle", "list-heads", bundleFile]).trim().split("\n").filter(Boolean)) {
    const separator = line.indexOf(" ");
    if (separator <= 0) throw new Error("Prepared bundle advertised an invalid head.");
    const ref = line.slice(separator + 1);
    if (listed.has(ref)) throw new Error("Prepared bundle advertised a duplicate head.");
    listed.set(ref, line.slice(0, separator));
  }
  const header = parseBundleHeader(bundleFile);
  if (!sameHeadMap(listed, header.heads)) throw new Error("Prepared bundle header and list-heads disagree.");
  if (expectedHeads && !sameHeadMap(listed, expectedHeads)) throw new Error("Prepared bundle advertised heads do not match the manifest.");
  if (expectedPrerequisites && JSON.stringify(header.prerequisites) !== JSON.stringify([...expectedPrerequisites].sort())) throw new Error("Prepared bundle prerequisites do not match the manifest.");
  return header;
}

function parseBundleHeader(bundleFile: string): BundleEvidence {
  const content = readFileSync(bundleFile);
  const headerEnd = content.indexOf(Buffer.from("\n\n"));
  if (headerEnd < 0 || headerEnd > MAX_BUNDLE_HEADER_BYTES) throw new Error("Prepared bundle has no bounded header.");
  const lines = content.subarray(0, headerEnd).toString("utf8").split("\n");
  if (!/^# v[23] git bundle$/.test(lines.shift() ?? "")) throw new Error("Prepared bundle version is unsupported.");
  const heads = new Map<string, string>();
  const prerequisites: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("-")) {
      const oid = line.slice(1).split(" ", 1)[0] ?? "";
      if (!OID_PATTERN.test(oid)) throw new Error("Prepared bundle prerequisite is invalid.");
      prerequisites.push(oid);
      continue;
    }
    const separator = line.indexOf(" ");
    if (separator <= 0) throw new Error("Prepared bundle head header is invalid.");
    const oid = line.slice(0, separator);
    const ref = line.slice(separator + 1);
    if (!OID_PATTERN.test(oid) || (ref !== "HEAD" && !ref.startsWith("refs/"))) throw new Error("Prepared bundle advertised head is invalid.");
    if (heads.has(ref)) throw new Error("Prepared bundle header contains a duplicate head.");
    heads.set(ref, oid);
  }
  return { heads, prerequisites: prerequisites.sort() };
}

function artifactHeadMap(artifact: PreparedObjectArtifact): Map<string, string> {
  return new Map([
    [artifact.heads.target.ref, artifact.heads.target.oid],
    [artifact.heads.candidate.ref, artifact.heads.candidate.oid],
    ...(artifact.heads.desired ? [[artifact.heads.desired.ref, artifact.heads.desired.oid] as [string, string]] : [])
  ]);
}

function sameHeadMap(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  return left.size === right.size && [...left.entries()].every(([ref, oid]) => right.get(ref) === oid);
}

function syntheticCommitMessage(selection: RepositoryChangeSetEntry, candidate: CandidateSnapshot): string {
  const purpose = selection.purpose.replace(/[\r\n]+/g, " ").trim();
  return [
    `Prepared ${selection.method} worker fold`,
    "",
    `Candidate: ${selection.candidateId}`,
    `Worker run: ${candidate.workerId}/${candidate.runId}`,
    `Workspace repository: ${candidate.workspaceRepo}`,
    `Candidate head: ${candidate.headCommit}`,
    `Purpose: ${purpose}`
  ].join("\n");
}

function cloneInventoryProvenance(value: CandidateInventoryProvenance): CandidateInventoryProvenance {
  return {
    inventoryFile: value.inventoryFile,
    inventorySha256: value.inventorySha256,
    reportedIssues: value.reportedIssues.map((item) => ({ ...item })),
    scanCoverage: { complete: value.scanCoverage.complete, limitations: [...value.scanCoverage.limitations] }
  };
}

function validateChangeSet(changeSet: RepositoryChangeSet): RepositoryChangeSetEntry[] {
  if (!isRecord(changeSet) || !hasOnlyKeys(changeSet, ["repositories"]) || !Array.isArray(changeSet.repositories) || changeSet.repositories.length < 1 || changeSet.repositories.length > MAX_REPOSITORIES) throw new Error(`RepositoryChangeSet must contain 1..${MAX_REPOSITORIES} repositories.`);
  const ids = new Set<string>();
  return changeSet.repositories.map((value) => {
    if (!isRecord(value) || !hasOnlyKeys(value, ["candidateId", "targetRepo", "targetRef", "purpose", "method", "dependsOn"])) throw new Error("RepositoryChangeSet contains an invalid repository mapping.");
    if (typeof value.candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(value.candidateId) || ids.has(value.candidateId)) throw new Error("RepositoryChangeSet candidate IDs must be unique canonical candidate IDs.");
    ids.add(value.candidateId);
    if (typeof value.targetRepo !== "string" || Buffer.byteLength(value.targetRepo, "utf8") > MAX_PATH_BYTES) throw new Error("RepositoryChangeSet targetRepo is invalid.");
    if (typeof value.targetRef !== "string" || !TARGET_REF_PATTERN.test(value.targetRef) || value.targetRef.includes("..") || value.targetRef.endsWith(".")) throw new Error("RepositoryChangeSet targetRef must be a canonical refs/heads/... ref.");
    if (typeof value.purpose !== "string" || !value.purpose.trim() || Buffer.byteLength(value.purpose, "utf8") > MAX_PURPOSE_BYTES) throw new Error("RepositoryChangeSet purpose is invalid.");
    if (value.method !== "merge" && value.method !== "squash") throw new Error("RepositoryChangeSet method must be merge or squash.");
    if (!Array.isArray(value.dependsOn) || value.dependsOn.length > MAX_REPOSITORIES || value.dependsOn.some((item) => typeof item !== "string" || !CANDIDATE_ID_PATTERN.test(item))) throw new Error("RepositoryChangeSet dependsOn is invalid.");
    if (new Set(value.dependsOn).size !== value.dependsOn.length || value.dependsOn.includes(value.candidateId)) throw new Error("RepositoryChangeSet dependencies must be unique and may not self-reference.");
    return { candidateId: value.candidateId, targetRepo: value.targetRepo, targetRef: value.targetRef, purpose: value.purpose, method: value.method, dependsOn: [...value.dependsOn] };
  });
}

function dependencyOrder(selections: readonly RepositoryChangeSetEntry[]): string[] {
  const byId = new Map(selections.map((item) => [item.candidateId, item]));
  for (const selection of selections) for (const dependency of selection.dependsOn) if (!byId.has(dependency)) throw new Error(`RepositoryChangeSet dependency is not selected: ${dependency}`);
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
      artifactFile: path.join(directory, item.artifact.file),
      viewPath: path.join(directory, item.viewPath)
    }))
  };
}

function manifestPayload(manifest: PreparedWorkerFoldManifest): PreparedManifestPayload {
  const { preparedId: _preparedId, manifestSha256: _manifestSha256, ...payload } = manifest;
  return payload;
}

function isPreparedWorkerFoldManifest(value: unknown): value is PreparedWorkerFoldManifest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "preparedId", "manifestSha256", "parentSessionFile", "createdAt", "status", "order", "repositories", "overlaps", "resolutionCases"]) || value.version !== PREPARED_FOLD_VERSION || typeof value.preparedId !== "string" || !PREPARED_ID_PATTERN.test(value.preparedId) || typeof value.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.manifestSha256) || typeof value.parentSessionFile !== "string" || !path.isAbsolute(value.parentSessionFile) || Buffer.byteLength(value.parentSessionFile, "utf8") > 4096 || typeof value.createdAt !== "string" || value.createdAt.length > 128 || Number.isNaN(Date.parse(value.createdAt)) || (value.status !== "ready" && value.status !== "resolution_required") || !Array.isArray(value.order) || !Array.isArray(value.repositories) || value.repositories.length < 1 || value.repositories.length > MAX_REPOSITORIES || !Array.isArray(value.overlaps) || !Array.isArray(value.resolutionCases)) return false;
  const order = value.order as unknown[];
  const repositories = value.repositories as unknown[];
  const overlaps = value.overlaps as unknown[];
  const resolutionCases = value.resolutionCases as unknown[];
  if (order.length !== repositories.length || order.some((item) => typeof item !== "string" || !CANDIDATE_ID_PATTERN.test(item)) || new Set(order).size !== order.length || overlaps.length > MAX_REPOSITORIES || resolutionCases.length > MAX_REPOSITORIES) return false;
  if (!overlaps.every(isPreparedOverlap) || !repositories.every(isPreparedRepositoryFold) || !resolutionCases.every(isResolutionCase)) return false;
  const preparedRepositories = repositories as PreparedRepositoryFold[];
  const cases = resolutionCases as FoldResolutionCase[];
  if (new Set(preparedRepositories.map((item) => item.candidateId)).size !== preparedRepositories.length) return false;
  if (new Set(preparedRepositories.map((item) => `${item.targetGitDevice}:${item.targetGitInode}`)).size !== preparedRepositories.length) return false;
  if (preparedRepositories.some((item) => !order.includes(item.candidateId))) return false;
  const requiredResolutionIds = preparedRepositories.filter((item) => item.status === "resolution_required").map((item) => item.candidateId).sort();
  if (JSON.stringify(requiredResolutionIds) !== JSON.stringify(cases.map((item) => item.candidateId).sort())) return false;
  return value.status === (cases.length === 0 ? "ready" : "resolution_required");
}

function isPreparedRepositoryFold(value: unknown): value is PreparedRepositoryFold {
  if (!isRecord(value) || !hasOnlyKeys(value, ["candidateId", "workerId", "runId", "workspaceRepo", "candidateReported", "candidateSource", "candidateBaseCommit", "candidateBaseTree", "candidateHeadCommit", "candidateHeadTree", "candidateDirty", "candidateInventory", "targetRepo", "targetRef", "targetGitDevice", "targetGitInode", "targetExpectedCommit", "targetExpectedTree", "mergeBase", "method", "purpose", "dependsOn", "status", "desiredCommit", "desiredTree", "artifact", "viewPath"])) return false;
  const oidKeys = ["candidateBaseCommit", "candidateBaseTree", "candidateHeadCommit", "candidateHeadTree", "targetExpectedCommit", "targetExpectedTree", "mergeBase"];
  if (oidKeys.some((key) => typeof value[key] !== "string" || !OID_PATTERN.test(value[key] as string))) return false;
  if (typeof value.candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(value.candidateId) || typeof value.workerId !== "string" || !/^worker_[A-Za-z0-9_-]{1,120}$/.test(value.workerId) || typeof value.runId !== "string" || !/^run_[A-Za-z0-9_-]{1,120}$/.test(value.runId) || typeof value.workspaceRepo !== "string" || !safeRelative(value.workspaceRepo) || typeof value.candidateReported !== "boolean" || (value.candidateSource !== undefined && (typeof value.candidateSource !== "string" || Buffer.byteLength(value.candidateSource, "utf8") > 2048)) || typeof value.candidateDirty !== "boolean" || !isInventoryProvenance(value.candidateInventory) || typeof value.targetRepo !== "string" || !path.isAbsolute(value.targetRepo) || Buffer.byteLength(value.targetRepo, "utf8") > MAX_PATH_BYTES || typeof value.targetRef !== "string" || !TARGET_REF_PATTERN.test(value.targetRef) || typeof value.targetGitDevice !== "string" || !/^\d+$/.test(value.targetGitDevice) || typeof value.targetGitInode !== "string" || !/^\d+$/.test(value.targetGitInode) || (value.method !== "merge" && value.method !== "squash") || typeof value.purpose !== "string" || !value.purpose || Buffer.byteLength(value.purpose, "utf8") > MAX_PURPOSE_BYTES || !Array.isArray(value.dependsOn) || value.dependsOn.length > MAX_REPOSITORIES || value.dependsOn.some((item) => typeof item !== "string" || !CANDIDATE_ID_PATTERN.test(item)) || new Set(value.dependsOn).size !== value.dependsOn.length || value.dependsOn.includes(value.candidateId) || (value.status !== "ready" && value.status !== "resolution_required") || !isPreparedArtifact(value.artifact) || typeof value.viewPath !== "string" || !safeRelative(value.viewPath)) return false;
  if (value.artifact.heads.target.oid !== value.targetExpectedCommit || value.artifact.heads.candidate.oid !== value.candidateHeadCommit || value.artifact.prerequisites.length !== 0) return false;
  if (value.status === "ready") return typeof value.desiredCommit === "string" && OID_PATTERN.test(value.desiredCommit) && typeof value.desiredTree === "string" && OID_PATTERN.test(value.desiredTree) && value.artifact.heads.desired?.oid === value.desiredCommit;
  return value.desiredCommit === undefined && value.desiredTree === undefined && value.artifact.heads.desired === undefined;
}

function isPreparedArtifact(value: unknown): value is PreparedObjectArtifact {
  if (!isRecord(value) || !hasOnlyKeys(value, ["file", "sha256", "heads", "prerequisites"]) || typeof value.file !== "string" || !safeRelative(value.file) || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) || !Array.isArray(value.prerequisites) || value.prerequisites.some((item) => typeof item !== "string" || !OID_PATTERN.test(item)) || !isRecord(value.heads) || !hasOnlyKeys(value.heads, ["target", "candidate", "desired"])) return false;
  return isArtifactHead(value.heads.target, ARTIFACT_REFS.target) && isArtifactHead(value.heads.candidate, ARTIFACT_REFS.candidate) && (value.heads.desired === undefined || isArtifactHead(value.heads.desired, ARTIFACT_REFS.desired));
}

function isArtifactHead(value: unknown, expectedRef: string): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["ref", "oid"]) && value.ref === expectedRef && typeof value.oid === "string" && OID_PATTERN.test(value.oid);
}

function isInventoryProvenance(value: unknown): value is CandidateInventoryProvenance {
  return isRecord(value) && hasOnlyKeys(value, ["inventoryFile", "inventorySha256", "reportedIssues", "scanCoverage"]) && typeof value.inventoryFile === "string" && safeRelative(value.inventoryFile) && typeof value.inventorySha256 === "string" && /^[0-9a-f]{64}$/.test(value.inventorySha256) && Array.isArray(value.reportedIssues) && value.reportedIssues.length <= 16 && value.reportedIssues.every((item) => isRecord(item) && hasOnlyKeys(item, ["kind", "workspaceRepo"]) && (item.kind === "reported_missing" || item.kind === "reported_not_repository") && typeof item.workspaceRepo === "string" && Buffer.byteLength(item.workspaceRepo, "utf8") <= MAX_PATH_BYTES) && isRecord(value.scanCoverage) && hasOnlyKeys(value.scanCoverage, ["complete", "limitations"]) && typeof value.scanCoverage.complete === "boolean" && Array.isArray(value.scanCoverage.limitations) && value.scanCoverage.limitations.every((item) => ["entry_limit", "repository_limit", "depth_limit", "path_limit", "unreadable_directory"].includes(String(item)));
}

function isPreparedOverlap(value: unknown): value is PreparedWorkerFoldManifest["overlaps"][number] {
  if (!isRecord(value) || !hasOnlyKeys(value, ["targetRepo", "candidateIds", "pathCount"]) || typeof value.targetRepo !== "string" || !path.isAbsolute(value.targetRepo) || Buffer.byteLength(value.targetRepo, "utf8") > MAX_PATH_BYTES || !Array.isArray(value.candidateIds) || value.candidateIds.length < 1 || value.candidateIds.length > MAX_REPOSITORIES || typeof value.pathCount !== "number" || !Number.isInteger(value.pathCount) || value.pathCount < 1 || value.pathCount > 1_000_000) return false;
  return value.candidateIds.every((item) => typeof item === "string" && CANDIDATE_ID_PATTERN.test(item)) && new Set(value.candidateIds).size === value.candidateIds.length;
}

function isResolutionCase(value: unknown): value is FoldResolutionCase {
  return isRecord(value) && hasOnlyKeys(value, ["candidateId", "targetRepo", "targetRef", "kind", "summary"]) && typeof value.candidateId === "string" && CANDIDATE_ID_PATTERN.test(value.candidateId) && typeof value.targetRepo === "string" && path.isAbsolute(value.targetRepo) && typeof value.targetRef === "string" && TARGET_REF_PATTERN.test(value.targetRef) && value.kind === "merge_conflict" && typeof value.summary === "string" && value.summary.length > 0 && Buffer.byteLength(value.summary, "utf8") <= MAX_CONFLICT_SUMMARY_BYTES;
}

function assertObject(repoPath: string, oid: string, runner: ReturnType<typeof createGitRunner>, message: string): void {
  try { gitBuffer(runner, repoPath, ["cat-file", "-e", `${oid}^{commit}`]); } catch { throw new Error(message); }
}

function assertBoundedRegularFile(file: string, label: string): void {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_BUNDLE_BYTES) throw new Error(`${label} is not a bounded single-link regular file.`);
}

function requireCanonicalDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  const canonical = realpathSync(resolved);
  if (canonical !== resolved) throw new Error(`${label} must use its canonical path.`);
  return canonical;
}

function fsyncPath(file: string): void {
  const descriptor = openSync(file, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRelative(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !path.normalize(value).startsWith("..") && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES;
}

function nulPaths(output: Buffer): string[] { return decodeGitOutput(output).split("\0").filter(Boolean); }
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
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { const keys = new Set(allowed); return Object.keys(value).every((key) => keys.has(key)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
