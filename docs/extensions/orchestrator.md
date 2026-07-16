# orchestrator

## Purpose

Run bounded, model-routed subagents in fresh in-process Pi sessions, keeping their intermediate context out of the parent session. The orchestrating agent may choose the provider/model and thinking level for each task. Harness code enforces task caps, tool allowlists, and reviewer-provider independence.

The current experimental slice supports read-only `reader`/`planner` tasks plus an opt-in `writer` role. Writers execute only when `writesEnabled=true` **and** `dryRun=false`, run serialized, and are confined to per-task managed git worktree branches. Machine fan-in review and reconciliation wiring are still disabled pending their own rollout.

## Provides

LLM-callable tool:

- `orchestrate` — run one or more independent child tasks: readers/planners with bounded concurrency, writers serialized in confined worktrees.

Commands:

- `/orchestrator:setup --worker provider/model[:thinking] --reviewer provider/model[:thinking] [--reviewer ...] [--reader ...] [--planner ...] [--guidance "..."]`
- `/orchestrator:status`

The extension is not yet registered in `package.json#pi.extensions`; load it with `-e extensions/orchestrator/index.ts` or use `scripts/orchestrator-sandbox.mjs` during development.

## Tool schema

```ts
{
  tasks: Array<{
    id?: string;
    task: string;
    role?: "reader" | "planner" | "writer"; // default reader
    model?: string;               // provider/model override
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  }>;
}
```

Caps come from `orchestrator-settings.json`; package defaults are 8 tasks, 4 concurrent, and 50,000 returned characters per child. Optional `validation: { command, args, timeoutMs, maxRunsPerTask }` is reserved for reconcile fold-time validation.

## Model routing

Resolution order is:

1. per-task `model` / `thinkingLevel` chosen by the parent orchestrator;
2. configured role model;
3. current parent model when the role has no configured route.

`reader` falls back to the configured worker. `planner` falls back to the current parent model. `writer` always routes to the configured worker unless overridden per task. Reviewer models are configured as a pool, and runtime selection must choose a provider different from the implementation provider. Setup rejects reviewer entries using the configured worker provider.

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

The child system prompt contains the required orchestration/read-only invariants. The extension does **not** require global `AGENTS.md`. Project AGENTS/context may still provide domain knowledge, but cannot replace or loosen the extension-owned invariants. Use `--guidance` or `--guidance-file` for organization/machine-specific orchestration guidance.

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

1. refuse unless `writesEnabled=true` and `dryRun=false`;
2. refuse when the parent checkout is dirty; create a locked managed worktree and `orch/<run>-<task>` branch under `.pi/orchestrator/worktrees/` (or `ORCHESTRATOR_WORKTREE_ROOT`);
3. spawn the child with `cwd` set to the worktree plus an allowed-root confinement extension that blocks path traversal, symlink escapes, and unsupported tools for the file-tool surface, while configured shell tools pass through to tool-safety's judged policy;
4. after the child finishes (or fails), the harness commits all changes on the task branch with an orchestrator identity;
5. worktrees with no writes are removed together with their branch; worktrees with writes are kept and reported (`branch`, `path`, `commit`, changed files);
6. every kept branch is independently reviewed: the harness computes the diff deterministically, selects a reviewer from the configured pool whose provider differs from the writer's actual model (refusing before the writer even spawns when impossible), and runs a read-only reviewer child inside the kept worktree. The reviewer must end with a `VERDICT: approve` or `VERDICT: request_changes` line, parsed deterministically; a missing verdict is recorded as `unparseable`, never as approval. Verdicts are report-only — nothing merges automatically.

Writer children omit only the `mutation-review` extension: their branch can never reach the parent checkout without the fan-in gate, so the per-edit gate is replaced by worktree confinement plus deterministic commit/report. `tool-safety` stays loaded in every child as a uniform layer. False-positive escalations are managed through the shared judge policy ([`config/tool-safety-policy.md`](../../config/tool-safety-policy.md)), which treats workspace/worktree-scoped work — including credential-pattern paths — as allow-by-default and reserves review for destructive scope and shared/production effects. Anything the judge still escalates inside a child fails closed and is harness-recorded. Writer-shaped `orchestrate` calls remain excluded from the tool-safety auto-allow rule at the parent boundary.

## Protection goals

The two invariants this design protects, and where each is enforced:

| Invariant | Enforcement |
| --- | --- |
| No destructive actions without approval | The same tuned tool-safety policy runs in the parent and every child: destructive-scope commands route to the judge, and child escalations are denied fail-closed and recorded. Writer file tools are additionally hard-confined to a disposable worktree branch, and the harness itself never touches the parent checkout. |
| No production-deployment changes without approval | Deploys, pushes, and cloud/infra mutations route to review under the shared policy in parent and children alike; child escalations are denied fail-closed. Nothing lands on a real branch without fan-in review and the (planned) human merge gate. |

Secrets-adjacent false positives that were previously escalated to a human are addressed in the judge policy itself, not by weakening enforcement: local, workspace/worktree-scoped credential-pattern access is allow-by-default, while off-machine exposure, destructive scope, and shared/production effects remain review cases. Escalations that still occur inside children fail closed and appear in `deniedCalls`.

## Approval flow

Human yes/no interactions are handled deterministically at exactly one place per run:

- **Parent boundary.** Read-only orchestrate shapes are auto-allowed by tool-safety; writer-shaped calls raise one human confirmation in the parent session. When no human is available (`pi -p`, batch), the confirmation fails and tool-safety denies — writers are fail-closed and interactive-only.
- **Child sessions never prompt.** All child sessions (orchestrator, review-subagent, mutation-review) run with a fail-closed UI: `confirm` resolves to `false` and `select`/`input`/`editor` resolve to `undefined`, each with a parent warning notification. A child that trips a review rule (for example a reader touching a credential-looking path) fails fast with a reportable reason instead of stacking mid-run dialogs or hanging a non-interactive run.
- **Denials are harness-recorded.** Every fail-closed interactive denial and every confinement block is collected deterministically and attached to the task result as `deniedCalls`, so refusals are always visible in the orchestrate output regardless of whether the child mentions them.
- **Planned merge gate.** Once fan-in review and reconciliation are wired, the meaningful human decision moves to the integration→parent merge with the independent reviewer's verdict attached. Auto-allowing confined writer spawns will be reconsidered only at that point, as an explicit decision.

## Safety and current limitations

- `writesEnabled` defaults false and `dryRun` defaults true, so writers are off until both are explicitly flipped.
- Writer-shaped `orchestrate` calls route to human review in tool-safety; only the read-only shape is auto-allowed.
- Deterministic `worktree.ts`, `confine.ts`, and `reconcile.ts` components are exercised against throwaway git/path fixtures: clean worktrees/branches/run directories are removed, dirty ones are kept, dirty parents are rejected, traversal/symlink escapes are blocked, merges are probed against pinned commits, validation failures roll back, and focused in-place conflict resolutions complete as merge commits.
- Reconciliation (fold/merge of kept writer branches) is implemented and fixture-tested but not yet invoked by the tool.
- The tool validates configured tool names before launching children.
- Output is bounded before being returned to parent context.
- Child extension loading omits the orchestrator itself, preventing recursive orchestration.
- Independent fan-in review is wired and report-only: verdicts and findings attach to writer results; reconciliation and merging remain manual.

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
