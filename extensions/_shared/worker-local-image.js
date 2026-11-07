import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;

export function localWorkerImageReference(configDigest) {
  if (!SHA256.test(configDigest)) throw new Error("Invalid local worker image configuration digest.");
  return `pi-managed-worker:sha256-${configDigest}`;
}

export function assertLocalWorkerImage(image) {
  if (!image || typeof image.digest !== "string" || !SHA256.test(image.digest) || image.reference !== localWorkerImageReference(image.digest) || !image.archive || typeof image.archive.reference !== "string" || !image.archive.reference.trim() || !SHA256.test(image.archive.sha256)) {
    throw new Error("Worker images require a content-addressed local tag and a SHA-256-pinned local archive; build the native local release first.");
  }
}

function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.uid].join(":");
}

function assertArchive(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o400) {
    throw new Error("Local worker image archive must be an owner-only, read-only ordinary file (0400).");
  }
}

// The CLI exposes only a truncated template ID. It is not an integrity authority.
// Always import the exact hashed archive before creation, never trust a cached tag.
export async function loadLocalWorkerImage(sbx, archivePath, expectedSha256) {
  if (!path.isAbsolute(archivePath) || !SHA256.test(expectedSha256)) throw new Error("Invalid local worker archive identity.");
  const before = await lstat(archivePath);
  assertArchive(before);
  const file = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const expectedIdentity = identity(before);
    const unchanged = async () => {
      if (identity(await file.stat()) !== expectedIdentity || identity(await lstat(archivePath)) !== expectedIdentity) {
        throw new Error("Local worker image archive changed during verification or import.");
      }
    };
    await unchanged();
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest("hex") !== expectedSha256) throw new Error("Local worker image archive SHA-256 mismatch; refusing import.");
    await unchanged();
    await exec(sbx, ["template", "load", archivePath], { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
    await unchanged();
  } finally {
    await file.close();
  }
}
