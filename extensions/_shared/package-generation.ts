import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@akoumjian/pi-tools";
const GENERATION_MANIFEST = "extensions/_shared/package-generation-files.json";
const PACKAGE_GENERATION_HOLDER: unique symbol = Symbol.for("@akoumjian/pi-tools/runtime-package-generation") as never;

export type PiToolsModuleGenerationMarker = {
  name: string;
  path: string;
  fingerprint: unknown;
};

export type PiToolsPackageGeneration = {
  version: 2;
  packageRoot: string;
  fingerprint: string;
  fileFingerprints: Readonly<Record<string, string>>;
  moduleFingerprints: Readonly<Record<string, string>>;
  fileStamps: Readonly<Record<string, string>>;
};

type GenerationGlobal = typeof globalThis & {
  [PACKAGE_GENERATION_HOLDER]?: unknown;
};

type GenerationManifest = {
  schemaVersion: 1;
  files: string[];
  moduleFingerprints: Record<string, string>;
};

export function createPiToolsPackageGenerationGuard(fromMetaUrl: string, moduleMarkers: readonly PiToolsModuleGenerationMarker[]): () => PiToolsPackageGeneration {
  const packageRoot = findPiToolsPackageRoot(fileURLToPath(fromMetaUrl));
  return () => assertPiToolsPackageGenerationAt(packageRoot, moduleMarkers);
}

export function assertPiToolsPackageGeneration(fromMetaUrl: string, moduleMarkers: readonly PiToolsModuleGenerationMarker[] = []): PiToolsPackageGeneration {
  return createPiToolsPackageGenerationGuard(fromMetaUrl, moduleMarkers)();
}

export function readPiToolsPackageGeneration(fromMetaUrl: string): PiToolsPackageGeneration {
  return readPiToolsPackageGenerationAt(findPiToolsPackageRoot(fileURLToPath(fromMetaUrl)));
}

export function readPiToolsPackageGenerationAt(packageRoot: string): PiToolsPackageGeneration {
  const root = realpathSync(packageRoot);
  const manifestPath = path.join(root, GENERATION_MANIFEST);
  const manifestBytes = readFileSync(manifestPath);
  const manifest = parseGenerationManifest(manifestBytes.toString("utf8"));
  const aggregate = createHash("sha256");
  aggregate.update(`${manifestBytes.length}:`);
  aggregate.update(manifestBytes);
  const fileFingerprints: Record<string, string> = {};
  const fileStamps: Record<string, string> = { [GENERATION_MANIFEST]: regularFileStamp(manifestPath) };
  for (const relative of manifest.files) {
    const file = containedManifestFile(root, relative);
    const bytes = readFileSync(file);
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    fileFingerprints[relative] = fingerprint;
    fileStamps[relative] = regularFileStamp(file);
    aggregate.update(`${Buffer.byteLength(relative)}:${relative}:${bytes.length}:`);
    aggregate.update(bytes);
  }
  return { version: 2, packageRoot: root, fingerprint: aggregate.digest("hex"), fileFingerprints, moduleFingerprints: manifest.moduleFingerprints, fileStamps };
}

export function assertCompatiblePiToolsPackageGeneration(loaded: PiToolsPackageGeneration, current: PiToolsPackageGeneration): void {
  if (loaded.packageRoot === current.packageRoot && loaded.fingerprint === current.fingerprint) return;
  throw generationChangedError(loaded, current);
}

export function assertCurrentModuleMarkers(moduleMarkers: readonly PiToolsModuleGenerationMarker[], current: PiToolsPackageGeneration): void {
  const stale = moduleMarkers.filter((item) => current.moduleFingerprints[item.path] !== item.fingerprint).map((item) => item.name);
  if (stale.length === 0) return;
  throw new Error(`Mixed @akoumjian/pi-tools worker modules are loaded (${stale.join(", ")}). Fully quit and restart Pi; /reload cannot activate package-code updates safely.`);
}

function assertPiToolsPackageGenerationAt(packageRoot: string, moduleMarkers: readonly PiToolsModuleGenerationMarker[]): PiToolsPackageGeneration {
  const globalState = globalThis as GenerationGlobal;
  const retained = globalState[PACKAGE_GENERATION_HOLDER];
  if (retained !== undefined && !isPackageGeneration(retained)) {
    throw new Error("The loaded @akoumjian/pi-tools generation guard is incompatible with the installed package. Fully quit and restart Pi.");
  }
  const loaded = retained;
  let current: PiToolsPackageGeneration;
  try {
    current = loaded?.version === 2 && loaded.packageRoot === packageRoot && generationFilesUnchanged(loaded)
      ? loaded
      : readPiToolsPackageGenerationAt(packageRoot);
  } catch (cause) {
    throw new Error(`Unable to verify the installed @akoumjian/pi-tools worker package generation. Fully quit and restart Pi after reinstalling or updating the package. ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (loaded) assertCompatiblePiToolsPackageGeneration(loaded, current);
  assertCurrentModuleMarkers(moduleMarkers, current);
  globalState[PACKAGE_GENERATION_HOLDER] = current;
  return current;
}

function generationFilesUnchanged(generation: PiToolsPackageGeneration): boolean {
  try {
    for (const [relative, expected] of Object.entries(generation.fileStamps)) {
      const file = path.join(generation.packageRoot, relative);
      if (regularFileStamp(file) !== expected) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function parseGenerationManifest(text: string): GenerationManifest {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.files) || value.files.length === 0) {
    throw new Error(`${GENERATION_MANIFEST} must contain schemaVersion 1 and a nonempty files array.`);
  }
  const files = value.files;
  if (!files.every((item): item is string => typeof item === "string" && validManifestPath(item))) {
    throw new Error(`${GENERATION_MANIFEST} contains an invalid file path.`);
  }
  const sorted = [...new Set(files)].sort((left, right) => left.localeCompare(right));
  if (sorted.length !== files.length || sorted.some((item, index) => item !== files[index])) {
    throw new Error(`${GENERATION_MANIFEST} files must be unique and sorted.`);
  }
  if (!isRecord(value.moduleFingerprints)) throw new Error(`${GENERATION_MANIFEST} must contain moduleFingerprints.`);
  const moduleFingerprints = value.moduleFingerprints;
  const modulePaths = Object.keys(moduleFingerprints).sort((left, right) => left.localeCompare(right));
  if (modulePaths.length === 0 || modulePaths.some((item) => !files.includes(item) || typeof moduleFingerprints[item] !== "string" || !/^[0-9a-f]{64}$/.test(moduleFingerprints[item]))) {
    throw new Error(`${GENERATION_MANIFEST} contains an invalid module fingerprint.`);
  }
  return { schemaVersion: 1, files, moduleFingerprints: moduleFingerprints as Record<string, string> };
}

function validManifestPath(value: string): boolean {
  if (!value || path.isAbsolute(value) || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function containedManifestFile(root: string, relative: string): string {
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error(`Generation manifest path escapes the package root: ${relative}`);
  regularFileStamp(candidate);
  return candidate;
}

function regularFileStamp(file: string): string {
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Generation manifest entry must be a regular non-symlink file: ${file}`);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function findPiToolsPackageRoot(fromPath: string): string {
  for (let dir = path.dirname(fromPath); ; dir = path.dirname(dir)) {
    const manifestPath = path.join(dir, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
      if (manifest.name === PACKAGE_NAME) return realpathSync(dir);
    } catch {}
    if (path.dirname(dir) === dir) break;
  }
  throw new Error(`Unable to locate ${PACKAGE_NAME} package root from ${fromPath}.`);
}

function generationChangedError(loaded: PiToolsPackageGeneration, current: PiToolsPackageGeneration): Error {
  const detail = loaded.packageRoot === current.packageRoot
    ? `worker package files changed (${loaded.fingerprint.slice(0, 12)} -> ${current.fingerprint.slice(0, 12)})`
    : `worker package root changed (${loaded.packageRoot} -> ${current.packageRoot})`;
  return new Error(`The installed @akoumjian/pi-tools ${detail} while this Pi process was running. Fully quit and restart Pi; /reload cannot activate package-code updates safely.`);
}

function isPackageGeneration(value: unknown): value is PiToolsPackageGeneration {
  return isRecord(value) && value.version === 2 && typeof value.packageRoot === "string" && typeof value.fingerprint === "string" && isRecord(value.fileFingerprints) && isRecord(value.moduleFingerprints) && isRecord(value.fileStamps);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
