import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildWorkerRpcArgs, type WorkerHostConfig } from "../extensions/worker/runner.js";
import { assertWorkerSandboxReference, createWorkerSandboxAsync, planWorkerSandbox, settleWorkerSandboxAsync, type WorkerSandboxRelease } from "../extensions/worker/sandbox.js";

const release: WorkerSandboxRelease = { schemaVersion: 1, protocolVersion: 1, status: "approved", kit: { reference: "/immutable/pi-kit", sha256: "a".repeat(64) }, image: { reference: `example.invalid/pi@sha256:${"b".repeat(64)}`, digest: "b".repeat(64) }, revisions: { pi: "1".repeat(40), profile: "2".repeat(40), piTools: "3".repeat(40), piDocparser: "4".repeat(40) }, guest: { piCli: "/usr/local/bin/pi", rpcLauncher: "/opt/pi-worker/launch.mjs", codingAgentDir: "/run/pi-worker/agent", resourceManifestSha256: "c".repeat(64), extensionPaths: ["/opt/profile/extensions", "/opt/pi-tools/extensions/worker/runtime.ts"], searxngUrl: "http://host.docker.internal:18888" } };

async function temp(run: (root: string) => Promise<void>) { const root = await mkdtemp(path.join(tmpdir(), "pi-worker-sbx-")); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }

test("Sandbox planning freezes exact runtime provenance and deterministic mounts", async () => temp(async (root) => {
  const workerRoot = path.join(root, "worker"); const codeRoot = path.join(root, "Code"); const input = path.join(root, "input.txt"); await mkdir(workerRoot); await mkdir(codeRoot); await writeFile(input, "evidence\n");
  const planned = planWorkerSandbox({ workerId: "worker_20260101000000_aaaaaaaa", runId: "run_20260101000000_bbbbbbbb", creationNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", workerRoot, codeRoot, mounts: [{ source: input, readOnly: true }, { source: input, readOnly: true }], release });
  assert.equal(planned.kind, "docker-sandbox"); assert.equal(planned.imageDigest, "b".repeat(64)); assert.equal(planned.kitSha256, "a".repeat(64)); assert.deepEqual(planned.mounts, [{ source: input, readOnly: true }]); assert.equal(planned.extensionPaths.length, 2);
}));


test("exact Sandbox references reject writable extension paths, duplicate extensions, and credential-bearing service URLs", async () => temp(async (root) => {
  const workerRoot = path.join(root, "worker"); const codeRoot = path.join(root, "Code"); await mkdir(workerRoot); await mkdir(codeRoot);
  const planned = planWorkerSandbox({ workerId: "worker_20260101000000_aaaaaaaa", runId: "run_20260101000000_bbbbbbbb", creationNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", workerRoot, codeRoot, mounts: [], release });
  assert.throws(() => assertWorkerSandboxReference({ ...planned, extensionPaths: ["/worker/extensions/runtime.ts"] }), /Invalid exact/);
  assert.throws(() => assertWorkerSandboxReference({ ...planned, extensionPaths: [planned.extensionPaths[0]!, planned.extensionPaths[0]!] }), /Invalid exact/);
  assert.throws(() => assertWorkerSandboxReference({ ...planned, searxngUrl: "https://secret@example.invalid" }), /Invalid exact/);
}));

test("Sandbox create and terminal removal use one exact name and verify absence", async () => temp(async (root) => {
  const workerRoot = path.join(root, "worker"); const codeRoot = path.join(root, "Code"); await mkdir(workerRoot); await mkdir(codeRoot); const log = path.join(root, "sbx.log"); const state = path.join(root, "state");
  const fake = path.join(root, "sbx"); await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1" in create) printf 'Name: %s\\n' "$3"; printf '%s\\n' "$3" > ${JSON.stringify(state)};; exec) printf 'cpu=8\\nmemoryBytes=17179869184\\n';; stop) :;; rm) rm -f ${JSON.stringify(state)};; ls) test -e ${JSON.stringify(state)} && cat ${JSON.stringify(state)} || :;; esac\n`); await chmod(fake, 0o755);
  const planned = planWorkerSandbox({ workerId: "worker_20260101000000_aaaaaaaa", runId: "run_20260101000000_bbbbbbbb", creationNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", workerRoot, codeRoot, mounts: [], release });
  const created = await createWorkerSandboxAsync(fake, planned); assert.match(created.createEvidenceSha256 ?? "", /^[a-f0-9]{64}$/); assert.equal(created.observedCpu, 8); assert.equal(created.observedMemoryBytes, 17_179_869_184); await settleWorkerSandboxAsync(fake, created);
  const commands = await readFile(log, "utf8"); assert.match(commands, new RegExp(`create --name ${planned.sandboxName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)); assert.match(commands, new RegExp(`stop ${planned.sandboxName}`)); assert.match(commands, new RegExp(`rm --force ${planned.sandboxName}`));
}));

test("RPC arguments retain immutable explicit extensions and complete built-in tools", () => {
  const sandbox = { ...planWorkerSandbox } as never;
  const config = { provider: "openai-codex", model: "gpt", thinkingLevel: "xhigh", sessionFile: "/worker/session.jsonl", sessionDir: "/worker", sandbox: { extensionPaths: release.guest.extensionPaths } } as WorkerHostConfig;
  const args = buildWorkerRpcArgs(config); assert.equal(args.includes("--no-builtin-tools"), false); assert.equal(args.includes("--tools"), false); assert.equal(args.includes("--no-extensions"), true); for (const extension of release.guest.extensionPaths) assert.ok(args.includes(extension));
});

test("sbx RPC shim forwards byte streams and only non-secret launch environment", async () => temp(async (root) => {
  const output = path.join(root, "output.json"); const fake = path.join(root, "sbx");
  await writeFile(fake, `#!/bin/sh\nnode -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{require("fs").writeFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),input:s,secret:process.env.REAL_TOKEN}))})' ${JSON.stringify(output)} "$@"\n`); await chmod(fake, 0o755);
  const manifest = path.join(root, "manifest.json"); await writeFile(manifest, JSON.stringify({ version: 1, sbxPath: fake, sandbox: { kind: "docker-sandbox", sandboxName: "pi-worker-run", rpcLauncher: "/opt/pi-worker/launch.mjs" }, guestEnvironment: { PI_WORKER_ID: "worker_test", OPENAI_CODEX_SENTINEL: "header.payload.signature" } }));
  const shim = path.resolve("scripts/worker-sbx-rpc.mjs"); const child = spawn(process.execPath, [shim, "--mode", "rpc", "--session", "/worker/session.jsonl"], { env: { ...process.env, REAL_TOKEN: "must-not-cross", PI_WORKER_SANDBOX_LAUNCH_MANIFEST: manifest }, stdio: ["pipe", "pipe", "pipe"] }); child.stdin.end('{"type":"probe"}\n'); const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); assert.equal(code, 0);
  const captured = JSON.parse(await readFile(output, "utf8")); assert.equal(captured.input, '{"type":"probe"}\n'); assert.equal(captured.secret, "must-not-cross", "fake host process sees host env but guest receives only explicit env arguments"); const joined = captured.argv.join(" "); assert.match(joined, /^exec pi-worker-run env /); assert.match(joined, /PI_WORKER_ID=worker_test/); assert.doesNotMatch(joined, /must-not-cross/); assert.match(joined, /\/opt\/pi-worker\/launch\.mjs --mode rpc/);
}));
