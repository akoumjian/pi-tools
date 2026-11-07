import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { readPiToolsJsonConfigSource, resolvePiToolsConfigReference } from "../_shared/config.js";
import { resolveExecutable } from "../_shared/executable.js";
import { resolveWorkerSandboxPlatform, selectWorkerSandboxRelease } from "../_shared/worker-platform.js";
import { assertLocalWorkerImage, loadLocalWorkerImage, type LocalWorkerImage } from "../_shared/worker-local-image.js";
import { isWorkerId } from "../_shared/worker-id.js";
import { assertReviewWorkspaceLowerIdentity, assertReviewWorkspaceOverlay, createReviewWorkspaceOverlayAsync, planReviewWorkspaceOverlay, type ReviewWorkspaceOverlay } from "./review-workspace.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const SANDBOX_NAME = /^pi-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SBX_VERSION = "v0.49.1";
export type WorkerSandboxResources = { cpus: number; memoryGiB: number };
export type WorkerSandboxResourceRequest = Partial<WorkerSandboxResources>;
export const DEFAULT_WORKER_SANDBOX_RESOURCES: WorkerSandboxResources = Object.freeze({ cpus: 1, memoryGiB: 4 });
export const MAX_WORKER_SANDBOX_RESOURCES: WorkerSandboxResources = Object.freeze({ cpus: 8, memoryGiB: 16 });
export const WORKER_SANDBOX_CPU_LIMIT = DEFAULT_WORKER_SANDBOX_RESOURCES.cpus;
export const WORKER_SANDBOX_MEMORY_LIMIT = `${DEFAULT_WORKER_SANDBOX_RESOURCES.memoryGiB}g`;
const SBX_VERSION_LINE = /^sbx version (v\d+\.\d+\.\d+) ([a-f0-9]{40})\n?$/;
const SBX_UPDATE_BANNER = [
  "╭──────────────────────────────────────────────────────────────────────────────────╮",
  "│ Docker Sandboxes Update Available                                                │",
  "├──────────────────────────────────────────────────────────────────────────────────┤",
  "│ v0.49.1  →  v0.49.2                                                              │",
  "├──────────────────────────────────────────────────────────────────────────────────┤",
  "│ Release notes  https://github.com/docker/sbx-releases/releases/tag/v0.49.2       │",
  "├──────────────────────────────────────────────────────────────────────────────────┤",
  "│ To upgrade     brew upgrade docker/tap/sbx                                       │",
  "╰──────────────────────────────────────────────────────────────────────────────────╯",
].join("\n");

export type WorkerSandboxMount = { source: string; readOnly?: boolean };
export type WorkerSandboxRelease = {
  schemaVersion: 2; protocolVersion: 1; releaseOrdinal: number; status: "approved";
  kit: { reference: string; sha256: string }; image: LocalWorkerImage;
  sandbox: { version: "v0.49.1"; buildCommit: string };
  revisions: { pi: string; profile: string; piTools: string; piDocparser: string };
  guest: { stagedLockSha256: string; piCli: string; rpcLauncher: string; codingAgentDir: string; resourceManifestSha256: string; runtimeProvenanceSha256: string; extensionPaths: string[]; searxngUrl: string };
};
export type WorkerSandboxReference = {
  kind: "docker-sandbox"; sandboxName: string; creationNonce: string; workerId: string; runId: string;
  kitReference: string; kitSha256: string; imageReference: string; imageDigest: string; imageArchive: string; imageArchiveSha256: string; sbxVersion: "v0.49.1"; sbxBuildCommit: string; protocolVersion: 1; releaseOrdinal: number;
  workspaceRoot: string; workspaceDevice?: number; workspaceInode?: number; workspaceOwnerUid?: number; workspaceOwnerGid?: number; workingDirectory: string; codeRoot: string; mounts: WorkerSandboxMount[]; reviewOverlay?: ReviewWorkspaceOverlay; piCli: string; rpcLauncher: string; codingAgentDir: string;
  stagedLockSha256: string; resourceManifestSha256: string; runtimeProvenanceSha256: string; extensionPaths: string[]; searxngUrl: string; revisions: WorkerSandboxRelease["revisions"];
  requestedCpu?: number; requestedMemoryGiB?: number;
  createEvidenceSha256?: string; inspectEvidenceSha256?: string; sbxVersionEvidenceSha256?: string; observedCpu?: number; observedMemoryBytes?: number; observedSandboxId?: string; observedRuntimeSha256?: string;
};

export function readApprovedWorkerSandboxRelease(): WorkerSandboxRelease {
  const config = readPiToolsJsonConfigSource("worker-sandbox-runtime.json", import.meta.url);
  if (!config) throw new Error("Managed workers require worker-sandbox-runtime.json from an approved profile release.");
  const platform = resolveWorkerSandboxPlatform();
  const value = selectWorkerSandboxRelease(config.data, platform) as Partial<WorkerSandboxRelease>; const releaseOrdinal = value.releaseOrdinal;
  if (value.schemaVersion !== 2 || value.protocolVersion !== 1 || !Number.isSafeInteger(releaseOrdinal) || releaseOrdinal! < 1 || value.status !== "approved") throw new Error(`Worker Sandbox runtime for ${platform} is not an approved schemaVersion 2 release.`);
  const kit = value.kit; const image = value.image; const sandbox = value.sandbox; const revisions = value.revisions; const guest = value.guest;
  if (!kit || typeof kit.reference !== "string" || !SHA256.test(String(kit.sha256))) throw new Error("Worker Sandbox release requires an exact kit reference and SHA-256.");
  assertLocalWorkerImage(image);
  const archive = resolvePiToolsConfigReference(image.archive.reference, config.path);
  if (archive instanceof URL) throw new Error("Worker image archives must be local files; downloads are forbidden.");
  if (!sandbox || sandbox.version !== SBX_VERSION || !/^[a-f0-9]{40}$/.test(String(sandbox.buildCommit)) || Object.hasOwn(sandbox, "template")) throw new Error("Worker Sandbox release requires exact sbx v0.49.1 identity without template-store state.");
  if (!revisions || ![revisions.pi, revisions.profile, revisions.piTools, revisions.piDocparser].every((revision) => typeof revision === "string" && /^[a-f0-9]{40}$/.test(revision))) throw new Error("Worker Sandbox release revisions must be exact 40-character commits.");
  if (!guest || !SHA256.test(String(guest.stagedLockSha256)) || !path.posix.isAbsolute(String(guest.piCli)) || !path.posix.isAbsolute(String(guest.rpcLauncher)) || guest.codingAgentDir !== "/run/pi-worker/agent" || !SHA256.test(String(guest.resourceManifestSha256)) || !SHA256.test(String(guest.runtimeProvenanceSha256)) || !Array.isArray(guest.extensionPaths) || guest.extensionPaths.length < 1 || !guest.extensionPaths.every((item) => typeof item === "string" && isImmutableGuestExtensionPath(item)) || new Set(guest.extensionPaths).size !== guest.extensionPaths.length || typeof guest.searxngUrl !== "string" || !isCredentialFreeHttpUrl(guest.searxngUrl)) throw new Error("Worker Sandbox release guest paths and resource manifest are invalid.");
  const resolved = resolvePiToolsConfigReference(kit.reference, config.path);
  if (resolved instanceof URL) throw new Error("Worker Sandbox releases require a locally verified ordinary kit directory; URL kits cannot prove exact content.");
  const kitReference = realpathSync(resolved);
  if (hashDirectory(kitReference) !== kit.sha256) throw new Error("Worker Sandbox kit content does not match the approved SHA-256.");
  assertKitImageReference(kitReference, image.reference);
  return { schemaVersion: 2, protocolVersion: 1, releaseOrdinal: releaseOrdinal!, status: "approved", kit: { reference: kitReference, sha256: kit.sha256 }, image: { ...image, archive: { reference: archive, sha256: image.archive.sha256 } }, sandbox: { version: SBX_VERSION, buildCommit: sandbox.buildCommit }, revisions: { ...revisions }, guest: { ...guest, extensionPaths: [...guest.extensionPaths] } };
}

export function resolveWorkerSandboxResources(value?: WorkerSandboxResourceRequest): WorkerSandboxResources {
  if (value === undefined) return { ...DEFAULT_WORKER_SANDBOX_RESOURCES };
  const keys = !value || typeof value !== "object" || Array.isArray(value) ? [] : Object.keys(value).sort();
  if (keys.length < 1 || keys.some((key) => key !== "cpus" && key !== "memoryGiB")) throw new Error("Worker Sandbox resources allow only cpus and memoryGiB overrides.");
  const cpus = value.cpus ?? DEFAULT_WORKER_SANDBOX_RESOURCES.cpus;
  const memoryGiB = value.memoryGiB ?? DEFAULT_WORKER_SANDBOX_RESOURCES.memoryGiB;
  if (!Number.isSafeInteger(cpus) || cpus < 1 || cpus > MAX_WORKER_SANDBOX_RESOURCES.cpus || !Number.isSafeInteger(memoryGiB) || memoryGiB < 1 || memoryGiB > MAX_WORKER_SANDBOX_RESOURCES.memoryGiB) throw new Error("Worker Sandbox resources require integer cpus from 1 through 8 and integer memoryGiB from 1 through 16.");
  return { cpus, memoryGiB };
}

export function planWorkerSandbox(input: { workerId: string; runId: string; creationNonce: string; workerRoot: string; workingDirectory?: string; codeRoot: string; mounts: WorkerSandboxMount[]; reviewSubjectWorkspace?: string; resources?: WorkerSandboxResourceRequest; release?: WorkerSandboxRelease }): WorkerSandboxReference {
  if (!isWorkerId(input.workerId) || !/^run_[A-Za-z0-9_-]+$/.test(input.runId)) throw new Error("Invalid Worker Sandbox identity.");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.creationNonce)) throw new Error("Invalid Worker Sandbox creation nonce.");
  const release = input.release ?? readApprovedWorkerSandboxRelease();
  const resources = resolveWorkerSandboxResources(input.resources);
  const identityHash = createHash("sha256").update(`${input.workerId}\0${input.runId}`).digest("hex").slice(0, 20);
  const sandboxName = `pi-${identityHash}-${input.creationNonce}`;
  if (!SANDBOX_NAME.test(sandboxName)) throw new Error("Invalid Worker Sandbox name.");
  const workspaceRoot = realpathSync(input.workerRoot); const workspace = statSync(workspaceRoot); const codeRoot = realpathSync(input.codeRoot);
  if (!workspace.isDirectory() || ![workspace.dev, workspace.ino, workspace.uid, workspace.gid].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("Worker Sandbox root identity or host ownership is invalid.");
  const reviewOverlay = input.reviewSubjectWorkspace ? planReviewWorkspaceOverlay({ workerId: input.workerId, runId: input.runId, subjectWorkspace: input.reviewSubjectWorkspace }) : undefined;
  const workingDirectory = reviewOverlay?.mergedDirectory ?? realpathSync(input.workingDirectory ?? workspaceRoot);
  if (!reviewOverlay && !pathWithin(workspaceRoot, workingDirectory)) throw new Error("Worker Sandbox working directory must remain beneath its worker root.");
  const mounts = deduplicateMounts([...input.mounts, ...(reviewOverlay ? [{ source: reviewOverlay.lowerDirectory, readOnly: true }] : [])].map((mount) => ({ source: realpathSync(mount.source), ...(mount.readOnly ? { readOnly: true } : {}) })));
  const reference: WorkerSandboxReference = { kind: "docker-sandbox", sandboxName, creationNonce: input.creationNonce, workerId: input.workerId, runId: input.runId, kitReference: release.kit.reference, kitSha256: release.kit.sha256, imageReference: release.image.reference, imageDigest: release.image.digest, imageArchive: release.image.archive.reference, imageArchiveSha256: release.image.archive.sha256, sbxVersion: release.sandbox.version, sbxBuildCommit: release.sandbox.buildCommit, protocolVersion: release.protocolVersion, releaseOrdinal: release.releaseOrdinal, workspaceRoot, workspaceDevice: Number(workspace.dev), workspaceInode: Number(workspace.ino), workspaceOwnerUid: Number(workspace.uid), workspaceOwnerGid: Number(workspace.gid), workingDirectory, codeRoot, mounts, ...(reviewOverlay ? { reviewOverlay } : {}), piCli: release.guest.piCli, rpcLauncher: release.guest.rpcLauncher, codingAgentDir: release.guest.codingAgentDir, stagedLockSha256: release.guest.stagedLockSha256, resourceManifestSha256: release.guest.resourceManifestSha256, runtimeProvenanceSha256: release.guest.runtimeProvenanceSha256, extensionPaths: [...release.guest.extensionPaths], searxngUrl: release.guest.searxngUrl, revisions: { ...release.revisions }, requestedCpu: resources.cpus, requestedMemoryGiB: resources.memoryGiB };
  assertWorkerSandboxReference(reference); return reference;
}

export async function createWorkerSandboxAsync(sbxPath: string, reference: WorkerSandboxReference): Promise<WorkerSandboxReference> {
  const expectedPlatform = resolveWorkerSandboxPlatform();
  assertWorkerSandboxReference(reference);
  revalidateWorkerSandboxKit(reference);
  if (reference.reviewOverlay) assertReviewWorkspaceLowerIdentity(reference.reviewOverlay);
  const version = await execFileAsync(sbxPath, ["version"], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 5_000 });
  const observedVersion = parseSbxVersion(version.stdout);
  if (observedVersion.version !== reference.sbxVersion || observedVersion.buildCommit !== reference.sbxBuildCommit) throw new Error(`Docker Sandbox version mismatch: expected ${reference.sbxVersion} ${reference.sbxBuildCommit}, received ${version.stdout.trim() || "no output"}.`);
  await loadLocalWorkerImage(sbxPath, reference.imageArchive, reference.imageArchiveSha256);
  const resources = referenceResources(reference, true);
  const memoryLimit = `${resources.memoryGiB}g`;
  const memoryLimitBytes = resources.memoryGiB * 1024 ** 3;
  const minimumEffectiveMemoryBytes = Math.floor(memoryLimitBytes * 0.9);
  const args = ["create", "--name", reference.sandboxName, "--memory", memoryLimit, "--cpus", String(resources.cpus), "--pull", "never", reference.kitReference, reference.workspaceRoot, `${reference.codeRoot}:ro`, ...reference.mounts.map((mount) => `${mount.source}:ro`)];
  const { stdout, stderr } = await execFileAsync(sbxPath, args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120_000 });
  const inspected = await execFileAsync(sbxPath, ["inspect", reference.sandboxName, "--json"], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000 });
  const inspectIdentity = parseObservedSandboxInspect(inspected.stdout, reference.sandboxName);
  const listedJson = await execFileAsync(sbxPath, ["ls", "--json"], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000 });
  const listIdentity = parseObservedSandboxList(listedJson.stdout, reference.sandboxName);
  if (inspectIdentity.id && listIdentity.id && inspectIdentity.id !== listIdentity.id) throw new Error("Sandbox inspect/list ID evidence disagrees.");
  const observedSandboxId = inspectIdentity.id ?? listIdentity.id;
  const runtimeRootScript = String.raw`set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset BASH_ENV ENV
root=$1
test "$(id -u)" = 0
test "$root" = /run/pi-worker
rm -rf "$root"
mkdir -p "$root"
chown 1000:1000 "$root"
chmod 0700 "$root"
test "$(stat -c '%u:%g:%a' "$root")" = 1000:1000:700
printf 'PI_WORKER_RUNTIME_ROOT_V1\n'`;
  const runtimeRoot = await execFileAsync(sbxPath, ["exec", "--user", "root", reference.sandboxName, "/usr/bin/env", "-u", "BASH_ENV", "-u", "ENV", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "/bin/sh", "-ceu", runtimeRootScript, "pi-worker-runtime-root", path.posix.dirname(reference.codingAgentDir)], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 10_000 });
  if (runtimeRoot.stdout !== "PI_WORKER_RUNTIME_ROOT_V1\n") throw new Error("Sandbox private runtime root setup returned unexpected output.");
  const reviewOverlay = reference.reviewOverlay ? await createReviewWorkspaceOverlayAsync(sbxPath, reference.sandboxName, reference.reviewOverlay) : undefined;
  const resourceScript = "node -e 'console.log(\"platform=\" + process.platform + \"/\" + (process.arch === \"x64\" ? \"amd64\" : process.arch))'; cpu=$(getconf _NPROCESSORS_ONLN); memoryKb=$(awk '/MemTotal:/ {print $2}' /proc/meminfo); runtime=$(cat /opt/pi-worker/runtime-provenance.json); resource=$(cat /opt/pi-worker/resource-manifest.sha256); printf 'cpu=%s\\nmemoryBytes=%s\\nruntime=%s\\nresource=%s\\n' \"$cpu\" \"$((memoryKb*1024))\" \"$runtime\" \"$resource\"";
  const observed = await execFileAsync(sbxPath, ["exec", "--workdir", reference.workingDirectory, reference.sandboxName, "/bin/sh", "-c", resourceScript], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 10_000 });
  const cpu = observed.stdout.match(/^cpu=(\d+)$/m)?.[1]; const memory = observed.stdout.match(/^memoryBytes=(\d+)$/m)?.[1]; const resource = observed.stdout.match(/^resource=([a-f0-9]{64})$/m)?.[1]; const runtimeText = observed.stdout.match(/^runtime=(\{.*\})$/m)?.[1];
  const observedPlatform = observed.stdout.match(/^platform=(\S+)$/m)?.[1];
  if (observedPlatform !== expectedPlatform) throw new Error(`Sandbox native platform mismatch: expected ${expectedPlatform}, received ${observedPlatform ?? "no platform evidence"}.`);
  const observedCpu = Number(cpu); const observedMemoryBytes = Number(memory);
  if (!cpu || !memory || !Number.isSafeInteger(observedCpu) || !Number.isSafeInteger(observedMemoryBytes) || resource !== reference.resourceManifestSha256 || !runtimeText) throw new Error("Sandbox did not report its exact approved resources and effective allocation.");
  if (observedCpu !== resources.cpus || observedMemoryBytes < minimumEffectiveMemoryBytes || observedMemoryBytes > memoryLimitBytes) throw new Error(`Sandbox effective allocation violates the requested ${resources.cpus}-CPU/${memoryLimit} limit.`);
  const runtime = JSON.parse(runtimeText) as Record<string, unknown>; const expectedRuntime = { protocolVersion: reference.protocolVersion, stagedLockSha256: reference.stagedLockSha256, piRevision: reference.revisions.pi, profileRevision: reference.revisions.profile, piToolsRevision: reference.revisions.piTools, piDocparserRevision: reference.revisions.piDocparser, resourceManifestSha256: reference.resourceManifestSha256, extensionPaths: reference.extensionPaths };
  if (JSON.stringify(runtime) !== JSON.stringify(expectedRuntime)) throw new Error("Sandbox embedded runtime provenance does not match the approved release.");
  const observedRuntimeSha256 = createHash("sha256").update(runtimeText).digest("hex");
  if (observedRuntimeSha256 !== reference.runtimeProvenanceSha256) throw new Error("Sandbox immutable runtime provenance digest does not match the approved release.");
  const canonicalInspect = `${canonicalJson(parseSbxJson(inspected.stdout, "inspect"))}\n`;
  const evidence = `${JSON.stringify(args)}\n${version.stdout}\n${version.stderr}\n${stdout}\n${stderr}\n${canonicalInspect}${inspected.stderr}\n${listedJson.stdout}\n${listedJson.stderr}\n${runtimeRoot.stdout}\n${runtimeRoot.stderr}\n${observed.stdout}\n${observed.stderr}`;
  return { ...reference, ...(reviewOverlay ? { reviewOverlay } : {}), createEvidenceSha256: createHash("sha256").update(evidence).digest("hex"), inspectEvidenceSha256: createHash("sha256").update(canonicalInspect).digest("hex"), sbxVersionEvidenceSha256: createHash("sha256").update(version.stdout).digest("hex"), observedCpu, observedMemoryBytes, ...(observedSandboxId ? { observedSandboxId } : {}), observedRuntimeSha256 };
}

export async function settleWorkerSandboxAsync(sbxPath: string, reference: WorkerSandboxReference): Promise<void> {
  assertWorkerSandboxReference(reference);
  const ownership = workspaceOwnership(reference);
  let normalizationError: unknown;
  if (reference.reviewOverlay && ownership && process.platform === "linux") {
    try { await normalizeReviewWorkspaceOwnership(sbxPath, reference, ownership); }
    catch (error) { normalizationError = error; }
  }
  try { await execFileAsync(sbxPath, ["stop", reference.sandboxName], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000 }); } catch {}
  try { await execFileAsync(sbxPath, ["rm", "--force", reference.sandboxName], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 65_000 }); } catch {}
  const { stdout } = await execFileAsync(sbxPath, ["ls", "--json"], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000 });
  if (sandboxJsonContains(stdout, reference.sandboxName)) throw new Error(`Sandbox ${reference.sandboxName} remained after exact stop/removal.`);
  if (!reference.reviewOverlay || !ownership) return;
  try { verifyReviewWorkspaceHostOwnership(reference.workspaceRoot, ownership); }
  catch (error) {
    const normalization = normalizationError ? ` Guest normalization also failed: ${normalizationError instanceof Error ? normalizationError.message : String(normalizationError)}` : "";
    throw new Error(`Reviewer Sandbox was removed, but retained workspace ownership requires manual repair before settlement can retry: ${error instanceof Error ? error.message : String(error)}${normalization}`);
  }
}

type WorkspaceOwnership = { device: number; inode: number; uid: number; gid: number };

function workspaceOwnership(reference: WorkerSandboxReference): WorkspaceOwnership | undefined {
  const values = [reference.workspaceDevice, reference.workspaceInode, reference.workspaceOwnerUid, reference.workspaceOwnerGid];
  if (values.every((value) => value === undefined)) return undefined;
  if (!values.every((value) => Number.isSafeInteger(value) && value! >= 0)) throw new Error("Invalid exact Worker Sandbox workspace ownership.");
  return { device: reference.workspaceDevice!, inode: reference.workspaceInode!, uid: reference.workspaceOwnerUid!, gid: reference.workspaceOwnerGid! };
}

async function normalizeReviewWorkspaceOwnership(sbxPath: string, reference: WorkerSandboxReference, ownership: WorkspaceOwnership): Promise<void> {
  const workspaceRoot = realpathSync(reference.workspaceRoot);
  const workspace = statSync(workspaceRoot);
  if (workspaceRoot !== reference.workspaceRoot || !workspace.isDirectory() || Number(workspace.dev) !== ownership.device || Number(workspace.ino) !== ownership.inode) throw new Error("Reviewer workspace root identity changed before ownership normalization.");
  const excluded = reference.mounts.map((mount) => mount.source).filter((source) => source !== workspaceRoot && pathWithin(workspaceRoot, source));
  const script = String.raw`const fs=require("node:fs"),path=require("node:path");
const [root,uidText,gidText,excludedText]=process.argv.slice(1),uid=Number(uidText),gid=Number(gidText),excluded=new Set(JSON.parse(excludedText));
const rootInfo=fs.lstatSync(root),device=Number(rootInfo.dev),stack=[root];let count=0;
while(stack.length){const current=stack.pop();if(excluded.has(current))continue;if(++count>1000000)throw new Error("reviewer workspace ownership traversal exceeded 1000000 entries");const info=fs.lstatSync(current);if(Number(info.dev)!==device)throw new Error("reviewer workspace contains an unexpected mounted filesystem");if((info.mode&0o6000)!==0)throw new Error("reviewer workspace contains setuid or setgid mode bits");if(!(info.isFile()||info.isDirectory()||info.isSymbolicLink()))throw new Error("reviewer workspace contains a special file");if(Number(info.uid)!==uid||Number(info.gid)!==gid)fs.lchownSync(current,uid,gid);const checked=fs.lstatSync(current);if(Number(checked.uid)!==uid||Number(checked.gid)!==gid)throw new Error("reviewer workspace ownership did not normalize");if(checked.isDirectory())for(const name of fs.readdirSync(current))stack.push(path.join(current,name));}
process.stdout.write("PI_REVIEW_WORKSPACE_OWNERSHIP_V2\\nuid="+uid+"\\ngid="+gid+"\\nentries="+count+"\\n");`;
  const normalized = await execFileAsync(sbxPath, ["exec", "--user", "root", reference.sandboxName, "/usr/bin/env", "-u", "BASH_ENV", "-u", "ENV", "PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "/usr/bin/node", "-e", script, workspaceRoot, String(ownership.uid), String(ownership.gid), JSON.stringify(excluded)], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 120_000 });
  if (!new RegExp(`^PI_REVIEW_WORKSPACE_OWNERSHIP_V2\\nuid=${ownership.uid}\\ngid=${ownership.gid}\\nentries=[1-9][0-9]*\\n$`).test(normalized.stdout)) throw new Error("Reviewer workspace ownership normalization returned unexpected evidence.");
}

function verifyReviewWorkspaceHostOwnership(workspaceRoot: string, ownership: WorkspaceOwnership): void {
  const exactRoot = realpathSync(workspaceRoot); const first = statSync(exactRoot);
  if (exactRoot !== workspaceRoot || !first.isDirectory() || Number(first.dev) !== ownership.device || Number(first.ino) !== ownership.inode) throw new Error("reviewer workspace root identity changed");
  const stack = [exactRoot]; let count = 0;
  while (stack.length) {
    const current = stack.pop()!; if (++count > 1_000_000) throw new Error("reviewer workspace ownership verification exceeded 1000000 entries");
    const info = lstatSync(current);
    if (Number(info.dev) !== ownership.device) throw new Error(`unexpected mounted filesystem at ${current}`);
    if (Number(info.uid) !== ownership.uid || Number(info.gid) !== ownership.gid) throw new Error(`unexpected owner at ${current}`);
    if ((info.mode & 0o6000) !== 0) throw new Error(`setuid or setgid mode bits at ${current}`);
    if (!(info.isFile() || info.isDirectory() || info.isSymbolicLink())) throw new Error(`special file at ${current}`);
    if (info.isDirectory()) for (const name of readdirSync(current)) stack.push(path.join(current, name));
  }
  const last = statSync(exactRoot);
  if (Number(last.dev) !== ownership.device || Number(last.ino) !== ownership.inode) throw new Error("reviewer workspace root identity changed during verification");
}

export function resolveSbxPath(): string { return resolveExecutable("sbx"); }
function referenceResources(reference: WorkerSandboxReference, required: boolean): WorkerSandboxResources {
  const absent = reference.requestedCpu === undefined && reference.requestedMemoryGiB === undefined;
  if (absent && !required) return { ...DEFAULT_WORKER_SANDBOX_RESOURCES };
  if (absent) throw new Error("Worker Sandbox launch requires persisted exact CPU and RAM settings.");
  return resolveWorkerSandboxResources({ cpus: reference.requestedCpu!, memoryGiB: reference.requestedMemoryGiB! });
}

export function assertWorkerSandboxReference(value: WorkerSandboxReference): void {
  assertLocalWorkerImage({ reference: value.imageReference, digest: value.imageDigest, archive: { reference: value.imageArchive, sha256: value.imageArchiveSha256 } });
  if (!path.isAbsolute(value.imageArchive)) throw new Error("Worker image archives require an absolute local path.");
  const revisions = value.revisions;
  if (value.kind !== "docker-sandbox" || !SANDBOX_NAME.test(value.sandboxName) || !isWorkerId(value.workerId) || !/^run_[A-Za-z0-9_-]+$/.test(value.runId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.creationNonce) || !SHA256.test(value.kitSha256) || value.protocolVersion !== 1 || !Number.isSafeInteger(value.releaseOrdinal) || value.releaseOrdinal < 1 || !SHA256.test(value.stagedLockSha256) || !SHA256.test(value.resourceManifestSha256) || !SHA256.test(value.runtimeProvenanceSha256) || value.sbxVersion !== SBX_VERSION || !/^[a-f0-9]{40}$/.test(value.sbxBuildCommit) || !Array.isArray(value.extensionPaths) || value.extensionPaths.length < 1 || !value.extensionPaths.every(isImmutableGuestExtensionPath) || new Set(value.extensionPaths).size !== value.extensionPaths.length || typeof value.searxngUrl !== "string" || !isCredentialFreeHttpUrl(value.searxngUrl) || !revisions || ![revisions.pi, revisions.profile, revisions.piTools, revisions.piDocparser].every((item) => /^[a-f0-9]{40}$/.test(item))) throw new Error("Invalid exact Worker Sandbox reference.");
  if (!value.sandboxName.endsWith(`-${value.creationNonce}`)) throw new Error("Worker Sandbox name does not retain its full creation nonce.");
  const resourcesAbsent = value.requestedCpu === undefined && value.requestedMemoryGiB === undefined;
  if ((value.requestedCpu === undefined) !== (value.requestedMemoryGiB === undefined)) throw new Error("Invalid partial Worker Sandbox resource request.");
  if (!resourcesAbsent) referenceResources(value, true);
  if (value.observedCpu !== undefined && (!Number.isSafeInteger(value.observedCpu) || value.observedCpu < 1 || value.observedCpu > MAX_WORKER_SANDBOX_RESOURCES.cpus)) throw new Error("Invalid observed Sandbox CPU allocation.");
  if (value.observedMemoryBytes !== undefined && (!Number.isSafeInteger(value.observedMemoryBytes) || value.observedMemoryBytes < 1 || value.observedMemoryBytes > MAX_WORKER_SANDBOX_RESOURCES.memoryGiB * 1024 ** 3)) throw new Error("Invalid observed Sandbox memory allocation.");
  if (value.observedSandboxId !== undefined && (value.observedSandboxId.length < 8 || value.observedSandboxId.length > 256)) throw new Error("Invalid observed Sandbox ID.");
  if (value.observedRuntimeSha256 !== undefined && (!SHA256.test(value.observedRuntimeSha256) || value.observedRuntimeSha256 !== value.runtimeProvenanceSha256)) throw new Error("Invalid observed runtime digest.");
  if (value.inspectEvidenceSha256 !== undefined && !SHA256.test(value.inspectEvidenceSha256)) throw new Error("Invalid Sandbox inspect evidence digest.");
  if (value.sbxVersionEvidenceSha256 !== undefined && !SHA256.test(value.sbxVersionEvidenceSha256)) throw new Error("Invalid sbx version evidence digest.");
  workspaceOwnership(value);
  if (![value.workspaceRoot, value.workingDirectory, value.codeRoot].every((source) => path.isAbsolute(source)) || (!value.reviewOverlay && !pathWithin(value.workspaceRoot, value.workingDirectory)) || (value.reviewOverlay && value.workingDirectory !== value.reviewOverlay.mergedDirectory) || ![value.piCli, value.rpcLauncher, value.codingAgentDir].every((guestPath) => path.posix.isAbsolute(guestPath) && path.posix.normalize(guestPath) === guestPath) || value.codingAgentDir !== "/run/pi-worker/agent") throw new Error("Invalid exact Worker Sandbox runtime paths.");
  if (value.reviewOverlay) { assertReviewWorkspaceOverlay(value.reviewOverlay, false); if (value.reviewOverlay.workerId !== value.workerId || value.reviewOverlay.runId !== value.runId || !value.mounts.some((mount) => mount.source === value.reviewOverlay!.lowerDirectory && mount.readOnly === true)) throw new Error("Invalid exact Worker Sandbox review OverlayFS binding."); }
  const protectedGuestPaths = [value.piCli, value.rpcLauncher, value.codingAgentDir, ...value.extensionPaths];
  if ([value.workspaceRoot, value.codeRoot].some((source) => protectedGuestPaths.some((protectedPath) => pathsOverlap(source, protectedPath)))) throw new Error("Worker Sandbox primary mount overlaps immutable guest runtime state.");
  for (const mount of value.mounts) { if (!path.isAbsolute(mount.source) || mount.readOnly !== true) throw new Error("Invalid exact Worker Sandbox read-only evidence mount."); if (protectedGuestPaths.some((protectedPath) => pathsOverlap(mount.source, protectedPath))) throw new Error("Worker Sandbox evidence mount overlaps immutable guest runtime state."); }
}
function parseObservedSandboxInspect(output: string, sandboxName: string): { id?: string } {
  let value: unknown; try { value = parseSbxJson(output, "inspect"); } catch { throw new Error("Sandbox inspect JSON was malformed."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sandbox inspect JSON was not an object.");
  return observedIdentity(value as Record<string, unknown>, sandboxName, "inspect");
}
function parseObservedSandboxList(output: string, sandboxName: string): { id?: string } {
  let value: unknown; try { value = parseSbxJson(output, "list"); } catch { throw new Error("Sandbox list JSON was malformed."); }
  if (!Array.isArray(value)) throw new Error("Sandbox list JSON was not the v0.49.1 array shape.");
  const rows = value;
  const row = rows.find((item: any) => item && typeof item === "object" && (item.name === sandboxName || item.Name === sandboxName));
  if (!row) throw new Error("Sandbox list JSON did not retain the exact full-nonce name.");
  return observedIdentity(row as Record<string, unknown>, sandboxName, "list");
}
function observedIdentity(row: Record<string, unknown>, sandboxName: string, label: string): { id?: string } {
  const name = row.name ?? row.Name; if (name !== sandboxName) throw new Error(`Sandbox ${label} JSON did not retain the exact full-nonce name.`);
  const id = row.id ?? row.ID; if (id === undefined || id === null || id === "") return {};
  if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{8,256}$/.test(id)) throw new Error(`Sandbox ${label} JSON exposed an invalid ID.`);
  return { id };
}
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value); }

function pathWithin(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function pathsOverlap(left: string, right: string): boolean { const a = path.resolve(left); const b = path.resolve(right); return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`); }
function isImmutableGuestExtensionPath(value: string): boolean { return path.posix.isAbsolute(value) && path.posix.normalize(value) === value && value.startsWith("/opt/"); }
function isCredentialFreeHttpUrl(value: string): boolean { try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; } }
function sandboxJsonContains(output: string, sandboxName: string): boolean { const value = parseSbxJson(output, "list"); if (!Array.isArray(value)) throw new Error("Sandbox list JSON was not the v0.49.1 array shape."); return value.some((item: any) => item && typeof item === "object" && (item.name === sandboxName || item.Name === sandboxName)); }
function parseSbxVersion(output: string): { version: string; buildCommit: string } { const match=SBX_VERSION_LINE.exec(output); if (!match) throw new Error(`Docker Sandbox version output did not match the recorded v0.49.1 contract: ${output.trim() || "no output"}.`); return { version: match[1]!, buildCommit: match[2]! }; }
function parseSbxJson(output: string, label: string): unknown { const suffix=`\n${SBX_UPDATE_BANNER}\n\n`; const prefix=output.slice(0, -suffix.length); const json=output.endsWith(suffix) && prefix.endsWith("\n") ? prefix : output; try { return JSON.parse(json); } catch { throw new Error(`Sandbox ${label} JSON was malformed or had unrecognized stdout contamination.`); } }
function deduplicateMounts(mounts: WorkerSandboxMount[]): WorkerSandboxMount[] { const seen = new Set<string>(); const result: WorkerSandboxMount[] = []; for (const mount of mounts) { const key = `${mount.source}\0${mount.readOnly ? "ro" : "rw"}`; if (seen.has(key)) continue; seen.add(key); result.push(mount); } return result; }
function revalidateWorkerSandboxKit(reference: WorkerSandboxReference): void { const exact = realpathSync(reference.kitReference); if (exact !== reference.kitReference || hashDirectory(exact) !== reference.kitSha256) throw new Error("Worker Sandbox kit changed after planning."); assertKitImageReference(exact, reference.imageReference); }
function assertKitImageReference(directory: string, expected: string): void { const spec = readFileSync(path.join(directory, "spec.yaml"), "utf8"); const images = [...spec.matchAll(/^\s{2}image:\s*([^#\s]+)\s*(?:#.*)?$/gm)].map((match) => match[1]!); if (images.length !== 1 || images[0] !== expected) throw new Error("Worker Sandbox kit image does not match the approved archive-bound local reference."); }
function hashDirectory(directory: string): string { const files: string[] = []; const visit = (current: string) => { for (const entry of readdirSync(current, { withFileTypes: true })) { const value = path.join(current, entry.name); if (entry.isSymbolicLink()) throw new Error(`Worker Sandbox kit may not contain symlinks: ${value}`); if (entry.isDirectory()) visit(value); else if (entry.isFile()) files.push(value); else throw new Error(`Worker Sandbox kit contains unsupported entry: ${value}`); } }; visit(directory); const hash = createHash("sha256"); for (const file of files.sort()) { if (!statSync(file).isFile()) throw new Error(`Worker Sandbox kit entry changed type: ${file}`); hash.update(path.relative(directory, file)); hash.update("\0"); hash.update(readFileSync(file)); hash.update("\0"); } return hash.digest("hex"); }
