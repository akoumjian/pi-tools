import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext, type MessageRenderer, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import asyncShellExtension from "../extensions/async-shell/index.js";
import nativeToolsExtension, {
  buildNativeToolsStatusText,
  buildNativeToolsSystemPrompt,
  editMany,
  enforceDefaultTools,
  nativeEditMutationEntryId,
  nativeWriteMutationEntryId,
  readMany,
  searchMany,
  writeMany
} from "../extensions/native-tools/index.js";

type FakeApi = ExtensionAPI & {
  activeTools: string[];
  registeredTools: ToolDefinition[];
  messageRenderers: Map<string, MessageRenderer>;
  commands: Map<string, { description: string; handler: Function }>;
  handlers: Map<string, Function[]>;
};

type SchemaNode = {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  additionalProperties?: boolean;
  default?: unknown;
  description?: string;
};

const renderTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text
};

function createContext(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

function createFakeApi(activeTools: string[], allToolNames: string[]): FakeApi {
  const registeredTools: ToolDefinition[] = [];
  const messageRenderers = new Map<string, MessageRenderer>();
  const commands = new Map<string, { description: string; handler: Function }>();
  const handlers = new Map<string, Function[]>();
  const fake = {
    activeTools: [...activeTools],
    registeredTools,
    messageRenderers,
    commands,
    handlers,
    registerCommand(name: string, command: { description: string; handler: Function }): void {
      commands.set(name, command);
    },
    registerTool(tool: ToolDefinition): void {
      registeredTools.push(tool);
    },
    registerMessageRenderer(customType: string, renderer: MessageRenderer): void {
      messageRenderers.set(customType, renderer);
    },
    on(event: string, handler: Function): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools(): string[] {
      return [...fake.activeTools];
    },
    setActiveTools(toolNames: string[]): void {
      fake.activeTools = [...toolNames];
    },
    getAllTools(): Array<{ name: string }> {
      const names = new Set([...allToolNames, ...registeredTools.map((tool) => tool.name)]);
      return Array.from(names).map((name) => ({ name }));
    }
  };
  return fake as unknown as FakeApi;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-native-tools-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function textFromResult(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.map((item) => item.text ?? "").join("\n") ?? "";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderToolCall(tool: ToolDefinition, args: unknown): string {
  assert.ok(tool.renderCall, `${tool.name} should define renderCall`);
  return tool.renderCall(args as never, renderTheme as never, {} as never).render(200).join("\n");
}

function renderToolResult(tool: ToolDefinition, result: unknown, expanded = false, context: unknown = {}): string {
  assert.ok(tool.renderResult, `${tool.name} should define renderResult`);
  return tool.renderResult(result as never, { expanded, isPartial: false }, renderTheme as never, context as never).render(200).join("\n");
}

function renderCustomMessage(api: FakeApi, customType: string, message: unknown): string {
  const renderer = required(api.messageRenderers.get(customType), `${customType} message renderer`);
  return renderer(message as never, { expanded: false }, renderTheme as never)?.render(200).join("\n") ?? "";
}

function schemaFor(tool: ToolDefinition): SchemaNode {
  return tool.parameters as unknown as SchemaNode;
}

function required<T>(value: T | undefined, name: string): T {
  assert.notEqual(value, undefined, name);
  if (value === undefined) {
    throw new Error(name);
  }
  return value;
}

test("native extension registers batch file tools but not single read/edit/write overrides", () => {
  const api = createFakeApi([], []);

  nativeToolsExtension(api);

  const names = api.registeredTools.map((tool) => tool.name);
  assert.deepEqual(names, ["bash", "read_many", "search_many", "write_many", "edit_many"]);

  const readManyTool = api.registeredTools.find((tool) => tool.name === "read_many");
  assert.ok(readManyTool);
  assert.equal(typeof readManyTool.renderCall, "function");
  assert.equal(typeof readManyTool.renderResult, "function");
  assert.equal(readManyTool.renderShell, "self");
  assert.match(readManyTool.promptSnippet ?? "", /files:\[\.\.\.\]/);
  assert.ok(readManyTool.promptGuidelines?.some((line) => line.startsWith("read_many use:")));
  assert.ok(readManyTool.promptGuidelines?.some((line) => line.startsWith("read_many input:")));
  assert.ok(readManyTool.promptGuidelines?.some((line) => line.startsWith("read_many output:")));
  assert.ok(readManyTool.promptGuidelines?.some((line) => line.startsWith("read_many constraints:")));
  assert.match(readManyTool.description, /Use search_many first/);
  assert.match(readManyTool.description, /Batch independent file reads/);
  assert.match(readManyTool.description, /offset/);
  assert.match(readManyTool.description, /limit/);
  const filesSchema = required(schemaFor(readManyTool).properties?.files, "read_many files schema");
  const fileItemSchema = required(filesSchema.items, "read_many file item schema");
  assert.equal(fileItemSchema.properties?.offset.minimum, 1);
  assert.equal(fileItemSchema.properties?.limit.maximum, undefined);

  const searchManyTool = api.registeredTools.find((tool) => tool.name === "search_many");
  assert.ok(searchManyTool);
  assert.equal(typeof searchManyTool.renderCall, "function");
  assert.equal(typeof searchManyTool.renderResult, "function");
  assert.equal(searchManyTool.renderShell, "self");
  assert.match(searchManyTool.promptSnippet ?? "", /searches:\[\.\.\.\]/);
  assert.ok(searchManyTool.promptGuidelines?.some((line) => line.startsWith("search_many use:")));
  assert.ok(searchManyTool.promptGuidelines?.some((line) => line.startsWith("search_many input:")));
  assert.ok(searchManyTool.promptGuidelines?.some((line) => line.startsWith("search_many output:")));
  assert.ok(searchManyTool.promptGuidelines?.some((line) => line.startsWith("search_many constraints:")));
  assert.match(searchManyTool.description, /rg text search/);
  assert.match(searchManyTool.description, /one searches array/);
  assert.match(searchManyTool.description, /rg --files/);
  const searchesSchema = required(schemaFor(searchManyTool).properties?.searches, "search_many searches schema");
  const searchItemSchema = required(searchesSchema.items, "search_many search item schema");
  assert.equal(searchItemSchema.properties?.path.default, ".");
  assert.equal(searchItemSchema.properties?.maxResults.maximum, 1000);
  assert.match(searchManyTool.promptGuidelines?.join("\n") ?? "", /literal:true for exact text/);

  const writeManyTool = api.registeredTools.find((tool) => tool.name === "write_many");
  const editManyTool = api.registeredTools.find((tool) => tool.name === "edit_many");
  assert.equal(typeof writeManyTool?.renderCall, "function");
  assert.equal(typeof writeManyTool?.renderResult, "function");
  assert.equal(writeManyTool?.renderShell, "self");
  assert.match(writeManyTool?.promptSnippet ?? "", /writes:\[\.\.\.\]/);
  assert.deepEqual(writeManyTool?.promptGuidelines?.map((line) => line.split(":", 1)[0]), ["write_many use", "write_many input", "write_many output", "write_many constraints"]);
  assert.equal(typeof editManyTool?.renderCall, "function");
  assert.equal(typeof editManyTool?.renderResult, "function");
  assert.equal(editManyTool?.renderShell, "self");
  assert.match(editManyTool?.promptSnippet ?? "", /files:\[\.\.\.\]/);
  assert.deepEqual(editManyTool?.promptGuidelines?.map((line) => line.split(":", 1)[0]), ["edit_many use", "edit_many input", "edit_many output", "edit_many constraints"]);
});

test("native file tool renderers show blocked errors instead of empty success summaries", () => {
  const api = createFakeApi([], []);
  nativeToolsExtension(api);
  const editManyTool = required(api.registeredTools.find((tool) => tool.name === "edit_many"), "edit_many tool");

  const rendered = renderToolResult(editManyTool, {
    content: [{ type: "text", text: "File mutation was not applied.\nReviewed mutation id: mr_ab12cd34" }],
    details: {}
  }, false, { isError: true });

  assert.match(rendered, /Blocked by mutation-review \(mr_ab12cd34\)/);
  assert.doesNotMatch(rendered, /Updated .* with 0 edits/);
});

test("native file tool renderers surface the reviewer summary for blocked mutations", () => {
  const api = createFakeApi([], []);
  nativeToolsExtension(api);
  const editManyTool = required(api.registeredTools.find((tool) => tool.name === "edit_many"), "edit_many tool");

  const reasonText = [
    "File mutation was not applied.",
    "",
    "Summary:",
    "Reuse the existing parser helper instead of duplicating it.",
    "",
    "Reviewed mutation id: mr_ab12cd34"
  ].join("\n");

  const rendered = renderToolResult(editManyTool, {
    content: [{ type: "text", text: reasonText }],
    details: {}
  }, false, { isError: true });

  assert.match(rendered, /Blocked by mutation-review \(mr_ab12cd34\): Reuse the existing parser helper instead of duplicating it\./);
});

test("native file tool renderers surface the reviewer summary for already-pending blocks", () => {
  const api = createFakeApi([], []);
  nativeToolsExtension(api);
  const writeManyTool = required(api.registeredTools.find((tool) => tool.name === "write_many"), "write_many tool");

  const reasonText = [
    "File mutation was not applied.",
    "",
    "This exact edit/write is already pending as mr_ab12cd34; it was not re-reviewed.",
    "",
    "Original reviewer summary:",
    "Reuse formatTimestamp from src/format.ts.",
    "",
    "Reviewed mutation id: mr_ab12cd34"
  ].join("\n");

  const rendered = renderToolResult(writeManyTool, {
    content: [{ type: "text", text: reasonText }],
    details: {}
  }, false, { isError: true });

  assert.match(rendered, /Blocked by mutation-review \(mr_ab12cd34\): Reuse formatTimestamp from src\/format\.ts\./);
});

test("native file tool renderers surface review failures for blocked mutations", () => {
  const api = createFakeApi([], []);
  nativeToolsExtension(api);
  const writeManyTool = required(api.registeredTools.find((tool) => tool.name === "write_many"), "write_many tool");

  const reasonText = [
    "File mutation was not applied because the mutation-review agent did not complete a structured decision.",
    "",
    "Failure: Reviewer finished without calling submit_mutation_review.",
    "",
    "Reviewed mutation id: mr_ab12cd34"
  ].join("\n");

  const rendered = renderToolResult(writeManyTool, {
    content: [{ type: "text", text: reasonText }],
    details: {}
  }, false, { isError: true });

  assert.match(rendered, /Blocked by mutation-review \(mr_ab12cd34\): Reviewer finished without calling submit_mutation_review\./);
});

test("native file tool renderers append the reviewer summary on partial mutation-review blocks", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "keep.ts");
    await writeFile(filePath, "export const keep = 1;\n");

    const api = createFakeApi([], []);
    nativeToolsExtension(api);
    const editManyTool = required(api.registeredTools.find((tool) => tool.name === "edit_many"), "edit_many tool");

    const result = await editMany(createContext(dir), { files: [{ path: "keep.ts", edits: [{ oldText: "keep = 1", newText: "keep = 2" }] }] });
    const decoratedResult = {
      ...result,
      details: {
        ...result.details,
        mutationReview: {
          pendingId: "mr_ab12cd34",
          blocked: [{ id: "m_blocked", path: "dup.ts", kind: "replace" }],
          summary: "Reuse the shared helper from src/util.ts."
        }
      }
    };

    const rendered = renderToolResult(editManyTool, decoratedResult);
    assert.match(rendered, /skipped m_blocked by mutation review: Reuse the shared helper from src\/util\.ts\./);
  });
});

test("shell_start schema exposes commands list and async completion guidance", () => {
  const api = createFakeApi([], []);

  asyncShellExtension(api);

  const shellStart = api.registeredTools.find((tool) => tool.name === "shell_start");
  assert.ok(shellStart);
  assert.match(shellStart.description, /commands: \[\.\.\.\]/);
  assert.match(shellStart.description, /Start independent shell work together/);
  assert.match(shellStart.description, /jobId/);
  assert.match(shellStart.description, /Each command item must include its own command and cwd/);
  assert.match(shellStart.description, /In-band shell_start results include compact job fields/);
  assert.match(shellStart.description, /does not return stdout\/stderr samples/);
  assert.match(shellStart.description, /Completion notices are short result notices/);
  assert.match(shellStart.description, /triggers one assistant turn for each flushed batch/);
  assert.match(shellStart.description, /at most 12 commands/);
  assert.match(shellStart.description, /Standard input is ignored/);
  assert.match(shellStart.description, /Do not use status\/read for polling/);
  assert.equal(typeof shellStart.renderCall, "function");
  assert.equal(typeof shellStart.renderResult, "function");
  assert.equal(shellStart.renderShell, "self");
  const shellSchema = schemaFor(shellStart);
  assert.ok(shellSchema.properties?.commands);
  assert.equal(shellSchema.properties?.command, undefined);
  assert.equal(shellSchema.properties?.waitForCompletionSeconds, undefined);
  assert.equal(shellSchema.properties?.notifyOnExit, undefined);
  assert.equal(shellSchema.properties?.cwd, undefined);
  assert.equal(shellSchema.properties?.label, undefined);
  assert.equal(shellSchema.properties?.shell, undefined);
  assert.equal(shellSchema.properties?.tailLines, undefined);
  assert.equal(shellSchema.additionalProperties, false);
  assert.equal(shellSchema.properties.commands.minItems, 1);
  assert.match(JSON.stringify(shellSchema.properties.commands), /notifyOnExit/);
  assert.match(JSON.stringify(shellSchema.properties.commands), /job_name/);
  assert.match(JSON.stringify(shellSchema.properties.commands), /cwd/);
  assert.doesNotMatch(JSON.stringify(shellSchema.properties.commands), /label/);

  for (const toolName of ["shell_status", "shell_read", "shell_cancel"]) {
    const tool = required(api.registeredTools.find((registeredTool) => registeredTool.name === toolName), `${toolName} tool`);
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
    assert.equal(tool.renderShell, "self");
    assert.equal(schemaFor(tool).additionalProperties, false);
  }

  assert.equal(api.registeredTools.some((registeredTool) => registeredTool.name === "shell_tail"), false);
  const shellRead = required(api.registeredTools.find((registeredTool) => registeredTool.name === "shell_read"), "shell_read tool");
  const shellReadSchema = schemaFor(shellRead);
  assert.match(shellRead.description, /mode='tail'/);
  assert.match(shellRead.description, /mode='range'/);
  assert.match(JSON.stringify(shellReadSchema.properties?.mode), /"default":"tail"/);
  assert.match(shellReadSchema.properties?.lines?.description ?? "", /Tail mode only/);
  assert.match(shellReadSchema.properties?.maxChars?.description ?? "", /Tail mode only/);
  assert.equal(shellReadSchema.properties?.offset.minimum, 1);
  assert.equal(shellReadSchema.properties?.limit.minimum, 1);

  const singleCallText = renderToolCall(shellStart, {
    commands: [{ command: "pwd", cwd: ".", job_name: "where" }]
  });
  assert.match(singleCallText, /⏺ Call\(where: pwd \(cwd \.\)/);
  assert.doesNotMatch(singleCallText, /Bash\(/);

  const callText = renderToolCall(shellStart, {
    commands: [
      { command: "rg -n \"needle\" extensions", cwd: ".", job_name: "scan" },
      { command: "npm test", cwd: ".", job_name: "tests" }
    ]
  });
  assert.match(callText, /⏺ Call\(2 shell commands:/);
  assert.match(callText, /scan: rg -n "needle" extensions \(cwd \.\)/);
  assert.match(callText, /tests: npm test \(cwd \.\)/);

  const partialText = shellStart.renderResult?.({
    content: [{ type: "text", text: "Async shell jobs running." }],
    details: {
      jobs: [
        {
          jobId: "job_20260427160000_abcdef12",
          job_name: "scan",
          command: "rg -n \"needle\" extensions",
          cwd: "/repo",
          status: "running",
          stdoutLog: "/repo/.pi/async-shell/jobs/job_20260427160000_abcdef12/stdout.log",
          stderrLog: "/repo/.pi/async-shell/jobs/job_20260427160000_abcdef12/stderr.log",
          outputBytes: { stdout: 0, stderr: 0 }
        }
      ]
    }
  } as never, { expanded: false, isPartial: true }, renderTheme as never, {} as never).render(200).join("\n") ?? "";
  assert.match(partialText, /⎿ running · scan: rg -n "needle" extensions/);

  const resultText = renderToolResult(shellStart, {
    content: [{ type: "text", text: "Started async shell jobs" }],
    details: {
      jobs: [
        {
          jobId: "job_20260427160000_abcdef12",
          job_name: "scan",
          command: "rg -n \"needle\" extensions",
          cwd: "/repo",
          status: "exited",
          exitCode: 0,
          durationMs: 1234,
          stdoutLog: "/repo/.pi/async-shell/jobs/job_20260427160000_abcdef12/stdout.log",
          stderrLog: "/repo/.pi/async-shell/jobs/job_20260427160000_abcdef12/stderr.log",
          outputBytes: { stdout: 42, stderr: 0 }
        }
      ]
    }
  });
  assert.match(resultText, /⎿ ok · 1\.2s · scan: rg -n "needle" extensions/);
  assert.doesNotMatch(resultText, /stdout: extensions\/native-tools\/index\.ts:12:needle/);
});

test("shell_start emits partial status updates while waiting", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi([], []);
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);

    const updates: unknown[] = [];
    const result = await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "printf ok", cwd: dir, notifyOnExit: false }]
      } as never,
      new AbortController().signal,
      (update: unknown) => updates.push(update),
      createContext(dir)
    );

    assert.ok(updates.length > 0);
    const renderedUpdate = shellStart.renderResult?.(updates[0] as never, { expanded: false, isPartial: true }, renderTheme as never, {} as never).render(200).join("\n") ?? "";
    assert.match(renderedUpdate, /⎿ running · printf ok/);
    const details = result.details as { jobs: Array<{ status: string; exitCode?: number | null }> };
    assert.equal(details.jobs[0].status, "exited");
    assert.equal(details.jobs[0].exitCode, 0);
    assert.match(renderToolResult(shellStart, result), /⎿ ok .* · printf ok/);
  });
});

test("async shell tool result renders compactly on schema/exec errors instead of dumping content", () => {
  const api = createFakeApi([], []);
  asyncShellExtension(api);
  const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
  const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
  const shellRead = required(api.registeredTools.find((tool) => tool.name === "shell_read"), "shell_read tool");
  const shellCancel = required(api.registeredTools.find((tool) => tool.name === "shell_cancel"), "shell_cancel tool");

  const longErrorText = [
    "Expected required property",
    "commands.0.cwd is required",
    "  /Users/aleck/Code/pi-tools/extensions/async-shell/index.ts:118",
    "    at Object.execute",
    "    at TypeBoxValueCheck",
    "    at runAgentLoop /Users/aleck/Code/pi-tools/.pi/test-build/extensions/async-shell/index.js:42"
  ].join("\n");
  const errorResult = {
    content: [{ type: "text", text: longErrorText }],
    details: undefined
  };

  for (const tool of [shellStart, shellStatus, shellRead, shellCancel]) {
    const rendered = renderToolResult(tool, errorResult, false, { isError: true });
    assert.match(rendered, /⎿ error: /);
    const trimmed = rendered.trimEnd();
    assert.doesNotMatch(trimmed, /\n/, `${tool.name} error row should be single-line`);
    assert.ok(trimmed.length <= 200, `${tool.name} error row should be bounded, got length ${trimmed.length}`);
    assert.ok(trimmed.endsWith("...") || trimmed.length <= 168, `${tool.name} error row should be truncated past ~160 chars (got ${trimmed.length})`);
  }
});

test("async shell management tools render compactly without raw output", () => {
  const api = createFakeApi([], []);
  asyncShellExtension(api);
  assert.equal(api.registeredTools.some((tool) => tool.name === "shell_wait"), false);
  const shellCancel = required(api.registeredTools.find((tool) => tool.name === "shell_cancel"), "shell_cancel tool");
  const shellRead = required(api.registeredTools.find((tool) => tool.name === "shell_read"), "shell_read tool");
  const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");

  const job = {
    jobId: "job_20260428122933_07a634dd",
    job_name: "zeta-countdown-failure-demo",
    cwd: "/repo",
    command: "for i in 5 4 3 2 1; do echo \"[zeta] intentional failure in $i...\"; sleep 1; done; echo \"[zeta] exiting with code 7 now\" >&2; exit 7",
    status: "failed",
    exitCode: 7,
    durationMs: 5037
  };
  const result = {
    content: [{
      type: "text",
      text: [
        "Job completed while waiting",
        "",
        "job_id: job_20260428122933_07a634dd",
        "Output:",
        "stderr:",
        "```",
        "[zeta] exiting with code 7 now",
        "```"
      ].join("\n")
    }],
    details: {
      job,
      output: { stdout: "", stderr: "[zeta] exiting with code 7 now" }
    }
  };

  assert.match(renderToolCall(shellCancel, { jobId: job.jobId, signal: "SIGINT" }), /⏺ Cancel\(07a634dd SIGINT\)/);
  const cancelText = renderToolResult(shellCancel, { ...result, details: { ...result.details, job: { ...job, status: "cancelled", signal: "SIGINT" } } });
  assert.match(cancelText, /⎿ cancel requested · cancelled/);
  assert.doesNotMatch(cancelText, /Output:|stderr/);

  assert.match(renderToolCall(shellRead, { jobId: job.jobId, mode: "tail", lines: 80 }), /⏺ Read\(07a634dd stdout\/stderr tail 80 lines\)/);
  const tailText = renderToolResult(shellRead, {
    content: [{ type: "text", text: "tail output" }],
    details: {
      job,
      streams: [{ stream: "stderr", logPath: "/repo/.pi/stderr.log", mode: "tail", requestedLines: 80, requestedMaxChars: 20000, previewLines: ["line"] }]
    }
  });
  assert.match(tailText, /⎿ read stderr:tail80 · exit 7/);
  assert.doesNotMatch(tailText, /tail output|line|exiting with code 7 now/);

  assert.match(renderToolCall(shellRead, { jobId: job.jobId, stream: "stderr", mode: "range", offset: 2, limit: 3 }), /⏺ Read\(07a634dd stderr range offset 2 limit 3\)/);
  const readText = renderToolResult(shellRead, {
    content: [{ type: "text", text: "range output" }],
    details: {
      job,
      streams: [{ stream: "stderr", logPath: "/repo/.pi/stderr.log", mode: "range", offset: 2, requestedLimit: 3, truncation: { truncated: false, truncatedBy: null, totalLines: 5, outputLines: 3, totalBytes: 100, outputBytes: 50 }, previewLines: ["line"] }]
    }
  });
  assert.match(readText, /⎿ read stderr:2:4 · exit 7/);
  assert.doesNotMatch(readText, /range output|line/);

  assert.match(renderToolCall(shellStatus, { jobId: job.jobId }), /⏺ Status\(07a634dd\)/);
  assert.match(renderToolResult(shellStatus, result), /⎿ exit 7/);

  assert.match(renderToolCall(shellStatus, { limit: 3 }), /⏺ Status\(last 3\)/);
  const listText = renderToolResult(shellStatus, {
    content: [{ type: "text", text: "job_20260428122933_07a634dd: failed exit=7\n  long command" }],
    details: {
      jobs: [
        job,
        { ...job, jobId: "job_20260428122933_ea5fc2f8", status: "exited", exitCode: 0 },
        { ...job, jobId: "job_20260428122933_3d3ad25f", status: "running", exitCode: undefined, durationMs: undefined }
      ]
    }
  });
  assert.match(listText, /⎿ 3 jobs · 1 exit 7, 1 ok, 1 running/);
  assert.doesNotMatch(listText, /long command|job_20260428122933/);

  const singleMessageText = renderCustomMessage(api, "async-shell", {
    customType: "async-shell",
    content: [
      "job_id: job_20260428122933_07a634dd",
      "Recent output:",
      "2026-04-28T12:29:38.489Z stderr: [zeta] exiting with code 7 now"
    ].join("\n"),
    display: true,
    details: { job, output: { stdout: "", stderr: "[zeta] exiting with code 7 now" } }
  });
  assert.match(singleMessageText, /⎿ exit 7 · 5\.0s · zeta-countdown-failure-demo:/);
  assert.doesNotMatch(singleMessageText, /async-shell notification|job_id|stderr/);

  const multiJobMessageText = renderCustomMessage(api, "async-shell", {
    customType: "async-shell",
    content: "Jobs completed.\nstdout spam",
    display: true,
    details: {
      jobs: [
        { job: { ...job, status: "exited", exitCode: 0 }, output: { stdout: "ok", stderr: "" } },
        { job: { ...job, jobId: "job_20260428122933_ea5fc2f8", status: "failed", exitCode: 7 }, output: { stdout: "", stderr: "fail" } }
      ]
    }
  });
  assert.match(multiJobMessageText, /⎿ 2 jobs · 1 ok, 1 exit 7/);
  assert.doesNotMatch(multiJobMessageText, /async-shell notification|stdout spam|job_20260428122933/);
});

test("enforceDefaultTools removes single-file and bash tools while preserving unrelated tools", () => {
  const api = createFakeApi(
    ["read", "bash", "edit", "write", "searxng_search"],
    ["read", "bash", "edit", "write", "searxng_search", "read_many", "search_many", "write_many", "edit_many", "web_fetch_many", "shell_start", "shell_status", "shell_read", "shell_cancel"]
  );

  const report = enforceDefaultTools(api, { strict: true });

  assert.equal(report.ok, true);
  assert.deepEqual(report.removedBannedTools, ["bash", "read", "edit", "write"]);
  assert.deepEqual(api.getActiveTools(), [
    "searxng_search",
    "read_many",
    "search_many",
    "write_many",
    "edit_many",
    "web_fetch_many",
    "shell_start",
    "shell_status",
    "shell_read",
    "shell_cancel"
  ]);
});

test("enforceDefaultTools fails loudly when required replacements are unavailable", () => {
  const api = createFakeApi(["bash"], ["bash", "read_many", "search_many", "write_many", "edit_many"]);

  assert.throws(() => enforceDefaultTools(api, { strict: true }), /required replacement tools missing: shell_start/);
  assert.deepEqual(api.getActiveTools(), ["read_many", "search_many", "write_many", "edit_many"]);
});

test("enforceDefaultTools supports read-only restricted profiles without mutation tools", () => {
  const api = createFakeApi(
    ["read_many", "search_many", "shell_start", "shell_status", "shell_read", "shell_cancel"],
    ["read_many", "search_many", "shell_start", "shell_status", "shell_read", "shell_cancel"]
  );

  const report = enforceDefaultTools(api, { strict: true });

  assert.equal(report.ok, true);
  assert.deepEqual(report.missingReplacementTools, []);
  assert.deepEqual(api.getActiveTools(), ["read_many", "search_many", "shell_start", "shell_status", "shell_read", "shell_cancel"]);
});

test("enforceDefaultTools still fails when active stock write/edit lack replacements", () => {
  const api = createFakeApi(["write", "edit"], ["write", "edit", "read_many", "search_many"]);

  assert.throws(() => enforceDefaultTools(api, { strict: true }), /required replacement tools missing: write_many, edit_many/);
  assert.deepEqual(api.getActiveTools(), ["read_many", "search_many"]);
});

test("native-tools-status reports strict replacement diagnostics", () => {
  const api = createFakeApi(
    ["read_many", "search_many", "write_many", "edit_many", "shell_start", "shell_status", "shell_read", "shell_cancel"],
    ["bash", "read", "write", "edit", "read_many", "search_many", "write_many", "edit_many", "shell_start", "shell_status", "shell_read", "shell_cancel"]
  );
  nativeToolsExtension(api);

  assert.ok(api.commands.has("native:status"));
  assert.equal(api.commands.has("native-tools-status"), false, "deprecated kebab alias removed");
  const status = buildNativeToolsStatusText(api);
  assert.match(status, /Strict replacement: ok/);
  assert.match(status, /Active banned stock tools: none/);
  assert.match(status, /Missing required replacements: none/);
});

test("native batch tools reject pre-aborted work before reads, searches, or mutations", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "existing.txt"), "before\n", "utf8");
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(readMany(createContext(dir), { files: [{ path: "existing.txt" }] }, controller.signal), { name: "AbortError" });
    await assert.rejects(searchMany(createContext(dir), { searches: [{ kind: "files", path: "." }] }, controller.signal), { name: "AbortError" });
    await assert.rejects(
      writeMany(createContext(dir), { writes: [{ path: "new.txt", content: "new\n" }] }, undefined, controller.signal),
      { name: "AbortError" }
    );
    await assert.rejects(
      editMany(createContext(dir), { files: [{ path: "existing.txt", edits: [{ oldText: "before", newText: "after" }] }] }, undefined, controller.signal),
      { name: "AbortError" }
    );

    assert.equal(await readFile(path.join(dir, "existing.txt"), "utf8"), "before\n");
    await assert.rejects(readFile(path.join(dir, "new.txt"), "utf8"), /ENOENT/);
  });
});

test("write_many aborts promptly while queued and never commits the deferred write", async () => {
  await withTempDir(async (dir) => {
    const targetPath = path.join(dir, "queued.txt");
    let releaseQueue!: () => void;
    const blocker = withFileMutationQueue(targetPath, () => new Promise<void>((resolve) => {
      releaseQueue = resolve;
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const controller = new AbortController();
    const writing = writeMany(
      createContext(dir),
      { writes: [{ path: "queued.txt", content: "must not land\n" }] },
      undefined,
      controller.signal
    );
    controller.abort();

    try {
      await assert.rejects(
        Promise.race([
          writing,
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("interrupted queue wait did not settle")), 500))
        ]),
        { name: "AbortError" }
      );
      await assert.rejects(readFile(targetPath, "utf8"), /ENOENT/);
    } finally {
      releaseQueue();
      await blocker;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(readFile(targetPath, "utf8"), /ENOENT/);
  });
});

test("search_many terminates its owned rg child on interruption", async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, "bin");
    await mkdir(binDir);
    const rgPath = path.join(binDir, "rg");
    await writeFile(rgPath, "#!/bin/sh\nsleep 30\n", "utf8");
    await chmod(rgPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      const controller = new AbortController();
      const startedAt = Date.now();
      const search = searchMany(createContext(dir), { searches: [{ kind: "files", path: "." }] }, controller.signal);
      setTimeout(() => controller.abort(), 50);
      await assert.rejects(search, { name: "AbortError" });
      assert.ok(Date.now() - startedAt < 1_500, "interrupted rg should settle promptly");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test("search_many lists files and searches content with line numbers", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "alpha.ts"), "const alpha = 1;\nconst needle = alpha;\n", "utf8");
    await writeFile(path.join(dir, "beta.md"), "needle in docs\n", "utf8");

    const result = await searchMany(createContext(dir), {
      searches: [
        { kind: "files", path: ".", glob: "*.ts", maxResults: 20 },
        { kind: "content", pattern: "needle", path: ".", glob: "*.ts", context: 0, maxResults: 20 }
      ]
    });

    assert.deepEqual(result.details.searches.map((search) => search.kind), ["files", "content"]);
    assert.equal(result.details.searches[0].outputLines, 1);
    assert.equal(result.details.searches[1].outputLines, 1);
    assert.match(result.details.searches[0].previewLines[0], /alpha\.ts/);
    assert.match(result.details.searches[1].previewLines[0], /alpha\.ts:2:\d+:const needle = alpha;/);

    const text = textFromResult(result);
    assert.match(text, /--- search 1: files in \. glob "\*\.ts"/);
    assert.match(text, /alpha\.ts/);
    assert.match(text, /--- search 2: content "needle" in \. glob "\*\.ts"/);
    assert.match(text, /alpha\.ts:2:\d+:const needle = alpha;/);
    assert.doesNotMatch(text, /beta\.md/);

    const api = createFakeApi([], []);
    nativeToolsExtension(api);
    const searchManyTool = required(api.registeredTools.find((tool) => tool.name === "search_many"), "search_many tool");
    const callText = renderToolCall(searchManyTool, {
      searches: [
        { kind: "files", path: ".", glob: "*.ts", maxResults: 20 },
        { kind: "content", pattern: "needle", path: ".", glob: "*.ts", context: 0, maxResults: 20 }
      ]
    });
    assert.match(callText, /⏺ Search\(/);
    assert.match(callText, /files in \. glob "\*\.ts"/);
    assert.match(callText, /"needle" in \. glob "\*\.ts"/);

    const renderedResult = renderToolResult(searchManyTool, result);
    assert.match(renderedResult, /⎿ Found 2 lines across 2 searches/);
    assert.doesNotMatch(renderedResult, /alpha\.ts/);
    assert.doesNotMatch(renderedResult, /const needle = alpha/);
  });
});

test("search_many rejects content searches without a pattern", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      searchMany(createContext(dir), {
        searches: [{ kind: "content", path: "." }]
      }),
      /content searches require pattern/
    );
  });
});

test("write_many creates parent directories and reports bytes for every file", async () => {
  await withTempDir(async (dir) => {
    const result = await writeMany(createContext(dir), {
      writes: [
        { path: "one.txt", content: "alpha\n" },
        { path: "nested/two.txt", content: "beta" }
      ]
    });

    const oneId = nativeWriteMutationEntryId({ path: "one.txt", content: "alpha\n" });
    const twoId = nativeWriteMutationEntryId({ path: "nested/two.txt", content: "beta" });
    assert.match(oneId, /^m_[a-f0-9]{12}$/);
    assert.deepEqual(result.details.files.map((file) => [file.id, file.path, file.bytes]), [
      [oneId, "one.txt", 6],
      [twoId, "nested/two.txt", 4]
    ]);
    assert.equal(await readFile(path.join(dir, "nested/two.txt"), "utf8"), "beta");
    assert.match(textFromResult(result), /Wrote 2 files/);

    const api = createFakeApi([], []);
    nativeToolsExtension(api);
    const writeManyTool = required(api.registeredTools.find((tool) => tool.name === "write_many"), "write_many tool");
    const renderedCall = renderToolCall(writeManyTool, {
      writes: [
        { path: "one.txt", content: "alpha\n" },
        { path: "nested/two.txt", content: "beta" }
      ]
    });
    assert.match(renderedCall, /⏺ Write\(one\.txt:1:2, nested\/two\.txt:1:1\)/);
    const renderedResult = renderToolResult(writeManyTool, result);
    assert.match(renderedResult, new RegExp(`⎿ Wrote ${escapeRegExp(oneId)} one\\.txt:1:2, ${escapeRegExp(twoId)} nested\\/two\\.txt:1:1 \\(10 B\\)`));
  });
});

test("write_many rejects duplicate resolved paths", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      writeMany(createContext(dir), {
        writes: [
          { path: "same.txt", content: "first" },
          { path: "./same.txt", content: "second" }
        ]
      }),
      /same resolved path/
    );
  });
});

test("read_many reads independent files with per-file offset and limit", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "alpha.txt"), "a1\na2\na3\na4\n", "utf8");
    await writeFile(path.join(dir, "beta.txt"), "b1\nb2\nb3", "utf8");

    const result = await readMany(createContext(dir), {
      files: [
        { path: "@alpha.txt", offset: 2, limit: 2 },
        { path: "beta.txt", limit: 1 }
      ]
    });

    assert.equal(result.details.files[0].offset, 2);
    assert.equal(result.details.files[0].requestedLimit, 2);
    assert.equal(result.details.files[0].truncation.nextOffset, 4);
    assert.deepEqual(result.details.files[0].previewLines, ["a2", "a3"]);
    assert.equal(result.details.files[1].truncation.nextOffset, 2);

    const text = textFromResult(result);
    assert.match(text, /--- @alpha\.txt \(lines 2-3 of 5\) ---\na2\na3/);
    assert.match(text, /continue with offset=4/);
    assert.match(text, /--- beta\.txt \(lines 1-1 of 3\) ---\nb1/);

    const api = createFakeApi([], []);
    nativeToolsExtension(api);
    const readManyTool = required(api.registeredTools.find((tool) => tool.name === "read_many"), "read_many tool");
    const renderedCall = renderToolCall(readManyTool, {
      files: [
        { path: "@alpha.txt", offset: 2, limit: 2 },
        { path: "beta.txt", limit: 1 }
      ]
    });
    assert.match(renderedCall, /⏺ Read\(@alpha\.txt:2:3, beta\.txt:1:1\)/);
    const renderedResult = renderToolResult(readManyTool, result);
    assert.match(renderedResult, /⎿ Read @alpha\.txt:2:3, beta\.txt:1:1/);
    assert.doesNotMatch(renderedResult, /"a2"|"a3"|b1/);
  });
});

test("read_many keeps uncapped model-facing reads separate from minimal display", async () => {
  await withTempDir(async (dir) => {
    const lines = Array.from({ length: 6000 }, (_value, index) => `line-${index + 1}`);
    await writeFile(path.join(dir, "long.txt"), lines.join("\n"), "utf8");

    const result = await readMany(createContext(dir), {
      files: [{ path: "long.txt", limit: 6000 }]
    });

    assert.equal(result.details.files[0].truncation.outputLines, 6000);
    assert.equal(result.details.files[0].truncation.truncated, false);
    assert.match(textFromResult(result), /line-6000/);

    const api = createFakeApi([], []);
    nativeToolsExtension(api);
    const readManyTool = required(api.registeredTools.find((tool) => tool.name === "read_many"), "read_many tool");
    const renderedResult = renderToolResult(readManyTool, result);
    assert.match(renderedResult, /⎿ Read long\.txt:1:6000/);
    assert.doesNotMatch(renderedResult, /line-6000/);
  });
});

test("read_many rejects offsets beyond the file", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "short.txt"), "one\ntwo", "utf8");

    await assert.rejects(
      readMany(createContext(dir), {
        files: [{ path: "short.txt", offset: 4 }]
      }),
      /beyond end of file/
    );
  });
});

test("read_many returns content beyond the previous byte display cap", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "long.txt"), `${"x".repeat(60 * 1024)}\nnext`, "utf8");

    const result = await readMany(createContext(dir), {
      files: [{ path: "long.txt" }]
    });

    assert.equal(result.details.files[0].truncation.truncated, false);
    assert.equal(result.details.files[0].truncation.outputLines, 2);
    assert.ok(result.details.files[0].truncation.outputBytes > 50 * 1024);
    assert.match(textFromResult(result), /next/);
  });
});

test("edit_many applies exact replacements across files and preserves original line endings", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "unix.txt"), "red\ngreen\nblue\n", "utf8");
    await writeFile(path.join(dir, "windows.txt"), "\uFEFFfirst\r\nsecond\r\nthird", "utf8");

    const result = await editMany(createContext(dir), {
      files: [
        {
          path: "unix.txt",
          edits: [
            { oldText: "green", newText: "yellow" },
            { oldText: "blue", newText: "purple" }
          ]
        },
        {
          path: "windows.txt",
          edits: [{ oldText: "second\nthird", newText: "changed\nthird" }]
        }
      ]
    });

    const unixId = nativeEditMutationEntryId({
      path: "unix.txt",
      edits: [
        { oldText: "green", newText: "yellow" },
        { oldText: "blue", newText: "purple" }
      ]
    });
    const windowsId = nativeEditMutationEntryId({ path: "windows.txt", edits: [{ oldText: "second\nthird", newText: "changed\nthird" }] });
    assert.match(unixId, /^m_[a-f0-9]{12}$/);
    assert.deepEqual(result.details.files.map((file) => [file.id, file.path, file.replacements]), [
      [unixId, "unix.txt", 2],
      [windowsId, "windows.txt", 1]
    ]);
    assert.deepEqual(result.details.files.map((file) => [file.id, file.path, file.ranges]), [
      [unixId, "unix.txt", [{ startLine: 2, endLine: 2 }, { startLine: 3, endLine: 3 }]],
      [windowsId, "windows.txt", [{ startLine: 2, endLine: 3 }]]
    ]);
    assert.equal(await readFile(path.join(dir, "unix.txt"), "utf8"), "red\nyellow\npurple\n");
    assert.equal(await readFile(path.join(dir, "windows.txt"), "utf8"), "\uFEFFfirst\r\nchanged\r\nthird");

    const api = createFakeApi([], []);
    nativeToolsExtension(api);
    const editManyTool = required(api.registeredTools.find((tool) => tool.name === "edit_many"), "edit_many tool");
    const renderedCall = renderToolCall(editManyTool, {
      files: [
        { path: "unix.txt", edits: [{ oldText: "green", newText: "yellow" }, { oldText: "blue", newText: "purple" }] },
        { path: "windows.txt", edits: [{ oldText: "second\nthird", newText: "changed\nthird" }] }
      ]
    });
    assert.match(renderedCall, /⏺ Update\(unix\.txt \(2\), windows\.txt \(1\); 3 edits\)/);
    const renderedResult = renderToolResult(editManyTool, result);
    assert.match(renderedResult, new RegExp(`⎿ Updated ${escapeRegExp(unixId)} unix\\.txt:2:3, ${escapeRegExp(windowsId)} windows\\.txt:2:3 with 3 edits`));
  });
});

test("edit_many rejects non-unique, missing, duplicate-path, and overlapping edits", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "target.txt"), "alpha beta alpha", "utf8");
    await writeFile(path.join(dir, "overlap.txt"), "abcdef", "utf8");

    const nonUniqueId = nativeEditMutationEntryId({ path: "target.txt", edits: [{ oldText: "alpha", newText: "omega" }] });
    await assert.rejects(
      editMany(createContext(dir), {
        files: [{ path: "target.txt", edits: [{ oldText: "alpha", newText: "omega" }] }]
      }),
      new RegExp(`${escapeRegExp(nonUniqueId)} target\\.txt: oldText is not unique`)
    );

    const missingId = nativeEditMutationEntryId({ path: "target.txt", edits: [{ oldText: "missing", newText: "omega" }] });
    await assert.rejects(
      editMany(createContext(dir), {
        files: [{ path: "target.txt", edits: [{ oldText: "missing", newText: "omega" }] }]
      }),
      new RegExp(`${escapeRegExp(missingId)} target\\.txt: oldText was not found`)
    );

    await assert.rejects(
      editMany(createContext(dir), {
        files: [
          { path: "target.txt", edits: [{ oldText: "beta", newText: "delta" }] },
          { path: "./target.txt", edits: [{ oldText: "beta", newText: "delta" }] }
        ]
      }),
      /same resolved path/
    );

    const overlapId = nativeEditMutationEntryId({ path: "overlap.txt", edits: [{ oldText: "abc", newText: "x" }, { oldText: "bcd", newText: "y" }] });
    await assert.rejects(
      editMany(createContext(dir), {
        files: [{ path: "overlap.txt", edits: [{ oldText: "abc", newText: "x" }, { oldText: "bcd", newText: "y" }] }]
      }),
      new RegExp(`${escapeRegExp(overlapId)} overlap\\.txt: Overlapping edits`)
    );
  });
});

test("buildNativeToolsSystemPrompt preserves the assembled prompt opaquely and appends only owned skill guidance", () => {
  const prompt = [
    "You are an expert coding assistant operating inside pi.",
    "",
    "Available tools:",
    "- sentinel_tool: SENTINEL_TOOL_SNIPPET",
    "",
    "Guidelines:",
    "- SENTINEL_TOOL_GUIDELINE",
    "",
    "Pi documentation: SENTINEL_PI_DOCS",
    "",
    "<project_context>",
    "<project_instructions path=\"/repo/AGENTS.md\">",
    "SENTINEL_AGENTS Available tools: Guidelines: Current date:",
    "</project_instructions>",
    "</project_context>",
    "",
    "SENTINEL_CHILD_APPEND_ROLE_AND_CONFINEMENT",
    "Current date: 2026-07-20",
    "Current working directory: /repo"
  ].join("\n");
  const skills: Skill[] = [
    {
      name: "pi-agent",
      description: "Use for Pi <agent> & config",
      filePath: "/repo/skills/pi-agent/SKILL.md",
      baseDir: "/repo/skills/pi-agent",
      disableModelInvocation: false,
      sourceInfo: {} as Skill["sourceInfo"]
    }
  ];

  const result = buildNativeToolsSystemPrompt(prompt, { skills });

  assert.equal(result.slice(0, prompt.length), prompt);
  assert.match(result, /SENTINEL_TOOL_SNIPPET/);
  assert.match(result, /SENTINEL_TOOL_GUIDELINE/);
  assert.match(result, /SENTINEL_PI_DOCS/);
  assert.match(result, /SENTINEL_AGENTS Available tools: Guidelines: Current date:/);
  assert.match(result, /SENTINEL_CHILD_APPEND_ROLE_AND_CONFINEMENT/);
  assert.doesNotMatch(result, /Batch-native tool usage:/);
  assert.match(result, /Use read_many with files/);
  assert.match(result, /<name>pi-agent<\/name>/);
  assert.match(result, /Use for Pi &lt;agent&gt; &amp; config/);
});

test("buildNativeToolsSystemPrompt restores structured tool guidance for a custom base prompt", () => {
  const prompt = "SENTINEL_CUSTOM_BASE\nSENTINEL_CONTEXT_AND_APPEND";
  const result = buildNativeToolsSystemPrompt(prompt, {
    customPrompt: "SENTINEL_CUSTOM_BASE",
    selectedTools: ["shell_start", "hidden_tool"],
    toolSnippets: {
      shell_start: "SENTINEL_SHELL_SNIPPET",
      unselected_tool: "MUST_NOT_APPEAR"
    },
    promptGuidelines: [
      "shell_start use: SENTINEL_SHELL_GUIDELINE",
      " shell_start use: SENTINEL_SHELL_GUIDELINE "
    ],
    skills: []
  });

  assert.equal(result.slice(0, prompt.length), prompt);
  assert.match(result, /Available tools:\n- shell_start: SENTINEL_SHELL_SNIPPET/);
  assert.doesNotMatch(result, /hidden_tool:/);
  assert.doesNotMatch(result, /MUST_NOT_APPEAR/);
  assert.equal(result.match(/shell_start use: SENTINEL_SHELL_GUIDELINE/g)?.length, 1);
  assert.match(result, /- Be concise in your responses/);
  assert.match(result, /- Show file paths clearly when working with files/);
});

test("native tool policy reconciles before prompt construction and blocks stock tool execution", () => {
  const api = createFakeApi(
    ["read", "bash", "edit", "write", "searxng_search"],
    ["read", "bash", "edit", "write", "searxng_search", "read_many", "search_many", "write_many", "edit_many", "web_fetch_many", "shell_start", "shell_status", "shell_read", "shell_cancel"]
  );
  nativeToolsExtension(api);

  const input = required(api.handlers.get("input")?.[0], "input policy handler");
  input({ type: "input", text: "hello", source: "interactive" }, createContext("/repo"));
  assert.deepEqual(api.getActiveTools(), [
    "searxng_search",
    "read_many",
    "search_many",
    "write_many",
    "edit_many",
    "web_fetch_many",
    "shell_start",
    "shell_status",
    "shell_read",
    "shell_cancel"
  ]);

  const guard = required(api.handlers.get("tool_call")?.[0], "stock tool guard");
  for (const toolName of ["bash", "read", "write", "edit"]) {
    const result = guard({ type: "tool_call", toolName, toolCallId: "tc1", input: {} }, createContext("/repo"));
    assert.equal(result.block, true);
    assert.match(result.reason, new RegExp(`stock ${toolName} tool is disabled`));
  }
  assert.equal(guard({ type: "tool_call", toolName: "read_many", toolCallId: "tc2", input: {} }, createContext("/repo")), undefined);
});
