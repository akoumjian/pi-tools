# worker

## Purpose

Managed-worker v2 provides durable, resumable work, independent review, conflict integration, and exact local merge preparation/application. The parent remains responsible for scope, grounding, acceptance, validation, publication, and task closure.

## Tools

Parent tools:

- `worker_run`: start `work`, `review`, or `integration` roles, or resume an exact worker.
- `worker_control`: `list`, `runs`, `get`, `cancel`, and `discard`.
- `worker_merge_test`: create a fresh isolated prepared set from explicit candidates and exact targets.
- `worker_merge_apply`: apply one ready parent-validated set after global preflight.

Worker-only tools:

- `worker_result_submit`: submit one role-valid outcome, concise summary/question, and canonical workspace repository/artifact paths; the runtime seals and reconciles owned work internally.
- `worker_beads_tasks`: bounded assigned/get/search reads, digest-fenced UTF-8-byte continuation of canonical `design` fields, and assigned-only work/integration progress updates. Every inline and continuation view includes lowercase SHA-256 of the complete canonical UTF-8 design plus `totalBytes`, `returnedBytes`, `truncated`, and `nextOffset`; continuation requires that digest and rejects task revisions with a restart-at-zero error. Every provider-visible read remains within 64 KiB. Search omits design content, reviewers retain read-only access, and no branch can close tasks or change dependencies.

Human commands are `/worker:list [status] [role]`, `/worker:show <workerId> [runId]`, `/worker:logs <workerId> [runId]`, `/worker:cancel <workerId>`, and `/worker:discard <workerId> --confirm`.

## Identities and registry

A `workerId` is reusable. Every execution has an immutable `runId`; task/model snapshots, logs, session ranges, result, repositories, artifacts, errors, and timestamps belong to that run. Pre-host launch diagnostics use best-effort files inside the run directory, never the future async-shell job directory; successful launch atomically replaces those paths with the published host logs. Every launch, settlement, and cancellation claim nonce is bound to an owner PID/start-token digest and has a matching durable admission record, closing the claim-to-file publication gap. Parent runtime registration, foreign-owner liveness evaluation, and interrupted-claim recovery share one write transaction; claim acquisition is fenced to the current generation. Fresh extension instances preserve a live operation token and recover only dead owners. Pre-host launches persist immutable project/session inputs before deferral and never retain an `ExtensionContext` across reload or session replacement. Same-run recovery parks and verifies any exact existing execution containment before restart; launch-side mutations check the exact registry claim before and after each effect, retain and cancel a started handle if a post-effect check fails, and unauthorized failure paths never remove an adopted resource.

Trusted host processes open one owner-only SQLite database at `~/.local/share/agent/worker-runtime/registry.sqlite`. SQLite transactions serialize lifecycle changes. Numbered schema migrations run transactionally; schema-source fingerprints are diagnostic rather than an availability gate. Containers and model code never access the registry. Large files stay beneath `worker-runtime/workers/<workerId>/`. v2 does not import or mutate legacy worker/fold state.

Completion settlement inserts a stable delivery record in the same transaction. The newest runtime generation for the exact parent session claims pending delivery; `PRAGMA data_version` plus an unreferenced one-second check makes delivery durable. Claiming and starting the send are separate persisted boundaries. Promotion CAS-releases only a provably dead runtime's pre-send claim for automatic delivery; once `sendMessage` starts, absent session evidence is surfaced with its exact run ID as `send_started_unconfirmed` in worker list/get and `/worker:list`/`/worker:show`, and is never automatically replayed because acceptance is ambiguous. Startup or runtime promotion emits one UI-only warning per exact unconfirmed run and runtime generation; it never steers the model or changes worker counts. Delivery state is transport bookkeeping and never gates resume. The compact TUI footer derives `wN` from exact-current-session queued/running registry rows and updates on committed registry transitions; direct visible async-shell work remains the separate `shN` count. Both disappear at zero. Separately, collapsed worker call/progress/result rows show a width-bounded operation hint derived only from complete structured call arguments, trusted returned details, or bounded in-memory snapshots captured as a byproduct of authoritative preflight reads. Rendering performs no filesystem, process, Beads, or registry I/O; unavailable context and optional titles are omitted. Worker prose and artifact contents never enter the hint.

## Package generation safety

Worker registration hashes only the checked-in, packaged worker-runtime files named by `extensions/_shared/package-generation-files.json` and records their exact file identities in process-global state. Later tool, deferred launch, reconciliation, cancellation, and discard boundaries first compare cheap metadata stamps and rehash only after a listed file or the manifest changes. Checked-in exact normalized-source fingerprints exported by the actually cached plain-JavaScript `async-job-process`, `atomic-json`, and `worker-job-settlement` modules catch the first old-process/new-disk transition before a missing export can be called; normalization replaces only the fingerprint literal itself so TypeScript test emission preserves the marker. Default configuration and unrelated untracked development files are outside this executable manifest. A mismatch notice is process-local and never replaces durable per-run recovery state; after a clean restart passes the guard, normal host supervision resumes. Package installation or update requires fully quitting and restarting Pi: `/reload` remains supported for same-generation worker delivery and context/configuration changes, but it is not a package-code activation mechanism.

## Roles and results

`work` and `integration` may submit `completed`, `needs_input`, or `blocked`. `review` may submit `approve`, `request_changes`, `needs_input`, or `blocked`; approve/request-changes requires a retained detailed report artifact. Only the worker system creates `failed` or `cancelled`. Semantic rejection returns coded field errors without sealing. Every accepted result records `outcomeSource` as `worker` or `system`.

Role instructions are verified regular UTF-8 files under `worker-roles/`. Ambient/project skill discovery remains disabled. The package exposes only `skills/managed-worker-parent/SKILL.md` to parents.

Repository paths must identify contained Git repositories. Artifact paths may identify contained regular files or directories. Work-start repository baselines are parent-validated provenance only: their exact paths and commits are recorded in the prompt but are not mounted and may be unreachable from the worker. These are live workspace pointers, not immutable artifact snapshots. Reviews therefore start only for the latest completed idle subject run.

## Review

Only a latest idle work/integration run with worker-submitted outcome `completed` is review-ready. Worker-submitted `needs_input` and `blocked`, and system-settled `failed` and `cancelled`, are not review signals. Review launch chooses the first available configured review selection whose provider differs from the subject provider and fails before launch when no independent provider is available.

The parent launches a review for every eligible completed result and treats its outcome as advisory evidence. On `request_changes`, the parent resumes the same subject worker with the findings and reviews its next completed run; the default parent-driven workflow stops after that one correction/re-review cycle unless the parent deliberately authorizes another. Review never accepts, applies, publishes, grounds, or closes tasks.

A review receives the exact subject run/session metadata, repository/artifact entry points, and additional-input mapping in `/review/context.json`. `/review/subject` is a disposable writable view of the complete unchanged subject workspace; reviewer reports belong under `/workspace`. The reviewed worker is leased against resume while review runs. Review workers have no credentials, Beads mutation, fix implementation, push, target mutation, or acceptance authority.

Container bootstrap, root-only launch-control setup, and OverlayFS setup retain root only for required setup. The worker cannot write the root launch-control directory. Every worker command is launched through audited `setpriv` UID/GID and cleared-group dropping to the host owner, so worker repositories, results, and discardable workspace files remain host-owned. Supported rootful Docker environments use a local-driver OverlayFS view with one Docker-managed scratch volume containing sibling upper/work directories. Unsupported/rootless environments fail preflight. Writes to the subject view are deleted after settlement; reviewer session/workspace/reports remain retained.

## Merge testing and application

`worker_merge_test` accepts 1–16 request-local IDs, local candidate repositories and optional exact refs (default `HEAD`), target repositories/branch refs, merge or squash methods, commit messages, and a request-local dependency DAG. It resolves exact commits and creates ordinary isolated prepared repositories containing target and candidate history. Ready repositories contain exact commits; conflicts retain ordinary Git index/worktree state.

The tool never mutates targets. Managed and historical candidates are discovered by path and exact commit and produce advisory provenance warnings; arbitrary local Git candidates and parent-resolved prepared repositories are also accepted. Every call creates a new `preparedId`. Any target movement requires a fresh test. A complete conflicted set can be atomically moved into one integration worker workspace, consuming that prepared set.

Prepared-set lifecycle and repository records in the SQLite registry are authoritative. `prepared.json` is a rendered inspection/context artifact only; integration and apply never trust worker-writable copies as authority.

After parent review and validation, `worker_merge_apply({preparedId})` globally preflights every exact clean target. It then applies dependency order using `git merge --ff-only` for checked-out refs or compare-and-swap `git update-ref --no-deref` otherwise. Earlier updates remain after a later operational failure; retrying the same prepared ID skips exact already-applied commits.

Trusted Git disables hooks, signing, credentials, global/system configuration, replace/graft overlays, and hostile merge configuration; linked candidate worktrees, per-worktree configuration, and gitlinks/submodules are rejected. Ignored or untracked nested repositories are inert for trusted-Git policy validation. Apply cleanliness is separate: an ignored nested repository remains clean, while an untracked nested repository makes the exact worktree that checks out the target ref dirty. Refs not checked out anywhere are compare-and-swap updated without inspecting an unrelated worktree; active target refs checked out in another worktree are updated through that exact clean worktree. Application performs no model call, conflict resolution, testing, push, release, grounding, or Beads mutation.

## Typed review completion

Review verdicts are authoritative only through `worker_result_submit`; unstructured assistant prose is never promoted into a result. If a review turn becomes fully quiescent without a typed result, the supervisor waits the normal five-second protocol grace and injects one bounded repair turn that requires the existing typed tool and retained report artifact. A second quiescent turn without a valid submission fails closed. Initial, asynchronous-follow-up, and repair prompts inspect Pi's correlated RPC response directly so `success:false` causes are retained instead of becoming a generic prompt-start watchdog failure. Injected prompts request follow-up streaming behavior; a busy rejection is benign only when authoritative RPC state shows an active turn, otherwise the same one logical opportunity is retried once without resetting the one-shot flag.

## Cancellation and retention

Cancellation requests and failed pre-host cleanup first persist owner-independent terminal intent. A cancel from an older same-session runtime is still accepted atomically; it reports `accepted_pending` while the newest live runtime owns lifecycle side effects, or `superseded` if another terminal result won the atomic race. If the newest runtime exits, the latest remaining live runtime is elected by process/start-token proof and a registry CAS before it may reclaim queued or terminal-intent work. The current/elected runtime also probes every exact lifecycle claim at the bounded reconciliation interval; only a provably dead PID/start-token owner is CAS-released, after which queued launch or running settlement reconciliation continues immediately. Verified accepted result evidence always takes precedence over a later cancellation request and is settled/delivered with its recorded outcome. If this runtime still has the exact attached host, cancellation returns `superseded` immediately and leaves normal handle completion to perform the sole containment and settlement. Superseded runtimes cannot start workers or claim lifecycle side effects without that promotion. Reconciliation never clears that intent or relaunches the run; any current or successor instance may claim it only to retry exact containment through finalization. Every terminal path first waits for any live durable lifecycle owner, revokes run authority, and drains admitted mutations, then removes and verifies the exact execution containment even if host-process identity is ambiguous, proves the exact supervisor process group absent, and only then cleans the exact persisted review overlay. Result submission and Beads mutation recheck durable authorization immediately before mutation. Host-side job records are reconciled afterward. Supervisor liveness and signalling require both the persisted OS start token and a unique command-environment token; permission-ambiguous PIDs still have their start token compared. A stale/reused PID is dead; a matching token remains recovery-required only when ownership enumeration itself is unavailable, while a completed readable scan without the exact token proves dead. SIGKILL is checked and followed by absence probes. Any authorization, drain, container, signal, liveness, or proof uncertainty retains terminal intent and recovery authority indefinitely; it never becomes launchable, ages into `failed`/idle, or permits overlapping resume. Waiting behind a provably live owner is pending work rather than a recovery error, and healthy finalization clears transient recovery evidence. The parent process start token is cached once; foreign-owner checks are interval-bounded and unreadable identity remains fail-closed. Only deterministic post-containment settlement failures use the bounded three-attempt system-failure path, retaining accepted results and scoped evidence.

Managed-worker package/schema upgrades require restarting **all** Pi processes that share the registry. Schema v5 adds the durable completion-send boundary and conservatively retains legacy v4 claimed deliveries as send-unconfirmed; schema v4 added durable terminal intent (including migration of an interrupted v3 cancellation claim). Older processes reject newer schemas rather than operating with mixed lifecycle semantics.

Cancellation preserves workspace/session/evidence. Resume after cancellation includes a warning to inspect interrupted Git operations and never removes locks automatically. `discard` is idle-only, permanent, and never auto-cancels. There is no automatic garbage collection.

## Configuration

`config/worker-settings.json` contains ordered exact selections:

```json
{
  "modelPreferences": {
    "work": ["openai-codex/gpt-5.6-sol:xhigh", "anthropic/claude-opus-5-5:xhigh"],
    "review": ["anthropic/claude-opus-5-5:xhigh", "openai-codex/gpt-5.6-sol:xhigh"],
    "integration": ["openai-codex/gpt-5.6-sol:xhigh", "anthropic/claude-opus-5-5:xhigh"]
  }
}
```

Fallback is startup-only before worker-visible effects. An explicit work `modelSelection` disables fallback. No package-imposed worker deadline exists.
