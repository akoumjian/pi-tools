export type LocalWorkerImage = { reference: string; digest: string; archive: { reference: string; sha256: string } };
/** digest is the Docker image configuration SHA-256, not a registry manifest digest. */
export function localWorkerImageReference(configDigest: string): string;
export function assertLocalWorkerImage(image: unknown): asserts image is LocalWorkerImage;
export function loadLocalWorkerImage(sbx: string, archivePath: string, expectedSha256: string): Promise<void>;
