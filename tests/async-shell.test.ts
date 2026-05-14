import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import asyncShellExtension, { buildAsyncShellStatusText } from "../extensions/async-shell/index.js";

type SentMessage = {
  message: unknown;
  options: unknown;
};

type FakeApi = ExtensionAPI & {
  registeredTools: ToolDefinition[];
  sentMessages: SentMessage[];
  commands: Map<string, { description: string; handler: Function }>;
  handlers: Map<string, Function[]>;
  emit(event: string, data: unknown, context: ExtensionContext): Promise<void>;
};

function createContext(cwd: string, isIdle: boolean | (() => boolean) = true): ExtensionContext {
  return {
    cwd,
    isIdle: typeof isIdle === "function" ? isIdle : () => isIdle,
    hasPendingMessages: () => false
  } as ExtensionContext;
}

function createFakeApi(): FakeApi {
  const registeredTools: ToolDefinition[] = [];
  const sentMessages: SentMessage[] = [];
  const commands = new Map<string, { description: string; handler: Function }>();
  const handlers = new Map<string, Function[]>();
  const fake = {
    registeredTools,
    sentMessages,
    commands,
    handlers,
    registerCommand(name: string, command: { description: string; handler: Function }): void {
      commands.set(name, command);
    },
    registerMessageRenderer(): void {},
    registerTool(tool: ToolDefinition): void {
      registeredTools.push(tool);
    },
    on(event: string, handler: Function): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async emit(event: string, data: unknown, context: ExtensionContext): Promise<void> {
      for (const handler of handlers.get(event) ?? []) {
        await handler(data, context);
      }
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
        commands: [{ command: "printf listed", cwd: dir, notifyOnExit: false }]
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

test("shell_start suppresses deferred completion notices when jobs complete in-band", async () => {
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
        ]
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { jobs: Array<{ status: string; exitCode?: number | null }> };
    assert.deepEqual(details.jobs.map((job) => [job.status, job.exitCode]), [
      ["exited", 0],
      ["exited", 0],
      ["exited", 0]
    ]);

    await delay(50);
    assert.equal(api.sentMessages.length, 0);
  });
});

test("shell_start sends one deferred completion batch for notified completed jobs", async () => {
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
        ]
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const startText = JSON.stringify(startResult.content);
    assert.doesNotMatch(startText, /Started async shell/);
    assert.doesNotMatch(startText, /logs:/);
    assert.doesNotMatch(startText, /stdout:\\n|stderr:\\n|```/);
    assert.match(startText, /stdout_log:/);
    assert.match(startText, /stderr_log:/);
    assert.match(startText, /output_bytes:/);
    assert.match(startText, /recent_output: shell_read jobId=.*mode=tail/);
    assert.match(startText, /range_output: shell_read jobId=.*mode=range/);

    await delay(1200);

    assert.equal(api.sentMessages.length, 1);
    const sentMessage = api.sentMessages[0];
    assert.deepEqual(sentMessage.options, { triggerTurn: true, deliverAs: "steer" });
    assert.doesNotMatch(JSON.stringify(sentMessage.message), /Job completed\./);
    assert.doesNotMatch(JSON.stringify(sentMessage.message), /async-shell notification/);

    const message = sentMessage.message as { content?: unknown; details?: { jobs?: Array<{ job_name?: string }> } };
    assert.equal(typeof message.content, "string");
    const content = message.content as string;
    assert.match(content, /^async shell results: 2 jobs completed/);
    assert.match(content, /stdout_log:/);
    assert.match(content, /stderr_log:/);
    assert.match(content, /recent_output: shell_read jobId=.*mode=tail.*max 500 lines/);
    assert.match(content, /range_output: shell_read jobId=.*mode=range/);
    assert.match(content, /targeted_output: use search_many on stdout_log\/stderr_log/);
    assert.doesNotMatch(content, /job_id:|stdout:|stderr:|```|logs:/);

    const notifiedNames = (message.details?.jobs ?? [])
      .map((job) => job.job_name)
      .sort();
    assert.deepEqual(notifiedNames, ["one", "three"]);
    assert.doesNotMatch(JSON.stringify(sentMessage.message), /ignored/);
  });
});

test("shell_start queues active completions until the current turn can flush one batch", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);
    let idle = false;
    const context = createContext(dir, () => idle);

    await shellStart.execute(
      "tool-call-id",
      {
        commands: [
          { command: "sleep 7; printf one", cwd: dir, job_name: "one" },
          { command: "sleep 7; printf two", cwd: dir, job_name: "two" }
        ]
      } as never,
      new AbortController().signal,
      undefined,
      context
    );

    await delay(1200);
    assert.equal(api.sentMessages.length, 0);

    await api.emit("turn_end", { type: "turn_end", turnIndex: 0, timestamp: Date.now(), message: {}, toolResults: [] }, context);
    assert.equal(api.sentMessages.length, 1);
    assert.deepEqual(api.sentMessages[0].options, { triggerTurn: true, deliverAs: "steer" });
    const message = api.sentMessages[0].message as { content?: string; details?: { jobs?: Array<{ job_name?: string }> } };
    assert.match(message.content ?? "", /^async shell results: 2 jobs completed/);
    assert.deepEqual((message.details?.jobs ?? []).map((job) => job.job_name).sort(), ["one", "two"]);

    idle = true;
    await delay(50);
    assert.equal(api.sentMessages.length, 1);
  });
});

test("per-command notifyOnExit false suppresses deferred completion notices", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);

    await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "sleep 7; printf ignored", cwd: dir, notifyOnExit: false }]
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
        commands: [{ command: "printf never", cwd: dir, shell: "/no/such/shell", notifyOnExit: false }]
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { jobs: Array<{ status: string; error?: string }> };
    assert.equal(details.jobs[0].status, "failed");
    assert.match(details.jobs[0].error ?? "", /ENOENT|no such/i);
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
          commands: [{ command: "pwd", cwd: "~", notifyOnExit: false }]
        } as never,
        new AbortController().signal,
        undefined,
        createContext(path.join(dir, "project"))
      );

      const details = result.details as { jobs: Array<{ cwd: string; stdoutLog: string }> };
      assert.equal(details.jobs[0].cwd, dir);
      assert.equal(path.basename((await readFile(details.jobs[0].stdoutLog, "utf8")).trim()), path.basename(dir));
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
        commands: [{ command: "node -e 'process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 50)'", cwd: dir, notifyOnExit: false }]
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { jobs: Array<{ stdoutLog: string; outputBytes: { stdout: number } }> };
    assert.equal(details.jobs[0].outputBytes.stdout, 2);
    assert.equal((await stat(details.jobs[0].stdoutLog)).size, 2);
    assert.deepEqual([...(await readFile(details.jobs[0].stdoutLog))], [0xc3, 0xa9]);
    assert.equal(await readFile(details.jobs[0].stdoutLog, "utf8"), "é");
  });
});

test("shell_read tail mode reads stdout and stderr separately", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellRead = required(api.registeredTools.find((tool) => tool.name === "shell_read"), "shell_read tool");
    assert.ok(shellStart.execute);
    assert.ok(shellRead.execute);
    assert.equal(api.registeredTools.some((tool) => tool.name === "shell_tail"), false);

    const started = await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "printf out; printf err >&2", cwd: dir, notifyOnExit: false }]
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );
    const jobId = (started.details as { jobs: Array<{ jobId: string }> }).jobs[0].jobId;

    const stdoutOnly = await shellRead.execute("tool-call-id", { jobId, mode: "tail", stream: "stdout" } as never, new AbortController().signal, undefined, createContext(dir));
    const stderrOnly = await shellRead.execute("tool-call-id", { jobId, mode: "tail", stream: "stderr" } as never, new AbortController().signal, undefined, createContext(dir));
    const both = await shellRead.execute("tool-call-id", { jobId } as never, new AbortController().signal, undefined, createContext(dir));

    const stdoutDetails = stdoutOnly.details as { streams: Array<{ stream: string; mode: string; requestedLines?: number; previewLines: string[] }> };
    const stderrDetails = stderrOnly.details as { streams: Array<{ stream: string; mode: string; requestedLines?: number; previewLines: string[] }> };
    const bothDetails = both.details as { streams: Array<{ stream: string; mode: string; previewLines: string[] }> };
    assert.deepEqual(stdoutDetails.streams, [{ stream: "stdout", mode: "tail", logPath: path.join(dir, ".pi", "async-shell", "jobs", jobId, "stdout.log"), requestedLines: 80, requestedMaxChars: 20000, previewLines: ["out"] }]);
    assert.deepEqual(stderrDetails.streams, [{ stream: "stderr", mode: "tail", logPath: path.join(dir, ".pi", "async-shell", "jobs", jobId, "stderr.log"), requestedLines: 80, requestedMaxChars: 20000, previewLines: ["err"] }]);
    assert.deepEqual(bothDetails.streams.map((stream) => [stream.stream, stream.mode, stream.previewLines[0]]), [["stdout", "tail", "out"], ["stderr", "tail", "err"]]);
    const stdoutText = JSON.stringify(stdoutOnly.content);
    const stderrText = JSON.stringify(stderrOnly.content);
    assert.match(stdoutText, /--- stdout tail .*last up to 80 lines, 20 KB max\) ---\\nout/);
    assert.doesNotMatch(stdoutText, /stderr tail/);
    assert.match(stderrText, /--- stderr tail .*last up to 80 lines, 20 KB max\) ---\\nerr/);
    assert.doesNotMatch(stderrText, /stdout tail/);
  });
});

test("shell_read reads stdout and stderr ranges by jobId with offset and limit", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellRead = required(api.registeredTools.find((tool) => tool.name === "shell_read"), "shell_read tool");
    assert.ok(shellStart.execute);
    assert.ok(shellRead.execute);

    const started = await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "printf 'out1\\nout2\\nout3\\n'; printf 'err1\\nerr2\\n' >&2", cwd: dir, notifyOnExit: false }]
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );
    const jobId = (started.details as { jobs: Array<{ jobId: string }> }).jobs[0].jobId;

    const stdoutRange = await shellRead.execute(
      "tool-call-id",
      { jobId, stream: "stdout", offset: 2, limit: 1 } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );
    const bothRanges = await shellRead.execute(
      "tool-call-id",
      { jobId, offset: 1, limit: 1 } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const stdoutDetails = stdoutRange.details as { streams: Array<{ stream: string; mode: string; offset: number; requestedLimit?: number; truncation: { nextOffset?: number; totalLines: number; outputLines: number }; previewLines: string[] }> };
    assert.deepEqual(stdoutDetails.streams.map((stream) => stream.stream), ["stdout"]);
    assert.equal(stdoutDetails.streams[0].offset, 2);
    assert.equal(stdoutDetails.streams[0].requestedLimit, 1);
    assert.equal(stdoutDetails.streams[0].truncation.nextOffset, 3);
    assert.deepEqual(stdoutDetails.streams[0].previewLines, ["out2"]);
    assert.equal(stdoutDetails.streams[0].mode, "range");
    assert.match(JSON.stringify(stdoutRange.content), /--- stdout range .*lines 2-2 of 4\) ---\\nout2/);
    assert.match(JSON.stringify(stdoutRange.content), /continue with mode=range offset=3/);

    const bothDetails = bothRanges.details as { streams: Array<{ stream: string; truncation: { nextOffset?: number } }> };
    assert.deepEqual(bothDetails.streams.map((stream) => stream.stream), ["stdout", "stderr"]);
    assert.deepEqual(bothDetails.streams.map((stream) => stream.truncation.nextOffset), [2, 2]);
  });
});

test("shell_cancel transitions a running job to cancelled and suppresses completion notices", async () => {
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
      { commands: [{ command: "sleep 30", cwd: dir }] } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );
    const jobId = (started.details as { jobs: Array<{ jobId: string }> }).jobs[0].jobId;

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
