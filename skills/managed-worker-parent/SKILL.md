---
name: managed-worker-parent
description: Coordinate durable managed work, independent review, conflict resolution, and exact local merge application. Use for substantial self-contained or parallel engineering; do not use for quick or tightly sequential parent work.
---

# Managed Worker Parent

The parent owns scope, grounding, Beads state, acceptance, validation, target selection, authoritative mutation, publication, and closure. Worker results and reviews are evidence, not authority.

1. Start substantial work with `worker_run` role `work`, focused instructions, and assigned task IDs. Batch only independent runs.
2. Treat completion as settlement, not acceptance. Use `worker_control get` for the exact result when deciding next steps; do not poll active workers.
3. Start a review for each completed work or integration result before relying on it. A requested correction normally resumes the original worker, followed by a new review of the corrected run.
4. Use `worker_merge_test` with explicit candidate repositories/revisions and exact target refs. Resolve conflicts directly or through `worker_run` role `integration`, then create a fresh prepared set.
5. Inspect prepared diffs and run all required project and cross-project checks before `worker_merge_apply`. Application never validates, pushes, publishes, or closes tasks.
6. Resume the same worker for answers, corrections, and same-assignment follow-up. Discard only when its retained session, workspace, and evidence are no longer useful.

Historical-candidate warnings are advisory; the parent may intentionally select an older exact commit. Never treat transport delivery state, review approval, successful application, or a worker completion claim as release or task-acceptance authority.
