import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { resolveExecutable } from "../_shared/executable.js";
import {
  createGitRunner,
  gitBuffer,
  gitText,
  repositoryCommitParents,
  repositoryPolicyIssues,
  repositoryTreePolicyIssues,
  runGit,
  type GitRunner
} from "./repositories.js";
import { readPreparedWorkerFold, type PreparedRepositoryFold, type PreparedWorkerFoldManifest } from "./folds.js";
import { acquireWorkerOperationLock, releaseWorkerOperationLock, type WorkerOperationLock } from "./state.js";

const PROMOTION_VERSION = 1;
const MAX_REPOSITORIES = 16;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const OID_PATTERN = /^[0-9a-f]{40,64}$/;
const PREPARED_ID_PATTERN = /^prepared_[0-9a-f]{24}$/;
const PROMOTION_ID_PATTERN = /^promotion_[0-9a-f]{24}$/;
const CANDIDATE_ID_PATTERN = /^candidate_[0-9a-f]{24}$/;
const TARGET_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,239}$/;

export type WorkerFoldPromotionSelection = {
  candidateId: string;
  targetRepo: string;
  targetRef: string;
  expectedCommit: string;
  desiredCommit: string;
};

export type WorkerFoldPromotionRequest = {
  preparedId: string;
  manifestSha256: string;
  repositories: WorkerFoldPromotionSelection[];
};

export type PromotionRepositoryStatus = "pending" | "objects_imported" | "ref_updated" | "completed" | "quarantined";
export type PromotionStatus = "promoting" | "partial" | "completed" | "quarantined";

export type PromotionRepositoryRecord = WorkerFoldPromotionSelection & {
  artifactFile: string;
  method: "merge" | "squash";
  candidateHeadCommit: string;
  expectedTree: string;
  desiredTree: string;
  targetGitDevice: string;
  targetGitInode: string;
  checkedOut: boolean;
  status: PromotionRepositoryStatus;
  error?: string;
};

export type WorkerFoldPromotionJournal = {
  version: typeof PROMOTION_VERSION;
  promotionId: string;
  preparedId: string;
  manifestSha256: string;
  parentSessionFile: string;
  createdAt: string;
  updatedAt: string;
  status: PromotionStatus;
  repositories: PromotionRepositoryRecord[];
  error?: string;
};

export type WorkerFoldPromotionSummary = {
  promotionId: string;
  journalFile: string;
  status: PromotionStatus;
  preparedId: string;
  manifestSha256: string;
  repositoryCount: number;
  completedCount: number;
  repositories: Array<{
    candidateId: string;
    targetRepo: string;
    targetRef: string;
    expectedCommit: string;
    desiredCommit: string;
    checkedOut: boolean;
    status: PromotionRepositoryStatus;
    error?: string;
  }>;
};

export class PromotionTestCrash extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionTestCrash";
  }
}

export type PromotionTestHooks = {
  afterJournalCreated?(journal: WorkerFoldPromotionJournal): void;
  beforeRepository?(index: number, repository: PromotionRepositoryRecord): void;
  afterObjectsImported?(index: number, repository: PromotionRepositoryRecord): void;
  afterRefUpdated?(index: number, repository: PromotionRepositoryRecord): void;
  beforeWorktreeSync?(index: number, repository: PromotionRepositoryRecord): void;
  afterRepositoryCompleted?(index: number, repository: PromotionRepositoryRecord): void;
};

export function defaultWorkerPromotionsRoot(stateRoot: string): string {
  return path.join(path.dirname(path.resolve(stateRoot)), "worker-promotions");
}

export function promotePreparedWorkerFold(input: {
  request: WorkerFoldPromotionRequest;
  parentSessionFile: string;
  foldsRoot: string;
  promotionsRoot: string;
  targetRoot: string;
  now(): Date;
  gitPath?: string;
  signal?: AbortSignal;
  testHooks?: PromotionTestHooks;
}): { journal: WorkerFoldPromotionJournal; summary: WorkerFoldPromotionSummary } {
  throwIfAborted(input.signal);
  const request = validatePromotionRequest(input.request);
  const manifest = readPreparedWorkerFold(input.foldsRoot, request.preparedId, input.parentSessionFile);
  if (manifest.manifestSha256 !== request.manifestSha256) throw new Error("Prepared worker fold promotion hash mismatch.");
  if (manifest.status !== "ready" || manifest.repositories.some((repository) => repository.status !== "ready")) {
    throw new Error("worker_fold_promote requires one fully ready prepared manifest.");
  }
  bindSelectionsToManifest(request.repositories, manifest);
  request.repositories = manifest.order.map((candidateId) => request.repositories.find((repository) => repository.candidateId === candidateId)!);

  mkdirSync(input.promotionsRoot, { recursive: true, mode: 0o700 });
  const promotionsRoot = requireCanonicalOwnerDirectory(input.promotionsRoot, "worker promotion root");
  const targetRoot = requireCanonicalDirectory(input.targetRoot, "worker promotion target root");
  const promotionId = promotionIdentity(request);
  const promotionDirectory = path.join(promotionsRoot, promotionId);
  const journalFile = path.join(promotionDirectory, "journal.json");
  if (existsSync(promotionDirectory)) requireCanonicalOwnerDirectory(promotionDirectory, "worker promotion directory");
  const runner = createGitRunner(input.gitPath ?? resolveExecutable("git"), promotionsRoot);
  const locks = acquireTargetLocks(promotionsRoot, request.repositories);
  try {
    let journal: WorkerFoldPromotionJournal;
    if (existsSync(journalFile)) {
      journal = readPromotionJournal(journalFile, request, input.parentSessionFile);
      validateJournalManifestBinding(journal, manifest, input.foldsRoot);
      if (journal.status === "quarantined") return { journal, summary: summarizePromotion(journal, journalFile) };
      if (journal.status === "completed") {
        for (let index = 0; index < journal.repositories.length; index += 1) {
          try {
            verifyCompletedRef(journal.repositories[index]!, runner, targetRoot);
          } catch (error) {
            const message = `Completed promotion no longer has its exact target identity/ref: ${boundError(error)}`;
            markQuarantined(journal, journalFile, index, message, input.now);
            return { journal, summary: summarizePromotion(journal, journalFile) };
          }
        }
        return { journal, summary: summarizePromotion(journal, journalFile) };
      }
    } else {
      const repositories = manifest.order.map((candidateId) => {
        const repository = manifest.repositories.find((item) => item.candidateId === candidateId)!;
        const selection = request.repositories.find((item) => item.candidateId === candidateId)!;
        return preflightNewRepository(selection, repository, input.foldsRoot, manifest.preparedId, runner, targetRoot);
      });
      recoverUnjournaledPromotionDirectory(promotionDirectory);
      if (!existsSync(promotionDirectory)) {
        mkdirSync(promotionDirectory, { mode: 0o700 });
        fsyncDirectory(promotionsRoot);
      }
      const createdAt = input.now().toISOString();
      journal = {
        version: PROMOTION_VERSION,
        promotionId,
        preparedId: request.preparedId,
        manifestSha256: request.manifestSha256,
        parentSessionFile: path.resolve(input.parentSessionFile),
        createdAt,
        updatedAt: createdAt,
        status: "promoting",
        repositories
      };
      persistPromotionJournal(journalFile, journal);
      input.testHooks?.afterJournalCreated?.(cloneJournal(journal));
    }

    try {
      for (let index = 0; index < journal.repositories.length; index += 1) {
        const repository = journal.repositories[index]!;
        if (repository.status === "completed") {
          try {
            verifyCompletedRef(repository, runner, targetRoot);
          } catch (error) {
            quarantine(journal, journalFile, index, `Completed repository target identity/ref changed: ${boundError(error)}`, input.now);
          }
          continue;
        }
        if (repository.status === "quarantined") throw new Error(`Promotion repository is quarantined: ${repository.targetRepo}`);
        throwIfAborted(input.signal);
        input.testHooks?.beforeRepository?.(index, { ...repository });
        try {
          promoteOneRepository(journal, journalFile, index, runner, targetRoot, input.now, input.signal, input.testHooks);
        } catch (error) {
          if (error instanceof PromotionTestCrash) throw error;
          if (repository.status === "ref_updated") {
            quarantine(journal, journalFile, index, `Promotion became ambiguous after CAS: ${boundError(error)}`, input.now);
          }
          repository.error ??= boundError(error);
          throw error;
        }
      }
      journal.status = "completed";
      journal.error = undefined;
      journal.updatedAt = input.now().toISOString();
      persistPromotionJournal(journalFile, journal);
      return { journal, summary: summarizePromotion(journal, journalFile) };
    } catch (error) {
      if (error instanceof PromotionTestCrash) throw error;
      journal.status = journal.repositories.some((repository) => repository.status === "quarantined") ? "quarantined" : "partial";
      journal.error = boundError(error);
      journal.updatedAt = input.now().toISOString();
      persistPromotionJournal(journalFile, journal);
      if (input.signal?.aborted) {
        const completion = journal.repositories.filter((repository) => repository.status === "completed").length;
        throw new Error(`Worker fold promotion cancelled after ${completion}/${journal.repositories.length} repositories; recover with promotion ${journal.promotionId} at ${journalFile}.`);
      }
      return { journal, summary: summarizePromotion(journal, journalFile) };
    }
  } finally {
    for (const lock of locks.reverse()) releaseWorkerOperationLock(lock);
  }
}

export function readWorkerFoldPromotion(promotionsRoot: string, promotionId: string): WorkerFoldPromotionJournal {
  if (!PROMOTION_ID_PATTERN.test(promotionId)) throw new Error(`Invalid worker fold promotion ID: ${promotionId}`);
  const root = requireCanonicalDirectory(promotionsRoot, "worker promotion root");
  const file = path.join(root, promotionId, "journal.json");
  return readPromotionJournalFile(file);
}

function promoteOneRepository(
  journal: WorkerFoldPromotionJournal,
  journalFile: string,
  index: number,
  runner: GitRunner,
  targetRoot: string,
  now: () => Date,
  signal?: AbortSignal,
  hooks?: PromotionTestHooks
): void {
  const repository = journal.repositories[index]!;
  const targetRepo = validateTargetIdentity(repository, runner, targetRoot);
  assertRepositoryPolicy(repository, runner);
  assertWorktreeTopology(repository, runner);
  let current = targetRefCommit(repository, runner);
  if (current !== repository.expectedCommit && current !== repository.desiredCommit) {
    if (repository.status === "ref_updated" || repository.status === "objects_imported") quarantine(journal, journalFile, index, `Target ref is ambiguous after promotion progress: ${repository.targetRef}`, now);
    repository.error = `Target ref moved before promotion: expected ${repository.expectedCommit}, found ${current}`;
    throw new Error(repository.error);
  }

  if (current === repository.expectedCommit) {
    if (repository.status === "ref_updated") quarantine(journal, journalFile, index, "Promotion journal says ref_updated but target ref returned to expected.", now);
    assertRepositoryPreCasClean(repository, runner);
    importAndVerifyObjects(repository, runner);
    repository.status = "objects_imported";
    repository.error = undefined;
    journal.updatedAt = now().toISOString();
    persistPromotionJournal(journalFile, journal);
    hooks?.afterObjectsImported?.(index, { ...repository });
    throwIfAborted(signal);
    assertRepositoryPolicy(repository, runner);
    assertRepositoryPreCasClean(repository, runner);
    gitBuffer(runner, targetRepo, ["update-ref", repository.targetRef, repository.desiredCommit, repository.expectedCommit]);
    current = targetRefCommit(repository, runner);
    if (current !== repository.desiredCommit) throw new Error(`Target ref CAS did not install the desired commit: ${repository.targetRef}`);
    hooks?.afterRefUpdated?.(index, { ...repository });
    repository.status = "ref_updated";
    journal.updatedAt = now().toISOString();
    persistPromotionJournal(journalFile, journal);
  } else {
    importAndVerifyObjects(repository, runner);
    if (repository.status === "pending" || repository.status === "objects_imported") {
      repository.status = "ref_updated";
      journal.updatedAt = now().toISOString();
      persistPromotionJournal(journalFile, journal);
    }
  }

  if (repository.checkedOut) {
    const state = checkedOutWorktreeState(repository, runner);
    if (state === "expected") {
      hooks?.beforeWorktreeSync?.(index, { ...repository });
      if (checkedOutWorktreeState(repository, runner) !== "expected") {
        quarantine(journal, journalFile, index, "Checked-out target changed before worktree synchronization.", now);
      }
      gitBuffer(runner, targetRepo, ["reset", "--hard", repository.desiredCommit]);
    } else if (state !== "desired") {
      quarantine(journal, journalFile, index, "Checked-out target worktree/index is neither the exact expected nor desired state.", now);
    }
  }
  verifyCompletedRepository(repository, runner, targetRoot);
  repository.status = "completed";
  repository.error = undefined;
  journal.updatedAt = now().toISOString();
  persistPromotionJournal(journalFile, journal);
  hooks?.afterRepositoryCompleted?.(index, { ...repository });
}

function preflightNewRepository(
  selection: WorkerFoldPromotionSelection,
  prepared: PreparedRepositoryFold,
  foldsRoot: string,
  preparedId: string,
  runner: GitRunner,
  targetRoot: string
): PromotionRepositoryRecord {
  if (!prepared.desiredCommit || !prepared.desiredTree || prepared.status !== "ready") throw new Error(`Prepared repository is not ready for promotion: ${prepared.candidateId}`);
  const preparedDirectory = path.resolve(foldsRoot, preparedId);
  const resolvedArtifact = path.resolve(preparedDirectory, prepared.artifact.file);
  if (!isWithin(preparedDirectory, resolvedArtifact)) throw new Error(`Prepared promotion artifact escapes its directory: ${prepared.candidateId}`);
  const record: PromotionRepositoryRecord = {
    ...selection,
    artifactFile: resolvedArtifact,
    method: prepared.method,
    candidateHeadCommit: prepared.candidateHeadCommit,
    expectedTree: prepared.targetExpectedTree,
    desiredTree: prepared.desiredTree,
    targetGitDevice: prepared.targetGitDevice,
    targetGitInode: prepared.targetGitInode,
    checkedOut: false,
    status: "pending"
  };
  const targetRepo = validateTargetIdentity(record, runner, targetRoot);
  if (targetRefCommit(record, runner) !== record.expectedCommit) throw new Error(`Target ref moved before promotion: ${record.targetRef}`);
  assertRepositoryPolicy(record, runner);
  record.checkedOut = targetRefCheckedOutHere(record, runner);
  if (!repositoryStatusClean(targetRepo, runner)) throw new Error(`Target repository is dirty before promotion: ${targetRepo}`);
  if (record.checkedOut && checkedOutWorktreeState(record, runner) !== "expected") throw new Error(`Checked-out target is not at its exact expected state: ${targetRepo}`);
  return record;
}

function bindSelectionsToManifest(selections: readonly WorkerFoldPromotionSelection[], manifest: PreparedWorkerFoldManifest): void {
  if (selections.length !== manifest.repositories.length) throw new Error("worker_fold_promote must authorize every repository in the prepared manifest.");
  const byId = new Map(selections.map((selection) => [selection.candidateId, selection]));
  if (byId.size !== selections.length) throw new Error("worker_fold_promote candidate IDs must be unique.");
  for (const repository of manifest.repositories) {
    const selection = byId.get(repository.candidateId);
    if (!selection || !repository.desiredCommit) throw new Error(`worker_fold_promote is missing prepared repository ${repository.candidateId}.`);
    if (path.resolve(selection.targetRepo) !== path.resolve(repository.targetRepo) || selection.targetRef !== repository.targetRef || selection.expectedCommit !== repository.targetExpectedCommit || selection.desiredCommit !== repository.desiredCommit) {
      throw new Error(`worker_fold_promote authorization does not exactly match prepared repository ${repository.candidateId}.`);
    }
  }
}

function validateJournalManifestBinding(journal: WorkerFoldPromotionJournal, manifest: PreparedWorkerFoldManifest, foldsRoot: string): void {
  if (journal.repositories.length !== manifest.order.length) throw new Error("Worker fold promotion journal repository count no longer matches its prepared manifest.");
  for (let index = 0; index < manifest.order.length; index += 1) {
    const prepared = manifest.repositories.find((repository) => repository.candidateId === manifest.order[index])!;
    const recorded = journal.repositories[index]!;
    const artifactFile = path.resolve(foldsRoot, manifest.preparedId, prepared.artifact.file);
    if (!prepared.desiredCommit || !prepared.desiredTree || recorded.candidateId !== prepared.candidateId || recorded.artifactFile !== artifactFile || recorded.method !== prepared.method || recorded.candidateHeadCommit !== prepared.candidateHeadCommit || recorded.expectedTree !== prepared.targetExpectedTree || recorded.desiredTree !== prepared.desiredTree || recorded.targetGitDevice !== prepared.targetGitDevice || recorded.targetGitInode !== prepared.targetGitInode || recorded.expectedCommit !== prepared.targetExpectedCommit || recorded.desiredCommit !== prepared.desiredCommit) {
      throw new Error(`Worker fold promotion journal mechanical binding mismatch: ${prepared.candidateId}`);
    }
  }
}

function validatePromotionRequest(value: WorkerFoldPromotionRequest): WorkerFoldPromotionRequest {
  if (!isRecordWithOnlyKeys(value, ["preparedId", "manifestSha256", "repositories"]) || typeof value.preparedId !== "string" || !PREPARED_ID_PATTERN.test(value.preparedId) || typeof value.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.manifestSha256) || !Array.isArray(value.repositories) || value.repositories.length < 1 || value.repositories.length > MAX_REPOSITORIES) {
    throw new Error("worker_fold_promote requires a prepared ID/hash and 1..16 exact repository authorizations.");
  }
  return {
    preparedId: value.preparedId,
    manifestSha256: value.manifestSha256,
    repositories: value.repositories.map((repository) => {
      if (!isRecordWithOnlyKeys(repository, ["candidateId", "targetRepo", "targetRef", "expectedCommit", "desiredCommit"]) || typeof repository.candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(repository.candidateId) || typeof repository.targetRepo !== "string" || !path.isAbsolute(repository.targetRepo) || Buffer.byteLength(repository.targetRepo, "utf8") > 1024 || typeof repository.targetRef !== "string" || !TARGET_REF_PATTERN.test(repository.targetRef) || typeof repository.expectedCommit !== "string" || !OID_PATTERN.test(repository.expectedCommit) || typeof repository.desiredCommit !== "string" || !OID_PATTERN.test(repository.desiredCommit)) {
        throw new Error("worker_fold_promote contains an invalid exact repository authorization.");
      }
      return {
        candidateId: repository.candidateId,
        targetRepo: path.resolve(repository.targetRepo),
        targetRef: repository.targetRef,
        expectedCommit: repository.expectedCommit,
        desiredCommit: repository.desiredCommit
      };
    })
  };
}

function promotionIdentity(request: WorkerFoldPromotionRequest): string {
  return `promotion_${sha256(Buffer.from(JSON.stringify(request))).slice(0, 24)}`;
}

function acquireTargetLocks(promotionsRoot: string, repositories: readonly WorkerFoldPromotionSelection[]): WorkerOperationLock[] {
  const locks: WorkerOperationLock[] = [];
  const lockRoot = path.join(promotionsRoot, ".locks");
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  requireCanonicalOwnerDirectory(lockRoot, "worker promotion lock root");
  try {
    const targets = [...new Set(repositories.map((repository) => path.resolve(repository.targetRepo)))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const target of targets) {
      locks.push(acquireWorkerOperationLock(path.join(lockRoot, `${sha256(Buffer.from(target))}.lock`)));
    }
    return locks;
  } catch (error) {
    for (const lock of locks.reverse()) releaseWorkerOperationLock(lock);
    throw error;
  }
}

function validateTargetIdentity(repository: PromotionRepositoryRecord, runner: GitRunner, targetRoot: string): string {
  const targetRepo = requireCanonicalDirectory(repository.targetRepo, "promotion target repository");
  if (targetRepo === targetRoot || !isWithin(targetRoot, targetRepo)) throw new Error(`Promotion target must be below the accepted local target root: ${targetRepo}`);
  const marker = statSync(path.join(targetRepo, ".git"), { bigint: true });
  if (marker.dev.toString() !== repository.targetGitDevice || marker.ino.toString() !== repository.targetGitInode) throw new Error(`Promotion target repository identity changed: ${targetRepo}`);
  return targetRepo;
}

function targetRefCommit(repository: PromotionRepositoryRecord, runner: GitRunner): string {
  const current = gitText(runner, repository.targetRepo, ["show-ref", "--verify", "--hash", repository.targetRef]).trim();
  if (!OID_PATTERN.test(current)) throw new Error(`Promotion target ref is not an exact commit: ${repository.targetRef}`);
  return current;
}

function assertRepositoryPolicy(repository: PromotionRepositoryRecord, runner: GitRunner): void {
  const issues = repositoryPolicyIssues(repository.targetRepo, runner);
  if (issues.length > 0) throw new Error(`Promotion target repository policy is unsupported: ${issues.join(",")}`);
  const expectedTree = gitText(runner, repository.targetRepo, ["rev-parse", `${repository.expectedCommit}^{tree}`]).trim();
  if (expectedTree !== repository.expectedTree) throw new Error(`Promotion target expected tree changed: ${repository.targetRepo}`);
}

function targetRefCheckedOutHere(repository: PromotionRepositoryRecord, runner: GitRunner): boolean {
  const worktrees = parseWorktrees(gitBuffer(runner, repository.targetRepo, ["worktree", "list", "--porcelain", "-z"]));
  const checkedOut = worktrees.filter((worktree) => worktree.branch === repository.targetRef);
  if (checkedOut.length > 1) throw new Error(`Promotion target ref is checked out in multiple worktrees: ${repository.targetRef}`);
  if (checkedOut.length === 0) return false;
  const checkoutPath = requireCanonicalDirectory(checkedOut[0]!.path, "promotion target checked-out worktree");
  if (checkoutPath !== repository.targetRepo) throw new Error(`Promotion target ref is checked out in an unauthorized linked worktree: ${checkoutPath}`);
  return true;
}

function assertWorktreeTopology(repository: PromotionRepositoryRecord, runner: GitRunner): void {
  if (targetRefCheckedOutHere(repository, runner) !== repository.checkedOut) {
    throw new Error(`Promotion target checked-out worktree topology changed: ${repository.targetRepo}`);
  }
}

function parseWorktrees(output: Buffer): Array<{ path: string; branch?: string }> {
  const fields = output.toString("utf8").split("\0");
  const worktrees: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;
  for (const field of fields) {
    if (field.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: field.slice("worktree ".length) };
    } else if (field.startsWith("branch ") && current) {
      current.branch = field.slice("branch ".length);
    }
  }
  if (current) worktrees.push(current);
  if (worktrees.length < 1 || worktrees.some((worktree) => !path.isAbsolute(worktree.path))) throw new Error("Promotion target returned an invalid worktree inventory.");
  return worktrees;
}

function symbolicHead(targetRepo: string, runner: GitRunner): string | undefined {
  const result = runGit(runner, targetRepo, ["symbolic-ref", "-q", "HEAD"], { allowedStatuses: [0, 1] });
  return result.status === 0 ? result.stdout.toString("utf8").trim() : undefined;
}

function repositoryStatusClean(targetRepo: string, runner: GitRunner): boolean {
  return gitBuffer(runner, targetRepo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]).byteLength === 0;
}

function checkedOutWorktreeState(repository: PromotionRepositoryRecord, runner: GitRunner): "expected" | "desired" | "other" {
  if (symbolicHead(repository.targetRepo, runner) !== repository.targetRef) return "other";
  const indexTree = gitText(runner, repository.targetRepo, ["write-tree"]).trim();
  const untracked = gitBuffer(runner, repository.targetRepo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const expectedDiff = runGit(runner, repository.targetRepo, ["diff", "--quiet", "--no-ext-diff", repository.expectedCommit, "--"], { allowedStatuses: [0, 1] }).status;
  if (indexTree === repository.expectedTree && untracked.byteLength === 0 && expectedDiff === 0) return "expected";
  const desiredDiff = runGit(runner, repository.targetRepo, ["diff", "--quiet", "--no-ext-diff", repository.desiredCommit, "--"], { allowedStatuses: [0, 1] }).status;
  if (indexTree === repository.desiredTree && untracked.byteLength === 0 && desiredDiff === 0) return "desired";
  return "other";
}

function assertRepositoryPreCasClean(repository: PromotionRepositoryRecord, runner: GitRunner): void {
  assertWorktreeTopology(repository, runner);
  if (targetRefCommit(repository, runner) !== repository.expectedCommit) throw new Error(`Promotion target ref moved before CAS: ${repository.targetRef}`);
  if (repository.checkedOut) {
    if (checkedOutWorktreeState(repository, runner) !== "expected") throw new Error(`Checked-out promotion target changed before CAS: ${repository.targetRepo}`);
  } else if (!repositoryStatusClean(repository.targetRepo, runner)) {
    throw new Error(`Promotion target worktree changed before CAS: ${repository.targetRepo}`);
  }
}

function importAndVerifyObjects(repository: PromotionRepositoryRecord, runner: GitRunner): void {
  gitBuffer(runner, repository.targetRepo, ["bundle", "unbundle", repository.artifactFile]);
  gitBuffer(runner, repository.targetRepo, ["cat-file", "-e", `${repository.desiredCommit}^{commit}`]);
  const desiredTree = gitText(runner, repository.targetRepo, ["rev-parse", `${repository.desiredCommit}^{tree}`]).trim();
  if (desiredTree !== repository.desiredTree) throw new Error(`Imported promotion desired tree mismatch: ${repository.targetRepo}`);
  const parents = repositoryCommitParents(repository.targetRepo, repository.desiredCommit, runner);
  const expectedParents = repository.method === "merge" ? [repository.expectedCommit, repository.candidateHeadCommit] : [repository.expectedCommit];
  if (JSON.stringify(parents) !== JSON.stringify(expectedParents)) throw new Error(`Imported promotion desired commit has the wrong exact parent shape: ${repository.targetRepo}`);
  if (repositoryTreePolicyIssues(repository.targetRepo, repository.desiredCommit, runner).length > 0) throw new Error(`Imported promotion desired tree policy is unsupported: ${repository.targetRepo}`);
  gitBuffer(runner, repository.targetRepo, ["fsck", "--strict", "--connectivity-only", "--no-dangling", repository.desiredCommit]);
}

function verifyCompletedRef(repository: PromotionRepositoryRecord, runner: GitRunner, targetRoot: string): void {
  validateTargetIdentity(repository, runner, targetRoot);
  if (targetRefCommit(repository, runner) !== repository.desiredCommit) throw new Error(`Completed promotion target ref no longer matches desired commit: ${repository.targetRef}`);
}

function verifyCompletedRepository(repository: PromotionRepositoryRecord, runner: GitRunner, targetRoot: string): void {
  verifyCompletedRef(repository, runner, targetRoot);
  assertWorktreeTopology(repository, runner);
  if (repository.checkedOut) {
    if (checkedOutWorktreeState(repository, runner) !== "desired") throw new Error(`Completed promotion checked-out worktree is not synchronized: ${repository.targetRepo}`);
  } else if (!repositoryStatusClean(repository.targetRepo, runner)) {
    throw new Error(`Completed promotion repository became dirty: ${repository.targetRepo}`);
  }
}


function markQuarantined(journal: WorkerFoldPromotionJournal, journalFile: string, index: number, message: string, now: () => Date): void {
  const repository = journal.repositories[index]!;
  repository.status = "quarantined";
  repository.error = message;
  journal.status = "quarantined";
  journal.error = message;
  journal.updatedAt = now().toISOString();
  persistPromotionJournal(journalFile, journal);
}

function quarantine(journal: WorkerFoldPromotionJournal, journalFile: string, index: number, message: string, now: () => Date): never {
  markQuarantined(journal, journalFile, index, message, now);
  throw new Error(message);
}

function recoverUnjournaledPromotionDirectory(directory: string): void {
  if (!existsSync(directory)) return;
  const canonical = requireCanonicalOwnerDirectory(directory, "unjournaled worker promotion directory");
  for (const entry of readdirSync(canonical)) {
    if (!/^\.journal-\d+-[0-9a-f-]+\.tmp$/.test(entry)) throw new Error(`Worker fold promotion directory exists without a recoverable journal: ${path.basename(directory)}`);
    const temporary = path.join(canonical, entry);
    const item = lstatSync(temporary);
    if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.size > MAX_JOURNAL_BYTES || (item.mode & 0o077) !== 0) throw new Error("Unjournaled worker promotion contains an unsafe temporary journal.");
    unlinkSync(temporary);
  }
  fsyncDirectory(canonical);
}

function persistPromotionJournal(file: string, journal: WorkerFoldPromotionJournal): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.journal-${process.pid}-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
  fsyncPath(file);
  fsyncDirectory(directory);
}

function readPromotionJournal(file: string, request: WorkerFoldPromotionRequest, parentSessionFile: string): WorkerFoldPromotionJournal {
  const journal = readPromotionJournalFile(file);
  if (journal.promotionId !== promotionIdentity(request) || journal.preparedId !== request.preparedId || journal.manifestSha256 !== request.manifestSha256 || path.resolve(journal.parentSessionFile) !== path.resolve(parentSessionFile)) {
    throw new Error("Worker fold promotion journal does not match this exact request/session.");
  }
  if (JSON.stringify(journal.repositories.map(({ candidateId, targetRepo, targetRef, expectedCommit, desiredCommit }) => ({ candidateId, targetRepo, targetRef, expectedCommit, desiredCommit }))) !== JSON.stringify(request.repositories)) {
    throw new Error("Worker fold promotion journal repository authorization mismatch.");
  }
  return journal;
}

function readPromotionJournalFile(file: string): WorkerFoldPromotionJournal {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_JOURNAL_BYTES || (metadata.mode & 0o077) !== 0) throw new Error("Worker fold promotion journal is not a bounded owner-only single-link file.");
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isPromotionJournal(value)) throw new Error("Worker fold promotion journal failed strict validation.");
  return value;
}

function isPromotionJournal(value: unknown): value is WorkerFoldPromotionJournal {
  if (!isRecordWithOnlyKeys(value, ["version", "promotionId", "preparedId", "manifestSha256", "parentSessionFile", "createdAt", "updatedAt", "status", "repositories", "error"])) return false;
  const journal = value as Partial<WorkerFoldPromotionJournal>;
  if (
    journal.version !== PROMOTION_VERSION ||
    typeof journal.promotionId !== "string" || !PROMOTION_ID_PATTERN.test(journal.promotionId) ||
    typeof journal.preparedId !== "string" || !PREPARED_ID_PATTERN.test(journal.preparedId) ||
    typeof journal.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(journal.manifestSha256) ||
    typeof journal.parentSessionFile !== "string" || !path.isAbsolute(journal.parentSessionFile) || Buffer.byteLength(journal.parentSessionFile, "utf8") > 2048 ||
    typeof journal.createdAt !== "string" || !validTimestamp(journal.createdAt) ||
    typeof journal.updatedAt !== "string" || !validTimestamp(journal.updatedAt) ||
    !["promoting", "partial", "completed", "quarantined"].includes(String(journal.status)) ||
    (journal.error !== undefined && (typeof journal.error !== "string" || Buffer.byteLength(journal.error, "utf8") > 1000)) ||
    !Array.isArray(journal.repositories) || journal.repositories.length < 1 || journal.repositories.length > MAX_REPOSITORIES
  ) return false;
  const candidateIds = new Set<string>();
  for (const repository of journal.repositories) {
    if (!isRecordWithOnlyKeys(repository, ["candidateId", "targetRepo", "targetRef", "expectedCommit", "desiredCommit", "artifactFile", "method", "candidateHeadCommit", "expectedTree", "desiredTree", "targetGitDevice", "targetGitInode", "checkedOut", "status", "error"])) return false;
    if (
      typeof repository.candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(repository.candidateId) || candidateIds.has(repository.candidateId) ||
      typeof repository.targetRepo !== "string" || !path.isAbsolute(repository.targetRepo) || Buffer.byteLength(repository.targetRepo, "utf8") > 2048 ||
      typeof repository.targetRef !== "string" || !TARGET_REF_PATTERN.test(repository.targetRef) ||
      typeof repository.expectedCommit !== "string" || !OID_PATTERN.test(repository.expectedCommit) ||
      typeof repository.desiredCommit !== "string" || !OID_PATTERN.test(repository.desiredCommit) ||
      typeof repository.artifactFile !== "string" || !path.isAbsolute(repository.artifactFile) || Buffer.byteLength(repository.artifactFile, "utf8") > 2048 ||
      (repository.method !== "merge" && repository.method !== "squash") ||
      typeof repository.candidateHeadCommit !== "string" || !OID_PATTERN.test(repository.candidateHeadCommit) ||
      typeof repository.expectedTree !== "string" || !OID_PATTERN.test(repository.expectedTree) ||
      typeof repository.desiredTree !== "string" || !OID_PATTERN.test(repository.desiredTree) ||
      typeof repository.targetGitDevice !== "string" || !/^\d+$/.test(repository.targetGitDevice) ||
      typeof repository.targetGitInode !== "string" || !/^\d+$/.test(repository.targetGitInode) ||
      typeof repository.checkedOut !== "boolean" ||
      !["pending", "objects_imported", "ref_updated", "completed", "quarantined"].includes(String(repository.status)) ||
      (repository.error !== undefined && (typeof repository.error !== "string" || Buffer.byteLength(repository.error, "utf8") > 1000))
    ) return false;
    candidateIds.add(repository.candidateId);
  }
  if (journal.status === "completed" && journal.repositories.some((repository) => repository.status !== "completed")) return false;
  if (journal.status === "quarantined" && journal.repositories.every((repository) => repository.status !== "quarantined")) return false;
  return true;
}

function isRecordWithOnlyKeys(value: unknown, allowed: readonly string[]): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function summarizePromotion(journal: WorkerFoldPromotionJournal, journalFile: string): WorkerFoldPromotionSummary {
  return {
    promotionId: journal.promotionId,
    journalFile,
    status: journal.status,
    preparedId: journal.preparedId,
    manifestSha256: journal.manifestSha256,
    repositoryCount: journal.repositories.length,
    completedCount: journal.repositories.filter((repository) => repository.status === "completed").length,
    repositories: journal.repositories.map(({ candidateId, targetRepo, targetRef, expectedCommit, desiredCommit, checkedOut, status, error }) => ({
      candidateId,
      targetRepo,
      targetRef,
      expectedCommit,
      desiredCommit,
      checkedOut,
      status,
      ...(error === undefined ? {} : { error })
    }))
  };
}

function cloneJournal(journal: WorkerFoldPromotionJournal): WorkerFoldPromotionJournal {
  return { ...journal, repositories: journal.repositories.map((repository) => ({ ...repository })) };
}

function requireCanonicalDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(resolved) !== resolved) throw new Error(`${label} is not a canonical directory: ${directory}`);
  return resolved;
}

function requireCanonicalOwnerDirectory(directory: string, label: string): string {
  const canonical = requireCanonicalDirectory(directory, label);
  if ((lstatSync(canonical).mode & 0o077) !== 0) throw new Error(`${label} is not owner-only: ${directory}`);
  return canonical;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function fsyncPath(file: string): void {
  const descriptor = openSync(file, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Worker fold promotion cancelled.");
}

function boundError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= 1000) return text;
  let end = 1000;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}
