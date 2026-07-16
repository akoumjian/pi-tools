import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findWorktreeForBranch, runReconcile } from "../extensions/orchestrator/integrate.js";
import { createManagedWorktree } from "../extensions/orchestrator/worktree.js";

const SETTINGS = { validation: undefined };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function createRepo(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Orchestrator Test");
  git(repo, "config", "user.email", "orchestrator@example.invalid");
  await writeFile(path.join(repo, "a.txt"), "base a\n", "utf8");
  await writeFile(path.join(repo, "b.txt"), "base b\n", "utf8");
  await writeFile(path.join(repo, "shared.txt"), "base shared\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  return repo;
}

async function createBranch(repo: string, branch: string, file: string, content: string): Promise<void> {
  git(repo, "switch", "-c", branch, "main");
  await writeFile(path.join(repo, file), content, "utf8");
  git(repo, "add", file);
  git(repo, "commit", "-m", branch);
  git(repo, "switch", "main");
}

async function withEnvUnset(name: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  delete process.env[name];
  try {
    await run();
  } finally {
    if (previous !== undefined) process.env[name] = previous;
  }
}

test("approved reconcile merges folded branches into the parent and cleans up", async () => {
  await withEnvUnset("ORCHESTRATOR_WORKTREE_ROOT", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-orch-int-merge-"));
    try {
      const repo = await createRepo(root);
      await createBranch(repo, "orch/run-a", "a.txt", "writer a\n");
      await createBranch(repo, "orch/run-b", "b.txt", "writer b\n");
      const confirms: string[] = [];
      const report = await runReconcile({
        parentCwd: repo,
        branches: ["orch/run-a", "orch/run-b"],
        settings: SETTINGS,
        confirm: async (_title, message) => {
          confirms.push(message);
          return true;
        }
      });
      assert.equal(report.status, "merged");
      assert.deepEqual(report.folded.map((f) => f.branch).sort(), ["orch/run-a", "orch/run-b"]);
      assert.deepEqual(report.cleanedBranches.sort(), ["orch/run-a", "orch/run-b"]);
      assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "writer a\n");
      assert.equal(await readFile(path.join(repo, "b.txt"), "utf8"), "writer b\n");
      assert.match(git(repo, "log", "--oneline", "-1"), /Merge branch/);
      assert.equal(git(repo, "branch", "--list", "orch/*"), "", "all orch/* branches removed after merge");
      assert.match(confirms[0], /Folded \(2\)/);
      assert.match(confirms[0], /UNVALIDATED/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("conflicting branch is skipped and retained while the clean branch merges", async () => {
  await withEnvUnset("ORCHESTRATOR_WORKTREE_ROOT", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-orch-int-conflict-"));
    try {
      const repo = await createRepo(root);
      await createBranch(repo, "orch/c-one", "shared.txt", "change one\n");
      await createBranch(repo, "orch/c-two", "shared.txt", "change two\n");
      const report = await runReconcile({
        parentCwd: repo,
        branches: ["orch/c-one", "orch/c-two"],
        settings: SETTINGS,
        confirm: async () => true
      });
      assert.equal(report.status, "merged");
      assert.equal(report.folded.length, 1);
      assert.equal(report.skipped.length, 1);
      assert.equal(report.skipped[0].status, "conflict");
      assert.equal(git(repo, "branch", "--list", report.skipped[0].branch).trim().replace(/^\*?\s*/, ""), report.skipped[0].branch, "conflicted branch is retained");
      assert.deepEqual(report.overlaps[0]?.files, ["shared.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("declined merge gate keeps the integration branch and leaves the parent untouched", async () => {
  await withEnvUnset("ORCHESTRATOR_WORKTREE_ROOT", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-orch-int-decline-"));
    try {
      const repo = await createRepo(root);
      await createBranch(repo, "orch/d-one", "a.txt", "declined change\n");
      const before = git(repo, "rev-parse", "HEAD");
      const report = await runReconcile({
        parentCwd: repo,
        branches: ["orch/d-one"],
        settings: SETTINGS,
        confirm: async () => false
      });
      assert.equal(report.status, "declined");
      assert.equal(git(repo, "rev-parse", "HEAD"), before);
      assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "base a\n");
      assert.ok(report.integrationBranch);
      assert.match(git(repo, "branch", "--list", report.integrationBranch!), /integration/);
      assert.ok(report.integrationPath && existsSync(report.integrationPath), "integration worktree kept for review");
      assert.match(git(repo, "branch", "--list", "orch/d-one"), /d-one/, "writer branch retained");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("reconcile guards: gating, branch names, dirty parent, missing branches, validation failure", async () => {
  await withEnvUnset("ORCHESTRATOR_WORKTREE_ROOT", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-orch-int-guards-"));
    try {
      const repo = await createRepo(root);
      await createBranch(repo, "orch/g-one", "a.txt", "guarded change\n");
      const confirm = async () => true;

      await assert.rejects(
        () => runReconcile({ parentCwd: repo, branches: ["main"], settings: SETTINGS, confirm }),
        /only integrates orchestrator branches/
      );

      await writeFile(path.join(repo, "dirty.txt"), "dirty\n", "utf8");
      await assert.rejects(
        () => runReconcile({ parentCwd: repo, branches: ["orch/g-one"], settings: SETTINGS, confirm }),
        /clean parent checkout/
      );
      await rm(path.join(repo, "dirty.txt"));

      const missing = await runReconcile({ parentCwd: repo, branches: ["orch/does-not-exist"], settings: SETTINGS, confirm });
      assert.equal(missing.status, "nothing_merged");
      assert.equal(missing.skipped[0].status, "invalid");

      const failedValidation = await runReconcile({
        parentCwd: repo,
        branches: ["orch/g-one"],
        settings: {
          ...SETTINGS,
          validation: { command: process.execPath, args: ["-e", "process.exit(3)"], timeoutMs: 10_000, maxRunsPerTask: 1 }
        },
        confirm
      });
      assert.equal(failedValidation.status, "nothing_merged");
      assert.equal(failedValidation.skipped[0].status, "validation_failed");
      assert.equal(git(repo, "branch", "--list", "orch/*integration*"), "", "failed integration worktree is removed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("worktree discovery finds managed worktrees by branch and parent-HEAD movement aborts the merge", async () => {
  await withEnvUnset("ORCHESTRATOR_WORKTREE_ROOT", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-orch-int-discovery-"));
    try {
      const repo = await createRepo(root);
      const managed = await createManagedWorktree({ cwd: repo, runId: "disc", taskId: "writer", managedRoot: path.join(root, "managed") });
      const discovered = await findWorktreeForBranch(repo, managed.branch);
      assert.equal(discovered && realpathSync(discovered), realpathSync(managed.path));
      assert.equal(await findWorktreeForBranch(repo, "orch/nope"), undefined);

      await writeFile(path.join(managed.path, "a.txt"), "writer via worktree\n", "utf8");
      git(managed.path, "add", "a.txt");
      git(managed.path, "commit", "-m", "writer change");

      await assert.rejects(
        () => runReconcile({
          parentCwd: repo,
          branches: [managed.branch],
          settings: SETTINGS,
          confirm: async () => {
            await writeFile(path.join(repo, "racer.txt"), "raced\n", "utf8");
            git(repo, "add", "racer.txt");
            git(repo, "commit", "-m", "parent moved during confirm");
            return true;
          }
        }),
        /Parent HEAD moved during reconcile/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
