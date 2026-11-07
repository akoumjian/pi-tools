export type WorkerSandboxPlatform = "linux/amd64" | "linux/arm64";
export function resolveWorkerSandboxPlatform(platform?: string, arch?: string): WorkerSandboxPlatform;
export function selectWorkerSandboxRelease(manifest: unknown, platform?: WorkerSandboxPlatform): Record<string, unknown>;
