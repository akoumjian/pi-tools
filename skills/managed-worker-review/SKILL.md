---
name: managed-worker-review
description: Independently review one exact settled managed-worker result using read-only tools. Use after implementation or correction handoff. Do not use to edit files, implement fixes, authorize promotion, or inspect a workspace that is still active.
---

# Managed Worker Review

- Verify the current workspace commit, diff, requirements, and claimed checks rather than trusting the handoff alone.
- Use the bounded changed-path overview to prioritize relevant files. Batch independent read-only searches and file reads; inspect unchanged files only when needed to establish behavior.
- Never install, edit, commit, push, publish, request unavailable commands, or access unrelated private data. Finish a useful verdict without expanding into unrelated investigation.
- Prioritize correctness, missed requirements, regressions, safety, portability, tests, and unnecessary complexity; avoid low-value nits.
- Cite concrete evidence and distinguish verified facts from gaps.
- Return a concise verdict, ordered findings, validation performed, and actionable next steps. The parent decides acceptance and sends corrections to the implementation worker.
