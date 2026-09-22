# worker

## Purpose

Run durable Pi engineering workers without granting parent authority. A worker is a stable identity with one exact Pi session, fixed provider route, and private writable workspace. A run is an ephemeral asynchronous process that must finish with a typed semantic handoff; process exit alone is not completion.

## Provides

Parent surface:

- `worker_run({ runs: [...] })`
- `worker_control({ action: "status" | "result" | "cancel" | "discard", ... })`
- `/worker:list`
- `/worker:status <worker-id>`
- `/worker:view <worker-id> [--stream both|stdout|stderr] [--tail 1..500] [--follow]`
- `/worker:ack <worker-id>`
- `/worker:cancel <worker-id>`
- `/worker:discard <worker-id> --confirm`

Worker-only RPC surface:

- `worker_handoff`
- `worker_task_read`
- `worker_task_update`
- `shell_start`, `shell_status`, `shell_read`, `shell_cancel`

`/worker:list` is provider-free and shows the total count plus up to 100 concise identities, states, routes, assigned tasks, and active/last runs for workers owned by the exact current chat; if more exist, it reports the omitted count instead of failing. `/worker:status <worker-id>` shows the full canonical record for one listed worker.

The parent owns grounding, assignment acceptance, review, integration, promotion, and task closure.

## Tool schema

```ts
worker_run({
  runs: [
    {
      kind: "new",
      taskIds: string[],
      guidance?: string,
      route?: "provider/model[:thinking]",
      completionDelivery?: "steer" | "followUp",
      initialRepos?: Array<{ source: string; revision?: string }>
    }
    | {
      kind: "resume",
      workerId: string,
      message: string,
      addTaskIds?: string[],
      completionDelivery?: "steer" | "followUp"
    }
  ]
})
```

`runs` accepts 1–8 entries. One durable worker may have at most 32 unique assigned task IDs across its initial run and all resumptions. New workers use the selected parent route unless `route` is explicit. Resume cannot change the worker session, workspace, provider, model, or thinking level. `completionDelivery` defaults to `steer`: use `steer` to get results as soon as they are ready, and `followUp` for lower-priority tasks that should be investigated after other work is finished.

```ts
worker_control({
  action: "status" | "result" | "cancel" | "discard",
  workerId?: string,
  confirm?: true
})
```

`status` without a worker ID lists at most 100 workers belonging to the exact parent session; with an ID it returns one canonical summary, including any durable repository-candidate inventory counts and bounded summaries. `result` requires a settled run, validates the persisted worker/run handoff identity and hash-bound repository inventory, returns the typed handoff plus exact bounded candidate details in model-visible content, and atomically marks pending delivery observed only after every persisted result artifact validates. `cancel` uses the same authoritative cleanup path as the user command; because its synchronous tool result already reports settlement, it does not queue a duplicate completion turn. `discard` refuses active/leased workers and requires literal `confirm:true`. Tool-safety deterministically allows every valid `worker_control` action without model or human review, while malformed IDs, missing confirmation, and unsupported fields remain reviewed. Use `shell_read` with returned job IDs for logs rather than duplicating log streaming in `worker_control`.

## Lifecycle

1. `worker_run` returns stable `workerId`, `runId`, `jobId`, `sessionId`, workspace, task, and route receipts immediately.
2. Before dispatch, the trusted host independently pins any local `initialRepos` source/revision to exact commit/tree identities without fetching or mutating the source. Nonlocal, unsupported, or unresolved sources remain explicitly unpinned. A new worker is then deferred until `turn_end` and forks the exact completed parent session with `SessionManager.forkFrom(...)`.
3. A resume verifies and reopens the exact recorded worker session. It exclusively creates a mode-`0400` completed-parent-session snapshot under the canonical, non-symlinked worker `artifacts` directory before launch; poisoned paths fail before any host write.
4. The first launch creates one exact Docker container for the worker identity, mounts all of `~/Code` read-only and only that worker's private workspace read-write at the same absolute paths, and waits for its pinned Alpine toolchain bootstrap to become ready. Successful handoffs stop that exact container to destroy its process namespace, then preserve the stopped container and writable layer for later resumptions.
5. The trusted macOS host writes its process marker, verifies an exact run/nonce/parent-PID authorization file, and only then starts Pi RPC with an explicit session file/directory, fixed model route, no built-in tools, no discovered extensions, skills, prompts, themes, or context files, and project trust forced off. Recovery revokes authorization before failed-run cleanup, fencing a host delayed before marker creation. Host-job completion remains pending until the original host process group, including its RPC descendant, has settled.
6. Pi stays alive through asynchronous shell completions and subsequent model turns until `worker_handoff` writes one accepted result and a later RPC `agent_settled` proves the handoff turn quiescent.
7. The host writes a separate trusted settlement marker only after rechecking exact session identity and quiescence. The parent accepts recovery only when both the typed handoff and matching settlement marker exist.
8. After trusted handoff settlement, the host inventories bounded Git repositories below the private `repos` directory without following symlinks, reconciles actual repositories with worker-reported paths, and writes a mode-`0600`, hash-bound repository inventory under the run state directory. Clean committed repositories with a verified base and supported Git policy become foldable candidates; dirty, missing-base, unsupported, unreported, nested, missing, and symlinked cases remain visible but fail closed. The audited Git boundary uses one absolute executable, fixed argv, scrubbed environment, no optional locks, disabled hooks/fsmonitor/credentials/signing/editors/pagers/replace objects, bounded output, and no fetch/push. Candidate IDs bind exact worker/run/path/base/head/tree facts and change if those identities move.
9. Host-side shell helpers settle normal command groups. A successful typed handoff parks the verified container in a stopped state for the same worker's next run; failed runs, cancellation, uncertain/crashed-adapter recovery, and discard extend exact stop/kill/wait through verified removal as the authoritative cleanup boundary. Completion delivery remains pending until Pi emits the exact same-session custom `message_end` receipt for the worker/run delivery ID. Reload never scans or automatically replays ambiguous history; model-facing `worker_control result` validates and observes the exact result, while user-facing `/worker:ack` explicitly resolves a separately reviewed pending completion.

Durable state lives under `~/.local/share/agent/workers/<worker-id>/`; the private workspace lives under `~/.local/share/agent/workspaces/<worker-id>/` with `repos`, `scratch`, `cache`, `artifacts`, and `tmp` directories.

## Confinement and authority

Worker shell commands execute inside one Linux container per worker identity, reused across successful resumptions while that worker remains durable. `/Users/<user>/Code` is a direct read-only VirtioFS mount and the exact private worker workspace is the only read-write host mount. This intentionally gives workers read access to all files under `~/Code`, including hidden project state, while preventing writes there. Sibling workspaces, worker state, Pi/provider credentials, `BEADS_DIR`, SSH agents, keychains, host Docker sockets, and other host paths are not mounted or injected. The accepted personal-workstation policy uses Docker Desktop's default bridge and therefore permits public internet plus reachable host/private network paths such as `host.docker.internal`.

The Pi RPC/provider/Beads control plane remains trusted on macOS. Docker init owns one long-lived container supervisor shell. Each detached host helper verifies the exact container ID and worker/run/nonce labels, uses `docker exec` only to submit a host-generated launch script and observe split output, and the supervisor starts a waiting launch wrapper which owns the command's new process group. Requested cancellation targets that recorded in-container group. Container commands receive a fixed sanitized environment with caches and temporary paths redirected into the worker workspace. Canonical job IDs and metadata-owned host log paths remain independently validated.

Per-command process groups are cooperative convenience, not the final containment primitive. Every terminal run first settles host helpers and then stops, kills when necessary, waits for, and verifies the exact labeled container, so a descendant that calls `setsid()` or clears its environment still disappears with the container PID namespace. Successful handoff retains only that verified stopped container; all other terminal paths remove it. The run remains active and leased if either shell or container cleanup cannot be verified.

The Pi RPC host remains trusted and outside the shell sandbox so it can use the configured provider route and central Beads store. `worker_task_read` uses Beads 1.1's official `bd --readonly search` and `bd --readonly show --include-dependents --json` paths after exact route verification. Workers can page their assigned roots, search all central tasks by title or ID, and read up to four arbitrary central task IDs per call. Every returned task and relationship marks whether its ID is assigned to that worker. Task text, direct dependency/dependent summaries, search results, raw CLI output, and provider-visible content remain bounded. The worker container receives no `bd` binary, database mount, route path, or `BEADS_DIR`, and the adapter exposes no arbitrary Beads command surface.

Beads mutation remains available only through `worker_task_update`, which:

- accepts only parent-assigned task IDs;
- verifies `bd where --json` matches the exact parent-recorded central `personal` path and database, with the unchanged ambient `BEADS_DIR`, before each access;
- appends notes and may set only `in_progress` or `blocked`;
- cannot close tasks or mutate arbitrary IDs.

Workspace `.pi/settings.json`, extensions, skills, prompts, themes, `SYSTEM.md`, and `APPEND_SYSTEM.md` are not trusted or loaded. Explicit trusted worker runtime extensions are the only exception.

## Handoff and cancellation

`worker_handoff` accepts `ready_for_review`, `assignment_complete`, `needs_input`, `blocked`, `checkpoint`, `failed`, or `cancelled`, with summary, task updates, optional repositories/checks, and optional question. Before calling it, the worker must inspect every owned async-shell job, choose to wait for work that should finish or cancel work that should stop, and verify terminal status. Handoff admission seals new shell starts, checks both the live registry and persisted job/process-token state, rejects every active or unverifiable job, and rejects duplicate handoffs. Once accepted, `shell_start`, `worker_task_read`, and `worker_task_update` remain sealed; the host independently rechecks RPC and actual process-group quiescence before settlement.

`/worker:view` opens the existing bounded, provider-free async-shell TUI for the worker's active or last host run. `/worker:ack` explicitly acknowledges a settled pending completion after inspection; automatic delivery acknowledgment comes only from the exact same-session custom-message receipt. Parent models use `worker_control result` instead of blind acknowledgment. `/worker:cancel` and `worker_control cancel` remove queued runs before launch; cancelling a queued resume also removes its previously parked container, retaining recovery ownership if that removal cannot be verified. Running host and command process groups receive bounded `SIGTERM` grace followed by `SIGKILL` escalation when necessary, after which the exact Docker container receives explicit `SIGTERM`/four-second stop and verified removal. Detached host cancellation still requires a matching trusted process marker and host command identity. Discard requires explicit confirmation, refuses active workers, removes the parked container when present, removes the private workspace, and removes durable state last.

An exclusive per-worker run lease prevents concurrent resumes. Cancellation records an exact durable cleanup owner before any host/container mutation, so normal completion cannot park/release the same run or expose its container to resume concurrently. Recovery atomically clears a cleanup owner only while replacing its dead parent lease. Host settlement is proven independently from recorded process-group liveness rather than inferred from identity-verification failure. Short record/lease transitions are additionally serialized by a trusted per-worker claim-directory operation lock; dead-owner claims are pruned and concurrent reclaimers elect exactly one owner. Launch revalidates the exact queued record and lease immediately before spawning. A trusted host-process marker closes the spawn-before-parent-PID crash window and supports exact restart adoption; stale PID data alone never authorizes signaling. If cleanup cannot prove owned shells are gone, the run and lease remain active with a visible recovery error; a later verified sweep can finalize cancellation instead of making the worker resumable prematurely.

## Setup and limitations

- Requires Node 22.19 or newer, macOS, a running Docker Desktop/Engine with the Docker CLI on trusted parent `PATH`, and local arm64 image `alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce`. Pull it explicitly with `docker pull --platform linux/arm64 alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce` before starting workers; launch fails loudly when it is absent.
- Requires `bd` on trusted parent `PATH` and an ambient central `personal` route for task updates.
- This vertical slice bounds each `worker_run` batch to eight but does not yet implement the later configurable cross-run concurrency scheduler or its 1–4 benchmark.
- This slice derives durable repository candidates and discrepancy records only. `worker_fold_prepare`, review/validation binding, and local exact-ref promotion remain separate later capabilities; neither a handoff nor a candidate authorizes integration.
- Publication, installation, provider trials, and promotion remain normal parent-owned reviewed operations.
- The exact stopped container persists across successful handoffs and restarts for resume, so container-root package changes and workspace caches remain available to that worker without allowing background processes to survive between runs. Failed/cancelled/crash-recovered runs and discard remove it; a later permitted resume creates a fresh replacement.
- The pinned Alpine bootstrap installs a broad Node/Python/build/Git shell toolchain at run start. ARM64 Linux cannot run Xcode, Darwin binaries, or macOS-only validation; those remain parent-owned checks.
- Command-level cancellation remains cooperative for descendants that leave their process group. Whole-container removal is authoritative run cleanup and handles those descendants independently of PID, process group, or environment tokens.
