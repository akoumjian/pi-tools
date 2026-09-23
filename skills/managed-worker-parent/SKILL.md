---
name: managed-worker-parent
description: Coordinate durable managed-worker implementation, review, correction, fold preparation, conflict resolution, and local promotion. Use when substantial engineering should leave the parent session; do not use for quick inspection or tightly sequential parent work.
---

# Managed Worker Parent

- Own scope, grounding, task state, target mapping, acceptance, promotion authorization, publication, and closure.
- Assign implementation with `worker_run`; use `worker_control result` only after settlement. Do not treat process exit as semantic completion.
- Send an independent reviewer to the exact stopped worker workspace. Resume the same worker for corrections, then review the new result.
- Select repository candidates and explicit local refs before `worker_fold_prepare`. Resolve only `resolution_required` folds through the integration-worker flow.
- Validate the final result before deterministic promotion. Never ask workers or reviewers to push, publish, promote, or write parent grounding.
