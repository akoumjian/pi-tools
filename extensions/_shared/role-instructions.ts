import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import type { WorkerRole } from "../worker/registry.js";

const PACKAGED_ROLE_ROOT = fileURLToPath(new URL("../../worker-roles/", import.meta.url));
const MAX_ROLE_INSTRUCTION_BYTES = 16 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const FILES: Record<WorkerRole, string> = { work: "work.md", review: "review.md", integration: "integration.md" };

export type VerifiedWorkerRoleInstructions = { path: string; text: string };

export function verifyWorkerRoleInstructionFile(requestedPath: string, roleRoot: string): VerifiedWorkerRoleInstructions {
  let requested: Stats;
  try { requested = lstatSync(requestedPath); } catch (error) { throw new Error(`Worker role instructions are unavailable: ${requestedPath}`, { cause: error }); }
  if (requested.isSymbolicLink() || !requested.isFile()) throw new Error(`Worker role instructions must be a regular file: ${requestedPath}`);
  if (requested.size > MAX_ROLE_INSTRUCTION_BYTES) throw new Error(`Worker role instructions exceed ${MAX_ROLE_INSTRUCTION_BYTES} bytes: ${requestedPath}`);
  const exactRoot = path.resolve(roleRoot);
  const exactPath = path.resolve(requestedPath);
  if (!strictlyBelow(exactRoot, exactPath)) throw new Error(`Worker role instructions are outside the exact role root: ${requestedPath}`);
  const canonicalRoot = realpathSync(exactRoot);
  const canonicalPath = realpathSync(exactPath);
  if (!strictlyBelow(canonicalRoot, canonicalPath)) throw new Error(`Worker role instructions escape the canonical role root: ${requestedPath}`);
  const canonical = lstatSync(canonicalPath);
  if (!canonical.isFile() || canonical.isSymbolicLink() || !sameFile(requested, canonical)) throw new Error(`Worker role instructions did not resolve to the requested regular file: ${requestedPath}`);
  const bytes = readFileSync(canonicalPath);
  if (bytes.byteLength > MAX_ROLE_INSTRUCTION_BYTES) throw new Error(`Worker role instructions exceed ${MAX_ROLE_INSTRUCTION_BYTES} bytes: ${requestedPath}`);
  let text: string;
  try { text = UTF8_DECODER.decode(bytes).trim(); } catch (error) { throw new Error(`Worker role instructions are not valid UTF-8: ${requestedPath}`, { cause: error }); }
  if (!text) throw new Error(`Worker role instructions are empty: ${requestedPath}`);
  return { path: canonicalPath, text };
}

export function workerRoleInstructions(role: WorkerRole): VerifiedWorkerRoleInstructions {
  return verifyWorkerRoleInstructionFile(path.join(PACKAGED_ROLE_ROOT, FILES[role]), PACKAGED_ROLE_ROOT);
}

function strictlyBelow(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
