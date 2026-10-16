import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertTrustedGitPolicy, runTrustedGit, trustedGit } from "../extensions/worker/trusted-git.js";
import { inputMounts, validateAdditionalInputs } from "../extensions/worker/inputs.js";

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
