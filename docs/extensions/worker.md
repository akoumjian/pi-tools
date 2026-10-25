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

Human commands are `/worker:list [status] [role]`, `/worker:show <workerId> [runId]`, `/worker:view <workerId> [runId]`, `/worker:logs <workerId> [runId]`, `/worker:cancel <workerId>`, and `/worker:discard <workerId> --confirm`. `/worker:view` opens a bounded, read-only manual-refresh rendering of the exact retained run range. It uses bounded transcript pages rather than refusing long runs: `[`/`]` move between pages, `J`/`K` jump between block boundaries, `g`/Home unambiguously opens the first run page, `G`/End opens the latest, and `r` refreshes the latest registry-backed snapshot. Compaction visibility follows Pi's exact `firstKeptEntryId` boundary across the run before pages are selected, so both traversal directions expose the same chronological set. A boundary before the retained run hides none of that run; otherwise the opening assignment remains reachable and a bounded warning counts only truly superseded entries. Pages obey a 512-entry limit, a 7 MiB decoded-content target, a separate 7 MiB encoded-entry display bound, and a 2,048-rendered-block limit; the byte bounds preserve 1 MiB of headroom beneath the hard 8 MiB total-I/O ceiling. Entries reaching or exceeding the 7 MiB display bound are prefix/index-classified, skipped, and reported rather than risking a non-progressing page. Page selection advances atomically past a whole boundary entry even when its physical line exceeds the byte target; fully consumed block-cursor entries do not spend the next page's byte budget, and adjacent multi-MiB entries remain reachable in both directions. Earlier/later counts include only entries that the viewer actually displays; page selection crosses windows containing only hidden, malformed, or skipped oversized records instead of presenting an empty page, and, only after the block parser has accounted for every displayable entry in the selected window, raw nondisplayed boundaries advance the cursor so oversized notices are not repeated on the next page. Post-budget malformed records are attributed to exactly one reachable page, and backward terminal pages report oversized records skipped before their first displayed entry without moving the page cursor. Run line indexes are streamed, fingerprint-validated, and reused, with byte checkpoints plus bounded pinned head/tail metadata for multi-MiB and oversized lines; bounded 16-level checkpoint hierarchies distribute sampled anchors across historical and recent ranges through at least 10 million entries (recent anchors are sampled rather than guaranteed contiguous), compact per-run display/oversized bitsets with 256-line cumulative ranks provide exact rank/select counts and cursor selection after compaction without budgeted historical rescans, bounded head/tail identity metadata resolves oversized Pi custom first-kept targets, one request-local no-follow range cache coalesces index, fingerprint, fallback, cursor, prefix, and decode reads, and bounded 256 KiB page read-ahead plus page-local cumulative-count anchors retain header/fingerprint headroom while fitting normal page I/O within 8 MiB by stopping at complete progress boundaries rather than surfacing a read-budget error, cumulative oversized checkpoints keep notices exact, byte-skipped backward gaps use bounded pinned oversized-line evidence instead of rereading the gap, and cached oversized spans avoid rereading their payload during backward traversal. Every async open extends a private line-index and visibility view frozen to its file size, and promotes immutable cache copies only by a newer-generation/size CAS, so settlement counts, synchronous readers, and concurrent refreshes cannot move its boundary. Running refresh extends only a stable appended suffix, running state promotes incrementally to a later settled boundary, and settled views stop indexing at their retained end. An unterminated final line is indexed once per opened snapshot, yields before returning, and is retained as bounded running-state evidence for a later append; a settled snapshot reuses that decision only at the identical file size, so growth is rechecked before a completed final entry can be excluded, while a still-partial settled snapshot shows an explicit notice. Empty settled ranges render normally, and interactive cold scans yield between bounded chunks. Malformed records in any byte-skipped leading region are not counted because there is no bounded malformed-record checkpoint hierarchy; fallback parses at most 512 KiB of an otherwise skipped gap, and dependent task `personal-71rzl` tracks fuller bounded accounting rather than allowing an unbounded recovery scan. Rendering has per-block and per-page character/line budgets before wrapping, so adversarial pages cannot monopolize input. Transient line-count snapshot races receive bounded retries through one no-follow descriptor and original file identity, while replacement fails with a stable error instead of counting a new path or leaking an internal empty-message exception. The command never acknowledges delivery or mutates worker lifecycle state.

## Identities and registry

A `workerId` is reusable. Every execution has an immutable `runId`; task/model snapshots, logs, session ranges, result, repositories, artifacts, errors, and timestamps belong to that run. Resume validates retained-session identity through a bounded no-follow header read and derives the next run start from the previous run's committed end boundary. Resume therefore performs no size-dependent JSONL scan or materialization, including for sessions beyond Node's maximum string length; settlement line counting remains streamed and bounded-memory.

Trusted host processes open one owner-only SQLite database at `~/.local/share/agent/worker-runtime/registry.sqlite`. SQLite transactions serialize lifecycle changes. Numbered schema migrations run transactionally; schema-source fingerprints are diagnostic rather than an availability gate. Containers and model code never access the registry. Large files stay beneath `worker-runtime/workers/<workerId>/`. v2 does not import or mutate legacy worker/fold state.

Completion settlement inserts a stable delivery record in the same transaction. The newest runtime generation for the exact parent session claims pending delivery; `PRAGMA data_version` plus an unreferenced one-second check makes reload delivery durable. Delivery state is transport bookkeeping and never gates resume. The compact TUI footer derives `wN` from exact-current-session queued/running registry rows and updates on committed registry transitions; direct visible async-shell work remains the separate `shN` count. Both disappear at zero. Separately, collapsed worker call/progress/result rows show a width-bounded operation hint derived only from complete structured call arguments, trusted returned details, or bounded in-memory snapshots captured as a byproduct of authoritative preflight reads. Rendering performs no filesystem, process, Beads, or registry I/O; unavailable context and optional titles are omitted. Worker prose and artifact contents never enter the hint.

## Roles and results

`work` and `integration` may submit `completed`, `needs_input`, or `blocked`. `review` may submit `approve`, `request_changes`, `needs_input`, or `blocked`; approve/request-changes requires a retained detailed report artifact. Only the worker system creates `failed` or `cancelled`. Semantic rejection returns coded field errors without sealing. Every accepted result records `outcomeSource` as `worker` or `system`.

Role instructions are verified regular UTF-8 files under `worker-roles/`. Ambient/project skill discovery remains disabled. The package exposes only `skills/managed-worker-parent/SKILL.md` to parents.

Repository paths must identify contained Git repositories. Artifact paths may identify contained regular files or directories. Work-start repository baselines are parent-validated provenance only: their exact paths and commits are recorded in the prompt but are not mounted and may be unreachable from the worker. These are live workspace pointers, not immutable artifact snapshots. Reviews therefore start only for the latest completed idle subject run.

## Review

A review receives the exact subject run/session metadata, repository/artifact entry points, and additional-input mapping in `/review/context.json`. `/review/subject` is a disposable writable view of the complete unchanged subject workspace; reviewer reports belong under `/workspace`. The reviewed worker is leased against resume while review runs. Review workers have no credentials, Beads mutation, fix implementation, push, target mutation, or acceptance authority.

Container bootstrap, root-only launch-control setup, and OverlayFS setup retain root only for required setup. The worker cannot write the root launch-control directory. Every worker command is launched through audited `setpriv` UID/GID and cleared-group dropping to the host owner, so worker repositories, results, and discardable workspace files remain host-owned. Supported rootful Docker environments use a local-driver OverlayFS view with one Docker-managed scratch volume containing sibling upper/work directories. Unsupported/rootless environments fail preflight. Writes to the subject view are deleted after settlement; reviewer session/workspace/reports remain retained.

## Merge testing and application

`worker_merge_test` accepts 1–16 request-local IDs, local candidate repositories and optional exact refs (default `HEAD`), target repositories/branch refs, merge or squash methods, commit messages, and a request-local dependency DAG. It resolves exact commits and creates ordinary isolated prepared repositories containing target and candidate history. Ready repositories contain exact commits; conflicts retain ordinary Git index/worktree state.

The tool never mutates targets. Managed and historical candidates are discovered by path and exact commit and produce advisory provenance warnings; arbitrary local Git candidates and parent-resolved prepared repositories are also accepted. Every call creates a new `preparedId`. Any target movement requires a fresh test. A complete conflicted set can be atomically moved into one integration worker workspace, consuming that prepared set.

Prepared-set lifecycle and repository records in the SQLite registry are authoritative. `prepared.json` is a rendered inspection/context artifact only; integration and apply never trust worker-writable copies as authority.

After parent review and validation, `worker_merge_apply({preparedId})` globally preflights every exact clean target. It then applies dependency order using `git merge --ff-only` for checked-out refs or compare-and-swap `git update-ref --no-deref` otherwise. Earlier updates remain after a later operational failure; retrying the same prepared ID skips exact already-applied commits.

Trusted Git disables hooks, signing, credentials, global/system configuration, replace/graft overlays, and hostile merge configuration; linked candidate worktrees, per-worktree configuration, and gitlinks/submodules are rejected. Ignored or untracked nested repositories are inert for trusted-Git policy validation. Apply cleanliness is separate: an ignored nested repository remains clean, while an untracked nested repository makes the exact worktree that checks out the target ref dirty. Refs not checked out anywhere are compare-and-swap updated without inspecting an unrelated worktree; active target refs checked out in another worktree are updated through that exact clean worktree. Application performs no model call, conflict resolution, testing, push, release, grounding, or Beads mutation.

## Cancellation and retention

Forced cancellation atomically revokes run authority, waits out admitted host mutations, proves the exact supervisor process group terminal, and uses one exact `docker rm --force <container-id>` as the agent and shell-process boundary. Result submission and Beads mutation recheck durable authorization immediately before mutation. Host-side job records are reconciled afterward. Supervisor liveness and signalling require the persisted OS start token plus a unique command-environment token; an unverifiable or reused PID is never signalled. Cleanup uncertainty becomes recovery-required rather than a false cancellation. Accepted-result settlement retries at most three times; persistent cleanup or inventory failure system-settles `failed` while retaining the accepted result and scoped evidence, never converting it to `cancelled`. Session-end line capture is bounded and best-effort in every finalization path: missing, unreadable, replaced, or truncated session files become sanitized run evidence rather than an escaping retry rejection or parent-process crash.

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

## Repository discovery boundaries

Repository discovery prioritizes `workspace/repos/`, schedules ordinary top-level roots ahead of broad `artifacts/`, and protects direct reported repositories from unrelated breadth. Runtime-owned `workspace/cache/` and `workspace/tmp/` are intentionally excluded, as are recognized HOME tool-cache subtrees such as Cargo registries, verified Python environments, package stores, and build caches. Inventory limitations explicitly name each policy-pruned tool-cache subtree and aggregate breadth exhaustion by broad subtree, rather than silently hiding the boundary. A directory merely named `venv` is not pruned unless it contains `pyvenv.cfg`, and `.local/share` is not excluded wholesale. Keep candidate repositories under `repos/` (or another ordinary workspace directory); a reported repository inside an excluded cache/temp subtree fails closed as not independently found.
