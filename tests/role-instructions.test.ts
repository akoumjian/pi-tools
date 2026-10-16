import assert from "node:assert/strict";
import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyWorkerRoleInstructionFile, workerRoleInstructions } from "../extensions/_shared/role-instructions.js";

test("plain worker role instructions are verified and role-specific", () => {
  for (const role of ["work", "review", "integration"] as const) {
    const value = workerRoleInstructions(role);
    assert.match(value.path, new RegExp(`${role}\\.md$`));
    assert.ok(value.text.length > 100);
    assert.doesNotMatch(value.text, /^---/);
  }
});

test("role instruction verifier rejects symlinks, escapes, invalid UTF-8, and oversized files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-worker-role-")); mkdirSync(path.join(root, "roles"));
  try {
    const good = path.join(root, "roles", "good.md"); writeFileSync(good, "# Role\nDo focused work.\n");
    const hard = path.join(root, "roles", "hard.md"); linkSync(good, hard); assert.match(verifyWorkerRoleInstructionFile(hard, path.join(root, "roles")).text, /focused/);
    const symbolic = path.join(root, "roles", "symbolic.md"); symlinkSync(good, symbolic); assert.throws(() => verifyWorkerRoleInstructionFile(symbolic, path.join(root, "roles")), /regular file/);
    const outside = path.join(root, "outside.md"); writeFileSync(outside, "outside"); assert.throws(() => verifyWorkerRoleInstructionFile(outside, path.join(root, "roles")), /outside/);
    const invalid = path.join(root, "roles", "invalid.md"); writeFileSync(invalid, Buffer.from([0xff])); assert.throws(() => verifyWorkerRoleInstructionFile(invalid, path.join(root, "roles")), /UTF-8/);
    const large = path.join(root, "roles", "large.md"); writeFileSync(large, "x".repeat(17 * 1024)); assert.throws(() => verifyWorkerRoleInstructionFile(large, path.join(root, "roles")), /exceed/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
