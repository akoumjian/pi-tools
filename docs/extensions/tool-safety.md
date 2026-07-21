# tool-safety

## Purpose

Optional rule + model + human review gate for tool calls. The Pi host pre-classifies tool calls based on a small set of routing heuristics; this extension treats that as a hint and applies a configurable policy plus an optional approval-judge model to produce the final `allow` / `review` / `deny` decision. When the decision is `review`, the user gets an interactive confirmation prompt (or a one-shot warning in non-interactive modes).

The goal is to allow routine local development work while reliably routing actions with external, security-sensitive, or hard-to-undo effects to a human reviewer.

## Provides

No LLM-callable tools.

Commands:

- `/safety:setup provider/model[:thinking]` — persist the approval-judge model for this machine.
- `/safety:status` — show the active policy file, approval model, trusted workspace root, and runtime overrides.
- `/safety:model provider/model[:thinking] | reset` — override the approval model for this session.
- `/safety:toggle [on|off]` — enable/disable runtime enforcement (the policy and approval judge still load).

Config:

- [`config/tool-safety-settings.json`](../../config/tool-safety-settings.json):
  ```json
  {
    "policyFile": "tool-safety-policy.md",
    "reviewCriteria": "conservative",
    "approvalMaxTokens": 600,
    "currentUserMaxChars": 2400,
    "recentUserMessages": 3,
    "recentUserMaxChars": 900,
    "toolInputMaxChars": 6000,
    "policyMaxChars": 12000
  }
  ```
- [`config/tool-safety-policy.md`](../../config/tool-safety-policy.md) — the actual policy text shown to the approval judge.

Environment overrides:

- `PI_TOOL_SAFETY_APPROVAL_MODEL=provider/model[:thinking]`
- `PI_TOOL_SAFETY_TRUSTED_WORKSPACE=/path/to/repo`
- `PI_TOOL_SAFETY_HUMAN_REVIEW_TIMEOUT_MS`, `PI_TOOL_SAFETY_POLICY_MAX_CHARS`, and other numeric tunables.

Side effects:

- `tool_call` event handler that may return `{ block: true, reason }`.
- `session_start` event handler that resets a one-shot warning when the approval model is unavailable.

## Decision pipeline

For each `tool_call` event:

1. **Initial classification.** A set of fast deterministic command/path rules produces a baseline decision:
   - Allow routine read-only inspection, local validation commands, and file mutations inside the trusted workspace.
   - Route credential-like paths, history-rewrite git ops, deploys, package installs, network exfiltration, privilege escalation, and similar to `review`.
   - Deny clearly malicious or self-harming patterns.
   The classification surfaces rule id, risk level, tags, and confidence, used as inputs for both the approval judge and the human review prompt.
2. **Review-criteria narrowing.** `reviewCriteria` controls which host review candidates proceed to the model:
   - `conservative` (default) preserves every host review candidate.
   - `production-or-unapproved-environment` independently re-evaluates each `bash`/`shell_start` command, including commands the baseline allowed. It auto-allows non-environment actions and environment mutations with a recognizable local/dev/test/QA/staging/sandbox/preview/demo/ephemeral target. Explicit `prod`/`production` evidence takes precedence, and every environment-changing command in a batch must identify an approved target. A target named in an explicit recent user approval is also accepted. Environment mutations with no recognized target continue to review. This deterministic stage runs before the model, so its auto-allows do not depend on model availability. Non-shell retained tools cannot directly deploy or mutate an environment and are auto-allowed in this mode; environment-changing shell calls made by an orchestration child are evaluated normally.
3. **Approval judge (model).** If the narrowed decision is `review` and an approval model is configured, the extension sends a structured request to the model:
   - System prompt: the package's approval-judge instructions (asks for `allow`/`review`/`deny` with risk, confidence, and a one-line reason).
   - User content: the policy text, the current and a few recent user messages (bounded), the proposed tool call (also bounded), and the initial classification.
   - Output is constrained to a short JSON-like block, parsed defensively. Failures are non-fatal and fall back to `review`.
4. **Final decision.**
   - `allow` → the tool runs.
   - `review` → in interactive mode, a confirmation prompt is shown to the user with a minimal one-line snippet describing the action; on approval the tool runs, on decline the tool is blocked with the reviewer's reason. In non-interactive mode, the call is blocked and the user is notified.
   - `deny` → the tool is blocked.
5. **Audit details.** The extension records the initial host decision, criteria-stage decision, optional model approval, and optional human-review disposition in the tool-call event audit log.

When runtime enforcement is disabled (`/safety:toggle off`), the policy still loads but no review/deny is applied. For transition safety, an older per-machine settings file that lacks `reviewCriteria` falls through to the profile/package value; `/safety:setup` then preserves the effective value. Unknown `reviewCriteria` values fail safe to `conservative`.

## Trusted workspace

A path can be marked as the active trusted workspace via:

- `"trustedWorkspaceRoot"` in `tool-safety-settings.json`, or
- `PI_TOOL_SAFETY_TRUSTED_WORKSPACE`.

File mutations inside that root are treated as routine; mutations outside it are routed to `review` unless an explicit user authorization is detected.

## Setup

1. Pick a reasoning-friendly cheap-and-fast model. Example:
   ```text
   /safety:setup openai-codex/gpt-5.3-codex-spark:medium
   ```
   This writes `approvalModel` into your Pi profile's tool-safety settings.
2. (Optional) Export a trusted workspace:
   ```bash
   export PI_TOOL_SAFETY_TRUSTED_WORKSPACE="$HOME/Code/my-project"
   ```
3. Run `/safety:status` after restart to verify the model resolves, the policy file is loaded, and the trusted workspace is set.
4. For interactive review prompts to display, run Pi in interactive UI mode. In print/RPC mode, reviewed actions are blocked with an explanatory message instead of prompting.

## Notes

- The approval-judge model receives a bounded slice of context, never the full transcript. Configure caps (`currentUserMaxChars`, `recentUserMessages`, `toolInputMaxChars`, `policyMaxChars`) if you need tighter or looser bounds.
- A non-reasoning model is automatically clamped to thinking level `off`. Reasoning models honor whatever level the setup command persisted.
- The package-default policy in [`tool-safety-policy.md`](../../config/tool-safety-policy.md) intentionally allows routine git commit/push for the agent's own working branch (non-protected, non-history-rewriting) while still routing protected branches, force pushes, deploys, and credentials to `review`.
- This extension is deliberately not coupled to model-spec lookup: it never tries to *resolve* a model; it accepts the configured spec, asks Pi to invoke it, and treats unresolvable specs as a non-fatal degradation with a single warning notification.
- Tests cover policy parsing, rule classification, model parsing, approval flow, trust-root behavior, env overrides, and one-shot warning logic (`tests/tool-safety.test.ts`).
