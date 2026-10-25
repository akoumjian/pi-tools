import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

type PackageJson = {
  name?: string;
  private?: boolean;
  license?: string;
  files?: string[];
  pi?: {
    extensions?: string[];
    skills?: string[];
    themes?: string[];
  };
};

const packageRoot = process.cwd();

function readText(relativePath: string): string {
  return readFileSync(path.join(packageRoot, relativePath), "utf8");
}

function packageJson(): PackageJson {
  return JSON.parse(readText("package.json")) as PackageJson;
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readText(relativePath)) as Record<string, unknown>;
}

test("pi-tools extension code does not hardcode personal absolute paths", () => {
  const extensions = packageJson().pi?.extensions ?? [];
  const localExtensionFiles = extensions.filter((entry) => entry.startsWith("extensions/") && entry.endsWith(".ts"));

  assert.ok(localExtensionFiles.length > 0, "pi-tools should register at least one local extension file");
  for (const file of localExtensionFiles) {
    assert.doesNotMatch(readText(file), /\/Users\/[^\/\s]+\/Code/, file);
  }
});

test("pi-tools package boundary excludes private profile assets", () => {
  const manifest = packageJson();

  assert.equal(manifest.name, "@akoumjian/pi-tools");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, "MIT");
  assert.ok(existsSync(path.join(packageRoot, "LICENSE")));
  assert.equal(manifest.pi?.themes, undefined);
  assert.equal(existsSync(path.join(packageRoot, "agents")), false);
  assert.equal(existsSync(path.join(packageRoot, "themes")), false);
  assert.equal(existsSync(path.join(packageRoot, "config", "settings.template.json")), false);
  assert.equal(existsSync(path.join(packageRoot, "config", "models.example.jsonc")), false);
});

test("pi-tools registered extensions have shipping default config files where required", () => {
  const requiredConfigs = [
    "config/tool-safety-policy.md",
    "config/tool-safety-settings.json",
    "config/completion-notifications-settings.json",
    "config/mutation-review-settings.json",
    "config/mutation-review-guidance.md",
    "config/tool-display-settings.json",
    "config/file-open-settings.json",
    "docs/README.md",
    "docs/extensions/async-shell.md",
    "docs/extensions/completion-notifications.md",
    "docs/extensions/context-export.md",
    "docs/extensions/file-open.md",
    "docs/extensions/manual-retry.md",
    "docs/extensions/mutation-review.md",
    "docs/extensions/native-tools.md",
    "docs/extensions/searxng-search.md",
    "docs/extensions/theme-preview.md",
    "docs/extensions/tmux-scrollback.md",
    "docs/extensions/tool-display.md",
    "docs/extensions/tool-safety.md",
    "docs/extensions/tui-scrollback.md",
    "docs/extensions/web-fetch.md",
    "docs/extensions/worker.md"
  ];
  for (const file of requiredConfigs) {
    assert.ok(readText(file).length > 0, file);
  }
});

test("legacy review-subagent package surfaces are absent", () => {
  const manifest = packageJson();
  assert.equal((manifest.pi?.extensions ?? []).includes("extensions/review-subagent/index.ts"), false);
  for (const removed of [
    "extensions/review-subagent/index.ts",
    "tests/review-subagent.test.ts",
    "config/review-subagent-settings.json",
    "config/review-subagent-guidance.md",
    "docs/extensions/review-subagent.md"
  ]) assert.equal(existsSync(path.join(packageRoot, removed)), false, removed);
});

test("extension load order preserves async-shell and context dependencies", () => {
  const extensions = packageJson().pi?.extensions ?? [];
  const asyncShellIndex = extensions.indexOf("extensions/async-shell/index.ts");
  const workerIndex = extensions.indexOf("extensions/worker/index.ts");
  const completionNotificationsIndex = extensions.indexOf("extensions/completion-notifications/index.ts");
  const retryIndex = extensions.indexOf("extensions/manual-retry/index.ts");
  const contextExportIndex = extensions.indexOf("extensions/context-export/index.ts");
  const compacterIndex = extensions.indexOf("extensions/compacter/index.ts");

  assert.ok(asyncShellIndex >= 0, "async-shell must be registered");
  assert.ok(workerIndex >= 0, "worker must be registered");
  assert.ok(completionNotificationsIndex >= 0, "completion-notifications must be registered");
  assert.ok(asyncShellIndex < workerIndex, "async-shell must load before worker");
  assert.ok(asyncShellIndex < completionNotificationsIndex, "async-shell must load before completion-notifications");
  assert.ok(retryIndex >= 0, "manual-retry must be registered");
  assert.ok(contextExportIndex >= 0, "context-export must be registered");
  assert.ok(compacterIndex >= 0, "compacter must be registered");
  assert.ok(retryIndex < contextExportIndex, "manual-retry must load before context-export");
  assert.ok(retryIndex < compacterIndex, "manual-retry must load before compacter");
});

test("pi-tools package defaults do not own personal profile model or trust choices", () => {
  const toolSafety = readJson("config/tool-safety-settings.json");
  const mutationReview = readJson("config/mutation-review-settings.json");

  assert.equal(toolSafety.approvalModel, undefined);
  assert.equal(toolSafety.trustedWorkspaceRoot, undefined);
  assert.equal(toolSafety.policyFile, "tool-safety-policy.md");

  const safetyPolicy = readText("config/tool-safety-policy.md");
  assert.match(safetyPolicy, /Require human review/);
  assert.match(safetyPolicy, /Git operations[\s\S]*pushes/);
  assert.doesNotMatch(safetyPolicy, /Everything else runs without interruption/);
  assert.doesNotMatch(safetyPolicy, /ordinary pushes to any\s+branch \(including `main`/i);
  assert.doesNotMatch(safetyPolicy, /Standing local-development permission/i);

  assert.equal(mutationReview.defaultModel, undefined);
  assert.equal(mutationReview.guidance, undefined);
  assert.equal(mutationReview.guidanceFile, "mutation-review-guidance.md");

  const mutationGuidance = readText("config/mutation-review-guidance.md");
  assert.match(mutationGuidance, /Package default mutation-review guidance/);
  const personalName = ["Al", "eck"].join("");
  const personalHomePattern = new RegExp(`${personalName}|/Users/${personalName.toLowerCase()}|~/${["Co", "de"].join("")}`, "i");
  assert.doesNotMatch(mutationGuidance, personalHomePattern);
});

test("pi-tools packages plain worker role instructions and one parent skill", () => {
  const manifest = packageJson();
  assert.deepEqual(manifest.pi?.skills, ["skills"]);
  assert.ok(existsSync(path.join(packageRoot, "skills", "managed-worker-parent", "SKILL.md")));
  for (const role of ["work", "review", "integration"]) {
    assert.ok(existsSync(path.join(packageRoot, "worker-roles", `${role}.md`)), role);
  }
  assert.equal(existsSync(path.join(packageRoot, "skills", "managed-worker-implementation")), false);
  assert.equal(existsSync(path.join(packageRoot, "skills", "managed-worker-review")), false);
  assert.equal(existsSync(path.join(packageRoot, "skills", "managed-worker-integration")), false);
});

test("package upgrade guidance requires a full process restart", () => {
  const readme = readText("README.md");
  const workerDoc = readText("docs/extensions/worker.md");
  const notificationDoc = readText("docs/extensions/completion-notifications.md");
  assert.match(readme, /Fully restart Pi after installing or updating the package/);
  assert.match(workerDoc, /Later tool, deferred launch, reconciliation, cancellation, and discard boundaries first compare cheap metadata stamps/);
  assert.match(workerDoc, /`\/reload` remains supported for same-generation worker delivery/);
  assert.match(workerDoc, /Default configuration and unrelated untracked development files are outside this executable manifest/);
  assert.match(workerDoc, /A mismatch notice is process-local and never replaces durable per-run recovery state/);
  assert.match(notificationDoc, /Fully quit and restart Pi after package installation or update/);
  assert.match(notificationDoc, /`\/reload` retains in-memory package modules and is supported only within the same installed generation/);
  assert.doesNotMatch(notificationDoc, /must `\/reload` or restart after installation or update/);
});

test("pi-tools package files whitelist excludes tests and local runtime artifacts", () => {
  const manifest = packageJson();
  assert.deepEqual(manifest.files, [
    "README.md",
    "config/",
    "docs/",
    "extensions/",
    "dist/worker-host/",
    "worker-roles/",
    "skills/",
    "scripts/dev-pi.mjs",
    "scripts/review-provider-context.mjs",
    "scripts/worker-rpc/",
    "scripts/worker-host.mjs",
    "scripts/worker-sbx-rpc.mjs"
  ]);
});
