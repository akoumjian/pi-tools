import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import asyncShellExtension, { buildAsyncShellStatusText } from "../extensions/async-shell/index.js";

type SentMessage = {
  message: unknown;
  options: unknown;
};

type FakeApi = ExtensionAPI & {
  registeredTools: ToolDefinition[];
  sentMessages: SentMessage[];
  commands: Map<string, { description: string; handler: Function }>;
};

function createContext(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

function createFakeApi(): FakeApi {
  const registeredTools: ToolDefinition[] = [];
  const sentMessages: SentMessage[] = [];
  const commands = new Map<string, { description: string; handler: Function }>();
  const fake = {
    registeredTools,
    sentMessages,
    commands,
    registerCommand(name: string, command: { description: string; handler: Function }): void {
      commands.set(name, command);
    },
    registerMessageRenderer(): void {},
    registerTool(tool: ToolDefinition): void {
      registeredTools.push(tool);
    },
    sendMessage(message: unknown, options: unknown): void {
      sentMessages.push({ message, options });
    }
  };
  return fake as unknown as FakeApi;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-async-shell-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function required<T>(value: T | undefined, name: string): T {
  assert.notEqual(value, undefined, name);
  if (value === undefined) {
    throw new Error(name);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJobMeta(contextDir: string, jobId: string, meta: Record<string, unknown>): Promise<void> {
  const logDir = path.join(contextDir, ".pi", "async-shell", "jobs", jobId);
  await mkdir(logDir, { recursive: true });
  await writeFile(path.join(logDir, "meta.json"), `${JSON.stringify({
    jobId,
    command: "printf legacy",
    cwd: contextDir,
    shell: "/bin/zsh",
    status: "exited",
    startedAt: new Date().toISOString(),
    notifyOnExit: false,
    completionNotified: true,
    logDir,
    stdoutLog: path.join(logDir, "stdout.log"),
    stderrLog: path.join(logDir, "stderr.log"),
    outputBytes: { stdout: 0, stderr: 0 },
    ...meta
  }, null, 2)}\n`);
}

test("async-shell-status reports job root and recent jobs", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);

    assert.ok(api.commands.has("async:status"));
    assert.equal(api.commands.has("async-shell-status"), false, "deprecated kebab alias removed");
    const text = buildAsyncShellStatusText(createContext(dir));
    assert.match(text, /Async shell status/);
    assert.match(text, /Job root:/);
    assert.match(text, /Recent jobs: 0/);
  });
});

test("shell_status lists recent jobs when jobId is omitted", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
    assert.equal(api.registeredTools.some((tool) => tool.name === "shell_list"), false);
    assert.ok(shellStart.execute);
    assert.ok(shellStatus.execute);

    await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "printf listed", cwd: dir, notifyOnExit: false }],
        tailLines: 1
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const result = await shellStatus.execute(
      "tool-call-id",
      { limit: 5 } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { jobs: Array<{ command: string; status: string }> };
    assert.equal(details.jobs.length, 1);
    assert.equal(details.jobs[0].command, "printf listed");
    assert.equal(details.jobs[0].status, "exited");
    assert.match(JSON.stringify(result.content), /printf listed/);
  });
});

test("shell_status maps legacy label metadata to job_name", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
    assert.ok(shellStatus.execute);
    const jobId = "job_20260512143000_legacy1";
    await writeJobMeta(dir, jobId, { label: "legacy-name" });

    const result = await shellStatus.execute(
      "tool-call-id",
      { jobId } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { job: { job_name?: string } };
    assert.equal(details.job.job_name, "legacy-name");
  });
});

test("shell_status marks stranded running job metadata as unknown", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
    assert.ok(shellStatus.execute);
    const jobId = "job_20260512143000_stranded";
    await writeJobMeta(dir, jobId, { status: "running", pid: 2147483647, completionNotified: false });

    const result = await shellStatus.execute(
      "tool-call-id",
      { jobId } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { job: { status: string; error?: string } };
    assert.equal(details.job.status, "unknown");
    assert.match(details.job.error ?? "", /previous Pi process/);
  });
});

test("shell_start suppresses deferred follow-ups when jobs complete in-band", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);

    const result = await shellStart.execute(
      "tool-call-id",
      {
        commands: [
          { command: "printf one", cwd: dir },
          { command: "printf two", cwd: dir },
          { command: "printf three", cwd: dir }
        ],
        tailLines: 1
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { jobs: Array<{ job: { status: string; exitCode?: number | null } }> };
    assert.deepEqual(details.jobs.map(({ job }) => [job.status, job.exitCode]), [
      ["exited", 0],
      ["exited", 0],
      ["exited", 0]
    ]);

    await delay(50);
    assert.equal(api.sentMessages.length, 0);
  });
});

test("shell_start sends one deferred follow-up per notified completed job", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);

    const startResult = await shellStart.execute(
      "tool-call-id",
      {
        commands: [
          { command: "sleep 7; printf one", cwd: dir, job_name: "one" },
          { command: "sleep 7; printf ignored", cwd: dir, job_name: "ignored", notifyOnExit: false },
          { command: "sleep 7; printf three", cwd: dir, job_name: "three" }
        ],
        tailLines: 1
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const startText = JSON.stringify(startResult.content);
    assert.doesNotMatch(startText, /Started async shell/);
    assert.doesNotMatch(startText, /logs:/);
    assert.doesNotMatch(startText, /stderr:/);
    assert.match(startText, /more: shell_tail jobId=/);

    await delay(1200);

    assert.equal(api.sentMessages.length, 2);
    for (const sentMessage of api.sentMessages) {
      assert.deepEqual(sentMessage.options, { deliverAs: "steer" });
      assert.doesNotMatch(JSON.stringify(sentMessage.message), /Job completed\./);
      assert.doesNotMatch(JSON.stringify(sentMessage.message), /async-shell notification/);

      const message = sentMessage.message as { content?: unknown };
      assert.equal(typeof message.content, "string");
      const content = message.content as string;
      assert.match(content, /^async shell result: /);
      assert.match(content, /more: shell_tail jobId=/);
      assert.doesNotMatch(content, /job_id:|stdout:|stderr:|```|logs:/);
    }

    const notifiedNames = api.sentMessages
      .map((sentMessage) => {
        const message = sentMessage.message as { details?: { job?: { job_name?: string } } };
        return message.details?.job?.job_name;
      })
      .sort();
    assert.deepEqual(notifiedNames, ["one", "three"]);
    assert.doesNotMatch(JSON.stringify(api.sentMessages.map((sentMessage) => sentMessage.message)), /ignored/);
  });
});

test("per-command notifyOnExit false suppresses deferred follow-up", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);

    await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "sleep 7; printf ignored", cwd: dir, notifyOnExit: false }],
        tailLines: 1
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    await delay(1200);

    assert.equal(api.sentMessages.length, 0);
  });
});

test("shell_start reports spawn errors for missing shells", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);

    const result = await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "printf never", cwd: dir, shell: "/no/such/shell", notifyOnExit: false }],
        tailLines: 1
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { jobs: Array<{ job: { status: string; error?: string } }> };
    assert.equal(details.jobs[0].job.status, "failed");
    assert.match(details.jobs[0].job.error ?? "", /ENOENT|no such/i);
  });
});

test("shell_start expands home in per-command cwd", async () => {
  await withTempDir(async (dir) => {
    const previousHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      const api = createFakeApi();
      asyncShellExtension(api);
      const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
      assert.ok(shellStart.execute);

      const result = await shellStart.execute(
        "tool-call-id",
        {
          commands: [{ command: "pwd", cwd: "~", notifyOnExit: false }],
          tailLines: 1
        } as never,
        new AbortController().signal,
        undefined,
        createContext(path.join(dir, "project"))
      );

      const details = result.details as { jobs: Array<{ job: { cwd: string }; output: { stdout: string } }> };
      assert.equal(details.jobs[0].job.cwd, dir);
      assert.equal(path.basename(details.jobs[0].output.stdout), path.basename(dir));
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });
});

test("shell_start preserves raw output bytes", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);

    const result = await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "node -e 'process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 50)'", cwd: dir, notifyOnExit: false }],
        tailLines: 1
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { jobs: Array<{ job: { stdoutLog: string; outputBytes: { stdout: number } }; output: { stdout: string } }> };
    assert.equal(details.jobs[0].job.outputBytes.stdout, 2);
    assert.equal((await stat(details.jobs[0].job.stdoutLog)).size, 2);
    assert.deepEqual([...(await readFile(details.jobs[0].job.stdoutLog))], [0xc3, 0xa9]);
    assert.equal(details.jobs[0].output.stdout, "é");
  });
});

test("shell_tail reads stdout and stderr separately", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellTail = required(api.registeredTools.find((tool) => tool.name === "shell_tail"), "shell_tail tool");
    assert.ok(shellStart.execute);
    assert.ok(shellTail.execute);

    const started = await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "printf out; printf err >&2", cwd: dir, notifyOnExit: false }],
        tailLines: 1
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );
    const jobId = (started.details as { jobs: Array<{ job: { jobId: string } }> }).jobs[0].job.jobId;

    const stdoutOnly = await shellTail.execute("tool-call-id", { jobId, stream: "stdout" } as never, new AbortController().signal, undefined, createContext(dir));
    const stderrOnly = await shellTail.execute("tool-call-id", { jobId, stream: "stderr" } as never, new AbortController().signal, undefined, createContext(dir));
    const both = await shellTail.execute("tool-call-id", { jobId } as never, new AbortController().signal, undefined, createContext(dir));

    assert.deepEqual((stdoutOnly.details as { output: { stdout: string; stderr: string } }).output, { stdout: "out", stderr: "" });
    assert.deepEqual((stderrOnly.details as { output: { stdout: string; stderr: string } }).output, { stdout: "", stderr: "err" });
    assert.deepEqual((both.details as { output: { stdout: string; stderr: string } }).output, { stdout: "out", stderr: "err" });
    assert.doesNotMatch(JSON.stringify(stderrOnly.content), /stdout:/);
  });
});

test("shell_cancel transitions a running job to cancelled and suppresses follow-up", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellCancel = required(api.registeredTools.find((tool) => tool.name === "shell_cancel"), "shell_cancel tool");
    const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
    assert.ok(shellStart.execute);
    assert.ok(shellCancel.execute);
    assert.ok(shellStatus.execute);

    const started = await shellStart.execute(
      "tool-call-id",
      { commands: [{ command: "sleep 30", cwd: dir }], tailLines: 1 } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );
    const jobId = (started.details as { jobs: Array<{ job: { jobId: string } }> }).jobs[0].job.jobId;

    const cancelled = await shellCancel.execute("tool-call-id", { jobId, signal: "SIGTERM" } as never, new AbortController().signal, undefined, createContext(dir));
    assert.equal((cancelled.details as { job: { notifyOnExit: boolean } }).job.notifyOnExit, false);
    await delay(500);

    const status = await shellStatus.execute("tool-call-id", { jobId } as never, new AbortController().signal, undefined, createContext(dir));
    const job = (status.details as { job: { status: string; notifyOnExit: boolean; signal?: string | null } }).job;
    assert.equal(job.status, "cancelled");
    assert.equal(job.notifyOnExit, false);
    assert.equal(job.signal, "SIGTERM");
    await delay(50);
    assert.equal(api.sentMessages.length, 0);
  });
});

test("async-shell does not register a polling wait tool", () => {
  const api = createFakeApi();
  asyncShellExtension(api);

  assert.equal(api.registeredTools.some((tool) => tool.name === "shell_wait"), false);
});
