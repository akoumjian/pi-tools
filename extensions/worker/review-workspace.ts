import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { WORKER_CONTAINER_IMAGE, type WorkerContainerMount } from "../_shared/worker-container.js";

export type ReviewOverlayRecord = { version: 2; mergedVolume: string; scratchVolume: string; mounts: WorkerContainerMount[] };
export type DockerRunner = (args: string[]) => string;
export type ReviewMountedInput = { source: string; target: string };

/** Create and live-mount the proven one-scratch-volume OverlayFS recipe before a review becomes launchable. */
export function createReviewOverlay(input: {
  dockerPath: string; workerId: string; runId?: string; subjectWorkspace: string; reviewerWorkspace: string;
  contextFile: string; reviewedSessionFile: string; additionalInputs?: ReviewMountedInput[];
}, run: DockerRunner = (args) => docker(input.dockerPath, args)): ReviewOverlayRecord {
  const identity = `${input.workerId}-${input.runId ?? randomBytes(6).toString("hex")}`.replaceAll(/[^A-Za-z0-9_.-]/g, "-").slice(-42);
  const nonce = randomBytes(5).toString("hex");
  const scratchVolume = `pi-review-scratch-${identity}-${nonce}`;
  const mergedVolume = `pi-review-subject-${identity}-${nonce}`;
  const created: string[] = [];
  try {
    run(["volume", "create", scratchVolume]); created.push(scratchVolume);
    run(["run", "--rm", "--network", "none", "--mount", `type=volume,src=${scratchVolume},dst=/overlay`, "--entrypoint", "/bin/sh", WORKER_CONTAINER_IMAGE, "-c", "mkdir -p /overlay/upper /overlay/work && chmod 700 /overlay/upper /overlay/work"]);
    const scratch = volumeMountpoint(run, scratchVolume);
    const lower = realDirectory(input.subjectWorkspace);
    run(["volume", "create", "--driver", "local", "--opt", "type=overlay", "--opt", "device=overlay", "--opt", `o=lowerdir=${lower},upperdir=${scratch}/upper,workdir=${scratch}/work`, mergedVolume]);
    created.push(mergedVolume);
    run(["run", "--rm", "--network", "none", "--mount", `type=volume,src=${mergedVolume},dst=/subject`, "--entrypoint", "/bin/sh", WORKER_CONTAINER_IMAGE, "-c", "test -d /subject"]);
    const mounts: WorkerContainerMount[] = [
      { kind: "volume", source: mergedVolume, target: "/review/subject" },
      { kind: "bind", source: realDirectory(input.reviewerWorkspace), target: "/workspace" },
      { kind: "bind", source: realFile(input.contextFile), target: "/review/context.json", readOnly: true },
      { kind: "bind", source: realFile(input.reviewedSessionFile), target: "/review/session.jsonl", readOnly: true },
      ...(input.additionalInputs ?? []).map((item) => ({ kind: "bind" as const, source: realInput(item.source), target: item.target, readOnly: true }))
    ];
    return { version: 2, mergedVolume, scratchVolume, mounts };
  } catch (error) {
    for (const name of created.reverse()) { try { run(["volume", "rm", "--force", name]); } catch {} }
    throw new Error(`Review OverlayFS preflight failed; rootful Docker with local overlay volumes is required: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function cleanupReviewOverlay(dockerPath: string, overlay: ReviewOverlayRecord, run: DockerRunner = (args) => docker(dockerPath, args)): void {
  run(["volume", "rm", "--force", overlay.mergedVolume]);
  run(["volume", "rm", "--force", overlay.scratchVolume]);
}

function volumeMountpoint(run: DockerRunner, name: string): string {
  const value = run(["volume", "inspect", "--format", "{{.Mountpoint}}", name]).trim();
  if (!value.startsWith("/")) throw new Error(`Docker returned invalid volume mountpoint for ${name}.`);
  return value;
}
function realDirectory(value: string): string { const exact = realpathSync(path.resolve(value)); if (!statSync(exact).isDirectory()) throw new Error(`Expected directory: ${value}`); return exact; }
function realFile(value: string): string { const exact = realpathSync(path.resolve(value)); if (!statSync(exact).isFile()) throw new Error(`Expected file: ${value}`); return exact; }
function realInput(value: string): string { const exact = realpathSync(path.resolve(value)); const stat = statSync(exact); if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Additional input must be a file or directory: ${value}`); return exact; }
function docker(dockerPath: string, args: string[]): string { return execFileSync(dockerPath, args, { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] }); }
