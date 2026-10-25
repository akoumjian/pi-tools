import { homedir } from "node:os";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { WorkerRole } from "./registry.js";
import type { MountedInput } from "./prompts.js";

export type RetainedInput = MountedInput & { source: string; target: string };

export function validateAdditionalInputs(input: {
  values?: string[]; existing?: RetainedInput[]; role: WorkerRole; workspaceRoot: string; runtimeRoot: string;
}): RetainedInput[] {
  const existing = [...(input.existing ?? [])];
  const home = homedir();
  const sensitive = [input.runtimeRoot, path.join(home, ".pi"), path.join(home, ".ssh"), path.join(home, ".aws"), path.join(home, ".gnupg"), path.join(home, ".config"), path.join(home, ".docker"), path.join(home, ".kube"), path.join(home, ".netrc"), path.join(home, ".git-credentials"), path.join(home, ".npmrc"), path.join(home, ".local", "share", "agent"), process.env.XDG_CONFIG_HOME, process.env.AWS_SHARED_CREDENTIALS_FILE, process.env.AWS_CONFIG_FILE, process.env.KUBECONFIG, process.env.DOCKER_CONFIG, process.env.NPM_CONFIG_USERCONFIG, process.env.BEADS_DIR, input.workspaceRoot]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .flatMap((value) => { try { return [realpathSync(path.resolve(value))]; } catch { return []; } });
  const allSources = new Set(existing.map((item) => item.source));
  for (const raw of input.values ?? []) {
    if (Buffer.byteLength(raw) > 4096) throw new Error(`Additional input path exceeds 4096 UTF-8 bytes: ${raw}.`);
    const source = realpathSync(path.resolve(raw)); const metadata = statSync(source);
    if (!metadata.isFile() && !metadata.isDirectory()) throw new Error(`Additional input must be a regular file or directory: ${raw}.`);
    if (sensitive.some((root) => overlaps(root, source))) throw new Error(`Additional input overlaps a sensitive or writable root: ${raw}.`);
    if (allSources.has(source)) throw new Error(`Duplicate additional input: ${raw}.`);
    if ([...allSources].some((other) => overlaps(other, source))) throw new Error(`Additional inputs cannot contain or overlap one another: ${raw}.`);
    const target = source;
    if (existing.some((item) => item.target === target)) throw new Error(`Additional-input mount target collision: ${target}.`);
    const type = metadata.isDirectory() ? "directory" as const : "file" as const;
    existing.push({ source, target, sourcePath: source, mountedPath: target, type }); allSources.add(source);
  }
  return existing;
}

export function inputMounts(inputs: RetainedInput[]): Array<{ source: string; readOnly: true }> { return inputs.map((item) => ({ source: item.source, readOnly: true })); }
export function contextInputs(inputs: RetainedInput[]): MountedInput[] { return inputs.map(({ sourcePath, mountedPath, type }) => ({ sourcePath, mountedPath, type })); }
function overlaps(a: string, b: string): boolean { return a === b || within(a, b) || within(b, a); }
function within(root: string, value: string): boolean { const relative = path.relative(root, value); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
