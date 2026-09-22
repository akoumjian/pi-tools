import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateToolArguments, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import asyncShellExtension, { cancelAsyncShellJobsForOwner, startManagedAsyncJob } from "../extensions/async-shell/index.js";
import { workerHandoffAdmissionPath } from "../extensions/_shared/worker-contract.js";
import workerRuntimeExtension, { readWorkerRuntimeHandoff } from "../extensions/worker/runtime.js";
import { buildWorkerRpcArgs, defaultWorkerExtensionPaths, resolvePiCliPath, type WorkerHostConfig } from "../extensions/worker/runner.js";

type FakeApi = ExtensionAPI & { tools: ToolDefinition[] };

function fakeApi(): FakeApi {
  const tools: ToolDefinition[] = [];
  return {
    tools,
    registerTool(tool: ToolDefinition): void { tools.push(tool); },
    registerCommand(): void {},
    registerMessageRenderer(): void {},
    on(): void {},
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

test("worker_task_read uses official readonly Beads access with broad reads and assigned-only identity", async () => {
  await withTempDir(async (directory) => {
    const bdPath = path.join(directory, "fake-bd");
    const logPath = path.join(directory, "bd-read-argv.log");
    const showPath = path.join(directory, "bd-show.json");
    const searchPath = path.join(directory, "bd-search.json");
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
        parent: "personal-second",
        description: "d".repeat(3_000),
        notes: "Use the bounded host adapter.",
        acceptance_criteria: "Never expose the Beads database.",
        dependency_count: 6,
        dependent_count: 5,
        dependencies: Array.from({ length: 6 }, (_, index) => ({
          ...relation(index, "dependency"),
          ...(index === 0 ? { id: "personal-second" } : {})
        })),
        dependents: Array.from({ length: 5 }, (_, index) => relation(index, "dependent"))
      },
      {
        id: "personal-second",
        title: "Second assigned task",
        status: "open",
        priority: 2,
        issue_type: "task",
        parent: "personal-parent",
        description: "Small task.",
        dependency_count: 0,
        dependent_count: 0,
        dependencies: [],
        dependents: []
      }
    ];
    await writeFile(showPath, `${JSON.stringify(showOutput)}\n`);
    await writeFile(searchPath, `${JSON.stringify(showOutput.map(({ id, title }) => ({ id, title })))}\n`);
    await writeFile(bdPath, [
      "#!/bin/sh",
      "printf '%s\\n' \"$@\" >> \"$PI_FAKE_BD_LOG\"",
      `if [ \"$1\" = where ]; then printf '%s\\n' '${whereOutput}'`,
      "elif [ \"$1\" = --readonly ] && [ \"$2\" = show ]; then",
      "  if [ -n \"$PI_FAKE_BD_FAIL_SHOW\" ]; then printf '%s\\n' \"$0 $BEADS_DIR\" >&2; exit 9; fi",
      "  cat \"$PI_FAKE_BD_SHOW\"",
      "elif [ \"$1\" = --readonly ] && [ \"$2\" = search ]; then cat \"$PI_FAKE_BD_SEARCH\"",
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
      const parameters = tool.parameters as unknown as {
        type?: string;
        anyOf?: unknown;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      assert.equal(parameters.type, "object");
      assert.equal(parameters.anyOf, undefined);
      assert.deepEqual(Object.keys(parameters.properties ?? {}).sort(), ["limit", "offset", "query", "taskIds"]);
      const anthropicLegacySchema = {
        type: "object",
        properties: parameters.properties ?? {},
        required: parameters.required ?? []
      };
      assert.deepEqual(Object.keys(anthropicLegacySchema.properties).sort(), ["limit", "offset", "query", "taskIds"]);
      const validateReadArguments = (argumentsValue: unknown): unknown => validateToolArguments(
        tool as unknown as Tool,
        { type: "toolCall", id: "validate-read", name: "worker_task_read", arguments: argumentsValue } as ToolCall
      );
      for (const valid of [{}, { offset: 0, limit: 2 }, { taskIds: ["personal-other"] }, { query: "other", limit: 2 }]) {
        assert.doesNotThrow(() => validateReadArguments(valid));
      }
      assert.throws(() => validateReadArguments({ taskIds: ["--db=/tmp/escape"] }), /validation failed|Invalid/i);
      assert.throws(() => validateReadArguments({ query: "x", unknown: true }), /validation failed|Invalid/i);

      const result = await tool.execute("read-1", { offset: 0, limit: 2 } as never, undefined, undefined, context(directory));
      const details = result.details as {
        scope: "assigned" | "requested";
        offset?: number;
        limit: number;
        totalAssigned: number;
        returned: number;
        nextOffset?: number;
        contentBytes: number;
        truncated: boolean;
      };
      assert.deepEqual({ ...details, contentBytes: undefined }, {
        scope: "assigned",
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
      assert.equal(payload.tasks[0].assigned, true);
      assert.deepEqual(payload.tasks[0].parent, { id: "personal-second", assigned: true });
      assert.deepEqual(payload.tasks[1].parent, { id: "personal-parent", assigned: false });
      assert.equal(Buffer.byteLength(payload.tasks[0].description as string, "utf8") <= 2_048, true);
      assert.equal((payload.tasks[0].dependencies as unknown[]).length, 4);
      assert.equal((payload.tasks[0].dependents as unknown[]).length, 4);
      assert.equal(
        (payload.tasks[0].dependencies as Array<{ assigned: boolean }>)[0].assigned,
        true
      );
      assert.deepEqual((payload.tasks[0].dependencies as Array<{ truncatedFields: string[] }>)[0].truncatedFields, ["title"]);
      assert.deepEqual(payload.tasks[0].truncatedFields, ["dependencies", "dependents", "description"]);
      assert.doesNotMatch(text, /central-beads|fake-bd/);

      const argv = await readFile(logPath, "utf8");
      assert.match(argv, /^where\n--json\n--readonly\nshow\n--include-dependents\n--id=personal-test\n--id=personal-second\n--json/m);
      assert.doesNotMatch(argv, /update|--db/);

      await writeFile(showPath, `${JSON.stringify([
        { ...showOutput[1], id: "personal-other", title: "Readable unassigned task" },
        showOutput[0]
      ])}\n`);
      const requestedResult = await tool.execute(
        "read-requested",
        { taskIds: ["personal-other", "personal-test"] } as never,
        undefined,
        undefined,
        context(directory)
      );
      assert.deepEqual({ ...(requestedResult.details as Record<string, unknown>), contentBytes: undefined }, {
        scope: "requested",
        limit: 2,
        totalAssigned: 3,
        returned: 2,
        contentBytes: undefined,
        truncated: true
      });
      const requestedContent = requestedResult.content[0];
      assert.equal(requestedContent.type, "text");
      const requestedText = requestedContent.type === "text" ? requestedContent.text : "";
      const requestedPayload = JSON.parse(requestedText.slice(requestedText.indexOf("{\n"))) as {
        tasks: Array<{ id: string; assigned: boolean }>;
      };
      assert.deepEqual(requestedPayload.tasks.map(({ id, assigned }) => ({ id, assigned })), [
        { id: "personal-other", assigned: false },
        { id: "personal-test", assigned: true }
      ]);
      assert.match(requestedText, /Assigned to this worker: personal-test, personal-second, personal-third/);
      await assert.rejects(
        tool.execute("read-invalid-id", { taskIds: ["--db=/tmp/escape"] } as never, undefined, undefined, context(directory)),
        /requires 1-4 unique central personal task IDs/
      );
      await assert.rejects(
        tool.execute("read-mixed-modes", { taskIds: ["personal-test"], query: "test" } as never, undefined, undefined, context(directory)),
        /either taskIds or query/
      );
      await assert.rejects(
        tool.execute("read-task-limit", { taskIds: ["personal-test"], limit: 1 } as never, undefined, undefined, context(directory)),
        /taskIds cannot be combined with offset or limit/
      );
      await assert.rejects(
        tool.execute("read-query-offset", { query: "test", offset: 0 } as never, undefined, undefined, context(directory)),
        /query cannot be combined with offset/
      );

      await writeFile(searchPath, `${JSON.stringify([
        { id: "personal-other", title: "Readable unassigned task" },
        { id: "personal-test", title: "Assigned test task" }
      ])}\n`);
      const searchResult = await tool.execute(
        "read-search",
        { query: "Readable", limit: 2 } as never,
        undefined,
        undefined,
        context(directory)
      );
      assert.equal((searchResult.details as { scope: string }).scope, "search");
      const searchContent = searchResult.content[0];
      assert.equal(searchContent.type, "text");
      const searchText = searchContent.type === "text" ? searchContent.text : "";
      const searchPayload = JSON.parse(searchText.slice(searchText.indexOf("{\n"))) as {
        tasks: Array<{ id: string; assigned: boolean }>;
      };
      assert.deepEqual(searchPayload.tasks.map(({ id, assigned }) => ({ id, assigned })), [
        { id: "personal-other", assigned: false },
        { id: "personal-test", assigned: true }
      ]);
      assert.match(await readFile(logPath, "utf8"), /search\n--query=Readable\n--status=all\n--limit=2\n--sort=id\n--json/);
      await assert.rejects(
        tool.execute("read-empty-search", { query: "   " } as never, undefined, undefined, context(directory)),
        /requires a non-empty bounded search query/
      );

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
        /did not match the requested task IDs/
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
          assert.match(error.message, /could not read the requested Beads task page/);
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
      PI_FAKE_BD_SEARCH: searchPath,
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

test("worker_handoff rejects persisted jobs that are absent from its in-memory registry", async () => {
  await withTempDir(async (directory) => {
    await withWorkerEnv(directory, async () => {
      const api = fakeApi();
      workerRuntimeExtension(api);
      const tool = api.tools.find((candidate) => candidate.name === "worker_handoff");
      assert.ok(tool?.execute);
      assert.match((tool.promptGuidelines ?? []).join("\n"), /wait.*cancel|cancel.*wait/i);
      assert.match((tool.promptGuidelines ?? []).join("\n"), /verify.*terminal/i);

      const jobId = "job_persisted_only";
      const logDir = path.join(directory, "worker-state", "async-shell", "jobs", jobId);
      await mkdir(logDir, { recursive: true });
      await Promise.all([
        writeFile(path.join(logDir, "stdout.log"), ""),
        writeFile(path.join(logDir, "stderr.log"), "")
      ]);
      const meta = {
        jobId,
        command: "persisted-only job",
        cwd: directory,
        shell: process.execPath,
        status: "running",
        pid: process.pid,
        startedAt: "2026-09-22T14:22:25.000Z",
        notifyOnExit: false,
        completionNotified: false,
        owner: { kind: "worker-run", workerId: "worker-test", runId: "run-test" },
        processToken: "11111111-1111-4111-8111-111111111111",
        logDir,
        stdoutLog: path.join(logDir, "stdout.log"),
        stderrLog: path.join(logDir, "stderr.log"),
        outputBytes: { stdout: 0, stderr: 0 }
      };
      await writeFile(path.join(logDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

      const blocked = await tool.execute("persisted-blocked", handoff as never, undefined, undefined, context(directory));
      assert.deepEqual(blocked.details, { accepted: false, activeJobIds: [jobId] });
      assert.match(JSON.stringify(blocked.content), /not verifiably settled/);
      assert.equal(existsSync(path.join(directory, "run", "result.json")), false);
      assert.equal(existsSync(workerHandoffAdmissionPath(path.join(directory, "run", "result.json"))), false);

      const metaFile = path.join(logDir, "meta.json");
      await writeFile(metaFile, `${JSON.stringify({ ...meta, command: undefined }, null, 2)}\n`);
      await assert.rejects(
        tool.execute("persisted-malformed", handoff as never, undefined, undefined, context(directory)),
        /invalid metadata.*cannot verify quiescence/
      );
      assert.equal(existsSync(workerHandoffAdmissionPath(path.join(directory, "run", "result.json"))), false);

      await writeFile(metaFile, `${JSON.stringify({
        ...meta,
        owner: { kind: "worker-run", workerId: "worker-test", runId: " " }
      }, null, 2)}\n`);
      await assert.rejects(
        tool.execute("persisted-invalid-owner", handoff as never, undefined, undefined, context(directory)),
        /unverifiable ownership metadata.*cannot verify quiescence/
      );

      await writeFile(metaFile, `${JSON.stringify({
        ...meta,
        status: "unknown",
        processToken: "22222222-2222-4222-8222-222222222222"
      }, null, 2)}\n`);
      const unknown = await tool.execute("persisted-unknown", handoff as never, undefined, undefined, context(directory));
      assert.deepEqual(unknown.details, { accepted: false, activeJobIds: [jobId] });

      await writeFile(metaFile, `${JSON.stringify({
        ...meta,
        status: "cancelled",
        endedAt: "2026-09-22T14:22:26.000Z",
        processToken: undefined
      }, null, 2)}\n`);
      await assert.rejects(
        tool.execute("persisted-tokenless", handoff as never, undefined, undefined, context(directory)),
        /invalid metadata.*cannot verify quiescence/
      );

      if (process.platform === "darwin") {
        const liveToken = "33333333-3333-4333-8333-333333333333";
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          env: { ...process.env, PI_WORKER_JOB_TOKEN: liveToken },
          stdio: "ignore"
        });
        assert.ok(child.pid);
        try {
          await writeFile(metaFile, `${JSON.stringify({
            ...meta,
            status: "cancelled",
            endedAt: "2026-09-22T14:22:26.000Z",
            pid: child.pid,
            processToken: liveToken
          }, null, 2)}\n`);
          const terminalButLive = await tool.execute("persisted-terminal-live", handoff as never, undefined, undefined, context(directory));
          assert.deepEqual(terminalButLive.details, { accepted: false, activeJobIds: [jobId] });
        } finally {
          child.kill("SIGKILL");
          await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        }
      }

      await writeFile(metaFile, `${JSON.stringify({
        ...meta,
        status: "cancelled",
        endedAt: "2026-09-22T14:22:26.000Z",
        processToken: "22222222-2222-4222-8222-222222222222",
        notifyOnExit: true,
        completionNotified: false
      }, null, 2)}\n`);
      const pendingNotice = await tool.execute("persisted-pending-notice", handoff as never, undefined, undefined, context(directory));
      assert.deepEqual(pendingNotice.details, { accepted: false, activeJobIds: [jobId] });

      await writeFile(metaFile, `${JSON.stringify({
        ...meta,
        status: "cancelled",
        endedAt: "2026-09-22T14:22:26.000Z",
        processToken: "22222222-2222-4222-8222-222222222222",
        notifyOnExit: true,
        completionNotified: true
      }, null, 2)}\n`);
      const accepted = await tool.execute("persisted-settled", handoff as never, undefined, undefined, context(directory));
      assert.equal((accepted.details as { accepted: boolean }).accepted, true);
    });
  });
});

test("managed worker shell starts are sealed while handoff admission is active", async () => {
  await withTempDir(async (directory) => {
    await withWorkerEnv(directory, async () => {
      const resultFile = path.join(directory, "run", "result.json");
      await mkdir(path.dirname(resultFile), { recursive: true });
      await writeFile(workerHandoffAdmissionPath(resultFile), "admitting\n");
      const api = fakeApi();
      asyncShellExtension(api);
      const shellStart = api.tools.find((candidate) => candidate.name === "shell_start");
      assert.ok(shellStart?.execute);
      await assert.rejects(
        shellStart.execute("sealed-start", {
          commands: [{ command: "printf must-not-start", cwd: directory }]
        } as never, undefined, undefined, context(directory)),
        /sealed during or after worker_handoff admission/
      );
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
