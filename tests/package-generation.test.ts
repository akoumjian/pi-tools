import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertCompatiblePiToolsPackageGeneration,
  assertCurrentModuleMarkers,
  fingerprintExecutablePackage,
  type PiToolsPackageGeneration
} from "../extensions/_shared/package-generation.js";

async function packageFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-tools-generation-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@akoumjian/pi-tools" }));
  for (const dir of ["config", "extensions", "scripts", "skills", "worker-roles"]) await mkdir(path.join(root, dir));
  await writeFile(path.join(root, "extensions", "index.ts"), "export const value = 1;\n");
  return root;
}

function generation(packageRoot: string, fingerprint: string): PiToolsPackageGeneration {
  return { version: 1, packageRoot, fingerprint };
}

test("executable package fingerprint is deterministic and changes with code", async () => {
  const root = await packageFixture();
  try {
    const first = fingerprintExecutablePackage(root);
    assert.equal(first, fingerprintExecutablePackage(root));
    await writeFile(path.join(root, "extensions", "index.ts"), "export const value = 2;\n");
    assert.notEqual(fingerprintExecutablePackage(root), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation compatibility rejects changed code or package roots with restart guidance", () => {
  const loaded = generation("/old/package", "a".repeat(64));
  assert.doesNotThrow(() => assertCompatiblePiToolsPackageGeneration(loaded, loaded));
  assert.throws(
    () => assertCompatiblePiToolsPackageGeneration(loaded, generation("/old/package", "b".repeat(64))),
    /Fully quit and restart Pi; \/reload cannot safely replace cached transitive modules/
  );
  assert.throws(
    () => assertCompatiblePiToolsPackageGeneration(loaded, generation("/new/package", "a".repeat(64))),
    /Fully quit and restart Pi/
  );
});

test("first guarded worker generation rejects legacy cached dependency modules", () => {
  const expected = "a".repeat(64);
  assert.doesNotThrow(() => assertCurrentModuleMarkers([
    { name: "async-job", marker: expected },
    { name: "worker settings", marker: expected }
  ], expected));
  assert.throws(
    () => assertCurrentModuleMarkers([{ name: "legacy async-job", marker: undefined }], expected),
    /Mixed @akoumjian\/pi-tools package generations.*Fully quit and restart Pi/
  );
});

test("generation fingerprint refuses executable-resource symlinks", async () => {
  const root = await packageFixture();
  try {
    await symlink(path.join(root, "extensions", "index.ts"), path.join(root, "skills", "linked.ts"));
    assert.throws(() => fingerprintExecutablePackage(root), /must not be a symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
