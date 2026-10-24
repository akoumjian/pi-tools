import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const PI_TOOLS_MODULE_FINGERPRINT = "cb528fd2286edb4638677a3804b78a9b2ca96d084efb97503c3d200ce2c4ee2c";

/**
 * Atomically replace one private JSON file so concurrent readers observe either
 * the previous complete value or the next complete value, never a partial write.
 *
 * @param {string} target
 * @param {unknown} value
 */
export function writeAtomicJson(target, value) {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
