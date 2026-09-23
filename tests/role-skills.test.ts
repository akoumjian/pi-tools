import assert from "node:assert/strict";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  exclusiveManagedWorkerRoleSkillOptions,
  managedWorkerRoleSkillPath,
  managedWorkerRoleSkillText,
  verifyManagedWorkerRoleSkillFile,
  type ManagedWorkerRoleSkill
} from "../extensions/_shared/role-skills.js";

const roles: ManagedWorkerRoleSkill[] = ["parent", "implementation", "review", "integration"];

test("managed-worker role skills are concise trusted progressive-disclosure resources", () => {
  for (const role of roles) {
    const skillPath = managedWorkerRoleSkillPath(role);
    const metadata = lstatSync(skillPath);
    const content = readFileSync(skillPath, "utf8");
    assert.equal(metadata.isFile(), true);
    assert.ok(metadata.size < 4_000, `${role} should stay concise`);
    assert.match(content, new RegExp(`name: managed-worker-${role}`));
    assert.match(content, /description: .+Use .+do not use/i);
    assert.equal(managedWorkerRoleSkillText(role), content.trim());
    assert.deepEqual(exclusiveManagedWorkerRoleSkillOptions(role), { noSkills: true, additionalSkillPaths: [skillPath] });
  }
});

test("role skill verification accepts hardlinks and rejects untrusted or malformed resources", () => {
  const base = mkdtempSync(path.join(tmpdir(), "pi-role-skills-"));
  try {
    const root = path.join(base, "skills");
    const outside = path.join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);

    const sourceDirectory = path.join(root, "source");
    const hardlinkDirectory = path.join(root, "hardlink");
    mkdirSync(sourceDirectory);
    mkdirSync(hardlinkDirectory);
    const source = path.join(sourceDirectory, "SKILL.md");
    const hardlink = path.join(hardlinkDirectory, "SKILL.md");
    writeFileSync(source, "---\nname: test\ndescription: Test. Use now. Do not use later.\n---\n\nTrusted.\n");
    linkSync(source, hardlink);
    assert.ok(lstatSync(hardlink).nlink > 1);
    assert.deepEqual(verifyManagedWorkerRoleSkillFile(hardlink, root), {
      path: realpathSync(hardlink),
      text: readFileSync(hardlink, "utf8").trim()
    });

    const directLink = path.join(root, "direct-link.md");
    symlinkSync(source, directLink);
    assert.throws(() => verifyManagedWorkerRoleSkillFile(directLink, root), /direct symbolic link/);

    const outsideSkill = path.join(outside, "SKILL.md");
    writeFileSync(outsideSkill, "outside\n");
    const escapedDirectory = path.join(root, "escaped");
    symlinkSync(outside, escapedDirectory, "dir");
    assert.throws(() => verifyManagedWorkerRoleSkillFile(path.join(escapedDirectory, "SKILL.md"), root), /escapes the canonical skills root/);

    const directory = path.join(root, "directory");
    mkdirSync(directory);
    assert.throws(() => verifyManagedWorkerRoleSkillFile(directory, root), /not a regular file/);

    const oversized = path.join(root, "oversized.md");
    writeFileSync(oversized, Buffer.alloc(16 * 1024 + 1, 0x61));
    assert.throws(() => verifyManagedWorkerRoleSkillFile(oversized, root), /exceeds 16384 bytes/);

    const empty = path.join(root, "empty.md");
    writeFileSync(empty, " \n\t");
    assert.throws(() => verifyManagedWorkerRoleSkillFile(empty, root), /is empty/);

    const invalid = path.join(root, "invalid.md");
    writeFileSync(invalid, Buffer.from([0xc3, 0x28]));
    assert.throws(() => verifyManagedWorkerRoleSkillFile(invalid, root), /not valid UTF-8/);

    assert.throws(() => verifyManagedWorkerRoleSkillFile(path.join(root, "missing.md"), root), /is unavailable/);
    assert.throws(() => verifyManagedWorkerRoleSkillFile(outsideSkill, root), /outside the exact skills root/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("managed-worker skills state role authority and handoff boundaries", () => {
  assert.match(managedWorkerRoleSkillText("parent"), /Own scope, grounding, task state/);
  assert.match(managedWorkerRoleSkillText("implementation"), /Never push, publish, promote/);
  assert.match(managedWorkerRoleSkillText("review"), /Never install, edit, commit, push/);
  assert.match(managedWorkerRoleSkillText("integration"), /analysis phase, do not mutate/i);
});
