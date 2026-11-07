import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertLocalWorkerImage, loadLocalWorkerImage, localWorkerImageReference } from "../extensions/_shared/worker-local-image.js";

const digest = "b".repeat(64);
const bytes = "exact local image archive";
const sha256 = createHash("sha256").update(bytes).digest("hex");

test("local image contract rejects registry refs, mutable tags and missing archive pins", () => {
  const valid = { reference: localWorkerImageReference(digest), digest, archive: { reference: "/image.tar", sha256 } };
  assert.doesNotThrow(() => assertLocalWorkerImage(valid));
  for (const invalid of [null, {}, { ...valid, reference: `example.invalid/image@sha256:${digest}` }, { ...valid, reference: "pi-managed-worker:latest" }, { ...valid, digest: "a".repeat(64) }, { ...valid, archive: undefined }, { ...valid, archive: { reference: "/image.tar", sha256: "invalid" } }]) {
    assert.throws(() => assertLocalWorkerImage(invalid), /local|digest/);
  }
});

test("each launch verifies and imports the exact read-only archive, never trusting template cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "worker-local-image-"));
  try {
    const archive = path.join(root, "image.tar"), sbx = path.join(root, "sbx"), log = path.join(root, "calls");
    await writeFile(archive, bytes); await chmod(archive, 0o400);
    await writeFile(sbx, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`); await chmod(sbx, 0o755);
    await loadLocalWorkerImage(sbx, archive, sha256);
    await loadLocalWorkerImage(sbx, archive, sha256);
    assert.equal(await readFile(log, "utf8"), `template load ${archive}\ntemplate load ${archive}\n`);
    await assert.rejects(loadLocalWorkerImage(sbx, archive, digest), /SHA-256 mismatch/);
    const alias = path.join(root, "alias.tar"); await symlink(archive, alias);
    await assert.rejects(loadLocalWorkerImage(sbx, alias, sha256), /ordinary file/);
    await chmod(archive, 0o600);
    await assert.rejects(loadLocalWorkerImage(sbx, archive, sha256), /ordinary file/);
    await chmod(archive, 0o400);
    await writeFile(sbx, `#!/bin/sh\nchmod 600 '${archive}'\nprintf changed > '${archive}'\nchmod 400 '${archive}'\n`);
    await assert.rejects(loadLocalWorkerImage(sbx, archive, sha256), /changed during/);
    await assert.rejects(loadLocalWorkerImage(sbx, path.join(root, "missing"), sha256), /ENOENT/);
    await assert.rejects(loadLocalWorkerImage(sbx, "https://example.invalid/image.tar", sha256), /identity/);
    await chmod(archive, 0o600); await writeFile(archive, bytes); await chmod(archive, 0o400);
    await writeFile(sbx, "#!/bin/sh\nexit 64\n");
    await assert.rejects(loadLocalWorkerImage(sbx, archive, sha256), /Command failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
