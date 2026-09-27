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
  repositoryChangedPaths,
  repositoryIgnoredWorktreePaths,
  repositoryPolicyIssues,
  repositoryTreePolicyIssues,
  runGit,
  type GitRunner
} from "./repositories.js";
import { readPreparedWorkerFold, type PreparedRepositoryFold, type PreparedWorkerFoldManifest } from "./folds.js";
import { acquireWorkerOperationLock, releaseWorkerOperationLock, type WorkerOperationLock } from "./state.js";

const PROMOTION_VERSION = 2;
const MAX_REPOSITORIES = 16;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const OID_PATTERN = /^[0-9a-f]{40,64}$/;
const PREPARED_ID_PATTERN = /^prepared_[0-9a-f]{24}$/;
const PROMOTION_ID_PATTERN = /^promotion_[0-9a-f]{24}$/;
const CANDIDATE_ID_PATTERN = /^candidate_[0-9a-f]{24}$/;
const TARGET_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,239}$/;
const DURABLE_GIT_CONFIG = ["-c", "core.fsync=objects,reference,index", "-c", "core.fsyncMethod=fsync"] as const;

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

export type PromotionRepositoryStatus = "pending" | "completed" | "failed";
export type PromotionStatus = "pending" | "completed" | "failed";

export type PromotionRepositoryRecord = WorkerFoldPromotionSelection & {
  artifactFile: string;
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
  error?: string;
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

export type PromotionTestHooks = {
  beforeRepository?(index: number, repository: PromotionRepositoryRecord): void;
};

export function defaultWorkerPromotionsRoot(stateRoot: string): string {
  return path.join(path.dirname(path.resolve(stateRoot)), "worker-promotions");
}

export async function promotePreparedWorkerFold(input: {
  request: WorkerFoldPromotionRequest;
  parentSessionFile: string;
  foldsRoot: string;
  promotionsRoot: string;
  targetRoot: string;
  now(): Date;
  gitPath?: string;
  signal?: AbortSignal;
  testHooks?: PromotionTestHooks;
}): Promise<{ journal: WorkerFoldPromotionJournal; summary: WorkerFoldPromotionSummary }> {
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
    } else {
      const repositories = manifest.order.map((candidateId) => {
        const prepared = manifest.repositories.find((repository) => repository.candidateId === candidateId)!;
        const selection = request.repositories.find((repository) => repository.candidateId === candidateId)!;
        return createPromotionRecord(selection, prepared, input.foldsRoot, manifest.preparedId, runner, targetRoot);
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
        status: "pending",
        repositories
      };
      persistPromotionJournal(journalFile, journal);
    }

    const preflightFailure = preflightAllRepositories(journal, runner, targetRoot);
    if (preflightFailure) return failPromotion(journal, journalFile, preflightFailure.index, preflightFailure.error, input.now);

    for (let index = 0; index < journal.repositories.length; index += 1) {
      const repository = journal.repositories[index]!;
      if (repository.status === "completed") continue;
      try {
        await cancellationBoundary(input.signal);
        input.testHooks?.beforeRepository?.(index, { ...repository });
        promoteOneRepository(repository, runner, targetRoot);
        repository.status = "completed";
        repository.error = undefined;
        journal.status = "pending";
        journal.error = undefined;
        journal.updatedAt = input.now().toISOString();
        persistPromotionJournal(journalFile, journal);
      } catch (error) {
        return failPromotion(journal, journalFile, index, error, input.now);
      }
    }

    journal.status = "completed";
    journal.error = undefined;
    journal.updatedAt = input.now().toISOString();
    persistPromotionJournal(journalFile, journal);
    return { journal, summary: summarizePromotion(journal, journalFile) };
  } finally {
    for (const lock of locks.reverse()) releaseWorkerOperationLock(lock);
  }
}

export function readWorkerFoldPromotion(promotionsRoot: string, promotionId: string): WorkerFoldPromotionJournal {
  if (!PROMOTION_ID_PATTERN.test(promotionId)) throw new Error(`Invalid worker fold promotion ID: ${promotionId}`);
  const root = requireCanonicalDirectory(promotionsRoot, "worker promotion root");
  return readPromotionJournalFile(path.join(root, promotionId, "journal.json"));
}

function preflightAllRepositories(
  journal: WorkerFoldPromotionJournal,
  runner: GitRunner,
  targetRoot: string
): { index: number; error: unknown } | undefined {
  for (let index = 0; index < journal.repositories.length; index += 1) {
    const repository = journal.repositories[index]!;
    try {
      importAndVerifyPreparedObjects(repository, runner);
      const state = inspectRepositoryState(repository, runner, targetRoot);
      if (repository.status === "completed" && state !== "desired") {
        throw new Error(`Completed promotion target is no longer exact: ${repository.targetRef}`);
      }
      if (state !== "expected" && state !== "desired") {
        throw new Error(`Promotion target is neither the exact expected nor desired commit: ${repository.targetRef}`);
      }
      if (repository.checkedOut && state === "expected") assertNoIgnoredWorktreeCollisions(repository, runner);
      repository.error = undefined;
    } catch (error) {
      return { index, error };
    }
  }
  return undefined;
}

function promoteOneRepository(repository: PromotionRepositoryRecord, runner: GitRunner, targetRoot: string): void {
  const state = inspectRepositoryState(repository, runner, targetRoot);
  if (state === "desired") return;
  if (state !== "expected") throw new Error(`Promotion target changed before update: ${repository.targetRef}`);
  if (repository.checkedOut) {
    assertNoIgnoredWorktreeCollisions(repository, runner);
    gitBuffer(runner, repository.targetRepo, [
      ...DURABLE_GIT_CONFIG,
      "merge", "--ff-only", "--no-edit", "--no-stat", repository.desiredCommit
    ], { timeoutMs: 300_000 });
  } else {
    gitBuffer(runner, repository.targetRepo, [
      ...DURABLE_GIT_CONFIG,
      "update-ref", "--no-deref", repository.targetRef, repository.desiredCommit, repository.expectedCommit
    ], { timeoutMs: 120_000 });
  }

  if (inspectRepositoryState(repository, runner, targetRoot) !== "desired") {
    throw new Error(`Promotion did not produce the exact desired state: ${repository.targetRef}`);
  }
}

function inspectRepositoryState(
  repository: PromotionRepositoryRecord,
  runner: GitRunner,
  targetRoot: string
): "expected" | "desired" | "other" {
  validateTargetIdentity(repository, runner, targetRoot);
  assertRepositoryPolicy(repository, runner);
  assertDirectTargetRef(repository, runner);
  assertNoRepositoryOperation(repository.targetRepo);
  assertNoRepositoryLocks(repository);
  assertWorktreeTopology(repository, runner);
  if (!repositoryStatusClean(repository.targetRepo, runner)) throw new Error(`Promotion target repository is dirty: ${repository.targetRepo}`);

  const current = targetRefCommit(repository, runner);
  const currentTree = gitText(runner, repository.targetRepo, ["rev-parse", `${current}^{tree}`], { timeoutMs: 120_000 }).trim();
  let state: "expected" | "desired" | "other" = "other";
  if (current === repository.expectedCommit && currentTree === repository.expectedTree) state = "expected";
  if (current === repository.desiredCommit && currentTree === repository.desiredTree) state = "desired";
  if (repository.checkedOut) {
    if (symbolicHead(repository.targetRepo, runner) !== repository.targetRef) return "other";
    if (gitText(runner, repository.targetRepo, ["rev-parse", "HEAD^{commit}"], { timeoutMs: 120_000 }).trim() !== current) return "other";
  }
  return state;
}

function createPromotionRecord(
  selection: WorkerFoldPromotionSelection,
  prepared: PreparedRepositoryFold,
  foldsRoot: string,
  preparedId: string,
  runner: GitRunner,
  targetRoot: string
): PromotionRepositoryRecord {
  if (!prepared.desiredCommit || !prepared.desiredTree || prepared.status !== "ready") {
    throw new Error(`Prepared repository is not ready for promotion: ${prepared.candidateId}`);
  }
  const preparedDirectory = path.resolve(foldsRoot, preparedId);
  const artifactFile = path.resolve(preparedDirectory, prepared.artifact.file);
  if (!isWithin(preparedDirectory, artifactFile)) throw new Error(`Prepared promotion artifact escapes its directory: ${prepared.candidateId}`);
  const record: PromotionRepositoryRecord = {
    ...selection,
    artifactFile,
    candidateHeadCommit: prepared.candidateHeadCommit,
    expectedTree: prepared.targetExpectedTree,
    desiredTree: prepared.desiredTree,
    targetGitDevice: prepared.targetGitDevice,
    targetGitInode: prepared.targetGitInode,
    checkedOut: false,
    status: "pending"
  };
  validateTargetIdentity(record, runner, targetRoot);
  record.checkedOut = targetRefCheckedOutHere(record, runner);
  return record;
}

function importAndVerifyPreparedObjects(repository: PromotionRepositoryRecord, runner: GitRunner): void {
  gitBuffer(runner, repository.targetRepo, ["bundle", "unbundle", repository.artifactFile], { timeoutMs: 300_000 });
  gitBuffer(runner, repository.targetRepo, ["cat-file", "-e", `${repository.expectedCommit}^{commit}`], { timeoutMs: 120_000 });
  gitBuffer(runner, repository.targetRepo, ["cat-file", "-e", `${repository.desiredCommit}^{commit}`], { timeoutMs: 120_000 });
  const expectedTree = gitText(runner, repository.targetRepo, ["rev-parse", `${repository.expectedCommit}^{tree}`], { timeoutMs: 120_000 }).trim();
  const desiredTree = gitText(runner, repository.targetRepo, ["rev-parse", `${repository.desiredCommit}^{tree}`], { timeoutMs: 120_000 }).trim();
  if (expectedTree !== repository.expectedTree) throw new Error(`Imported promotion expected tree mismatch: ${repository.targetRepo}`);
  if (desiredTree !== repository.desiredTree) throw new Error(`Imported promotion desired tree mismatch: ${repository.targetRepo}`);
  const descendant = runGit(runner, repository.targetRepo, ["merge-base", "--is-ancestor", repository.expectedCommit, repository.desiredCommit], { allowedStatuses: [0, 1], timeoutMs: 120_000 });
  if (descendant.status !== 0) throw new Error(`Prepared desired commit is not a descendant of the expected target: ${repository.targetRepo}`);
  if (repositoryTreePolicyIssues(repository.targetRepo, repository.desiredCommit, runner).length > 0) {
    throw new Error(`Imported promotion desired tree policy is unsupported: ${repository.targetRepo}`);
  }
}

function failPromotion(
  journal: WorkerFoldPromotionJournal,
  journalFile: string,
  index: number,
  error: unknown,
  now: () => Date
): { journal: WorkerFoldPromotionJournal; summary: WorkerFoldPromotionSummary } {
  const bounded = boundError(error);
  const repository = journal.repositories[index]!;
  if (repository.status !== "completed") repository.status = "failed";
  repository.error = bounded;
  journal.status = "failed";
  journal.error = bounded;
  journal.updatedAt = now().toISOString();
  persistPromotionJournal(journalFile, journal);
  return { journal, summary: summarizePromotion(journal, journalFile) };
}

function bindSelectionsToManifest(selections: readonly WorkerFoldPromotionSelection[], manifest: PreparedWorkerFoldManifest): void {
  if (selections.length !== manifest.repositories.length) throw new Error("worker_fold_promote must authorize every repository in the prepared manifest.");
  const byId = new Map(selections.map((selection) => [selection.candidateId, selection]));
  if (byId.size !== selections.length) throw new Error("worker_fold_promote candidate IDs must be unique.");
  for (const repository of manifest.repositories) {
    const selection = byId.get(repository.candidateId);
    if (!selection || !repository.desiredCommit) throw new Error(`worker_fold_promote is missing prepared repository ${repository.candidateId}.`);
    if (
      path.resolve(selection.targetRepo) !== path.resolve(repository.targetRepo) ||
      selection.targetRef !== repository.targetRef ||
      selection.expectedCommit !== repository.targetExpectedCommit ||
      selection.desiredCommit !== repository.desiredCommit
    ) throw new Error(`worker_fold_promote authorization does not exactly match prepared repository ${repository.candidateId}.`);
  }
}

function validateJournalManifestBinding(journal: WorkerFoldPromotionJournal, manifest: PreparedWorkerFoldManifest, foldsRoot: string): void {
  if (journal.repositories.length !== manifest.order.length) throw new Error("Worker fold promotion journal repository count no longer matches its prepared manifest.");
  for (let index = 0; index < manifest.order.length; index += 1) {
    const prepared = manifest.repositories.find((repository) => repository.candidateId === manifest.order[index])!;
    const recorded = journal.repositories[index]!;
    const artifactFile = path.resolve(foldsRoot, manifest.preparedId, prepared.artifact.file);
    if (
      !prepared.desiredCommit || !prepared.desiredTree ||
      recorded.candidateId !== prepared.candidateId || recorded.artifactFile !== artifactFile ||
      recorded.candidateHeadCommit !== prepared.candidateHeadCommit ||
      recorded.expectedTree !== prepared.targetExpectedTree || recorded.desiredTree !== prepared.desiredTree ||
      recorded.targetGitDevice !== prepared.targetGitDevice || recorded.targetGitInode !== prepared.targetGitInode ||
      recorded.expectedCommit !== prepared.targetExpectedCommit || recorded.desiredCommit !== prepared.desiredCommit
    ) throw new Error(`Worker fold promotion journal mechanical binding mismatch: ${prepared.candidateId}`);
  }
}

function validatePromotionRequest(value: WorkerFoldPromotionRequest): WorkerFoldPromotionRequest {
  if (
    !isRecordWithOnlyKeys(value, ["preparedId", "manifestSha256", "repositories"]) ||
    typeof value.preparedId !== "string" || !PREPARED_ID_PATTERN.test(value.preparedId) ||
    typeof value.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.manifestSha256) ||
    !Array.isArray(value.repositories) || value.repositories.length < 1 || value.repositories.length > MAX_REPOSITORIES
  ) throw new Error("worker_fold_promote requires a prepared ID/hash and 1..16 exact repository authorizations.");
  return {
    preparedId: value.preparedId,
    manifestSha256: value.manifestSha256,
    repositories: value.repositories.map((repository) => {
      if (
        !isRecordWithOnlyKeys(repository, ["candidateId", "targetRepo", "targetRef", "expectedCommit", "desiredCommit"]) ||
        typeof repository.candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(repository.candidateId) ||
        typeof repository.targetRepo !== "string" || !path.isAbsolute(repository.targetRepo) || Buffer.byteLength(repository.targetRepo, "utf8") > 1024 ||
        typeof repository.targetRef !== "string" || !TARGET_REF_PATTERN.test(repository.targetRef) ||
        typeof repository.expectedCommit !== "string" || !OID_PATTERN.test(repository.expectedCommit) ||
        typeof repository.desiredCommit !== "string" || !OID_PATTERN.test(repository.desiredCommit)
      ) throw new Error("worker_fold_promote contains an invalid exact repository authorization.");
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
    const targets = [...new Set(repositories.map((repository) => path.resolve(repository.targetRepo)))].sort();
    for (const target of targets) locks.push(acquireWorkerOperationLock(path.join(lockRoot, `${sha256(Buffer.from(target))}.lock`)));
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
  if (marker.dev.toString() !== repository.targetGitDevice || marker.ino.toString() !== repository.targetGitInode) {
    throw new Error(`Promotion target repository identity changed: ${targetRepo}`);
  }
  return targetRepo;
}

function assertRepositoryPolicy(repository: PromotionRepositoryRecord, runner: GitRunner): void {
  const issues = repositoryPolicyIssues(repository.targetRepo, runner, repository.expectedCommit);
  if (issues.length > 0) throw new Error(`Promotion target repository policy is unsupported: ${issues.join(",")}`);
}

function assertDirectTargetRef(repository: PromotionRepositoryRecord, runner: GitRunner): void {
  const symbolic = runGit(runner, repository.targetRepo, ["symbolic-ref", "-q", repository.targetRef], { allowedStatuses: [0, 1], timeoutMs: 120_000 });
  if (symbolic.status === 0) throw new Error(`Promotion target ref is symbolic: ${repository.targetRef}`);
}

function assertNoRepositoryOperation(targetRepo: string): void {
  const gitDirectory = path.join(targetRepo, ".git");
  for (const marker of ["rebase-apply", "rebase-merge", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "BISECT_START"]) {
    if (existsSync(path.join(gitDirectory, marker))) throw new Error(`Promotion target has an in-progress Git operation: ${marker}`);
  }
}

function assertNoRepositoryLocks(repository: PromotionRepositoryRecord): void {
  const gitDirectory = path.join(repository.targetRepo, ".git");
  const refLock = path.join(gitDirectory, `${repository.targetRef}.lock`);
  for (const lock of ["index.lock", "HEAD.lock", "packed-refs.lock"]) {
    if (existsSync(path.join(gitDirectory, lock))) throw new Error(`Promotion target is locked: ${lock}`);
  }
  if (existsSync(refLock)) throw new Error(`Promotion target ref is locked: ${repository.targetRef}`);
}

function targetRefCommit(repository: PromotionRepositoryRecord, runner: GitRunner): string {
  const current = gitText(runner, repository.targetRepo, ["show-ref", "--verify", "--hash", repository.targetRef], { timeoutMs: 120_000 }).trim();
  if (!OID_PATTERN.test(current)) throw new Error(`Promotion target ref is not an exact commit: ${repository.targetRef}`);
  return current;
}

function targetRefCheckedOutHere(repository: PromotionRepositoryRecord, runner: GitRunner): boolean {
  const worktrees = parseWorktrees(gitBuffer(runner, repository.targetRepo, ["worktree", "list", "--porcelain", "-z"], { timeoutMs: 120_000 }));
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
    } else if (field.startsWith("branch ") && current) current.branch = field.slice("branch ".length);
  }
  if (current) worktrees.push(current);
  if (worktrees.length < 1 || worktrees.some((worktree) => !path.isAbsolute(worktree.path))) throw new Error("Promotion target returned an invalid worktree inventory.");
  return worktrees;
}

function symbolicHead(targetRepo: string, runner: GitRunner): string | undefined {
  const result = runGit(runner, targetRepo, ["symbolic-ref", "-q", "HEAD"], { allowedStatuses: [0, 1], timeoutMs: 120_000 });
  return result.status === 0 ? result.stdout.toString("utf8").trim() : undefined;
}

function repositoryStatusClean(targetRepo: string, runner: GitRunner): boolean {
  return gitBuffer(runner, targetRepo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], { timeoutMs: 120_000 }).byteLength === 0;
}

function assertNoIgnoredWorktreeCollisions(repository: PromotionRepositoryRecord, runner: GitRunner): void {
  const changed = new Map(repositoryChangedPaths(repository.targetRepo, repository.expectedCommit, repository.desiredCommit, runner).map((repositoryPath) => [foldRepositoryPath(repositoryPath), repositoryPath]));
  const ignored = new Map(repositoryIgnoredWorktreePaths(repository.targetRepo, runner).map((repositoryPath) => [foldRepositoryPath(repositoryPath), repositoryPath]));
  const changedKeys = new Set(changed.keys());
  const ignoredKeys = new Set(ignored.keys());
  for (const [key, original] of ignored) {
    if (changedKeys.has(key) || pathHasAncestorIn(key, changedKeys)) throw new Error(`Ignored worktree path collides with promotion: ${original}`);
  }
  for (const [key, original] of changed) {
    if (pathHasAncestorIn(key, ignoredKeys)) throw new Error(`Ignored worktree path collides with promotion: ${original}`);
  }
}

function foldRepositoryPath(repositoryPath: string): string {
  return repositoryPath.split("/").map((part) => part.normalize("NFD").toLowerCase()).join("/");
}

function pathHasAncestorIn(repositoryPath: string, candidates: ReadonlySet<string>): boolean {
  let separator = repositoryPath.lastIndexOf("/");
  while (separator > 0) {
    if (candidates.has(repositoryPath.slice(0, separator))) return true;
    separator = repositoryPath.lastIndexOf("/", separator - 1);
  }
  return false;
}

function recoverUnjournaledPromotionDirectory(directory: string): void {
  if (!existsSync(directory)) return;
  const canonical = requireCanonicalOwnerDirectory(directory, "unjournaled worker promotion directory");
  for (const entry of readdirSync(canonical)) {
    if (!/^\.journal-\d+-[0-9a-f-]+\.tmp$/.test(entry)) throw new Error(`Worker fold promotion directory exists without a recoverable journal: ${path.basename(directory)}`);
    const temporary = path.join(canonical, entry);
    const item = lstatSync(temporary);
    if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.size > MAX_JOURNAL_BYTES || (item.mode & 0o077) !== 0) {
      throw new Error("Unjournaled worker promotion contains an unsafe temporary journal.");
    }
    unlinkSync(temporary);
  }
  fsyncDirectory(canonical);
}

function persistPromotionJournal(file: string, journal: WorkerFoldPromotionJournal): void {
  const content = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
  if (content.byteLength > MAX_JOURNAL_BYTES) throw new Error("Worker fold promotion journal exceeds the bounded size limit.");
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.journal-${process.pid}-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, content);
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
  if (
    journal.promotionId !== promotionIdentity(request) || journal.preparedId !== request.preparedId ||
    journal.manifestSha256 !== request.manifestSha256 || journal.parentSessionFile !== path.resolve(parentSessionFile) ||
    JSON.stringify(journal.repositories.map(({ candidateId, targetRepo, targetRef, expectedCommit, desiredCommit }) => ({ candidateId, targetRepo, targetRef, expectedCommit, desiredCommit }))) !== JSON.stringify(request.repositories)
  ) throw new Error("Worker fold promotion journal does not match the exact request/session binding.");
  return journal;
}

function readPromotionJournalFile(file: string): WorkerFoldPromotionJournal {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size <= 0 || metadata.size > MAX_JOURNAL_BYTES || (metadata.mode & 0o077) !== 0) {
    throw new Error("Worker fold promotion journal is not a bounded owner-only regular file.");
  }
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("Worker fold promotion journal is not valid JSON."); }
  if (!isPromotionJournal(value)) throw new Error("Worker fold promotion journal failed strict validation.");
  return value;
}

function isPromotionJournal(value: unknown): value is WorkerFoldPromotionJournal {
  if (!isRecordWithOnlyKeys(value, ["version", "promotionId", "preparedId", "manifestSha256", "parentSessionFile", "createdAt", "updatedAt", "status", "repositories", "error"])) return false;
  if (
    value.version !== PROMOTION_VERSION || typeof value.promotionId !== "string" || !PROMOTION_ID_PATTERN.test(value.promotionId) ||
    typeof value.preparedId !== "string" || !PREPARED_ID_PATTERN.test(value.preparedId) ||
    typeof value.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.manifestSha256) ||
    typeof value.parentSessionFile !== "string" || !path.isAbsolute(value.parentSessionFile) ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
    !["pending", "completed", "failed"].includes(String(value.status)) ||
    !Array.isArray(value.repositories) || value.repositories.length < 1 || value.repositories.length > MAX_REPOSITORIES ||
    (value.error !== undefined && (typeof value.error !== "string" || Buffer.byteLength(value.error, "utf8") > 1000))
  ) return false;
  return value.repositories.every((repository) => isPromotionRepositoryRecord(repository));
}

function isPromotionRepositoryRecord(value: unknown): value is PromotionRepositoryRecord {
  if (!isRecordWithOnlyKeys(value, ["candidateId", "targetRepo", "targetRef", "expectedCommit", "desiredCommit", "artifactFile", "candidateHeadCommit", "expectedTree", "desiredTree", "targetGitDevice", "targetGitInode", "checkedOut", "status", "error"])) return false;
  return typeof value.candidateId === "string" && CANDIDATE_ID_PATTERN.test(value.candidateId) &&
    typeof value.targetRepo === "string" && path.isAbsolute(value.targetRepo) && Buffer.byteLength(value.targetRepo, "utf8") <= 1024 &&
    typeof value.targetRef === "string" && TARGET_REF_PATTERN.test(value.targetRef) &&
    typeof value.expectedCommit === "string" && OID_PATTERN.test(value.expectedCommit) &&
    typeof value.desiredCommit === "string" && OID_PATTERN.test(value.desiredCommit) &&
    typeof value.artifactFile === "string" && path.isAbsolute(value.artifactFile) &&
    typeof value.candidateHeadCommit === "string" && OID_PATTERN.test(value.candidateHeadCommit) &&
    typeof value.expectedTree === "string" && OID_PATTERN.test(value.expectedTree) &&
    typeof value.desiredTree === "string" && OID_PATTERN.test(value.desiredTree) &&
    typeof value.targetGitDevice === "string" && /^\d+$/.test(value.targetGitDevice) &&
    typeof value.targetGitInode === "string" && /^\d+$/.test(value.targetGitInode) &&
    typeof value.checkedOut === "boolean" && ["pending", "completed", "failed"].includes(String(value.status)) &&
    (value.error === undefined || (typeof value.error === "string" && Buffer.byteLength(value.error, "utf8") <= 1000));
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
    ...(journal.error ? { error: journal.error } : {}),
    repositories: journal.repositories.map((repository) => ({
      candidateId: repository.candidateId,
      targetRepo: repository.targetRepo,
      targetRef: repository.targetRef,
      expectedCommit: repository.expectedCommit,
      desiredCommit: repository.desiredCommit,
      checkedOut: repository.checkedOut,
      status: repository.status,
      ...(repository.error ? { error: repository.error } : {})
    }))
  };
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
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

async function cancellationBoundary(signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Worker fold promotion cancelled.");
}

function boundError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= 1000) return text;
  return `${encoded.subarray(0, 960).toString("utf8").replace(/\uFFFD+$/g, "")}…`;
}

function isRecordWithOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => keys.includes(key));
}
