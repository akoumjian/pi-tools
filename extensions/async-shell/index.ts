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
type ShellReadMode = "tail" | "range";

type JobOutput = {
  stdout: string;
  stderr: string;
};

type LogReadTruncation = {
  truncated: boolean;
  truncatedBy: "lines" | null;
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
  nextOffset?: number;
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

type JobStartDetails = Pick<JobMeta,
  | "jobId"
  | "job_name"
  | "command"
  | "cwd"
  | "status"
  | "durationMs"
  | "exitCode"
  | "signal"
  | "error"
  | "stdoutLog"
  | "stderrLog"
  | "outputBytes"
>;

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

type StartDetails = {
  jobs: JobStartDetails[];
};

type LogReadStreamDetails = {
  stream: OutputStreamName;
  logPath: string;
  mode: ShellReadMode;
  offset?: number;
  requestedLimit?: number;
  requestedLines?: number;
  requestedMaxChars?: number;
  truncation?: LogReadTruncation;
  previewLines: string[];
};

type LogReadStreamResult = LogReadStreamDetails & {
  content: string;
};

type ShellReadDetails = {
  job: JobMeta;
  streams: LogReadStreamDetails[];
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
const SHELL_STATUS_DEFAULT_TAIL_LINES = 40;
const SHELL_TAIL_DEFAULT_LINES = 80;
const SHELL_TAIL_MAX_LINES = 500;
const SHELL_TAIL_MIN_CHARS = 1000;
const SHELL_TAIL_DEFAULT_MAX_CHARS = 20000;
const SHELL_TAIL_MAX_CHARS = 120000;
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
  })
}, { additionalProperties: false });

const StatusParams = Type.Object({
  jobId: Type.Optional(Type.String({ minLength: 1, description: "Async shell job id. Omit to list active and recent jobs." })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20, description: "When jobId is omitted, maximum number of recent jobs to list." })),
  tailLines: Type.Optional(Type.Number({ minimum: 1, maximum: SHELL_TAIL_MAX_LINES, default: SHELL_STATUS_DEFAULT_TAIL_LINES, description: "When jobId is set, diagnostic status tail lines per stream. Prefer shell_read mode='tail' for output reading and shell_read mode='range' for exact lines; max 500." }))
}, { additionalProperties: false });

const ReadParams = Type.Object({
  jobId: Type.String({ minLength: 1, description: "Async shell job id." }),
  mode: Type.Optional(Type.Union([Type.Literal("tail"), Type.Literal("range")], { default: "tail", description: "Output read mode. Use mode='tail' (default) for recent output after a result/notification. Use mode='range' when you know exact line numbers, when continuing with nextOffset, or after search_many finds matching log lines. If offset or limit is provided without mode, range mode is inferred." })),
  stream: Type.Optional(Type.Union([Type.Literal("stdout"), Type.Literal("stderr")], { description: "Optional stream to read. Omit to read both stdout and stderr for the selected mode." })),
  lines: Type.Optional(Type.Number({ minimum: 1, maximum: SHELL_TAIL_MAX_LINES, default: SHELL_TAIL_DEFAULT_LINES, description: "Tail mode only: maximum recent lines per selected stream. Default 80, max 500. Prefer tail mode for progress, recent failures, and completion summaries." })),
  maxChars: Type.Optional(Type.Number({ minimum: SHELL_TAIL_MIN_CHARS, maximum: SHELL_TAIL_MAX_CHARS, default: SHELL_TAIL_DEFAULT_MAX_CHARS, description: "Tail mode only: maximum bytes per selected stream before line trimming. Default 20 KB, max 120 KB." })),
  offset: Type.Optional(Type.Number({ minimum: 1, description: "Range mode only: 1-indexed line number to start from, like read_many offset. Use returned nextOffset to continue a truncated log stream." })),
  limit: Type.Optional(Type.Number({ minimum: 1, description: "Range mode only: maximum lines per selected stream, like read_many limit. Omit only when the full remaining log output is actually needed." }))
}, { additionalProperties: false });

const CancelParams = Type.Object({
  jobId: Type.String({ minLength: 1, description: "Async shell job id." }),
  signal: Type.Optional(Type.Union([Type.Literal("SIGTERM"), Type.Literal("SIGINT"), Type.Literal("SIGKILL")], { default: "SIGTERM", description: "Signal to send to the job process group." }))
}, { additionalProperties: false });

type StartInput = Static<typeof StartParams>;
type StatusInput = Static<typeof StatusParams>;
type ReadInput = Static<typeof ReadParams>;
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
      "Each command item must include its own command and cwd, and starts as a durable async job with its own jobId, status, cwd, stdout_log, stderr_log, and output byte counts. Standard input is ignored, so do not use shell_start for interactive commands.",
      "Results are grouped per job as { jobs: Array<JobStartDetails> }; shell_start does not return stdout/stderr samples. A single shell_start call accepts at most 12 commands.",
      `shell_start waits only for a fixed ${START_WAIT_FOR_COMPLETION_SECONDS}s grace period: jobs that finish quickly return status/log metadata in-band; unfinished jobs continue in the background and, by default, append completion notices when they exit.`,
      "In-band shell_start results include compact job fields plus stdout_log/stderr_log paths only. Completion notices are short result notices with log paths, batched into history/TUI, then Pi triggers one assistant turn for each flushed batch; use shell_read mode='tail' for recent output, shell_read mode='range' for exact line ranges, or search_many/read_many on log paths for targeted output.",
      "Continue useful work while jobs run. If there is no useful work, stop after reporting that jobs are running; completion notices will appear in history and resume the agent. Do not poll or wait.",
      "Set per-command notifyOnExit:false only when the result is unimportant.",
      "Use shell_status to inspect jobs and shell_read to read stdout/stderr. Prefer shell_read mode='tail' after a result/notification or for progress/failure summaries; use shell_read mode='range' only when you know line numbers, are continuing nextOffset, or searched log paths first. Use search_many/read_many on stdout_log/stderr_log for targeted file inspection. Do not use status/read for polling."
    ].join(" "),
    promptSnippet: "Run shell commands as durable async jobs. Start independent shell work together in one commands list, keep doing useful work, and rely on per-job completion notices instead of polling.",
    promptGuidelines: [
      "shell_start use: Use shell_start for shell commands instead of bash. Prefer search_many for normal code/file discovery; use custom rg --files, rg -n, git grep -n, or bounded find shell inspection only when needed.",
      "shell_start input: Schema: closed { commands: closed { command: string(minLength=1), cwd: string(minLength=1), job_name?: string(minLength=1), shell?: string, notifyOnExit?: boolean(default=true) }[1..12] }. Batch independent commands together; split only for dependencies, required ordering, or unsafe concurrency. stdin is ignored, so avoid interactive commands.",
      `shell_start output: Schema: { content: text(one block per job with jobId, job_name?, status, exitCode?, signal?, durationMs?, error?, cwd, command, stdout_log, stderr_log, outputBytes, and shell_read handoff; no stdout/stderr samples), details: { jobs: [{ jobId, job_name?, command, cwd, status, durationMs?, exitCode?, signal?, error?, stdoutLog, stderrLog, outputBytes: { stdout, stderr } }] }, isError?: boolean }. Only content is provider-visible. After the fixed ${START_WAIT_FOR_COMPLETION_SECONDS}s grace, unfinished jobs continue and notify by default.`,
      "shell_start constraints: Continue useful work while jobs run; otherwise report that they are running and let the completion batch resume the agent. Do not poll or wait, do not repeatedly call status/read, and do not paste raw shell output unless explicitly requested. Set notifyOnExit:false only when completion is unimportant."
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
    description: "Get async shell job status. Pass jobId for one job; omit jobId to list active and recent jobs. Use shell_status for job metadata/health, not routine output reading. Single-job results include job metadata, stdout_log/stderr_log paths, and a small diagnostic tail; prefer shell_read mode='tail' for recent stdout/stderr, shell_read mode='range' for exact line ranges/nextOffset continuation, or search_many/read_many on log paths for targeted file inspection. List result details shape: { jobs: JobMeta[] }.",
    promptSnippet: "Inspect async job metadata/health by jobId or list active/recent jobs; use shell_read, not shell_status, for output.",
    promptGuidelines: [
      "shell_status use: Use shell_status for specific async job metadata/health or to list active/recent jobs; use shell_read for stdout/stderr content.",
      "shell_status input: Schema: closed { jobId?: string(minLength=1), limit?: number(1..100, default=20), tailLines?: number(1..500, default=40) }; limit applies when jobId is omitted and tailLines applies when jobId is present.",
      "shell_status output: Schema: { content: text(jobId mode: job metadata, both log paths, access instructions, bounded stdout/stderr tails; list mode: recency-ordered job id/name/status/exit/command/cwd entries), details: { job: JobMeta, output: { stdout: string, stderr: string } } | { jobs: JobMeta[] }, isError?: boolean }. Only content is provider-visible; JobMeta details additionally retain shell, pid/timestamps, notification state, logDir, and raw byte counts.",
      "shell_status constraints: Do not poll shell_status. Call it only after a result/notification or when inspection of a specific active job is necessary."
    ],
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
    name: "shell_read",
    label: "Async Shell Read",
    description: "Read async shell stdout/stderr logs by jobId. Use mode='tail' (default) for recent output after shell_start results or completion notices. Use mode='range' for exact read_many-style line ranges, when continuing with nextOffset, or after search_many finds log matches. Choose stream='stdout' or 'stderr', or omit stream to read both selected streams. Tail mode accepts lines/maxChars; range mode accepts offset/limit. Result details shape: { job: JobMeta, streams: [{ stream, logPath, mode, offset?, requestedLimit?, requestedLines?, requestedMaxChars?, truncation?, previewLines }] }.",
    promptSnippet: "Read async stdout/stderr by jobId with tail mode for recent output or range mode for exact lines and continuation.",
    promptGuidelines: [
      "shell_read use: Use shell_read for async job stdout/stderr after a start result, completion notice, targeted log search, or when specific active-job output is necessary; use shell_status only for metadata/health.",
      "shell_read input: Schema: closed { jobId: string(minLength=1), mode?: \"tail\" | \"range\"(default=\"tail\"), stream?: \"stdout\" | \"stderr\", lines?: number(1..500, default=80), maxChars?: number(1000..120000, default=20000), offset?: number(min=1), limit?: number(min=1) }; tail accepts lines/maxChars and range accepts offset/limit.",
      "shell_read output: Schema: { content: text(job identity plus each selected stream's logPath, requested tail/exact range and actual log text; range mode also includes total lines and nextOffset?), details: { job: JobMeta, streams: [{ stream, logPath, mode, offset?, requestedLimit?, requestedLines?, requestedMaxChars?, truncation?, previewLines }] }, isError?: boolean }. Only content is provider-visible; stream content is omitted from details.",
      "shell_read constraints: Do not poll or repeatedly reread unchanged output. Use search_many/read_many on stdout_log/stderr_log first when targeted inspection is more efficient."
    ],
    parameters: ReadParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_toolCallId, params: ReadInput, _signal, _onUpdate, context): Promise<AgentToolResult<ShellReadDetails>> {
      const job = requireJob(context, params.jobId);
      acknowledgeObservedJobCompletion(job);
      return shellReadResult(job, params);
    },
    renderCall(args, theme) {
      return renderShellReadCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderShellReadResult(result, options, theme, context);
    }
  }));

  api.registerTool(defineTool({
    name: "shell_cancel",
    label: "Async Shell Cancel",
    description: "Cancel one async shell job by jobId using SIGTERM, SIGINT, or SIGKILL. Result details shape: { job: JobMeta, output: { stdout: string, stderr: string } }.",
    promptSnippet: "Stop an active Pi async job by jobId with SIGTERM, SIGINT, or SIGKILL and return its updated job summary.",
    promptGuidelines: [
      "shell_cancel use: Use shell_cancel only to stop an active async job started by Pi.",
      "shell_cancel input: Schema: closed { jobId: string(minLength=1), signal?: \"SIGTERM\" | \"SIGINT\" | \"SIGKILL\"(default=\"SIGTERM\") }.",
      "shell_cancel output: Schema: { content: text(immediate post-signal job metadata, log paths, output access instructions, and bounded stdout/stderr tails), details: { job: JobMeta, output: { stdout: string, stderr: string } }, isError?: boolean }. Only content is provider-visible; status may still be running immediately after dispatch.",
      "shell_cancel constraints: Prefer SIGTERM unless a stronger signal is necessary; do not call shell_cancel for jobs that already exited."
    ],
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
  return startResult(runtimes);
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

  const completedJobs = Array.from(pendingCompletionNotifications.values()).map(publicJob);
  pendingCompletionNotifications.clear();

  try {
    api.sendMessage(
      {
        customType: "async-shell",
        content: formatCompletionBatchMessage(completedJobs),
        display: true,
        details: completedJobs.length === 1 ? completedJobs[0] : { jobs: completedJobs }
      },
      { triggerTurn: true, deliverAs: "steer" }
    );
  } catch {
    // Pi may be shutting down; the persisted logs still hold the result.
  }
}

function createCompletionDeliveryContext(context: Partial<Pick<ExtensionContext, "isIdle">> | undefined): CompletionDeliveryContext {
  if (typeof context?.isIdle !== "function") {
    return { isIdle: () => true };
  }

  return {
    isIdle: () => {
      try {
        return context.isIdle?.() === true;
      } catch {
        // Session replacement and reload deliberately make captured contexts
        // stale. Keep the completion queued for a fresh lifecycle event.
        return false;
      }
    }
  };
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
    `recent_output: shell_read jobId=${job.jobId} mode=tail lines=${SHELL_TAIL_DEFAULT_LINES} (recent stdout/stderr; max ${SHELL_TAIL_MAX_LINES} lines / ${formatBytes(SHELL_TAIL_MAX_CHARS)})`,
    `range_output: shell_read jobId=${job.jobId} mode=range stream=stdout offset=<line> limit=<lines> (exact line ranges; use nextOffset to continue)`,
    "targeted_output: use search_many on stdout_log/stderr_log, then shell_read mode=range or read_many around relevant lines"
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
    `more: shell_read jobId=${job.jobId} mode=tail lines=${SHELL_TAIL_DEFAULT_LINES} (recent output; max ${SHELL_TAIL_MAX_LINES} lines)`
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

function startJobDetails(job: JobMeta): JobStartDetails {
  return {
    jobId: job.jobId,
    job_name: job.job_name,
    command: job.command,
    cwd: job.cwd,
    status: job.status,
    durationMs: job.durationMs,
    exitCode: job.exitCode,
    signal: job.signal,
    error: job.error,
    stdoutLog: job.stdoutLog,
    stderrLog: job.stderrLog,
    outputBytes: { ...job.outputBytes }
  };
}

function formatStartJobMessage(job: JobStartDetails): string {
  const lines = [
    `job_id: ${job.jobId}`,
    job.job_name ? `job_name: ${job.job_name}` : undefined,
    `status: ${shellStatusText(job)}`,
    job.exitCode === undefined || job.exitCode === null ? undefined : `exit_code: ${job.exitCode}`,
    job.signal === undefined || job.signal === null ? undefined : `signal: ${job.signal}`,
    job.durationMs === undefined ? undefined : `duration: ${formatDuration(job.durationMs)}`,
    job.error === undefined ? undefined : `error: ${job.error}`,
    `cwd: ${job.cwd}`,
    `command: ${truncateOneLine(job.command, 160)}`,
    `stdout_log: ${job.stdoutLog}`,
    `stderr_log: ${job.stderrLog}`,
    `output_bytes: stdout=${formatBytes(job.outputBytes.stdout)} stderr=${formatBytes(job.outputBytes.stderr)}`,
    `recent_output: shell_read jobId=${job.jobId} mode=tail lines=${SHELL_TAIL_DEFAULT_LINES} (recent stdout/stderr; max ${SHELL_TAIL_MAX_LINES} lines / ${formatBytes(SHELL_TAIL_MAX_CHARS)})`,
    `range_output: shell_read jobId=${job.jobId} mode=range stream=stdout offset=<line> limit=<lines> (exact line ranges; use nextOffset to continue)`
  ].filter((line): line is string => line !== undefined);

  return lines.join("\n");
}

function formatJobOutputAccess(job: JobMeta, tailLines: number, maxChars: number, stream?: OutputStreamName): string {
  const streams = selectedStreams(stream);
  return [
    ...streams.map((selected) => `${selected}_log: ${selected === "stdout" ? job.stdoutLog : job.stderrLog}`),
    `tail_window: showing last up to ${tailLines} line${tailLines === 1 ? "" : "s"} and ${formatBytes(maxChars)} per selected stream (shell_read mode=tail max ${SHELL_TAIL_MAX_LINES} lines / ${formatBytes(SHELL_TAIL_MAX_CHARS)}).`,
    `recent_output: use shell_read jobId=${job.jobId} mode=tail lines=${SHELL_TAIL_DEFAULT_LINES} for recent stdout/stderr.`,
    `range_output: use shell_read jobId=${job.jobId} mode=range stream=stdout offset=<line> limit=<lines> for exact log lines.`,
    "targeted_output: use search_many/read_many on stdout_log or stderr_log for targeted file inspection."
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

function shellReadResult(job: JobMeta, input: ReadInput): AgentToolResult<ShellReadDetails> {
  const mode = normalizeShellReadMode(input);
  if (mode === "tail") {
    return shellReadTailResult(job, input);
  }
  return shellReadRangeResult(job, input);
}

function normalizeShellReadMode(input: ReadInput): ShellReadMode {
  const hasRangeParams = input.offset !== undefined || input.limit !== undefined;
  const hasTailParams = input.lines !== undefined || input.maxChars !== undefined;
  const mode = inferShellReadMode(input);

  if (mode === "tail" && hasRangeParams) {
    throw new Error("shell_read offset/limit require mode='range'. Use mode='tail' with lines/maxChars for recent output.");
  }
  if (mode === "range" && hasTailParams) {
    throw new Error("shell_read lines/maxChars require mode='tail'. Use mode='range' with offset/limit for exact log lines.");
  }
  return mode;
}

function inferShellReadMode(input: ReadInput): ShellReadMode {
  return input.mode ?? (input.offset !== undefined || input.limit !== undefined ? "range" : "tail");
}

function shellReadTailResult(job: JobMeta, input: ReadInput): AgentToolResult<ShellReadDetails> {
  const lines = clampInteger(input.lines ?? SHELL_TAIL_DEFAULT_LINES, 1, SHELL_TAIL_MAX_LINES);
  const maxChars = clampInteger(input.maxChars ?? SHELL_TAIL_DEFAULT_MAX_CHARS, SHELL_TAIL_MIN_CHARS, SHELL_TAIL_MAX_CHARS);
  const streams = selectedStreams(input.stream as OutputStreamName | undefined).map((selected) => readLogTailResult(job, selected, lines, maxChars));
  return logReadResult(job, "Read recent async shell output", streams, formatLogTail);
}

function shellReadRangeResult(job: JobMeta, input: ReadInput): AgentToolResult<ShellReadDetails> {
  const offset = input.offset ?? 1;
  const streams = selectedStreams(input.stream as OutputStreamName | undefined).map((selected) => readLogRange(job, selected, offset, input.limit));
  return logReadResult(job, "Read async shell output range", streams, formatLogRange);
}

function logReadResult(job: JobMeta, title: string, streams: LogReadStreamResult[], formatStream: (result: LogReadStreamResult) => string): AgentToolResult<ShellReadDetails> {
  const details = streams.map(({ content: _content, ...detail }) => detail);
  const text = [
    `${title} for ${job.jobId}.`,
    "",
    streams.map(formatStream).join("\n\n")
  ].join("\n");

  return {
    content: [{ type: "text", text }],
    details: {
      job: publicJob(job),
      streams: details
    }
  };
}

function startResult(jobsList: JobRuntime[]): AgentToolResult<StartDetails> {
  const jobSummaries = jobsList.map(startJobDetails);
  const text = jobSummaries.map(formatStartJobMessage).join("\n\n");

  return {
    content: [{ type: "text", text }],
    details: {
      jobs: jobSummaries
    }
  };
}

function partialStartResult(jobsList: JobRuntime[]): AgentToolResult<StartDetails> {
  return {
    content: [{ type: "text", text: "Async shell jobs running." }],
    details: {
      jobs: jobsList.map(startJobDetails)
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
    outputBytes: { ...job.outputBytes }
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

function readLogTailResult(job: JobMeta, stream: OutputStreamName, lines: number, maxChars: number): LogReadStreamResult {
  const logPath = logPathForStream(job, stream);
  const content = readLogTail(logPath, lines, maxChars);
  return {
    stream,
    logPath,
    mode: "tail",
    requestedLines: lines,
    requestedMaxChars: maxChars,
    previewLines: previewLogLines(content, 2),
    content
  };
}

function readLogRange(job: JobMeta, stream: OutputStreamName, offset: number, limit: number | undefined): LogReadStreamResult {
  const logPath = logPathForStream(job, stream);
  const content = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const lines = content.length === 0 ? [] : content.split("\n");
  const totalLines = lines.length;
  const normalizedOffset = clampInteger(offset, 1, Number.MAX_SAFE_INTEGER);
  if (totalLines === 0 && normalizedOffset > 1) {
    throw new Error(`Offset ${normalizedOffset} is beyond end of ${stream} log for ${job.jobId} (0 lines total).`);
  }
  if (totalLines > 0 && normalizedOffset > totalLines) {
    throw new Error(`Offset ${normalizedOffset} is beyond end of ${stream} log for ${job.jobId} (${totalLines} lines total).`);
  }

  const start = normalizedOffset - 1;
  const selected = limit === undefined ? lines.slice(start) : lines.slice(start, start + clampInteger(limit, 1, Number.MAX_SAFE_INTEGER));
  const outputContent = selected.join("\n");
  return {
    stream,
    logPath,
    mode: "range",
    offset: normalizedOffset,
    requestedLimit: limit,
    truncation: buildLogReadTruncation(selected, outputContent, totalLines, Buffer.byteLength(content, "utf8"), start),
    previewLines: previewLogLines(outputContent, 2),
    content: outputContent
  };
}

function buildLogReadTruncation(selected: string[], outputContent: string, totalLines: number, totalBytes: number, startIndex: number): LogReadTruncation {
  const outputLines = selected.length;
  const hasMoreLogLines = startIndex + outputLines < totalLines;
  return {
    truncated: hasMoreLogLines,
    truncatedBy: hasMoreLogLines ? "lines" : null,
    totalLines,
    outputLines,
    totalBytes,
    outputBytes: Buffer.byteLength(outputContent, "utf8"),
    nextOffset: hasMoreLogLines ? startIndex + outputLines + 1 : undefined
  };
}

function formatLogTail(result: LogReadStreamResult): string {
  const lines = result.requestedLines ?? SHELL_TAIL_DEFAULT_LINES;
  const maxChars = result.requestedMaxChars ?? SHELL_TAIL_DEFAULT_MAX_CHARS;
  const header = `--- ${result.stream} tail (${result.logPath}; last up to ${lines} line${lines === 1 ? "" : "s"}, ${formatBytes(maxChars)} max) ---`;
  const output = result.content.length === 0 ? "(no output)" : result.content;
  return `${header}\n${output}`;
}

function formatLogRange(result: LogReadStreamResult): string {
  if (result.offset === undefined || result.truncation === undefined) {
    throw new Error("Range log result is missing offset/truncation metadata.");
  }

  const startLine = result.offset;
  const endLine = result.offset + result.truncation.outputLines - 1;
  const header = `--- ${result.stream} range (${result.logPath}; lines ${startLine}-${Math.max(startLine, endLine)} of ${result.truncation.totalLines}) ---`;
  const output = result.content.length === 0 ? "(no output)" : result.content;
  const continuation = result.truncation.nextOffset === undefined
    ? ""
    : `\n[truncated by ${result.truncation.truncatedBy}; continue with mode=range offset=${result.truncation.nextOffset}]`;
  return `${header}\n${output}${continuation}`;
}

function previewLogLines(content: string, limit: number): string[] {
  if (content.length === 0) {
    return [];
  }
  return content.split(/\r?\n/).slice(0, limit);
}

function logPathForStream(job: JobMeta, stream: OutputStreamName): string {
  return stream === "stdout" ? job.stdoutLog : job.stderrLog;
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
    running > 0 ? "Use shell_status without a jobId to list jobs, shell_read mode=tail for recent output, shell_read mode=range for exact log lines, or shell_cancel to stop a running job. Do not poll; completion notices will be batched into history and resume the agent." : "No running jobs in the recent async-shell registry.",
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

  const jobsList = result.details?.jobs ?? [];
  if (jobsList.length === 0) {
    return new Text(claudeToolResult(options.isPartial ? "starting" : "done", "muted", theme), 0, 0);
  }

  return new Text(jobsList.map((job) => claudeToolResult(formatShellJobStatus(job), shellStatusColor(job), theme)).join("\n"), 0, 0);
}

function renderShellReadCall(args: ReadInput, theme: RenderTheme): Text {
  const stream = args.stream ?? "stdout/stderr";
  const mode = inferShellReadMode(args);
  if (mode === "tail") {
    const lines = args.lines ?? SHELL_TAIL_DEFAULT_LINES;
    return new Text(claudeToolCall("Read", `${shortDisplayId(args.jobId)} ${stream} tail ${lines} lines`, theme), 0, 0);
  }

  const offset = args.offset ?? 1;
  const limit = args.limit === undefined ? "end" : String(args.limit);
  return new Text(claudeToolCall("Read", `${shortDisplayId(args.jobId)} ${stream} range offset ${offset} limit ${limit}`, theme), 0, 0);
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

function renderShellReadResult(result: AgentToolResult<ShellReadDetails>, options: RenderOptions, theme: RenderTheme, context?: RenderContext): Text {
  const errorRow = renderShellToolError(result, theme, context);
  if (errorRow !== undefined) {
    return errorRow;
  }

  if (options.isPartial) {
    return new Text(claudeToolResult("reading shell output", "warning", theme), 0, 0);
  }

  const details = result.details;
  if (details === undefined) {
    return new Text(claudeToolResult("read shell output", "muted", theme), 0, 0);
  }

  const spans = details.streams.map(formatLogReadSpan).join(", ");
  const summary = spans.length === 0 ? `read · ${formatShellJobStatus(details.job)}` : `read ${spans} · ${formatShellJobStatus(details.job)}`;
  return new Text(claudeToolResult(summary, shellStatusColor(details.job), theme), 0, 0);
}

function formatLogReadSpan(stream: LogReadStreamDetails): string {
  if (stream.mode === "tail") {
    const lines = stream.requestedLines ?? SHELL_TAIL_DEFAULT_LINES;
    return stream.previewLines.length === 0 ? `${stream.stream}:tail empty` : `${stream.stream}:tail${lines}`;
  }

  if (stream.offset === undefined || stream.truncation === undefined || stream.truncation.outputLines === 0) {
    return `${stream.stream}:range empty`;
  }

  const end = stream.offset + stream.truncation.outputLines - 1;
  return `${stream.stream}:${stream.offset}:${end}`;
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

type ShellJobDisplay = Pick<JobMeta, "job_name" | "command" | "status" | "durationMs" | "exitCode">;

type ShellJobStatusFields = Pick<JobMeta, "status" | "exitCode">;

function formatShellJobStatus(job: ShellJobDisplay): string {
  const jobName = job.job_name === undefined ? "" : `${job.job_name}: `;
  const status = shellStatusText(job);
  const duration = job.durationMs === undefined ? "" : ` · ${formatDuration(job.durationMs)}`;
  return `${status}${duration} · ${jobName}${truncateOneLine(job.command, 80)}`;
}

function shellStatusText(job: ShellJobStatusFields): string {
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

function shellStatusColor(job: ShellJobStatusFields): string {
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
