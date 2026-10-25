---
name: managed-worker-parent
description: Coordinate durable workers for substantial work, independent review, conflict integration, merge testing, and repository application while retaining parent authority. Use for self-contained or parallel assignments; do not use when work must be done sequentially, as workers incur overhead costs.
---

# Managed Worker Parent

## Control Flow

### 1. Delegate

Handle sequential work directly because workers incur startup, context-transfer, review, and integration overhead.

Start a `work` worker for substantial self-contained assignments. Batch runs only when the assignments are independent and benefit from parallel execution.

The parent remains responsible for grounding, task assignment, scope, and durable decisions.

### 2. Handle the Result

Rely on completion notifications rather than polling. Use `worker_control get` to inspect the exact run.

- `completed`: start an independent review before relying on the result.
- `needs_input`: answer the focused question and resume the same worker.
- `blocked`: resolve or defer the external prerequisite, then decide whether to resume.
- system `failed` or `cancelled`: inspect the retained run and decide whether to resume, replace, or abandon it.

Resume the same worker for corrections and follow-up. Start a replacement only after intentionally abandoning the previous worker.

### 3. Review

Treat an accepted `worker_result_submit` outcome `completed` from a work or integration worker as its ready-for-review signal. Worker-submitted `needs_input` and `blocked`, and system-settled `failed` and `cancelled`, are not review-eligible.

Start a review worker for every eligible completed result. The worker system selects a configured reviewer from a different provider than the subject and fails before launch when no independent provider is available.

- `approve`: treat the review as advisory evidence; the parent still decides acceptance.
- `request_changes`: resume the original subject worker with the findings, then independently review its new completed run. Treat this as one bounded correction and re-review cycle by default; any further cycle requires a deliberate parent decision.
- `needs_input`: answer and resume the same reviewer.
- `blocked`: resolve or defer the review prerequisite.

Use review instructions only for emphasis, questions, acceptance criteria, or follow-up. A focused review must still report material issues outside the requested focus. Review never accepts work, mutates authoritative repositories, applies merges, publishes, or closes tasks.

### 4. Integrate Repository Results

After review and parent acceptance:

1. Read each accepted repository path and exact commit from `worker_control get`; choose a request-local ID for each repository.
2. Group only repositories that must move together.
3. Call `worker_merge_test` with each local `candidateRepo`, exact `candidateRef`, explicit target, method, commit message, and request-local dependencies.
4. If conflicts are reported:
   - resolve and commit them directly in the prepared repositories, then call merge testing again with each resolved `preparedPath` as `candidateRepo`; or
   - start an integration worker, review its completed result, and test the complete repository set again.
5. When the complete set is `ready`, inspect every final diff and run the required checks from each `preparedPath`.
6. Call `worker_merge_apply` only after every prepared repository passes validation.

Applying a prepared set is sequential rather than atomic. If application is partial, inspect the reported state and retry only the same remaining operation. Do not repair target refs manually.

### 5. Finish

Pushing, publication, release, grounding updates, semantic acceptance, and Beads closure remain parent-owned.

Cancel only active work. Discard an idle worker only when no further review, resume, merge, or recovery access is needed.

## Invariants

- Only a worker’s latest completed run may be reviewed. Repository candidates may intentionally name any retained exact safely reachable commit; historical provenance, staleness, and run outcome are advisory warnings.
- Workers may update only assigned Beads tasks and never close them.
- Review outcomes are advisory and never authorize repository application.
- Workers never modify authoritative repositories, push, publish, release, or write parent grounding.
- Worker workspaces, sessions, and run evidence remain retained until explicit discard.

## Retention, preservation, and explicit cleanup

Treat retained workers, sessions, runs, results, repositories, and artifacts as durable evidence; settlement, age, storage pressure, or task closure never deletes them. Use `worker_control cleanup_inventory` for bounded current/all-session accounting. For any cross-session action, open-task abandonment, artifact loss, pending/claimed delivery takeover, prepared state, or physical leftover, request `cleanup_preview` with exact IDs and then call `cleanup_apply` with its one-use token and the exact acknowledgement lists shown by the preview. Never synthesize acknowledgements from memory or reuse a token. Live/ambiguous owners, unavailable Beads, recovery state, claims, and changed snapshots must remain blocked.

Use `preserve` before cleanup for non-reproducible evidence that must outlive the worker. Choose a new absolute destination outside repositories, `.git`, worker/runtime roots, and credential/configuration storage. Preservation rejects links and repositories by design. Narrow same-session `discard` is only for already-delivered, closed-task idle workers; use preview/apply for every earlier-loss case. Reviewer/subject lease pairs must be previewed together and are deleted reviewer first. Inspect per-item results because a cleanup batch continues after exact failures and reports partial failure as an error.

Before requesting review, ask workers to remove temporary clones, generated environments, caches, and other reproducible debris while retaining clean committed repositories, required reports, declared artifacts, and session/evidence needed for review or resume. Repository paths and artifact paths are different contracts: never report a Git repository root as an artifact, never place candidate repositories under cache/tmp subtrees, and keep every declared path workspace-contained.
