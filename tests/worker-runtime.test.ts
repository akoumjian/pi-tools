import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { cancelAsyncShellJobsForOwner, startManagedAsyncJob } from "../extensions/async-shell/index.js";
import workerRuntimeExtension, { readWorkerRuntimeHandoff } from "../extensions/worker/runtime.js";
import { buildWorkerRpcArgs, defaultWorkerExtensionPaths, resolvePiCliPath, type WorkerHostConfig } from "../extensions/worker/runner.js";

type FakeApi = ExtensionAPI & { tools: ToolDefinition[] };

function fakeApi(): FakeApi {
  const tools: ToolDefinition[] = [];
  return {
    tools,
    registerTool(tool: ToolDefinition): void { tools.push(tool); },
    sendMessage(): void {}
  } as unknown as FakeApi;
}

function context(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => "parent-test" },
    isIdle: () => true
  } as ExtensionContext;
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-worker-runtime-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withWorkerEnv(
  directory: string,
  run: () => Promise<void>,
  extra: Record<string, string> = {}
): Promise<void> {
  await Promise.all([
    mkdir(path.join(directory, "cache", "config"), { recursive: true }),
    mkdir(path.join(directory, "cache", "data"), { recursive: true }),
    mkdir(path.join(directory, "cache", "state"), { recursive: true }),
    mkdir(path.join(directory, "tmp"), { recursive: true }),
    mkdir(path.join(directory, "worker-state", "async-shell"), { recursive: true })
  ]);
  const values = {
    PI_WORKER_ID: "worker-test",
    PI_WORKER_RUN_ID: "run-test",
    PI_WORKER_NATIVE_TEST_SHELL: "1",
    PI_WORKER_RESULT_FILE: path.join(directory, "run", "result.json"),
    PI_WORKER_WORKSPACE_ROOT: directory,
    PI_WORKER_STATE_ROOT: path.join(directory, "worker-state"),
    PI_WORKER_ASYNC_JOB_ROOT: path.join(directory, "worker-state", "async-shell"),
    PI_WORKER_TASK_IDS: JSON.stringify(["personal-test"]),
    ...extra
  };
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const handoff = {
  state: "assignment_complete",
  summary: "Implemented the focused change.",
  taskUpdates: [{ taskId: "personal-test", update: "Ready for parent acceptance." }],
  repositories: [{ workspaceRepo: "repos/project", purpose: "Focused implementation" }],
  checks: [{ cwd: "repos/project", command: "npm test", outcome: "passed" }]
} as const;

test("worker_task_read uses official readonly Beads paging with bounded assigned-task output", async () => {
  await withTempDir(async (directory) => {
    const bdPath = path.join(directory, "fake-bd");
    const logPath = path.join(directory, "bd-read-argv.log");
    const showPath = path.join(directory, "bd-show.json");
    const beadsPath = path.join(directory, "central-beads");
    const beadsRoute = { prefix: "personal", path: beadsPath, databasePath: path.join(beadsPath, "database") } as const;
    const whereOutput = JSON.stringify({ prefix: "personal", path: beadsRoute.path, database_path: beadsRoute.databasePath });
    const relation = (index: number, kind: string) => ({
      id: `personal-${kind}${index}`,
      title: index === 0 ? `${kind} ${"t".repeat(600)}` : `${kind} ${index}`,
      status: "open",
      priority: 2,
      issue_type: "task",
      dependency_type: "blocks"
    });
    const showOutput = [
      {
        id: "personal-test",
        title: "Assigned test task",
        status: "in_progress",
        priority: 1,
        issue_type: "feature",
        assignee: "worker-test",
        parent: "personal-parent",
        description: "d".repeat(3_000),
        notes: "Use the bounded host adapter.",
        acceptance_criteria: "Never expose the Beads database.",
        dependency_count: 6,
        dependent_count: 5,
        dependencies: Array.from({ length: 6 }, (_, index) => relation(index, "dependency")),
        dependents: Array.from({ length: 5 }, (_, index) => relation(index, "dependent"))
      },
      {
        id: "personal-second",
        title: "Second assigned task",
        status: "open",
        priority: 2,
        issue_type: "task",
        description: "Small task.",
        dependency_count: 0,
        dependent_count: 0,
        dependencies: [],
        dependents: []
      }
    ];
    await writeFile(showPath, `${JSON.stringify(showOutput)}\n`);
    await writeFile(bdPath, [
      "#!/bin/sh",
      "printf '%s\\n' \"$@\" >> \"$PI_FAKE_BD_LOG\"",
      `if [ \"$1\" = where ]; then printf '%s\\n' '${whereOutput}'`,
      "elif [ \"$1\" = --readonly ] && [ \"$2\" = show ]; then",
      "  if [ -n \"$PI_FAKE_BD_FAIL_SHOW\" ]; then printf '%s\\n' \"$0 $BEADS_DIR\" >&2; exit 9; fi",
      "  cat \"$PI_FAKE_BD_SHOW\"",
      "else exit 2",
      "fi",
      ""
    ].join("\n"));
    await chmod(bdPath, 0o700);
    await withWorkerEnv(directory, async () => {
      const api = fakeApi();
      workerRuntimeExtension(api);
      const tool = api.tools.find((candidate) => candidate.name === "worker_task_read");
      assert.ok(tool?.execute);
      const result = await tool.execute("read-1", { offset: 0, limit: 2 } as never, undefined, undefined, context(directory));
      const details = result.details as {
        offset: number;
        limit: number;
        totalAssigned: number;
        returned: number;
        nextOffset?: number;
        contentBytes: number;
        truncated: boolean;
      };
      assert.deepEqual({ ...details, contentBytes: undefined }, {
        offset: 0,
        limit: 2,
        totalAssigned: 3,
        returned: 2,
        nextOffset: 2,
        contentBytes: undefined,
        truncated: true
      });
      assert.ok(details.contentBytes > 0 && details.contentBytes <= 64 * 1024);
      const content = result.content[0];
      assert.equal(content.type, "text");
      const text = content.type === "text" ? content.text : "";
      const payload = JSON.parse(text.slice(text.indexOf("{\n"))) as { tasks: Array<Record<string, unknown>> };
      assert.equal(payload.tasks.length, 2);
      assert.equal(Buffer.byteLength(payload.tasks[0].description as string, "utf8") <= 2_048, true);
      assert.equal((payload.tasks[0].dependencies as unknown[]).length, 4);
      assert.equal((payload.tasks[0].dependents as unknown[]).length, 4);
      assert.deepEqual((payload.tasks[0].dependencies as Array<{ truncatedFields: string[] }>)[0].truncatedFields, ["title"]);
      assert.deepEqual(payload.tasks[0].truncatedFields, ["dependencies", "dependents", "description"]);
      assert.doesNotMatch(text, /central-beads|fake-bd/);

      const argv = await readFile(logPath, "utf8");
      assert.match(argv, /^where\n--json\n--readonly\nshow\n--include-dependents\n--id=personal-test\n--id=personal-second\n--json/m);
      assert.doesNotMatch(argv, /update|--db/);

      await writeFile(showPath, `${JSON.stringify([{
        ...showOutput[0],
        description: "Small task.",
        dependency_count: 1,
        dependent_count: 0,
        dependencies: [relation(0, "dependency")],
        dependents: []
      }])}\n`);
      const relationOnlyResult = await tool.execute(
        "read-relation-truncation",
        { offset: 0, limit: 1 } as never,
        undefined,
        undefined,
        context(directory)
      );
      assert.equal((relationOnlyResult.details as { truncated: boolean }).truncated, true);
      const relationOnlyContent = relationOnlyResult.content[0];
      assert.equal(relationOnlyContent.type, "text");
      const relationOnlyText = relationOnlyContent.type === "text" ? relationOnlyContent.text : "";
      const relationOnlyPayload = JSON.parse(relationOnlyText.slice(relationOnlyText.indexOf("{\n"))) as {
        tasks: Array<{ truncatedFields: string[]; dependencies: Array<{ truncatedFields: string[] }> }>;
      };
      assert.deepEqual(relationOnlyPayload.tasks[0].truncatedFields, []);
      assert.deepEqual(relationOnlyPayload.tasks[0].dependencies[0].truncatedFields, ["title"]);

      await writeFile(showPath, `${JSON.stringify([{ ...showOutput[0], id: "personal-unexpected" }])}\n`);
      await assert.rejects(
        tool.execute("read-mismatch", { offset: 0, limit: 1 } as never, undefined, undefined, context(directory)),
        /did not match the assigned task page/
      );
      await assert.rejects(
        tool.execute("read-offset", { offset: 3, limit: 1 } as never, undefined, undefined, context(directory)),
        /offset 3 exceeds 3 assigned task IDs/
      );
      process.env.PI_FAKE_BD_FAIL_SHOW = "1";
      await assert.rejects(
        tool.execute("read-cli-failure", { offset: 0, limit: 1 } as never, undefined, undefined, context(directory)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /could not read the assigned Beads task page/);
          assert.doesNotMatch(error.message, /central-beads|fake-bd/);
          return true;
        }
      );
      delete process.env.PI_FAKE_BD_FAIL_SHOW;

      await writeFile(showPath, "/CENTRAL_ROUTE_SECRET/not-json\n");
      await assert.rejects(
        tool.execute("read-malformed-json", { offset: 0, limit: 1 } as never, undefined, undefined, context(directory)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /received invalid JSON from Beads/);
          assert.doesNotMatch(error.message, /CENTRAL_ROUTE_SECRET/);
          assert.ok(Buffer.byteLength(error.message, "utf8") < 1_024);
          return true;
        }
      );

      const oversizedId = "X".repeat(100 * 1_024);
      const oversizedTask = { ...showOutput[0], id: oversizedId };
      await writeFile(showPath, `${JSON.stringify([oversizedTask, oversizedTask])}\n`);
      await assert.rejects(
        tool.execute("read-oversized-duplicate-id", { offset: 0, limit: 1 } as never, undefined, undefined, context(directory)),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /id exceeded 128 bytes/);
          assert.doesNotMatch(error.message, /X{32}/);
          assert.ok(Buffer.byteLength(error.message, "utf8") < 1_024);
          return true;
        }
      );

      await writeFile(showPath, `${JSON.stringify([showOutput[0], showOutput[0]])}\n`);
      await assert.rejects(
        tool.execute("read-duplicate-id", { offset: 0, limit: 1 } as never, undefined, undefined, context(directory)),
        /received duplicate Beads task records/
      );

      await writeFile(showPath, `${JSON.stringify([{ ...showOutput[0], status: "   " }])}\n`);
      await assert.rejects(
        tool.execute("read-blank-status", { offset: 0, limit: 1 } as never, undefined, undefined, context(directory)),
        /expected non-empty status/
      );

      const taskWithoutCounts: Record<string, unknown> = {
        ...showOutput[0],
        description: "Small task.",
        dependencies: Array.from({ length: 6 }, (_, index) => relation(index, "dependency")),
        dependents: []
      };
      delete taskWithoutCounts.dependency_count;
      delete taskWithoutCounts.dependent_count;
      await writeFile(showPath, `${JSON.stringify([taskWithoutCounts])}\n`);
      const countResult = await tool.execute(
        "read-count-fallback",
        { offset: 0, limit: 1 } as never,
        undefined,
        undefined,
        context(directory)
      );
      const countContent = countResult.content[0];
      assert.equal(countContent.type, "text");
      const countText = countContent.type === "text" ? countContent.text : "";
      const countPayload = JSON.parse(countText.slice(countText.indexOf("{\n"))) as {
        tasks: Array<{ dependencyCount: number; dependentCount: number; dependencies: unknown[] }>;
      };
      assert.equal(countPayload.tasks[0].dependencyCount, 6);
      assert.equal(countPayload.tasks[0].dependentCount, 0);
      assert.equal(countPayload.tasks[0].dependencies.length, 4);
    }, {
      PI_WORKER_TASK_IDS: JSON.stringify(["personal-test", "personal-second", "personal-third"]),
      PI_WORKER_BD_PATH: bdPath,
      PI_WORKER_BEADS_ROUTE: JSON.stringify(beadsRoute),
      PI_FAKE_BD_LOG: logPath,
      PI_FAKE_BD_SHOW: showPath,
      BEADS_DIR: beadsPath
    });
  });
});

test("worker_task_update verifies personal routing and permits only assigned tasks", async () => {
  await withTempDir(async (directory) => {
    const bdPath = path.join(directory, "fake-bd");
    const logPath = path.join(directory, "bd-argv.log");
    const beadsPath = path.join(directory, "central-beads");
    const beadsRoute = { prefix: "personal", path: beadsPath, databasePath: path.join(beadsPath, "database") } as const;
    const whereOutput = JSON.stringify({ prefix: "personal", path: beadsRoute.path, database_path: beadsRoute.databasePath });
    await writeFile(bdPath, `#!/bin/sh\nprintf '%s\\n' "$@" >> "$PI_FAKE_BD_LOG"\nif [ "$1" = where ]; then printf '%s\\n' '${whereOutput}'; else printf '{}\\n'; fi\n`);
    await chmod(bdPath, 0o700);
    await withWorkerEnv(directory, async () => {
      const api = fakeApi();
      workerRuntimeExtension(api);
      const tool = api.tools.find((candidate) => candidate.name === "worker_task_update");
      assert.ok(tool?.execute);
      const result = await tool.execute("call-1", {
        taskId: "personal-test",
        note: "Implemented the bounded slice.",
        status: "in_progress"
      } as never, undefined, undefined, context(directory));
      assert.equal((result.details as { recorded: boolean }).recorded, true);
      const argv = await readFile(logPath, "utf8");
      assert.match(argv, /^where\n--json\nupdate\npersonal-test\n/m);
      assert.match(argv, /--append-notes=Implemented the bounded slice\.\n/);
      assert.match(argv, /--actor\nworker:worker-test\n--json/);
      process.env.PI_WORKER_BEADS_ROUTE = JSON.stringify({ ...beadsRoute, databasePath: path.join(beadsPath, "wrong-database") });
      await assert.rejects(
        tool.execute("call-wrong-route", { taskId: "personal-test", note: "wrong route" } as never, undefined, undefined, context(directory)),
        /does not match the parent-recorded/
      );
      process.env.PI_WORKER_BEADS_ROUTE = JSON.stringify(beadsRoute);
      await assert.rejects(
        tool.execute("call-2", { taskId: "personal-other", note: "unauthorized" } as never, undefined, undefined, context(directory)),
        /not authorized/
      );
    }, {
      PI_WORKER_BD_PATH: bdPath,
      PI_WORKER_BEADS_ROUTE: JSON.stringify(beadsRoute),
      PI_FAKE_BD_LOG: logPath,
      BEADS_DIR: beadsPath
    });
  });
});

test("worker_handoff rejects unassigned tasks and workspace path escapes", async () => {
  await withTempDir(async (directory) => {
    await withWorkerEnv(directory, async () => {
      const outside = `${directory}-outside`;
      await mkdir(outside, { recursive: true });
      await symlink(outside, path.join(directory, "escape"));
      try {
        const api = fakeApi();
        workerRuntimeExtension(api);
        const tool = api.tools.find((candidate) => candidate.name === "worker_handoff");
        assert.ok(tool?.execute);
        await assert.rejects(
          tool.execute("call-1", {
            ...handoff,
            taskUpdates: [{ taskId: "personal-other", update: "unauthorized" }]
          } as never, undefined, undefined, context(directory)),
          /unassigned task/
        );
        await assert.rejects(
          tool.execute("call-2", {
            ...handoff,
            repositories: [{ workspaceRepo: "escape/repo", purpose: "outside" }]
          } as never, undefined, undefined, context(directory)),
          /resolves outside the workspace/
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});

test("worker_handoff writes one typed accepted result when the worker is quiescent", async () => {
  await withTempDir(async (directory) => {
    await withWorkerEnv(directory, async () => {
      const api = fakeApi();
      workerRuntimeExtension(api);
      const tool = api.tools.find((candidate) => candidate.name === "worker_handoff");
      const taskRead = api.tools.find((candidate) => candidate.name === "worker_task_read");
      const taskUpdate = api.tools.find((candidate) => candidate.name === "worker_task_update");
      assert.ok(tool?.execute);
      assert.ok(taskRead?.execute);
      assert.ok(taskUpdate?.execute);
      const result = await tool.execute("call-1", handoff as never, undefined, undefined, context(directory));
      assert.deepEqual(result.details, {
        accepted: true,
        resultFile: path.join(directory, "run", "result.json")
      });
      const accepted = readWorkerRuntimeHandoff(path.join(directory, "run", "result.json"));
      assert.equal(accepted.workerId, "worker-test");
      assert.equal(accepted.runId, "run-test");
      assert.deepEqual(accepted.handoff, handoff);
      assert.match(await readFile(path.join(directory, "run", "result.json"), "utf8"), /assignment_complete/);
      await assert.rejects(
        tool.execute("call-2", handoff as never, undefined, undefined, context(directory)),
        /already accepted/
      );
      await assert.rejects(
        taskRead.execute("read-after-handoff", {} as never, undefined, undefined, context(directory)),
        /already accepted|sealed/i
      );
      await assert.rejects(
        taskUpdate.execute("task-after-handoff", {
          taskId: "personal-test",
          note: "must not mutate after handoff"
        } as never, undefined, undefined, context(directory)),
        /already accepted|sealed/i
      );
    });
  });
});

test("persisted worker handoff reader rejects payloads outside the typed schema", async () => {
  await withTempDir(async (directory) => {
    const resultFile = path.join(directory, "invalid-result.json");
    await writeFile(resultFile, `${JSON.stringify({
      version: 1,
      workerId: "worker-test",
      runId: "run-test",
      acceptedAt: "2026-09-10T19:30:00.000Z",
      handoff: { state: "assignment_complete", summary: "", taskUpdates: "not-an-array" }
    })}\n`);
    assert.throws(() => readWorkerRuntimeHandoff(resultFile), /validation failed|Invalid|summary|taskUpdates/i);
  });
});

test("worker_handoff refuses active owned shell jobs and succeeds after cascade cancellation", async () => {
  await withTempDir(async (directory) => {
    await withWorkerEnv(directory, async () => {
      const api = fakeApi();
      workerRuntimeExtension(api);
      const tool = api.tools.find((candidate) => candidate.name === "worker_handoff");
      assert.ok(tool?.execute);
      const shell = startManagedAsyncJob(api, context(directory), {
        command: "owned long job",
        cwd: directory,
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        notifyOnExit: false
      });

      const blocked = await tool.execute("call-1", handoff as never, undefined, undefined, context(directory));
      assert.equal((blocked.details as { accepted: boolean }).accepted, false);
      assert.match(JSON.stringify(blocked.content), new RegExp(shell.jobId));

      const owner = { kind: "worker-run" as const, workerId: "worker-test", runId: "run-test" };
      await cancelAsyncShellJobsForOwner(owner, "SIGTERM", 1_000);
      const accepted = await tool.execute("call-2", handoff as never, undefined, undefined, context(directory));
      assert.equal((accepted.details as { accepted: boolean }).accepted, true);
    });
  });
});

test("worker RPC argv pins exact session resources and only the worker tool surface", () => {
  const config: WorkerHostConfig = {
    version: 1,
    workerId: "worker-test",
    runId: "run-test",
    sessionId: "session-test",
    sessionFile: "/tmp/session/test.jsonl",
    sessionDir: "/tmp/session",
    workspaceRoot: "/tmp/workspace",
    stateRoot: "/tmp/worker-state",
    asyncJobRoot: "/tmp/worker-state/async-shell",
    taskIds: ["personal-test"],
    resultFile: "/tmp/result.json",
    settledFile: "/tmp/settled.json",
    processFile: "/tmp/host-process.json",
    processNonce: "process-nonce",
    hostConfigFile: "/tmp/host.json",
    authorizationFile: "/tmp/host-authorization.json",
    parentPid: process.pid,
    prompt: "Do the assigned work.",
    provider: "openai-codex",
    model: "gpt-test",
    thinkingLevel: "xhigh",
    piCliPath: "/tmp/cli.js",
    bdPath: "/opt/homebrew/bin/bd",
    beadsRoute: { prefix: "personal", path: "/tmp/beads", databasePath: "/tmp/beads/database" },
    extensionPaths: ["/tmp/runtime.ts", "/tmp/async-shell.ts"],
    shellExecution: { kind: "native-test" },
    rpcArgs: [],
    timeoutMs: 60_000
  };
  const args = buildWorkerRpcArgs(config);
  assert.deepEqual(args.slice(0, 8), [
    "--session", config.sessionFile,
    "--session-dir", config.sessionDir,
    "--model", "openai-codex/gpt-test",
    "--thinking", "xhigh"
  ]);
  for (const required of ["--no-approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions", "--no-builtin-tools"]) {
    assert.ok(args.includes(required), required);
  }
  assert.match(args[args.indexOf("--tools") + 1], /worker_handoff/);
  assert.match(args[args.indexOf("--tools") + 1], /worker_task_read/);
  assert.ok(resolvePiCliPath().endsWith("/dist/cli.js"));
  assert.equal(defaultWorkerExtensionPaths().length, 2);
});
