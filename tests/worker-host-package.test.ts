import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repoRoot = process.cwd();
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const sdkPeers = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"];

test("packed production worker host starts without Pi SDK peers or ancestor fallback", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-tools-worker-host-package-"));
  try {
    const packDir = path.join(root, "pack");
    const consumer = path.join(root, "consumer");
    const staging = path.join(root, "staging");
    await mkdir(packDir);
    await mkdir(consumer);
    await cp(repoRoot, staging, {
      recursive: true,
      filter(source) {
        const first = path.relative(repoRoot, source).split(path.sep)[0];
        return ![".git", ".pi", "node_modules"].includes(first);
      }
    });
    await symlink(path.join(repoRoot, "node_modules"), path.join(staging, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`);

    const packed = spawnSync(npmExecutable, ["pack", "--json", "--pack-destination", packDir, staging], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
      timeout: 90_000
    });
    assert.equal(packed.status, 0, `npm pack failed:\n${packed.stderr}\n${packed.stdout}`);
    const packResult = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>;
    assert.equal(packResult.length, 1);
    assert.equal(typeof packResult[0]?.filename, "string");
    const tarball = path.join(packDir, packResult[0]!.filename as string);

    const installed = spawnSync(npmExecutable, ["install", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", tarball], {
      cwd: consumer,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
      timeout: 120_000
    });
    assert.equal(installed.status, 0, `production install failed:\n${installed.stderr}\n${installed.stdout}`);

    const packageRoot = path.join(consumer, "node_modules", "@akoumjian", "pi-tools");
    const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
    assert.ok(packageJson.devDependencies?.["@earendil-works/pi-coding-agent"], "fixture must exercise a package whose SDK is not a production dependency");
    for (const peer of sdkPeers) {
      assert.equal(existsSync(path.join(consumer, "node_modules", "@earendil-works", peer)), false, `${peer} must be absent from the production install`);
      assert.equal(existsSync(path.join(packageRoot, "node_modules", "@earendil-works", peer)), false, `${peer} must not be nested under the package`);
    }
    for (let current = consumer; ; current = path.dirname(current)) {
      assert.equal(existsSync(path.join(current, "node_modules", "@earendil-works", "pi-coding-agent")), false, `SDK ancestor fallback exists at ${current}`);
      const parent = path.dirname(current);
      if (parent === current) break;
    }

    const workerHost = path.join(packageRoot, "scripts", "worker-host.mjs");
    const launched = spawnSync(process.execPath, [workerHost], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
      timeout: 30_000
    });
    const output = `${launched.stdout}\n${launched.stderr}`;
    assert.equal(launched.status, 1, output);
    assert.match(output, /Usage: worker-host\.mjs <host-config\.json>/);
    assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find package|@earendil-works\/pi-coding-agent/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
