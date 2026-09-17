import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildWorkerContainerEnvironment,
  createWorkerContainer,
  parkWorkerContainer,
  planWorkerContainer,
  prepareWorkerContainerProcess,
  settleWorkerContainer,
  signalWorkerContainerJob
} from "../extensions/_shared/worker-container.js";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-worker-container-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("worker container environment excludes host credentials and routes mutable state into the workspace", () => {
  const workspace = "/Users/test/.local/share/agent/workspaces/worker-test";
  const env = buildWorkerContainerEnvironment({
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    ANTHROPIC_API_KEY: "secret",
    SSH_AUTH_SOCK: "/private/agent.sock",
    BEADS_DIR: "/private/beads",
    PI_WORKER_JOB_TOKEN: "host-only-token"
  }, workspace);
  assert.equal(env.HOME, workspace);
  assert.equal(env.PATH, "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  assert.equal(env.XDG_CACHE_HOME, path.join(workspace, "cache"));
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.BEADS_DIR, undefined);
  assert.equal(env.PI_WORKER_JOB_TOKEN, undefined);
});

test("worker container process uses the trusted host helper and preserves only sanitized container environment", async () => {
  await withTempDir(async (directory) => {
    const codeRoot = path.join(directory, "Code");
    const workspaceRoot = path.join(directory, "workspace");
    await Promise.all([mkdir(codeRoot), mkdir(workspaceRoot)]);
    const container = {
      ...planWorkerContainer({ workerId: "worker_20260917140000_aaaaaaaa", runId: "run_20260917140000_bbbbbbbb", nonce: "nonce", codeRoot, workspaceRoot }),
      containerId: "a".repeat(64)
    };
    const prepared = prepareWorkerContainerProcess({
      dockerPath: process.execPath,
      container,
      jobId: "job_20260917140000_cccccccc",
      cwd: workspaceRoot,
      executable: "/bin/bash",
      args: ["--noprofile", "--norc", "-c", "printf ok"],
      env: { ...process.env, ANTHROPIC_API_KEY: "secret", PI_WORKER_JOB_TOKEN: "host-token" }
    });
    assert.equal(prepared.executable, process.execPath);
    assert.ok(prepared.args[0].endsWith("scripts/worker-shell-host.mjs"));
    const config = JSON.parse(prepared.args[1]) as { env: Record<string, string>; container: { containerId: string }; executable: string };
    assert.equal(config.container.containerId, container.containerId);
    assert.equal(config.executable, "/bin/bash");
    assert.equal(config.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(config.env.PI_WORKER_JOB_TOKEN, undefined);
    assert.equal(config.env.HOME, container.workspaceRoot);
    assert.equal(prepared.env.PI_WORKER_JOB_TOKEN, "host-token");
  });
});

test("worker container lifecycle uses exact labels, read-only Code, writable workspace, and verified removal", async () => {
  await withTempDir(async (directory) => {
    const codeRoot = path.join(directory, "Code");
    const workspaceRoot = path.join(directory, "workspace");
    const fakeDocker = path.join(directory, "docker");
    const stateFile = path.join(directory, "docker-state.json");
    const callsFile = path.join(directory, "docker-calls.jsonl");
    await Promise.all([mkdir(codeRoot), mkdir(workspaceRoot)]);
    await writeFile(fakeDocker, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(stateFile)};
const callsFile = ${JSON.stringify(callsFile)};
fs.appendFileSync(callsFile, JSON.stringify(args) + "\\n");
const load = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : undefined;
const save = (value) => fs.writeFileSync(stateFile, JSON.stringify(value));
const missing = () => { process.stderr.write("Error response from daemon: No such object\\n"); process.exit(1); };
if (args[0] === "image" && args[1] === "inspect") process.exit(0);
if (args[0] === "container" && args[1] === "inspect") { const state = load(); if (!state) missing(); process.stdout.write(JSON.stringify([{ Id: state.id, State: { Running: state.running, ExitCode: state.exitCode }, Config: { Labels: state.labels } }])); process.exit(0); }
if (args[0] === "create") { const id = "a".repeat(64); const labels = {}; for (let i=0;i<args.length;i++) if (args[i] === "--label") { const [k,v] = args[++i].split("=",2); labels[k]=v; } save({ id, labels, running:false, exitCode:0 }); process.stdout.write(id + "\\n"); process.exit(0); }
if (args[0] === "start") { const state=load(); state.running=true; save(state); process.stdout.write(state.id + "\\n"); process.exit(0); }
if (args[0] === "exec") process.exit(0);
if (args[0] === "stop" || args[0] === "kill") { const state=load(); state.running=false; state.exitCode=137; save(state); process.stdout.write(state.id + "\\n"); process.exit(0); }
if (args[0] === "wait") { const state=load(); if (!state) missing(); process.stdout.write(String(state.exitCode) + "\\n"); process.exit(0); }
if (args[0] === "rm") { const state=load(); if (!state) missing(); fs.unlinkSync(stateFile); process.stdout.write(state.id + "\\n"); process.exit(0); }
process.stderr.write("unsupported fake docker call: " + JSON.stringify(args) + "\\n"); process.exit(2);
`);
    await chmod(fakeDocker, 0o700);

    const planned = planWorkerContainer({
      workerId: "worker_20260917140000_aaaaaaaa",
      runId: "run_20260917140000_bbbbbbbb",
      nonce: "exact-nonce",
      codeRoot,
      workspaceRoot
    });
    const created = createWorkerContainer(fakeDocker, planned);
    assert.equal(created.containerId, "a".repeat(64));
    signalWorkerContainerJob(fakeDocker, created, "job_20260917140000_signalk1", "SIGKILL");
    parkWorkerContainer(fakeDocker, created);
    const reused = createWorkerContainer(fakeDocker, created);
    assert.equal(reused.containerId, created.containerId);
    settleWorkerContainer(fakeDocker, reused);
    assert.throws(
      () => createWorkerContainer(fakeDocker, reused),
      /disappeared; refusing to replace its exact persisted identity/
    );
    const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const creates = calls.filter((args) => args[0] === "create");
    assert.equal(creates.length, 1);
    const [create] = creates;
    assert.ok(create);
    assert.ok(create.includes(`pi.worker=${planned.workerId}`));
    assert.ok(create.includes(`pi.run=${planned.runId}`));
    assert.ok(create.includes(`pi.nonce=${planned.nonce}`));
    assert.ok(create.includes(`type=bind,src=${planned.codeRoot},dst=${planned.codeRoot},readonly,bind-propagation=rprivate`));
    assert.ok(create.includes(`type=bind,src=${planned.workspaceRoot},dst=${planned.workspaceRoot},bind-propagation=rprivate`));
    assert.ok(calls.some((args) => args[0] === "exec" && args.includes("SIGKILL") && args.some((value) => value.includes("kill"))));
    assert.ok(calls.some((args) => args[0] === "stop" && args.includes("SIGTERM") && args.includes("4")));
    assert.ok(calls.some((args) => args[0] === "wait" && args.includes(created.containerId)));
    assert.ok(calls.some((args) => args[0] === "rm" && args.includes(created.containerId)));
  });
});
