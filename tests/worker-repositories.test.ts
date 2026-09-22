import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AcceptedWorkerHandoff } from "../extensions/_shared/worker-contract.js";
import {
  deriveRepositoryInventory,
  persistRepositoryInventory,
  pinInitialRepositories,
  readRepositoryInventory
} from "../extensions/worker/repositories.js";

const WORKER_ID = "worker_20260922170000_repocand";
const RUN_ID = "run_20260922170000_repocand";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-worker-repositories-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Worker Candidate Test",
      GIT_AUTHOR_EMAIL: "worker-candidate@example.invalid",
      GIT_COMMITTER_NAME: "Worker Candidate Test",
      GIT_COMMITTER_EMAIL: "worker-candidate@example.invalid"
    }
  }).trim();
}

async function createSource(directory: string, name: string): Promise<string> {
  const repo = path.join(directory, name);
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  await writeFile(path.join(repo, "README.md"), `${name}\n`);
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "base");
  return repo;
}

function clone(source: string, destination: string): void {
  mkdirSyncParent(destination);
  execFileSync("git", ["clone", "-q", "--no-hardlinks", source, destination], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null" }
  });
}

function mkdirSyncParent(destination: string): void {
  execFileSync("mkdir", ["-p", path.dirname(destination)]);
}

function handoff(workspaceRepo?: string): AcceptedWorkerHandoff {
  return {
    version: 1,
    workerId: WORKER_ID,
    runId: RUN_ID,
    acceptedAt: "2026-09-22T17:00:00.000Z",
    handoff: {
      state: "ready_for_review",
      summary: "Repository candidate ready.",
      taskUpdates: [],
      repositories: workspaceRepo ? [{ workspaceRepo, purpose: "Implement candidate support", dependsOn: ["repos/dependency"] }] : []
    }
  };
}

function inventoryInput(directory: string, accepted: AcceptedWorkerHandoff, pins = pinInitialRepositories([], path.join(directory, "state"))) {
  const workspaceRoot = path.join(directory, "workspace");
  return {
    workerId: WORKER_ID,
    runId: RUN_ID,
    workspaceRoot,
    reposRoot: path.join(workspaceRoot, "repos"),
    handoff: accepted,
    initialRepositories: pins,
    generatedAt: "2026-09-22T17:00:01.000Z",
    trustedStateRoot: path.join(directory, "state", "run")
  };
}

test("derives a clean reported candidate from independently pinned Git identities", async () => {
  await withTempDir(async (directory) => {
    const source = await createSource(directory, "source");
    const workspace = path.join(directory, "workspace");
    const candidateRepo = path.join(workspace, "repos", "project");
    clone(source, candidateRepo);
    const base = git(source, "rev-parse", "HEAD");
    const sourceStatus = git(source, "status", "--porcelain");
    await writeFile(path.join(candidateRepo, "feature.txt"), "feature\n");
    git(candidateRepo, "add", "feature.txt");
    git(candidateRepo, "commit", "-qm", "feature");

    const pins = pinInitialRepositories([{ source, revision: base }], path.join(directory, "state"));
    assert.equal(pins[0]?.status, "pinned");
    const inventory = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/project"), pins));
    assert.equal(inventory.candidates.length, 1);
    const candidate = inventory.candidates[0]!;
    assert.equal(candidate.reported, true);
    assert.equal(candidate.baseCommit, base);
    assert.equal(candidate.headCommit, git(candidateRepo, "rev-parse", "HEAD"));
    assert.equal(candidate.dirty, false);
    assert.equal(candidate.changed, true);
    assert.equal(candidate.foldable, true);
    assert.deepEqual(candidate.changedPaths, ["feature.txt"]);
    assert.equal(candidate.purpose, "Implement candidate support");
    assert.deepEqual(candidate.dependsOn, ["repos/dependency"]);
    assert.deepEqual(inventory.discrepancies, []);
    assert.equal(git(source, "rev-parse", "HEAD"), base);
    assert.equal(git(source, "status", "--porcelain"), sourceStatus);

    const inventoryFile = path.join(directory, "state", "runs", RUN_ID, "repository-candidates.json");
    const summary = persistRepositoryInventory(inventoryFile, inventory);
    assert.equal(summary.candidateCount, 1);
    assert.equal(summary.foldableCount, 1);
    assert.equal(summary.candidates[0]?.candidateId, candidate.candidateId);
    assert.deepEqual(readRepositoryInventory(inventoryFile, {
      workerId: WORKER_ID,
      runId: RUN_ID,
      workspaceRoot: workspace,
      sha256: summary.inventorySha256
    }), inventory);
  });
});

test("keeps dirty and unreported nested repositories visible and refuses symlink traversal", async () => {
  await withTempDir(async (directory) => {
    const firstSource = await createSource(directory, "first-source");
    const secondSource = await createSource(directory, "second-source");
    const nestedSource = await createSource(directory, "nested-source");
    const workspace = path.join(directory, "workspace");
    const dirtyRepo = path.join(workspace, "repos", "dirty");
    const unreportedRepo = path.join(workspace, "repos", "group", "unreported");
    const nestedRepo = path.join(dirtyRepo, "vendor", "nested");
    clone(firstSource, dirtyRepo);
    clone(secondSource, unreportedRepo);
    clone(nestedSource, nestedRepo);
    await writeFile(path.join(dirtyRepo, "README.md"), "dirty\n");
    await writeFile(path.join(unreportedRepo, "change.txt"), "change\n");
    await writeFile(path.join(nestedRepo, "nested.txt"), "nested\n");
    git(nestedRepo, "add", "nested.txt");
    git(nestedRepo, "commit", "-qm", "nested change");
    git(unreportedRepo, "add", "change.txt");
    git(unreportedRepo, "commit", "-qm", "change");
    const outside = await createSource(directory, "outside");
    await symlink(outside, path.join(workspace, "repos", "linked-repo"));

    const pins = pinInitialRepositories([
      { source: firstSource },
      { source: secondSource },
      { source: nestedSource }
    ], path.join(directory, "state"));
    const inventory = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/dirty"), pins));
    assert.deepEqual(inventory.candidates.map((candidate) => candidate.workspaceRepo), ["repos/dirty", "repos/dirty/vendor/nested", "repos/group/unreported"]);
    const dirty = inventory.candidates.find((candidate) => candidate.workspaceRepo === "repos/dirty")!;
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.foldable, false);
    const nested = inventory.candidates.find((candidate) => candidate.workspaceRepo === "repos/dirty/vendor/nested")!;
    assert.equal(nested.foldable, true);
    assert.equal(nested.reported, false);
    const unreported = inventory.candidates.find((candidate) => candidate.workspaceRepo === "repos/group/unreported")!;
    assert.equal(unreported.reported, false);
    assert.equal(unreported.foldable, true);
    assert.ok(inventory.discrepancies.some((item) => item.kind === "unreported_changed" && item.workspaceRepo === "repos/group/unreported"));
    assert.ok(inventory.discrepancies.some((item) => item.kind === "unreported_changed" && item.workspaceRepo === "repos/dirty/vendor/nested"));
    assert.ok(inventory.discrepancies.some((item) => item.kind === "symlink_skipped" && item.workspaceRepo === "repos/linked-repo"));
  });
});

test("marks unsupported and missing-base repositories non-foldable and reports stale identities", async () => {
  await withTempDir(async (directory) => {
    const workspace = path.join(directory, "workspace");
    const repo = path.join(workspace, "repos", "unsupported");
    await mkdir(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(repo, "file.txt"), "content\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-qm", "initial");
    git(repo, "config", "filter.danger.clean", "cat");

    const first = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/unsupported")));
    const candidate = first.candidates[0]!;
    assert.equal(candidate.foldable, false);
    assert.ok(candidate.policyIssues.includes("missing_base"));
    assert.ok(candidate.policyIssues.includes("unsupported_config:filter.danger.clean"));

    const inventoryFile = path.join(directory, "state", "repository-candidates.json");
    const summary = persistRepositoryInventory(inventoryFile, first);
    const staleId = candidate.candidateId;
    await writeFile(path.join(repo, "second.txt"), "second\n");
    git(repo, "add", "second.txt");
    git(repo, "commit", "-qm", "second");
    const second = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/unsupported")));
    assert.notEqual(second.candidates[0]?.candidateId, staleId);

    const tampered = `${await readFile(inventoryFile, "utf8")} `;
    await writeFile(inventoryFile, tampered);
    assert.throws(() => readRepositoryInventory(inventoryFile, {
      workerId: WORKER_ID,
      runId: RUN_ID,
      workspaceRoot: workspace,
      sha256: summary.inventorySha256
    }), /hash mismatch/);
  });
});

test("reports missing and non-repository handoff paths without trusting them", async () => {
  await withTempDir(async (directory) => {
    const workspace = path.join(directory, "workspace");
    await mkdir(path.join(workspace, "repos", "plain"), { recursive: true });
    const accepted = handoff("repos/plain");
    accepted.handoff.repositories!.push({ workspaceRepo: "repos/missing", purpose: "Missing" });
    const inventory = deriveRepositoryInventory(inventoryInput(directory, accepted));
    assert.equal(inventory.candidates.length, 0);
    assert.ok(inventory.discrepancies.some((item) => item.kind === "reported_not_repository" && item.workspaceRepo === "repos/plain"));
    assert.ok(inventory.discrepancies.some((item) => item.kind === "reported_missing" && item.workspaceRepo === "repos/missing"));
  });
});

test("rejects candidate-controlled Git metadata symlinks before invoking repository Git", async () => {
  await withTempDir(async (directory) => {
    const source = await createSource(directory, "metadata-source");
    const workspace = path.join(directory, "workspace");
    const repo = path.join(workspace, "repos", "poisoned");
    clone(source, repo);
    const outsideConfig = path.join(directory, "outside-config");
    await writeFile(outsideConfig, "[remote \"origin\"]\n\turl = https://secret:credential@example.invalid/repo.git\n");
    await rm(path.join(repo, ".git", "config"));
    await symlink(outsideConfig, path.join(repo, ".git", "config"));

    const inventory = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/poisoned")));
    const candidate = inventory.candidates[0]!;
    assert.equal(candidate.foldable, false);
    assert.equal(candidate.source, undefined);
    assert.ok(candidate.policyIssues.includes("git_metadata_symlink"));
    assert.ok(candidate.policyIssues.includes("missing_base"));
  });
});

test("bounds changed-path details while retaining the exact total", async () => {
  await withTempDir(async (directory) => {
    const source = await createSource(directory, "bounded-source");
    const workspace = path.join(directory, "workspace");
    const repo = path.join(workspace, "repos", "bounded");
    clone(source, repo);
    for (let index = 0; index < 140; index++) {
      await writeFile(path.join(repo, `file-${String(index).padStart(3, "0")}.txt`), `${index}\n`);
    }
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "many paths");
    const pins = pinInitialRepositories([{ source }], path.join(directory, "state"));
    const inventory = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/bounded"), pins));
    const candidate = inventory.candidates[0]!;
    assert.equal(candidate.changedPathCount, 140);
    assert.equal(candidate.changedPaths.length, 128);
    assert.equal(candidate.changedPathsTruncated, true);
    assert.equal(candidate.foldable, true);
  });
});
