import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertCompatiblePiToolsPackageGeneration,
  assertCurrentModuleMarkers,
  createPiToolsPackageGenerationGuard,
  readPiToolsPackageGenerationAt,
  type PiToolsPackageGeneration
} from "../extensions/_shared/package-generation.js";

const repoRoot = process.cwd();
const generationManifestPath = path.join(repoRoot, "extensions/_shared/package-generation-files.json");

type Fixture = { root: string; source: string; unlisted: string };

async function packageFixture(source = "export const value = 1;\n"): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-tools-generation-"));
  const sourcePath = "extensions/worker/index.ts";
  const unlistedPath = "extensions/worker/untracked.ts";
  await mkdir(path.join(root, "extensions", "worker"), { recursive: true });
  await mkdir(path.join(root, "extensions", "_shared"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@akoumjian/pi-tools", type: "module" }));
  await writeFile(path.join(root, sourcePath), source);
  await writeFile(path.join(root, unlistedPath), "untracked initial\n");
  await writeFile(path.join(root, "extensions/_shared/package-generation-files.json"), `${JSON.stringify({ schemaVersion: 1, files: [sourcePath, "package.json"], moduleFingerprints: { [sourcePath]: sha256(source) } }, null, 2)}\n`);
  return { root, source: path.join(root, sourcePath), unlisted: path.join(root, unlistedPath) };
}

function generation(packageRoot: string, fingerprint: string): PiToolsPackageGeneration {
  return { version: 2, packageRoot, fingerprint, fileFingerprints: {}, moduleFingerprints: {}, fileStamps: {} };
}

test("stable generation manifest ignores unlisted development files and detects listed code changes", async () => {
  const fixture = await packageFixture();
  try {
    const first = readPiToolsPackageGenerationAt(fixture.root);
    assert.equal(first.fingerprint, readPiToolsPackageGenerationAt(fixture.root).fingerprint);
    await writeFile(fixture.unlisted, "untracked revised\n");
    assert.equal(readPiToolsPackageGenerationAt(fixture.root).fingerprint, first.fingerprint);
    await writeFile(fixture.source, "export const value = 2;\n");
    assert.notEqual(readPiToolsPackageGenerationAt(fixture.root).fingerprint, first.fingerprint);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("generation manifest refuses symlinked runtime files", async () => {
  const fixture = await packageFixture();
  try {
    await rm(fixture.source);
    await symlink(path.join(fixture.root, "package.json"), fixture.source);
    assert.throws(() => readPiToolsPackageGenerationAt(fixture.root), /regular non-symlink file/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("generation compatibility rejects changed code or package roots with full-restart guidance", () => {
  const loaded = generation("/old/package", "a".repeat(64));
  assert.doesNotThrow(() => assertCompatiblePiToolsPackageGeneration(loaded, loaded));
  assert.throws(
    () => assertCompatiblePiToolsPackageGeneration(loaded, generation("/old/package", "b".repeat(64))),
    /Fully quit and restart Pi; \/reload cannot activate package-code updates safely/
  );
  assert.throws(
    () => assertCompatiblePiToolsPackageGeneration(loaded, generation("/new/package", "a".repeat(64))),
    /Fully quit and restart Pi/
  );
});

test("cached plain-JavaScript markers must match the manifest's exact source marker", async () => {
  const fixture = await packageFixture();
  try {
    const current = readPiToolsPackageGenerationAt(fixture.root);
    const expected = current.moduleFingerprints["extensions/worker/index.ts"]!;
    assert.doesNotThrow(() => assertCurrentModuleMarkers([{ name: "module", path: "extensions/worker/index.ts", fingerprint: expected }], current));
    assert.throws(
      () => assertCurrentModuleMarkers([{ name: "legacy module", path: "extensions/worker/index.ts", fingerprint: undefined }], current),
      /Mixed @akoumjian\/pi-tools worker modules.*Fully quit and restart Pi/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("old-process/new-disk loader regression rejects the cached module before its new token is called", async () => {
  const fixture = await packageFixture("export const oldIdentity = true;\n");
  try {
    const modulePath = path.join(fixture.root, "extensions/_shared/async-job-process.js");
    const sourcePath = "extensions/_shared/async-job-process.js";
    const oldMarker = "a".repeat(64);
    const newMarker = "b".repeat(64);
    await writeFile(modulePath, `export const PI_TOOLS_MODULE_FINGERPRINT = "${oldMarker}";\nexport const oldIdentity = true;\n`);
    await writeFile(path.join(fixture.root, "extensions/_shared/package-generation-files.json"), `${JSON.stringify({ schemaVersion: 1, files: [sourcePath], moduleFingerprints: { [sourcePath]: oldMarker } }, null, 2)}\n`);
    const cached = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
    await writeFile(modulePath, `export const PI_TOOLS_MODULE_FINGERPRINT = "${newMarker}";\nexport function asyncJobProcessStartToken() { return "new-token"; }\n`);
    await writeFile(path.join(fixture.root, "extensions/_shared/package-generation-files.json"), `${JSON.stringify({ schemaVersion: 1, files: [sourcePath], moduleFingerprints: { [sourcePath]: newMarker } }, null, 2)}\n`);
    const freshLoader = path.join(fixture.root, "extensions/_shared/fresh-loader.mjs");
    await writeFile(freshLoader, "import * as dependency from './async-job-process.js';\nexport const marker = dependency.PI_TOOLS_MODULE_FINGERPRINT;\nexport const token = dependency.asyncJobProcessStartToken;\n");
    const reloaded = await import(`${pathToFileURL(freshLoader).href}?reload=${Date.now()}`) as { marker?: unknown; token?: unknown };
    assert.equal(cached.asyncJobProcessStartToken, undefined);
    assert.equal(reloaded.token, undefined, "the fresh entry still observes the old cached dependency, reproducing the launch failure");
    const guard = createPiToolsPackageGenerationGuard(pathToFileURL(freshLoader).href, [
      { name: "async-job-process", path: sourcePath, fingerprint: reloaded.marker }
    ]);
    assert.throws(guard, /Mixed @akoumjian\/pi-tools worker modules.*Fully quit and restart Pi/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("checked-in generation manifest covers local worker runtime imports and excludes default config", () => {
  const manifest = JSON.parse(readFileSync(generationManifestPath, "utf8")) as { schemaVersion: number; files: string[]; moduleFingerprints: Record<string, string> };
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.files, [...new Set(manifest.files)].sort((left, right) => left.localeCompare(right)));
  assert.equal(manifest.files.some((file) => file.startsWith("config/")), false);
  for (const required of [
    "extensions/_shared/async-job-process.js",
    "extensions/_shared/atomic-json.js",
    "extensions/_shared/worker-job-settlement.js",
    "extensions/_shared/worker-rpc-prompt.js",
    "extensions/worker/index.ts",
    "extensions/worker/sandbox.ts",
    "scripts/worker-host.mjs",
    "scripts/worker-rpc/rpc-client.js",
    "scripts/worker-sbx-rpc.mjs"
  ]) assert.ok(manifest.files.includes(required), required);
  for (const file of manifest.files) assert.equal(existsSync(path.join(repoRoot, file)), true, file);
  assert.deepEqual(Object.keys(manifest.moduleFingerprints), [
    "extensions/_shared/async-job-process.js",
    "extensions/_shared/atomic-json.js",
    "extensions/_shared/worker-job-settlement.js"
  ]);
  for (const [file, marker] of Object.entries(manifest.moduleFingerprints)) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    assert.equal(marker, normalizedModuleFingerprint(source), `${file} static marker is stale`);
    assert.match(source, new RegExp(`PI_TOOLS_MODULE_FINGERPRINT = ["']${marker}["']`));
  }

  const discovered = discoverLocalImports([
    "extensions/worker/index.ts",
    "extensions/worker/runtime.ts",
    "extensions/async-shell/index.ts",
    "scripts/worker-host.mjs",
    "scripts/worker-sbx-rpc.mjs"
  ]);
  const missing = [...discovered].filter((file) => !manifest.files.includes(file));
  assert.deepEqual(missing, [], `generation manifest misses local runtime imports: ${missing.join(", ")}`);
});

function discoverLocalImports(entries: string[]): Set<string> {
  const discovered = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    if (discovered.has(relative)) continue;
    discovered.add(relative);
    const source = readFileSync(path.join(repoRoot, relative), "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*\(|import\s+)(["'])(\.[^"']+)\1/g)) {
      const resolved = resolveLocalImport(relative, match[2]!);
      if (resolved && !discovered.has(resolved)) pending.push(resolved);
    }
  }
  return discovered;
}

function resolveLocalImport(from: string, specifier: string): string | undefined {
  const requested = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (requested.startsWith("dist/worker-host/")) return undefined; // generated from manifest-covered extension sources
  const candidates = [requested];
  if (requested.endsWith(".js")) candidates.push(`${requested.slice(0, -3)}.ts`);
  if (!path.posix.extname(requested)) candidates.push(`${requested}.ts`, `${requested}.js`, `${requested}.mjs`);
  return candidates.find((candidate) => existsSync(path.join(repoRoot, candidate)));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedModuleFingerprint(source: string): string {
  const normalized = source.replace(/export const PI_TOOLS_MODULE_FINGERPRINT = ["'][0-9a-f]{64}["'];/, 'export const PI_TOOLS_MODULE_FINGERPRINT = "<normalized-source-fingerprint>";');
  assert.notEqual(normalized, source, "module source must export one static SHA-256 marker");
  return sha256(normalized);
}
