---
name: managed-worker-integration
description: Analyze and resolve one exact prepared merge conflict in a managed integration workspace. Use only for a `resolution_required` prepared fold. Do not use for independent review, implicit rebasing, promotion, pushing, or authoritative-target changes.
---

# Managed Worker Integration

- Treat prepared target, candidate, manifest, context, and evidence as immutable inputs.
- In analysis phase, do not mutate the repository. Return a checkpoint or `needs_input` with conflicts, plan, questions, and decisions required from the parent.
- In resolution phase, apply only settled parent decisions in the exact resumed session. Produce a clean committed result with the required merge or squash parent shape.
- Run focused checks and report remaining semantic risk. Never push, publish, promote, write grounding, or modify authoritative repositories.
- Settle every shell job before `worker_handoff`; the resolved result becomes a new candidate for normal review and preparation.
