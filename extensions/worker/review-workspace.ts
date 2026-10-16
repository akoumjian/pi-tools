import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { WorkerContainerMount } from "../_shared/worker-container.js";

export type ReviewOverlayRecord = { version: 1; mergedVolume: string; upperVolume: string; workVolume: string; mounts: WorkerContainerMount[] };
export type DockerRunner = (args: string[]) => string;

export function createReviewOverlay(input: { dockerPath: string; workerId: string; subjectWorkspace: string; reviewerWorkspace: string; contextFile: string; additionalInputs?: string[] }, run: DockerRunner = (args) => docker(input.dockerPath, args)): ReviewOverlayRecord {
  const suffix = input.workerId.replaceAll(/[^A-Za-z0-9_.-]/g, "-").slice(-48);
  const upperVolume = `pi-review-upper-${suffix}`;
  const workVolume = `pi-review-work-${suffix}`;
  const mergedVolume = `pi-review-subject-${suffix}`;
  const created: string[] = [];
  try {
    for (const name of [upperVolume, workVolume]) { run(["volume", "create", name]); created.push(name); }
    const upper = volumeMountpoint(run, upperVolume);
    const work = volumeMountpoint(run, workVolume);
    const lower = dockerDaemonPath(realDirectory(input.subjectWorkspace));
    run(["volume", "create", "--driver", "local", "--opt", "type=overlay", "--opt", "device=overlay", "--opt", `o=lowerdir=${lower},upperdir=${upper},workdir=${work}`, mergedVolume]);
    created.push(mergedVolume);
    const mounts: WorkerContainerMount[] = [
      { kind: "volume", source: mergedVolume, target: "/review/subject" },
      { kind: "bind", source: realDirectory(input.reviewerWorkspace), target: "/workspace" },
      { kind: "bind", source: realFile(input.contextFile), target: "/review/context.json", readOnly: true },
      ...(input.additionalInputs ?? []).map((value, index) => ({ kind: "bind" as const, source: realInput(value), target: `/review/inputs/${String(index + 1).padStart(2, "0")}-${path.basename(value)}`, readOnly: true }))
    ];
    return { version: 1, mergedVolume, upperVolume, workVolume, mounts };
  } catch (error) {
    for (const name of created.reverse()) { try { run(["volume", "rm", "--force", name]); } catch {} }
    throw new Error(`Review OverlayFS preflight failed; rootful Docker with local overlay volumes is required: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function cleanupReviewOverlay(dockerPath: string, overlay: ReviewOverlayRecord, run: DockerRunner = (args) => docker(dockerPath, args)): void {
  for (const name of [overlay.mergedVolume, overlay.upperVolume, overlay.workVolume]) run(["volume", "rm", "--force", name]);
}

function volumeMountpoint(run: DockerRunner, name: string): string {
  const value = run(["volume", "inspect", "--format", "{{.Mountpoint}}", name]).trim();
  if (!value.startsWith("/")) throw new Error(`Docker returned invalid volume mountpoint for ${name}.`);
  return value;
}
function dockerDaemonPath(value: string): string {
  return process.platform === "darwin" && value.startsWith("/Users/") ? `/host_mnt${value}` : value;
}
function realDirectory(value: string): string { const exact = realpathSync(path.resolve(value)); if (!statSync(exact).isDirectory()) throw new Error(`Expected directory: ${value}`); return exact; }
function realFile(value: string): string { const exact = realpathSync(path.resolve(value)); if (!statSync(exact).isFile()) throw new Error(`Expected file: ${value}`); return exact; }
function realInput(value: string): string { const exact = realpathSync(path.resolve(value)); const stat = statSync(exact); if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Additional input must be a file or directory: ${value}`); return exact; }
function docker(dockerPath: string, args: string[]): string { return execFileSync(dockerPath, args, { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] }); }
