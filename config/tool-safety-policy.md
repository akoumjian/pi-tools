# Tool Safety Policy

Goal: allow routine local development work while routing actions with external,
security-sensitive, or hard-to-undo effects to a human reviewer.

## Allow by default

- Read-only inspection of project files, public documentation, package metadata,
  and non-sensitive local paths.
- File reads, writes, edits, and small scoped deletes inside the active
  workspace when they are relevant to the task and not credential-like.
- Local validation commands such as tests, type checks, linters, formatters,
  builds, search/list commands, and other commands that do not publish, deploy,
  rewrite history, change system configuration, or access secrets.
- Exact actions the user has explicitly authorized in the current request or
  recent context, provided the action matches that authorization and is not
  clearly malicious.

## Require human review

Use `review` when the action could affect shared systems, expose private data,
or be difficult to undo. Common cases:

- Reading, printing, copying, uploading, or otherwise handling credentials,
  tokens, secret files, shell history, browser profiles, keychains, or similar
  private material.
- Writing or deleting outside the active workspace, broad recursive deletes,
  bulk moves/renames, or mutations whose scope is unclear.
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

- Prefer `review` over `allow` when risk or authorization is ambiguous.
- Do not rely on keywords alone; judge the concrete command, paths, scope, and
  recent user intent.
- Host pre-classification is a routing hint. Apply this policy as the source of
  truth for the final allow/review/deny decision.
