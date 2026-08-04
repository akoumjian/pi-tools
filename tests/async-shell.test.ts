import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import asyncShellExtension, {
  buildAsyncShellStatusText,
  buildAsyncShellViewerFrame,
  buildAsyncShellViewerUsage,
  createAsyncShellViewerComponent,
  loadAsyncShellViewerSnapshot,
  parseAsyncShellViewerArgs,
  sanitizeAsyncShellViewerText,
  type AsyncShellViewerSnapshot
} from "../extensions/async-shell/index.js";

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
    sessionManager: {
      getSessionId: () => `test-session:${cwd}`
    },
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

const plainTheme = {
  fg(_color: string, text: string): string {
    return text;
  },
  bold(text: string): string {
    return text;
  }
} as unknown as Theme;

function viewerSnapshot(overrides: Partial<AsyncShellViewerSnapshot> = {}): AsyncShellViewerSnapshot {
  const jobId = "job_20260803170000_viewtest";
  const logDir = "/tmp/viewer/.pi/async-shell/jobs/job_20260803170000_viewtest";
  return {
    job: {
      jobId,
      job_name: "viewer-test",
      command: "printf output",
      cwd: "/tmp/viewer",
      shell: "/bin/zsh",
      status: "running",
      startedAt: "2026-08-03T21:00:00.000Z",
      notifyOnExit: true,
      completionNotified: false,
      logDir,
      stdoutLog: path.join(logDir, "stdout.log"),
      stderrLog: path.join(logDir, "stderr.log"),
      outputBytes: { stdout: 12, stderr: 0 }
    },
    projectRoot: "/tmp/viewer/.pi/async-shell",
    streams: [],
    outputLines: ["--- stdout ---", "one", "two"],
    refreshedAt: "2026-08-03T21:00:01.000Z",
    ...overrides
  };
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

test("async-shell tools expose complete system-prompt contracts", () => {
  const api = createFakeApi();
  asyncShellExtension(api);

  for (const name of ["shell_start", "shell_status", "shell_read", "shell_cancel"]) {
    const tool = required(api.registeredTools.find((candidate) => candidate.name === name), `${name} tool`);
    assert.ok(tool.description.length > 100, `${name} keeps a detailed provider description`);
    assert.ok((tool.promptSnippet ?? "").length > 40, `${name} has an Available tools snippet`);
    assert.deepEqual(tool.promptGuidelines?.map((line) => line.split(":", 1)[0]), [
      `${name} use`,
      `${name} input`,
      `${name} output`,
      `${name} constraints`
    ]);
    assert.ok((tool.parameters as { additionalProperties?: boolean }).additionalProperties === false);
  }
});

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

test("async-shell viewer registers a user-only command and rejects headless mode", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);

    const command = required(api.commands.get("async:view"), "async:view command");
    assert.match(command.description, /read-only TUI/);
    const notifications: Array<{ message: string; type?: string }> = [];
    let customCalls = 0;
    const context = {
      ...createContext(dir),
      mode: "print",
      hasUI: false,
      ui: {
        notify(message: string, type?: string): void {
          notifications.push({ message, type });
        },
        async custom(): Promise<void> {
          customCalls += 1;
        }
      }
    } as unknown as ExtensionCommandContext;

    await command.handler("", context);

    assert.equal(customCalls, 0);
    assert.deepEqual(notifications, [{ message: "/async:view requires interactive Pi TUI mode.", type: "warning" }]);

    await command.handler("", { ...context, mode: "rpc", hasUI: true } as unknown as ExtensionCommandContext);
    assert.equal(customCalls, 0);
    assert.deepEqual(notifications[1], { message: "/async:view requires interactive Pi TUI mode.", type: "warning" });
    assert.equal(api.sentMessages.length, 0, "viewer never injects a message or triggers an assistant turn");
  });
});

test("async-shell viewer opens an explicit historical job without mutating its log", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const jobId = "job_20260803165900_explicit";
    await writeJobMeta(dir, jobId, { status: "exited", exitCode: 0 });
    const stdoutLog = path.join(dir, ".pi", "async-shell", "jobs", jobId, "stdout.log");
    await writeFile(stdoutLog, "viewer output\n", "utf8");
    let rendered = "";
    let customCalls = 0;
    const tui = {
      terminal: { rows: 20 },
      requestRender(): void {}
    } as unknown as TUI;
    const context = {
      ...createContext(dir),
      mode: "tui",
      hasUI: true,
      ui: {
        theme: plainTheme,
        notify(): void {},
        async custom<T>(factory: Function): Promise<T> {
          customCalls += 1;
          return await new Promise<T>((resolve) => {
            const component = factory(tui, plainTheme, {}, resolve) as { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void };
            rendered = component.render(80).join("\n");
            component.handleInput?.("q");
            component.dispose?.();
          });
        }
      }
    } as unknown as ExtensionCommandContext;

    await required(api.commands.get("async:view"), "async:view command").handler(`${jobId} --stream stdout`, context);

    assert.equal(customCalls, 1);
    assert.match(rendered, /viewer output/);
    assert.equal(await readFile(stdoutLog, "utf8"), "viewer output\n");
    assert.equal(api.sentMessages.length, 0);
  });
});

test("async-shell viewer arguments are explicit and bounded", () => {
  assert.deepEqual(parseAsyncShellViewerArgs(""), {
    help: false,
    stream: "both",
    tailLines: 500,
    follow: false
  });
  assert.deepEqual(parseAsyncShellViewerArgs("job_123 --stream stderr --tail 42 --follow"), {
    help: false,
    jobId: "job_123",
    stream: "stderr",
    tailLines: 42,
    follow: true
  });
  assert.equal(parseAsyncShellViewerArgs("--help").help, true);
  assert.match(buildAsyncShellViewerUsage(), /Esc\/q closes without stopping the job/);
  assert.throws(() => parseAsyncShellViewerArgs("--stream merged"), /both, stdout, stderr/);
  assert.throws(() => parseAsyncShellViewerArgs("--tail 501"), /integer from 1 to 500/);
  assert.throws(() => parseAsyncShellViewerArgs("one two"), /at most one job id/);
  assert.throws(() => parseAsyncShellViewerArgs("--unknown"), /Unknown option/);
});

test("async-shell viewer reads bounded canonical historical logs and sanitizes terminal controls", async () => {
  await withTempDir(async (dir) => {
    const jobId = "job_20260803170100_history";
    await writeJobMeta(dir, jobId, {
      status: "cancelled",
      signal: "SIGTERM",
      cwd: path.join(dir, "child-project")
    });
    const logDir = path.join(dir, ".pi", "async-shell", "jobs", jobId);
    await writeFile(path.join(logDir, "stdout.log"), "first\nsecond\nthird\n", "utf8");
    await writeFile(path.join(logDir, "stderr.log"), "\u001b]0;owned\u0007warn\u001b[31m red\u001b[0m\u0000\n", "utf8");

    const snapshot = loadAsyncShellViewerSnapshot(createContext(dir), jobId, "both", 2);

    assert.equal(snapshot.job.status, "cancelled");
    assert.equal(snapshot.job.cwd, path.join(dir, "child-project"));
    assert.equal(snapshot.projectRoot, path.join(dir, ".pi", "async-shell"));
    assert.deepEqual(snapshot.streams.map((stream) => [stream.stream, stream.exists]), [["stdout", true], ["stderr", true]]);
    assert.equal(snapshot.streams[0].content, "second\nthird");
    assert.equal(snapshot.streams[1].content, "warn red�");
    assert.doesNotMatch(snapshot.outputLines.join("\n"), /\u001b|owned/);
    assert.equal(sanitizeAsyncShellViewerText("a\tb\rrewind\u0000"), "a    b�rewind�");

    const detachedId = "job_20260803170200_detached";
    await writeJobMeta(dir, detachedId, { status: "running", pid: 2_147_483_647 });
    const detached = loadAsyncShellViewerSnapshot(createContext(dir), detachedId, "stdout", 20);
    assert.equal(detached.job.status, "unknown");
    assert.match(detached.job.error ?? "", /previous Pi process/);
    assert.match(detached.outputLines.join("\n"), /log file has not been created/);
    assert.match(buildAsyncShellViewerFrame(plainTheme, {
      snapshot: detached,
      stream: "stdout",
      tailLines: 20,
      following: false,
      topLine: 0,
      pinnedToEnd: true
    }, 100, 20).lines.join("\n"), /job note: Job was running in a previous Pi process/);
    assert.throws(() => loadAsyncShellViewerSnapshot(createContext(dir), "job_missing", "both", 20), /Unknown async shell job/);
  });
});

test("async-shell viewer frame is viewport-bounded and keeps streams separate", () => {
  const snapshot = viewerSnapshot({
    job: { ...viewerSnapshot().job, status: "failed", exitCode: 7, durationMs: 2000 },
    outputLines: ["--- stdout ---", ...Array.from({ length: 20 }, (_, index) => `line-${index + 1}`), "", "--- stderr ---", "failure"]
  });
  const frame = buildAsyncShellViewerFrame(plainTheme, {
    snapshot,
    stream: "both",
    tailLines: 500,
    following: false,
    topLine: 0,
    pinnedToEnd: true
  }, 72, 16);
  const rendered = frame.lines.join("\n");

  assert.equal(frame.lines.length, 16);
  assert.equal(frame.topLine, snapshot.outputLines.length - frame.pageSize);
  assert.match(rendered, /failed · 2\.0s · exit 7/);
  assert.match(rendered, /stdout\/stderr are grouped/);
  assert.ok(frame.lines.every((line) => visibleWidth(line) <= 72));
});

test("async-shell viewer follow refreshes and dispose stops refresh without touching jobs", async () => {
  let loadCount = 0;
  let renderCount = 0;
  let doneCount = 0;
  let resolveFirstRefresh: (() => void) | undefined;
  const firstRefresh = new Promise<void>((resolve) => {
    resolveFirstRefresh = resolve;
  });
  const tui = {
    terminal: { rows: 20 },
    requestRender(): void {
      renderCount += 1;
    }
  } as unknown as TUI;
  const component = createAsyncShellViewerComponent({
    tui,
    getTheme: () => plainTheme,
    initialSnapshot: viewerSnapshot(),
    initialStream: "both",
    tailLines: 500,
    follow: false,
    loadSnapshot: () => {
      loadCount += 1;
      resolveFirstRefresh?.();
      return viewerSnapshot({ outputLines: ["--- stdout ---", `refresh-${loadCount}`] });
    },
    done: () => {
      doneCount += 1;
    },
    followIntervalMs: 5
  });

  component.render(80);
  component.handleInput?.("f");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("viewer follow did not refresh within 500 ms")), 500);
    void firstRefresh.then(() => {
      clearTimeout(timeout);
      resolve();
    }, reject);
  });
  assert.ok(loadCount >= 1);
  assert.ok(renderCount >= 1);
  component.dispose();
  const countAfterDispose = loadCount;
  await delay(20);
  assert.equal(loadCount, countAfterDispose, "dispose clears the follow timer");
  assert.equal(doneCount, 0);

  component.handleInput?.("q");
  assert.equal(doneCount, 1, "closing the viewer only resolves its UI");
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

test("async-shell active jobs remain scoped to their project registry", async () => {
  await withTempDir(async (dir) => {
    const projectA = path.join(dir, "project-a");
    const projectB = path.join(dir, "project-b");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
    assert.ok(shellStart.execute);
    assert.ok(shellStatus.execute);

    const started = await shellStart.execute(
      "tool-call-id",
      { commands: [{ command: "printf scoped", cwd: projectA, notifyOnExit: false }] } as never,
      new AbortController().signal,
      undefined,
      createContext(projectA)
    );
    const jobId = (started.details as { jobs: Array<{ jobId: string }> }).jobs[0].jobId;
    const foreignList = await shellStatus.execute(
      "tool-call-id",
      { limit: 20 } as never,
      new AbortController().signal,
      undefined,
      createContext(projectB)
    );

    assert.deepEqual((foreignList.details as { jobs: unknown[] }).jobs, []);
    await assert.rejects(
      shellStatus.execute(
        "tool-call-id",
        { jobId } as never,
        new AbortController().signal,
        undefined,
        createContext(projectB)
      ),
      /Unknown async shell job/
    );
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

    await delay(2500);

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

test("shell_start keeps completions queued when its captured context becomes stale", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);
    let stale = false;
    const context = createContext(dir, () => {
      if (stale) {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      }
      return false;
    });

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

    stale = true;
    await delay(2500);
    assert.equal(api.sentMessages.length, 0);

    const replacementContext = createContext(dir);
    await api.emit("turn_end", { type: "turn_end", turnIndex: 0, timestamp: Date.now(), message: {}, toolResults: [] }, replacementContext);
    assert.equal(api.sentMessages.length, 1);
    assert.deepEqual(api.sentMessages[0].options, { triggerTurn: true, deliverAs: "steer" });
    const message = api.sentMessages[0].message as { content?: string; details?: { jobs?: Array<{ job_name?: string }> } };
    assert.match(message.content ?? "", /^async shell results: 2 jobs completed/);
    assert.deepEqual((message.details?.jobs ?? []).map((job) => job.job_name).sort(), ["one", "two"]);

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

    await delay(2500);

    assert.equal(api.sentMessages.length, 0);
  });
});

test("shell_start rejects a pre-aborted call before creating durable job state", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      shellStart.execute!(
        "tool-call-id",
        { commands: [{ command: "printf never", cwd: dir, notifyOnExit: false }] } as never,
        controller.signal,
        undefined,
        createContext(dir)
      ),
      { name: "AbortError" }
    );
    await assert.rejects(stat(path.join(dir, ".pi", "async-shell")), /ENOENT/);
  });
});

test("shell_start interruption ends only the foreground grace wait and preserves the durable job", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 50);

    const started = await shellStart.execute!(
      "tool-call-id",
      { commands: [{ command: "sleep 0.3; printf survived", cwd: dir, notifyOnExit: false }] } as never,
      controller.signal,
      undefined,
      createContext(dir)
    );
    assert.ok(Date.now() - startedAt < 1_000, "foreground grace wait should settle promptly after interruption");
    const startedJob = (started.details as { jobs: Array<{ jobId: string; status: string; stdoutLog: string }> }).jobs[0];
    assert.equal(startedJob.status, "running");

    await delay(500);
    const status = await shellStatus.execute!(
      "tool-call-id",
      { jobId: startedJob.jobId } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );
    assert.equal((status.details as { job: { status: string } }).job.status, "exited");
    assert.equal(await readFile(startedJob.stdoutLog, "utf8"), "survived");
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
