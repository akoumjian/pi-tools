# orchestrator

## Purpose

Run bounded, model-routed subagents in fresh in-process Pi sessions, keeping their intermediate context out of the parent session. The orchestrating agent may choose a primary provider/model, explicit ordered fallbacks, and thinking level for each task. Harness code enforces task caps, tool allowlists, provider-aware writer concurrency, and reviewer-provider independence.

Roles are `reader`/`planner` (read-only, parallel) and `writer` (bounded parallel execution, confined to per-task managed git worktree branches with independent cross-provider review). Writer git setup and all reconciliation remain serialized. Integration happens only through the `reconcile` tool's human confirmation gate. There are no enable/disable behavior flags: safety comes from tool-safety review at the call boundary, worktree confinement, mandatory distinct-provider review, and the merge gate.

## Provides

LLM-callable tool:

- `orchestrate` — run one or more independent child tasks: readers/planners with bounded concurrency and provider-aware bounded writers in confined worktrees.
- `reconcile` — deterministically fold kept `orch/*` writer branches into one integration branch and merge it into the current branch behind a single human confirmation.

Commands:

- `/orchestrator:setup --worker provider/model[:thinking] --reviewer provider/model[:thinking] [--reviewer ...] [--reader ...] [--planner ...] [--guidance "..."]`
- `/orchestrator:status`

The extension is registered in `package.json#pi.extensions`; `scripts/orchestrator-sandbox.mjs` remains available for isolated development against a scratch clone.

## Tool schema

```ts
{
  tasks: Array<{
    id?: string;
    task: string;
    role?: "reader" | "planner" | "writer"; // default reader
    model?: string;               // primary provider/model override
    fallbackModels?: string[];    // up to 4 explicit provider/model[:thinking] routes
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  }>;
}
```

Caps come from `orchestrator-settings.json`; package defaults are 8 tasks, 4 concurrent readers/planners, 2 concurrent writers globally, 1 concurrent writer per provider, and 50,000 returned characters per child. Optional `validation: { command, args, timeoutMs, maxRunsPerTask }` is reserved for reconcile fold-time validation.

## Model routing

Resolution order is:

1. per-task primary `model` / `thinkingLevel` chosen by the parent orchestrator;
2. configured role model when no per-task primary is supplied;
3. current parent model when the role has no configured route;
4. only the explicit ordered per-task `fallbackModels` supplied by the parent.

`reader` uses the configured reader or worker route. `planner` uses its configured route or the current parent model. `writer` uses the configured worker unless overridden. Missing models and missing auth are rejected during preflight and reported in `routeAttempts`. A read-only task advances to its next usable explicit fallback only after auth, rate-limit/429, or transient provider failure; aborts and task/tool errors do not trigger cross-provider replay. A writer may select a fallback during preflight, including when the primary has no independent reviewer, but never replays on another model after its worktree session has started.

Reviewer models are an explicit pool. Every candidate must use a provider different from the implementation provider. Runtime review advances to the next usable pool entry after a provider failure or unparseable verdict; every rejected/failed/completed attempt is reported. Setup rejects reviewer entries using the configured worker provider.

## Result contracts

`orchestrate` model-visible text always reports the success count and one section per task. Each section includes the stable id/role, status or actionable error, every model route (`rejected`/`failed`/`completed`, failure classification, and reason), resolved model/thinking, duration/tool-call count, denied calls, and child output. Writer sections additionally expose worktree branch/path/base, commit, changed files, cleanup disposition, and every reviewer route/error/final verdict. The same structured records are retained in internal `details`; callers must not rely on `details` because Pi does not send it to providers.

`reconcile` model-visible text reports the integration branch/path, folded/skipped branches and reasons, changed-file overlaps, per-fold validation status, merge/decline outcome, merge commit, and cleanup. Internal `details` mirrors the report. Neither tool hides model-needed ids, paths, failures, or next actions in `details` alone.

No public/package default assumes access to GPT-5.6, Opus, or Fable. Those are machine/profile choices installed by `/orchestrator:setup` into the normal pi-tools per-machine config directory.

Example for this machine:

```text
/orchestrator:setup \
  --worker openai-codex/gpt-5.6-sol:xhigh \
  --reader openai-codex/gpt-5.6-sol:xhigh \
  --planner anthropic/claude-fable-5:xhigh \
  --reviewer anthropic/claude-opus-4-8:xhigh \
  --reviewer anthropic/claude-fable-5:xhigh
```

## Configuration and guidance

Lookup uses the standard pi-tools precedence: `PI_TOOLS_CONFIG_DIR`, per-agent machine config under `<agent-dir>/extensions/akoumjian-tools/`, consumer profile `config/pi-tools/`, package `config/`, then cwd `config/`.

Package defaults: [`config/orchestrator-settings.json`](../../config/orchestrator-settings.json). `/orchestrator:setup` writes a complete machine-local `orchestrator-settings.json`, preserving safety caps and writing optional guidance inline.

The child system prompt contains the required orchestration/read-only invariants. The extension does **not** require global `AGENTS.md`. Project AGENTS/context may still provide domain knowledge, but cannot replace or loosen the extension-owned invariants. The parent reads canonical grounding before delegation, passes task-relevant evidence, synthesizes child handoffs, and performs durable decisions/journal/task-tracker updates afterward; children are explicitly forbidden from external grounding writes. Use `--guidance` or `--guidance-file` for organization/machine-specific orchestration guidance.

## Child-session behavior

The implementation uses the shared [`extensions/_shared/child-agent-session.ts`](../../extensions/_shared/child-agent-session.ts) lifecycle, also used by review-subagent and mutation-review:

1. create cwd-bound services;
2. append the role/system invariants;
3. enforce the configured tool allowlist at session start/tree/before-agent-start;
4. create an in-memory session with the resolved model and thinking level;
5. prompt and return only the final text;
6. abort on the parent signal and always dispose.

Default child tools are `search_many` and `read_many` (readers/planners/reviewers) plus the configured `shellTools` for every role (default `shell_start`, `shell_status`, `shell_read`, `shell_cancel`; set `shellTools: []` to disable child shell). Writer children additionally get the configured `writeTools` (default `edit_many` and `write_many`).

## Child shell access

Children use the same async-shell tools as the main agent, governed by the same tuned tool-safety policy in every child session rather than by capability removal — the Claude Code subagent model with a fail-closed twist:

- routine local development commands (builds, tests, installs, git inspection, dev servers) run without escalation under the shared policy;
- destructive-scope and shared/production commands route to the judge; escalations inside children are denied fail-closed and harness-recorded in `deniedCalls`;
- read-only roles are instructed to use shell for research and verification only; for shell this is prompt-level, while their file-tool surface stays read-only by capability;
- writer file tools (`search_many`/`read_many`/`edit_many`/`write_many`) remain deterministically root-confined to the worktree, while shell passes through the guard to the judged policy — trading capability-impossibility for parity with the main agent, per the protection-goals table.

## Writer lifecycle

Each writer task follows a deterministic harness pipeline:

1. resolve the primary/explicit fallback route and refuse when no usable route has a configured reviewer whose provider differs from the writer (before spending writer tokens);
2. through a serial setup gate, refuse when the parent checkout is dirty and create a locked managed worktree and `orch/<run>-<task>` branch under `.pi/orchestrator/worktrees/` (or `ORCHESTRATOR_WORKTREE_ROOT`);
3. spawn the child with `cwd` set to the worktree plus an allowed-root confinement extension that blocks path traversal, symlink escapes, and unsupported tools for the file-tool surface, while configured shell tools pass through to tool-safety's judged policy;
4. after the child finishes (or fails), the harness commits all changes on the task branch with an orchestrator identity;
5. worktrees with no writes are removed together with their branch; worktrees with writes are kept and reported (`branch`, `path`, `commit`, changed files);
6. every kept branch is independently reviewed: the harness computes the diff deterministically, selects reviewers from the configured pool whose providers differ from the writer's actual model (refusing before the writer spawns when impossible), and runs a read-only reviewer child inside the kept worktree. Failure or an unparseable verdict advances to the next explicit reviewer. A reviewer must end with a `VERDICT: approve` or `VERDICT: request_changes` line, parsed deterministically; a missing verdict is never approval. Verdicts and all attempts are report-only — nothing merges automatically.

Writer sessions are scheduled with `maxWriterConcurrency` globally and `maxWriterConcurrencyPerProvider` per provider. Package defaults (`2` and `1`) allow two providers to make progress concurrently without stacking writer traffic on one provider. Worktree creation itself is serialized; separate worktrees may then run, commit, finalize, and review independently.

Writer children omit only the `mutation-review` extension: their branch can never reach the parent checkout without the fan-in gate, so the per-edit gate is replaced by worktree confinement plus deterministic commit/report. `tool-safety` stays loaded in every child as a uniform layer. False-positive escalations are managed through the shared judge policy ([`config/tool-safety-policy.md`](../../config/tool-safety-policy.md)), which treats workspace/worktree-scoped work — including credential-pattern paths — as allow-by-default and reserves review for destructive scope and shared/production effects. Anything the judge still escalates inside a child fails closed and is harness-recorded. Writer-shaped `orchestrate` calls remain excluded from the tool-safety auto-allow rule at the parent boundary.

## Protection goals

The two invariants this design protects, and where each is enforced:

| Invariant | Enforcement |
| --- | --- |
| No destructive actions without approval | The same tuned tool-safety policy runs in the parent and every child: destructive-scope commands route to the judge, and child escalations are denied fail-closed and recorded. Writer file tools are additionally hard-confined to a disposable worktree branch, and the harness itself never touches the parent checkout. |
| No production-deployment changes without approval | Deploys, pushes, and cloud/infra mutations route to review under the shared policy in parent and children alike; child escalations are denied fail-closed. Nothing lands on a real branch without fan-in review and the reconcile tool's human merge gate. |

Secrets-adjacent false positives that were previously escalated to a human are addressed in the judge policy itself, not by weakening enforcement: local, workspace/worktree-scoped credential-pattern access is allow-by-default, while off-machine exposure, destructive scope, and shared/production effects remain review cases. Escalations that still occur inside children fail closed and appear in `deniedCalls`.

## Approval flow

Human yes/no interactions are handled deterministically at exactly one place per run:

- **Parent boundary.** Read-only orchestrate shapes are auto-allowed by tool-safety; writer-shaped calls raise one human confirmation in the parent session. When no human is available (`pi -p`, batch), the confirmation fails and tool-safety denies — writers are fail-closed and interactive-only.
- **Child sessions never prompt.** All child sessions (orchestrator, review-subagent, mutation-review) run with a fail-closed UI: `confirm` resolves to `false` and `select`/`input`/`editor` resolve to `undefined`, each with a parent warning notification. A child that trips a review rule (for example a reader touching a credential-looking path) fails fast with a reportable reason instead of stacking mid-run dialogs or hanging a non-interactive run.
- **Denials are harness-recorded.** Every fail-closed interactive denial and every confinement block is collected deterministically and attached to the task result as `deniedCalls`, so refusals are always visible in the orchestrate output regardless of whether the child mentions them.
- **Merge gate.** `reconcile` folds branches into an integration branch with overlap/probe/validation reporting, then asks once before the integration→parent merge. Declining keeps the integration branch for manual review.

## Safety and current limitations

- There are no `writesEnabled`/`dryRun` behavior flags; strong defaults apply. The mutation gates are: tool-safety review of writer-shaped calls (only the read-only shape is auto-allowed), scratch-branch confinement, mandatory distinct-provider review, and the reconcile confirmation before anything reaches a real branch.
- Deterministic `worktree.ts`, `confine.ts`, and `reconcile.ts` components are exercised against throwaway git/path fixtures: clean worktrees/branches/run directories are removed, dirty ones are kept, dirty parents are rejected, traversal/symlink escapes are blocked, merges are probed against pinned commits, validation failures roll back, and focused in-place conflict resolutions complete as merge commits.
- Reconciliation is wired as the `reconcile` tool: overlap report, fewest-files-first deterministic order, commit-pinned probes, per-fold validation with rollback (`validation` settings command; folds are marked UNVALIDATED when unconfigured), conflicts skipped and reported rather than force-merged, and a structural human merge gate — `ui.confirm` inside the tool — before anything reaches the parent branch. Approval merges and removes folded writer branches/worktrees; declining keeps the integration branch for manual review. Dirty parents, non-`orch/*` branches, and parent-HEAD movement during the gate all abort deterministically.
- The `reconcile` tool shape is not auto-allowed by tool-safety; calls route through the judge/policy like any mutating action, and the in-tool confirmation is interactive-only (non-interactive runs fail closed and keep the integration branch).
- The tool validates configured tool names before launching children.
- Output is bounded before being returned to parent context.
- Child extension loading omits the orchestrator itself, preventing recursive orchestration.
- Independent fan-in review is report-only: verdicts, route attempts, and findings attach to writer results. Reconciliation is deterministic but still requires the in-tool human merge confirmation.

See [`docs/plans/orchestrator.md`](../plans/orchestrator.md) for worktree, confinement, review, conflict-resolution, and promotion phases.

## Testing

Use the dedicated worktree and sandbox, never the live `pi-agent-config` checkout:

```bash
npm run check
npm test
node scripts/orchestrator-sandbox.mjs reset
node scripts/orchestrator-sandbox.mjs repo
node scripts/orchestrator-sandbox.mjs pi
```

The sandbox has its own `PI_CODING_AGENT_DIR`, sessions, scratch clone, and worktree root. It only symlinks real auth/model catalogs so live child turns can authenticate.
