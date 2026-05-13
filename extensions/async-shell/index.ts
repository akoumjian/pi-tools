import { spawn, type ChildProcessByStdio } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { Type, type Static } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerCommandWithAliases } from "../_shared/deprecated-command.js";

type JobStatus = "running" | "exited" | "failed" | "cancelled" | "unknown";
type OutputStreamName = "stdout" | "stderr";

type JobOutput = {
  stdout: string;
  stderr: string;
};

type JobMeta = {
  jobId: string;
  job_name?: string;
  command: string;
  cwd: string;
  shell: string;
  status: JobStatus;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  notifyOnExit: boolean;
  completionNotified: boolean;
  logDir: string;
  stdoutLog: string;
  stderrLog: string;
  outputBytes: {
    stdout: number;
    stderr: number;
  };
};

type CompletionDeliveryContext = {
  isIdle: () => boolean;
};

type JobRuntime = JobMeta & {
  process: ChildProcessByStdio<null, Readable, Readable>;
  waiters: Array<() => void>;
  activeWaiters: number;
  // Suppresses completion notices until shell_start returns its in-band result.
  startResultPending: boolean;
  cancelRequested: boolean;
  completionContext: CompletionDeliveryContext;
};

type JobSummaryDetails = {
  job: JobMeta;
  output: JobOutput;
};

type JobListDetails = {
  jobs: JobMeta[];
};

type StartJobDetails = {
  job: JobMeta;
  output: JobOutput;
};

type StartDetails = {
  jobs: StartJobDetails[];
};

type StartUpdate = (partial: AgentToolResult<StartDetails>) => void;

type CompletionNotificationTarget = {
  notifyOnExit: boolean;
  completionNotified: boolean;
};

type CompletionNotificationOptions = {
  isReady: () => boolean;
  markNotified: () => void;
  queue: () => void;
};

type CommandSpec = {
  command: string;
  cwd: string;
  job_name?: string;
  shell?: string;
  notifyOnExit?: boolean;
};

const START_WAIT_FOR_COMPLETION_SECONDS = 6;
const START_RESULT_TAIL_MAX_LINES = 200;
const START_RESULT_TAIL_MAX_CHARS = 20000;
const SHELL_STATUS_DEFAULT_TAIL_LINES = 40;
const SHELL_TAIL_DEFAULT_LINES = 80;
const SHELL_TAIL_MAX_LINES = 500;
const SHELL_TAIL_MIN_CHARS = 1000;
const SHELL_TAIL_DEFAULT_MAX_CHARS = 20000;
const SHELL_TAIL_MAX_CHARS = 120000;
const NOTIFICATION_TAIL_LINES = 8;
const NOTIFICATION_TAIL_MAX_CHARS = 2000;
const COMPLETION_BATCH_FLUSH_DELAY_MS = 100;
const CommandItem = Type.Object({
  command: Type.String({ minLength: 1, description: "Shell command to start." }),
  cwd: Type.String({ minLength: 1, description: "Working directory for this command. Use per-command cwd; shell_start has no top-level cwd." }),
  job_name: Type.Optional(Type.String({ minLength: 1, description: "Optional human-readable name for this job." })),
  shell: Type.Optional(Type.String({ description: "Shell executable for this command. Defaults to $SHELL or /bin/zsh." })),
  notifyOnExit: Type.Optional(Type.Boolean({ default: true, description: "Defaults to true. When this command is still running after shell_start returns, append a per-job completion notice when it exits. Set false only when you do not care about this command's result." }))
}, { additionalProperties: false });

const StartParams = Type.Object({
  commands: Type.Array(CommandItem, {
    minItems: 1,
    maxItems: 12,
    description: "Required list of shell commands to start from one tool call. Each item is an object with command and per-command cwd, and optional job_name, shell, or notifyOnExit. Multiple commands start in parallel, each command receives its own jobId, and a single call accepts at most 12 commands."
  }),
  tailLines: Type.Optional(Type.Number({ minimum: 1, maximum: START_RESULT_TAIL_MAX_LINES, default: SHELL_STATUS_DEFAULT_TAIL_LINES, description: "Output lines per stream to include in the shell_start result after the fixed short wait. Max 200; result text also includes stdout_log/stderr_log paths for older or targeted output." }))
}, { additionalProperties: false });

const StatusParams = Type.Object({
  jobId: Type.Optional(Type.String({ minLength: 1, description: "Async shell job id. Omit to list active and recent jobs." })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20, description: "When jobId is omitted, maximum number of recent jobs to list." })),
  tailLines: Type.Optional(Type.Number({ minimum: 1, maximum: SHELL_TAIL_MAX_LINES, default: SHELL_STATUS_DEFAULT_TAIL_LINES, description: "When jobId is set, recent output lines per stream to include. Max 500; for older or targeted output use the returned stdout_log/stderr_log paths with search_many or read_many." }))
}, { additionalProperties: false });

const TailParams = Type.Object({
  jobId: Type.String({ minLength: 1, description: "Async shell job id." }),
  stream: Type.Optional(Type.Union([Type.Literal("stdout"), Type.Literal("stderr")], { description: "Optional stream to read. Omit to read stdout and stderr separately." })),
  lines: Type.Optional(Type.Number({ minimum: 1, maximum: SHELL_TAIL_MAX_LINES, default: SHELL_TAIL_DEFAULT_LINES, description: "Maximum output lines per selected stream, from the recent tail. shell_tail is capped at 500 lines; use stdout_log/stderr_log with search_many or read_many for older ranges." })),
  maxChars: Type.Optional(Type.Number({ minimum: SHELL_TAIL_MIN_CHARS, maximum: SHELL_TAIL_MAX_CHARS, default: SHELL_TAIL_DEFAULT_MAX_CHARS, description: "Maximum bytes to read per selected stream before line trimming. Max 120 KB per stream." }))
}, { additionalProperties: false });

const CancelParams = Type.Object({
  jobId: Type.String({ minLength: 1, description: "Async shell job id." }),
  signal: Type.Optional(Type.Union([Type.Literal("SIGTERM"), Type.Literal("SIGINT"), Type.Literal("SIGKILL")], { default: "SIGTERM", description: "Signal to send to the job process group." }))
}, { additionalProperties: false });

type StartInput = Static<typeof StartParams>;
type StatusInput = Static<typeof StatusParams>;
type TailInput = Static<typeof TailParams>;
type CancelInput = Static<typeof CancelParams>;

const jobs = new Map<string, JobRuntime>();
const scheduledCompletionNotifications = new WeakSet<CompletionNotificationTarget>();
const pendingCompletionNotifications = new Map<string, JobRuntime>();
let completionBatchFlushTimer: NodeJS.Timeout | undefined;
let latestCompletionContext: CompletionDeliveryContext | undefined;

export default function asyncShellExtension(api: ExtensionAPI): void {
  registerCommandWithAliases(
    api,
    "async:status",
    {
      description: "Show async-shell job storage and recent job diagnostics",
      handler: async (_args, context) => {
        context.ui.notify(buildAsyncShellStatusText(context), "info");
      }
    },
    []
  );

  api.registerMessageRenderer("async-shell", (message, options, theme) => {
    return renderAsyncShellMessage(message.details, options, theme);
  });

  api.on("message_end", (event, context) => {
    if (event.message.role === "user") {
      flushCompletionNotificationBatch(api, createCompletionDeliveryContext(context), { allowActive: true });
    }
  });
  api.on("turn_end", (_event, context) => {
    flushCompletionNotificationBatch(api, createCompletionDeliveryContext(context), { allowActive: true });
  });
  api.on("agent_end", (_event, context) => {
    scheduleCompletionBatchFlush(api, createCompletionDeliveryContext(context));
  });

  api.registerTool(defineTool({
    name: "shell_start",
    label: "Async Shell Start",
    description: [
      "Use shell_start for shell commands. Pass inputs as commands: [...].",
      "Start independent shell work together in one commands list instead of making serial shell_start calls; split into separate calls only when commands depend on previous output, must run in order, or are not safe to run concurrently.",
      "Each command item must include its own command and cwd, and starts as a durable async job with its own jobId, status, cwd, logs, and stdout/stderr output. Standard input is ignored, so do not use shell_start for interactive commands.",
      "Results are grouped per job as { jobs: Array<{ job: JobMeta, output: { stdout: string, stderr: string } }> }. A single shell_start call accepts at most 12 commands.",
      `shell_start waits only for a fixed ${START_WAIT_FOR_COMPLETION_SECONDS}s grace period: jobs that finish quickly return in-band; unfinished jobs continue in the background and, by default, append completion notices when they exit.`,
      "In-band shell_start results include compact job fields, stdout_log/stderr_log paths, and bounded stdout/stderr tails. Completion notices are short result notices with log paths, batched into history/TUI, then Pi triggers one assistant turn for each flushed batch; use shell_tail for recent output and search/read log paths for older or targeted output. Start-result output is capped by tailLines and about 20 KB per stream.",
      "Continue useful work while jobs run. If there is no useful work, stop after reporting that jobs are running; completion notices will appear in history and resume the agent. Do not poll or wait.",
      "Set per-command notifyOnExit:false only when the result is unimportant.",
      "Use shell_status to inspect jobs and shell_tail to read recent output after a result/notification, or only when necessary for a specific active job; use search_many/read_many on stdout_log/stderr_log for older or targeted log output. Do not use status/tail for polling."
    ].join(" "),
    promptSnippet: "Run shell commands as durable async jobs. Start independent shell work together in one commands list, keep doing useful work, and rely on per-job completion notices instead of polling.",
    promptGuidelines: [
      "Use shell_start for shell commands instead of bash.",
      "Start independent shell work together in one commands list instead of making serial shell_start calls; split into separate calls only when commands depend on previous output, must run in order, or are not safe to run concurrently.",
      "Each command item must include its own command and cwd. Use optional job_name only when a short human-readable name helps distinguish concurrent jobs. Standard input is ignored, so avoid interactive commands.",
      "Prefer search_many for code/file discovery. If using shell_start for custom search, start with rg --files, rg -n, git grep -n, or bounded find before reading file contents.",
      `shell_start waits only for a fixed ${START_WAIT_FOR_COMPLETION_SECONDS}s grace period; there is no wait parameter. Jobs that do not finish in-band continue in the background and append per-job completion notices by default.`,
      "Set per-command notifyOnExit:false only when the result is unimportant.",
      "Async-shell completion notices are short result notices with stdout_log/stderr_log paths, batched into history/TUI before Pi resumes the agent once for the flushed batch. Use shell_tail for recent output; use search_many/read_many on log paths for older or targeted output. Do not paste raw shell output unless explicitly requested.",
      "Continue useful work while jobs run; if there is no useful work, stop after reporting that jobs are running and let the completion batch resume the agent. Do not poll or wait. Use shell_status and shell_tail only after a result/notification or when necessary for a specific active job."
    ],
    parameters: StartParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_toolCallId, params, _signal, onUpdate, context): Promise<AgentToolResult<StartDetails>> {
      return startJobs(api, context, params, onUpdate);
    },
    renderCall(args, theme) {
      return renderShellStartCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderShellStartResult(result, options, theme, context);
    }
  }));

  api.registerTool(defineTool({
    name: "shell_status",
    label: "Async Shell Status",
    description: "Get async shell job status. Pass jobId for one job; omit jobId to list active and recent jobs. Single-job results include job metadata, stdout_log/stderr_log paths, and bounded recent output; use search_many/read_many on log paths for older or targeted output. Single-job result details shape: { job: JobMeta, output: { stdout: string, stderr: string } }. List result details shape: { jobs: JobMeta[] }.",
    promptSnippet: "Check one async shell job by jobId, or omit jobId to list active/recent jobs.",
    parameters: StatusParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_toolCallId, params: StatusInput, _signal, _onUpdate, context): Promise<AgentToolResult<JobSummaryDetails | JobListDetails>> {
      if (params.jobId === undefined) {
        const jobsList = listJobs(context, params.limit ?? 20);
        return {
          content: [{ type: "text", text: formatJobList(jobsList) }],
          details: { jobs: jobsList }
        };
      }

      const job = requireJob(context, params.jobId);
      return jobResult(job, "Job status", params.tailLines ?? SHELL_STATUS_DEFAULT_TAIL_LINES);
    },
    renderCall(args, theme) {
      if (args.jobId === undefined) {
        return new Text(claudeToolCall("Status", `last ${args.limit ?? 20}`, theme), 0, 0);
      }
      return renderJobCall("Status", args.jobId, theme);
    },
    renderResult(result, options, theme, context) {
      return renderShellStatusResult(result, options, theme, context);
    }
  }));

  api.registerTool(defineTool({
    name: "shell_tail",
    label: "Async Shell Tail",
    description: "Read recent output from one async shell job log by jobId. Choose stdout or stderr, or omit stream to read both separately. shell_tail returns only the tail: max 500 lines and 120 KB per selected stream. For older or targeted output, use the returned stdout_log/stderr_log paths with search_many, then read_many with offset/limit. Result details shape: { job: JobMeta, output: { stdout: string, stderr: string } }.",
    promptSnippet: "Read recent stdout/stderr output from an async shell job; use log paths with search_many/read_many for older ranges.",
    parameters: TailParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_toolCallId, params, _signal, _onUpdate, context): Promise<AgentToolResult<JobSummaryDetails>> {
      const job = requireJob(context, params.jobId);
      acknowledgeObservedJobCompletion(job);
      const stream = params.stream as OutputStreamName | undefined;
      const title = stream === undefined ? "Recent output" : `Recent ${stream} output`;
      return jobResult(job, title, params.lines ?? SHELL_TAIL_DEFAULT_LINES, stream, params.maxChars ?? SHELL_TAIL_DEFAULT_MAX_CHARS);
    },
    renderCall(args, theme) {
      const stream = args.stream ?? "stdout/stderr";
      const lines = args.lines ?? SHELL_TAIL_DEFAULT_LINES;
      return new Text(claudeToolCall("Tail", `${shortDisplayId(args.jobId)} ${stream} ${lines} lines`, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return renderJobSummaryResult(result, options, theme, context, "tail");
    }
  }));

  api.registerTool(defineTool({
    name: "shell_cancel",
    label: "Async Shell Cancel",
    description: "Cancel one async shell job by jobId using SIGTERM, SIGINT, or SIGKILL. Result details shape: { job: JobMeta, output: { stdout: string, stderr: string } }.",
    promptSnippet: "Terminate an async shell job started by Pi.",
    parameters: CancelParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_toolCallId, params, _signal, _onUpdate, context): Promise<AgentToolResult<JobSummaryDetails>> {
      const job = requireActiveJob(context, params.jobId);
      cancelJob(job, params.signal ?? "SIGTERM");
      return jobResult(job, "Cancellation requested", 80);
    },
    renderCall(args, theme) {
      return new Text(claudeToolCall("Cancel", `${shortDisplayId(args.jobId)} ${args.signal ?? "SIGTERM"}`, theme), 0, 0);
    },
    renderResult(result, options, theme, context) {
      return renderJobSummaryResult(result, options, theme, context, "cancel requested");
    }
  }));

}

async function startJobs(api: ExtensionAPI, context: ExtensionContext, input: StartInput, onUpdate: StartUpdate | undefined): Promise<AgentToolResult<StartDetails>> {
  const specs = normalizeCommandSpecs(input);

  const runtimes = specs.map((spec) => startJob(api, context, {
    command: spec.command,
    cwd: spec.cwd,
    job_name: spec.job_name,
    shell: spec.shell,
    notifyOnExit: spec.notifyOnExit ?? true
  }));

  onUpdate?.(partialStartResult(runtimes));

  await waitForJobsWithUpdates(runtimes, secondsToMilliseconds(START_WAIT_FOR_COMPLETION_SECONDS), onUpdate);

  finishStartGracePeriod(runtimes);
  return startResult(runtimes, input.tailLines ?? 40);
}

function startJob(
  api: ExtensionAPI,
  context: ExtensionContext,
  input: CommandSpec & {
    notifyOnExit: boolean;
  }
): JobRuntime {
  const cwd = resolveCwd(context, input.cwd);
  const shell = input.shell?.trim() || process.env.SHELL || "/bin/zsh";
  const jobId = createJobId();
  const root = jobsRoot(context.cwd);
  const logDir = path.join(root, "jobs", jobId);

  mkdirSync(logDir, { recursive: true });

  const startedAtMs = Date.now();
  const job = createJobMeta({
    jobId,
    job_name: input.job_name,
    command: input.command,
    cwd,
    shell,
    logDir,
    startedAtMs,
    notifyOnExit: input.notifyOnExit ?? true
  });

  writeMeta(job);

  const child = spawn(shell, ["-lc", input.command], {
    cwd,
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const runtime: JobRuntime = {
    ...job,
    process: child,
    waiters: [],
    activeWaiters: 0,
    startResultPending: true,
    cancelRequested: false,
    completionContext: createCompletionDeliveryContext(context),
    pid: child.pid
  };

  jobs.set(jobId, runtime);
  writeMeta(runtime);

  child.stdout.on("data", (chunk: Buffer) => appendOutput(runtime, "stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => appendOutput(runtime, "stderr", chunk));
  child.on("error", (error) => finalizeJob(api, runtime, "failed", undefined, undefined, error.message));
  child.on("close", (code, signal) => {
    const status = runtime.cancelRequested ? "cancelled" : code === 0 ? "exited" : "failed";
    finalizeJob(api, runtime, status, code, signal);
  });

  child.unref();

  return runtime;
}

function createJobMeta(input: {
  jobId: string;
  job_name?: string;
  command: string;
  cwd: string;
  shell: string;
  logDir: string;
  startedAtMs: number;
  notifyOnExit: boolean;
}): JobMeta {
  return {
    jobId: input.jobId,
    job_name: input.job_name,
    command: input.command,
    cwd: input.cwd,
    shell: input.shell,
    status: "running",
    startedAt: new Date(input.startedAtMs).toISOString(),
    notifyOnExit: input.notifyOnExit,
    completionNotified: false,
    logDir: input.logDir,
    stdoutLog: path.join(input.logDir, "stdout.log"),
    stderrLog: path.join(input.logDir, "stderr.log"),
    outputBytes: {
      stdout: 0,
      stderr: 0
    }
  };
}

function appendOutput(job: JobRuntime, stream: OutputStreamName, chunk: Buffer): void {
  const rawLog = stream === "stdout" ? job.stdoutLog : job.stderrLog;

  appendFileSync(rawLog, chunk);
  job.outputBytes[stream] += chunk.length;
}

function finalizeJob(
  api: ExtensionAPI,
  job: JobRuntime,
  status: JobStatus,
  exitCode: number | null | undefined,
  signal: NodeJS.Signals | null | undefined,
  error?: string
): void {
  if (isTerminal(job.status)) {
    return;
  }

  const endedAtMs = Date.now();
  job.status = status;
  job.endedAt = new Date(endedAtMs).toISOString();
  job.durationMs = endedAtMs - Date.parse(job.startedAt);
  job.exitCode = exitCode;
  job.signal = signal;
  job.error = error;
  writeMeta(job);

  for (const resolve of job.waiters.splice(0)) {
    resolve();
  }

  scheduleCompletionNotification(api, job);
}

function scheduleCompletionNotification(api: ExtensionAPI, job: JobRuntime): void {
  scheduleCompletionFollowUp(job, {
    isReady: () => !job.startResultPending && job.activeWaiters === 0,
    markNotified: () => writeMeta(job),
    queue: () => queueCompletionNotification(api, job)
  });
}

function scheduleCompletionFollowUp(target: CompletionNotificationTarget, options: CompletionNotificationOptions): void {
  if (!target.notifyOnExit || target.completionNotified || scheduledCompletionNotifications.has(target)) {
    return;
  }

  scheduledCompletionNotifications.add(target);
  setTimeout(() => {
    scheduledCompletionNotifications.delete(target);

    // The timer intentionally runs after waiter promises and shell_start's
    // finishStartGracePeriod() continuation have had a chance to suppress an
    // in-band result. The inner latch check is still required because multiple
    // job finalizers can schedule work before any timer callback runs.
    if (target.completionNotified || !options.isReady()) {
      return;
    }

    target.completionNotified = true;
    options.markNotified();
    options.queue();
  }, 0);
}

function queueCompletionNotification(api: ExtensionAPI, job: JobRuntime): void {
  pendingCompletionNotifications.set(job.jobId, job);
  scheduleCompletionBatchFlush(api, job.completionContext);
}

function scheduleCompletionBatchFlush(api: ExtensionAPI, context: CompletionDeliveryContext): void {
  latestCompletionContext = context;
  if (completionBatchFlushTimer !== undefined) {
    return;
  }

  completionBatchFlushTimer = setTimeout(() => {
    completionBatchFlushTimer = undefined;
    flushCompletionNotificationBatch(api, latestCompletionContext, { allowActive: false });
  }, COMPLETION_BATCH_FLUSH_DELAY_MS);
}

function flushCompletionNotificationBatch(api: ExtensionAPI, context: CompletionDeliveryContext | undefined, options: { allowActive: boolean }): void {
  if (pendingCompletionNotifications.size === 0) {
    return;
  }
  if (!options.allowActive && context !== undefined && !context.isIdle()) {
    return;
  }

  const entries = Array.from(pendingCompletionNotifications.values()).map((job) => ({
    job: publicJob(job),
    output: readJobOutput(job, NOTIFICATION_TAIL_LINES, NOTIFICATION_TAIL_MAX_CHARS)
  }));
  pendingCompletionNotifications.clear();

  try {
    api.sendMessage(
      {
        customType: "async-shell",
        content: formatCompletionBatchMessage(entries.map((entry) => entry.job)),
        display: true,
        details: entries.length === 1 ? entries[0] : { jobs: entries }
      },
      { triggerTurn: true, deliverAs: "steer" }
    );
  } catch {
    // Pi may be shutting down; the persisted logs still hold the result.
  }
}

function createCompletionDeliveryContext(context: Partial<Pick<ExtensionContext, "isIdle">> | undefined): CompletionDeliveryContext {
  const isIdle = typeof context?.isIdle === "function"
    ? () => context.isIdle?.() === true
    : () => true;
  return { isIdle };
}

function formatCompletionMessage(job: JobMeta): string {
  return [
    `async shell result: ${formatShellJobStatus(job)}`,
    formatCompletionAccess(job)
  ].join("\n");
}

function formatCompletionBatchMessage(jobsList: JobMeta[]): string {
  if (jobsList.length === 1) {
    return formatCompletionMessage(jobsList[0]);
  }

  return [
    `async shell results: ${jobsList.length} jobs completed`,
    ...jobsList.map((job) => `- ${formatShellJobStatus(job)}\n  ${indentLines(formatCompletionAccess(job), "  ")}`)
  ].join("\n");
}

function formatCompletionAccess(job: JobMeta): string {
  return [
    `stdout_log: ${job.stdoutLog}`,
    `stderr_log: ${job.stderrLog}`,
    `more: shell_tail jobId=${job.jobId} (recent output; max ${SHELL_TAIL_MAX_LINES} lines)`,
    "older_output: use search_many/read_many on stdout_log or stderr_log for older or targeted log output"
  ].join("\n");
}

function indentLines(text: string, indent: string): string {
  return text.split("\n").join(`\n${indent}`);
}

function formatJobMessage(job: JobMeta, output: JobOutput, tailLines: number, maxChars: number, stream?: OutputStreamName): string {
  return [
    formatJobMessageFields(job),
    formatJobOutputAccess(job, tailLines, maxChars, stream),
    formatJobMessageOutput(output, stream),
    `more: shell_tail jobId=${job.jobId} lines=${SHELL_TAIL_DEFAULT_LINES} (recent output; max ${SHELL_TAIL_MAX_LINES} lines)`
  ].filter((line) => line.length > 0).join("\n");
}

function formatJobMessageFields(job: JobMeta): string {
  const lines = [
    `job_id: ${job.jobId}`,
    job.job_name ? `job_name: ${job.job_name}` : undefined,
    `status: ${shellStatusText(job)}`,
    job.exitCode === undefined || job.exitCode === null ? undefined : `exit_code: ${job.exitCode}`,
    job.signal === undefined || job.signal === null ? undefined : `signal: ${job.signal}`,
    job.durationMs === undefined ? undefined : `duration: ${formatDuration(job.durationMs)}`,
    job.error === undefined ? undefined : `error: ${job.error}`,
    `cwd: ${job.cwd}`,
    `command: ${truncateOneLine(job.command, 160)}`
  ].filter((line): line is string => line !== undefined);

  return lines.join("\n");
}

function formatJobOutputAccess(job: JobMeta, tailLines: number, maxChars: number, stream?: OutputStreamName): string {
  const streams = selectedStreams(stream);
  return [
    ...streams.map((selected) => `${selected}_log: ${selected === "stdout" ? job.stdoutLog : job.stderrLog}`),
    `tail_window: showing last up to ${tailLines} line${tailLines === 1 ? "" : "s"} and ${formatBytes(maxChars)} per selected stream (shell_tail max ${SHELL_TAIL_MAX_LINES} lines / ${formatBytes(SHELL_TAIL_MAX_CHARS)}).`,
    "older_output: use search_many/read_many on stdout_log or stderr_log for older or targeted log output."
  ].join("\n");
}

function selectedStreams(stream?: OutputStreamName): OutputStreamName[] {
  if (stream === "stdout" || stream === "stderr") {
    return [stream];
  }
  return ["stdout", "stderr"];
}

function formatJobMessageOutput(output: JobOutput, stream?: OutputStreamName): string {
  const sections: string[] = [];
  const includeStdout = stream === "stdout" || (stream === undefined && output.stdout.length > 0);
  const includeStderr = stream === "stderr" || (stream === undefined && output.stderr.length > 0);

  if (includeStdout) {
    sections.push("stdout:", fenced(output.stdout || "(no output)"));
  }
  if (includeStderr) {
    sections.push("stderr:", fenced(output.stderr || "(no output)"));
  }
  return sections.length === 0 ? "output: (no output)" : sections.join("\n");
}

function cancelJob(job: JobRuntime, signal: NodeJS.Signals): void {
  if (isTerminal(job.status)) {
    return;
  }

  job.cancelRequested = true;
  job.notifyOnExit = false;
  writeMeta(job);

  if (job.pid === undefined) {
    throw new Error(`Job ${job.jobId} has no process id to cancel.`);
  }

  try {
    process.kill(-job.pid, signal);
  } catch {
    process.kill(job.pid, signal);
  }
}

async function waitForJob(job: JobRuntime, timeoutMs: number): Promise<boolean> {
  if (isTerminal(job.status)) {
    return true;
  }

  job.activeWaiters += 1;
  try {
    return await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const done = () => {
        cleanup();
        resolve(true);
      };

      const cleanup = () => {
        clearTimeout(timeout);
        const index = job.waiters.indexOf(done);
        if (index !== -1) {
          job.waiters.splice(index, 1);
        }
      };

      job.waiters.push(done);
    });
  } finally {
    job.activeWaiters -= 1;
  }
}

async function waitForJobsWithUpdates(jobsList: JobRuntime[], timeoutMs: number, onUpdate: StartUpdate | undefined): Promise<void> {
  if (onUpdate === undefined) {
    await Promise.all(jobsList.map((job) => waitForJob(job, timeoutMs)));
    return;
  }

  const interval = setInterval(() => {
    onUpdate(partialStartResult(jobsList));
  }, 500);

  try {
    await Promise.all(jobsList.map((job) => waitForJob(job, timeoutMs)));
  } finally {
    clearInterval(interval);
    onUpdate(partialStartResult(jobsList));
  }
}

function readJobOutput(job: JobMeta, tailLines: number, maxChars: number, stream?: OutputStreamName): JobOutput {
  const lines = clampInteger(tailLines, 1, SHELL_TAIL_MAX_LINES);
  const chars = clampInteger(maxChars, SHELL_TAIL_MIN_CHARS, SHELL_TAIL_MAX_CHARS);
  return {
    stdout: stream === "stderr" ? "" : readLogTail(job.stdoutLog, lines, chars),
    stderr: stream === "stdout" ? "" : readLogTail(job.stderrLog, lines, chars)
  };
}

function jobResult(
  job: JobMeta,
  _title: string,
  tailLines: number,
  stream?: OutputStreamName,
  maxChars = SHELL_TAIL_DEFAULT_MAX_CHARS
): AgentToolResult<JobSummaryDetails> {
  const output = readJobOutput(job, tailLines, maxChars, stream);
  const lines = clampInteger(tailLines, 1, SHELL_TAIL_MAX_LINES);
  const chars = clampInteger(maxChars, SHELL_TAIL_MIN_CHARS, SHELL_TAIL_MAX_CHARS);
  const text = formatJobMessage(job, output, lines, chars, stream);

  return {
    content: [{ type: "text", text }],
    details: {
      job: publicJob(job),
      output
    }
  };
}

function startResult(jobsList: JobRuntime[], tailLines: number): AgentToolResult<StartDetails> {
  const jobsWithOutput = jobsList.map((job) => ({
    job: publicJob(job),
    output: readJobOutput(job, tailLines, START_RESULT_TAIL_MAX_CHARS)
  }));
  const lines = clampInteger(tailLines, 1, START_RESULT_TAIL_MAX_LINES);
  const text = jobsWithOutput
    .map(({ job, output }) => formatJobMessage(job, output, lines, START_RESULT_TAIL_MAX_CHARS))
    .join("\n\n");

  return {
    content: [{ type: "text", text }],
    details: {
      jobs: jobsWithOutput
    }
  };
}

function partialStartResult(jobsList: JobRuntime[]): AgentToolResult<StartDetails> {
  return {
    content: [{ type: "text", text: "Async shell jobs running." }],
    details: {
      jobs: jobsList.map((job) => ({
        job: publicJob(job),
        output: { stdout: "", stderr: "" }
      }))
    }
  };
}

function formatJobList(jobsList: JobMeta[]): string {
  if (jobsList.length === 0) {
    return "No async shell jobs for this project.";
  }

  return jobsList.map((job) => {
    const jobName = job.job_name ? ` (${job.job_name})` : "";
    const outcome = job.exitCode === undefined ? "" : ` exit=${job.exitCode}`;
    return `${job.jobId}${jobName}: ${job.status}${outcome}\n  ${job.command}\n  cwd: ${job.cwd}`;
  }).join("\n\n");
}

function requireJob(context: ExtensionContext, jobId: string): JobMeta {
  const active = jobs.get(jobId);
  if (active !== undefined) {
    return active;
  }

  const meta = readMeta(context, jobId);
  if (meta === undefined) {
    throw new Error(`Unknown async shell job: ${jobId}`);
  }

  if (meta.status === "running" && !isPidAlive(meta.pid)) {
    return { ...meta, status: "unknown", error: "Job was running in a previous Pi process and is no longer attached." };
  }

  return meta;
}

function requireActiveJob(context: ExtensionContext, jobId: string): JobRuntime {
  const job = jobs.get(jobId);
  if (job === undefined) {
    const meta = readMeta(context, jobId);
    if (meta === undefined) {
      throw new Error(`Unknown async shell job: ${jobId}`);
    }
    throw new Error(`Job ${jobId} is not attached to this Pi process; status is ${meta.status}.`);
  }

  return job;
}

function listJobs(context: ExtensionContext, limit: number): JobMeta[] {
  const root = path.join(jobsRoot(context.cwd), "jobs");
  const diskJobs = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readMetaFile(path.join(root, entry.name, "meta.json")))
      .filter((job): job is JobMeta => job !== undefined)
    : [];

  const activeJobs = Array.from(jobs.values()).map(publicJob);
  const byId = new Map<string, JobMeta>();
  for (const job of diskJobs) {
    byId.set(job.jobId, job);
  }
  for (const job of activeJobs) {
    byId.set(job.jobId, job);
  }

  return Array.from(byId.values())
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, clampInteger(limit, 1, 100));
}

function readMeta(context: ExtensionContext, jobId: string): JobMeta | undefined {
  return readMetaFile(path.join(jobsRoot(context.cwd), "jobs", jobId, "meta.json"));
}

function readMetaFile(metaPath: string): JobMeta | undefined {
  if (!existsSync(metaPath)) {
    return undefined;
  }

  const raw = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<JobMeta> & { label?: unknown };
  if (typeof raw.jobId !== "string" || typeof raw.command !== "string" || typeof raw.cwd !== "string") {
    return undefined;
  }

  const legacyName = raw.job_name === undefined && typeof raw.label === "string" && raw.label.trim() !== ""
    ? raw.label
    : undefined;
  return {
    ...raw,
    job_name: raw.job_name ?? legacyName
  } as JobMeta;
}

function writeMeta(job: JobMeta): void {
  mkdirSync(job.logDir, { recursive: true });
  writeFileSync(path.join(job.logDir, "meta.json"), `${JSON.stringify(publicJob(job), null, 2)}\n`);
}

function publicJob(job: JobMeta): JobMeta {
  return {
    jobId: job.jobId,
    job_name: job.job_name,
    command: job.command,
    cwd: job.cwd,
    shell: job.shell,
    status: job.status,
    pid: job.pid,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    durationMs: job.durationMs,
    exitCode: job.exitCode,
    signal: job.signal,
    error: job.error,
    notifyOnExit: job.notifyOnExit,
    completionNotified: job.completionNotified,
    logDir: job.logDir,
    stdoutLog: job.stdoutLog,
    stderrLog: job.stderrLog,
    outputBytes: job.outputBytes
  };
}

function normalizeCommandSpecs(input: StartInput): CommandSpec[] {
  if (input.commands.length === 0) {
    throw new Error("shell_start requires a non-empty commands list.");
  }

  return input.commands.map((item) => {
    const command = item.command.trim();
    const cwd = item.cwd.trim();
    if (command === "" || cwd === "") {
      throw new Error("shell_start commands require non-empty command and cwd fields.");
    }

    return {
      command,
      cwd,
      job_name: item.job_name,
      shell: item.shell,
      notifyOnExit: item.notifyOnExit
    };
  });
}

function finishStartGracePeriod(jobsList: JobRuntime[]): void {
  for (const job of jobsList.filter((candidate) => isTerminal(candidate.status))) {
    job.completionNotified = true;
    pendingCompletionNotifications.delete(job.jobId);
    writeMeta(job);
  }

  for (const job of jobsList) {
    job.startResultPending = false;
  }
}

function acknowledgeObservedJobCompletion(job: JobMeta): void {
  const runtime = jobs.get(job.jobId);
  if (runtime === undefined || !isTerminal(runtime.status)) {
    return;
  }

  runtime.completionNotified = true;
  pendingCompletionNotifications.delete(runtime.jobId);
  writeMeta(runtime);
}

function readLogTail(logFile: string, lines: number, maxChars: number): string {
  if (!existsSync(logFile)) {
    return "";
  }

  const size = statSync(logFile).size;
  const bytesToRead = Math.min(size, maxChars);
  const start = size - bytesToRead;
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(logFile, "r");
  try {
    readSync(fd, buffer, 0, bytesToRead, start);
  } finally {
    closeSync(fd);
  }

  return buffer.toString("utf8").trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}

function resolveCwd(context: ExtensionContext, requestedCwd: string | undefined): string {
  const base = path.resolve(context.cwd ?? process.cwd());
  if (requestedCwd === undefined || requestedCwd.trim() === "") {
    return base;
  }

  return path.resolve(base, expandHome(requestedCwd));
}

export function buildAsyncShellStatusText(context: Pick<ExtensionContext, "cwd">): string {
  const root = jobsRoot(context.cwd);
  const recentJobs = listJobs(context as ExtensionContext, 20);
  const running = recentJobs.filter((job) => job.status === "running").length;
  const terminal = recentJobs.length - running;
  return [
    "Async shell status",
    "",
    `Job root: ${root}`,
    `Job root state: ${describePathAccess(root)}`,
    `Recent jobs: ${recentJobs.length} (${running} running, ${terminal} terminal or detached)`,
    running > 0 ? "Use shell_status without a jobId to list jobs, shell_tail with a jobId to read output, or shell_cancel to stop a running job. Do not poll; completion notices will be batched into history and resume the agent." : "No running jobs in the recent async-shell registry.",
    recentJobs.some((job) => job.status === "unknown") ? "Some jobs were started by a previous Pi process and are no longer attached." : undefined
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function describePathAccess(targetPath: string): string {
  if (!existsSync(targetPath)) {
    const parent = path.dirname(targetPath);
    return existsSync(parent) ? `absent; parent ${describeExistingPathAccess(parent)}` : "absent; parent directory is missing";
  }
  return describeExistingPathAccess(targetPath);
}

function describeExistingPathAccess(targetPath: string): string {
  try {
    const stat = statSync(targetPath);
    const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    const readable = hasAccess(targetPath, constants.R_OK) ? "readable" : "not readable";
    const writable = hasAccess(targetPath, constants.W_OK) ? "writable" : "not writable";
    return `${kind}, ${readable}, ${writable}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable: ${message}`;
  }
}

function hasAccess(targetPath: string, mode: number): boolean {
  try {
    accessSync(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

function jobsRoot(cwd: string): string {
  return path.join(path.resolve(cwd), ".pi", "async-shell");
}

function createJobId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `job_${timestamp}_${randomUUID().slice(0, 8)}`;
}

function isTerminal(status: JobStatus): boolean {
  return status === "exited" || status === "failed" || status === "cancelled" || status === "unknown";
}

function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function expandHome(rawPath: string): string {
  if (rawPath === "~") {
    return process.env.HOME ?? rawPath;
  }

  if (rawPath.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", rawPath.slice(2));
  }

  return rawPath;
}

function secondsToMilliseconds(seconds: number): number {
  return clampInteger(seconds, 1, 600) * 1000;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

type RenderTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type RenderOptions = {
  expanded: boolean;
  isPartial?: boolean;
};

type RenderContext = {
  isError?: boolean;
};

function renderShellToolError(result: AgentToolResult<unknown>, theme: RenderTheme, context: RenderContext | undefined): Text | undefined {
  if (context?.isError !== true) {
    return undefined;
  }
  const text = result.content
    .map((item) => item.type === "text" ? item.text : "")
    .join("\n")
    .trim();
  const summary = text.length === 0 ? "Tool failed." : truncateOneLine(text, 160);
  return new Text(claudeToolResult(`error: ${summary}`, "error", theme), 0, 0);
}

function renderShellStartCall(args: StartInput, theme: RenderTheme): Text {
  const commands = args.commands.map(formatCommandRequest);
  const summary = commands.length === 1
    ? commands[0]
    : `${commands.length} shell commands: ${summarizeShellItems(commands, 2)}`;
  return new Text(claudeToolCall("Call", summary, theme), 0, 0);
}

function renderShellStartResult(result: AgentToolResult<StartDetails>, options: RenderOptions, theme: RenderTheme, context?: RenderContext): Text {
  const errorRow = renderShellToolError(result, theme, context);
  if (errorRow !== undefined) {
    return errorRow;
  }

  const jobsList = result.details?.jobs?.map((entry) => entry.job) ?? [];
  if (jobsList.length === 0) {
    return new Text(claudeToolResult(options.isPartial ? "starting" : "done", "muted", theme), 0, 0);
  }

  return new Text(jobsList.map((job) => claudeToolResult(formatShellJobStatus(job), shellStatusColor(job), theme)).join("\n"), 0, 0);
}

function renderJobCall(name: string, jobId: string, theme: RenderTheme): Text {
  return new Text(claudeToolCall(name, shortDisplayId(jobId), theme), 0, 0);
}

function renderShellStatusResult(result: AgentToolResult<JobSummaryDetails | JobListDetails>, options: RenderOptions, theme: RenderTheme, context?: RenderContext): Text {
  const errorRow = renderShellToolError(result, theme, context);
  if (errorRow !== undefined) {
    return errorRow;
  }

  if (isJobSummaryDetails(result.details)) {
    return renderJobSummaryResult(result as AgentToolResult<JobSummaryDetails>, options, theme, context);
  }

  return renderJobListResult(result as AgentToolResult<JobListDetails>, options, theme);
}

function isJobSummaryDetails(details: unknown): details is JobSummaryDetails {
  return isRecord(details) && isJobMeta(details.job);
}

function renderJobSummaryResult(result: AgentToolResult<JobSummaryDetails>, options: RenderOptions, theme: RenderTheme, context?: RenderContext, prefix?: string): Text {
  const errorRow = renderShellToolError(result, theme, context);
  if (errorRow !== undefined) {
    return errorRow;
  }

  if (options.isPartial) {
    return new Text(claudeToolResult(prefix ?? "working", "warning", theme), 0, 0);
  }

  const job = result.details?.job;
  if (job === undefined) {
    return new Text(claudeToolResult(prefix ?? "done", "muted", theme), 0, 0);
  }

  const summary = prefix === undefined
    ? formatShellJobStatus(job)
    : `${prefix} · ${formatShellJobStatus(job)}`;
  return new Text(claudeToolResult(summary, shellStatusColor(job), theme), 0, 0);
}

function renderJobListResult(result: AgentToolResult<JobListDetails>, options: RenderOptions, theme: RenderTheme): Text {
  if (options.isPartial) {
    return new Text(claudeToolResult("listing jobs", "warning", theme), 0, 0);
  }

  const jobsList = result.details?.jobs ?? [];
  return new Text(claudeToolResult(formatJobListStatus(jobsList), jobListStatusColor(jobsList), theme), 0, 0);
}

function renderAsyncShellMessage(details: unknown, _options: RenderOptions, theme: RenderTheme): Text {
  try {
    const jobsList = jobsFromAsyncShellMessage(details);
    if (jobsList.length === 0) {
      return new Text(claudeToolResult("async shell completed", "muted", theme), 0, 0);
    }

    if (jobsList.length === 1) {
      const job = jobsList[0];
      return new Text(claudeToolResult(formatShellJobStatus(job), shellStatusColor(job), theme), 0, 0);
    }

    return new Text(claudeToolResult(formatJobListStatus(jobsList), jobListStatusColor(jobsList), theme), 0, 0);
  } catch {
    return new Text(claudeToolResult("async shell completed", "muted", theme), 0, 0);
  }
}

function claudeToolCall(name: string, summary: string, theme: RenderTheme): string {
  return theme.fg("toolTitle", `⏺ ${theme.bold(name)}(`) + theme.fg("accent", summary) + theme.fg("toolTitle", ")…");
}

function claudeToolResult(summary: string, color: string, theme: RenderTheme): string {
  return theme.fg("muted", "⎿ ") + theme.fg(color, summary);
}

function summarizeShellItems(items: string[], limit: number): string {
  const visible = items.slice(0, limit).join(", ");
  const hidden = items.length - Math.min(items.length, limit);
  return hidden > 0 ? `${visible}, +${hidden}` : visible;
}

function formatJobListStatus(jobsList: JobMeta[]): string {
  if (jobsList.length === 0) {
    return "no jobs";
  }

  const counts = new Map<string, number>();
  for (const job of jobsList) {
    const status = shellStatusText(job);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  const summary = Array.from(counts.entries())
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  return `${jobsList.length} job${jobsList.length === 1 ? "" : "s"} · ${summary}`;
}

function jobListStatusColor(jobsList: JobMeta[]): string {
  if (jobsList.some((job) => shellStatusColor(job) === "error")) {
    return "error";
  }
  if (jobsList.some((job) => shellStatusColor(job) === "warning")) {
    return "warning";
  }
  if (jobsList.some((job) => shellStatusColor(job) === "muted")) {
    return "muted";
  }
  return "success";
}

function jobsFromAsyncShellMessage(details: unknown): JobMeta[] {
  if (isJobMeta(details)) {
    return [details];
  }

  if (isJobSummaryDetails(details)) {
    return [details.job];
  }

  if (isRecord(details) && Array.isArray(details.jobs)) {
    return details.jobs.map((entry) => {
      if (isJobMeta(entry)) return entry;
      if (isRecord(entry) && isJobMeta(entry.job)) return entry.job;
      return undefined;
    }).filter((job): job is JobMeta => job !== undefined);
  }

  return [];
}

function isJobMeta(value: unknown): value is JobMeta {
  return isRecord(value)
    && typeof value.jobId === "string"
    && typeof value.command === "string"
    && typeof value.status === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatCommandRequest(item: StartInput["commands"][number]): string {
  const jobName = item.job_name === undefined ? "" : `${item.job_name}: `;
  return `${jobName}${truncateOneLine(item.command, 80)} (cwd ${compactDisplayPath(item.cwd)})`;
}

function formatShellJobStatus(job: JobMeta): string {
  const jobName = job.job_name === undefined ? "" : `${job.job_name}: `;
  const status = shellStatusText(job);
  const duration = job.durationMs === undefined ? "" : ` · ${formatDuration(job.durationMs)}`;
  return `${status}${duration} · ${jobName}${truncateOneLine(job.command, 80)}`;
}

function shellStatusText(job: JobMeta): string {
  if (job.status === "running") {
    return "running";
  }
  if (job.status === "exited" && (job.exitCode === 0 || job.exitCode === undefined)) {
    return "ok";
  }
  if (job.status === "failed" && job.exitCode !== undefined && job.exitCode !== null) {
    return `exit ${job.exitCode}`;
  }
  if (job.status === "cancelled") {
    return "cancelled";
  }
  if (job.status === "unknown") {
    return "unknown";
  }
  return job.status;
}

function shellStatusColor(job: JobMeta): string {
  if (job.status === "running") {
    return "warning";
  }
  if (job.status === "exited" && (job.exitCode === 0 || job.exitCode === undefined)) {
    return "success";
  }
  if (job.status === "cancelled" || job.status === "unknown") {
    return "muted";
  }
  return "error";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function shortDisplayId(jobId: string): string {
  const parts = jobId.split("_");
  return parts.length === 0 ? truncateOneLine(jobId, 18) : parts[parts.length - 1];
}

function compactDisplayPath(rawPath: string): string {
  return truncateMiddle(rawPath.replace(/\\/g, "/"), 56);
}

function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const keep = maxLength - 3;
  const start = Math.ceil(keep * 0.55);
  const end = keep - start;
  return `${text.slice(0, start)}...${text.slice(text.length - end)}`;
}

function truncateOneLine(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function fenced(text: string): string {
  return ["```", text, "```"].join("\n");
}
