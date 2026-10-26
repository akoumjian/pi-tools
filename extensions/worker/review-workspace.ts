import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isWorkerId } from "../_shared/worker-id.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^run_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const GUEST_MERGED = "/review/subject";
const GUEST_SCRATCH_ROOT = "/run/pi-worker/review-overlays";

export type ReviewWorkspaceOverlay = {
  version: 1;
  workerId: string;
  runId: string;
  lowerDirectory: string;
  lowerDevice: number;
  lowerInode: number;
  scratchDirectory: string;
  upperDirectory: string;
  workDirectory: string;
  mergedDirectory: string;
  setupEvidenceSha256?: string;
};

export type ReviewOverlayExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** Plan one fresh guest-native OverlayFS identity. No subject bytes are copied. */
export function planReviewWorkspaceOverlay(input: { workerId: string; runId: string; subjectWorkspace: string }): ReviewWorkspaceOverlay {
  if (!isWorkerId(input.workerId) || !RUN_ID.test(input.runId)) throw new Error("Invalid review OverlayFS worker/run identity.");
  const lowerDirectory = realpathSync(path.resolve(input.subjectWorkspace));
  const lower = statSync(lowerDirectory);
  if (!lower.isDirectory()) throw new Error("Review OverlayFS lower layer must be an ordinary directory.");
  const identity = createHash("sha256").update(`${input.workerId}\0${input.runId}`).digest("hex").slice(0, 24);
  const scratchDirectory = path.posix.join(GUEST_SCRATCH_ROOT, identity);
  return {
    version: 1,
    workerId: input.workerId,
    runId: input.runId,
    lowerDirectory,
    lowerDevice: Number(lower.dev),
    lowerInode: Number(lower.ino),
    scratchDirectory,
    upperDirectory: path.posix.join(scratchDirectory, "upper"),
    workDirectory: path.posix.join(scratchDirectory, "work"),
    mergedDirectory: GUEST_MERGED
  };
}

/**
 * Mount the read-only host lower through a private in-Sandbox upper/work layer.
 * Local sbx v0.49.1 root+privileged exec is mandatory; there is no copy or
 * ordinary-Docker fallback. The Sandbox itself owns and disposes every guest path.
 */
export async function createReviewWorkspaceOverlayAsync(
  sbxPath: string,
  sandboxName: string,
  overlay: ReviewWorkspaceOverlay,
  run: ReviewOverlayExec = (args) => execute(sbxPath, args)
): Promise<ReviewWorkspaceOverlay> {
  assertReviewWorkspaceOverlay(overlay, false);
  assertReviewWorkspaceLowerIdentity(overlay);
  const script = String.raw`set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset BASH_ENV ENV
lower=$1
scratch=$2
upper=$3
work=$4
merged=$5
test "$(id -u)" = 0
test -d "$lower"
case "$scratch:$upper:$work:$merged" in /run/pi-worker/review-overlays/*:/run/pi-worker/review-overlays/*/upper:/run/pi-worker/review-overlays/*/work:/review/subject) ;; *) exit 61 ;; esac
rm -rf "$scratch" "$merged"
mkdir -p "$upper" "$work" "$merged"
mount -t overlay overlay -o "lowerdir=$lower,upperdir=$upper,workdir=$work,metacopy=on" "$merged"
chown 1000:1000 "$merged"
chmod u+rwx "$merged"
test "$(find "$upper" -mindepth 1 -print -quit)" = ""
grep -F " $merged overlay " /proc/mounts >/dev/null
printf 'PI_REVIEW_OVERLAY_V1\nlower=%s\nscratch=%s\nupper=%s\nwork=%s\nmerged=%s\n' "$lower" "$scratch" "$upper" "$work" "$merged"`;
  const mounted = await run(["exec", "--user", "root", "--privileged", sandboxName, "/usr/bin/env", "-u", "BASH_ENV", "-u", "ENV", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "/bin/sh", "-ceu", script, "pi-review-overlay", overlay.lowerDirectory, overlay.scratchDirectory, overlay.upperDirectory, overlay.workDirectory, overlay.mergedDirectory]);
  const expected = `PI_REVIEW_OVERLAY_V1\nlower=${overlay.lowerDirectory}\nscratch=${overlay.scratchDirectory}\nupper=${overlay.upperDirectory}\nwork=${overlay.workDirectory}\nmerged=${overlay.mergedDirectory}\n`;
  if (mounted.stdout !== expected) throw new Error("Review OverlayFS setup did not return exact identity evidence.");
  const writable = await run(["exec", "--user", "1000", "--workdir", overlay.mergedDirectory, sandboxName, "/bin/sh", "-ceu", 'test "$(id -u)" = 1000; test -d .; test -w .; printf "PI_REVIEW_OVERLAY_WRITABLE_V1\\n"']);
  if (writable.stdout !== "PI_REVIEW_OVERLAY_WRITABLE_V1\n") throw new Error("Review OverlayFS merged view is not writable by the reviewer identity.");
  const setupEvidenceSha256 = createHash("sha256").update(JSON.stringify({ sandboxName, args: [overlay.lowerDirectory, overlay.scratchDirectory, overlay.upperDirectory, overlay.workDirectory, overlay.mergedDirectory], mounted, writable })).digest("hex");
  const result = { ...overlay, setupEvidenceSha256 };
  assertReviewWorkspaceOverlay(result, true);
  return result;
}

export function assertReviewWorkspaceOverlay(value: ReviewWorkspaceOverlay, requireEvidence: boolean): void {
  if (value.version !== 1 || !isWorkerId(value.workerId) || !RUN_ID.test(value.runId)) throw new Error("Invalid exact review OverlayFS identity.");
  if (!path.isAbsolute(value.lowerDirectory) || path.normalize(value.lowerDirectory) !== value.lowerDirectory || /[\u0000-\u0020,:\\]/.test(value.lowerDirectory) || !Number.isSafeInteger(value.lowerDevice) || value.lowerDevice < 0 || !Number.isSafeInteger(value.lowerInode) || value.lowerInode < 0) throw new Error("Invalid or unsafe review OverlayFS lower layer.");
  const expected = planPaths(value.workerId, value.runId);
  if (value.scratchDirectory !== expected.scratchDirectory || value.upperDirectory !== expected.upperDirectory || value.workDirectory !== expected.workDirectory || value.mergedDirectory !== GUEST_MERGED) throw new Error("Invalid exact review OverlayFS guest paths.");
  if (value.setupEvidenceSha256 !== undefined && !SHA256.test(value.setupEvidenceSha256)) throw new Error("Invalid review OverlayFS setup evidence digest.");
  if (requireEvidence && !value.setupEvidenceSha256) throw new Error("Review OverlayFS setup evidence is required before launch.");
}

export function assertReviewWorkspaceLowerIdentity(value: ReviewWorkspaceOverlay): void {
  let exact: string; try { exact = realpathSync(value.lowerDirectory); } catch { throw new Error("Review OverlayFS lower layer disappeared before Sandbox creation."); }
  const current = statSync(exact);
  if (exact !== value.lowerDirectory || !current.isDirectory() || Number(current.dev) !== value.lowerDevice || Number(current.ino) !== value.lowerInode) throw new Error("Review OverlayFS lower layer identity changed before Sandbox creation.");
}

function planPaths(workerId: string, runId: string): Pick<ReviewWorkspaceOverlay, "scratchDirectory" | "upperDirectory" | "workDirectory"> {
  const identity = createHash("sha256").update(`${workerId}\0${runId}`).digest("hex").slice(0, 24);
  const scratchDirectory = path.posix.join(GUEST_SCRATCH_ROOT, identity);
  return { scratchDirectory, upperDirectory: path.posix.join(scratchDirectory, "upper"), workDirectory: path.posix.join(scratchDirectory, "work") };
}

async function execute(sbxPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(sbxPath, args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000 });
  return { stdout: result.stdout, stderr: result.stderr };
}
