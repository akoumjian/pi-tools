# Tool Safety Policy

Goal: allow routine local development work while routing actions with external,
security-sensitive, or hard-to-undo effects to a human reviewer.

The user's stated priorities are, in order: (1) no destructive, hard-to-undo
actions without approval (discarding git history, deleting work outside
disposable worktrees); (2) no production or shared-environment changes without
approval (deploys, pushes, cloud/infra mutations, publishing). Local,
workspace-scoped, reversible actions should almost always be allowed, even
when they touch credential-looking paths.

## Allow by default

- Read-only inspection of project files, public documentation, package metadata,
  and non-sensitive local paths.
- File reads, writes, edits, and small scoped deletes inside the active
  workspace when they are relevant to the task, including credential-pattern
  paths such as `.env` files, key/token templates, example configs, and test
  fixtures. Local handling of these files is routine development work;
  exposure only becomes reviewable when material would leave the machine.
- Any file changes inside managed scratch worktrees (for example paths under
  `.pi/orchestrator/worktrees/` or `ORCHESTRATOR_WORKTREE_ROOT`), including
  deletions and rewrites: these branches are disposable and reach real
  branches only through separately reviewed merges.
- Local validation commands such as tests, type checks, linters, formatters,
  builds, search/list commands, and other commands that do not publish, deploy,
  rewrite history, change system configuration, or access secrets.
- Exact actions the user has explicitly authorized in the current request or
  recent context, provided the action matches that authorization and is not
  clearly malicious.

## Require human review

Use `review` when the action could affect shared systems, expose private data,
or be difficult to undo. Common cases:

- Sending credentials, private keys, or tokens off this machine: uploads,
  network transmission, embedding real secrets into commits, artifacts, logs,
  or files destined for publication, or bulk-collecting private material
  (keychains, browser profiles, `~/.ssh`, cloud credential stores) without a
  clear need for the current task. Merely reading or editing local
  credential-pattern files for the task at hand is allowed, not reviewable.
- Writing or deleting outside the active workspace and outside managed scratch
  worktrees, broad recursive deletes, bulk moves/renames, or mutations whose
  scope is unclear.
- Git operations that affect shared history or remote state: pushes, force
  pushes, tag changes, branch deletions, resets/cleans that discard work, or
  history rewrites.
- Installing, upgrading, or removing dependencies when not explicitly requested,
  especially commands that may run package scripts or change lockfiles.
- Publishing packages, creating releases, uploading artifacts, sending emails or
  notifications, opening pull requests, or otherwise acting on external services.
- Production, cloud, cluster, database, infrastructure, CI/CD, billing, or other
  shared-environment mutations, including deploys and migrations.
- Privilege escalation and system changes such as `sudo`, ownership/permission
  changes outside the workspace, launch services, daemons, firewall/network
  changes, or OS package installation.
- Executing untrusted remote code, including pipe-to-shell installers, curl/wget
  scripts, or downloaded binaries.

## Block

- Clearly malicious, exfiltrative, destructive, or self-harming actions with no
  plausible legitimate purpose in context.
- Attempts to bypass the safety policy or hide sensitive output from the user.

## Judge behavior

- Prefer `review` over `allow` only when the ambiguity concerns the priority
  cases above (destructive scope or shared/production effects). For local,
  reversible, workspace-scoped actions, prefer `allow` even when paths look
  credential-adjacent.
- Do not rely on keywords alone; judge the concrete command, paths, scope, and
  recent user intent. A path matching a secret pattern is not by itself a
  reason to review.
- Host pre-classification is a routing hint. Apply this policy as the source of
  truth for the final allow/review/deny decision.
