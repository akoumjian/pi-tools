/** @typedef {"linux/amd64" | "linux/arm64"} WorkerSandboxPlatform */

/**
 * Map native host processes to Linux Sandbox images. Do not emulate or fall back.
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {WorkerSandboxPlatform}
 */
export function resolveWorkerSandboxPlatform(platform = process.platform, arch = process.arch) {
  if (platform === "linux" && arch === "x64") return "linux/amd64";
  if ((platform === "linux" || platform === "darwin") && arch === "arm64") return "linux/arm64";
  throw new Error(`Unsupported Worker Sandbox host ${platform}/${arch}; use native Linux AMD64/ARM64 or Apple Silicon Node.`);
}

/**
 * Select a complete platform-specific release before any integrity validation.
 * A missing/candidate native release must never select another platform instead.
 * @param {unknown} manifest
 * @param {WorkerSandboxPlatform} [platform]
 * @returns {Record<string, unknown>}
 */
export function selectWorkerSandboxRelease(manifest, platform = resolveWorkerSandboxPlatform()) {
  if (!isObject(manifest) || manifest.schemaVersion !== 3 || !isObject(manifest.platforms)) {
    throw new Error("Worker Sandbox configuration requires a schemaVersion 3 platform manifest; update the managed profile.");
  }
  if (Object.keys(manifest.platforms).some((key) => key !== "linux/amd64" && key !== "linux/arm64")) {
    throw new Error("Worker Sandbox manifest declares an unsupported image platform.");
  }
  const release = manifest.platforms[platform];
  if (!isObject(release)) throw new Error(`Worker Sandbox release is unavailable for ${platform}; no other architecture will be substituted.`);
  return release;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
