import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type ManagedWorkerRoleSkill = "parent" | "implementation" | "review" | "integration";

const ROLE_SKILL_DIRECTORIES: Record<ManagedWorkerRoleSkill, string> = {
  parent: "managed-worker-parent",
  implementation: "managed-worker-implementation",
  review: "managed-worker-review",
  integration: "managed-worker-integration"
};

const MAX_ROLE_SKILL_BYTES = 16 * 1024;

export function managedWorkerRoleSkillPath(role: ManagedWorkerRoleSkill): string {
  return fileURLToPath(new URL(`../../skills/${ROLE_SKILL_DIRECTORIES[role]}/SKILL.md`, import.meta.url));
}

export function managedWorkerRoleSkillText(role: ManagedWorkerRoleSkill): string {
  const requested = managedWorkerRoleSkillPath(role);
  const canonical = realpathSync(requested);
  const metadata = lstatSync(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_ROLE_SKILL_BYTES) {
    throw new Error(`Managed-worker ${role} role skill is not a bounded single-link file: ${requested}`);
  }
  const content = readFileSync(canonical, "utf8");
  if (!content.trim() || content.includes("\uFFFD")) throw new Error(`Managed-worker ${role} role skill is not valid UTF-8 text: ${requested}`);
  return content.trim();
}

export function exclusiveManagedWorkerRoleSkillOptions(role: ManagedWorkerRoleSkill): {
  noSkills: true;
  additionalSkillPaths: string[];
} {
  return { noSkills: true, additionalSkillPaths: [managedWorkerRoleSkillPath(role)] };
}
