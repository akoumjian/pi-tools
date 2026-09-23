import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveExecutable } from "../_shared/executable.js";
import type { WorkerHandoff } from "../_shared/worker-contract.js";
import type { WorkerIntegrationRecord, WorkerIntegrationSnapshot } from "./state.js";
import {
  createGitRunner,
  gitBuffer,
  gitText,
  repositoryPolicyIssues,
  repositoryTreePolicyIssues,
  runStandaloneGit,
  type InitialRepositoryPin
} from "./repositories.js";
import type { PreparedRepositoryFold, PreparedWorkerFoldManifest } from "./folds.js";

const OID_PATTERN = /^[0-9a-f]{40,64}$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CONTEXT_ITEMS = 32;
const MAX_CONTEXT_ITEM_BYTES = 4000;
const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_PREPARED_ARTIFACT_BYTES = 256 * 1024 * 1024;

export const INTEGRATION_CONTEXT_KEYS = [
  "decisions", "projectRules", "acceptanceCriteria", "dependencies", "candidateRationale",
  "candidateChecks", "reviewFindings", "invariants", "nonGoals", "priorities", "openQuestions",
  "authorResponses", "evidencePaths"
] as const;

type ContextKey = typeof INTEGRATION_CONTEXT_KEYS[number];
export type IntegrationContextBundle = Record<Exclude<ContextKey, "evidencePaths">, string[]> & { evidencePaths?: string[] };
export type NormalizedIntegrationContextBundle = Record<ContextKey, string[]>;

export type IntegrationPreparedSelection = {
  manifest: PreparedWorkerFoldManifest;
  repository: PreparedRepositoryFold;
  preparedDirectory: string;
};

export function normalizeIntegrationContext(value: unknown, targetRoot: string): NormalizedIntegrationContextBundle {
  if (!isRecord(value) || Object.keys(value).some((key) => !(INTEGRATION_CONTEXT_KEYS as readonly string[]).includes(key))) {
    throw new Error("IntegrationContextBundle contains unknown fields.");
  }
  const normalized = {} as NormalizedIntegrationContextBundle;
  for (const key of INTEGRATION_CONTEXT_KEYS) {
    const items = key === "evidencePaths" && value[key] === undefined ? [] : value[key];
    if (!Array.isArray(items) || items.length > MAX_CONTEXT_ITEMS || items.some((item) => typeof item !== "string" || !item.trim() || Buffer.byteLength(item, "utf8") > MAX_CONTEXT_ITEM_BYTES)) {
      throw new Error(`IntegrationContextBundle ${key} must contain at most ${MAX_CONTEXT_ITEMS} bounded non-empty strings.`);
    }
    if (key === "evidencePaths") {
      normalized[key] = items.map((item) => canonicalEvidencePath(item, targetRoot));
    } else {
      normalized[key] = items.map((item) => item.trim()) as never;
    }
  }
  if (INTEGRATION_CONTEXT_KEYS.filter((key) => key !== "evidencePaths").every((key) => normalized[key].length === 0)) throw new Error("IntegrationContextBundle requires parent-curated integration context.");
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_CONTEXT_BYTES) throw new Error("IntegrationContextBundle exceeds its bounded size.");
  return normalized;
}

export function persistIntegrationEnvelope(input: {
  destination: string;
  workspaceCopy: string;
  value: unknown;
}): { file: string; workspaceFile: string; sha256: string } {
  const serialized = `${JSON.stringify(input.value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONTEXT_BYTES) throw new Error("Integration context artifact exceeds its bounded size.");
  writeImmutable(input.destination, serialized);
  mkdirSync(path.dirname(input.workspaceCopy), { recursive: true, mode: 0o700 });
  copyFileSync(input.destination, input.workspaceCopy, constants.COPYFILE_EXCL);
  chmodSync(input.workspaceCopy, 0o400);
  fsyncFileAndParent(input.workspaceCopy);
  const copied = lstatSync(input.workspaceCopy);
  if (!copied.isFile() || copied.isSymbolicLink() || copied.nlink !== 1) throw new Error("Integration workspace context copy is not a single-link regular file.");
  const result = { file: path.resolve(input.destination), workspaceFile: path.resolve(input.workspaceCopy), sha256: sha256(Buffer.from(serialized)) };
  verifyIntegrationArtifact(result.file, result.sha256);
  verifyIntegrationArtifact(result.workspaceFile, result.sha256);
  return result;
}

export function verifyIntegrationArtifact(file: string, expectedHash: string): void {
  if (!SHA_PATTERN.test(expectedHash)) throw new Error("Integration artifact expected hash is invalid.");
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_CONTEXT_BYTES || (metadata.mode & 0o077) !== 0 || (metadata.mode & 0o222) !== 0) {
    throw new Error("Integration artifact is not an immutable owner-only bounded file.");
  }
  if (sha256(readFileSync(file)) !== expectedHash) throw new Error("Integration artifact hash mismatch.");
}

export function provisionIntegrationRepository(input: {
  selection: IntegrationPreparedSelection;
  repositoryPath: string;
  trustedStateRoot: string;
}): { snapshot: WorkerIntegrationSnapshot; initialRepository: InitialRepositoryPin; artifactFile: string } {
  const repository = input.selection.repository;
  const directory = path.resolve(input.repositoryPath);
  if (existsSync(directory)) throw new Error(`Integration repository already exists: ${directory}`);
  const artifact = path.resolve(input.selection.preparedDirectory, repository.artifact.file);
  if (!artifact.startsWith(`${path.resolve(input.selection.preparedDirectory)}${path.sep}`)) throw new Error("Prepared integration artifact escapes its prepared directory.");
  verifyPreparedIntegrationArtifact(artifact, repository.artifact.sha256);
  mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  const runner = createGitRunner(resolveExecutable("git"), input.trustedStateRoot);
  runStandaloneGit(runner, path.dirname(directory), ["init", "--initial-branch=integration", `--template=${runner.templateDir}`, directory]);
  gitBuffer(runner, directory, [
    "fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", artifact,
    `${repository.artifact.heads.target.ref}:refs/heads/integration-target`,
    `${repository.artifact.heads.candidate.ref}:refs/heads/integration-candidate`
  ]);
  verifyPreparedIntegrationArtifact(artifact, repository.artifact.sha256);
  const targetRef = gitText(runner, directory, ["rev-parse", "refs/heads/integration-target^{commit}"]).trim();
  const candidateRef = gitText(runner, directory, ["rev-parse", "refs/heads/integration-candidate^{commit}"]).trim();
  if (targetRef !== repository.targetExpectedCommit || candidateRef !== repository.candidateHeadCommit) throw new Error("Integration repository fetched unexpected prepared input refs.");
  gitBuffer(runner, directory, ["checkout", "-B", "integration", repository.targetExpectedCommit]);
  gitBuffer(runner, directory, ["config", "--local", "remote.origin.url", artifact]);
  gitBuffer(runner, directory, ["config", "--local", "remote.origin.pushurl", "/dev/null"]);
  gitBuffer(runner, directory, ["config", "--local", "branch.integration.remote", "."]);
  gitBuffer(runner, directory, ["config", "--local", "branch.integration.merge", "refs/heads/integration-target"]);
  gitBuffer(runner, directory, ["fsck", "--strict", "--connectivity-only", "--no-dangling", repository.targetExpectedCommit, repository.candidateHeadCommit]);
  const head = gitText(runner, directory, ["rev-parse", "HEAD^{commit}"]).trim();
  const tree = gitText(runner, directory, ["rev-parse", "HEAD^{tree}"]).trim();
  if (head !== repository.targetExpectedCommit || tree !== repository.targetExpectedTree) throw new Error("Integration repository did not materialize the exact target identity.");
  if (repositoryPolicyIssues(directory, runner).length || repositoryTreePolicyIssues(directory, head, runner).length) throw new Error("Integration repository has unsupported policy.");
  return {
    snapshot: snapshotIntegrationRepository(directory, input.trustedStateRoot),
    artifactFile: artifact,
    initialRepository: {
      source: artifact,
      revision: repository.targetExpectedCommit,
      canonicalSource: artifact,
      baseCommit: repository.targetExpectedCommit,
      baseTree: repository.targetExpectedTree,
      status: "pinned"
    }
  };
}

function verifyPreparedIntegrationArtifact(file: string, expectedHash: string): void {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_PREPARED_ARTIFACT_BYTES || (metadata.mode & 0o077) !== 0 || (metadata.mode & 0o222) !== 0) {
    throw new Error("Prepared integration artifact is not an immutable owner-only bounded file.");
  }
  if (sha256(readFileSync(file)) !== expectedHash) throw new Error("Prepared integration artifact hash mismatch.");
}

export function snapshotIntegrationRepository(repositoryPath: string, trustedStateRoot: string): WorkerIntegrationSnapshot {
  const repository = canonicalDirectory(repositoryPath, "integration repository");
  const runner = createGitRunner(resolveExecutable("git"), trustedStateRoot);
  if (repositoryPolicyIssues(repository, runner).length > 0) throw new Error("Integration repository has unsupported Git metadata or configuration.");
  const headCommit = gitText(runner, repository, ["rev-parse", "HEAD^{commit}"]).trim();
  const headTree = gitText(runner, repository, ["rev-parse", "HEAD^{tree}"]).trim();
  if (!OID_PATTERN.test(headCommit) || !OID_PATTERN.test(headTree)) throw new Error("Integration repository has invalid HEAD identity.");
  return {
    headCommit,
    headTree,
    statusSha256: commandHash(gitBuffer(runner, repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"])),
    indexSha256: commandHash(gitBuffer(runner, repository, ["ls-files", "--stage", "-z"])),
    refsSha256: commandHash(gitBuffer(runner, repository, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/"])),
    configSha256: commandHash(gitBuffer(runner, repository, ["config", "--local", "--no-includes", "--null", "--list"])),
    metadataSha256: gitMetadataHash(repository),
    objectsSha256: commandHash(gitBuffer(runner, repository, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]))
  };
}

export function assertIntegrationRecordLayout(integration: WorkerIntegrationRecord, workspaceRoot: string, stateDir: string): void {
  const workspace = path.resolve(workspaceRoot);
  const state = path.resolve(stateDir);
  const expectedRepo = `repos/integration-${integration.candidateId.slice("candidate_".length)}`;
  if (integration.workspaceRepo !== expectedRepo) throw new Error("Integration workspace repository identity is invalid.");
  if (path.resolve(integration.contextFile) !== path.join(state, "integration", "context.json") || path.resolve(integration.workspaceContextFile) !== path.join(workspace, "artifacts", "integration-context.json")) {
    throw new Error("Integration context artifact identity is invalid.");
  }
  if (integration.phase === "resolution") {
    if (!integration.resolutionRunId || !integration.decisionsFile || !integration.workspaceDecisionsFile) throw new Error("Integration decision artifact identity is incomplete.");
    if (path.resolve(integration.decisionsFile) !== path.join(state, "integration", `decisions-${integration.resolutionRunId}.json`) || path.resolve(integration.workspaceDecisionsFile) !== path.join(workspace, "artifacts", `integration-decisions-${integration.resolutionRunId}.json`)) {
      throw new Error("Integration decision artifact identity is invalid.");
    }
  }
}

export function assertIntegrationPristine(integration: WorkerIntegrationRecord, workspaceRoot: string, trustedStateRoot: string): void {
  const repository = path.resolve(workspaceRoot, integration.workspaceRepo);
  const current = snapshotIntegrationRepository(repository, trustedStateRoot);
  if (JSON.stringify(current) !== JSON.stringify(integration.analysisSnapshot)) throw new Error("Integration analysis phase mutated its pristine repository state.");
  verifyIntegrationArtifact(integration.contextFile, integration.contextSha256);
  verifyIntegrationArtifact(integration.workspaceContextFile, integration.contextSha256);
}

export function assertPreparedTargetCurrent(repository: PreparedRepositoryFold, trustedStateRoot: string): void {
  const target = canonicalDirectory(repository.targetRepo, "integration target repository");
  const marker = statSync(path.join(target, ".git"), { bigint: true });
  if (marker.dev.toString() !== repository.targetGitDevice || marker.ino.toString() !== repository.targetGitInode) throw new Error("Integration target repository physical identity moved; prepare a fresh fold.");
  const runner = createGitRunner(resolveExecutable("git"), trustedStateRoot);
  const commit = gitText(runner, target, ["show-ref", "--verify", "--hash", repository.targetRef]).trim();
  const tree = gitText(runner, target, ["rev-parse", `${commit}^{tree}`]).trim();
  const status = gitBuffer(runner, target, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  if (commit !== repository.targetExpectedCommit || tree !== repository.targetExpectedTree || status.byteLength > 0) throw new Error("Integration target moved or became dirty; prepare a fresh fold.");
}

export function validateIntegrationHandoff(handoff: WorkerHandoff, integration: WorkerIntegrationRecord, workspaceRoot: string, trustedStateRoot: string): void {
  if (integration.phase === "analysis") {
    if (handoff.state !== "checkpoint" && handoff.state !== "needs_input") throw new Error("Integration analysis must hand off checkpoint or needs_input.");
    if ((handoff.repositories?.length ?? 0) !== 0) throw new Error("Integration analysis may not report repository changes.");
    assertIntegrationPristine(integration, workspaceRoot, trustedStateRoot);
    return;
  }
  if (handoff.state !== "ready_for_review" && handoff.state !== "assignment_complete") throw new Error("Integration resolution must hand off ready_for_review or assignment_complete.");
  if (!integration.decisionsFile || !integration.decisionsSha256) throw new Error("Integration resolution is missing settled decisions.");
  verifyIntegrationArtifact(integration.contextFile, integration.contextSha256);
  verifyIntegrationArtifact(integration.workspaceContextFile, integration.contextSha256);
  verifyIntegrationArtifact(integration.decisionsFile, integration.decisionsSha256);
  if (!integration.workspaceDecisionsFile) throw new Error("Integration resolution is missing its workspace decisions copy.");
  verifyIntegrationArtifact(integration.workspaceDecisionsFile, integration.decisionsSha256);
  if (handoff.repositories?.length !== 1 || handoff.repositories[0]?.workspaceRepo !== integration.workspaceRepo) throw new Error(`Integration resolution must report exactly ${integration.workspaceRepo}.`);
  validateResolutionRepository(integration, workspaceRoot, trustedStateRoot);
}

function validateResolutionRepository(integration: WorkerIntegrationRecord, workspaceRoot: string, trustedStateRoot: string): void {
  const root = canonicalDirectory(workspaceRoot, "integration workspace");
  const candidate = path.resolve(root, integration.workspaceRepo);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !integration.workspaceRepo.startsWith("repos/")) throw new Error("Integration repository path escapes its workspace.");
  const repository = canonicalDirectory(candidate, "integration repository");
  const runner = createGitRunner(resolveExecutable("git"), trustedStateRoot);
  const policy = repositoryPolicyIssues(repository, runner);
  if (policy.length > 0) throw new Error(`Integration resolution repository policy is unsupported: ${policy.join(",")}`);
  const head = gitText(runner, repository, ["rev-parse", "HEAD^{commit}"]).trim();
  const tree = gitText(runner, repository, ["rev-parse", "HEAD^{tree}"]).trim();
  const targetRef = gitText(runner, repository, ["rev-parse", "refs/heads/integration-target^{commit}"]).trim();
  const candidateRef = gitText(runner, repository, ["rev-parse", "refs/heads/integration-candidate^{commit}"]).trim();
  if (targetRef !== integration.targetExpectedCommit || candidateRef !== integration.candidateHeadCommit) throw new Error("Integration exact input refs changed during resolution.");
  if (!OID_PATTERN.test(head) || !OID_PATTERN.test(tree) || head === integration.targetExpectedCommit || tree === integration.targetExpectedTree) throw new Error("Integration resolution must produce a new committed tree.");
  gitBuffer(runner, repository, ["merge-base", "--is-ancestor", integration.targetExpectedCommit, head]);
  if (integration.method === "merge") gitBuffer(runner, repository, ["merge-base", "--is-ancestor", integration.candidateHeadCommit, head]);
  if (repositoryTreePolicyIssues(repository, head, runner).length > 0) throw new Error("Integration resolution produced an unsupported exact tree.");
  if (gitBuffer(runner, repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]).byteLength > 0) throw new Error("Integration resolution repository must be clean at handoff.");
  const origin = gitText(runner, repository, ["config", "--local", "--get", "remote.origin.url"]).trim();
  const push = gitText(runner, repository, ["config", "--local", "--get", "remote.origin.pushurl"]).trim();
  if (origin !== integration.preparedArtifactFile || push !== "/dev/null") throw new Error("Integration resolution changed its no-push remote configuration.");
}

function gitMetadataHash(repository: string): string {
  const root = path.join(repository, ".git");
  const hash = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  const visit = (directory: string, relative: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (!relative && name === "objects") continue;
      const file = path.join(directory, name);
      const itemRelative = relative ? `${relative}/${name}` : name;
      const metadata = lstatSync(file);
      if (metadata.isSymbolicLink()) throw new Error("Integration Git metadata contains a symbolic link.");
      entries += 1; bytes += metadata.isFile() ? metadata.size : 0;
      if (entries > 20_000 || bytes > 32 * 1024 * 1024) throw new Error("Integration Git metadata exceeds pristine snapshot bounds.");
      const kind = metadata.isDirectory() ? "d" : metadata.isFile() ? "f" : "x";
      hash.update(`${kind}:${metadata.mode & 0o777}:${Buffer.byteLength(itemRelative, "utf8")}:`).update(itemRelative);
      if (metadata.isDirectory()) { visit(file, itemRelative); continue; }
      if (!metadata.isFile()) throw new Error("Integration Git metadata contains an unsupported entry.");
      const content = readFileSync(file);
      hash.update(`${content.byteLength}:`).update(content);
    }
  };
  visit(root, "");
  return hash.digest("hex");
}

function canonicalEvidencePath(value: string, targetRoot: string): string {
  if (!path.isAbsolute(value)) throw new Error(`Integration evidence path must be absolute: ${value}`);
  const root = canonicalDirectory(targetRoot, "integration evidence root");
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) throw new Error(`Integration evidence path does not exist: ${value}`);
  const canonical = realpathSync(resolved);
  const relative = path.relative(root, canonical);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Integration evidence path must be below ${root}: ${value}`);
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) throw new Error(`Integration evidence path is unsupported: ${value}`);
  return canonical;
}

function writeImmutable(file: string, content: string): void {
  const target = path.resolve(file);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (existsSync(target)) throw new Error(`Integration immutable artifact already exists: ${target}`);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
  renameSync(temporary, target);
  const descriptor = openSync(target, "r");
  try { /* opening proves a regular readable artifact before chmod */ } finally { closeSync(descriptor); }
  chmodSync(target, 0o400);
  fsyncFileAndParent(target);
}

function fsyncFileAndParent(file: string): void {
  const fileDescriptor = openSync(file, "r");
  try { fsyncSync(fileDescriptor); } finally { closeSync(fileDescriptor); }
  const directoryDescriptor = openSync(path.dirname(file), "r");
  try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
}

function canonicalDirectory(directory: string, label: string): string {
  const resolved = path.resolve(directory);
  const metadata = lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a canonical directory.`);
  const canonical = realpathSync(resolved);
  if (canonical !== resolved) throw new Error(`${label} must use its canonical path.`);
  return canonical;
}

function commandHash(value: Buffer): string { return sha256(value); }
function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
