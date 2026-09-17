import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnAsyncJobProcess } from "../extensions/_shared/async-job.js";
import {
  buildWorkspaceSandboxEnvironment,
  buildWorkspaceSandboxProfile,
  prepareWorkspaceSandboxProcess
} from "../extensions/_shared/workspace-sandbox.js";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-workspace-sandbox-"));
  try {
    await run(await realpath(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("worker shell environment removes credentials and routes caches into the workspace", async () => {
  await withTempDir(async (workspaceRoot) => {
    const env = buildWorkspaceSandboxEnvironment({
      HOME: "/Users/tester",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      PI_WORKER_ID: "worker-test",
      PI_WORKER_RUN_ID: "run-test",
      PI_WORKER_WORKSPACE_ROOT: workspaceRoot,
      PI_WORKER_RESULT_FILE: "/trusted/result.json",
      BEADS_DIR: "/trusted/beads",
      ANTHROPIC_API_KEY: "secret",
      SSH_AUTH_SOCK: "/private/agent.sock"
    }, workspaceRoot);

    assert.equal(env.PI_WORKER_ID, "worker-test");
    assert.equal(env.PI_WORKER_RESULT_FILE, undefined);
    assert.equal(env.BEADS_DIR, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.TMPDIR, path.join(workspaceRoot, "tmp"));
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    const profile = buildWorkspaceSandboxProfile({ workspaceRoot, home: "/Users/tester" });
    assert.match(profile, /deny file-write\*/);
    assert.match(profile, /auth\.json/);
  });
});

test("macOS worker shell sandbox permits workspace writes and denies symlink escape", { skip: process.platform !== "darwin" }, async () => {
  await withTempDir(async (directory) => {
    const workspaceRoot = path.join(directory, "workspaces", "worker-test");
    const outsideRoot = path.join(directory, "outside");
    const fakeHome = path.join(directory, "home");
    const workerStateRoot = path.join(directory, "workers", "worker-test");
    const parentContextSnapshot = path.join(workerStateRoot, "parent-context.jsonl");
    const customAgentDir = path.join(directory, "custom-agent");
    await Promise.all([
      mkdir(path.join(workspaceRoot, "cache", "config"), { recursive: true }),
      mkdir(path.join(workspaceRoot, "cache", "data"), { recursive: true }),
      mkdir(path.join(workspaceRoot, "cache", "state"), { recursive: true }),
      mkdir(path.join(workspaceRoot, "tmp"), { recursive: true }),
      mkdir(outsideRoot, { recursive: true }),
      mkdir(path.join(fakeHome, ".pi", "agent"), { recursive: true }),
      mkdir(workerStateRoot, { recursive: true }),
      mkdir(customAgentDir, { recursive: true })
    ]);
    await symlink(outsideRoot, path.join(workspaceRoot, "escape"));
    await symlink(customAgentDir, path.join(fakeHome, "relocated-agent"));
    const defaultCredentialTarget = path.join(directory, "default-ssh-target");
    await mkdir(defaultCredentialTarget, { recursive: true });
    await symlink(defaultCredentialTarget, path.join(fakeHome, ".ssh"));
    const insideFile = path.join(workspaceRoot, "inside.txt");
    const escapedFile = path.join(workspaceRoot, "escape", "escaped.txt");
    const outsideSource = path.join(outsideRoot, "source.txt");
    const hardlink = path.join(workspaceRoot, "hardlink.txt");
    const authFile = path.join(fakeHome, ".pi", "agent", "auth.json");
    const copiedCredential = path.join(workspaceRoot, "copied-auth.txt");
    const stateSecret = path.join(workerStateRoot, "host.json");
    const copiedState = path.join(workspaceRoot, "copied-state.txt");
    const copiedSnapshot = path.join(workspaceRoot, "copied-snapshot.txt");
    const relocatedAuth = path.join(customAgentDir, "auth.json");
    const copiedRelocatedAuth = path.join(workspaceRoot, "copied-relocated-auth.txt");
    const siblingState = path.join(directory, "workers", "worker-other", "host.json");
    const copiedSiblingState = path.join(workspaceRoot, "copied-sibling-state.txt");
    const defaultCredential = path.join(defaultCredentialTarget, "id_test");
    const copiedDefaultCredential = path.join(workspaceRoot, "copied-default-credential.txt");
    const siblingWorkspaceSecret = path.join(directory, "workspaces", "worker-other", "secret.txt");
    const copiedSiblingWorkspaceSecret = path.join(workspaceRoot, "copied-sibling-workspace-secret.txt");
    await Promise.all([
      writeFile(outsideSource, "original"),
      writeFile(authFile, "secret"),
      writeFile(path.join(fakeHome, ".zshenv"), "export WORKER_DOTFILE_SECRET=leaked\n"),
      writeFile(stateSecret, "trusted-state"),
      writeFile(parentContextSnapshot, "parent-context"),
      writeFile(relocatedAuth, "relocated-secret"),
      mkdir(path.dirname(siblingState), { recursive: true }).then(() => writeFile(siblingState, "sibling-secret")),
      writeFile(defaultCredential, "default-credential-secret"),
      mkdir(path.dirname(siblingWorkspaceSecret), { recursive: true }).then(() => writeFile(siblingWorkspaceSecret, "sibling-workspace-secret"))
    ]);
    const prepared = prepareWorkspaceSandboxProcess({
      executable: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');fs.writeFileSync('/dev/null','discard');fs.writeFileSync(process.argv[1],'inside');try{fs.linkSync(process.argv[3],process.argv[4]);fs.writeFileSync(process.argv[4],'corrupt')}catch{}try{fs.writeFileSync(process.argv[6],fs.readFileSync(process.argv[5]))}catch{}try{fs.writeFileSync(process.argv[8],fs.readFileSync(process.argv[7]))}catch{}try{fs.writeFileSync(process.argv[10],fs.readFileSync(process.argv[9]))}catch{}try{fs.writeFileSync(process.argv[14],fs.readFileSync(process.argv[13]))}catch{}try{fs.writeFileSync(process.argv[16],fs.readFileSync(process.argv[15]))}catch{}try{fs.writeFileSync(process.argv[18],fs.readFileSync(process.argv[17]))}catch{}fs.writeFileSync(process.argv[12],fs.readFileSync(process.argv[11]));fs.writeFileSync(process.argv[2],'escaped')",
        insideFile,
        escapedFile,
        outsideSource,
        hardlink,
        authFile,
        copiedCredential,
        stateSecret,
        copiedState,
        relocatedAuth,
        copiedRelocatedAuth,
        parentContextSnapshot,
        copiedSnapshot,
        siblingState,
        copiedSiblingState,
        defaultCredential,
        copiedDefaultCredential,
        siblingWorkspaceSecret,
        copiedSiblingWorkspaceSecret
      ],
      env: {
        ...process.env,
        HOME: fakeHome,
        PI_CODING_AGENT_DIR: "~/relocated-agent",
        PI_WORKER_STATE_ROOT: workerStateRoot,
        PI_WORKER_PARENT_CONTEXT_SNAPSHOT: parentContextSnapshot,
        PI_WORKER_RESULT_FILE: "/trusted/result.json"
      },
      workspaceRoot
    });
    const child = spawnAsyncJobProcess({
      executable: prepared.executable,
      args: prepared.args,
      cwd: workspaceRoot,
      env: prepared.env,
      stdoutLog: path.join(workspaceRoot, "stdout.log"),
      stderrLog: path.join(workspaceRoot, "stderr.log")
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    assert.notEqual(result.code, 0);
    assert.equal(await readFile(insideFile, "utf8"), "inside");
    assert.equal(existsSync(path.join(outsideRoot, "escaped.txt")), false);
    assert.equal(await readFile(outsideSource, "utf8"), "original");
    assert.equal(existsSync(hardlink), false);
    assert.equal(existsSync(copiedCredential), false);
    assert.equal(existsSync(copiedState), false);
    assert.equal(existsSync(copiedRelocatedAuth), false);
    assert.equal(existsSync(copiedSiblingState), false);
    assert.equal(existsSync(copiedDefaultCredential), false);
    assert.equal(existsSync(copiedSiblingWorkspaceSecret), false);
    assert.equal(await readFile(copiedSnapshot, "utf8"), "parent-context");
    assert.match(await readFile(path.join(workspaceRoot, "stderr.log"), "utf8"), /Operation not permitted|operation not permitted|EPERM/);

    const dotfileProbe = path.join(workspaceRoot, "dotfile-clean.txt");
    const cleanShell = prepareWorkspaceSandboxProcess({
      executable: "/bin/zsh",
      args: ["-f", "-c", `test -z "$WORKER_DOTFILE_SECRET" && printf clean > ${JSON.stringify(dotfileProbe)} 2>/dev/null`],
      env: { ...process.env, HOME: fakeHome },
      workspaceRoot
    });
    const shell = spawnAsyncJobProcess({
      executable: cleanShell.executable,
      args: cleanShell.args,
      cwd: workspaceRoot,
      env: cleanShell.env,
      stdoutLog: path.join(workspaceRoot, "shell-stdout.log"),
      stderrLog: path.join(workspaceRoot, "shell-stderr.log")
    });
    const shellCode = await new Promise<number | null>((resolve, reject) => {
      shell.once("error", reject);
      shell.once("close", (code) => resolve(code));
    });
    assert.equal(shellCode, 0, await readFile(path.join(workspaceRoot, "shell-stderr.log"), "utf8"));
    assert.equal(await readFile(dotfileProbe, "utf8"), "clean");

    const copiedLaunchctl = path.join(workspaceRoot, "copied-launchctl");
    await copyFile("/bin/launchctl", copiedLaunchctl);
    await chmod(copiedLaunchctl, 0o700);
    for (const deniedCommand of [
      "/bin/launchctl help",
      "/usr/bin/open -Ra Finder",
      `${JSON.stringify(copiedLaunchctl)} print gui/${process.getuid?.() ?? 0}`
    ]) {
      const denied = prepareWorkspaceSandboxProcess({
        executable: "/bin/zsh",
        args: ["-f", "-c", deniedCommand],
        env: { ...process.env, HOME: fakeHome },
        workspaceRoot
      });
      const deniedProcess = spawnAsyncJobProcess({
        executable: denied.executable,
        args: denied.args,
        cwd: workspaceRoot,
        env: denied.env,
        stdoutLog: path.join(workspaceRoot, "denied-stdout.log"),
        stderrLog: path.join(workspaceRoot, "denied-stderr.log")
      });
      const deniedCode = await new Promise<number | null>((resolve, reject) => {
        deniedProcess.once("error", reject);
        deniedProcess.once("close", (code) => resolve(code));
      });
      assert.notEqual(deniedCode, 0, `${deniedCommand} unexpectedly executed inside the worker sandbox`);
    }

    const cacheState = path.join(workspaceRoot, "cache", "state");
    await rm(cacheState, { recursive: true, force: true });
    await symlink(outsideRoot, cacheState);
    assert.throws(() => prepareWorkspaceSandboxProcess({
      executable: "/bin/zsh",
      args: ["-f", "-c", "true"],
      env: { ...process.env, HOME: fakeHome },
      workspaceRoot
    }), /not a directory|escapes the workspace/);
  });
});
