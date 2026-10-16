import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupReviewOverlay, createReviewOverlay } from "../extensions/worker/review-workspace.js";

test("review overlay uses one Docker scratch volume for upper/work and deterministic read-only evidence mounts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-review-overlay-"));
  try {
    const subject = path.join(root, "subject"); const workspace = path.join(root, "workspace"); const context = path.join(workspace, "context.json"); const session = path.join(root, "session.jsonl");
    mkdirSync(subject); mkdirSync(workspace); writeFileSync(context, "{}\n"); writeFileSync(session, "{}\n");
    const calls: string[][] = [];
    const run = (args: string[]) => { calls.push(args); if (args[0] === "volume" && args[1] === "inspect") return `/var/lib/docker/volumes/${args.at(-1)}/_data\n`; return `${args.at(-1) ?? ""}\n`; };
    const overlay = createReviewOverlay({ dockerPath: "/docker", workerId: "worker_20260101000000_aaaaaaaa", subjectWorkspace: subject, reviewerWorkspace: workspace, contextFile: context, reviewedSessionFile: session }, run);
    assert.equal(overlay.mounts.some((mount) => mount.kind === "volume" && mount.target === "/review/subject"), true);
    const create = calls.find((args) => args.includes("type=overlay")); assert.ok(create);
    assert.match(create!.join(" "), /upperdir=\/var\/lib\/docker\/volumes/);
    assert.match(create!.join(" "), /workdir=\/var\/lib\/docker\/volumes/);
    assert.equal(create!.join(" ").includes("/host_mnt"), false);
    assert.equal(overlay.mounts.some((mount) => mount.target === "/review/session.jsonl" && mount.readOnly), true);
    const cleanup: string[][] = []; cleanupReviewOverlay("/docker", overlay, (args) => { cleanup.push(args); return ""; });
    assert.deepEqual(cleanup.map((args) => args.at(-1)), [overlay.mergedVolume, overlay.scratchVolume]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
