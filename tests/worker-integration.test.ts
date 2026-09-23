import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertIntegrationPristine,
  assertPreparedTargetCurrent,
  normalizeIntegrationContext,
  persistIntegrationEnvelope,
  provisionIntegrationRepository,
  snapshotIntegrationRepository,
  validateStoppedIntegrationHandoff,
  verifyIntegrationArtifact
} from "../extensions/worker/integration.js";
import type { PreparedRepositoryFold, PreparedWorkerFoldManifest } from "../extensions/worker/folds.js";
import type { WorkerIntegrationRecord } from "../extensions/worker/state.js";
import { deriveRepositoryInventory } from "../extensions/worker/repositories.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(cwd: string, message: string): string {
  git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD^{commit}");
}
async function withTemp(run: (root: string) => Promise<void>): Promise<void> {
  const raw = await mkdtemp(path.join(tmpdir(), "pi-worker-integration-"));
  const root = await realpath(raw);
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function fixture(root: string): Promise<{ selection: { manifest: PreparedWorkerFoldManifest; repository: PreparedRepositoryFold; preparedDirectory: string }; target: string }> {
  const target = path.join(root, "targets", "project");
  const candidate = path.join(root, "candidate");
  const preparedDirectory = path.join(root, "folds", "prepared_aaaaaaaaaaaaaaaaaaaaaaaa");
  const artifactDirectory = path.join(preparedDirectory, "repositories", "01");
  const assembly = path.join(root, "assembly");
  await mkdir(target, { recursive: true });
  git(target, "init", "--initial-branch=main");
  await writeFile(path.join(target, "shared.txt"), "base\n"); git(target, "add", "shared.txt"); const base = commit(target, "base");
  const baseTree = git(target, "rev-parse", "HEAD^{tree}");
  git(root, "clone", "--no-hardlinks", target, candidate);
  await writeFile(path.join(candidate, "shared.txt"), "candidate\n"); git(candidate, "add", "shared.txt"); const candidateHead = commit(candidate, "candidate");
  const candidateTree = git(candidate, "rev-parse", "HEAD^{tree}");
  await writeFile(path.join(target, "shared.txt"), "target\n"); git(target, "add", "shared.txt"); const targetHead = commit(target, "target");
  const targetTree = git(target, "rev-parse", "HEAD^{tree}");
  await mkdir(artifactDirectory, { recursive: true }); await mkdir(assembly, { recursive: true }); git(assembly, "init", "--initial-branch=main");
  git(assembly, "fetch", target, `${targetHead}:refs/worker-fold/target`);
  git(assembly, "fetch", candidate, `${candidateHead}:refs/worker-fold/candidate`);
  const artifact = path.join(artifactDirectory, "prepared-objects.bundle");
  git(assembly, "bundle", "create", artifact, "refs/worker-fold/target", "refs/worker-fold/candidate");
  chmodSync(artifact, 0o400);
  const artifactSha256 = createHash("sha256").update(await readFile(artifact)).digest("hex");
  const repository: PreparedRepositoryFold = {
    candidateId: "candidate_bbbbbbbbbbbbbbbbbbbbbbbb", workerId: "worker_20260923000000_aaaaaaaa", runId: "run_20260923000000_bbbbbbbb", workspaceRepo: "repos/source", candidateReported: true,
    candidateBaseCommit: base, candidateBaseTree: baseTree, candidateHeadCommit: candidateHead, candidateHeadTree: candidateTree, candidateDirty: false,
    candidateInventory: { inventoryFile: "repositories/01/candidate-inventory.json", inventorySha256: "c".repeat(64), reportedIssues: [], scanCoverage: { complete: true, limitations: [] } },
    targetRepo: target, targetRef: "refs/heads/main", targetGitDevice: "0", targetGitInode: "0", targetExpectedCommit: targetHead, targetExpectedTree: targetTree,
    mergeBase: base, method: "merge", purpose: "resolve conflict", dependsOn: [], status: "resolution_required",
    artifact: { file: "repositories/01/prepared-objects.bundle", sha256: artifactSha256, heads: { target: { ref: "refs/worker-fold/target", oid: targetHead }, candidate: { ref: "refs/worker-fold/candidate", oid: candidateHead } }, prerequisites: [] },
    viewPath: "repositories/01/view"
  };
  const marker = await import("node:fs/promises").then(({ stat }) => stat(path.join(target, ".git"), { bigint: true }));
  repository.targetGitDevice = marker.dev.toString(); repository.targetGitInode = marker.ino.toString();
  const manifest = { version: 1, preparedId: "prepared_aaaaaaaaaaaaaaaaaaaaaaaa", manifestSha256: "a".repeat(64), parentSessionFile: path.join(root, "parent.jsonl"), createdAt: new Date().toISOString(), status: "resolution_required", order: [repository.candidateId], repositories: [repository], overlaps: [], resolutionCases: [{ candidateId: repository.candidateId, targetRepo: target, targetRef: repository.targetRef, kind: "merge_conflict", summary: "conflict" }] } as PreparedWorkerFoldManifest;
  return { target, selection: { manifest, repository, preparedDirectory } };
}

test("provisions exact isolated integration inputs and enforces pristine analysis", async () => withTemp(async (root) => {
  const { selection, target } = await fixture(root);
  const evidence = path.join(target, "shared.txt");
  const evidenceLink = path.join(target, "evidence-link.txt"); await symlink(evidence, evidenceLink);
  assert.throws(() => normalizeIntegrationContext({ decisions: ["x"], projectRules: [], acceptanceCriteria: [], dependencies: [], candidateRationale: [], candidateChecks: [], reviewFindings: [], invariants: [], nonGoals: [], priorities: [], openQuestions: [], authorResponses: [], evidencePaths: [evidenceLink] }, path.join(root, "targets")), /symbolic links|single-link regular file/);
  assert.throws(() => verifyIntegrationArtifact("/dev/zero", "0".repeat(64)), /bounded single-link regular file/);
  const context = normalizeIntegrationContext(Object.fromEntries(["decisions","projectRules","acceptanceCriteria","dependencies","candidateRationale","candidateChecks","reviewFindings","invariants","nonGoals","priorities","openQuestions","authorResponses"].map((key) => [key, [key]]).concat([["evidencePaths", [evidence]]])), path.join(root, "targets"));
  assert.equal(context.evidencePaths[0], evidence);
  const state = path.join(root, "state"); const workspace = path.join(root, "workspace");
  await mkdir(path.join(workspace, "artifacts"), { recursive: true });
  const artifact = persistIntegrationEnvelope({ destination: path.join(state, "context.json"), workspaceCopy: path.join(workspace, "artifacts", "context.json"), value: { context } });
  verifyIntegrationArtifact(artifact.file, artifact.sha256); verifyIntegrationArtifact(artifact.workspaceFile, artifact.sha256);
  const repositoryPath = path.join(workspace, "repos", "integration");
  const provisioned = provisionIntegrationRepository({ selection, repositoryPath, trustedStateRoot: path.join(state, "git"), context, artifactsDir: path.join(workspace, "artifacts") });
  const repeatedWorkspace = path.join(root, "repeated-workspace"); await mkdir(path.join(repeatedWorkspace, "artifacts"), { recursive: true });
  const repeatedRepository = path.join(repeatedWorkspace, "repos", "integration");
  const repeated = provisionIntegrationRepository({ selection, repositoryPath: repeatedRepository, trustedStateRoot: path.join(root, "repeated-state", "git"), context, artifactsDir: path.join(repeatedWorkspace, "artifacts") });
  assert.equal(repeated.snapshot.headCommit, provisioned.snapshot.headCommit);
  assert.equal(git(repeatedRepository, "rev-parse", "refs/heads/integration-candidate"), selection.repository.candidateHeadCommit);
  assert.equal(git(repositoryPath, "rev-parse", "HEAD"), selection.repository.targetExpectedCommit);
  assert.equal(git(repositoryPath, "rev-parse", "refs/heads/integration-candidate"), selection.repository.candidateHeadCommit);
  assert.equal(git(repositoryPath, "config", "--get", "remote.origin.pushurl"), "/dev/null");
  const integration: WorkerIntegrationRecord = { phase: "analysis", preparedId: selection.manifest.preparedId, manifestSha256: selection.manifest.manifestSha256, candidateId: selection.repository.candidateId, method: selection.repository.method, sourceCandidateIds: [selection.repository.candidateId], targetRepo: target, targetRef: selection.repository.targetRef, targetExpectedCommit: selection.repository.targetExpectedCommit, targetExpectedTree: selection.repository.targetExpectedTree, candidateHeadCommit: selection.repository.candidateHeadCommit, candidateHeadTree: selection.repository.candidateHeadTree, preparedArtifactFile: path.join(selection.preparedDirectory, selection.repository.artifact.file), analysisIndexFile: provisioned.analysisIndexFile, analysisIndexSha256: provisioned.analysisIndexSha256, evidence: [], workspaceRepo: "repos/integration", contextFile: artifact.file, workspaceContextFile: artifact.workspaceFile, contextSha256: artifact.sha256, analysisRunId: "run_20260923000000_aaaaaaaa", analysisSnapshot: provisioned.snapshot };
  assertIntegrationPristine(integration, workspace, path.join(state, "git"));
  git(repositoryPath, "status", "--porcelain=v1");
  assertIntegrationPristine(integration, workspace, path.join(state, "git"));
  let objectStream = "";
  for (let index = 0; index < 25_100; index += 1) { const value = `unreferenced-${index}\n`; objectStream += `blob\nmark :${index + 1}\ndata ${Buffer.byteLength(value)}\n${value}`; }
  objectStream += "done\n";
  const imported = spawnSync("git", ["fast-import", "--quiet"], { cwd: repositoryPath, input: objectStream, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" } });
  assert.equal(imported.status, 0, imported.stderr);
  assertIntegrationPristine(integration, workspace, path.join(state, "git"));
  validateStoppedIntegrationHandoff({ state: "checkpoint", summary: "plan", taskUpdates: [] }, integration, workspace, path.join(state, "git"));
  validateStoppedIntegrationHandoff({ state: "blocked", summary: "terminal blocker", taskUpdates: [] }, integration, workspace, path.join(state, "git"));
  assert.throws(() => validateStoppedIntegrationHandoff({ state: "ready_for_review", summary: "wrong", taskUpdates: [] }, integration, workspace, path.join(state, "git")), /checkpoint, needs_input/);
  await writeFile(path.join(repositoryPath, ".git", "logs", "HEAD"), "forged reflog\n", { flag: "a" });
  assert.throws(() => assertIntegrationPristine(integration, workspace, path.join(state, "git")), /mutated/);
}));

test("rejects context tampering and moved targets", async () => withTemp(async (root) => {
  const { selection, target } = await fixture(root);
  const workspace = path.join(root, "workspace"); await mkdir(path.join(workspace, "artifacts"), { recursive: true });
  const artifact = persistIntegrationEnvelope({ destination: path.join(root, "state", "context.json"), workspaceCopy: path.join(workspace, "artifacts", "context.json"), value: { decisions: ["x"] } });
  chmodSync(artifact.workspaceFile, 0o600); await writeFile(artifact.workspaceFile, "poisoned");
  assert.throws(() => verifyIntegrationArtifact(artifact.workspaceFile, artifact.sha256), /immutable|hash/);
  const preparedArtifact = path.join(selection.preparedDirectory, selection.repository.artifact.file); chmodSync(preparedArtifact, 0o600);
  const tamperedRepo = path.join(workspace, "repos", "tampered");
  assert.throws(() => provisionIntegrationRepository({ selection, repositoryPath: tamperedRepo, trustedStateRoot: path.join(root, "tampered-git"), context: normalizeIntegrationContext({ decisions: ["test"], projectRules: [], acceptanceCriteria: [], dependencies: [], candidateRationale: [], candidateChecks: [], reviewFindings: [], invariants: [], nonGoals: [], priorities: [], openQuestions: [], authorResponses: [] }, path.join(root, "targets")), artifactsDir: path.join(workspace, "artifacts") }), /immutable owner-only|hash mismatch/);
  assert.equal(await import("node:fs/promises").then(({ stat }) => stat(tamperedRepo).then(() => true, () => false)), false);
  assertPreparedTargetCurrent(selection.repository, path.join(root, "target-check"));
  await writeFile(path.join(target, "moved.txt"), "moved\n"); git(target, "add", "moved.txt"); commit(target, "moved");
  assert.throws(() => assertPreparedTargetCurrent(selection.repository, path.join(root, "target-check")), /moved, became dirty/);
}));


test("accepts only a clean committed resolution and emits exact integration lineage", async () => withTemp(async (root) => {
  const { selection, target } = await fixture(root);
  const workspace = path.join(root, "workspace"); const state = path.join(root, "state");
  await mkdir(path.join(workspace, "artifacts"), { recursive: true });
  const context = persistIntegrationEnvelope({ destination: path.join(state, "context.json"), workspaceCopy: path.join(workspace, "artifacts", "context.json"), value: { context: "bound" } });
  const decisions = persistIntegrationEnvelope({ destination: path.join(state, "decisions.json"), workspaceCopy: path.join(workspace, "artifacts", "decisions.json"), value: { decisions: ["resolve in favor of both"] } });
  const repositoryPath = path.join(workspace, "repos", "integration");
  const provisioned = provisionIntegrationRepository({ selection, repositoryPath, trustedStateRoot: path.join(state, "git"), context: normalizeIntegrationContext({ decisions: ["test"], projectRules: [], acceptanceCriteria: [], dependencies: [], candidateRationale: [], candidateChecks: [], reviewFindings: [], invariants: [], nonGoals: [], priorities: [], openQuestions: [], authorResponses: [] }, path.join(root, "targets")), artifactsDir: path.join(workspace, "artifacts") });
  assert.throws(() => git(repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-commit", "refs/heads/integration-candidate"), /git|conflict|failed/i);
  await writeFile(path.join(repositoryPath, "shared.txt"), "resolved\n"); git(repositoryPath, "add", "shared.txt"); commit(repositoryPath, "resolve prepared conflict");
  const integration: WorkerIntegrationRecord = {
    phase: "resolution", preparedId: selection.manifest.preparedId, manifestSha256: selection.manifest.manifestSha256,
    candidateId: selection.repository.candidateId, method: selection.repository.method, sourceCandidateIds: [selection.repository.candidateId], targetRepo: target, targetRef: selection.repository.targetRef,
    targetExpectedCommit: selection.repository.targetExpectedCommit, targetExpectedTree: selection.repository.targetExpectedTree,
    candidateHeadCommit: selection.repository.candidateHeadCommit, candidateHeadTree: selection.repository.candidateHeadTree,
    preparedArtifactFile: path.join(selection.preparedDirectory, selection.repository.artifact.file), analysisIndexFile: provisioned.analysisIndexFile, analysisIndexSha256: provisioned.analysisIndexSha256, evidence: [], workspaceRepo: "repos/integration", contextFile: context.file, workspaceContextFile: context.workspaceFile, contextSha256: context.sha256,
    analysisRunId: "run_20260923000000_aaaaaaaa", analysisSnapshot: provisioned.snapshot,
    decisionsFile: decisions.file, workspaceDecisionsFile: decisions.workspaceFile, decisionsSha256: decisions.sha256, resolutionRunId: "run_20260923000001_bbbbbbbb"
  };
  const handoff = { state: "ready_for_review" as const, summary: "resolved", taskUpdates: [], repositories: [{ workspaceRepo: "repos/integration", purpose: "resolved prepared conflict" }] };
  validateStoppedIntegrationHandoff(handoff, integration, workspace, path.join(state, "git"));
  validateStoppedIntegrationHandoff({ state: "failed", summary: "terminal failure", taskUpdates: [] }, integration, workspace, path.join(state, "git"));
  const inventory = deriveRepositoryInventory({
    workerId: "worker_20260923000000_aaaaaaaa", runId: integration.resolutionRunId!, workspaceRoot: workspace, reposRoot: path.join(workspace, "repos"),
    handoff: { version: 1, workerId: "worker_20260923000000_aaaaaaaa", runId: integration.resolutionRunId!, acceptedAt: new Date().toISOString(), handoff },
    initialRepositories: [provisioned.initialRepository], generatedAt: new Date().toISOString(), trustedStateRoot: path.join(state, "inventory"),
    integrationLineage: { workspaceRepo: integration.workspaceRepo, lineage: { kind: "integration_resolution", preparedId: integration.preparedId, manifestSha256: integration.manifestSha256, sourceCandidateIds: integration.sourceCandidateIds, contextSha256: integration.contextSha256, decisionsSha256: integration.decisionsSha256!, analysisRunId: integration.analysisRunId, resolutionWorkerId: "worker_20260923000000_aaaaaaaa", resolutionRunId: integration.resolutionRunId!, workspaceRepo: integration.workspaceRepo, targetExpectedCommit: integration.targetExpectedCommit, targetExpectedTree: integration.targetExpectedTree } }
  });
  assert.equal(inventory.candidates.length, 1); assert.equal(inventory.candidates[0]?.foldable, true);
  assert.deepEqual(inventory.candidates[0]?.lineage, { kind: "integration_resolution", preparedId: integration.preparedId, manifestSha256: integration.manifestSha256, sourceCandidateIds: integration.sourceCandidateIds, contextSha256: integration.contextSha256, decisionsSha256: integration.decisionsSha256, analysisRunId: integration.analysisRunId, resolutionWorkerId: "worker_20260923000000_aaaaaaaa", resolutionRunId: integration.resolutionRunId, workspaceRepo: integration.workspaceRepo, targetExpectedCommit: integration.targetExpectedCommit, targetExpectedTree: integration.targetExpectedTree });
  git(repositoryPath, "update-ref", "refs/heads/integration-candidate", integration.targetExpectedCommit);
  assert.throws(() => validateStoppedIntegrationHandoff(handoff, integration, workspace, path.join(state, "git")), /input refs changed/);
  assert.throws(() => validateStoppedIntegrationHandoff({ ...handoff, repositories: [...handoff.repositories, { workspaceRepo: "repos/extra", purpose: "unexpected" }] }, integration, workspace, path.join(state, "git")), /report exactly/);
}));


test("accepts exact linear squash shape and rejects candidate ancestry or merge commits", async () => withTemp(async (root) => {
  const { selection, target } = await fixture(root);
  selection.repository.method = "squash"; selection.manifest.repositories[0]!.method = "squash";
  const workspace = path.join(root, "squash-workspace"); const state = path.join(root, "squash-state");
  await mkdir(path.join(workspace, "artifacts"), { recursive: true });
  const context = persistIntegrationEnvelope({ destination: path.join(state, "context.json"), workspaceCopy: path.join(workspace, "artifacts", "context.json"), value: { context: "bound" } });
  const decisions = persistIntegrationEnvelope({ destination: path.join(state, "decisions.json"), workspaceCopy: path.join(workspace, "artifacts", "decisions.json"), value: { decisions: ["squash"] } });
  const normalized = normalizeIntegrationContext({ decisions: ["squash"], projectRules: [], acceptanceCriteria: [], dependencies: [], candidateRationale: [], candidateChecks: [], reviewFindings: [], invariants: [], nonGoals: [], priorities: [], openQuestions: [], authorResponses: [] }, path.join(root, "targets"));
  const repositoryPath = path.join(workspace, "repos", "integration");
  const provisioned = provisionIntegrationRepository({ selection, repositoryPath, trustedStateRoot: path.join(state, "git"), context: normalized, artifactsDir: path.join(workspace, "artifacts") });
  await writeFile(path.join(repositoryPath, "shared.txt"), "squashed resolution\n"); git(repositoryPath, "add", "shared.txt"); commit(repositoryPath, "squash prepared candidate");
  const integration: WorkerIntegrationRecord = {
    phase: "resolution", preparedId: selection.manifest.preparedId, manifestSha256: selection.manifest.manifestSha256, candidateId: selection.repository.candidateId, method: "squash", sourceCandidateIds: [selection.repository.candidateId], targetRepo: target, targetRef: selection.repository.targetRef,
    targetExpectedCommit: selection.repository.targetExpectedCommit, targetExpectedTree: selection.repository.targetExpectedTree, candidateHeadCommit: selection.repository.candidateHeadCommit, candidateHeadTree: selection.repository.candidateHeadTree,
    preparedArtifactFile: path.join(selection.preparedDirectory, selection.repository.artifact.file), analysisIndexFile: provisioned.analysisIndexFile, analysisIndexSha256: provisioned.analysisIndexSha256, evidence: [], workspaceRepo: "repos/integration", contextFile: context.file, workspaceContextFile: context.workspaceFile, contextSha256: context.sha256,
    analysisRunId: "run_20260923000000_cccccccc", analysisSnapshot: provisioned.snapshot, decisionsFile: decisions.file, workspaceDecisionsFile: decisions.workspaceFile, decisionsSha256: decisions.sha256, resolutionRunId: "run_20260923000001_dddddddd"
  };
  const handoff = { state: "assignment_complete" as const, summary: "squashed", taskUpdates: [], repositories: [{ workspaceRepo: "repos/integration", purpose: "squashed" }] };
  validateStoppedIntegrationHandoff(handoff, integration, workspace, path.join(state, "git"));
  git(repositoryPath, "reset", "--hard", integration.targetExpectedCommit);
  git(repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "-s", "ours", "-m", "forbidden merge", "refs/heads/integration-candidate");
  await writeFile(path.join(repositoryPath, "merge-only.txt"), "changed tree\n"); git(repositoryPath, "add", "merge-only.txt"); git(repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--amend", "--no-edit");
  assert.throws(() => validateStoppedIntegrationHandoff(handoff, integration, workspace, path.join(state, "git")), /squash resolution must be linear/);
}));
