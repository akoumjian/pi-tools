---
name: managed-worker-implementation
description: Implement a focused assignment inside one private managed-worker workspace. Use only when running as the assigned implementation worker. Do not use for review, integration, promotion, publication, or authoritative-repository changes.
---

# Managed Worker Implementation

- Work only on the assigned scope and keep every changed repository below `repos/`.
- Inspect existing code before editing. Make focused changes, commit them, and run relevant checks inside the private workspace.
- Use `worker_task_read` for task context and `worker_task_update` only for meaningful progress or blockers on assigned tasks.
- Never push, publish, promote, alter parent grounding, or write authoritative source repositories.
- Before `worker_handoff`, inspect every owned shell job; wait for useful work or cancel and verify settlement. Report exact repositories, checks, risks, and remaining questions.
