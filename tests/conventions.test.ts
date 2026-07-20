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
    "config/mutation-review-settings.json",
    "config/mutation-review-guidance.md",
    "config/review-subagent-settings.json",
    "config/review-subagent-guidance.md",
    "config/tool-display-settings.json",
    "config/file-open-settings.json",
    "docs/README.md",
    "docs/extensions/async-shell.md",
    "docs/extensions/file-open.md",
    "docs/extensions/mutation-review.md",
    "docs/extensions/native-tools.md",
    "docs/extensions/review-subagent.md",
    "docs/extensions/searxng-search.md",
    "docs/extensions/theme-preview.md",
    "docs/extensions/tmux-scrollback.md",
    "docs/extensions/tool-display.md",
    "docs/extensions/tool-safety.md",
    "docs/extensions/tui-scrollback.md",
    "docs/extensions/web-fetch.md"
  ];
  for (const file of requiredConfigs) {
    assert.ok(readText(file).length > 0, file);
  }
});

test("pi-tools package defaults do not own personal profile model or trust choices", () => {
  const toolSafety = readJson("config/tool-safety-settings.json");
  const mutationReview = readJson("config/mutation-review-settings.json");
  const reviewSubagent = readJson("config/review-subagent-settings.json");

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
  assert.equal(reviewSubagent.defaultModel, undefined);
  assert.equal(reviewSubagent.guidance, undefined);
  assert.equal(reviewSubagent.guidanceFile, "review-subagent-guidance.md");

  const mutationGuidance = readText("config/mutation-review-guidance.md");
  const reviewGuidance = readText("config/review-subagent-guidance.md");
  assert.match(mutationGuidance, /Package default mutation-review guidance/);
  assert.match(reviewGuidance, /Package default review guidance/);
  const personalName = ["Al", "eck"].join("");
  const personalHomePattern = new RegExp(`${personalName}|/Users/${personalName.toLowerCase()}|~/${["Co", "de"].join("")}`, "i");
  assert.doesNotMatch(mutationGuidance, personalHomePattern);
  assert.doesNotMatch(reviewGuidance, personalHomePattern);
});

test("pi-tools package does not register removed Hunk resources", () => {
  const manifest = packageJson();
  assert.equal(manifest.pi?.skills, undefined);
  assert.equal(manifest.pi?.extensions?.some((entry: string) => entry.includes("hunk-review")), false);
  assert.equal(existsSync(path.join(packageRoot, "extensions", "hunk-review")), false);
  assert.equal(existsSync(path.join(packageRoot, "skills", "hunk-review")), false);
});

test("pi-tools package files whitelist excludes tests and local runtime artifacts", () => {
  const manifest = packageJson();
  assert.deepEqual(manifest.files, [
    "README.md",
    "config/",
    "docs/",
    "extensions/",
    "skills/",
    "scripts/dev-pi.mjs",
    "scripts/review-provider-context.mjs"
  ]);
});
