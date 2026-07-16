# Orchestrator Plan (ultracode-style, replaces Fleet)

Status: draft / implementation started on the isolated `feat/orchestrator`
`pi-tools` worktree. This is the replacement design for Fleet in the separate
consumer profile. Fleet runtime surfaces were disabled in `pi-agent-config`
commit `ccd74b3` (2026-07-13); that live profile checkout is not used for
development. Dormant Fleet source remains available there as design reference.

This document captures the plan to replace Fleet's durable, human-attachable
worker pool with an ephemeral, orchestrated subagent model closer to Claude
Code's "ultracode" dynamic workflows, with a hard bias toward **deterministic
enforcement in harness code** over model-followed instructions.

---

## 1. Goals / non-goals

**Goals**
- Ephemeral, orchestrated parallel subagents for one task (fan-out -> reconcile
  -> synthesize).
- The orchestrating agent chooses the model per task; workers default to
  `openai-codex/gpt-5.6-sol` at `xhigh`.
- Optional fan-in review by a **distinct provider**, enforced in code.
- Maximize deterministic enforcement: isolation, cleanup, concurrency caps,
  model-distinctness, conflict handling, and validation are guaranteed by the
  harness, not by asking the model nicely.

**Non-goals**
- No durable / attachable / steerable background workers (Fleet's RPC + FIFO +
  lease-takeover model is dropped).
- No `hunk` anywhere in the machine flow. `hunk` is a human diff tool; human
  review is a separate, out-of-scope concern.
- Beads is not the coordination backbone (optional task *source* only).

---

## 2. Corrections baked in (from cross-model review of earlier drafts)

These were wrong in earlier iterations and are corrected here:

1. **Execution model is in-process, not subprocess.** The active
   `@akoumjian/pi-tools/extensions/review-subagent` already spawns agents
   in-process via the SDK (`createAgentSessionServices` +
   `createAgentSessionFromServices` + `SessionManager.inMemory`,
   `review-subagent/index.ts:473-493`). Build on this, not on subprocess
   `pi --mode json` of the bundled example. Do not load SDK example paths from
   `node_modules` (fragile version boundary); implement it as a tested,
   reusable `@akoumjian/pi-tools` extension.
2. **`xhigh` cannot be set by a prompt template.** Template expansion is just
   prompt text; `/thinking` inside it is not executed. Use the extension API
   `setThinkingLevel(level)` / `setModel(model)`
   (`dist/core/extensions/types.d.ts:870,874`), restoring prior values after a
   one-shot run. Workers get their level at session construction.
3. **`cwd` is not confinement.** Passing `cwd` to a child does not stop `..`,
   absolute paths, or `bash` from escaping. Real confinement needs a tool-level
   path guard or OS sandbox (see §5).
4. **Fleet scopes did not guarantee disjoint ownership.** `scope.ts` only
   compiles `bd ready` filters; two roles can match the same issue. Correctness
   requires atomic claim (`bd assign`), not scope config. `git-checkpoint.ts` /
   `git-merge-and-resolve.ts` are inactive examples, not a fan-in engine.
5. **Worktrees are opt-in and only defer conflicts.** They solve live-edit
   isolation only; branch reconciliation and retention/GC are separate problems
   that must be built (see §6, §7).

---

## 3. Architecture

One reusable `pi-tools` extension supplies the engine; consumer profiles supply
machine-specific model choices through the standard extension-config chain:

```
extensions/_shared/child-agent-session.ts # shared in-process lifecycle
extensions/orchestrator/
  index.ts       # orchestrate tool + setup/status commands
  settings.ts    # extension-owned config and setup parsing
  models.ts      # route resolution + distinct-provider reviewer rule
  spawn.ts       # read-only child task execution (current safe slice)
  worktree.ts    # deterministic create/lock/inspect/clean-GC (implemented core)
  reconcile.ts   # merge-tree probe + fold/validate/resolve-in-place (implemented core)
  confine.ts     # allowed-root mutation guard (implemented core)
config/orchestrator-settings.json
```

The shared child-session lifecycle is also consumed by `review-subagent` and
`mutation-review`; orchestrator must not become a third parallel implementation.
Fleet liveness/atomic-create ideas may be adapted later without importing from
the separate profile repository.

Execution: each task is an in-process `AgentSession` built with its resolved
`{ model, thinkingLevel, tools }` and a per-child tool-allowlist/confinement
extension (same `extensionFactories` hook review-subagent uses). Only the
final summary returns to the orchestrator's context.

---

## 4. Model routing

The orchestrator is the main session (you select Opus 4.8 / Fable 5 for it; see
D1). It never gets spawned; it decides per-task models and passes them in the
tool call.

Resolution order per task (first wins): explicit tool-call model/thinking ->
configured role model -> current parent model. Reader falls back to worker.
Package defaults intentionally contain no personal model IDs; setup writes
machine-local routes. Example setup for this machine:

```text
/orchestrator:setup \\
  --worker openai-codex/gpt-5.6-sol:xhigh \\
  --reader openai-codex/gpt-5.6-sol:xhigh \\
  --planner anthropic/claude-fable-5:xhigh \\
  --reviewer anthropic/claude-opus-4-8:xhigh \\
  --reviewer anthropic/claude-fable-5:xhigh
```

`config/orchestrator-settings.json` owns caps/tool defaults. The setup command
writes validated model routes under the standard per-agent
`extensions/akoumjian-tools/` config directory, with optional inline/file
guidance. No global `AGENTS.md` content is required for runtime invariants.

**Distinct-reviewer rule (enforced):** given implementer model `I`, pick the
first pool model whose provider differs from `provider(I)`. If none, the run
**refuses to auto-merge** and reports "no independent reviewer available" rather
than reviewing with the same provider. So `openai-codex/gpt-5.6-sol` is reviewed
by `anthropic/claude-opus-4-8` or `anthropic/claude-fable-5`, never by another
codex model. Reuse a `selectModel` helper over `context.modelRegistry` (cf.
`selectReviewModel` in review-subagent).

---

## 5. Isolation / confinement tiers

Default posture: **parallelize reads, serialize writes.** Read-only agents
(scout/planner/reviewer) run in the main checkout with a read-only tool
allowlist (`read,grep,find,ls`), enforced by the child's tool set. A single
writer needs no worktree.

Worktrees are **opt-in**, used only when the orchestrator deliberately runs
*concurrent* writers. Separate the three concerns; only the first is solved by a
worktree:
1. live-edit isolation (worktree),
2. branch reconciliation (§6),
3. retention / GC (§7).

Confinement strength ladder (cwd alone is NOT confinement):
- (a) `cwd` = convenience default only.
- (b) **deterministic tool-wrapper** (`confine.ts`): wrap read/write/edit/bash
  for the child; resolve real paths and reject writes or `bash` targets outside
  the allowed root(s). `bash` is restricted (or disabled) for writers. This is
  the practical enforcement layer and rides the same per-child extension hook.
- (c) OS sandbox (`sandbox` example / `containerization.md`) for hard
  guarantees; heaviest, optional.

---

## 6. Reconciler (fan-in)

Only on the concurrent-writer path. Primitive: `git merge-tree --write-tree`
(git 2.39.5 confirmed) computes a real 3-way merge in memory, writes the result
tree, and reports conflicts **without touching the working tree, index, or
HEAD** — side-effect-free probing.

Per-branch review (distinct provider, §4) happens before a branch reaches the
reducer; a branch that failed review never gets merged.

### Stages

**0. Prevent (deterministic guard).** After each writer, compute changed set
`git diff --name-only base..branch` and build an overlap matrix. Disjoint sets
across all branches => no textual conflict possible => safe linear merge.

**1. Probe (side-effect-free).** Before each candidate merge,
`git merge-tree --write-tree <integration-tip> <branch>`:
exit 0 => clean merge tree available; exit !=0 => conflicts (paths/hunks via
`--messages`/`--name-only`).

**2. Fold + validate.** Integrate one branch at a time into
`orch/<runId>-integration` in a **reproducible order** (declared dependency ->
fewest-changed-files / least-overlap -> tie-break by branch name; ordering also
minimizes total resolution cost by settling small/independent branches first).
After each clean merge, run the validation gate (build/test/lint) in the
integration tree:
- pass => keep, delete branch, GC worktree.
- fail => *semantic* conflict (textually clean, behaviorally broken); revert
  that one merge, set branch aside, report. Folding isolates the bad branch.

### Conflict ladder (when Stage 1 reports a real conflict)

Most -> least deterministic; configurable via `conflictPolicy`.

1. **resolve-in-place (default, cheap).** Do NOT regenerate B's task. Keep B's
   branch + worktree intact. In B's own worktree:
   `git merge orch/<runId>-integration` (merge integration INTO B) —
   non-conflicting hunks auto-merge; only overlapping hunks get markers.
   Re-invoke **agent B in that same worktree** with a reconciliation prompt: its
   original task + what landed since (A's intent + `git diff` summary) +
   "resolve conflicts and refactor for coherence, do not just delete markers."
   It pays only the integration delta and has full context of its own change.
   Deterministic gates before landing:
   - no unmerged paths: `git ls-files -u` empty;
   - no leftover markers: `git diff --check` clean (+ grep for conflict
     markers);
   - validation suite passes.
   Then re-review the resolution delta with the distinct-provider reviewer.
   B now contains integration history => merges back cleanly. Bounded by
   `maxResolveAttempts`. (Use merge, not rebase: one conflict round, preserves
   commits, agent-friendly.)
2. **resolve-agent (opt-in).** A dedicated merge-resolver subagent (distinct
   provider) gets the conflicted hunks + both task intents; used if the owner
   fails or its worktree is gone. Always gated by validation.
3. **report / escalate (terminal).** Keep branches unmerged; emit a structured
   conflict report (files, hunks, both intents) to orchestrator and/or human.
   Never a silent auto-resolve.
4. **regenerate-from-scratch (rare fallback).** Only if in-place keeps failing
   validation or the worktree is unusable.

### Backstops

- **Validation gate is universal.** Every accepted merge (clean, in-place,
  agent-resolved) must pass configured checks before commit to integration.
  This makes model-produced resolutions safe and catches semantic conflicts git
  cannot see.
- **Run output is gated, not auto-landed.** The reducer targets
  `orch/<runId>-integration`, never your working branch. Final hand-off goes
  through the active write-gate (`mutation-review`).

### Config
```jsonc
reconcile: {
  order: "dependency",                        // else "fewest-files" | "name"
  conflictPolicy: ["resolve-in-place", "report"], // "resolve-agent" opt-in
  maxResolveAttempts: 1,
  validate: { command: "npm run validate", required: true },
  resolver: { enabled: false, model: "anthropic/claude-opus-4-8", thinking: "xhigh" }
}
```

### Determinism split
Harness (deterministic): probe, changed-file overlap, fold order, merge,
unmerged-path + marker checks, validation, re-review dispatch, escalation.
Model (gated): only the content of a resolution/refactor, which must pass the
gates above.

---

## 7. Worktree lifecycle + GC (`worktree.ts`)

Writers that opt into isolation get:
- base = `origin/HEAD` (fallback `HEAD`); validate base ref exists.
- branch = `orch/<runId>-<agent>`; handle branch-name collisions.
- worktree = `.pi/orchestrator/worktrees/<runId>/<agent>/` (single gitignored,
  run-scoped root).
- `git worktree add --lock` (lock so GC cannot race a live agent).
- copy gitignored essentials via a `.worktreeinclude`-style allowlist.

GC (deterministic, in `finally` — model cannot skip):
- dirty = `git -C wt status --porcelain`; ahead = `git -C wt rev-list base..HEAD`.
- both empty (no writes) => `git worktree remove --force` + delete branch.
- otherwise keep + record `{branch, wt, diffstat}` for the reducer.
- startup + run-end sweep removes clean `.pi/orchestrator/worktrees/*` older than
  N days; also reap abandoned-process worktrees.

---

## 8. Consumer-profile migration (after package promotion)

Do not modify the live local `pi-agent-config` checkout during development.
After the `pi-tools` extension is validated and released/installed:

- update the profile's installed `@akoumjian/pi-tools` dependency;
- register orchestrator in the profile/package load order;
- run `/orchestrator:setup` (or add profile `config/pi-tools/` defaults) for this
  machine's worker/reviewer routes;
- only then remove dormant Fleet source/config/docs in a separate profile
  change, preserving history and avoiding a mixed-repository rollout.

---

## 9. Phases

1. **In progress:** shared in-process child-session lifecycle; extension-owned
   setup/config; model routing + distinct-provider rule; bounded read-only
   reader/planner fan-out. No worktrees or writers yet.
2. **Implemented, fixture-tested, and wired into writer children:** `confine.ts`
   deterministic allowed-root guard, including traversal and symlink escapes
   plus denial of unsupported tools in confined sessions.
3. **Implemented, fixture-tested, and wired into writer children:** `worktree.ts`
   dirty-parent rejection, collision checks, lock/create/inspect, harness
   commits with orchestrator identity, committed or uncommitted write
   detection, clean-worktree branch removal, and empty-run-dir GC. The
   `orchestrate` tool now accepts serialized `writer` tasks behind
   `writesEnabled=true` plus `dryRun=false`, with writer-shaped calls excluded
   from the tool-safety auto-allow rule.
4. **Implemented and fixture-tested, not yet model-facing:** `reconcile.ts`
   changed-file overlap, stable ordering, commit-pinned `merge-tree` probes,
   fold-one-at-a-time, rollback on validation failure, conflict materialization,
   and completion of a validated in-place resolution merge.
5. **Implemented (report-only):** `review.ts` independent fan-in review of kept
   writer branches: deterministic diff, distinct-provider reviewer selection
   (pre-writer refusal when impossible), read-only reviewer child in the kept
   worktree, and strict `VERDICT:` parsing where missing verdicts are
   `unparseable`, never approvals. No automatic merge.
6. **Implemented:** child shell governance: all child roles get the async-shell
   tools under the same tuned tool-safety policy as the parent (fail-closed
   escalations, harness-recorded denials); the writer path guard passes shell
   through to the judged policy while keeping file tools root-confined. An
   earlier bespoke `git_query`/`run_validation` experiment was removed as
   redundant with judged shell.

7. Agents + prompts; xhigh/model commands via `setThinkingLevel`/`setModel`
   with deterministic restore.
8. Reconcile invocation + human merge gate: fold approved branches into an
   integration branch with the tested reducer, surface overlap/probe reports,
   and require one human approval before integration reaches the parent branch.
9. Promote/register the pi-tools extension, update the consumer profile, then
   remove dormant Fleet in a separate profile change. Test model resolution,
   distinctness refusal, GC-on-clean, merge-tree probes, and in-place gates.

### Promotion checklist additions

- The consumer profile's `config/pi-tools/tool-safety-policy.md` override still
  carries the old "Disclosure or exfiltration" review bullet. When promoting,
  sync it with the tuned package policy (off-machine exfiltration framing,
  scratch-worktree carve-out, secret-pattern judge note) through the normal
  profile update process.

---

## 10. Open decisions

- **D1** Orchestrator model: auto-switch session to `claude-opus-4-8` /
  `claude-fable-5` for orchestration turns via `setModel` (feasible), or leave
  manual `/model`?
- **D2** Review default on/off: review every writer branch, or only when the
  orchestrator opts a task in? (Cost: every review is a full second-provider
  pass.)
- **D4** Resolve/fix bound: `maxResolveAttempts` = 1 vs higher.
- **D5** Beads: thin `/orchestrate:from-ready` (with atomic claim) vs leave
  beads out for now.
- **D6** Confinement floor: ship tier (b) tool-wrapper as the default, or allow
  cwd-only for trusted single-writer runs?

---

## 11. Testing & isolation

Grounded in existing precedent: `scripts/dev-pi.mjs` (isolated
`PI_CODING_AGENT_DIR` agent dir), per-repo `node --test` unit suites
(`tsconfig.test.json` -> `.pi/test-build`), and `scripts/fleet-sandbox.mjs`
(out-of-repo sandbox that loads one extension via `-e` and symlinks real
`auth.json`/`models.json` so live turns work). Testing is local, not CI-gated;
the gate is `npm run validate` (= `check && test && git diff --check`).

Four layers, safe -> live. Do not register the extension in
`package.json#pi.extensions` until proven (also avoids tripping
`conventions.test.ts`, which requires a `### orchestrator` section in
`docs/EXTENSIONS.md` for every registered local extension).

- **L1 - deterministic core (no models, no real repo).** Unit-test model
  resolution, distinct-provider *refusal*, worktree GC decision, reconcile
  ordering, `merge-tree` output parsing, marker/`ls-files -u` gates, confinement
  path checks. Pure functions, like the `fleet-*.test.ts` suite. Zero risk.
- **L2 - real git on ephemeral fixtures.** `mkdtemp` a throwaway repo; exercise
  real `git worktree add/remove`, `git merge-tree --write-tree`, fold+validate,
  and resolve-in-place against it. Real git, throwaway repo, no models.
- **L3 - in-process spawn with a stubbed model.** Drive `createAgentSession*`
  with a scripted/fake model to verify fan-out -> fold wiring for zero tokens.
- **L4 - live, contained.** `scripts/orchestrator-sandbox.mjs`: out-of-repo
  agent dir under `~/.local/share/agent/orchestrator-sandbox/`, real
  auth/models symlinked, cheap default model (`gpt-5.6-luna`), and a **throwaway
  git clone** as the work target (the new element beyond fleet-sandbox, since
  the orchestrator mutates git). Start `maxConcurrency: 1`,
  `maxAgentsPerRun: 2-3`, `conflictPolicy: ["report"]`, `dryRun` on.

**Blast-radius guards (deterministic, built in from day one):** `dryRun` default
(probe + plan, no writes); writes gated behind an explicit flag; reducer targets
`orch/<runId>-integration` only (never your branch/`main`); worktree root is a
gitignored/sandbox path (`ORCHESTRATOR_WORKTREE_ROOT`); final landing stays
behind `mutation-review`.

**Sandbox <-> extension contract:** the sandbox sets `PI_CODING_AGENT_DIR`
(isolated agent dir), runs Pi with `cwd` = the scratch clone, and exports
`ORCHESTRATOR_WORKTREE_ROOT` for the worktree/integration trees. Commands:
`setup`, `repo [<path-or-url>]`, `pi [args]`, `status`, `reset`, `path`.

**Two-repo boundary:** development starts in the isolated `pi-tools` worktree.
`pi-agent-config` remains the live consumer and is not modified in place.
`pi-tools` is consumed there as an installed dependency (not a symlink), so the
profile cannot see this work until an explicit package update/promotion. Model
routes remain extension-owned machine config or optional consumer-profile
`config/pi-tools/` overrides.
