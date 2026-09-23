import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AcceptedWorkerHandoff } from "../extensions/_shared/worker-contract.js";
import {
  createGitRunner,
  deriveRepositoryInventory,
  persistRepositoryInventory,
  pinInitialRepositories,
  readRepositoryInventory,
  repositoryDirty,
  repositoryPolicyIssues,
  repositoryTreePolicyIssues,
  runStandaloneGit
} from "../extensions/worker/repositories.js";

const WORKER_ID = "worker_20260922170000_repocand";
const RUN_ID = "run_20260922170000_repocand";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const created = await mkdtemp(path.join(tmpdir(), "pi-worker-repositories-"));
  const directory = await realpath(created);
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
    assert.equal(candidate.committedChanged, true);
    assert.equal(candidate.foldable, true);
    assert.equal(candidate.purpose, "Implement candidate support");
    assert.deepEqual(candidate.dependsOn, ["repos/dependency"]);
    assert.deepEqual(inventory.reportedIssues, []);
    assert.deepEqual(inventory.scanCoverage, { complete: true, limitations: [] });
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

test("rejects a clean candidate whose head does not descend from the pinned base", async () => {
  await withTempDir(async (directory) => {
    const source = await createSource(directory, "ancestry-source");
    const workspace = path.join(directory, "workspace");
    const repo = path.join(workspace, "repos", "unrelated");
    clone(source, repo);
    git(repo, "checkout", "-q", "--orphan", "unrelated");
    git(repo, "rm", "-q", "-rf", ".");
    await writeFile(path.join(repo, "unrelated.txt"), "unrelated\n");
    git(repo, "add", "unrelated.txt");
    git(repo, "commit", "-qm", "unrelated history");

    const pins = pinInitialRepositories([{ source }], path.join(directory, "state"));
    const inventory = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/unrelated"), pins));
    const candidate = inventory.candidates[0]!;
    assert.equal(candidate.dirty, false);
    assert.equal(candidate.committedChanged, true);
    assert.equal(candidate.foldable, false);
    assert.ok(candidate.policyIssues.includes("base_not_ancestor"));
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
    await writeFile(path.join(nestedRepo, ".gitignore"), "intentional.tmp\n");
    git(nestedRepo, "add", "nested.txt", ".gitignore");
    git(nestedRepo, "commit", "-qm", "nested change");
    await writeFile(path.join(nestedRepo, "intentional.tmp"), "scratch\n");
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
    assert.equal(nested.dirty, true);
    assert.equal(nested.reported, false);
    const unreported = inventory.candidates.find((candidate) => candidate.workspaceRepo === "repos/group/unreported")!;
    assert.equal(unreported.reported, false);
    assert.equal(unreported.foldable, true);
    assert.equal(unreported.committedChanged, true);
    assert.equal(nested.committedChanged, true);
    assert.deepEqual(inventory.reportedIssues, []);
    assert.deepEqual(inventory.scanCoverage, { complete: true, limitations: [] });
  });
});

test("fails closed on unsupported repositories and reports stale clean identities", async () => {
  await withTempDir(async (directory) => {
    const workspace = path.join(directory, "workspace");
    const repo = path.join(workspace, "repos", "unsupported");
    await mkdir(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    await writeFile(path.join(repo, "file.txt"), "content\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-qm", "initial");
    for (let index = 0; index < 65; index++) {
      git(repo, "config", `filter.danger${String(index).padStart(2, "0")}.clean`, "cat");
    }

    const first = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/unsupported")));
    const candidate = first.candidates[0]!;
    assert.equal(candidate.foldable, false);
    assert.ok(candidate.policyIssues.some((issue) => issue.startsWith("unsupported_config:filter.danger")));
    assert.ok(candidate.policyIssues.includes("policy_issues_truncated"));
    assert.ok(candidate.policyIssues.length <= 64);

    assert.equal(candidate.headCommit, undefined);

    const cleanRepo = path.join(workspace, "repos", "clean");
    await mkdir(cleanRepo, { recursive: true });
    git(cleanRepo, "init", "-q", "-b", "main");
    await writeFile(path.join(cleanRepo, "first.txt"), "first\n");
    git(cleanRepo, "add", "first.txt");
    git(cleanRepo, "commit", "-qm", "first");
    const cleanFirst = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/clean")));
    const staleId = cleanFirst.candidates.find((entry) => entry.workspaceRepo === "repos/clean")!.candidateId;
    await writeFile(path.join(cleanRepo, "second.txt"), "second\n");
    git(cleanRepo, "add", "second.txt");
    git(cleanRepo, "commit", "-qm", "second");
    const cleanSecond = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/clean")));
    assert.notEqual(cleanSecond.candidates.find((entry) => entry.workspaceRepo === "repos/clean")?.candidateId, staleId);

    const invalidInventoryFile = path.join(directory, "state", "invalid-repository-candidates.json");
    assert.throws(() => persistRepositoryInventory(invalidInventoryFile, {
      ...first,
      candidates: first.candidates.map((entry, index) => index === 0
        ? { ...entry, policyIssues: Array.from({ length: 65 }, (_, issueIndex) => `issue_${issueIndex}`) }
        : entry)
    }), /Refusing to persist an invalid/);
    assert.equal(existsSync(invalidInventoryFile), false);

    const inventoryFile = path.join(directory, "state", "repository-candidates.json");
    const summary = persistRepositoryInventory(inventoryFile, first);
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

test("bounds generated repository metadata to persisted record limits", async () => {
  await withTempDir(async (directory) => {
    const credentialSource = `https://user:password@example.invalid/${" ".repeat(2_000)}`;
    const credentialPin = pinInitialRepositories([{ source: credentialSource }], path.join(directory, "credential-state"))[0]!;
    assert.equal(credentialPin.status, "unsupported");
    assert.ok(credentialPin.source.length <= 2_048);

    const source = await createSource(directory, "bounded-metadata-source");
    const workspace = path.join(directory, "workspace");
    const repo = path.join(workspace, "repos", "bounded-metadata");
    clone(source, repo);
    const inventory = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/bounded-metadata"), [{
      source,
      canonicalSource: source,
      status: "unsupported",
      issue: "x".repeat(160)
    }]));
    const candidate = inventory.candidates[0]!;
    assert.equal(candidate.foldable, false);
    assert.ok(candidate.policyIssues.some((issue) => issue.startsWith("initial_base_unsupported:")));
    assert.ok(candidate.policyIssues.every((issue) => issue.length <= 160));
  });
});



test("repository discovery stays complete with more than twenty thousand ordinary files", async () => {
  await withTempDir(async (directory) => {
    const source = await createSource(directory, "many-files-source");
    const workspace = path.join(directory, "workspace");
    const repo = path.join(workspace, "repos", "project");
    clone(source, repo);
    await writeFile(path.join(repo, ".gitignore"), "bulk/\n");
    git(repo, "add", ".gitignore"); git(repo, "commit", "-qm", "ignore generated bulk");
    const bulk = path.join(repo, "bulk"); await mkdir(bulk);
    for (let index = 0; index < 20_100; index += 1) closeSync(openSync(path.join(bulk, `file-${String(index).padStart(5, "0")}.tmp`), "w"));
    const inventory = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/project")));
    assert.equal(inventory.candidates.length, 1);
    assert.deepEqual(inventory.scanCoverage, { complete: true, limitations: [] });
  });
});
test("reports overall incomplete scan coverage without per-path scan noise", async () => {
  await withTempDir(async (directory) => {
    const workspace = path.join(directory, "workspace");
    let nested = path.join(workspace, "repos");
    for (let depth = 0; depth < 14; depth++) {
      nested = path.join(nested, `depth-${depth}`);
      await mkdir(nested, { recursive: true });
    }
    git(nested, "init", "-q", "-b", "main");
    await writeFile(path.join(nested, "deep.txt"), "deep\n");
    git(nested, "add", "deep.txt");
    git(nested, "commit", "-qm", "deep repository");
    const workspaceRepo = path.relative(workspace, nested).replaceAll(path.sep, "/");
    const inventory = deriveRepositoryInventory(inventoryInput(directory, handoff(workspaceRepo)));
    assert.equal(inventory.candidates.length, 1);
    assert.equal(inventory.candidates[0]?.workspaceRepo, workspaceRepo);
    assert.equal(inventory.candidates[0]?.reported, true);
    assert.deepEqual(inventory.reportedIssues, []);
    assert.deepEqual(inventory.scanCoverage, { complete: false, limitations: ["depth_limit"] });
  });
});

test("reports missing and non-repository handoff paths without trusting them", async () => {
  await withTempDir(async (directory) => {
    const workspace = path.join(directory, "workspace");
    await mkdir(path.join(workspace, "repos", "plain"), { recursive: true });
    const accepted = handoff("repos/plain");
    accepted.handoff.repositories!.push(
      { workspaceRepo: "repos/missing", purpose: "Missing" },
      { workspaceRepo: ".", purpose: "Invalid root" }
    );
    const inventory = deriveRepositoryInventory(inventoryInput(directory, accepted));
    assert.equal(inventory.candidates.length, 0);
    assert.ok(inventory.reportedIssues.some((item) => item.kind === "reported_not_repository" && item.workspaceRepo === "repos/plain"));
    assert.ok(inventory.reportedIssues.some((item) => item.kind === "reported_missing" && item.workspaceRepo === "repos/missing"));
    assert.ok(inventory.reportedIssues.some((item) => item.kind === "reported_not_repository" && item.workspaceRepo === "."));
  });
});

test("reserves candidate capacity for reported repositories", async () => {
  await withTempDir(async (directory) => {
    const workspace = path.join(directory, "workspace");
    const reposRoot = path.join(workspace, "repos");
    for (let index = 0; index < 33; index++) {
      await mkdir(path.join(reposRoot, `a-unreported-${String(index).padStart(2, "0")}`, ".git"), { recursive: true });
    }
    const reportedRepo = path.join(reposRoot, "z-reported");
    await mkdir(reportedRepo, { recursive: true });
    git(reportedRepo, "init", "-q", "-b", "main");
    await writeFile(path.join(reportedRepo, "reported.txt"), "reported\n");
    git(reportedRepo, "add", "reported.txt");
    git(reportedRepo, "commit", "-qm", "reported repository");

    const inventory = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/z-reported")));
    assert.equal(inventory.candidates.length, 32);
    assert.ok(inventory.candidates.some((candidate) => candidate.workspaceRepo === "repos/z-reported" && candidate.reported));
    assert.deepEqual(inventory.reportedIssues, []);
    assert.deepEqual(inventory.scanCoverage, { complete: false, limitations: ["repository_limit"] });
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
  });
});

test("does not inherit a parent repository for an invalid nested Git directory", async () => {
  await withTempDir(async (directory) => {
    const workspace = path.join(directory, "workspace");
    const reposRoot = path.join(workspace, "repos");
    await mkdir(reposRoot, { recursive: true });
    git(reposRoot, "init", "-q", "-b", "main");
    await writeFile(path.join(reposRoot, "root.txt"), "root\n");
    git(reposRoot, "add", "root.txt");
    git(reposRoot, "commit", "-qm", "root repository");
    const phantom = path.join(reposRoot, "phantom");
    await mkdir(path.join(phantom, ".git"), { recursive: true });

    const inventory = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/phantom")));
    const candidate = inventory.candidates.find((entry) => entry.workspaceRepo === "repos/phantom")!;
    assert.equal(candidate.foldable, false);
    assert.equal(candidate.headCommit, undefined);
    assert.ok(candidate.policyIssues.some((issue) => issue.startsWith("git_failed:")));
  });
});

test("rejects linked common Git metadata before repository inspection", async () => {
  await withTempDir(async (directory) => {
    const source = await createSource(directory, "commondir-source");
    const workspace = path.join(directory, "workspace");
    const repo = path.join(workspace, "repos", "commondir");
    clone(source, repo);
    await writeFile(path.join(repo, ".git", "commondir"), "../../outside-git\n");

    const inventory = deriveRepositoryInventory(inventoryInput(directory, handoff("repos/commondir")));
    const candidate = inventory.candidates[0]!;
    assert.equal(candidate.foldable, false);
    assert.equal(candidate.headCommit, undefined);
    assert.ok(candidate.policyIssues.includes("linked_common_gitdir"));
  });
});

test("records repository-level commit status without enumerating changed files", async () => {
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
    assert.equal(candidate.committedChanged, true);
    assert.equal(candidate.dirty, false);
    assert.equal(candidate.foldable, true);
    assert.equal("changedPaths" in candidate, false);
    assert.equal("changedPathCount" in candidate, false);
  });
});


test("repository dirty state exactly matches inventory tracked and untracked commands", async () => {
  await withTempDir(async (directory) => {
    const repo = await createSource(directory, "dirty-semantics");
    const runner = createGitRunner(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(directory, "state"));
    assert.equal(repositoryDirty(repo, runner), false);
    await mkdir(path.join(repo, "empty-untracked"));
    assert.equal(repositoryDirty(repo, runner), true);
    await rm(path.join(repo, "empty-untracked"), { recursive: true });
    assert.equal(repositoryDirty(repo, runner), false);
    await mkdir(path.join(repo, "empty-untracked"));
    await writeFile(path.join(repo, "empty-untracked", "file.txt"), "untracked\n");
    assert.equal(repositoryDirty(repo, runner), true);
    git(repo, "add", "empty-untracked/file.txt");
    git(repo, "commit", "-qm", "tracked file");
    await writeFile(path.join(repo, ".gitignore"), "ignored/\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-qm", "ignore directory");
    await mkdir(path.join(repo, "ignored"));
    await writeFile(path.join(repo, "ignored", "artifact.txt"), "ignored but inventoried dirty\n");
    assert.equal(repositoryDirty(repo, runner), true);
  });
});

test("exact tree policy parses one full tree and rejects nested case-insensitive attributes", async () => {
  await withTempDir(async (directory) => {
    const repo = await createSource(directory, "tree-policy");
    const runner = createGitRunner(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(directory, "state"));
    await mkdir(path.join(repo, "sub"));
    await writeFile(path.join(repo, "sub", ".GiTaTtRiBuTeS"), "* text\n");
    git(repo, "add", "sub/.GiTaTtRiBuTeS");
    git(repo, "commit", "-qm", "nested attributes");
    assert.deepEqual(repositoryTreePolicyIssues(repo, git(repo, "rev-parse", "HEAD"), runner), ["repository_attributes"]);

    const fakeGit = path.join(directory, "fake-git");
    await writeFile(fakeGit, "#!/bin/sh\nprintf '\\377\\0'\n");
    await chmod(fakeGit, 0o700);
    const malformedRunner = createGitRunner(fakeGit, path.join(directory, "malformed-state"));
    assert.deepEqual(repositoryTreePolicyIssues(repo, git(repo, "rev-parse", "HEAD"), malformedRunner), ["tree_listing_not_utf8"]);

    const unterminatedGit = path.join(directory, "unterminated-git");
    await writeFile(unterminatedGit, `#!/bin/sh\nprintf '100644 blob ${"a".repeat(40)}\tfile.txt'\n`); await chmod(unterminatedGit, 0o700);
    assert.deepEqual(repositoryTreePolicyIssues(repo, git(repo, "rev-parse", "HEAD"), createGitRunner(unterminatedGit, path.join(directory, "unterminated-state"))), ["malformed_tree_listing"]);

    const malformedEntryGit = path.join(directory, "malformed-entry-git");
    await writeFile(malformedEntryGit, "#!/bin/sh\nprintf 'garbage\\0'\n"); await chmod(malformedEntryGit, 0o700);
    assert.deepEqual(repositoryTreePolicyIssues(repo, git(repo, "rev-parse", "HEAD"), createGitRunner(malformedEntryGit, path.join(directory, "entry-state"))), ["malformed_tree_entry"]);
  });
});

test("repository policy reuses exact streamed tree parsing for gitlinks", async () => {
  await withTempDir(async (directory) => {
    const repo = await createSource(directory, "gitlink-policy"); const head = git(repo, "rev-parse", "HEAD");
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${head},nested-module`); git(repo, "commit", "-qm", "gitlink");
    const runner = createGitRunner(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(directory, "state"));
    assert.deepEqual(repositoryPolicyIssues(repo, runner), ["gitlinks_or_submodules"]);
  });
});

test("trusted Git disables history overlays and policy rejects repository grafts", async () => {
  await withTempDir(async (directory) => {
    const repo = await createSource(directory, "overlay-policy"); const head = git(repo, "rev-parse", "HEAD");
    const runner = createGitRunner(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(directory, "state"));
    assert.equal(runner.env.GIT_GRAFT_FILE, "/dev/null"); assert.equal(runner.env.GIT_NO_REPLACE_OBJECTS, "1");
    await mkdir(path.join(repo, ".git", "info"), { recursive: true }); await writeFile(path.join(repo, ".git", "info", "grafts"), `${head}\n`);
    assert.deepEqual(repositoryPolicyIssues(repo, runner), ["grafts_file"]);

    const fakeGit = path.join(directory, "capture-git");
    await writeFile(fakeGit, `#!/bin/sh\nprintf '%s\n' "$@" > "$HOME/invocation-args"\n`); await chmod(fakeGit, 0o700);
    const captureRunner = createGitRunner(fakeGit, path.join(directory, "capture-state"));
    assert.deepEqual(repositoryTreePolicyIssues(repo, head, captureRunner), []);
    const argsFile = path.join(String(captureRunner.env.HOME), "invocation-args");
    const args = (await readFile(argsFile, "utf8")).split("\n"); assert.ok(args.includes("core.commitGraph=false"));
    runStandaloneGit(captureRunner, repo, ["version"]);
    const standaloneArgs = (await readFile(argsFile, "utf8")).split("\n"); assert.ok(standaloneArgs.includes("core.commitGraph=false"));
  });
});

test("local clone object hardlinks are allowed but mutable Git metadata hardlinks are rejected", async () => {
  await withTempDir(async (directory) => {
    const source = await createSource(directory, "hardlink-source");
    const destination = path.join(directory, "hardlink-clone");
    execFileSync("git", ["clone", "-q", source, destination], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null" }
    });
    const runner = createGitRunner(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(directory, "state"));
    assert.doesNotMatch(repositoryPolicyIssues(destination, runner).join(","), /git_metadata_hardlink/);
    await link(path.join(destination, ".git", "config"), path.join(destination, ".git", "config-hardlink"));
    assert.deepEqual(repositoryPolicyIssues(destination, runner), ["git_metadata_hardlink"]);
  });
});
