import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readApprovedWorkerSandboxRelease } from "../extensions/worker/sandbox.js";
import { resolveWorkerSandboxPlatform, selectWorkerSandboxRelease } from "../extensions/_shared/worker-platform.js";

test("approved loader verifies the selected Kit and never substitutes an approved foreign architecture", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-platform-"));
  const beforeConfig = process.env.PI_TOOLS_CONFIG_DIR;
  const beforePlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const beforeArch = Object.getOwnPropertyDescriptor(process, "arch")!;
  try {
    process.env.PI_TOOLS_CONFIG_DIR = root;
    const entry = (arch: string, digest: string) => {
      mkdirSync(path.join(root, arch));
      const image = `example.invalid/worker@sha256:${digest}`;
      const spec = `sandbox:\n  image: ${image}\n`;
      writeFileSync(path.join(root, arch, "spec.yaml"), spec);
      return {
        schemaVersion: 2, protocolVersion: 1, releaseOrdinal: 9, status: "approved",
        kit: { reference: arch, sha256: createHash("sha256").update(`spec.yaml\0${spec}\0`).digest("hex") },
        image: { reference: image, digest },
        sandbox: { version: "v0.49.1", buildCommit: "1".repeat(40) },
        revisions: { pi: "1".repeat(40), profile: "2".repeat(40), piTools: "3".repeat(40), piDocparser: "4".repeat(40) },
        guest: { stagedLockSha256: digest, piCli: "/usr/local/bin/pi", rpcLauncher: "/opt/pi-worker/launch.mjs", codingAgentDir: "/run/pi-worker/agent", resourceManifestSha256: digest, runtimeProvenanceSha256: digest, extensionPaths: ["/opt/pi-tools/extensions/worker/runtime.ts"], searxngUrl: "http://host.docker.internal:18888" },
      };
    };
    const arm = entry("arm", "a".repeat(64)), amd = entry("amd", "b".repeat(64));
    const manifest = { schemaVersion: 3, platforms: { "linux/arm64": arm, "linux/amd64": amd } };
    const save = () => writeFileSync(path.join(root, "worker-sandbox-runtime.json"), JSON.stringify(manifest));
    save();
    for (const [platform, arch, expected] of [["darwin", "arm64", arm], ["linux", "arm64", arm], ["linux", "x64", amd]] as const) {
      Object.defineProperty(process, "platform", { ...beforePlatform, value: platform });
      Object.defineProperty(process, "arch", { ...beforeArch, value: arch });
      const actual = readApprovedWorkerSandboxRelease();
      assert.equal(actual.image.digest, expected.image.digest);
      assert.equal(actual.kit.reference, path.join(root, expected.kit.reference));
      assert.deepEqual(actual.guest, expected.guest);
    }
    amd.status = "candidate"; save();
    assert.throws(readApprovedWorkerSandboxRelease, /not an approved/);
    amd.status = "approved"; save();
    writeFileSync(path.join(root, "amd", "spec.yaml"), "tampered");
    assert.throws(readApprovedWorkerSandboxRelease, /approved SHA-256/);
  } finally {
    Object.defineProperty(process, "platform", beforePlatform);
    Object.defineProperty(process, "arch", beforeArch);
    if (beforeConfig === undefined) delete process.env.PI_TOOLS_CONFIG_DIR; else process.env.PI_TOOLS_CONFIG_DIR = beforeConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native Sandbox selection preserves Apple Silicon and selects AMD64 on Linux", () => {
  assert.equal(resolveWorkerSandboxPlatform("darwin", "arm64"), "linux/arm64");
  assert.equal(resolveWorkerSandboxPlatform("linux", "arm64"), "linux/arm64");
  assert.equal(resolveWorkerSandboxPlatform("linux", "x64"), "linux/amd64");
  for (const [platform, arch] of [["darwin", "x64"], ["linux", "ia32"], ["linux", "riscv64"], ["win32", "x64"]]) {
    assert.throws(() => resolveWorkerSandboxPlatform(platform, arch), /Unsupported Worker Sandbox host/);
  }
});

test("selection retains each platform's complete independent immutable release", () => {
  const arm = { status: "approved", image: { digest: "a".repeat(64) }, kit: { sha256: "b".repeat(64) }, guest: { resourceManifestSha256: "c".repeat(64) } };
  const amd = { status: "candidate", image: { digest: "d".repeat(64) }, kit: { sha256: "e".repeat(64) }, guest: { resourceManifestSha256: "f".repeat(64) } };
  const manifest = { schemaVersion: 3, platforms: { "linux/arm64": arm, "linux/amd64": amd } };
  assert.equal(selectWorkerSandboxRelease(manifest, "linux/arm64"), arm);
  assert.equal(selectWorkerSandboxRelease(manifest, "linux/amd64"), amd);
  assert.equal(selectWorkerSandboxRelease(manifest, resolveWorkerSandboxPlatform("darwin", "arm64")), arm);
  assert.throws(() => selectWorkerSandboxRelease({ schemaVersion: 3, platforms: { "linux/arm64": arm } }, "linux/amd64"), /unavailable.*linux\/amd64/);
  for (const invalid of [null, [], { schemaVersion: 2 }, { schemaVersion: 3, platforms: [] }, { schemaVersion: 3, platforms: { "linux/386": arm } }, { schemaVersion: 3, platforms: { "linux/amd64": null } }]) {
    assert.throws(() => selectWorkerSandboxRelease(invalid, "linux/amd64"), /manifest|configuration|unavailable/);
  }
});
