import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildWorkerRpcArgs, type WorkerHostConfig } from "../extensions/worker/runner.js";
import { assertWorkerSandboxReference, createWorkerSandboxAsync, planWorkerSandbox, settleWorkerSandboxAsync, type WorkerSandboxRelease } from "../extensions/worker/sandbox.js";

const revisions = { pi: "1".repeat(40), profile: "2".repeat(40), piTools: "3".repeat(40), piDocparser: "4".repeat(40) };
const extensionPaths = ["/opt/profile/extensions", "/opt/pi-tools/extensions/worker/runtime.ts"];
const runtimeJson = JSON.stringify({ protocolVersion: 1, piRevision: revisions.pi, profileRevision: revisions.profile, piToolsRevision: revisions.piTools, piDocparserRevision: revisions.piDocparser, resourceManifestSha256: "c".repeat(64), extensionPaths });
const release: WorkerSandboxRelease = { schemaVersion: 1, protocolVersion: 1, releaseOrdinal: 1, status: "approved", kit: { reference: "/immutable/pi-kit", sha256: "a".repeat(64) }, image: { reference: `example.invalid/pi@sha256:${"b".repeat(64)}`, digest: "b".repeat(64) }, sandbox: { version: "v0.49.1", template: { id: "template-id-1234", repository: "pi-worker-r1-deadbeef", tag: "loaded", flavor: "pi-managed-worker" } }, revisions, guest: { piCli: "/usr/local/bin/pi", rpcLauncher: "/opt/pi-worker/launch.mjs", codingAgentDir: "/run/pi-worker/agent", resourceManifestSha256: "c".repeat(64), runtimeProvenanceSha256: createHash("sha256").update(runtimeJson).digest("hex"), extensionPaths, searxngUrl: "http://host.docker.internal:18888" } };

async function temp(run: (root: string) => Promise<void>) { const root = await mkdtemp(path.join(tmpdir(), "pi-worker-sbx-")); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }

test("Sandbox planning freezes exact runtime provenance and deterministic mounts", async () => temp(async (root) => {
  const workerRoot = path.join(root, "worker"); const codeRoot = path.join(root, "Code"); const input = path.join(root, "input.txt"); await mkdir(workerRoot); await mkdir(codeRoot); await writeFile(input, "evidence\n");
  const planned = planWorkerSandbox({ workerId: "worker_20260101000000_aaaaaaaa", runId: "run_20260101000000_bbbbbbbb", creationNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", workerRoot, codeRoot, mounts: [{ source: input, readOnly: true }, { source: input, readOnly: true }], release });
  assert.equal(planned.kind, "docker-sandbox"); assert.equal(planned.imageDigest, "b".repeat(64)); assert.equal(planned.kitSha256, "a".repeat(64)); assert.deepEqual(planned.mounts, [{ source: input, readOnly: true }]); assert.equal(planned.extensionPaths.length, 2); assert.ok(planned.sandboxName.endsWith(`-${planned.creationNonce}`)); assert.equal(planned.sandboxName.length, 60);
}));


test("exact Sandbox references reject writable extension paths, duplicate extensions, and credential-bearing service URLs", async () => temp(async (root) => {
  const workerRoot = path.join(root, "worker"); const codeRoot = path.join(root, "Code"); await mkdir(workerRoot); await mkdir(codeRoot);
  const planned = planWorkerSandbox({ workerId: "worker_20260101000000_aaaaaaaa", runId: "run_20260101000000_bbbbbbbb", creationNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", workerRoot, codeRoot, mounts: [], release });
  assert.throws(() => assertWorkerSandboxReference({ ...planned, extensionPaths: ["/worker/extensions/runtime.ts"] }), /Invalid exact/);
  assert.throws(() => assertWorkerSandboxReference({ ...planned, extensionPaths: [planned.extensionPaths[0]!, planned.extensionPaths[0]!] }), /Invalid exact/);
  assert.throws(() => assertWorkerSandboxReference({ ...planned, searxngUrl: "https://secret@example.invalid" }), /Invalid exact/);
  assert.throws(() => assertWorkerSandboxReference({ ...planned, sandboxName: planned.sandboxName.slice(0, -1) }), /nonce|exact/i);
  assert.throws(() => assertWorkerSandboxReference({ ...planned, inspectEvidenceSha256: "not-a-digest" }), /inspect evidence/);
}));

test("Sandbox create and terminal removal use one exact name and verify absence", async () => temp(async (root) => {
  const workerRoot = path.join(root, "worker"); const codeRoot = path.join(root, "Code"); await mkdir(workerRoot); await mkdir(codeRoot); const log = path.join(root, "sbx.log"); const state = path.join(root, "state");
  const fake = path.join(root, "sbx"); await writeFile(fake, `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = version ]; then printf 'v0.49.1\n'
elif [ "$1 $2 $3" = "template ls --json" ]; then printf '%s\n' '[{"id":"${release.sandbox.template.id}","repository":"${release.sandbox.template.repository}","tag":"${release.sandbox.template.tag}","flavor":"${release.sandbox.template.flavor}","created_at":"2026-10-25T00:00:00Z","size":123}]'
elif [ "$1" = create ]; then printf 'ID: sandbox-id-1234\nName: %s\n' "$3"; printf '%s\n' "$3" > ${JSON.stringify(state)}
elif [ "$1" = inspect ] && [ "$3" = --json ]; then printf '{"name":"%s","id":"sandbox-id-1234","status":"running","agent":"shell","workspace":"%s"}\n' "$2" ${JSON.stringify(workerRoot)}
elif [ "$1" = exec ]; then printf 'cpu=8\nmemoryBytes=17179869184\nruntime=%s\nresource=%s\n' '${runtimeJson}' '${release.guest.resourceManifestSha256}'
elif [ "$1" = stop ]; then :
elif [ "$1" = rm ]; then rm -f ${JSON.stringify(state)}
elif [ "$1 $2" = "ls --json" ]; then if test -e ${JSON.stringify(state)}; then n=$(cat ${JSON.stringify(state)}); printf '[{"id":"sandbox-id-1234","name":"%s","status":"running","agent":"shell","workspace":"${workerRoot}"}]\n' "$n"; else printf '[]\n'; fi
elif [ "$1" = ls ]; then test -e ${JSON.stringify(state)} && cat ${JSON.stringify(state)} || :
else exit 64
fi
`); await chmod(fake, 0o755);
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
  const manifest = path.join(root, "manifest.json"); await writeFile(manifest, JSON.stringify({ version: 1, sbxPath: fake, sandbox: { kind: "docker-sandbox", sandboxName: "pi-worker-run", workingDirectory: "/worker/workspace", workspaceRoot: "/worker/workspace", rpcLauncher: "/opt/pi-worker/launch.mjs" }, guestEnvironment: { PI_WORKER_ID: "worker_test", OPENAI_CODEX_SENTINEL: "header.payload.signature" } }));
  const shim = path.resolve("scripts/worker-sbx-rpc.mjs"); const child = spawn(process.execPath, [shim, "--mode", "rpc", "--session", "/worker/session.jsonl"], { env: { ...process.env, REAL_TOKEN: "must-not-cross", PI_WORKER_SANDBOX_LAUNCH_MANIFEST: manifest }, stdio: ["pipe", "pipe", "pipe"] }); child.stdin.end('{"type":"probe"}\n'); const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); assert.equal(code, 0);
  const captured = JSON.parse(await readFile(output, "utf8")); assert.equal(captured.input, '{"type":"probe"}\n'); assert.equal(captured.secret, "must-not-cross", "fake host process sees host env but guest receives only explicit env arguments"); const joined = captured.argv.join(" "); assert.match(joined, /^exec --workdir \/worker\/workspace pi-worker-run env /); assert.match(joined, /PI_WORKER_ID=worker_test/); assert.doesNotMatch(joined, /must-not-cross/); assert.match(joined, /\/opt\/pi-worker\/launch\.mjs --mode rpc/);
}));

test("packaged worker-host spawns through the real shim and fake sbx, admits typed RPC, settles, and exits on EOF", async () => temp(async (root) => {
  const workerId = "worker_20260101000000_aaaaaaaa"; const runId = "run_20260101000000_bbbbbbbb"; const sessionId = "session-spawned-host";
  const workerRoot = path.join(root, "worker"); const workspaceRoot = path.join(workerRoot, "workspace"); const sessionDir = path.join(workerRoot, "session"); const runDir = path.join(root, "supervision", runId); await mkdir(workspaceRoot, { recursive: true }); await mkdir(sessionDir, { recursive: true }); await mkdir(runDir, { recursive: true }); await mkdir(path.join(workerRoot, "async-shell"));
  const sessionFile = path.join(sessionDir, "session.jsonl"); await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: sessionId, cwd: workspaceRoot })}\n`);
  const fakeRpc = path.resolve("tests/fixtures/worker-sandbox-rpc-fixture.mjs"); const sbxLog = path.join(root, "sbx.log"); const fakeSbx = path.join(root, "sbx");
  await writeFile(fakeSbx, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(sbxLog)}\nif [ "$1" = exec ]; then while [ "$1" != env ]; do shift; done; shift; while echo "$1" | grep -q '='; do export "$1"; shift; done; shift; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeRpc)} "$@"; fi\nexit 0\n`); await chmod(fakeSbx, 0o755);
  const beadsDir = path.join(root, "beads"); await mkdir(beadsDir); const fakeBd = path.join(root, "bd");
  await writeFile(fakeBd, `#!/bin/sh
if echo "$*" | grep -q 'where --json'; then printf '%s\n' '{"prefix":"personal","path":"${beadsDir}","database_path":"${path.join(beadsDir, "db")}"}'
elif echo "$*" | grep -q 'search'; then printf '%s\n' '[{"id":"personal-test","title":"Test","status":"in_progress","priority":1,"issue_type":"task","design":"Spawned design"}]'
elif echo "$*" | grep -q 'show'; then printf '%s\n' '[{"id":"personal-test","title":"Test","status":"in_progress","priority":1,"issue_type":"task","design":"Spawned design"}]'
elif echo "$*" | grep -q 'update'; then printf '%s\n' '{"ok":true}'
else exit 9; fi
`); await chmod(fakeBd, 0o755);
  const provenance = { protocolVersion: 1, sandboxName: "pi-worker-spawned", creationNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", piRevision: "1".repeat(40), profileRevision: "2".repeat(40), piToolsRevision: "3".repeat(40), piDocparserRevision: "4".repeat(40), resourceManifestSha256: "a".repeat(64), runtimeProvenanceSha256: "e".repeat(64), imageDigest: "b".repeat(64), kitSha256: "c".repeat(64), sbxVersion: "v0.49.1", templateId: "template-id-1234", templateRepository: "pi-worker-r1-deadbeef", templateTag: "loaded", templateFlavor: "pi-managed-worker", inspectEvidenceSha256: "f".repeat(64), sbxVersionEvidenceSha256: "9".repeat(64), extensionPaths: ["/opt/pi-tools/runtime.ts"], observedSandboxId: "sandbox-id-1234", observedRuntimeSha256: "d".repeat(64) };
  const sandbox = { kind: "docker-sandbox", sandboxName: provenance.sandboxName, creationNonce: provenance.creationNonce, workingDirectory: workspaceRoot, workspaceRoot, rpcLauncher: "/opt/pi-worker/launch.mjs" };
  const launchManifestFile = path.join(runDir, "launch.json"); const launchText = `${JSON.stringify({ version: 1, sbxPath: fakeSbx, sandbox, guestEnvironment: { FAKE_TRACE: path.join(root, "rpc.trace"), FAKE_WORKER_IDENTITY: JSON.stringify({ workerId, runId, role: "work", sessionId, ...provenance }) } }, null, 2)}\n`; await writeFile(launchManifestFile, launchText);
  const resultFile = path.join(runDir, "result.json"); const settledFile = path.join(runDir, "settled.json"); const processFile = path.join(runDir, "process.json"); const authorizationFile = path.join(runDir, "authorization.json"); const configFile = path.join(runDir, "host.json");
  await writeFile(authorizationFile, `${JSON.stringify({ version: 2, workerId, runId, processNonce: "process-nonce", sandboxName: sandbox.sandboxName, creationNonce: sandbox.creationNonce })}\n`);
  const config = { version: 2, backend: "docker-sandbox", workerId, runId, role: "work", sessionId, sessionFile, sessionDir, workerRoot, workspaceRoot, asyncJobRoot: path.join(workerRoot, "async-shell"), taskIds: ["personal-test"], resultFile, settledFile, helloFile: path.join(runDir, "hello.json"), stateFile: path.join(runDir, "state.json"), processFile, processNonce: "process-nonce", hostConfigFile: configFile, cancellationFile: path.join(runDir, "cancel-request.json"), supervisionRoot: runDir, authorizationFile, launchManifestFile, launchManifestSha256: createHash("sha256").update(launchText).digest("hex"), prompt: "spawned host probe", sandbox, sandboxShimPath: path.resolve("scripts/worker-sbx-rpc.mjs"), sbxPath: fakeSbx, runtimeProvenance: provenance, rpcArgs: ["--session", sessionFile] };
  await writeFile(configFile, `${JSON.stringify(config)}\n`);
  const host = spawn(process.execPath, [path.resolve("scripts/worker-host.mjs"), configFile], { detached: true, cwd: workspaceRoot, env: { ...process.env, PI_WORKER_JOB_TOKEN: "job-token-spawned", PI_WORKER_ID: workerId, PI_WORKER_RUN_ID: runId, PI_WORKER_RESULT_FILE: resultFile, PI_WORKER_WORKSPACE_ROOT: workspaceRoot, PI_WORKER_STATE_ROOT: workerRoot, PI_WORKER_SUPERVISION_ROOT: runDir, PI_WORKER_ASYNC_JOB_ROOT: path.join(workerRoot, "async-shell"), PI_WORKER_TASK_IDS: JSON.stringify(["personal-test"]), PI_WORKER_ROLE: "work", PI_WORKER_BD_PATH: fakeBd, PI_WORKER_BEADS_ROUTE: JSON.stringify({ prefix: "personal", path: beadsDir, databasePath: path.join(beadsDir, "db") }), BEADS_DIR: beadsDir, PI_WORKER_AUTHORIZATION_FILE: authorizationFile, PI_WORKER_PROCESS_NONCE: "process-nonce" }, stdio: ["ignore", "pipe", "pipe"] });
  const killTimer = setTimeout(() => { if (host.pid) try { process.kill(-host.pid, "SIGKILL"); } catch {} }, 30_000);
  const [code, stdout, stderr] = await Promise.all([new Promise<number | null>((resolve, reject) => { host.once("error", reject); host.once("exit", resolve); }), collectStream(host.stdout), collectStream(host.stderr)]);
  clearTimeout(killTimer); assert.equal(code, 0, `${stderr}\nstdout=${stdout}\nsbx=${existsSync(sbxLog) ? await readFile(sbxLog, "utf8") : "missing"}\nrpc=${existsSync(path.join(root, "rpc.trace")) ? await readFile(path.join(root, "rpc.trace"), "utf8") : "missing"}`); assert.equal(existsSync(resultFile), true); assert.equal(existsSync(settledFile), true); assert.match(stdout, /worker_host_result/); const trace = await readFile(path.join(root, "rpc.trace"), "utf8"); for (const label of ["additional-field-rejected", "assigned", "get", "search", "design", "update-status-less", "update-with-status", "result-additional-field-rejected", "identical-retry-after-response-loss", "conflicting-retry-rejected"]) assert.match(trace, new RegExp(`checked:${label}`)); assert.match(trace, /eof/); const sbxArgs = await readFile(sbxLog, "utf8"); assert.match(sbxArgs, new RegExp(`exec --workdir ${workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ${sandbox.sandboxName}`));
}));

async function collectStream(stream: NodeJS.ReadableStream): Promise<string> { let value = ""; for await (const chunk of stream) value += chunk; return value; }

test("sbx RPC shim propagates guest signal termination as nonzero", async () => temp(async (root) => {
  const fake=path.join(root,"sbx-signal"); await writeFile(fake,"#!/bin/sh\nkill -TERM $$\n"); await chmod(fake,0o755); const manifest=path.join(root,"manifest.json"); await writeFile(manifest,JSON.stringify({version:1,sbxPath:fake,sandbox:{kind:"docker-sandbox",sandboxName:"pi-worker-signal",workingDirectory:"/worker/workspace",workspaceRoot:"/worker/workspace",rpcLauncher:"/opt/pi-worker/launch.mjs"},guestEnvironment:{}})); const child=spawn(process.execPath,[path.resolve("scripts/worker-sbx-rpc.mjs"),"--mode","rpc"],{env:{...process.env,PI_WORKER_SANDBOX_LAUNCH_MANIFEST:manifest},stdio:["ignore","pipe","pipe"]}); const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve)}); assert.equal(code,143);
}));

test("spawned supervisor covers ordering, every result branch, missing-result grace, mutation-drained cancellation, and EOF-to-stop escalation", async () => {
  for (const scenario of ["missing", "ignore-eof", "cancel", "cancel-mutation", "cancel-result", "ordering", "outcome-completed", "outcome-needs_input", "outcome-blocked", "outcome-approve", "outcome-request_changes"]) await temp(async (root) => {
    const workerId="worker_20260101000000_aaaaaaaa", runId="run_20260101000000_bbbbbbbb", sessionId=`session-${scenario}`, role=scenario === "outcome-approve" || scenario === "outcome-request_changes" ? "review" : "work";
    const workerRoot=path.join(root,"worker"), workspaceRoot=path.join(workerRoot,"workspace"), sessionDir=path.join(workerRoot,"session"), runDir=path.join(root,"supervision",runId);
    await mkdir(workspaceRoot,{recursive:true}); await writeFile(path.join(workspaceRoot,"report.md"),"# spawned review\n"); await mkdir(sessionDir,{recursive:true}); await mkdir(path.join(workerRoot,"async-shell")); await mkdir(runDir,{recursive:true});
    const sessionFile=path.join(sessionDir,"session.jsonl"); await writeFile(sessionFile,`${JSON.stringify({type:"session",id:sessionId,cwd:workspaceRoot})}\n`);
    const rpcTrace=path.join(root,"rpc.trace"), sbxTrace=path.join(root,"sbx.trace"), execPid=path.join(root,"exec.pid"), fakeSbx=path.join(root,"sbx"), fakeRpc=path.resolve("tests/fixtures/worker-sandbox-rpc-fixture.mjs");
    const settledFile=path.join(runDir,"settled.json"), beadsDir=path.join(root,"beads"), fakeBd=path.join(root,"bd"); await mkdir(beadsDir); await writeFile(fakeBd,`#!/usr/bin/env node\nconst args=process.argv.slice(2); if(args.includes("where")) process.stdout.write(${JSON.stringify(JSON.stringify({prefix:"personal",path:"__BEADS__",database_path:"__DB__"}))}.replace("__BEADS__",${JSON.stringify(beadsDir)}).replace("__DB__",${JSON.stringify(path.join(beadsDir,"db"))})); else if(args.includes("update")){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);process.stdout.write('{"ok":true}');} else process.stdout.write('[]');\n`); await chmod(fakeBd,0o755);
    await writeFile(fakeSbx,`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(sbxTrace)}\nif [ "$1" = exec ]; then echo $$ > ${JSON.stringify(execPid)}; while [ "$1" != env ]; do shift; done; shift; while echo "$1" | grep -q '='; do export "$1"; shift; done; shift; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeRpc)} "$@"; fi\nif [ "$1" = stop ]; then echo 'sbx-stop' >> ${JSON.stringify(rpcTrace)}; if test -e ${JSON.stringify(settledFile)}; then echo 'stop:settled=yes' >> ${JSON.stringify(sbxTrace)}; else echo 'stop:settled=no' >> ${JSON.stringify(sbxTrace)}; fi; test -e ${JSON.stringify(execPid)} && kill -KILL "$(cat ${JSON.stringify(execPid)})" 2>/dev/null || :; fi\nexit 0\n`); await chmod(fakeSbx,0o755);
    const provenance={protocolVersion:1,sandboxName:`pi-case-${scenario.replaceAll("_","-")}`,creationNonce:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",piRevision:"1".repeat(40),profileRevision:"2".repeat(40),piToolsRevision:"3".repeat(40),piDocparserRevision:"4".repeat(40),resourceManifestSha256:"a".repeat(64),runtimeProvenanceSha256:"e".repeat(64),imageDigest:"b".repeat(64),kitSha256:"c".repeat(64),sbxVersion:"v0.49.1",templateId:"template-id-1234",templateRepository:"pi-worker-r1-deadbeef",templateTag:"loaded",templateFlavor:"pi-managed-worker",inspectEvidenceSha256:"f".repeat(64),sbxVersionEvidenceSha256:"9".repeat(64),extensionPaths:["/opt/pi-tools/runtime.ts"],observedSandboxId:"sandbox-id-1234",observedRuntimeSha256:"d".repeat(64)};
    const sandbox={kind:"docker-sandbox",sandboxName:provenance.sandboxName,creationNonce:provenance.creationNonce,workingDirectory:workspaceRoot,workspaceRoot,rpcLauncher:"/opt/pi-worker/launch.mjs"};
    const launchManifestFile=path.join(runDir,"launch.json"), launchText=`${JSON.stringify({version:1,sbxPath:fakeSbx,sandbox,guestEnvironment:{FAKE_TRACE:rpcTrace,FAKE_SCENARIO:scenario,FAKE_WORKER_IDENTITY:JSON.stringify({workerId,runId,role,sessionId,...provenance})}})}\n`; await writeFile(launchManifestFile,launchText);
    const resultFile=path.join(runDir,"result.json"), processFile=path.join(runDir,"process.json"), authorizationFile=path.join(runDir,"authorization.json"), cancellationFile=path.join(runDir,"cancel-request.json"), configFile=path.join(runDir,"host.json");
    await writeFile(authorizationFile,`${JSON.stringify({version:2,workerId,runId,processNonce:"process-nonce",sandboxName:sandbox.sandboxName,creationNonce:sandbox.creationNonce})}\n`);
    const config={version:2,backend:"docker-sandbox",workerId,runId,role,sessionId,sessionFile,sessionDir,workerRoot,workspaceRoot,supervisionRoot:runDir,asyncJobRoot:path.join(workerRoot,"async-shell"),taskIds:["personal-test"],resultFile,settledFile,helloFile:path.join(runDir,"hello.json"),stateFile:path.join(runDir,"state.json"),processFile,processNonce:"process-nonce",hostConfigFile:configFile,cancellationFile,authorizationFile,launchManifestFile,launchManifestSha256:createHash("sha256").update(launchText).digest("hex"),prompt:"race probe",sandbox,sandboxShimPath:path.resolve("scripts/worker-sbx-rpc.mjs"),sbxPath:fakeSbx,runtimeProvenance:provenance,rpcArgs:["--session",sessionFile]}; await writeFile(configFile,`${JSON.stringify(config)}\n`);
    const host=spawn(process.execPath,[path.resolve("scripts/worker-host.mjs"),configFile],{cwd:workspaceRoot,env:{...process.env,PI_WORKER_JOB_TOKEN:`job-${scenario}`,PI_WORKER_ID:workerId,PI_WORKER_RUN_ID:runId,PI_WORKER_RESULT_FILE:resultFile,PI_WORKER_WORKSPACE_ROOT:workspaceRoot,PI_WORKER_STATE_ROOT:workerRoot,PI_WORKER_SUPERVISION_ROOT:runDir,PI_WORKER_ASYNC_JOB_ROOT:path.join(workerRoot,"async-shell"),PI_WORKER_TASK_IDS:JSON.stringify(["personal-test"]),PI_WORKER_ROLE:role,PI_WORKER_BD_PATH:fakeBd,PI_WORKER_BEADS_ROUTE:JSON.stringify({prefix:"personal",path:beadsDir,databasePath:path.join(beadsDir,"db")}),BEADS_DIR:beadsDir,PI_WORKER_AUTHORIZATION_FILE:authorizationFile,PI_WORKER_PROCESS_NONCE:"process-nonce"},stdio:["ignore","pipe","pipe"]});
    if(scenario==="cancel" || scenario==="cancel-mutation" || scenario==="cancel-result"){ await waitForText(rpcTrace,scenario==="cancel-result"?"result-sent":"cancel-ready",15_000); await writeFile(cancellationFile,`${JSON.stringify({version:1,workerId,runId})}\n`); }
    const [code,,stderr]=await Promise.all([new Promise<number|null>((resolve,reject)=>{host.once("error",reject);host.once("exit",resolve)}),collectStream(host.stdout),collectStream(host.stderr)]);
    const rpc=await readFile(rpcTrace,"utf8"), sbx=await readFile(sbxTrace,"utf8"); assert.match(rpc,/eof/); assert.doesNotMatch(rpc,/signal:/);
    if(scenario==="missing"){assert.notEqual(code,0);assert.match(stderr,/without worker_result_submit/);assert.doesNotMatch(sbx,/^stop /m);}
    if(scenario==="ignore-eof"){assert.equal(existsSync(settledFile),true);assert.match(sbx,/^stop /m);assert.match(sbx,/stop:settled=yes/);assert.ok(rpc.indexOf("eof")>=0 && rpc.indexOf("eof")<rpc.indexOf("sbx-stop"));}
    if(scenario==="cancel" || scenario==="cancel-mutation" || scenario==="cancel-result"){assert.notEqual(code,0);assert.doesNotMatch(sbx,/^stop /m);if(scenario==="cancel-mutation")assert.match(rpc,/mutation-response:success/);assert.ok(rpc.indexOf("mutation-response:success")<rpc.indexOf("eof"));if(scenario==="cancel-result"){assert.equal(existsSync(resultFile),true);assert.equal(JSON.parse(await readFile(resultFile,"utf8")).result.outcome,"completed");}}
    if(scenario==="ordering"){assert.equal(code,0,stderr);for(const label of ["state-before-hello-rejected","mismatched-hello-rejected","duplicate-hello-rejected","state-additional-field-rejected","state-sequence-replay-rejected"])assert.match(rpc,new RegExp(`checked:${label}`));}
    if(scenario.startsWith("outcome-")){assert.equal(code,0,stderr);assert.equal(JSON.parse(await readFile(resultFile,"utf8")).result.outcome,scenario.slice(8));assert.match(rpc,new RegExp(`checked:${scenario}`));}
  });
});
async function waitForText(file:string,text:string,timeout:number){const start=Date.now();while(Date.now()-start<timeout){try{if((await readFile(file,"utf8")).includes(text))return;}catch{}await new Promise((resolve)=>setTimeout(resolve,20));}throw new Error(`Timed out waiting for ${text} in ${file}`);}
