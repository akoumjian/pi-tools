import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  exclusiveManagedWorkerRoleSkillOptions,
  managedWorkerRoleSkillPath,
  managedWorkerRoleSkillText,
  type ManagedWorkerRoleSkill
} from "../extensions/_shared/role-skills.js";

const roles: ManagedWorkerRoleSkill[] = ["parent", "implementation", "review", "integration"];

test("managed-worker role skills are concise trusted progressive-disclosure resources", () => {
  for (const role of roles) {
    const path = managedWorkerRoleSkillPath(role);
    const metadata = lstatSync(path);
    const content = readFileSync(path, "utf8");
    assert.equal(metadata.isFile(), true);
    assert.ok(metadata.size < 4_000, `${role} should stay concise`);
    assert.match(content, new RegExp(`name: managed-worker-${role === "parent" ? "parent" : role}`));
    assert.match(content, /description: .+Use .+do not use/i);
    assert.equal(managedWorkerRoleSkillText(role), content.trim());
    assert.deepEqual(exclusiveManagedWorkerRoleSkillOptions(role), { noSkills: true, additionalSkillPaths: [path] });
  }
});

test("managed-worker skills state role authority and handoff boundaries", () => {
  assert.match(managedWorkerRoleSkillText("parent"), /Own scope, grounding, task state/);
  assert.match(managedWorkerRoleSkillText("implementation"), /Never push, publish, promote/);
  assert.match(managedWorkerRoleSkillText("review"), /Never install, edit, commit, push/);
  assert.match(managedWorkerRoleSkillText("integration"), /analysis phase, do not mutate/i);
});
