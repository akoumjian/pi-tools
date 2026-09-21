import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

export function resolveExecutable(name: string, pathValue = process.env.PATH): string {
  for (const directory of (pathValue ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      }
    } catch {}
  }
  throw new Error(`Required executable is unavailable on PATH: ${name}`);
}
