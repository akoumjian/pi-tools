import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@akoumjian/pi-tools";
const EXECUTABLE_ROOTS = ["config", "extensions", "scripts", "skills", "worker-roles"] as const;
const PACKAGE_GENERATION_HOLDER: unique symbol = Symbol.for("@akoumjian/pi-tools/runtime-package-generation") as never;

export type PiToolsPackageGeneration = {
  version: 1;
  packageRoot: string;
  fingerprint: string;
};

type GenerationGlobal = typeof globalThis & {
  [PACKAGE_GENERATION_HOLDER]?: PiToolsPackageGeneration;
};

export function assertPiToolsPackageGeneration(fromMetaUrl: string, moduleMarkers: ReadonlyArray<{ name: string; marker: unknown }> = []): PiToolsPackageGeneration {
  const current = readPiToolsPackageGeneration(fromMetaUrl);
  assertCurrentModuleMarkers(moduleMarkers, current.fingerprint);
  const globalState = globalThis as GenerationGlobal;
  const loaded = globalState[PACKAGE_GENERATION_HOLDER];
  if (loaded) assertCompatiblePiToolsPackageGeneration(loaded, current);
  globalState[PACKAGE_GENERATION_HOLDER] = current;
  return current;
}

export function assertCompatiblePiToolsPackageGeneration(loaded: PiToolsPackageGeneration, current: PiToolsPackageGeneration): void {
  if (loaded.packageRoot === current.packageRoot && loaded.fingerprint === current.fingerprint) return;
  throw mixedGenerationError(loaded, current);
}

export function readPiToolsPackageGeneration(fromMetaUrl: string): PiToolsPackageGeneration {
  const packageRoot = findPiToolsPackageRoot(fileURLToPath(fromMetaUrl));
  return { version: 1, packageRoot, fingerprint: fingerprintExecutablePackage(packageRoot) };
}

export function fingerprintExecutablePackage(packageRoot: string): string {
  const root = realpathSync(packageRoot);
  const files = [path.join(root, "package.json")];
  for (const relativeRoot of EXECUTABLE_ROOTS) collectRegularFiles(path.join(root, relativeRoot), files);
  const hash = createHash("sha256");
  for (const file of files.sort((left, right) => left.localeCompare(right))) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const bytes = readFileSync(file);
    hash.update(`${Buffer.byteLength(relative)}:${relative}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function assertCurrentModuleMarkers(moduleMarkers: ReadonlyArray<{ name: string; marker: unknown }>, expectedFingerprint: string): void {
  const stale = moduleMarkers.filter((item) => item.marker !== expectedFingerprint).map((item) => item.name);
  if (stale.length === 0) return;
  throw new Error(`Mixed @akoumjian/pi-tools package generations are loaded (${stale.join(", ")}). Fully quit and restart Pi; /reload cannot safely replace cached package modules.`);
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

function collectRegularFiles(directory: string, files: string[]): void {
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(`Executable package path is not a real directory: ${directory}`);
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Executable package path must not be a symlink: ${candidate}`);
    if (entry.isDirectory()) collectRegularFiles(candidate, files);
    else if (entry.isFile()) files.push(candidate);
    else throw new Error(`Executable package path must be a regular file or directory: ${candidate}`);
  }
}

function mixedGenerationError(loaded: PiToolsPackageGeneration, current: PiToolsPackageGeneration): Error {
  const loadedShort = loaded.fingerprint.slice(0, 12);
  const currentShort = current.fingerprint.slice(0, 12);
  return new Error(`@akoumjian/pi-tools package code changed while this Pi process was running (${loadedShort} -> ${currentShort}). Fully quit and restart Pi; /reload cannot safely replace cached transitive modules.`);
}
