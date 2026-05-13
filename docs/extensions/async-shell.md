# async-shell

## Purpose

Run shell commands as durable async jobs instead of blocking the agent. Each `shell_start` call accepts a list of commands; the call returns within a fixed in-band grace period, and any unfinished jobs continue in the background. When background jobs finish, the extension batches their completion notices into one custom message that triggers exactly one assistant turn, so the agent can react without polling.

## Provides

LLM-callable tools:

- `shell_start({ commands: [...], tailLines? })`
- `shell_status({ jobId?, limit?, tailLines? })`
- `shell_tail({ jobId, stream?, lines?, maxChars? })`
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
  ],
  tailLines?: number                    // 1..200, default 40; cap on in-band stdout/stderr preview per stream
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

- With `jobId`: returns a single-job summary including small stdout/stderr tails.
- Without `jobId`: lists recent jobs from the on-disk registry plus active runtime jobs.

### shell_tail

```ts
shell_tail({
  jobId: string,
  stream?: "stdout" | "stderr",         // omit for both
  lines?: number,                       // 1..500, default 80
  maxChars?: number                     // 1000..120000, default 20000
})
```

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
3. The in-band result groups one entry per command:
   ```ts
   { jobs: [{ job: JobMeta, output: { stdout: string, stderr: string } }, ...] }
   ```
   with bounded `stdout`/`stderr` tails per `tailLines` and a hard ~20 KB per-stream cap.
4. For each background job that finishes later (with `notifyOnExit !== false`), the extension queues a completion notice. A ~100 ms debounce coalesces near-simultaneous completions into one batch.
5. When the agent is idle, the batch is delivered as a custom message of type `async-shell` with `triggerTurn: true, deliverAs: "steer"`, so Pi resumes exactly once for the whole batch. When the agent is active, the flush is deferred to the next `turn_end`/`message_end (user)`/`agent_end` safe point.
6. `shell_status` and `shell_tail` acknowledge an observed completion: if you inspect a job after it finished, no further notice is sent for that job.

## Completion notice shape

- Single job:
  ```
  async shell result: <status> · <duration> · <job_name>: <command-preview>
  more: shell_tail jobId=<jobId>
  ```
- Multiple jobs in one batch:
  ```
  async shell results: N jobs completed
  - <status> · <duration> · <job_name>: <command-preview>
    more: shell_tail jobId=<jobId>
  - ...
  ```

The `details` payload on the custom message carries the structured job metadata and short stdout/stderr tails for renderer/tool use.

## In-band result shape

```ts
{
  jobs: [
    {
      job: {
        jobId, job_name?, command, cwd, shell, status,
        pid?, startedAt, endedAt?, durationMs?, exitCode?, signal?, error?,
        notifyOnExit, completionNotified,
        logDir, stdoutLog, stderrLog,
        outputBytes: { stdout, stderr }
      },
      output: { stdout: string, stderr: string }
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
- Notification stdout/stderr cap: **8 lines / 2 KB**.
- Start-result per-stream cap: **20 KB**.
- Maximum commands per call: **12**.

If you need to inspect storage health, run `/async:status`.

## Notes

- There is intentionally no model-facing `shell_wait` or polling tool. Continue useful work while jobs run; if there is no useful work, stop after reporting that jobs are running. Completion notices will resume the agent.
- Do not paste raw stdout/stderr unless the user explicitly asks. The intended use of `shell_tail`/`shell_status` is targeted inspection after a completion notice, not transcript dumping.
- Tests cover spawn, durable logs, batched completions, `notifyOnExit:false`, cancel suppression, compact rendering, and error fallback (`tests/async-shell.test.ts`, `tests/native-tools.test.ts`).
