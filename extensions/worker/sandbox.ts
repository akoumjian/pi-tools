import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { readPiToolsJsonConfigSource, resolvePiToolsConfigReference } from "../_shared/config.js";
import { resolveExecutable } from "../_shared/executable.js";
import { isWorkerId } from "../_shared/worker-id.js";
import { assertReviewWorkspaceLowerIdentity, assertReviewWorkspaceOverlay, createReviewWorkspaceOverlayAsync, planReviewWorkspaceOverlay, type ReviewWorkspaceOverlay } from "./review-workspace.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const OCI_DIGEST = /@sha256:[a-f0-9]{64}$/;
const SANDBOX_NAME = /^pi-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SBX_VERSION = "v0.49.1";
const SBX_VERSION_LINE = /^sbx version (v\d+\.\d+\.\d+) ([a-f0-9]{40})\n?$/;
const TEMPLATE_COMPONENT = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
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
  schemaVersion: 1; protocolVersion: 1; releaseOrdinal: number; status: "approved";
  kit: { reference: string; sha256: string }; image: { reference: string; digest: string };
  sandbox: { version: "v0.49.1"; buildCommit: string; template: { id: string; repository: string; tag: string; flavor: string } };
  revisions: { pi: string; profile: string; piTools: string; piDocparser: string };
  guest: { stagedLockSha256: string; piCli: string; rpcLauncher: string; codingAgentDir: string; resourceManifestSha256: string; runtimeProvenanceSha256: string; extensionPaths: string[]; searxngUrl: string };
};
export type WorkerSandboxReference = {
  kind: "docker-sandbox"; sandboxName: string; creationNonce: string; workerId: string; runId: string;
  kitReference: string; kitSha256: string; imageReference: string; imageDigest: string; sbxVersion: "v0.49.1"; sbxBuildCommit: string; templateId: string; templateRepository: string; templateTag: string; templateFlavor: string; protocolVersion: 1; releaseOrdinal: number;
  workspaceRoot: string; workingDirectory: string; codeRoot: string; mounts: WorkerSandboxMount[]; reviewOverlay?: ReviewWorkspaceOverlay; piCli: string; rpcLauncher: string; codingAgentDir: string;
  stagedLockSha256: string; resourceManifestSha256: string; runtimeProvenanceSha256: string; extensionPaths: string[]; searxngUrl: string; revisions: WorkerSandboxRelease["revisions"];
  createEvidenceSha256?: string; inspectEvidenceSha256?: string; sbxVersionEvidenceSha256?: string; observedCpu?: number; observedMemoryBytes?: number; observedSandboxId?: string; observedRuntimeSha256?: string;
};

export function readApprovedWorkerSandboxRelease(): WorkerSandboxRelease {
  const config = readPiToolsJsonConfigSource("worker-sandbox-runtime.json", import.meta.url);
  if (!config) throw new Error("Managed workers require worker-sandbox-runtime.json from an approved profile release.");
  const value = config.data as Partial<WorkerSandboxRelease>; const releaseOrdinal = value.releaseOrdinal;
  if (value.schemaVersion !== 1 || value.protocolVersion !== 1 || !Number.isSafeInteger(releaseOrdinal) || releaseOrdinal! < 1 || value.status !== "approved") throw new Error("Worker Sandbox runtime is not an approved schemaVersion 1 release.");
  const kit = value.kit; const image = value.image; const sandbox = value.sandbox; const revisions = value.revisions; const guest = value.guest;
  if (!kit || typeof kit.reference !== "string" || !SHA256.test(String(kit.sha256))) throw new Error("Worker Sandbox release requires an exact kit reference and SHA-256.");
  if (!image || typeof image.reference !== "string" || !OCI_DIGEST.test(image.reference) || !SHA256.test(String(image.digest)) || !image.reference.endsWith(`@sha256:${image.digest}`)) throw new Error("Worker Sandbox release image must be an exact matching OCI digest reference.");
  if (!sandbox || sandbox.version !== SBX_VERSION || !/^[a-f0-9]{40}$/.test(String(sandbox.buildCommit)) || !validTemplateIdentity(sandbox.template)) throw new Error("Worker Sandbox release requires exact sbx v0.49.1 and template-store identity.");
  if (!revisions || ![revisions.pi, revisions.profile, revisions.piTools, revisions.piDocparser].every((revision) => typeof revision === "string" && /^[a-f0-9]{40}$/.test(revision))) throw new Error("Worker Sandbox release revisions must be exact 40-character commits.");
  if (!guest || !SHA256.test(String(guest.stagedLockSha256)) || !path.posix.isAbsolute(String(guest.piCli)) || !path.posix.isAbsolute(String(guest.rpcLauncher)) || !path.posix.isAbsolute(String(guest.codingAgentDir)) || !SHA256.test(String(guest.resourceManifestSha256)) || !SHA256.test(String(guest.runtimeProvenanceSha256)) || !Array.isArray(guest.extensionPaths) || guest.extensionPaths.length < 1 || !guest.extensionPaths.every((item) => typeof item === "string" && isImmutableGuestExtensionPath(item)) || new Set(guest.extensionPaths).size !== guest.extensionPaths.length || typeof guest.searxngUrl !== "string" || !isCredentialFreeHttpUrl(guest.searxngUrl)) throw new Error("Worker Sandbox release guest paths and resource manifest are invalid.");
  const resolved = resolvePiToolsConfigReference(kit.reference, config.path);
  if (resolved instanceof URL) throw new Error("Worker Sandbox releases require a locally verified ordinary kit directory; URL kits cannot prove exact content.");
  const kitReference = realpathSync(resolved);
  if (hashDirectory(kitReference) !== kit.sha256) throw new Error("Worker Sandbox kit content does not match the approved SHA-256.");
  assertKitImageReference(kitReference, `${sandbox.template.repository}:${sandbox.template.tag}`);
  return { schemaVersion: 1, protocolVersion: 1, releaseOrdinal: releaseOrdinal!, status: "approved", kit: { reference: kitReference, sha256: kit.sha256 }, image: { reference: image.reference, digest: image.digest }, sandbox: { version: SBX_VERSION, buildCommit: sandbox.buildCommit, template: { ...sandbox.template } }, revisions: { ...revisions }, guest: { ...guest, extensionPaths: [...guest.extensionPaths] } };
}

export function planWorkerSandbox(input: { workerId: string; runId: string; creationNonce: string; workerRoot: string; workingDirectory?: string; codeRoot: string; mounts: WorkerSandboxMount[]; reviewSubjectWorkspace?: string; release?: WorkerSandboxRelease }): WorkerSandboxReference {
  if (!isWorkerId(input.workerId) || !/^run_[A-Za-z0-9_-]+$/.test(input.runId)) throw new Error("Invalid Worker Sandbox identity.");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.creationNonce)) throw new Error("Invalid Worker Sandbox creation nonce.");
  const release = input.release ?? readApprovedWorkerSandboxRelease();
  const identityHash = createHash("sha256").update(`${input.workerId}\0${input.runId}`).digest("hex").slice(0, 20);
  const sandboxName = `pi-${identityHash}-${input.creationNonce}`;
  if (!SANDBOX_NAME.test(sandboxName)) throw new Error("Invalid Worker Sandbox name.");
  const workspaceRoot = realpathSync(input.workerRoot); const codeRoot = realpathSync(input.codeRoot);
  const reviewOverlay = input.reviewSubjectWorkspace ? planReviewWorkspaceOverlay({ workerId: input.workerId, runId: input.runId, subjectWorkspace: input.reviewSubjectWorkspace }) : undefined;
  const workingDirectory = reviewOverlay?.mergedDirectory ?? realpathSync(input.workingDirectory ?? workspaceRoot);
  if (!reviewOverlay && !pathWithin(workspaceRoot, workingDirectory)) throw new Error("Worker Sandbox working directory must remain beneath its worker root.");
  const mounts = deduplicateMounts([...input.mounts, ...(reviewOverlay ? [{ source: reviewOverlay.lowerDirectory, readOnly: true }] : [])].map((mount) => ({ source: realpathSync(mount.source), ...(mount.readOnly ? { readOnly: true } : {}) })));
  const reference: WorkerSandboxReference = { kind: "docker-sandbox", sandboxName, creationNonce: input.creationNonce, workerId: input.workerId, runId: input.runId, kitReference: release.kit.reference, kitSha256: release.kit.sha256, imageReference: release.image.reference, imageDigest: release.image.digest, sbxVersion: release.sandbox.version, sbxBuildCommit: release.sandbox.buildCommit, templateId: release.sandbox.template.id, templateRepository: release.sandbox.template.repository, templateTag: release.sandbox.template.tag, templateFlavor: release.sandbox.template.flavor, protocolVersion: release.protocolVersion, releaseOrdinal: release.releaseOrdinal, workspaceRoot, workingDirectory, codeRoot, mounts, ...(reviewOverlay ? { reviewOverlay } : {}), piCli: release.guest.piCli, rpcLauncher: release.guest.rpcLauncher, codingAgentDir: release.guest.codingAgentDir, stagedLockSha256: release.guest.stagedLockSha256, resourceManifestSha256: release.guest.resourceManifestSha256, runtimeProvenanceSha256: release.guest.runtimeProvenanceSha256, extensionPaths: [...release.guest.extensionPaths], searxngUrl: release.guest.searxngUrl, revisions: { ...release.revisions } };
  assertWorkerSandboxReference(reference); return reference;
}

export async function createWorkerSandboxAsync(sbxPath: string, reference: WorkerSandboxReference): Promise<WorkerSandboxReference> {
  assertWorkerSandboxReference(reference);
  if (reference.reviewOverlay) assertReviewWorkspaceLowerIdentity(reference.reviewOverlay);
  const version = await execFileAsync(sbxPath, ["version"], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 5_000 });
  const observedVersion = parseSbxVersion(version.stdout);
  if (observedVersion.version !== reference.sbxVersion || observedVersion.buildCommit !== reference.sbxBuildCommit) throw new Error(`Docker Sandbox version mismatch: expected ${reference.sbxVersion} ${reference.sbxBuildCommit}, received ${version.stdout.trim() || "no output"}.`);
  const templates = await execFileAsync(sbxPath, ["template", "ls", "--json"], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000 });
  verifyTemplateStoreIdentity(templates.stdout, reference);
  const args = ["create", "--name", reference.sandboxName, "--pull", "never", reference.kitReference, reference.workspaceRoot, `${reference.codeRoot}:ro`, ...reference.mounts.map((mount) => `${mount.source}:ro`)];
  const { stdout, stderr } = await execFileAsync(sbxPath, args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120_000 });
  const inspected = await execFileAsync(sbxPath, ["inspect", reference.sandboxName, "--json"], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000 });
  const inspectIdentity = parseObservedSandboxInspect(inspected.stdout, reference.sandboxName);
  const listedJson = await execFileAsync(sbxPath, ["ls", "--json"], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000 });
  const listIdentity = parseObservedSandboxList(listedJson.stdout, reference.sandboxName);
  if (inspectIdentity.id && listIdentity.id && inspectIdentity.id !== listIdentity.id) throw new Error("Sandbox inspect/list ID evidence disagrees.");
  const observedSandboxId = inspectIdentity.id ?? listIdentity.id;
  const reviewOverlay = reference.reviewOverlay ? await createReviewWorkspaceOverlayAsync(sbxPath, reference.sandboxName, reference.reviewOverlay) : undefined;
  const resourceScript = "cpu=$(getconf _NPROCESSORS_ONLN); memoryKb=$(awk '/MemTotal:/ {print $2}' /proc/meminfo); runtime=$(cat /opt/pi-worker/runtime-provenance.json); resource=$(cat /opt/pi-worker/resource-manifest.sha256); printf 'cpu=%s\\nmemoryBytes=%s\\nruntime=%s\\nresource=%s\\n' \"$cpu\" \"$((memoryKb*1024))\" \"$runtime\" \"$resource\"";
  const observed = await execFileAsync(sbxPath, ["exec", "--workdir", reference.workingDirectory, reference.sandboxName, "/bin/sh", "-c", resourceScript], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 10_000 });
  const cpu = observed.stdout.match(/^cpu=(\d+)$/m)?.[1]; const memory = observed.stdout.match(/^memoryBytes=(\d+)$/m)?.[1]; const resource = observed.stdout.match(/^resource=([a-f0-9]{64})$/m)?.[1]; const runtimeText = observed.stdout.match(/^runtime=(\{.*\})$/m)?.[1];
  if (!cpu || !memory || Number(cpu) < 1 || Number(memory) < 1 || resource !== reference.resourceManifestSha256 || !runtimeText) throw new Error("Sandbox did not report its exact approved resources and effective allocation.");
  const runtime = JSON.parse(runtimeText) as Record<string, unknown>; const expectedRuntime = { protocolVersion: reference.protocolVersion, stagedLockSha256: reference.stagedLockSha256, piRevision: reference.revisions.pi, profileRevision: reference.revisions.profile, piToolsRevision: reference.revisions.piTools, piDocparserRevision: reference.revisions.piDocparser, resourceManifestSha256: reference.resourceManifestSha256, extensionPaths: reference.extensionPaths };
  if (JSON.stringify(runtime) !== JSON.stringify(expectedRuntime)) throw new Error("Sandbox embedded runtime provenance does not match the approved release.");
  const observedRuntimeSha256 = createHash("sha256").update(runtimeText).digest("hex");
  if (observedRuntimeSha256 !== reference.runtimeProvenanceSha256) throw new Error("Sandbox immutable runtime provenance digest does not match the approved release.");
  const canonicalInspect = `${canonicalJson(parseSbxJson(inspected.stdout, "inspect"))}\n`;
  const evidence = `${version.stdout}\n${version.stderr}\n${templates.stdout}\n${templates.stderr}\n${stdout}\n${stderr}\n${canonicalInspect}${inspected.stderr}\n${listedJson.stdout}\n${listedJson.stderr}\n${observed.stdout}\n${observed.stderr}`;
  return { ...reference, ...(reviewOverlay ? { reviewOverlay } : {}), createEvidenceSha256: createHash("sha256").update(evidence).digest("hex"), inspectEvidenceSha256: createHash("sha256").update(canonicalInspect).digest("hex"), sbxVersionEvidenceSha256: createHash("sha256").update(version.stdout).digest("hex"), observedCpu: Number(cpu), observedMemoryBytes: Number(memory), ...(observedSandboxId ? { observedSandboxId } : {}), observedRuntimeSha256 };
}

export async function settleWorkerSandboxAsync(sbxPath: string, reference: WorkerSandboxReference): Promise<void> {
  assertWorkerSandboxReference(reference);
  try { await execFileAsync(sbxPath, ["stop", reference.sandboxName], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000 }); } catch {}
  try { await execFileAsync(sbxPath, ["rm", "--force", reference.sandboxName], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 65_000 }); } catch {}
  const { stdout } = await execFileAsync(sbxPath, ["ls", "--json"], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000 });
  if (sandboxJsonContains(stdout, reference.sandboxName)) throw new Error(`Sandbox ${reference.sandboxName} remained after exact stop/removal.`);
}

export function resolveSbxPath(): string { return resolveExecutable("sbx"); }
export function assertWorkerSandboxReference(value: WorkerSandboxReference): void {
  const revisions = value.revisions;
  if (value.kind !== "docker-sandbox" || !SANDBOX_NAME.test(value.sandboxName) || !isWorkerId(value.workerId) || !/^run_[A-Za-z0-9_-]+$/.test(value.runId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.creationNonce) || !SHA256.test(value.kitSha256) || !OCI_DIGEST.test(value.imageReference) || !SHA256.test(value.imageDigest) || !value.imageReference.endsWith(`@sha256:${value.imageDigest}`) || value.protocolVersion !== 1 || !Number.isSafeInteger(value.releaseOrdinal) || value.releaseOrdinal < 1 || !SHA256.test(value.stagedLockSha256) || !SHA256.test(value.resourceManifestSha256) || !SHA256.test(value.runtimeProvenanceSha256) || value.sbxVersion !== SBX_VERSION || !/^[a-f0-9]{40}$/.test(value.sbxBuildCommit) || !TEMPLATE_COMPONENT.test(value.templateId) || !isRegistryQualifiedRepository(value.templateRepository) || !TEMPLATE_COMPONENT.test(value.templateTag) || !TEMPLATE_COMPONENT.test(value.templateFlavor) || !Array.isArray(value.extensionPaths) || value.extensionPaths.length < 1 || !value.extensionPaths.every(isImmutableGuestExtensionPath) || new Set(value.extensionPaths).size !== value.extensionPaths.length || typeof value.searxngUrl !== "string" || !isCredentialFreeHttpUrl(value.searxngUrl) || !revisions || ![revisions.pi, revisions.profile, revisions.piTools, revisions.piDocparser].every((item) => /^[a-f0-9]{40}$/.test(item))) throw new Error("Invalid exact Worker Sandbox reference.");
  if (!value.sandboxName.endsWith(`-${value.creationNonce}`)) throw new Error("Worker Sandbox name does not retain its full creation nonce.");
  if (value.observedSandboxId !== undefined && (value.observedSandboxId.length < 8 || value.observedSandboxId.length > 256)) throw new Error("Invalid observed Sandbox ID.");
  if (value.observedRuntimeSha256 !== undefined && (!SHA256.test(value.observedRuntimeSha256) || value.observedRuntimeSha256 !== value.runtimeProvenanceSha256)) throw new Error("Invalid observed runtime digest.");
  if (value.inspectEvidenceSha256 !== undefined && !SHA256.test(value.inspectEvidenceSha256)) throw new Error("Invalid Sandbox inspect evidence digest.");
  if (value.sbxVersionEvidenceSha256 !== undefined && !SHA256.test(value.sbxVersionEvidenceSha256)) throw new Error("Invalid sbx version evidence digest.");
  if (![value.workspaceRoot, value.workingDirectory, value.codeRoot].every((source) => path.isAbsolute(source)) || (!value.reviewOverlay && !pathWithin(value.workspaceRoot, value.workingDirectory)) || (value.reviewOverlay && value.workingDirectory !== value.reviewOverlay.mergedDirectory) || ![value.piCli, value.rpcLauncher, value.codingAgentDir].every((guestPath) => path.posix.isAbsolute(guestPath) && path.posix.normalize(guestPath) === guestPath)) throw new Error("Invalid exact Worker Sandbox runtime paths.");
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
function verifyTemplateStoreIdentity(output: string, reference: WorkerSandboxReference): void {
  let value: unknown; try { value = parseSbxJson(output, "template list"); } catch { throw new Error("Sandbox template list JSON was malformed."); }
  if (!Array.isArray(value)) throw new Error("Sandbox template list JSON was not the v0.49.1 array shape.");
  const matches = value.filter((item: any) => item && typeof item === "object" && item.id === reference.templateId && item.repository === reference.templateRepository && item.tag === reference.templateTag && item.flavor === reference.templateFlavor);
  if (matches.length !== 1) throw new Error("Sandbox template store did not contain exactly the approved template identity.");
}
function validTemplateIdentity(value: unknown): value is WorkerSandboxRelease["sandbox"]["template"] { const item=value as any; return Boolean(item) && typeof item.id === "string" && TEMPLATE_COMPONENT.test(item.id) && typeof item.repository === "string" && isRegistryQualifiedRepository(item.repository) && typeof item.tag === "string" && TEMPLATE_COMPONENT.test(item.tag) && typeof item.flavor === "string" && TEMPLATE_COMPONENT.test(item.flavor); }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`; return JSON.stringify(value); }

function pathWithin(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function pathsOverlap(left: string, right: string): boolean { const a = path.resolve(left); const b = path.resolve(right); return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`); }
function isImmutableGuestExtensionPath(value: string): boolean { return path.posix.isAbsolute(value) && path.posix.normalize(value) === value && value.startsWith("/opt/"); }
function isCredentialFreeHttpUrl(value: string): boolean { try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; } }
function sandboxJsonContains(output: string, sandboxName: string): boolean { const value = parseSbxJson(output, "list"); if (!Array.isArray(value)) throw new Error("Sandbox list JSON was not the v0.49.1 array shape."); return value.some((item: any) => item && typeof item === "object" && (item.name === sandboxName || item.Name === sandboxName)); }
function parseSbxVersion(output: string): { version: string; buildCommit: string } { const match=SBX_VERSION_LINE.exec(output); if (!match) throw new Error(`Docker Sandbox version output did not match the recorded v0.49.1 contract: ${output.trim() || "no output"}.`); return { version: match[1]!, buildCommit: match[2]! }; }
function parseSbxJson(output: string, label: string): unknown { const suffix=`\n${SBX_UPDATE_BANNER}\n\n`; const prefix=output.slice(0, -suffix.length); const json=output.endsWith(suffix) && prefix.endsWith("\n") ? prefix : output; try { return JSON.parse(json); } catch { throw new Error(`Sandbox ${label} JSON was malformed or had unrecognized stdout contamination.`); } }
function isRegistryQualifiedRepository(value: string): boolean { if (value !== value.toLowerCase() || value.includes("://") || value.includes("@") || /\s/.test(value)) return false; const parts=value.split("/"); if (parts.length < 2) return false; const registry=parts.shift()!; if (!(registry.includes(".") || registry.includes(":") || registry === "localhost") || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(registry)) return false; return parts.every((part) => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part)); }
function deduplicateMounts(mounts: WorkerSandboxMount[]): WorkerSandboxMount[] { const seen = new Set<string>(); const result: WorkerSandboxMount[] = []; for (const mount of mounts) { const key = `${mount.source}\0${mount.readOnly ? "ro" : "rw"}`; if (seen.has(key)) continue; seen.add(key); result.push(mount); } return result; }
function assertKitImageReference(directory: string, expected: string): void { const spec = readFileSync(path.join(directory, "spec.yaml"), "utf8"); const images = [...spec.matchAll(/^\s{2}image:\s*([^#\s]+)\s*(?:#.*)?$/gm)].map((match) => match[1]!); if (images.length !== 1 || images[0] !== expected) throw new Error("Worker Sandbox kit image does not match the approved immutable OCI reference."); }
function hashDirectory(directory: string): string { const files: string[] = []; const visit = (current: string) => { for (const entry of readdirSync(current, { withFileTypes: true })) { const value = path.join(current, entry.name); if (entry.isSymbolicLink()) throw new Error(`Worker Sandbox kit may not contain symlinks: ${value}`); if (entry.isDirectory()) visit(value); else if (entry.isFile()) files.push(value); else throw new Error(`Worker Sandbox kit contains unsupported entry: ${value}`); } }; visit(directory); const hash = createHash("sha256"); for (const file of files.sort()) { if (!statSync(file).isFile()) throw new Error(`Worker Sandbox kit entry changed type: ${file}`); hash.update(path.relative(directory, file)); hash.update("\0"); hash.update(readFileSync(file)); hash.update("\0"); } return hash.digest("hex"); }
