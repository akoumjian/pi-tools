# async-shell

## Purpose

Run shell commands as durable async jobs instead of blocking the agent. Each `shell_start` call accepts a list of commands; the call returns within a fixed in-band grace period, and any unfinished jobs continue in the background. When background jobs finish, the extension batches their completion notices into one custom message that triggers exactly one assistant turn, so the agent can react without polling.

## Provides

LLM-callable tools:

- `shell_start({ commands: [...] })`
- `shell_status({ jobId?, limit?, tailLines? })`
- `shell_read({ jobId, mode?, stream?, lines?, maxChars?, offset?, limit? })`
- `shell_cancel({ jobId, signal? })`

Command:

- `/async:status` — reports job-root state and recent-job diagnostics.

Side effects:

- Maintains a per-project job registry under `.pi/async-shell/jobs/<jobId>/`.
- Subscribes to `message_end`, `turn_end`, and `agent_end` to flush ready completion batches at safe points.
- Registers a custom-message renderer for the `async-shell` customType.

## Tool schemas

### shell_start

```ts
shell_start({
  commands: [
    {
      command: string,                  // required
      cwd: string,                      // required, per-command
      job_name?: string,                // short human-readable name
      shell?: string,                   // defaults to $SHELL or /bin/zsh
      notifyOnExit?: boolean            // default true; set false to silence completion notice
    },
    ...
  ]
})
```

- `commands.minItems: 1`, `maxItems: 12`.
- `cwd` is resolved against the active project root and is required per command.
- Standard input is ignored: `shell_start` does not feed stdin, so interactive commands are not supported.

### shell_status

```ts
shell_status({
  jobId?: string,                       // omit for list-mode
  limit?: number,                       // 1..100, default 20
  tailLines?: number                    // 1..500, default 40
})
```

- With `jobId`: returns a single-job summary including `stdout_log`/`stderr_log` paths plus a small diagnostic tail. Prefer `shell_read` for normal stdout/stderr output reading.
- Without `jobId`: lists recent jobs from the on-disk registry plus active runtime jobs.

### shell_read

```ts
shell_read({
  jobId: string,
  mode?: "tail" | "range",              // default "tail"; offset/limit infer "range"
  stream?: "stdout" | "stderr",         // omit for both
  lines?: number,                       // tail mode: 1..500, default 80
  maxChars?: number,                    // tail mode: 1000..120000, default 20000 per stream
  offset?: number,                      // range mode: 1-indexed starting line, default 1
  limit?: number                        // range mode: maximum lines per selected stream
})
```

Use `mode: "tail"` for recent output after `shell_start` results or completion notices. Use `mode: "range"` when you know line numbers, are continuing with `nextOffset`, or searched a log path first. Range mode returns one entry per selected stream with `offset`, `requestedLimit`, `truncation`, `previewLines`, and text content in the model-facing result. Use returned `nextOffset` to continue.

### shell_cancel

```ts
shell_cancel({
  jobId: string,
  signal?: "SIGTERM" | "SIGINT" | "SIGKILL"   // default "SIGTERM"
})
```

Cancel implicitly suppresses the completion notice for that job (`notifyOnExit` is set to `false` internally).

## Behavior

1. Each command is spawned via `spawn(shell, ["-lc", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] })`. A durable `jobId` of the form `job_<yyyymmddhhmmss>_<random8>` is created, metadata is written to `meta.json`, and stdout/stderr are streamed to `stdout.log` and `stderr.log` under `.pi/async-shell/jobs/<jobId>/`.
2. `shell_start` then waits up to a fixed **6-second** in-band grace period for all jobs in the call to finish. Jobs that finish in-band are reported as completed in the start result and never produce a completion notice; jobs still running at the end of the grace period continue in the background.
3. The in-band result groups one metadata entry per command:
   ```ts
   { jobs: [{ jobId, job_name?, command, cwd, status, durationMs?, exitCode?, signal?, error?, stdoutLog, stderrLog, outputBytes }, ...] }
   ```
   `shell_start` deliberately does not return stdout/stderr samples. Use `shell_read` with `mode: "tail"` for recent output, `shell_read` with `mode: "range"` for exact log lines, or `search_many`/`read_many` on log paths for targeted file inspection.
4. For each background job that finishes later (with `notifyOnExit !== false`), the extension queues a completion notice. A ~100 ms debounce coalesces near-simultaneous completions into one batch.
5. When the agent is idle, the batch is delivered as a custom message of type `async-shell` with `triggerTurn: true, deliverAs: "steer"`, so Pi resumes exactly once for the whole batch. When the agent is active, the flush is deferred to the next `turn_end`/`message_end (user)`/`agent_end` safe point.
6. `shell_status` and `shell_read` acknowledge an observed completion: if you inspect a job after it finished, no further notice is sent for that job.

## Completion notice shape

- Single job:
  ```
  async shell result: <status> · <duration> · <job_name>: <command-preview>
  stdout_log: <path-to-stdout.log>
  stderr_log: <path-to-stderr.log>
  recent_output: shell_read jobId=<jobId> mode=tail lines=80 (recent stdout/stderr; max 500 lines / 120 KB)
  range_output: shell_read jobId=<jobId> mode=range stream=stdout offset=<line> limit=<lines> (exact line ranges; use nextOffset to continue)
  targeted_output: use search_many on stdout_log/stderr_log, then shell_read mode=range or read_many around relevant lines
  ```
- Multiple jobs in one batch:
  ```
  async shell results: N jobs completed
  - <status> · <duration> · <job_name>: <command-preview>
    stdout_log: <path-to-stdout.log>
    stderr_log: <path-to-stderr.log>
    recent_output: shell_read jobId=<jobId> mode=tail lines=80 (recent stdout/stderr; max 500 lines / 120 KB)
    range_output: shell_read jobId=<jobId> mode=range stream=stdout offset=<line> limit=<lines> (exact line ranges; use nextOffset to continue)
    targeted_output: use search_many on stdout_log/stderr_log, then shell_read mode=range or read_many around relevant lines
  - ...
  ```

Completion notice content deliberately points at log paths rather than embedding stdout/stderr samples. The `details` payload carries structured job metadata for renderer/tool use.

## In-band result shape

```ts
{
  jobs: [
    {
      jobId, job_name?, command, cwd, status,
      durationMs?, exitCode?, signal?, error?,
      stdoutLog, stderrLog,
      outputBytes: { stdout, stderr }
    },
    ...
  ]
}
```

## TUI rendering

- Call row: `⏺ Call(<n shell commands>: <preview>)…` — always `Call(...)`, including single-command calls.
- Result row(s): one `⎿ <status> · <duration> · <job_name>: <command>` line per job, color-coded by status (success, warning, error, muted).
- Custom-message rendering for the batched completion notice uses the same compact row format.
- On schema/exec error in a tool call (e.g. missing `cwd`), the renderer shows a single `⎿ error: ...` row instead of dumping the raw error.

## Setup

None. The job root is created lazily under the project's `.pi/async-shell/`.

Defaults (constants, not configurable):

- In-band grace period: **6 s**.
- Per-job completion batch debounce: **~100 ms**.
- Completion-notice model-facing content: status summary plus `stdout_log`/`stderr_log` paths; no stdout/stderr sample.
- `shell_start` result content: status/log metadata only; no stdout/stderr samples.
- `shell_read` tail mode cap: max **500 lines / 120 KB** per selected stream. Range mode uses explicit `offset`/`limit` and has no fixed line cap.
- Maximum commands per call: **12**.

If you need to inspect storage health, run `/async:status`.

## Notes

- There is intentionally no model-facing `shell_wait` or polling tool. Continue useful work while jobs run; if there is no useful work, stop after reporting that jobs are running. Completion notices will resume the agent.
- Do not paste raw stdout/stderr unless the user explicitly asks. Use `shell_read` tail mode for recent inspection after a completion notice, `shell_read` range mode for exact line ranges/continuation, and `search_many`/`read_many` on `stdout_log` or `stderr_log` for targeted file inspection.
- Tests cover spawn, durable logs, batched completions, `notifyOnExit:false`, cancel suppression, `shell_read` tail/range reads, compact rendering, and error fallback (`tests/async-shell.test.ts`, `tests/native-tools.test.ts`).
