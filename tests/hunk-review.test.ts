import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import hunkReviewExtension, {
  attachSessionToLaunch,
  buildFollowModeMessage,
  buildHunkAgentGuidanceBlock,
  buildHunkDiffArgs,
  buildHunkReviewStatusText,
  buildHunkSessionNavigateArgs,
  buildHunkSessionReloadArgs,
  buildItermSplitAppleScript,
  detectLaunchers,
  inspectHunkAgentGuidanceText,
  itermSessionIdFromEnv,
  parseHunkSessionList,
  selectNewHunkSession,
  selectRememberedHunkSession,
  selectReusableHunkSession,
  extractMutationTargetsFromToolResult,
  extractTouchedPathsFromToolCall,
  extractTouchedPathsFromToolResult,
  findNearestRepoRoot,
  findNewHunkSession,
  readHunkAgentGuidanceSnippet,
  readHunkReviewSettings,
  recordTouchedFiles,
  repoRelativePath,
  removeHunkAgentGuidanceText,
  restoreStateFromEntries,
  selectFollowTarget,
  snapshotState,
  splitCommandArgs,
  upsertHunkAgentGuidanceText,
  type HunkReviewStateSnapshot
} from "../extensions/hunk-review/index.js";

type FakeRegisteredCommand = {
  description?: string;
  handler: (args: string, context: ExtensionCommandContext) => unknown | Promise<unknown>;
};

type FakeHunkReviewApi = ExtensionAPI & {
  entries: Array<{ type: string; data: unknown }>;
  tools: ToolDefinition[];
  commands: Map<string, FakeRegisteredCommand>;
  handlers: Map<string, Function[]>;
};

function createFakeHunkReviewApi(): FakeHunkReviewApi {
  const entries: Array<{ type: string; data: unknown }> = [];
  const tools: ToolDefinition[] = [];
  const commands = new Map<string, FakeRegisteredCommand>();
  const handlers = new Map<string, Function[]>();
  return {
    entries,
    tools,
    commands,
    handlers,
    registerTool(tool: ToolDefinition): void {
      tools.push(tool);
    },
    registerCommand(name: string, command: unknown): void {
      commands.set(name, command as FakeRegisteredCommand);
    },
    on(event: string, handler: Function): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry(type: string, data: unknown): void {
      entries.push({ type, data });
    }
  } as unknown as FakeHunkReviewApi;
}

function fakeHunkReviewContext(cwd: string): ExtensionContext {
  return {
    cwd,
    ui: {
      setStatus(): void {}
    }
  } as unknown as ExtensionContext;
}

function fakeHunkReviewCommandContext(cwd: string, notifications: Array<{ text: string; level: string }>): ExtensionCommandContext {
  return {
    cwd,
    ui: {
      notify(text: string, level: string): void {
        notifications.push({ text, level });
      },
      setStatus(): void {}
    }
  } as unknown as ExtensionCommandContext;
}

function restoreHunkReviewState(api: FakeHunkReviewApi, cwd: string, entries: readonly unknown[]): void {
  const context = {
    ...fakeHunkReviewContext(cwd),
    sessionManager: { getBranch: () => entries }
  } as unknown as ExtensionContext;
  for (const handler of api.handlers.get("session_start") ?? []) {
    handler({}, context);
  }
}

function hunkReviewStateEntry(data: HunkReviewStateSnapshot): { type: "custom"; customType: "hunk-review-state"; data: HunkReviewStateSnapshot } {
  return { type: "custom", customType: "hunk-review-state", data };
}

function rememberedHunkState(repo: string, sessionId: string): HunkReviewStateSnapshot {
  return {
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    followEnabled: false,
    followDebounceMs: 1200,
    activeRepo: repo,
    activeRepoPinned: false,
    lastMode: "open",
    lastScope: "repo",
    lastLauncher: "iterm",
    touchedFilesByRepo: {},
    sessionsByRepo: {
      [repo]: {
        repo,
        launcher: "iterm",
        command: "hunk diff --watch",
        mode: "open",
        scope: "repo",
        startedAt: "2026-01-01T00:00:00.000Z",
        sessionId,
        dryRun: false
      }
    }
  };
}

test("hunk-review settings use package defaults and validate overrides", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-settings-"));
  try {
    const configPath = path.join(dir, "hunk-review-settings.json");
    writeFileSync(configPath, JSON.stringify({
      hunkBin: "/opt/bin/hunk",
      defaultLauncher: "iterm",
      followDebounceMs: 900,
      maxTouchedFiles: 12,
      allowAgentLaunch: true
    }), "utf8");

    const settings = readHunkReviewSettings(configPath);
    assert.equal(settings.hunkBin, "/opt/bin/hunk");
    assert.equal(settings.defaultLauncher, "iterm");
    assert.equal(settings.followDebounceMs, 900);
    assert.equal(settings.maxTouchedFiles, 12);
    assert.equal(settings.allowAgentLaunch, true);

    const badConfigPath = path.join(dir, "bad.json");
    writeFileSync(badConfigPath, JSON.stringify({ maxTouchedFiles: 0 }), "utf8");
    assert.throws(() => readHunkReviewSettings(badConfigPath), /maxTouchedFiles/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review extracts mutation paths from batch and reviewed-mutation results", () => {
  assert.deepEqual(extractTouchedPathsFromToolCall({
    toolName: "write_many",
    input: { writes: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }
  }), ["src/a.ts", "src/b.ts"]);

  assert.deepEqual(extractTouchedPathsFromToolCall({
    toolName: "edit_many",
    input: { files: [{ path: "src/c.ts", edits: [] }] }
  }), ["src/c.ts"]);

  assert.deepEqual(extractTouchedPathsFromToolResult({
    toolName: "apply_reviewed_mutation",
    input: {},
    details: { files: [{ resolvedPath: "/tmp/repo/src/d.ts" }, { path: "src/e.ts" }] }
  }), ["/tmp/repo/src/d.ts", "src/e.ts"]);

  assert.deepEqual(extractMutationTargetsFromToolResult({
    toolName: "edit_many",
    input: {},
    details: { files: [{ path: "src/f.ts", ranges: [{ startLine: 12, endLine: 14 }] }] }
  }), [{ path: "src/f.ts", line: 12 }]);
});

test("hunk-review resolves touched files to nearest child repository", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-repos-"));
  try {
    const repo = path.join(dir, "repo-one");
    const nested = path.join(repo, "src", "deep");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    const file = path.join(nested, "file.ts");
    writeFileSync(file, "export const value = 1;\n", "utf8");

    const realRepo = realpathSync(repo);
    assert.equal(findNearestRepoRoot(file), realRepo);
    assert.equal(repoRelativePath(realRepo, file), "src/deep/file.ts");

    const state = restoreStateFromEntries([], "repo");
    const tracked = recordTouchedFiles(state, dir, [path.relative(dir, file)], 80);
    assert.deepEqual(tracked.map((item) => item.repoPath), ["src/deep/file.ts"]);
    assert.deepEqual(snapshotState(state).touchedFilesByRepo, { [realRepo]: ["src/deep/file.ts"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review follow target respects pinned active repo", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-follow-"));
  try {
    const repoOne = path.join(dir, "repo-one");
    const repoTwo = path.join(dir, "repo-two");
    mkdirSync(path.join(repoOne, ".git"), { recursive: true });
    mkdirSync(path.join(repoTwo, ".git"), { recursive: true });
    mkdirSync(path.join(repoOne, "src"), { recursive: true });
    mkdirSync(path.join(repoTwo, "src"), { recursive: true });
    writeFileSync(path.join(repoOne, "src", "one.ts"), "one\n", "utf8");
    writeFileSync(path.join(repoTwo, "src", "two.ts"), "two\n", "utf8");

    const state = restoreStateFromEntries([], "repo");
    state.activeRepo = realpathSync(repoOne);
    state.activeRepoPinned = true;

    const target = selectFollowTarget(state, dir, [
      { path: "repo-two/src/two.ts", line: 4 },
      { path: "repo-one/src/one.ts", line: 8 }
    ]);

    assert.equal(target?.repo, realpathSync(repoOne));
    assert.equal(target?.repoPath, "src/one.ts");
    assert.equal(target?.line, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review treats git worktree .git files as repo roots", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-worktree-"));
  try {
    const repo = path.join(dir, "worktree");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, ".git"), "gitdir: ../.git/worktrees/worktree\n", "utf8");
    const file = path.join(repo, "src", "file.ts");
    writeFileSync(file, "export {};\n", "utf8");

    assert.equal(findNearestRepoRoot(file), realpathSync(repo));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review restores latest hidden state snapshot from session entries", () => {
  const older: HunkReviewStateSnapshot = {
    version: 1,
    updatedAt: "2026-01-01T00:00:00Z",
    followEnabled: false,
    followDebounceMs: 1200,
    activeRepoPinned: false,
    lastMode: "repo",
    lastScope: "repo",
    touchedFilesByRepo: {},
    sessionsByRepo: {}
  };
  const newer: HunkReviewStateSnapshot = {
    version: 1,
    updatedAt: "2026-01-01T00:00:01Z",
    followEnabled: true,
    followDebounceMs: 900,
    activeRepo: "/repo",
    activeRepoPinned: true,
    lastMode: "touched",
    lastScope: "touched",
    lastLauncher: "iterm",
    touchedFilesByRepo: { "/repo": ["src/a.ts"] },
    sessionsByRepo: {}
  };

  const state = restoreStateFromEntries([
    { type: "custom", customType: "hunk-review-state", data: older },
    { type: "custom", customType: "other", data: newer },
    { type: "custom", customType: "hunk-review-state", data: newer }
  ], "repo");

  assert.deepEqual(snapshotState(state), newer);
});

test("hunk-review registers single Hunk session tool and returns session ids", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-open-tool-"));
  const previousHunkBin = process.env.HUNK_BIN;
  try {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const realRepo = realpathSync(dir);
    const hunkBin = path.join(dir, "hunk");
    const hunkLog = path.join(dir, "hunk-args.jsonl");
    const fullSessionId = "6a580f7a-e149-40a8-bda0-0ed46b1a0b3f";
    const unownedSessionId = "11111111-2222-4333-8444-555555555555";
    writeFileSync(hunkBin, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(hunkLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("--version")) {
  console.log("hunk-test 1.0.0");
  process.exit(0);
}
if (process.argv[2] === "session" && process.argv[3] === "reload") {
  console.log("Reloaded session");
  process.exit(0);
}
if (process.argv[2] === "session" && process.argv[3] === "navigate") {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
console.log(JSON.stringify({ sessions: [
  { sessionId: ${JSON.stringify(fullSessionId)}, repoRoot: ${JSON.stringify(realRepo)}, launchedAt: "2026-01-01T00:00:00.000Z" },
  { sessionId: ${JSON.stringify(unownedSessionId)}, repoRoot: ${JSON.stringify(realRepo)}, launchedAt: "2026-01-02T00:00:00.000Z" }
] }));
`, "utf8");
    chmodSync(hunkBin, 0o755);
    process.env.HUNK_BIN = hunkBin;

    const api = createFakeHunkReviewApi();
    hunkReviewExtension(api);

    assert.equal(api.handlers.has("before_agent_start"), false);
    assert.equal(api.tools.some((item) => item.name === "hunk_open"), false);
    assert.equal(api.commands.has("hunk:open"), true);
    assert.equal(api.commands.has("hunk:follow"), true);
    assert.equal(api.commands.has("hunk:guidance"), true);
    assert.equal(api.commands.has("diff:open"), false);
    assert.equal(api.commands.has("diff:follow"), false);

    const sessionTool = api.tools.find((item) => item.name === "hunk_session");
    assert.ok(sessionTool?.execute);
    assert.equal(api.tools.some((item) => item.name === "hunk_window_open"), false);
    assert.match(sessionTool.description, /return its sessionId/);
    assert.match(sessionTool.description, /show the user Hunk diffs/);
    assert.match(sessionTool.description, /this Pi session/);
    assert.match(sessionTool.promptSnippet ?? "", /Get or create this Pi session's Hunk session/);
    assert.ok(sessionTool.promptGuidelines?.some((line) => line.includes("hunk session navigate")));
    assert.ok(sessionTool.promptGuidelines?.some((line) => line.includes("Do not run /hunk:* slash commands yourself")));
    const toolProperties = (sessionTool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    assert.equal(Object.hasOwn(toolProperties, "scope"), false);
    assert.equal(Object.hasOwn(toolProperties, "file"), true);
    assert.equal(Object.hasOwn(toolProperties, "newLine"), true);

    restoreHunkReviewState(api, dir, [hunkReviewStateEntry(rememberedHunkState(realRepo, fullSessionId))]);

    const sessionResult = await sessionTool.execute(
      "tool-call-id",
      { repo: dir },
      new AbortController().signal,
      undefined,
      fakeHunkReviewContext(dir)
    );

    const sessionDetails = sessionResult.details as { repo: string; reused: boolean; reloaded: boolean; sessionId: string; command: string; reloadCommand: string; pathspecs: string[] };
    assert.equal(sessionDetails.repo, realRepo);
    assert.equal("scope" in sessionDetails, false);
    assert.equal(sessionDetails.reused, true);
    assert.equal(sessionDetails.reloaded, true);
    assert.equal(sessionDetails.sessionId, fullSessionId);
    assert.notEqual(sessionDetails.sessionId, unownedSessionId);
    assert.deepEqual(sessionDetails.pathspecs, []);
    assert.match(sessionDetails.command, /hunk.*diff.*--watch/);
    assert.match(sessionDetails.reloadCommand, /session.*reload.*--source.*diff/);
    assert.match(sessionResult.content[0]?.type === "text" ? sessionResult.content[0].text : "", new RegExp(fullSessionId));
    assert.equal(api.entries.length, 1);

    const secondResult = await sessionTool.execute(
      "tool-call-id-2",
      { repo: dir },
      new AbortController().signal,
      undefined,
      fakeHunkReviewContext(dir)
    );
    const secondDetails = secondResult.details as { reused: boolean; reloaded: boolean; sessionId: string; pathspecs: string[] };
    assert.equal(secondDetails.reused, true);
    assert.equal(secondDetails.reloaded, true);
    assert.equal(secondDetails.sessionId, fullSessionId);
    assert.deepEqual(secondDetails.pathspecs, []);
    assert.match(secondResult.content[0]?.type === "text" ? secondResult.content[0].text : "", new RegExp(fullSessionId));
    const focusedResult = await sessionTool.execute(
      "tool-call-id-3",
      { repo: dir, file: "src/a.ts", newLine: 7 },
      new AbortController().signal,
      undefined,
      fakeHunkReviewContext(dir)
    );
    const focusedDetails = focusedResult.details as { focused: boolean; focusCommand: string; reused: boolean; reloaded: boolean; pathspecs: string[] };
    assert.equal(focusedDetails.reused, true);
    assert.equal(focusedDetails.reloaded, true);
    assert.equal(focusedDetails.focused, true);
    assert.deepEqual(focusedDetails.pathspecs, []);
    assert.match(focusedDetails.focusCommand, /session.*navigate.*src\/a\.ts.*--new-line.*7/);
    assert.match(focusedResult.content[0]?.type === "text" ? focusedResult.content[0].text : "", /Focused Hunk on src\/a\.ts new-line 7/);

    const loggedArgs = readFileSync(hunkLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const reloads = loggedArgs.filter((args) => args[0] === "session" && args[1] === "reload");
    assert.deepEqual(reloads, [
      ["session", "reload", fullSessionId, "--source", realRepo, "--", "diff"],
      ["session", "reload", fullSessionId, "--source", realRepo, "--", "diff"],
      ["session", "reload", fullSessionId, "--source", realRepo, "--", "diff"]
    ]);
    assert.deepEqual(loggedArgs.filter((args) => args[0] === "session" && args[1] === "navigate"), [
      ["session", "navigate", fullSessionId, "--file", "src/a.ts", "--new-line", "7", "--json"]
    ]);
    assert.equal(loggedArgs.some((args) => args.join("\u0000").includes("diff\u0000--\u0000src/a.ts")), false);
    assert.equal(api.entries.length, 3);
  } finally {
    if (previousHunkBin === undefined) {
      delete process.env.HUNK_BIN;
    } else {
      process.env.HUNK_BIN = previousHunkBin;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review tool focus refreshes repo-wide source before retrying missing navigation", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-focus-refresh-"));
  const previousHunkBin = process.env.HUNK_BIN;
  try {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const realRepo = realpathSync(dir);
    const hunkBin = path.join(dir, "hunk");
    const hunkLog = path.join(dir, "hunk-args.jsonl");
    const navigateCount = path.join(dir, "navigate-count.txt");
    const fullSessionId = "3ba83366-f2dd-4f51-9393-1f138c1d2618";
    writeFileSync(hunkBin, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(hunkLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("--version")) {
  console.log("hunk-test 1.0.0");
  process.exit(0);
}
if (process.argv[2] === "session" && process.argv[3] === "reload") {
  console.log("Reloaded session");
  process.exit(0);
}
if (process.argv[2] === "session" && process.argv[3] === "navigate") {
  const countPath = ${JSON.stringify(navigateCount)};
  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;
  fs.writeFileSync(countPath, String(count + 1));
  if (count === 0) {
    console.error("hunk: No diff file matches src/new.ts.");
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
console.log(JSON.stringify({ sessions: [{ sessionId: ${JSON.stringify(fullSessionId)}, repoRoot: ${JSON.stringify(realRepo)}, launchedAt: "2026-01-01T00:00:00.000Z" }] }));
`, "utf8");
    chmodSync(hunkBin, 0o755);
    process.env.HUNK_BIN = hunkBin;

    const api = createFakeHunkReviewApi();
    hunkReviewExtension(api);
    restoreHunkReviewState(api, dir, [hunkReviewStateEntry(rememberedHunkState(realRepo, fullSessionId))]);
    const sessionTool = api.tools.find((item) => item.name === "hunk_session");
    assert.ok(sessionTool?.execute);

    const result = await sessionTool.execute(
      "tool-call-id",
      { repo: dir, file: "src/new.ts", newLine: 3 },
      new AbortController().signal,
      undefined,
      fakeHunkReviewContext(dir)
    );
    const details = result.details as { focused: boolean; reloaded: boolean; reloadCommand: string; pathspecs: string[] };
    assert.equal(details.focused, true);
    assert.equal(details.reloaded, true);
    assert.deepEqual(details.pathspecs, []);
    assert.match(details.reloadCommand, /session.*reload.*--source.*diff/);
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Refreshed repo-wide Hunk source and focused Hunk on src\/new\.ts new-line 3/);

    const loggedArgs = readFileSync(hunkLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(loggedArgs.filter((args) => args[0] === "session" && args[1] === "reload"), [
      ["session", "reload", fullSessionId, "--source", realRepo, "--", "diff"],
      ["session", "reload", fullSessionId, "--source", realRepo, "--", "diff"]
    ]);
    assert.deepEqual(loggedArgs.filter((args) => args[0] === "session" && args[1] === "navigate"), [
      ["session", "navigate", fullSessionId, "--file", "src/new.ts", "--new-line", "3", "--json"],
      ["session", "navigate", fullSessionId, "--file", "src/new.ts", "--new-line", "3", "--json"]
    ]);
    assert.equal(loggedArgs.some((args) => args.join("\u0000").includes("diff\u0000--\u0000src/new.ts")), false);
  } finally {
    if (previousHunkBin === undefined) {
      delete process.env.HUNK_BIN;
    } else {
      process.env.HUNK_BIN = previousHunkBin;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review hunk_session launches a new session instead of claiming an unremembered daemon session", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-owned-launch-"));
  const previousHunkBin = process.env.HUNK_BIN;
  const previousPath = process.env.PATH;
  try {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const realRepo = realpathSync(dir);
    const fakeBinDir = path.join(dir, "bin");
    mkdirSync(fakeBinDir, { recursive: true });
    const launchMarker = path.join(dir, "launched.txt");
    const osascriptBin = path.join(fakeBinDir, "osascript");
    writeFileSync(osascriptBin, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(launchMarker)}, "launched");
`, "utf8");
    chmodSync(osascriptBin, 0o755);

    const hunkBin = path.join(dir, "hunk");
    const hunkLog = path.join(dir, "hunk-args.jsonl");
    const unownedSessionId = "11111111-2222-4333-8444-555555555555";
    const createdSessionId = "6a580f7a-e149-40a8-bda0-0ed46b1a0b3f";
    writeFileSync(hunkBin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(hunkLog)}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) {
  console.log("hunk-test 1.0.0");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "list") {
  const sessions = [{ sessionId: ${JSON.stringify(unownedSessionId)}, repoRoot: ${JSON.stringify(realRepo)}, launchedAt: "2026-01-01T00:00:00.000Z" }];
  if (fs.existsSync(${JSON.stringify(launchMarker)})) {
    sessions.push({ sessionId: ${JSON.stringify(createdSessionId)}, repoRoot: ${JSON.stringify(realRepo)}, launchedAt: "2026-01-02T00:00:00.000Z" });
  }
  console.log(JSON.stringify({ sessions }));
  process.exit(0);
}
if (args[0] === "session" && args[1] === "reload") {
  if (args[2] === ${JSON.stringify(unownedSessionId)}) {
    console.error("unowned session must not be reused");
    process.exit(1);
  }
  console.log("Reloaded session");
  process.exit(0);
}
console.error("unexpected hunk args", JSON.stringify(args));
process.exit(1);
`, "utf8");
    chmodSync(hunkBin, 0o755);
    process.env.HUNK_BIN = hunkBin;
    process.env.PATH = `${fakeBinDir}${path.delimiter}${previousPath ?? ""}`;

    const api = createFakeHunkReviewApi();
    hunkReviewExtension(api);
    restoreHunkReviewState(api, dir, []);
    const sessionTool = api.tools.find((item) => item.name === "hunk_session");
    assert.ok(sessionTool?.execute);

    const result = await sessionTool.execute(
      "tool-call-id",
      { repo: dir, launcher: "iterm" },
      new AbortController().signal,
      undefined,
      fakeHunkReviewContext(dir)
    );
    const details = result.details as { launched: boolean; reused: boolean; reloaded: boolean; sessionId: string };
    assert.equal(details.launched, true);
    assert.equal(details.reused, false);
    assert.equal(details.reloaded, false);
    assert.equal(details.sessionId, createdSessionId);

    const loggedArgs = readFileSync(hunkLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(loggedArgs.filter((args) => args[0] === "session" && args[1] === "reload"), []);
    assert.equal(loggedArgs.filter((args) => args[0] === "session" && args[1] === "list").length, 2);
    assert.equal(api.entries.length, 1);
    const snapshot = api.entries.at(-1)?.data as HunkReviewStateSnapshot;
    assert.equal(snapshot.sessionsByRepo[realRepo]?.sessionId, createdSessionId);
  } finally {
    if (previousHunkBin === undefined) {
      delete process.env.HUNK_BIN;
    } else {
      process.env.HUNK_BIN = previousHunkBin;
    }
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review hunk_session refuses unremembered daemon sessions when agent launches are disabled", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-owned-disabled-"));
  const previousHunkBin = process.env.HUNK_BIN;
  const previousConfigDir = process.env.PI_TOOLS_CONFIG_DIR;
  try {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const realRepo = realpathSync(dir);
    const configDir = path.join(dir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "hunk-review-settings.json"), JSON.stringify({ allowAgentLaunch: false }), "utf8");
    const hunkBin = path.join(dir, "hunk");
    const hunkLog = path.join(dir, "hunk-args.jsonl");
    const unownedSessionId = "11111111-2222-4333-8444-555555555555";
    writeFileSync(hunkBin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(hunkLog)}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) {
  console.log("hunk-test 1.0.0");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "list") {
  console.log(JSON.stringify({ sessions: [{ sessionId: ${JSON.stringify(unownedSessionId)}, repoRoot: ${JSON.stringify(realRepo)}, launchedAt: "2026-01-01T00:00:00.000Z" }] }));
  process.exit(0);
}
if (args[0] === "session" && args[1] === "reload") {
  console.error("unowned session must not be reused");
  process.exit(1);
}
console.error("unexpected hunk args", JSON.stringify(args));
process.exit(1);
`, "utf8");
    chmodSync(hunkBin, 0o755);
    process.env.HUNK_BIN = hunkBin;
    process.env.PI_TOOLS_CONFIG_DIR = configDir;

    const api = createFakeHunkReviewApi();
    hunkReviewExtension(api);
    restoreHunkReviewState(api, dir, []);
    const sessionTool = api.tools.find((item) => item.name === "hunk_session");
    assert.ok(sessionTool?.execute);

    await assert.rejects(
      () => sessionTool.execute("tool-call-id", { repo: dir }, new AbortController().signal, undefined, fakeHunkReviewContext(dir)),
      /No Hunk session is remembered.*agent Hunk launches are disabled/
    );

    const loggedArgs = readFileSync(hunkLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(loggedArgs.some((args) => args[0] === "session" && args[1] === "reload"), false);
    assert.equal(api.entries.length, 0);
  } finally {
    if (previousHunkBin === undefined) {
      delete process.env.HUNK_BIN;
    } else {
      process.env.HUNK_BIN = previousHunkBin;
    }
    if (previousConfigDir === undefined) {
      delete process.env.PI_TOOLS_CONFIG_DIR;
    } else {
      process.env.PI_TOOLS_CONFIG_DIR = previousConfigDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review hunk_session clears stale remembered sessions without claiming unowned sessions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-owned-stale-"));
  const previousHunkBin = process.env.HUNK_BIN;
  const previousConfigDir = process.env.PI_TOOLS_CONFIG_DIR;
  try {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const realRepo = realpathSync(dir);
    const configDir = path.join(dir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "hunk-review-settings.json"), JSON.stringify({ allowAgentLaunch: false }), "utf8");
    const hunkBin = path.join(dir, "hunk");
    const hunkLog = path.join(dir, "hunk-args.jsonl");
    const staleSessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const unownedSessionId = "11111111-2222-4333-8444-555555555555";
    writeFileSync(hunkBin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(hunkLog)}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) {
  console.log("hunk-test 1.0.0");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "list") {
  console.log(JSON.stringify({ sessions: [{ sessionId: ${JSON.stringify(unownedSessionId)}, repoRoot: ${JSON.stringify(realRepo)}, launchedAt: "2026-01-01T00:00:00.000Z" }] }));
  process.exit(0);
}
if (args[0] === "session" && args[1] === "reload") {
  console.error("unowned session must not be reused");
  process.exit(1);
}
console.error("unexpected hunk args", JSON.stringify(args));
process.exit(1);
`, "utf8");
    chmodSync(hunkBin, 0o755);
    process.env.HUNK_BIN = hunkBin;
    process.env.PI_TOOLS_CONFIG_DIR = configDir;

    const api = createFakeHunkReviewApi();
    hunkReviewExtension(api);
    restoreHunkReviewState(api, dir, [hunkReviewStateEntry(rememberedHunkState(realRepo, staleSessionId))]);
    const sessionTool = api.tools.find((item) => item.name === "hunk_session");
    assert.ok(sessionTool?.execute);

    await assert.rejects(
      () => sessionTool.execute("tool-call-id", { repo: dir }, new AbortController().signal, undefined, fakeHunkReviewContext(dir)),
      new RegExp(`Remembered Hunk session ${staleSessionId} is no longer active`)
    );

    const loggedArgs = readFileSync(hunkLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(loggedArgs.some((args) => args[0] === "session" && args[1] === "reload"), false);
    assert.equal(api.entries.length, 1);
    const snapshot = api.entries.at(-1)?.data as HunkReviewStateSnapshot;
    assert.deepEqual(snapshot.sessionsByRepo, {});
  } finally {
    if (previousHunkBin === undefined) {
      delete process.env.HUNK_BIN;
    } else {
      process.env.HUNK_BIN = previousHunkBin;
    }
    if (previousConfigDir === undefined) {
      delete process.env.PI_TOOLS_CONFIG_DIR;
    } else {
      process.env.PI_TOOLS_CONFIG_DIR = previousConfigDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review slash focus discovers a full session id before navigating", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-slash-focus-session-"));
  const previousHunkBin = process.env.HUNK_BIN;
  try {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.ts"), "export {};\n", "utf8");
    const realRepo = realpathSync(dir);
    const hunkBin = path.join(dir, "hunk");
    const hunkLog = path.join(dir, "hunk-args.jsonl");
    const fullSessionId = "6a580f7a-e149-40a8-bda0-0ed46b1a0b3f";
    writeFileSync(hunkBin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(hunkLog)}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) {
  console.log("hunk-test 1.0.0");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "list") {
  console.log(JSON.stringify({ sessions: [
    { sessionId: "older", repoRoot: ${JSON.stringify(realRepo)}, launchedAt: "2026-01-01T00:00:00.000Z" },
    { sessionId: ${JSON.stringify(fullSessionId)}, repoRoot: ${JSON.stringify(realRepo)}, launchedAt: "2026-01-02T00:00:00.000Z" }
  ] }));
  process.exit(0);
}
if (args[0] === "session" && args[1] === "navigate") {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
console.error("unexpected hunk args", JSON.stringify(args));
process.exit(1);
`, "utf8");
    chmodSync(hunkBin, 0o755);
    process.env.HUNK_BIN = hunkBin;

    const api = createFakeHunkReviewApi();
    hunkReviewExtension(api);
    const startContext = {
      ...fakeHunkReviewContext(dir),
      sessionManager: { getBranch: () => [] }
    } as unknown as ExtensionContext;
    for (const handler of api.handlers.get("session_start") ?? []) {
      handler({}, startContext);
    }

    const notifications: Array<{ text: string; level: string }> = [];
    const command = api.commands.get("hunk:focus");
    assert.ok(command);
    await command.handler(`src/a.ts --repo ${dir} --new-line 7`, fakeHunkReviewCommandContext(dir, notifications));
    assert.match(notifications.at(-1)?.text ?? "", /Focused Hunk on src\/a\.ts new-line 7/);

    const loggedArgs = readFileSync(hunkLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(loggedArgs.filter((args) => args[0] === "session" && args[1] === "navigate"), [
      ["session", "navigate", fullSessionId, "--file", "src/a.ts", "--new-line", "7", "--json"]
    ]);
    assert.equal(loggedArgs.some((args) => args[0] === "session" && args[1] === "navigate" && args.includes("--repo")), false);
    assert.equal(api.entries.length, 1);
  } finally {
    if (previousHunkBin === undefined) {
      delete process.env.HUNK_BIN;
    } else {
      process.env.HUNK_BIN = previousHunkBin;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review slash focus discovers a session id after repo navigation cannot match an active session", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-slash-focus-retry-"));
  const previousHunkBin = process.env.HUNK_BIN;
  try {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "new.ts"), "export {};\n", "utf8");
    const realRepo = realpathSync(dir);
    const hunkBin = path.join(dir, "hunk");
    const hunkLog = path.join(dir, "hunk-args.jsonl");
    const listCountPath = path.join(dir, "list-count.txt");
    const fullSessionId = "3ba83366-f2dd-4f51-9393-1f138c1d2618";
    writeFileSync(hunkBin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(hunkLog)}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) {
  console.log("hunk-test 1.0.0");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "list") {
  const countPath = ${JSON.stringify(listCountPath)};
  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;
  fs.writeFileSync(countPath, String(count + 1));
  const sessions = count === 0 ? [] : [{ sessionId: ${JSON.stringify(fullSessionId)}, repoRoot: ${JSON.stringify(realRepo)}, launchedAt: "2026-01-02T00:00:00.000Z" }];
  console.log(JSON.stringify({ sessions }));
  process.exit(0);
}
if (args[0] === "session" && args[1] === "reload") {
  console.log("Reloaded session");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "navigate") {
  if (args[2] === "--repo") {
    console.error("hunk: No active session matches repo ${realRepo}.");
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
console.error("unexpected hunk args", JSON.stringify(args));
process.exit(1);
`, "utf8");
    chmodSync(hunkBin, 0o755);
    process.env.HUNK_BIN = hunkBin;

    const api = createFakeHunkReviewApi();
    hunkReviewExtension(api);
    const startContext = {
      ...fakeHunkReviewContext(dir),
      sessionManager: { getBranch: () => [] }
    } as unknown as ExtensionContext;
    for (const handler of api.handlers.get("session_start") ?? []) {
      handler({}, startContext);
    }

    const notifications: Array<{ text: string; level: string }> = [];
    const command = api.commands.get("hunk:focus");
    assert.ok(command);
    await command.handler(`src/new.ts --repo ${dir} --new-line 3`, fakeHunkReviewCommandContext(dir, notifications));
    assert.match(notifications.at(-1)?.text ?? "", /Refreshed repo-wide Hunk source and focused Hunk on src\/new\.ts new-line 3/);

    const loggedArgs = readFileSync(hunkLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(loggedArgs.filter((args) => args[0] === "session" && args[1] === "reload"), [
      ["session", "reload", fullSessionId, "--source", realRepo, "--", "diff"]
    ]);
    assert.deepEqual(loggedArgs.filter((args) => args[0] === "session" && args[1] === "navigate"), [
      ["session", "navigate", "--repo", realRepo, "--file", "src/new.ts", "--new-line", "3", "--json"],
      ["session", "navigate", fullSessionId, "--file", "src/new.ts", "--new-line", "3", "--json"]
    ]);
    assert.equal(api.entries.length, 1);
  } finally {
    if (previousHunkBin === undefined) {
      delete process.env.HUNK_BIN;
    } else {
      process.env.HUNK_BIN = previousHunkBin;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review status text shows full Hunk session ids for CLI copy", () => {
  const fullSessionId = "6a580f7a-e149-40a8-bda0-0ed46b1a0b3f";
  const text = buildHunkReviewStatusText({
    followEnabled: false,
    followDebounceMs: 1200,
    activeRepoPinned: false,
    lastMode: "open",
    lastScope: "repo",
    settings: {
      defaultLauncher: "auto",
      followDebounceMs: 1200,
      maxTouchedFiles: 80,
      allowAgentLaunch: true,
      configSource: "test"
    },
    hunk: { available: true },
    launchers: [],
    touchedRepos: [],
    sessions: [{
      repo: "/repo",
      launcher: "iterm",
      command: "hunk diff --watch",
      mode: "open",
      scope: "repo",
      startedAt: "2026-01-01T00:00:00.000Z",
      sessionId: fullSessionId
    }]
  });

  assert.match(text, new RegExp(`sessionId=${fullSessionId}`));
  assert.doesNotMatch(text, /#6a580f7a/);
});

test("hunk-review saves and updates optional Hunk AGENTS guidance snippet", () => {
  const snippet = readHunkAgentGuidanceSnippet();
  assert.match(snippet, /# Code Review Guidance/);
  assert.equal(snippet.includes("hunk_window_open"), false);
  assert.match(snippet, /hunk_session/);

  const block = buildHunkAgentGuidanceBlock(snippet);
  assert.match(block, /akoumjian-pi-tools:hunk-code-review-guidance:start/);
  assert.match(block, /akoumjian-pi-tools:hunk-code-review-guidance:end/);

  const installed = upsertHunkAgentGuidanceText("# Existing Guidance\n", snippet);
  assert.equal(installed.changed, true);
  assert.match(installed.content, /# Existing Guidance/);
  assert.match(installed.content, /# Code Review Guidance/);
  assert.equal(inspectHunkAgentGuidanceText(installed.content, "/tmp/AGENTS.md", snippet).state, "installed");

  const unchanged = upsertHunkAgentGuidanceText(installed.content, snippet);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.content, installed.content);

  const modified = installed.content.replace("Use hunk related tools", "Use reviewed hunk related tools");
  assert.equal(inspectHunkAgentGuidanceText(modified, "/tmp/AGENTS.md", snippet).state, "modified");

  const unmarked = `# Existing Guidance\n\n${snippet}`;
  assert.equal(inspectHunkAgentGuidanceText(unmarked, "/tmp/AGENTS.md", snippet).state, "present-unmarked");
  const unmarkedUpdate = upsertHunkAgentGuidanceText(unmarked, snippet);
  assert.equal(unmarkedUpdate.changed, false);

  const removed = removeHunkAgentGuidanceText(installed.content);
  assert.equal(removed.changed, true);
  assert.doesNotMatch(removed.content, /akoumjian-pi-tools:hunk-code-review-guidance/);
  assert.equal(inspectHunkAgentGuidanceText(removed.content, "/tmp/AGENTS.md", snippet).state, "missing");

  assert.throws(
    () => inspectHunkAgentGuidanceText("<!-- akoumjian-pi-tools:hunk-code-review-guidance:start -->", "/tmp/AGENTS.md", snippet),
    /incomplete Hunk Code Review Guidance marker block/
  );
});

test("hunk-review guidance command installs and removes the global AGENTS snippet", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-guidance-command-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    const api = createFakeHunkReviewApi();
    hunkReviewExtension(api);
    const command = api.commands.get("hunk:guidance");
    assert.ok(command);

    const notifications: Array<{ text: string; level: string }> = [];
    const context = fakeHunkReviewCommandContext(dir, notifications);
    const agentsPath = path.join(dir, "AGENTS.md");

    await command.handler("status", context);
    assert.match(notifications.at(-1)?.text ?? "", /not installed/);

    await command.handler("install --dry-run", context);
    assert.equal(existsSync(agentsPath), false);
    assert.match(notifications.at(-1)?.text ?? "", /Would install\/update/);

    await command.handler("install", context);
    assert.match(readFileSync(agentsPath, "utf8"), /# Code Review Guidance/);
    assert.match(readFileSync(agentsPath, "utf8"), /akoumjian-pi-tools:hunk-code-review-guidance:start/);
    assert.match(notifications.at(-1)?.text ?? "", /Installed Hunk Code Review Guidance/);

    await command.handler("status", context);
    assert.match(notifications.at(-1)?.text ?? "", /is installed/);

    await command.handler("remove --dry-run", context);
    assert.match(readFileSync(agentsPath, "utf8"), /# Code Review Guidance/);
    assert.match(notifications.at(-1)?.text ?? "", /Would remove/);

    await command.handler("remove", context);
    assert.equal(readFileSync(agentsPath, "utf8"), "");
    assert.match(notifications.at(-1)?.text ?? "", /Removed the marked Hunk Code Review Guidance block/);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review builds Hunk commands for open and focus", () => {
  assert.deepEqual(buildHunkDiffArgs({ watch: true, pathspecs: ["src/a.ts", "README.md"] }), [
    "diff",
    "--watch",
    "--",
    "src/a.ts",
    "README.md"
  ]);
  assert.deepEqual(buildHunkDiffArgs({ base: "main...HEAD" }), ["diff", "main...HEAD"]);
  assert.deepEqual(buildHunkSessionNavigateArgs({ repo: "/repo", file: "src/a.ts", selector: { label: "new-line", value: 42 } }), [
    "session",
    "navigate",
    "--repo",
    "/repo",
    "--file",
    "src/a.ts",
    "--new-line",
    "42",
    "--json"
  ]);
  assert.deepEqual(buildHunkSessionNavigateArgs({ repo: "/repo", sessionId: "session-1", file: "src/a.ts", selector: { label: "new-line", value: 42 } }), [
    "session",
    "navigate",
    "session-1",
    "--file",
    "src/a.ts",
    "--new-line",
    "42",
    "--json"
  ]);
  assert.deepEqual(buildHunkSessionReloadArgs({ repo: "/repo", sessionId: "session-1" }), [
    "session",
    "reload",
    "session-1",
    "--source",
    "/repo",
    "--",
    "diff"
  ]);
  assert.deepEqual(buildHunkSessionReloadArgs({ repo: "/repo", pathspecs: ["src/a.ts"] }), [
    "session",
    "reload",
    "--repo",
    "/repo",
    "--source",
    "/repo",
    "--",
    "diff",
    "--",
    "src/a.ts"
  ]);
});

test("hunk-review selects the newest reusable Hunk session for a repo", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-hunk-session-"));
  try {
    const repo = path.join(dir, "repo");
    const other = path.join(dir, "other");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(path.join(other, ".git"), { recursive: true });
    const realRepo = realpathSync(repo);
    const sessions = parseHunkSessionList({
      sessions: [
        { sessionId: "older", repoRoot: realRepo, launchedAt: "2026-01-01T00:00:00.000Z", title: "repo" },
        { sessionId: "ignored", repoRoot: realpathSync(other), launchedAt: "2026-01-03T00:00:00.000Z", title: "other" },
        { sessionId: "newer", repoRoot: realRepo, launchedAt: "2026-01-02T00:00:00.000Z", title: "repo" }
      ]
    });

    assert.equal(selectReusableHunkSession(sessions, realRepo)?.sessionId, "newer");
    assert.equal(selectRememberedHunkSession(sessions, realRepo, "older")?.sessionId, "older");
    assert.equal(selectRememberedHunkSession(sessions, realRepo, "ignored"), undefined);
    assert.equal(selectRememberedHunkSession(sessions, realRepo, undefined), undefined);
    assert.equal(selectNewHunkSession(sessions, realRepo, ["older"])?.sessionId, "newer");
    assert.equal(selectNewHunkSession(sessions, realRepo, ["older", "newer"]), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review discovers and attaches newly launched Hunk sessions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hunk-review-hunk-discovery-"));
  try {
    const repo = path.join(dir, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    const realRepo = realpathSync(repo);
    const hunkBin = path.join(dir, "hunk");
    const createdSessionId = "6a580f7a-e149-40a8-bda0-0ed46b1a0b3f";
    writeFileSync(hunkBin, `#!/usr/bin/env node
const sessions = [{ sessionId: "existing", repoRoot: ${JSON.stringify(realRepo)}, launchedAt: "2026-01-01T00:00:00.000Z" }, { sessionId: ${JSON.stringify(createdSessionId)}, repoRoot: ${JSON.stringify(realRepo)}, launchedAt: "2026-01-02T00:00:00.000Z" }];
console.log(JSON.stringify({ sessions }));
`, "utf8");
    chmodSync(hunkBin, 0o755);

    const discovered = findNewHunkSession(hunkBin, realRepo, ["existing"]);
    assert.equal(discovered?.sessionId, createdSessionId);

    const launch = attachSessionToLaunch({
      launcher: "iterm",
      resolvedLauncher: "iterm",
      launched: true,
      reused: false,
      reloaded: false,
      command: "hunk diff --watch",
      message: "Opened Hunk in an iTerm2 split for repo."
    }, discovered!);
    assert.equal(launch.sessionId, createdSessionId);
    assert.match(launch.message, new RegExp(`Session: ${createdSessionId}\\.`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk-review detects iTerm launcher only in iTerm on macOS", () => {
  const inIterm = detectLaunchers({ ITERM_SESSION_ID: "w0t0p0" }, "darwin");
  assert.equal(inIterm.find((launcher) => launcher.id === "iterm")?.available, true);

  const notIterm = detectLaunchers({}, "darwin");
  assert.equal(notIterm.find((launcher) => launcher.id === "iterm")?.available, false);
  assert.equal(notIterm.find((launcher) => launcher.id === "manual")?.available, true);
});

test("hunk-review quotes iTerm shell commands inside AppleScript", () => {
  const script = buildItermSplitAppleScript("cd '/tmp/repo with spaces' && exec 'hunk' 'diff' '--watch'");
  assert.match(script, /split vertically with default profile/);
  assert.match(script, /write text "/);
  assert.match(script, /repo with spaces/);
});

test("hunk-review targets the originating iTerm session when available", () => {
  const sessionId = "A07B6FCE-2E14-4598-9CF3-01223B82CDE1";
  assert.equal(itermSessionIdFromEnv({ ITERM_SESSION_ID: `w0t0p0:${sessionId}` }), sessionId);
  assert.equal(itermSessionIdFromEnv({ TERM_SESSION_ID: `w1t2p3:${sessionId.toLowerCase()}` }), sessionId);
  assert.equal(itermSessionIdFromEnv({ ITERM_SESSION_ID: "w0t0p0" }), undefined);

  const script = buildItermSplitAppleScript("echo hunk", sessionId);
  assert.match(script, /repeat with aWindow in windows/);
  assert.match(script, new RegExp(`if id of aSession is "${sessionId}"`));
  assert.doesNotMatch(script, /tell current window/);
});

test("hunk-review follow mode warns without a launched Hunk view", () => {
  assert.equal(buildFollowModeMessage(false, 1200, false), "Follow mode is off.");
  assert.equal(
    buildFollowModeMessage(true, 1200, true),
    "Follow mode is on. Hunk will move to tool-edited files after 1200ms of quiet time."
  );
  assert.match(buildFollowModeMessage(true, 1200, false), /No launched Hunk view is remembered/);
});

test("hunk-review command arg splitter handles simple quotes", () => {
  assert.deepEqual(splitCommandArgs("--repo '/tmp/repo one' --dry-run"), [
    "--repo",
    "/tmp/repo one",
    "--dry-run"
  ]);
});
