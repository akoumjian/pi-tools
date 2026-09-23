import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

export type ManagedWorkerRoleSkill = "parent" | "implementation" | "review" | "integration";

const ROLE_SKILL_DIRECTORIES: Record<ManagedWorkerRoleSkill, string> = {
  parent: "managed-worker-parent",
  implementation: "managed-worker-implementation",
  review: "managed-worker-review",
  integration: "managed-worker-integration"
};

const PACKAGED_SKILLS_ROOT = fileURLToPath(new URL("../../skills/", import.meta.url));
const MAX_ROLE_SKILL_BYTES = 16 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type VerifiedManagedWorkerRoleSkill = {
  path: string;
  text: string;
};

function isStrictlyBelow(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function verifyManagedWorkerRoleSkillFile(requestedPath: string, skillsRoot: string): VerifiedManagedWorkerRoleSkill {
  let requestedMetadata: Stats;
  try {
    requestedMetadata = lstatSync(requestedPath);
  } catch (error) {
    throw new Error(`Managed-worker role skill is unavailable: ${requestedPath}`, { cause: error });
  }
  if (requestedMetadata.isSymbolicLink()) {
    throw new Error(`Managed-worker role skill must not be a direct symbolic link: ${requestedPath}`);
  }
  if (!requestedMetadata.isFile()) {
    throw new Error(`Managed-worker role skill is not a regular file: ${requestedPath}`);
  }
  if (requestedMetadata.size > MAX_ROLE_SKILL_BYTES) {
    throw new Error(`Managed-worker role skill exceeds ${MAX_ROLE_SKILL_BYTES} bytes: ${requestedPath}`);
  }

  const exactRoot = path.resolve(skillsRoot);
  const exactRequested = path.resolve(requestedPath);
  if (!isStrictlyBelow(exactRoot, exactRequested)) {
    throw new Error(`Managed-worker role skill is outside the exact skills root: ${requestedPath}`);
  }

  let canonicalRoot: string;
  let canonicalPath: string;
  try {
    canonicalRoot = realpathSync(exactRoot);
    canonicalPath = realpathSync(exactRequested);
  } catch (error) {
    throw new Error(`Managed-worker role skill cannot be resolved: ${requestedPath}`, { cause: error });
  }
  if (!isStrictlyBelow(canonicalRoot, canonicalPath)) {
    throw new Error(`Managed-worker role skill escapes the canonical skills root: ${requestedPath}`);
  }

  const canonicalMetadata = lstatSync(canonicalPath);
  if (!canonicalMetadata.isFile() || canonicalMetadata.isSymbolicLink() || !sameFile(requestedMetadata, canonicalMetadata)) {
    throw new Error(`Managed-worker role skill did not resolve to the requested regular file: ${requestedPath}`);
  }
  if (canonicalMetadata.size > MAX_ROLE_SKILL_BYTES) {
    throw new Error(`Managed-worker role skill exceeds ${MAX_ROLE_SKILL_BYTES} bytes: ${requestedPath}`);
  }

  const bytes = readFileSync(canonicalPath);
  if (bytes.byteLength > MAX_ROLE_SKILL_BYTES) {
    throw new Error(`Managed-worker role skill exceeds ${MAX_ROLE_SKILL_BYTES} bytes: ${requestedPath}`);
  }
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new Error(`Managed-worker role skill is not valid UTF-8: ${requestedPath}`, { cause: error });
  }
  if (!text.trim()) {
    throw new Error(`Managed-worker role skill is empty: ${requestedPath}`);
  }
  return { path: canonicalPath, text: text.trim() };
}

function verifiedManagedWorkerRoleSkill(role: ManagedWorkerRoleSkill): VerifiedManagedWorkerRoleSkill {
  const requested = path.join(PACKAGED_SKILLS_ROOT, ROLE_SKILL_DIRECTORIES[role], "SKILL.md");
  return verifyManagedWorkerRoleSkillFile(requested, PACKAGED_SKILLS_ROOT);
}

export function managedWorkerRoleSkillPath(role: ManagedWorkerRoleSkill): string {
  return verifiedManagedWorkerRoleSkill(role).path;
}

export function managedWorkerRoleSkillText(role: ManagedWorkerRoleSkill): string {
  return verifiedManagedWorkerRoleSkill(role).text;
}

export function exclusiveManagedWorkerRoleSkillOptions(role: ManagedWorkerRoleSkill): {
  noSkills: true;
  additionalSkillPaths: string[];
} {
  return { noSkills: true, additionalSkillPaths: [managedWorkerRoleSkillPath(role)] };
}
