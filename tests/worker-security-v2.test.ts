import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertTrustedGitPolicy, runTrustedGit, trustedGit } from "../extensions/worker/trusted-git.js";
import { inputMounts, validateAdditionalInputs } from "../extensions/worker/inputs.js";
import { inspectInterruptedGitState, inventoryWorkerRepositories, snapshotWorkerRepositories } from "../extensions/worker/inventory.js";

function repository(root: string): string { const repo = path.join(root, "repo"); execFileSync("git", ["init", "-q", "-b", "main", repo]); execFileSync("git", ["-C", repo, "config", "user.name", "Test"]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]); writeFileSync(path.join(repo, "file.txt"), "one\n"); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-qm", "one"]); return repo; }

test("trusted Git rejects repository fsmonitor without executing it", () => { const root = mkdtempSync(path.join(tmpdir(), "trusted-git-fsmonitor-")); try { const repo = repository(root); const marker = path.join(root, "executed"); const hook = path.join(root, "fsmonitor.sh"); writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(hook, 0o755); execFileSync("git", ["-C", repo, "config", "core.fsmonitor", hook]); assert.throws(() => trustedGit(repo, ["status", "--porcelain"]), /core.fsmonitor/); assert.equal(existsSync(marker), false); } finally { rmSync(root, { recursive: true, force: true }); } });

test("trusted Git rejects includes, filters, replace refs, and graft history", () => { const root = mkdtempSync(path.join(tmpdir(), "trusted-git-policy-")); try { const cases: Array<[string,string]> = [["include.path", path.join(root, "other")],["filter.evil.clean","/bin/true"],["diff.evil.textconv","/bin/true"],["merge.evil.driver","/bin/true"],["core.sshCommand","/bin/true"]]; for (const [index,[key,value]] of cases.entries()) { const repo = repository(path.join(root, String(index))); execFileSync("git", ["-C", repo, "config", key, value]); assert.throws(() => assertTrustedGitPolicy(repo), /prohibited/); }
    const replace = repository(path.join(root, "replace")); const head = execFileSync("git", ["-C", replace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); execFileSync("git", ["-C", replace, "replace", head, head]); assert.throws(() => assertTrustedGitPolicy(replace), /replace refs/);
    const graft = repository(path.join(root, "graft")); mkdirSync(path.join(graft, ".git", "info"), { recursive: true }); writeFileSync(path.join(graft, ".git", "info", "grafts"), `${head}\n`); assert.throws(() => assertTrustedGitPolicy(graft), /grafts/);
  } finally { rmSync(root, { recursive: true, force: true }); } });

test("trusted Git ignores ambient global/system and replacement configuration", () => { const root = mkdtempSync(path.join(tmpdir(), "trusted-git-ambient-")); try { const repo = repository(root); const global = path.join(root, "global.gitconfig"); writeFileSync(global, "[alias]\nowned = !false\n[core]\nfsmonitor = /bin/false\n"); const output = runTrustedGit(["-C", repo, "status", "--porcelain"], { env: { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: global, GIT_REPLACE_REF_BASE: "refs/evil" } }); assert.equal(output, ""); } finally { rmSync(root, { recursive: true, force: true }); } });

test("additional inputs reject sensitive roots, aliases, duplicates, and overlap while retaining deterministic mounts", () => { const root = mkdtempSync(path.join(tmpdir(), "worker-input-policy-")); try { const runtime = path.join(root, "runtime"); const workspace = path.join(root, "workspace"); const data = path.join(root, "data"); const nested = path.join(data, "nested"); mkdirSync(runtime); mkdirSync(workspace); mkdirSync(nested, { recursive: true }); writeFileSync(path.join(data, "a.txt"), "a");
    assert.throws(() => validateAdditionalInputs({ values: [runtime], role: "work", workspaceRoot: workspace, runtimeRoot: runtime }), /sensitive/);
    assert.throws(() => validateAdditionalInputs({ values: [workspace], role: "work", workspaceRoot: workspace, runtimeRoot: runtime }), /sensitive/);
    assert.throws(() => validateAdditionalInputs({ values: [data, nested], role: "review", workspaceRoot: workspace, runtimeRoot: runtime }), /overlap/);
    const alias = path.join(root, "alias"); symlinkSync(data, alias); assert.throws(() => validateAdditionalInputs({ values: [data, alias], role: "work", workspaceRoot: workspace, runtimeRoot: runtime }), /Duplicate/);
    const retained = validateAdditionalInputs({ values: [path.join(data, "a.txt")], role: "integration", workspaceRoot: workspace, runtimeRoot: runtime }); assert.equal(retained[0]?.target, "/integration/inputs/01-a.txt"); assert.equal(inputMounts(retained)[0]?.readOnly, true);
    const more = path.join(root, "more.txt"); writeFileSync(more, "more"); const resumed = validateAdditionalInputs({ values: [more], existing: retained, role: "integration", workspaceRoot: workspace, runtimeRoot: runtime }); assert.deepEqual(resumed.map((item) => item.target), ["/integration/inputs/01-a.txt", "/integration/inputs/02-more.txt"]);
  } finally { rmSync(root, { recursive: true, force: true }); } });

test("trusted Git rejects linked candidate worktrees and gitlinks while accepting inert nested content", () => {
  const root = mkdtempSync(path.join(tmpdir(), "trusted-git-structure-"));
  try {
    const worktreeSource = repository(path.join(root, "worktree-source"));
    const linked = path.join(root, "linked");
    execFileSync("git", ["-C", worktreeSource, "worktree", "add", "-q", "-b", "linked", linked]);
    assert.throws(() => assertTrustedGitPolicy(linked), /worktrees/);

    const configured = repository(path.join(root, "configured"));
    execFileSync("git", ["-C", configured, "config", "extensions.worktreeConfig", "true"]);
    assert.throws(() => assertTrustedGitPolicy(configured), /extensions.worktreeconfig/);

    assert.doesNotThrow(() => assertTrustedGitPolicy(worktreeSource));
    const outer = repository(path.join(root, "outer"));
    const ignored = path.join(outer, "ignored"); repository(path.join(ignored, "vendor"));
    writeFileSync(path.join(outer, ".gitignore"), "ignored/\nlarge/\n");
    const large = path.join(outer, "large"); mkdirSync(large); for (let index = 0; index < 2_000; index += 1) writeFileSync(path.join(large, `entry-${index}`), "x");
    assert.doesNotThrow(() => assertTrustedGitPolicy(outer));

    const child = repository(path.join(root, "child"));
    const parent = repository(path.join(root, "parent"));
    execFileSync("git", ["-c", "protocol.file.allow=always", "-C", parent, "submodule", "add", "-q", child, "dependency"]);
    execFileSync("git", ["-C", parent, "commit", "-qm", "submodule"]);
    assert.throws(() => assertTrustedGitPolicy(parent), /gitlinks|nested Git metadata|submodule/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("inventory retains structured repository policy failures and interrupted-state evidence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-inventory-policy-"));
  try {
    const workspace = path.join(root, "workspace"); const repos = path.join(workspace, "repos"); mkdirSync(repos, { recursive: true });
    const child = repository(path.join(root, "child")); const parent = repository(path.join(repos, "parent"));
    execFileSync("git", ["-c", "protocol.file.allow=always", "-C", parent, "submodule", "add", "-q", child, "dependency"]); execFileSync("git", ["-C", parent, "commit", "-qm", "submodule"]);
    const inventory = inventoryWorkerRepositories({ workspaceRoot: workspace, workerId: "worker_policy", runId: "run_policy", reported: ["repos/parent/repo"] });
    assert.equal(inventory.repositories.length, 1); assert.equal(inventory.repositories[0]!.path, "repos/parent/repo"); assert.equal(inventory.repositories[0]!.eligible, false); assert.match(inventory.repositories[0]!.issues?.join(" ") ?? "", /policy validation failed.*(?:gitlinks|submodule)|(?:gitlinks|submodule).*policy validation failed/i);
    assert.doesNotMatch(inventory.errors.join(" "), /not found by independent workspace scan/);
    assert.match(inspectInterruptedGitState(workspace).join(" "), /repos\/parent\/repo: Repository policy validation failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("inventory fails closed when repository HEAD changes during inspection and sanitizes remote controls", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-inventory-race-"));
  try {
    const workspace = path.join(root, "workspace"); mkdirSync(workspace, { recursive: true });
    const repo = repository(workspace);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://example.invalid/\u001b[31mrepo"]);
    let changed = false;
    const inventory = inventoryWorkerRepositories({ workspaceRoot: workspace, workerId: "worker_race", runId: "run_race", reported: ["repo"] }, {
      afterHeadRead(repositoryPath) {
        if (changed) return;
        changed = true;
        writeFileSync(path.join(repositoryPath, "raced.txt"), "race\n");
        execFileSync("git", ["-C", repositoryPath, "add", "raced.txt"]);
        execFileSync("git", ["-C", repositoryPath, "commit", "-qm", "race"]);
      }
    });
    assert.equal(inventory.repositories.length, 1);
    assert.equal(inventory.repositories[0]?.eligible, false);
    assert.equal(inventory.repositories[0]?.commit, "unknown");
    assert.match(inventory.repositories[0]?.issues?.join(" ") ?? "", /HEAD changed during inventory/);
    assert.doesNotMatch(inventory.repositories[0]?.source ?? "", /\u001b/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("inventory scan limitations are precise and do not disqualify an independently proven repository", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-inventory-limits-"));
  try {
    const workspace = path.join(root, "workspace"); mkdirSync(workspace, { recursive: true });
    const repo = repository(workspace);
    const before = snapshotWorkerRepositories(workspace);
    writeFileSync(path.join(repo, "changed.txt"), "changed\n"); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-qm", "changed"]);
    const cache = path.join(workspace, "cache", "npm", "_cacache"); mkdirSync(cache, { recursive: true });
    const bulk = path.join(workspace, "bulk"); mkdirSync(bulk); for (let index = 0; index < 8; index += 1) mkdirSync(path.join(bulk, `entry-${index}`));
    const inventory = inventoryWorkerRepositories({ workspaceRoot: workspace, workerId: "worker_limits", runId: "run_limits", reported: ["repo"], before }, { scanLimits: { maxDirectories: 4, maxDirectoryEntries: 3, maxDepth: 2 } });
    assert.equal(inventory.repositories.find((item) => item.path === "repo")?.eligible, true);
    assert.match(inventory.errors.join(" "), /directory bulk after 3 entries|subtree bulk\//);
    assert.doesNotMatch(inventory.repositories.find((item) => item.path === "repo")?.issues?.join(" ") ?? "", /scan was incomplete/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("inventory bounds its traversal queue while preserving an already scheduled reported repository", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-inventory-queue-"));
  try {
    const workspace = path.join(root, "workspace"); mkdirSync(workspace, { recursive: true });
    const repo = repository(workspace); const before = snapshotWorkerRepositories(workspace);
    writeFileSync(path.join(repo, "changed.txt"), "changed\n"); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-qm", "changed"]);
    const wide = path.join(workspace, "wide"); mkdirSync(wide); for (let index = 0; index < 12; index += 1) mkdirSync(path.join(wide, `child-${String(index).padStart(2, "0")}`));
    const inventory = inventoryWorkerRepositories({ workspaceRoot: workspace, workerId: "worker_queue", runId: "run_queue", reported: ["repo"], before }, { scanLimits: { maxDirectories: 3, maxDirectoryEntries: 32, maxDepth: 4 } });
    assert.equal(inventory.repositories.find((item) => item.path === "repo")?.eligible, true);
    assert.match(inventory.errors.join(" "), /broad subtree wide after scheduling 3 directories/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("inventory reports the precise subtree skipped by its depth bound without poisoning a proven candidate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-inventory-depth-"));
  try {
    const workspace = path.join(root, "workspace"); mkdirSync(workspace, { recursive: true });
    const repo = repository(workspace); const before = snapshotWorkerRepositories(workspace);
    writeFileSync(path.join(repo, "changed.txt"), "changed\n"); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-qm", "changed"]);
    mkdirSync(path.join(workspace, "deep", "level-one", "level-two"), { recursive: true });
    const inventory = inventoryWorkerRepositories({ workspaceRoot: workspace, workerId: "worker_depth", runId: "run_depth", reported: ["repo"], before }, { scanLimits: { maxDirectories: 16, maxDirectoryEntries: 32, maxDepth: 1 } });
    assert.equal(inventory.repositories.find((item) => item.path === "repo")?.eligible, true);
    assert.match(inventory.errors.join(" "), /deep\/level-one below depth 1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("inventory matches symlink aliases by physical identity and sanitizes hostile repository paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-inventory-alias-"));
  try {
    const workspace = path.join(root, "workspace"); mkdirSync(workspace, { recursive: true });
    const actualRoot = path.join(workspace, "actual"); const repo = repository(actualRoot); const alias = path.join(workspace, "alias"); symlinkSync(actualRoot, alias, "dir");
    let inventory = inventoryWorkerRepositories({ workspaceRoot: workspace, workerId: "worker_alias", runId: "run_alias", reported: ["alias/repo"] });
    assert.equal(inventory.repositories[0]?.reported, true); assert.equal(inventory.repositories[0]?.path, "actual/repo");

    const hostileRoot = path.join(workspace, "hostile"); mkdirSync(hostileRoot); const hostile = repository(path.join(hostileRoot, "evil\u001b[31m"));
    const relative = path.relative(workspace, hostile);
    inventory = inventoryWorkerRepositories({ workspaceRoot: workspace, workerId: "worker_hostile", runId: "run_hostile", reported: [relative] });
    const candidate = inventory.repositories.find((item) => item.path.includes("hostile"))!;
    assert.equal(candidate.eligible, false); assert.doesNotMatch(candidate.path, /\u001b/); assert.match(candidate.issues?.join(" ") ?? "", /terminal-control/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("inventory protects repos priority and names broad artifact and HOME tool-cache limits", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-inventory-priority-"));
  try {
    const workspace = path.join(root, "workspace"); mkdirSync(workspace, { recursive: true });
    const repo = repository(path.join(workspace, "repos", "a")); const relative = path.relative(workspace, repo);
    const before = snapshotWorkerRepositories(workspace);
    writeFileSync(path.join(repo, "changed.txt"), "changed\n"); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "-qm", "changed"]);
    const artifacts = path.join(workspace, "artifacts"); mkdirSync(artifacts); for (let index = 0; index < 40; index += 1) mkdirSync(path.join(artifacts, `wide-${index}`));
    mkdirSync(path.join(workspace, ".cargo", "registry", "src", "deep", "crate"), { recursive: true });
    mkdirSync(path.join(workspace, "scratch", ".venv", "lib", "python", "site-packages", "pkg"), { recursive: true });
    const inventory = inventoryWorkerRepositories({ workspaceRoot: workspace, workerId: "worker_priority", runId: "run_priority", reported: [relative], before }, { scanLimits: { maxDirectories: 8, maxDirectoryEntries: 128, maxDepth: 3 } });
    assert.equal(inventory.repositories.find((item) => item.path === relative.split(path.sep).join("/"))?.eligible, true);
    assert.match(inventory.errors.join(" "), /tool-cache subtree \.cargo\/registry/);
    assert.match(inventory.errors.join(" "), /broad subtree artifacts/);
    assert.match(inventory.errors.join(" "), /broad subtree artifacts after scheduling 8 directories/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
