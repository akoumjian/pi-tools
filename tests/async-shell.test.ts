import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { existsSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import asyncShellExtension, {
  ASYNC_SHELL_ACTIVITY_STATUS_KEY,
  activeAsyncShellJobCount,
  activeAsyncShellJobsForOwner,
  buildAsyncShellPruneUsage,
  buildAsyncShellStatusText,
  buildAsyncShellViewerFrame,
  buildAsyncShellViewerUsage,
  cancelAsyncShellJobsForOwner,
  cancelPersistedAsyncShellJobsForOwner,
  createAsyncShellViewerComponent,
  loadAsyncShellViewerSnapshot,
  latestAsyncShellRetentionSnapshot,
  listEligibleAsyncShellPrune,
  migrateAsyncShellRuntimeHolder,
  parseAsyncShellPruneArgs,
  parseAsyncShellViewerArgs,
  previewAsyncShellPrune,
  pruneAsyncShellJobs,
  recoverAsyncShellPruneLeftovers,
  refreshAsyncShellRetentionSnapshot,
  sanitizeAsyncShellViewerText,
  renderAsyncShellActivityStatus,
  startManagedAsyncJob,
  type AsyncShellViewerSnapshot
} from "../extensions/async-shell/index.js";
import { managedWorkerEvidenceReason, readManagedWorkerHostJobIds, scanAsyncShellRetention } from "../extensions/async-shell/retention.js";

type SentMessage = {
  message: unknown;
  options: unknown;
};

type FakeApi = ExtensionAPI & {
  registeredTools: ToolDefinition[];
  sentMessages: SentMessage[];
  commands: Map<string, { description: string; handler: Function }>;
  handlers: Map<string, Function[]>;
  emit(event: string, data: unknown, context: ExtensionContext): Promise<void>;
};

function createContext(cwd: string, isIdle: boolean | (() => boolean) = true): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => `test-session:${cwd}`
    },
    isIdle: typeof isIdle === "function" ? isIdle : () => isIdle,
    hasPendingMessages: () => false
  } as ExtensionContext;
}

function createFakeApi(): FakeApi {
  const registeredTools: ToolDefinition[] = [];
  const sentMessages: SentMessage[] = [];
  const commands = new Map<string, { description: string; handler: Function }>();
  const handlers = new Map<string, Function[]>();
  const fake = {
    registeredTools,
    sentMessages,
    commands,
    handlers,
    registerCommand(name: string, command: { description: string; handler: Function }): void {
      commands.set(name, command);
    },
    registerMessageRenderer(): void {},
    registerTool(tool: ToolDefinition): void {
      registeredTools.push(tool);
    },
    on(event: string, handler: Function): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async emit(event: string, data: unknown, context: ExtensionContext): Promise<void> {
      for (const handler of handlers.get(event) ?? []) {
        await handler(data, context);
      }
    },
    sendMessage(message: unknown, options: unknown): void {
      sentMessages.push({ message, options });
    }
  };
  return fake as unknown as FakeApi;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-async-shell-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function required<T>(value: T | undefined, name: string): T {
  assert.notEqual(value, undefined, name);
  if (value === undefined) {
    throw new Error(name);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installAsyncMetaRenameEnospc(): () => void {
  const originalRenameSync = fs.renameSync;
  fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
    if (path.basename(String(newPath)) === "meta.json" && String(newPath).includes(`${path.sep}.pi${path.sep}async-shell${path.sep}jobs${path.sep}`)) {
      const error = Object.assign(new Error("ENOSPC: injected async metadata rename failure"), { code: "ENOSPC" });
      throw error;
    }
    return originalRenameSync(oldPath, newPath);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  return () => {
    fs.renameSync = originalRenameSync;
    syncBuiltinESMExports();
  };
}

async function waitWithRefTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for completion.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const plainTheme = {
  fg(_color: string, text: string): string {
    return text;
  },
  bold(text: string): string {
    return text;
  }
} as unknown as Theme;

function viewerSnapshot(overrides: Partial<AsyncShellViewerSnapshot> = {}): AsyncShellViewerSnapshot {
  const jobId = "job_20260803170000_viewtest";
  const logDir = "/tmp/viewer/.pi/async-shell/jobs/job_20260803170000_viewtest";
  return {
    job: {
      jobId,
      job_name: "viewer-test",
      command: "printf output",
      cwd: "/tmp/viewer",
      shell: "/bin/zsh",
      status: "running",
      startedAt: "2026-08-03T21:00:00.000Z",
      notifyOnExit: true,
      completionNotified: false,
      reportedInBand: false,
      logDir,
      stdoutLog: path.join(logDir, "stdout.log"),
      stderrLog: path.join(logDir, "stderr.log"),
      outputBytes: { stdout: 12, stderr: 0 }
    },
    projectRoot: "/tmp/viewer/.pi/async-shell",
    streams: [],
    outputLines: ["--- stdout ---", "one", "two"],
    refreshedAt: "2026-08-03T21:00:01.000Z",
    ...overrides
  };
}

async function writeJobMeta(contextDir: string, jobId: string, meta: Record<string, unknown>): Promise<void> {
  const logDir = path.join(contextDir, ".pi", "async-shell", "jobs", jobId);
  await mkdir(logDir, { recursive: true });
  await writeFile(path.join(logDir, "meta.json"), `${JSON.stringify({
    jobId,
    command: "printf legacy",
    cwd: contextDir,
    shell: "/bin/zsh",
    status: "exited",
    startedAt: new Date().toISOString(),
    notifyOnExit: false,
    completionNotified: true,
    logDir,
    stdoutLog: path.join(logDir, "stdout.log"),
    stderrLog: path.join(logDir, "stderr.log"),
    outputBytes: { stdout: 0, stderr: 0 },
    ...meta
  }, null, 2)}\n`);
}

test("async-shell pruning is exact, previewed, terminal-only, and separate from worker cleanup", async () => {
  await withTempDir(async (dir) => {
    const eligible = "job_20261024180000_prune001";
    const undelivered = "job_20261024180000_prune002";
    const workerOwned = "job_20261024180000_prune003";
    await writeJobMeta(dir, eligible, { status: "exited", notifyOnExit: false, completionNotified: true });
    await writeJobMeta(dir, undelivered, { status: "failed", notifyOnExit: true, completionNotified: false });
    await writeJobMeta(dir, workerOwned, { status: "cancelled", owner: { kind: "worker-run", workerId: "worker_20261024180000_prune01", runId: "run_20261024180000_prune01" } });

    assert.deepEqual(parseAsyncShellPruneArgs(`${eligible} ${eligible}`), { help: false, confirm: false, recover: false, inventory: undefined, after: undefined, limit: 100, targets: [eligible] });
    assert.match(buildAsyncShellPruneUsage(), /no wildcard/i);
    assert.throws(() => parseAsyncShellPruneArgs("*"), /Invalid async-shell job or leftover target/);
    const eligibility = await listEligibleAsyncShellPrune({ cwd: dir }, undefined, 2);
    assert.deepEqual(eligibility.entries.map((entry) => entry.jobId), [eligible]);
    assert.equal(eligibility.snapshot.totals.eligible.count, 1);
    assert.equal(eligibility.snapshot.totals.ineligible.count, 2);
    assert.throws(() => parseAsyncShellPruneArgs("--eligible --confirm"), /read-only/);
    assert.throws(() => parseAsyncShellPruneArgs("--offset 1"), /deletion-stable --after/);
    const maximumTargets = Array.from({ length: 250 }, (_value, index) => `job_20261024_cap${String(index).padStart(3, "0")}`);
    assert.equal(parseAsyncShellPruneArgs(maximumTargets.join(" ")).targets.length, 250);
    assert.throws(() => parseAsyncShellPruneArgs([...maximumTargets, "job_20261024_cap250"].join(" ")), /at most 250/);
    const preview = previewAsyncShellPrune({ cwd: dir }, [eligible]);
    assert.equal(preview[0]?.jobId, eligible);
    assert.ok(existsSync(preview[0]!.logDir), "preview is read-only");
    assert.throws(() => previewAsyncShellPrune({ cwd: dir }, [undelivered]), /undelivered completion evidence/);
    assert.throws(() => previewAsyncShellPrune({ cwd: dir }, [workerOwned]), /worker cleanup/);
    const deleted = pruneAsyncShellJobs({ cwd: dir }, [eligible]);
    assert.equal(deleted.length, 1);
    assert.equal(existsSync(preview[0]!.logDir), false);
  });
});



test("ordinary retention protects new, legacy-command, and exact-registry managed-worker host evidence", async () => {
  await withTempDir(async (dir) => {
    const marked = "job_20261024180000_workerhost1";
    const legacy = "job_20261024180000_workerhost2";
    const registryId = "job_20261024180000_workerhost3";
    await writeJobMeta(dir, marked, {
      command: "host process changed wording",
      status: "exited",
      notifyOnExit: false,
      processToken: "123e4567-e89b-42d3-a456-426614174301",
      managedBy: { kind: "worker-host", workerId: "worker_20261024180000_host01", runId: "run_20261024180000_host01" }
    });
    await writeJobMeta(dir, legacy, {
      command: "Pi worker host worker_20261024180000_host02/run_20261024180000_host02",
      status: "failed",
      notifyOnExit: false,
      processToken: "123e4567-e89b-42d3-a456-426614174302"
    });
    await writeJobMeta(dir, registryId, { command: "legacy host with edited command", status: "cancelled", notifyOnExit: false, processToken: "123e4567-e89b-42d3-a456-426614174303" });

    const inventory = await listEligibleAsyncShellPrune({ cwd: dir }, undefined, 100, "ineligible");
    assert.deepEqual(inventory.entries.map((entry) => [entry.name, entry.reason]), [
      [marked, "managed-worker evidence; ordinary prune refused; host-log cleanup is separate"],
      [legacy, "managed-worker evidence; ordinary prune refused; host-log cleanup is separate"]
    ]);
    assert.throws(() => previewAsyncShellPrune({ cwd: dir }, [marked]), /managed-worker evidence; ordinary prune refused/);
    assert.throws(() => pruneAsyncShellJobs({ cwd: dir }, [legacy]), /managed-worker evidence; ordinary prune refused/);

    const runtimeRoot = path.join(dir, "worker-runtime");
    await mkdir(runtimeRoot);
    const database = new DatabaseSync(path.join(runtimeRoot, "registry.sqlite"));
    database.exec("CREATE TABLE runs(job_id TEXT)");
    database.prepare("INSERT INTO runs(job_id) VALUES(?)").run(registryId);
    database.close();
    const registryIds = readManagedWorkerHostJobIds(runtimeRoot);
    assert.deepEqual([...registryIds], [registryId]);
    assert.equal(managedWorkerEvidenceReason({ jobId: registryId, command: "edited" }, registryIds), "managed-worker evidence; ordinary prune refused; host-log cleanup is separate");
    const invalidRoot = path.join(dir, "invalid-worker-runtime");
    await mkdir(invalidRoot);
    const invalidDatabase = new DatabaseSync(path.join(invalidRoot, "registry.sqlite"));
    invalidDatabase.exec("CREATE TABLE unrelated(value TEXT)");
    invalidDatabase.close();
    assert.throws(() => readManagedWorkerHostJobIds(invalidRoot), /evidence registry is unavailable/);
    const directSnapshot = await scanAsyncShellRetention(path.join(dir, ".pi", "async-shell", "jobs"), undefined, registryIds);
    assert.equal(directSnapshot.entries.find((entry) => entry.name === registryId)?.reason, "managed-worker evidence; ordinary prune refused; host-log cleanup is separate");
    const root = path.join(dir, ".pi", "async-shell", "jobs");
    const metadataLessPending = `.pending-${registryId}-123e4567-e89b-42d3-a456-426614174311`;
    const metadataLessPrune = `.prune-${registryId}-123e4567-e89b-42d3-a456-426614174312`;
    await mkdir(path.join(root, metadataLessPending));
    await mkdir(path.join(root, metadataLessPrune));
    assert.throws(() => previewAsyncShellPrune({ cwd: dir }, [metadataLessPending], registryIds), /managed-worker evidence; ordinary prune refused/);
    assert.throws(() => previewAsyncShellPrune({ cwd: dir }, [metadataLessPrune], registryIds), /managed-worker evidence; ordinary prune refused/);
    const leftoverSnapshot = await scanAsyncShellRetention(root, undefined, registryIds);
    assert.equal(leftoverSnapshot.entries.find((entry) => entry.name === metadataLessPending)?.reason, "managed-worker evidence; ordinary prune refused; host-log cleanup is separate");
    assert.equal(leftoverSnapshot.entries.find((entry) => entry.name === metadataLessPrune)?.reason, "managed-worker evidence; ordinary prune refused; host-log cleanup is separate");
    assert.equal(existsSync(path.join(dir, ".pi", "async-shell", "jobs", marked)), true);
  });
});


test("managed async host marker persists in canonical metadata", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const managedBy = { kind: "worker-host" as const, workerId: "worker_20261024180000_marked", runId: "run_20261024180000_marked" };
    const handle = startManagedAsyncJob(api, createContext(dir), {
      jobId: "job_20261024180000_markedhost",
      command: `Pi worker host ${managedBy.workerId}/${managedBy.runId}`,
      cwd: dir,
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      notifyOnExit: false,
      managedBy
    });
    await waitWithRefTimeout(handle.completion);
    const persisted = JSON.parse(await readFile(path.join(handle.snapshot().logDir, "meta.json"), "utf8")) as { managedBy?: unknown };
    assert.deepEqual(persisted.managedBy, managedBy);
    assert.throws(() => previewAsyncShellPrune({ cwd: dir }, [handle.jobId]), /managed-worker evidence; ordinary prune refused/);
  });
});

test("retention totals count regular stray root files including pending-shaped names", async () => {
  await withTempDir(async (dir) => {
    const root = path.join(dir, ".pi", "async-shell", "jobs");
    await mkdir(root, { recursive: true });
    const pendingFile = ".pending-job_20261024180000_file0001-123e4567-e89b-42d3-a456-426614174099";
    await writeFile(path.join(root, pendingFile), "pending-file");
    await writeFile(path.join(root, "stray-root-file"), "stray");
    const snapshot = await refreshAsyncShellRetentionSnapshot({ cwd: dir });
    assert.equal(snapshot.totals.directories, 2);
    assert.equal(snapshot.totals.unknownLeftovers.count, 2);
    assert.equal(snapshot.totals.bytes, Buffer.byteLength("pending-filestray"));
    assert.match(snapshot.entries.find((entry) => entry.name === pendingFile)?.reason ?? "", /not an ordinary directory/);
  });
});

test("status and inventory surface corrupt worker-registry protection failures while failing closed", async () => {
  await withTempDir(async (dir) => {
    const exercise = async (project: string, command: "async:status" | "async:prune", args: string): Promise<string> => {
      const invalidRoot = path.join(project, "corrupt-worker-runtime");
      await mkdir(invalidRoot, { recursive: true });
      const invalidDatabase = new DatabaseSync(path.join(invalidRoot, "registry.sqlite"));
      invalidDatabase.exec("CREATE TABLE unrelated(value TEXT)");
      invalidDatabase.close();
      await assert.rejects(refreshAsyncShellRetentionSnapshot({ cwd: project }, undefined, invalidRoot), /evidence registry is unavailable/);
      const api = createFakeApi();
      asyncShellExtension(api);
      const notifications: string[] = [];
      const context = {
        ...createContext(project),
        mode: "tui",
        hasUI: true,
        ui: { notify(message: string): void { notifications.push(message); } }
      } as unknown as ExtensionCommandContext;
      await required(api.commands.get(command), command).handler(args, context);
      return notifications.join("\n");
    };
    const status = await exercise(path.join(dir, "status-project"), "async:status", "");
    assert.match(status, /protection failed closed: Managed-worker evidence registry is unavailable/);
    const inventory = await exercise(path.join(dir, "inventory-project"), "async:prune", "--eligible");
    assert.match(inventory, /inventory protection failed closed: Managed-worker evidence registry is unavailable/);
  });
});

test("retention inventory uses deletion-stable cursors and reports bounded class totals", async () => {
  await withTempDir(async (dir) => {
    const ids = [
      "job_20261024180000_cursor001",
      "job_20261024180000_cursor002",
      "job_20261024180000_cursor003"
    ];
    for (const id of ids) await writeJobMeta(dir, id, { status: "exited", notifyOnExit: false, completionNotified: true });
    const first = await listEligibleAsyncShellPrune({ cwd: dir }, undefined, 1);
    assert.deepEqual(first.entries.map((entry) => entry.name), [ids[0]]);
    assert.equal(first.nextAfter, ids[0]);
    pruneAsyncShellJobs({ cwd: dir }, [ids[0]!]);
    const latest = required(latestAsyncShellRetentionSnapshot({ cwd: dir }), "latest retention snapshot after confirm");
    assert.equal(latest.totals.eligible.count, 2);
    assert.deepEqual(latest.entries.filter((entry) => entry.kind === "eligible").map((entry) => entry.name), ids.slice(1));
    const second = await listEligibleAsyncShellPrune({ cwd: dir }, first.nextAfter, 1);
    assert.deepEqual(second.entries.map((entry) => entry.name), [ids[1]], "deleting the first page must not skip the next key");
    assert.equal(second.snapshot.totals.eligible.count, 2);
    assert.equal(parseAsyncShellPruneArgs("--eligible --after job_20261024180000_cursor001 --limit 1").after, ids[0]);
  });
});


test("partial deletion failure leaves incomplete residue purge-only and never restores a broken canonical job", async () => {
  await withTempDir(async (dir) => {
    const first = "job_20261024180000_partial01";
    const second = "job_20261024180000_partial02";
    await writeJobMeta(dir, first, { status: "exited", notifyOnExit: false, completionNotified: true });
    await writeJobMeta(dir, second, { status: "exited", notifyOnExit: false, completionNotified: true });
    const originalRmSync = fs.rmSync;
    let removals = 0;
    fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
      if (path.basename(String(target)).startsWith(".prune-")) {
        removals += 1;
        if (removals === 2) {
          originalRmSync(path.join(String(target), "stdout.log"), { force: true });
          throw new Error("injected second partial removal failure");
        }
      }
      return originalRmSync(target, options as never);
    }) as typeof fs.rmSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => pruneAsyncShellJobs({ cwd: dir }, [first, second]), /retained classified purge\/recovery residue/);
    } finally {
      fs.rmSync = originalRmSync;
      syncBuiltinESMExports();
    }
    const root = path.join(dir, ".pi", "async-shell", "jobs");
    const names = await readdir(root);
    assert.equal(names.includes(first), false);
    assert.equal(names.includes(second), false, "a possibly partial directory is never restored as canonical");
    const retained = required(names.find((name) => name.startsWith(`.prune-${second}-`)), "classified retained prune target");
    assert.equal(previewAsyncShellPrune({ cwd: dir }, [retained])[0]?.recoveryEligible, false);
    assert.throws(() => recoverAsyncShellPruneLeftovers({ cwd: dir }, [retained]), /not recoverable/);
    assert.equal(existsSync(path.join(root, second)), false);
    assert.equal(pruneAsyncShellJobs({ cwd: dir }, [retained]).length, 1, "purge-only residue remains exactly deletable");
  });
});

test("pending and prune leftovers are visible, exactly deletable, and prune recovery is atomic", async () => {
  await withTempDir(async (dir) => {
    const root = path.join(dir, ".pi", "async-shell", "jobs");
    const pendingJob = "job_20261024180000_pending01";
    const pruneJob = "job_20261024180000_recover01";
    const orphanJob = "job_20261024180000_orphan001";
    const pending = `.pending-${pendingJob}-123e4567-e89b-42d3-a456-426614174000`;
    const prune = `.prune-${pruneJob}-123e4567-e89b-42d3-a456-426614174001`;
    const interruptedDelete = `.prune-${orphanJob}-123e4567-e89b-42d3-a456-426614174002`;
    await mkdir(path.join(root, pending), { recursive: true });
    await writeFile(path.join(root, pending, "stdout.log"), "pending data");
    const pendingLogDir = path.join(root, pendingJob);
    await writeFile(path.join(root, pending, "meta.json"), `${JSON.stringify({
      jobId: pendingJob,
      command: "interrupted publication",
      cwd: dir,
      shell: "/bin/zsh",
      status: "running",
      pid: 2_147_483_647,
      startedAt: new Date().toISOString(),
      notifyOnExit: true,
      completionNotified: false,
      logDir: pendingLogDir,
      stdoutLog: path.join(pendingLogDir, "stdout.log"),
      stderrLog: path.join(pendingLogDir, "stderr.log"),
      outputBytes: { stdout: 0, stderr: 0 }
    })}\n`);
    await writeJobMeta(dir, pruneJob, { status: "exited", notifyOnExit: false, completionNotified: true });
    await writeFile(path.join(root, pruneJob, "stdout.log"), "complete stdout");
    await writeFile(path.join(root, pruneJob, "stderr.log"), "complete stderr");
    await rename(path.join(root, pruneJob), path.join(root, prune));
    await mkdir(path.join(root, interruptedDelete), { recursive: true });
    await writeFile(path.join(root, interruptedDelete, "partial"), "trash");

    const leftovers = await listEligibleAsyncShellPrune({ cwd: dir }, undefined, 100, "leftovers");
    assert.deepEqual(leftovers.entries.map((entry) => entry.name), [pending, interruptedDelete, prune].sort());
    assert.equal(leftovers.snapshot.totals.leftovers.count, 3);
    assert.ok(leftovers.snapshot.totals.leftovers.bytes >= Buffer.byteLength("pending datatrash"));
    assert.match(await buildAsyncShellStatusText(createContext(dir)), /Leftovers: 1 pending .*2 prune/);

    const recoveryPreview = previewAsyncShellPrune({ cwd: dir }, [prune]);
    assert.equal(recoveryPreview[0]?.recoveryEligible, true);
    recoverAsyncShellPruneLeftovers({ cwd: dir }, [prune]);
    assert.equal(existsSync(path.join(root, prune)), false);
    assert.equal(existsSync(path.join(root, pruneJob)), true);
    assert.equal(previewAsyncShellPrune({ cwd: dir }, [interruptedDelete])[0]?.recoveryEligible, false);
    assert.equal(pruneAsyncShellJobs({ cwd: dir }, [pending, interruptedDelete]).length, 2);
    assert.equal((await readdir(root)).some((name) => name.startsWith(".pending-") || name.startsWith(".prune-")), false);
  });
});

test("retention scanning yields the event loop and publishes progress for large registries", async () => {
  await withTempDir(async (dir) => {
    const root = path.join(dir, ".pi", "async-shell", "jobs");
    await mkdir(root, { recursive: true });
    const total = 2_000;
    for (let offset = 0; offset < total; offset += 100) {
      await Promise.all(Array.from({ length: Math.min(100, total - offset) }, (_value, index) =>
        mkdir(path.join(root, `unknown-${String(offset + index).padStart(5, "0")}`))));
    }
    const api = createFakeApi();
    asyncShellExtension(api);
    const notifications: string[] = [];
    const commandContext = {
      ...createContext(dir),
      mode: "tui",
      hasUI: true,
      ui: { notify(message: string): void { notifications.push(message); } }
    } as unknown as ExtensionCommandContext;
    const commandStartedAt = Date.now();
    await required(api.commands.get("async:status"), "async:status command").handler("", commandContext);
    assert.ok(Date.now() - commandStartedAt < 500, "status returns progress without waiting for the full large scan");
    assert.match(notifications.join("\n"), /scan (started|in progress)/i);
    assert.match(notifications.join("\n"), /Completion delivery backlog:/);

    let timerFired = false;
    let progressEvents = 0;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    const snapshot = await refreshAsyncShellRetentionSnapshot({ cwd: dir }, () => { progressEvents += 1; });
    clearTimeout(timer);
    assert.equal(snapshot.totals.directories, total);
    assert.equal(snapshot.totals.unknownLeftovers.count, total);
    assert.equal(parseAsyncShellPruneArgs("--leftovers --after unknown-00099 --limit 100").after, "unknown-00099");
    assert.equal(timerFired, true, "the registry scan must not monopolize the event loop");
    assert.ok(progressEvents > 1, "large scans expose chunk progress");
  });
});

test("async-shell pruning accepts a symlinked registry ancestor while retaining realpath containment", async () => {
  await withTempDir(async (dir) => {
    const realParent = path.join(dir, "real-parent");
    const linkedParent = path.join(dir, "linked-parent");
    await mkdir(realParent, { recursive: true });
    await symlink(realParent, linkedParent, "dir");
    const project = path.join(linkedParent, "project");
    await mkdir(project, { recursive: true });
    const jobId = "job_20261024180000_symlinkroot";
    await writeJobMeta(project, jobId, { status: "exited", notifyOnExit: false, completionNotified: true });
    const preview = previewAsyncShellPrune({ cwd: project }, [jobId]);
    assert.equal(preview[0]?.logDir, path.join(project, ".pi", "async-shell", "jobs", jobId));
    assert.equal(pruneAsyncShellJobs({ cwd: project }, [jobId]).length, 1);
  });
});

test("async-shell activity status is compact, themed, exact-session scoped, and lifecycle driven", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const theme = {
      fg(color: string, text: string): string { return `<${color}>${text}</${color}>`; },
      bold(text: string): string { return text; }
    } as unknown as Theme;
    const context = {
      ...createContext(dir),
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => "activity-session" },
      ui: {
        theme,
        setStatus(key: string, text: string | undefined): void { statuses.push({ key, text }); }
      }
    } as unknown as ExtensionContext;

    assert.equal(renderAsyncShellActivityStatus(0, theme), undefined);
    assert.equal(renderAsyncShellActivityStatus(3, theme), "<warning>sh3</warning>");
    assert.equal(visibleWidth(renderAsyncShellActivityStatus(123, plainTheme)!), 5, "the count stays narrow");
    const footerLine = new Map([
      [ASYNC_SHELL_ACTIVITY_STATUS_KEY, renderAsyncShellActivityStatus(34, plainTheme)!],
      ["mutation-review", "mutation review running · 12 tool calls · search_many"]
    ]);
    const narrowFooter = truncateToWidth(
      [...footerLine.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, text]) => text).join(" "),
      12,
      "..."
    );
    assert.match(narrowFooter, /^sh34 /, "the priority status key keeps the compact count before verbose statuses");
    await api.emit("session_start", { reason: "startup" }, context);
    assert.deepEqual(statuses.at(-1), { key: ASYNC_SHELL_ACTIVITY_STATUS_KEY, text: undefined });
    await writeJobMeta(dir, "job_20260923165959_stale001", { status: "running", pid: 2_147_483_647 });
    assert.equal(activeAsyncShellJobCount(context), 0, "detached stale metadata is not active UI state");

    const internal = startManagedAsyncJob(api, context, {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => {}, 80)")}`,
      cwd: dir,
      notifyOnExit: false
    });
    assert.equal(activeAsyncShellJobCount(context), 0, "managed worker host jobs stay out of the shell count");
    await waitWithRefTimeout(internal.completion);

    const shellStart = required(api.registeredTools.find((candidate) => candidate.name === "shell_start"), "shell_start tool");
    const run = shellStart.execute(
      "activity-call",
      {
        commands: [
          { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => {}, 180)")}`, cwd: dir, notifyOnExit: false },
          { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => {}, 360)")}`, cwd: dir, notifyOnExit: false }
        ]
      } as never,
      new AbortController().signal,
      undefined,
      context
    );
    await delay(40);
    assert.equal(activeAsyncShellJobCount(context), 2);
    assert.ok(statuses.some((status) => status.text === "<warning>sh2</warning>"));
    const nextTheme = {
      fg(color: string, text: string): string { return `[${color}]${text}[/${color}]`; },
      bold(text: string): string { return text; }
    } as unknown as Theme;
    (context.ui as { theme: Theme }).theme = nextTheme;
    await api.emit("input", { text: "refresh theme" }, context);
    assert.deepEqual(statuses.at(-1), { key: ASYNC_SHELL_ACTIVITY_STATUS_KEY, text: "[warning]sh2[/warning]" });
    const otherSession = {
      ...context,
      sessionManager: { getSessionId: () => "other-session" }
    } as ExtensionContext;
    assert.equal(activeAsyncShellJobCount(otherSession), 0, "activity never crosses session identity");

    await run;
    assert.equal(activeAsyncShellJobCount(context), 0);
    assert.ok(statuses.some((status) => status.text === "<warning>sh1</warning>"), "concurrent completion decrements the canonical count");
    assert.deepEqual(statuses.at(-1), { key: ASYNC_SHELL_ACTIVITY_STATUS_KEY, text: undefined });
    assert.equal(api.sentMessages.length, 0, "activity status adds no provider-visible messages");

    await api.emit("session_shutdown", { reason: "reload" }, context);
    assert.deepEqual(statuses.at(-1), { key: ASYNC_SHELL_ACTIVITY_STATUS_KEY, text: undefined });
    const tuiStatusCount = statuses.length;
    const rpcContext = { ...context, mode: "rpc", hasUI: true } as ExtensionContext;
    await api.emit("session_start", { reason: "resume" }, rpcContext);
    await api.emit("session_shutdown", { reason: "reload" }, rpcContext);
    assert.equal(statuses.length, tuiStatusCount, "RPC/headless modes receive no activity UI requests");
  });
});

test("async-shell activity survives a fresh module reload and old completion clears the new listener", async () => {
  await withTempDir(async (dir) => {
    const originalApi = createFakeApi();
    asyncShellExtension(originalApi);
    const originalStatuses: Array<string | undefined> = [];
    const context = {
      ...createContext(dir),
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => "reload-activity-session" },
      ui: {
        theme: plainTheme,
        setStatus(_key: string, text: string | undefined): void { originalStatuses.push(text); }
      }
    } as unknown as ExtensionContext;
    await originalApi.emit("session_start", { reason: "startup" }, context);
    const shellStart = required(originalApi.registeredTools.find((candidate) => candidate.name === "shell_start"), "shell_start tool");
    const running = shellStart.execute(
      "reload-call",
      { commands: [{ command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => {}, 240)")}`, cwd: dir, notifyOnExit: false }] } as never,
      new AbortController().signal,
      undefined,
      context
    );
    await delay(35);
    assert.equal(activeAsyncShellJobCount(context), 1);
    await originalApi.emit("session_shutdown", { reason: "reload" }, context);

    const freshModule = await import(`../extensions/async-shell/index.js?activity-reload=${Date.now()}`);
    const freshApi = createFakeApi();
    freshModule.default(freshApi);
    const freshStatuses: Array<string | undefined> = [];
    const freshContext = {
      ...context,
      ui: {
        theme: plainTheme,
        setStatus(_key: string, text: string | undefined): void { freshStatuses.push(text); }
      }
    } as ExtensionContext;
    await freshApi.emit("session_start", { reason: "reload" }, freshContext);
    assert.equal(freshModule.activeAsyncShellJobCount(freshContext), 1, "the fresh module reuses the canonical live job map");
    assert.equal(freshStatuses.at(-1), "sh1");
    await waitWithRefTimeout(running, 2_000);
    assert.equal(freshModule.activeAsyncShellJobCount(freshContext), 0);
    assert.equal(freshStatuses.at(-1), undefined, "the old lifecycle owner notifies the new listener");
    await freshApi.emit("session_shutdown", { reason: "quit" }, freshContext);
  });
});

test("concurrent child session runtime cannot deactivate or receive parent completions", async () => {
  await withTempDir(async (dir) => {
    const parentApi = createFakeApi();
    const childApi = createFakeApi();
    asyncShellExtension(parentApi);
    asyncShellExtension(childApi);
    const parentContext = {
      ...createContext(dir),
      sessionManager: { getSessionId: () => "parent-runtime-session", getEntries: () => [] }
    } as unknown as ExtensionContext;
    const childContext = {
      ...createContext(dir),
      sessionManager: { getSessionId: () => "child-runtime-session", getSessionFile: () => undefined, getEntries: () => [] }
    } as unknown as ExtensionContext;
    await parentApi.emit("session_start", { reason: "startup" }, parentContext);
    await childApi.emit("session_start", { reason: "startup" }, childContext);

    const handle = startManagedAsyncJob(parentApi, parentContext, {
      command: "parent completion after child bind",
      cwd: dir,
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 80)"],
      notifyOnExit: true
    });
    await waitWithRefTimeout(handle.completion);
    await delay(700);
    assert.equal(parentApi.sentMessages.length, 1);
    assert.equal(childApi.sentMessages.length, 0);
    const delivered = parentApi.sentMessages[0]!.message as { details?: { originSessionId?: string } };
    assert.equal(delivered.details?.originSessionId, "parent-runtime-session");
    await childApi.emit("session_shutdown", { reason: "quit" }, childContext);
    await parentApi.emit("session_shutdown", { reason: "quit" }, parentContext);
  });
});

test("ordinary async-shell completion rebinds to the fresh extension runtime after reload", async () => {
  await withTempDir(async (dir) => {
    const originalApi = createFakeApi();
    asyncShellExtension(originalApi);
    const sessionId = "reload-delivery-session";
    const originalContext = {
      ...createContext(dir),
      sessionManager: { getSessionId: () => sessionId, getEntries: () => [] }
    } as unknown as ExtensionContext;
    await originalApi.emit("session_start", { reason: "startup" }, originalContext);
    const handle = startManagedAsyncJob(originalApi, originalContext, {
      command: "reload delivery probe",
      cwd: dir,
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 180)"],
      notifyOnExit: true
    });
    await delay(30);
    await originalApi.emit("session_shutdown", { reason: "reload" }, originalContext);

    const freshModule = await import(`../extensions/async-shell/index.js?delivery-reload=${Date.now()}`);
    const freshApi = createFakeApi();
    freshModule.default(freshApi);
    const freshContext = {
      ...createContext(dir),
      sessionManager: { getSessionId: () => sessionId, getEntries: () => [] }
    } as unknown as ExtensionContext;
    await freshApi.emit("session_start", { reason: "reload" }, freshContext);
    await waitWithRefTimeout(handle.completion);
    await delay(700);
    await freshApi.emit("agent_end", {}, freshContext);
    assert.equal(originalApi.sentMessages.length, 0, "the detached runtime never delivers completion");
    assert.equal(freshApi.sentMessages.length, 1, "the latest same-session runtime delivers completion");
    const delivered = freshApi.sentMessages[0]!.message as { customType?: string; details?: { originSessionId?: string } };
    assert.equal(delivered.customType, "async-shell");
    assert.equal(delivered.details?.originSessionId, sessionId);
    await freshApi.emit("session_shutdown", { reason: "quit" }, freshContext);
  });
});

test("reload never replays an accepted async-shell batch absent from the session ledger", async () => {
  await withTempDir(async (dir) => {
    const originalApi = createFakeApi();
    asyncShellExtension(originalApi);
    const sessionId = "reload-ambiguous-delivery-session";
    const originalContext = {
      ...createContext(dir),
      sessionManager: { getSessionId: () => sessionId, getEntries: () => [] }
    } as unknown as ExtensionContext;
    await originalApi.emit("session_start", { reason: "startup" }, originalContext);
    const handle = startManagedAsyncJob(originalApi, originalContext, {
      command: "ambiguous reload delivery probe",
      cwd: dir,
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 80)"],
      notifyOnExit: true
    });
    const completed = await waitWithRefTimeout(handle.completion);
    await delay(700);
    assert.equal(originalApi.sentMessages.length, 1);
    const acceptedMessage = originalApi.sentMessages[0]!.message;
    await originalApi.emit("session_shutdown", { reason: "reload" }, originalContext);

    const freshModule = await import(`../extensions/async-shell/index.js?ambiguous-delivery-reload=${Date.now()}`);
    const freshApi = createFakeApi();
    freshModule.default(freshApi);
    const freshContext = {
      ...createContext(dir),
      sessionManager: { getSessionId: () => sessionId, getEntries: () => [] }
    } as unknown as ExtensionContext;
    await freshApi.emit("session_start", { reason: "reload" }, freshContext);
    await delay(150);
    await freshApi.emit("agent_end", {}, freshContext);
    assert.equal(freshApi.sentMessages.length, 0, "an accepted but unreceipted batch remains claimed instead of replaying");
    let persisted = JSON.parse(await readFile(path.join(completed.logDir, "meta.json"), "utf8")) as { completionNotified: boolean };
    assert.equal(persisted.completionNotified, false);
    await freshApi.emit("message_end", { message: { ...(acceptedMessage as Record<string, unknown>), role: "custom" } }, freshContext);
    persisted = JSON.parse(await readFile(path.join(completed.logDir, "meta.json"), "utf8")) as { completionNotified: boolean };
    assert.equal(persisted.completionNotified, true, "a later exact receipt still acknowledges the retained batch");
    await freshApi.emit("session_shutdown", { reason: "quit" }, freshContext);
  });
});

test("reload acknowledges an accepted async-shell delivery already present in the same session", async () => {
  await withTempDir(async (dir) => {
    const originalApi = createFakeApi();
    asyncShellExtension(originalApi);
    const sessionId = "reload-observed-delivery-session";
    const originalContext = {
      ...createContext(dir),
      sessionManager: { getSessionId: () => sessionId, getEntries: () => [] }
    } as unknown as ExtensionContext;
    await originalApi.emit("session_start", { reason: "startup" }, originalContext);
    const handle = startManagedAsyncJob(originalApi, originalContext, {
      command: "observed reload delivery probe",
      cwd: dir,
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 80)"],
      notifyOnExit: true
    });
    const completed = await waitWithRefTimeout(handle.completion);
    await delay(700);
    assert.equal(originalApi.sentMessages.length, 1);
    const recordedMessage = originalApi.sentMessages[0]!.message;
    await originalApi.emit("session_shutdown", { reason: "reload" }, originalContext);

    const freshModule = await import(`../extensions/async-shell/index.js?observed-delivery-reload=${Date.now()}`);
    const freshApi = createFakeApi();
    freshModule.default(freshApi);
    const freshContext = {
      ...createContext(dir),
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => [{ type: "message", message: recordedMessage }]
      }
    } as unknown as ExtensionContext;
    await freshApi.emit("session_start", { reason: "reload" }, freshContext);
    await delay(150);
    await freshApi.emit("agent_end", {}, freshContext);
    assert.equal(freshApi.sentMessages.length, 0, "session-recorded delivery is acknowledged rather than replayed");
    const persisted = JSON.parse(await readFile(path.join(completed.logDir, "meta.json"), "utf8")) as { completionNotified: boolean };
    assert.equal(persisted.completionNotified, true);
    await freshApi.emit("session_shutdown", { reason: "quit" }, freshContext);
  });
});

test("async-shell upgrades the version-one process-global holder in place", () => {
  const holder = { version: 1, jobs: new Map(), activityListeners: new Set() };
  const migrated = migrateAsyncShellRuntimeHolder(holder);
  assert.equal(migrated, holder);
  assert.equal(migrated.version, 2);
  assert.ok(migrated.pendingCompletionNotifications instanceof Map);
  assert.ok(migrated.completionDeliveryBatches instanceof Map);
  assert.ok(migrated.scheduledCompletionJobIds instanceof Set);
  assert.ok(migrated.completionRuntimes instanceof Map);
  assert.ok(migrated.retentionSnapshots instanceof Map);
});

test("async-shell rejects an incompatible process-global runtime holder", () => {
  assert.throws(
    () => migrateAsyncShellRuntimeHolder({ version: 99, jobs: new Map(), activityListeners: new Set() }),
    /Incompatible async-shell runtime holder/
  );
});

test("async-shell activity listener failures do not block another live listener", async () => {
  await withTempDir(async (dir) => {
    const throwingApi = createFakeApi();
    const observingApi = createFakeApi();
    asyncShellExtension(throwingApi);
    asyncShellExtension(observingApi);
    const base = {
      ...createContext(dir),
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => "listener-failure-session" }
    } as ExtensionContext;
    const throwingContext = {
      ...base,
      ui: {
        theme: plainTheme,
        setStatus(_key: string, text: string | undefined): void { if (text !== undefined) throw new Error("display failed"); }
      }
    } as ExtensionContext;
    const observed: Array<string | undefined> = [];
    const observingContext = {
      ...base,
      ui: {
        theme: plainTheme,
        setStatus(_key: string, text: string | undefined): void { observed.push(text); }
      }
    } as ExtensionContext;
    await throwingApi.emit("session_start", { reason: "startup" }, throwingContext);
    await observingApi.emit("session_start", { reason: "startup" }, observingContext);
    const shellStart = required(observingApi.registeredTools.find((candidate) => candidate.name === "shell_start"), "shell_start tool");
    await waitWithRefTimeout(shellStart.execute(
      "listener-failure-call",
      { commands: [{ command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => process.exit(7), 90)")}`, cwd: dir, notifyOnExit: false }] } as never,
      new AbortController().signal,
      undefined,
      observingContext
    ), 2_000);
    assert.ok(observed.includes("sh1"), "the healthy listener still observes the failed job while active");
    assert.equal(observed.at(-1), undefined, "failure completion clears the count");
    await throwingApi.emit("session_shutdown", { reason: "quit" }, throwingContext);
    await observingApi.emit("session_shutdown", { reason: "quit" }, observingContext);
  });
});

test("async-shell tools expose complete system-prompt contracts", () => {
  const api = createFakeApi();
  asyncShellExtension(api);

  for (const name of ["shell_start", "shell_status", "shell_read", "shell_cancel"]) {
    const tool = required(api.registeredTools.find((candidate) => candidate.name === name), `${name} tool`);
    assert.ok(tool.description.length > 100, `${name} keeps a detailed provider description`);
    assert.ok((tool.promptSnippet ?? "").length > 40, `${name} has an Available tools snippet`);
    assert.deepEqual(tool.promptGuidelines?.map((line) => line.split(":", 1)[0]), [
      `${name} use`,
      `${name} input`,
      `${name} output`,
      `${name} constraints`
    ]);
    assert.ok((tool.parameters as { additionalProperties?: boolean }).additionalProperties === false);
  }
});

test("async-shell-status reports job root and recent jobs", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);

    assert.ok(api.commands.has("async:status"));
    assert.ok(api.commands.has("async:prune"));
    assert.equal(api.commands.has("async-shell-status"), false, "deprecated kebab alias removed");
    const text = await buildAsyncShellStatusText(createContext(dir));
    assert.match(text, /Async shell status/);
    assert.match(text, /Job root:/);
    assert.match(text, /Recent jobs: 0/);
  });
});

test("async-shell viewer registers a user-only command and rejects headless mode", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);

    const command = required(api.commands.get("async:view"), "async:view command");
    assert.match(command.description, /read-only TUI/);
    const notifications: Array<{ message: string; type?: string }> = [];
    let customCalls = 0;
    const context = {
      ...createContext(dir),
      mode: "print",
      hasUI: false,
      ui: {
        notify(message: string, type?: string): void {
          notifications.push({ message, type });
        },
        async custom(): Promise<void> {
          customCalls += 1;
        }
      }
    } as unknown as ExtensionCommandContext;

    await command.handler("", context);

    assert.equal(customCalls, 0);
    assert.deepEqual(notifications, [{ message: "/async:view requires interactive Pi TUI mode.", type: "warning" }]);

    await command.handler("", { ...context, mode: "rpc", hasUI: true } as unknown as ExtensionCommandContext);
    assert.equal(customCalls, 0);
    assert.deepEqual(notifications[1], { message: "/async:view requires interactive Pi TUI mode.", type: "warning" });
    assert.equal(api.sentMessages.length, 0, "viewer never injects a message or triggers an assistant turn");
  });
});

test("async-shell viewer opens an explicit historical job without mutating its log", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const jobId = "job_20260803165900_explicit";
    await writeJobMeta(dir, jobId, { status: "exited", exitCode: 0 });
    const stdoutLog = path.join(dir, ".pi", "async-shell", "jobs", jobId, "stdout.log");
    await writeFile(stdoutLog, "viewer output\n", "utf8");
    let rendered = "";
    let customCalls = 0;
    const tui = {
      terminal: { rows: 20 },
      requestRender(): void {}
    } as unknown as TUI;
    const context = {
      ...createContext(dir),
      mode: "tui",
      hasUI: true,
      ui: {
        theme: plainTheme,
        notify(): void {},
        async custom<T>(factory: Function): Promise<T> {
          customCalls += 1;
          return await new Promise<T>((resolve) => {
            const component = factory(tui, plainTheme, {}, resolve) as { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void };
            rendered = component.render(80).join("\n");
            component.handleInput?.("q");
            component.dispose?.();
          });
        }
      }
    } as unknown as ExtensionCommandContext;

    await required(api.commands.get("async:view"), "async:view command").handler(`${jobId} --stream stdout`, context);

    assert.equal(customCalls, 1);
    assert.match(rendered, /viewer output/);
    assert.equal(await readFile(stdoutLog, "utf8"), "viewer output\n");
    assert.equal(api.sentMessages.length, 0);
  });
});

test("async-shell viewer arguments are explicit and bounded", () => {
  assert.deepEqual(parseAsyncShellViewerArgs(""), {
    help: false,
    stream: "both",
    tailLines: 500,
    follow: false
  });
  assert.deepEqual(parseAsyncShellViewerArgs("job_123 --stream stderr --tail 42 --follow"), {
    help: false,
    jobId: "job_123",
    stream: "stderr",
    tailLines: 42,
    follow: true
  });
  assert.equal(parseAsyncShellViewerArgs("--help").help, true);
  assert.match(buildAsyncShellViewerUsage(), /Esc\/q closes without stopping the job/);
  assert.throws(() => parseAsyncShellViewerArgs("--stream merged"), /both, stdout, stderr/);
  assert.throws(() => parseAsyncShellViewerArgs("--tail 501"), /integer from 1 to 500/);
  assert.throws(() => parseAsyncShellViewerArgs("one two"), /at most one job id/);
  assert.throws(() => parseAsyncShellViewerArgs("--unknown"), /Unknown option/);
});

test("async-shell viewer reads bounded canonical historical logs and sanitizes terminal controls", async () => {
  await withTempDir(async (dir) => {
    const jobId = "job_20260803170100_history";
    await writeJobMeta(dir, jobId, {
      status: "cancelled",
      signal: "SIGTERM",
      cwd: path.join(dir, "child-project")
    });
    const logDir = path.join(dir, ".pi", "async-shell", "jobs", jobId);
    await writeFile(path.join(logDir, "stdout.log"), "first\nsecond\nthird\n", "utf8");
    await writeFile(path.join(logDir, "stderr.log"), "\u001b]0;owned\u0007warn\u001b[31m red\u001b[0m\u0000\n", "utf8");

    const snapshot = loadAsyncShellViewerSnapshot(createContext(dir), jobId, "both", 2);

    assert.equal(snapshot.job.status, "cancelled");
    assert.equal(snapshot.job.cwd, path.join(dir, "child-project"));
    assert.equal(snapshot.projectRoot, path.join(dir, ".pi", "async-shell"));
    assert.deepEqual(snapshot.streams.map((stream) => [stream.stream, stream.exists]), [["stdout", true], ["stderr", true]]);
    assert.equal(snapshot.streams[0].content, "second\nthird");
    assert.equal(snapshot.streams[1].content, "warn red�");
    assert.doesNotMatch(snapshot.outputLines.join("\n"), /\u001b|owned/);
    assert.equal(sanitizeAsyncShellViewerText("a\tb\rrewind\u0000"), "a    b�rewind�");

    const detachedId = "job_20260803170200_detached";
    await writeJobMeta(dir, detachedId, { status: "running", pid: 2_147_483_647 });
    const detached = loadAsyncShellViewerSnapshot(createContext(dir), detachedId, "stdout", 20);
    assert.equal(detached.job.status, "unknown");
    assert.match(detached.job.error ?? "", /previous Pi process/);
    assert.match(detached.outputLines.join("\n"), /log file has not been created/);
    assert.match(buildAsyncShellViewerFrame(plainTheme, {
      snapshot: detached,
      stream: "stdout",
      tailLines: 20,
      following: false,
      topLine: 0,
      pinnedToEnd: true
    }, 100, 20).lines.join("\n"), /job note: Job was running in a previous Pi process/);
    assert.throws(() => loadAsyncShellViewerSnapshot(createContext(dir), "job_missing", "both", 20), /Unknown async shell job/);
  });
});

test("async-shell viewer frame is viewport-bounded and keeps streams separate", () => {
  const snapshot = viewerSnapshot({
    job: { ...viewerSnapshot().job, status: "failed", exitCode: 7, durationMs: 2000 },
    outputLines: ["--- stdout ---", ...Array.from({ length: 20 }, (_, index) => `line-${index + 1}`), "", "--- stderr ---", "failure"]
  });
  const frame = buildAsyncShellViewerFrame(plainTheme, {
    snapshot,
    stream: "both",
    tailLines: 500,
    following: false,
    topLine: 0,
    pinnedToEnd: true
  }, 72, 16);
  const rendered = frame.lines.join("\n");

  assert.equal(frame.lines.length, 16);
  assert.equal(frame.topLine, snapshot.outputLines.length - frame.pageSize);
  assert.match(rendered, /failed · 2\.0s · exit 7/);
  assert.match(rendered, /stdout\/stderr are grouped/);
  assert.ok(frame.lines.every((line) => visibleWidth(line) <= 72));
});

test("async-shell viewer follow refreshes and dispose stops refresh without touching jobs", async () => {
  let loadCount = 0;
  let renderCount = 0;
  let doneCount = 0;
  let resolveFirstRefresh: (() => void) | undefined;
  const firstRefresh = new Promise<void>((resolve) => {
    resolveFirstRefresh = resolve;
  });
  const tui = {
    terminal: { rows: 20 },
    requestRender(): void {
      renderCount += 1;
    }
  } as unknown as TUI;
  const component = createAsyncShellViewerComponent({
    tui,
    getTheme: () => plainTheme,
    initialSnapshot: viewerSnapshot(),
    initialStream: "both",
    tailLines: 500,
    follow: false,
    loadSnapshot: () => {
      loadCount += 1;
      resolveFirstRefresh?.();
      return viewerSnapshot({ outputLines: ["--- stdout ---", `refresh-${loadCount}`] });
    },
    done: () => {
      doneCount += 1;
    },
    followIntervalMs: 5
  });

  component.render(80);
  component.handleInput?.("f");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("viewer follow did not refresh within 500 ms")), 500);
    void firstRefresh.then(() => {
      clearTimeout(timeout);
      resolve();
    }, reject);
  });
  assert.ok(loadCount >= 1);
  assert.ok(renderCount >= 1);
  component.dispose();
  const countAfterDispose = loadCount;
  await delay(20);
  assert.equal(loadCount, countAfterDispose, "dispose clears the follow timer");
  assert.equal(doneCount, 0);

  component.handleInput?.("q");
  assert.equal(doneCount, 1, "closing the viewer only resolves its UI");
});

test("shell_status lists recent jobs when jobId is omitted", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
    assert.equal(api.registeredTools.some((tool) => tool.name === "shell_list"), false);
    assert.ok(shellStart.execute);
    assert.ok(shellStatus.execute);

    await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "printf listed", cwd: dir, notifyOnExit: false }]
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const result = await shellStatus.execute(
      "tool-call-id",
      { limit: 5 } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { jobs: Array<{ command: string; status: string }> };
    assert.equal(details.jobs.length, 1);
    assert.equal(details.jobs[0].command, "printf listed");
    assert.equal(details.jobs[0].status, "exited");
    assert.match(JSON.stringify(result.content), /printf listed/);
  });
});


test("shell_status returns immediately from the latest snapshot and refreshes in the background", async () => {
  await withTempDir(async (dir) => {
    const historical = "job_20261024180000_latest001";
    await writeJobMeta(dir, historical, { command: "historical latest snapshot", startedAt: "2026-10-24T18:00:00.000Z" });
    await refreshAsyncShellRetentionSnapshot({ cwd: dir });
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
    const startedAt = Date.now();
    const result = await shellStatus.execute!("latest-list", { limit: 5 } as never, new AbortController().signal, undefined, createContext(dir));
    assert.ok(Date.now() - startedAt < 500, "list must not await its background refresh");
    assert.deepEqual((result.details as { jobs: Array<{ jobId: string }> }).jobs.map((job) => job.jobId), [historical]);
  });
});

test("snapshot job lists preserve exact managed-worker owner filtering", async () => {
  await withTempDir(async (dir) => {
    const workerId = "worker_20261024180000_owner01";
    const runId = "run_20261024180000_owner01";
    const own = "job_20261024180000_owner001";
    const other = "job_20261024180000_owner002";
    await writeJobMeta(dir, own, { owner: { kind: "worker-run", workerId, runId }, command: "owned current run" });
    await writeJobMeta(dir, other, { owner: { kind: "worker-run", workerId: "worker_other", runId: "run_other" }, command: "owned prior run" });
    await refreshAsyncShellRetentionSnapshot({ cwd: dir });
    await withEnv({ PI_WORKER_ID: workerId, PI_WORKER_RUN_ID: runId, PI_WORKER_ASYNC_JOB_ROOT: path.join(dir, ".pi", "async-shell") }, async () => {
      const api = createFakeApi();
      asyncShellExtension(api);
      const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
      const result = await shellStatus.execute!("owner-list", { limit: 20 } as never, new AbortController().signal, undefined, createContext(dir));
      assert.deepEqual((result.details as { jobs: Array<{ jobId: string }> }).jobs.map((job) => job.jobId), [own]);
    });
  });
});

test("async-shell active jobs remain scoped to their project registry", async () => {
  await withTempDir(async (dir) => {
    const projectA = path.join(dir, "project-a");
    const projectB = path.join(dir, "project-b");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
    assert.ok(shellStart.execute);
    assert.ok(shellStatus.execute);

    const started = await shellStart.execute(
      "tool-call-id",
      { commands: [{ command: "printf scoped", cwd: projectA, notifyOnExit: false }] } as never,
      new AbortController().signal,
      undefined,
      createContext(projectA)
    );
    const jobId = (started.details as { jobs: Array<{ jobId: string }> }).jobs[0].jobId;
    const foreignList = await shellStatus.execute(
      "tool-call-id",
      { limit: 20 } as never,
      new AbortController().signal,
      undefined,
      createContext(projectB)
    );

    assert.deepEqual((foreignList.details as { jobs: unknown[] }).jobs, []);
    await assert.rejects(
      shellStatus.execute(
        "tool-call-id",
        { jobId } as never,
        new AbortController().signal,
        undefined,
        createContext(projectB)
      ),
      /Unknown async shell job/
    );
  });
});

test("shell_status maps legacy label metadata to job_name", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
    assert.ok(shellStatus.execute);
    const jobId = "job_20260512143000_legacy1";
    await writeJobMeta(dir, jobId, { label: "legacy-name" });

    const result = await shellStatus.execute(
      "tool-call-id",
      { jobId } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { job: { job_name?: string } };
    assert.equal(details.job.job_name, "legacy-name");
  });
});

test("shell_status marks stranded running job metadata as unknown", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
    assert.ok(shellStatus.execute);
    const jobId = "job_20260512143000_stranded";
    await writeJobMeta(dir, jobId, { status: "running", pid: 2147483647, completionNotified: false });

    const result = await shellStatus.execute(
      "tool-call-id",
      { jobId } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { job: { status: string; error?: string } };
    assert.equal(details.job.status, "unknown");
    assert.match(details.job.error ?? "", /previous Pi process/);
  });
});

test("shell_start suppresses deferred completion notices when jobs complete in-band", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);

    const result = await shellStart.execute(
      "tool-call-id",
      {
        commands: [
          { command: "printf one", cwd: dir },
          { command: "printf two", cwd: dir },
          { command: "printf three", cwd: dir }
        ]
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { jobs: Array<{ status: string; exitCode?: number | null }> };
    assert.deepEqual(details.jobs.map((job) => [job.status, job.exitCode]), [
      ["exited", 0],
      ["exited", 0],
      ["exited", 0]
    ]);

    await delay(50);
    assert.equal(api.sentMessages.length, 0);
  });
});

test("single late-grace ENOSPC result is explicitly reported in-band and never triggers a duplicate turn across reload", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const context = createContext(dir, true);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);
    let restoreRename: (() => void) | undefined;
    let started = false;
    let result;
    try {
      result = await shellStart.execute(
        "single-late-grace-enospc",
        { commands: [{ command: "sleep 0.5", cwd: dir, job_name: "single-in-band-enospc" }] } as never,
        new AbortController().signal,
        () => {
          if (!started) {
            started = true;
            restoreRename = installAsyncMetaRenameEnospc();
          }
        },
        context
      );
    } finally {
      restoreRename?.();
    }
    const job = (result!.details as { jobs: Array<{ jobId: string; status: string; reportedInBand: boolean; error?: string }> }).jobs[0]!;
    assert.equal(job.status, "failed");
    assert.equal(job.reportedInBand, true);
    assert.match(job.error ?? "", /ENOSPC/);
    await api.emit("turn_end", {}, context);
    await api.emit("agent_end", {}, context);
    await delay(250);
    assert.equal(api.sentMessages.length, 0, "timer, queue, and flush paths must suppress the in-band result");

    const reloaded = createFakeApi();
    asyncShellExtension(reloaded);
    await reloaded.emit("session_start", { reason: "reload" }, context);
    await reloaded.emit("turn_end", {}, context);
    await reloaded.emit("agent_end", {}, context);
    await delay(250);
    assert.equal(reloaded.sentMessages.length, 0, "reload reconciliation must retain the holder-backed in-band latch");
    const shellStatus = required(reloaded.registeredTools.find((tool) => tool.name === "shell_status"), "reloaded shell_status");
    const status = await shellStatus.execute!("reported-status", { jobId: job.jobId } as never, new AbortController().signal, undefined, context);
    assert.equal((status.details as { job: { reportedInBand: boolean } }).job.reportedInBand, true);
  });
});

test("multi-job late-grace ENOSPC marks every terminal in-band result and sends zero notices", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const context = createContext(dir, true);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);
    let restoreRename: (() => void) | undefined;
    let started = false;
    let result;
    try {
      result = await shellStart.execute(
        "multi-late-grace-enospc",
        { commands: [
          { command: "sleep 0.4", cwd: dir, job_name: "multi-in-band-one" },
          { command: "sleep 0.6", cwd: dir, job_name: "multi-in-band-two" }
        ] } as never,
        new AbortController().signal,
        () => {
          if (!started) {
            started = true;
            restoreRename = installAsyncMetaRenameEnospc();
          }
        },
        context
      );
    } finally {
      restoreRename?.();
    }
    const jobs = (result!.details as { jobs: Array<{ status: string; reportedInBand: boolean; error?: string }> }).jobs;
    assert.equal(jobs.length, 2);
    assert.deepEqual(jobs.map((job) => job.reportedInBand), [true, true]);
    assert.deepEqual(jobs.map((job) => job.status), ["failed", "failed"]);
    assert.ok(jobs.every((job) => /ENOSPC/.test(job.error ?? "")));
    await api.emit("turn_end", {}, context);
    await api.emit("agent_end", {}, context);
    await delay(300);
    assert.equal(api.sentMessages.length, 0, "no in-band member can create a duplicate notice or new turn");
  });
});

test("shell_start batches deferred completions by the requested delivery mode and acknowledges exact receipts", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);
    const context = createContext(dir);

    const startResult = await shellStart.execute(
      "tool-call-id",
      {
        commands: [
          { command: "sleep 7; printf one", cwd: dir, job_name: "one", completionDelivery: "followUp" },
          { command: "sleep 7; printf ignored", cwd: dir, job_name: "ignored", notifyOnExit: false },
          { command: "sleep 7; printf three", cwd: dir, job_name: "three", completionDelivery: "followUp" },
          { command: "sleep 7; printf four", cwd: dir, job_name: "four", completionDelivery: "steer" }
        ]
      } as never,
      new AbortController().signal,
      undefined,
      context
    );

    const startText = JSON.stringify(startResult.content);
    assert.doesNotMatch(startText, /Started async shell/);
    assert.doesNotMatch(startText, /logs:/);
    assert.doesNotMatch(startText, /stdout:\\n|stderr:\\n|```/);
    assert.match(startText, /stdout_log:/);
    assert.match(startText, /stderr_log:/);
    assert.match(startText, /output_bytes:/);
    assert.match(startText, /recent_output: shell_read jobId=.*mode=tail/);
    assert.match(startText, /range_output: shell_read jobId=.*mode=range/);

    await delay(2500);

    assert.equal(api.sentMessages.length, 2);
    const sentMessage = required(
      api.sentMessages.find((candidate) => (candidate.options as { deliverAs?: string }).deliverAs === "followUp"),
      "followUp completion batch"
    );
    const steerMessage = required(
      api.sentMessages.find((candidate) => (candidate.options as { deliverAs?: string }).deliverAs === "steer"),
      "steer completion batch"
    );
    assert.deepEqual(sentMessage.options, { triggerTurn: true, deliverAs: "followUp" });
    assert.deepEqual(steerMessage.options, { triggerTurn: true, deliverAs: "steer" });
    assert.doesNotMatch(JSON.stringify(sentMessage.message), /Job completed\./);
    assert.doesNotMatch(JSON.stringify(sentMessage.message), /async-shell notification/);

    const message = sentMessage.message as {
      role?: string;
      customType?: string;
      content?: unknown;
      details?: { deliveryId?: string; jobs?: Array<{ jobId?: string; job_name?: string; logDir?: string }> };
    };
    assert.equal(typeof message.content, "string");
    const content = message.content as string;
    assert.match(content, /^async shell results: 2 jobs completed/);
    assert.match(content, /stdout_log:/);
    assert.match(content, /stderr_log:/);
    assert.match(content, /recent_output: shell_read jobId=.*mode=tail.*max 500 lines/);
    assert.match(content, /range_output: shell_read jobId=.*mode=range/);
    assert.match(content, /targeted_output: use search_many on stdout_log\/stderr_log/);
    assert.doesNotMatch(content, /job_id:|stdout:|stderr:|```|logs:/);

    const notifiedNames = (message.details?.jobs ?? [])
      .map((job) => job.job_name)
      .sort();
    assert.deepEqual(notifiedNames, ["one", "three"]);
    assert.doesNotMatch(JSON.stringify(sentMessage.message), /ignored|four/);
    assert.match(JSON.stringify(steerMessage.message), /four/);
    assert.doesNotMatch(JSON.stringify(steerMessage.message), /ignored|one|three/);
    const steerDetails = (steerMessage.message as { details?: { deliveryId?: string; logDir?: string } }).details;
    assert.equal(typeof steerDetails?.deliveryId, "string");
    assert.equal(typeof message.details?.deliveryId, "string");
    for (const job of message.details?.jobs ?? []) {
      const persisted = JSON.parse(await readFile(path.join(job.logDir!, "meta.json"), "utf8")) as { completionNotified: boolean };
      assert.equal(persisted.completionNotified, false, "sendMessage alone must not acknowledge completion delivery");
    }

    const steerBefore = JSON.parse(await readFile(path.join(steerDetails!.logDir!, "meta.json"), "utf8")) as { completionNotified: boolean };
    assert.equal(steerBefore.completionNotified, false);

    await api.emit("message_end", { message: { role: "custom", ...(sentMessage.message as object) } }, context);
    await api.emit("message_end", { message: { role: "custom", ...(steerMessage.message as object) } }, context);
    for (const job of message.details?.jobs ?? []) {
      const persisted = JSON.parse(await readFile(path.join(job.logDir!, "meta.json"), "utf8")) as { completionNotified: boolean };
      assert.equal(persisted.completionNotified, true, "the exact message lifecycle receipt acknowledges delivery");
    }
    const steerAfter = JSON.parse(await readFile(path.join(steerDetails!.logDir!, "meta.json"), "utf8")) as { completionNotified: boolean };
    assert.equal(steerAfter.completionNotified, true);
  });
});


test("Escape-style agent interruption preserves a queued completion without replaying its accepted send", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);
    let idle = false;
    const context = createContext(dir, () => idle);
    await api.emit("session_start", { type: "session_start" }, context);
    const controller = new AbortController();
    const escape = setTimeout(() => controller.abort(), 100);
    const startResult = await shellStart.execute(
      "tool-call-id",
      { commands: [{ command: "sleep 7", cwd: dir, job_name: "escape-pending", completionDelivery: "followUp" }] } as never,
      controller.signal,
      undefined,
      context
    ).finally(() => clearTimeout(escape));
    const jobId = (startResult.details as { jobs: Array<{ jobId: string }> }).jobs[0]!.jobId;
    idle = true;
    await api.emit("agent_end", { type: "agent_end", messages: [] }, context);
    for (let attempt = 0; attempt < 400 && api.sentMessages.length === 0; attempt += 1) await delay(25);
    assert.equal(api.sentMessages.length, 1, "the completion survives the interrupted agent turn");
    await api.emit("agent_end", { type: "agent_end", messages: [] }, context);
    await delay(50);
    assert.equal(api.sentMessages.length, 1, "an accepted ambiguous send remains claimed");
    const status = await buildAsyncShellStatusText(context);
    assert.match(status, /1 claimed in 1 unreceipted batch/);
    assert.match(status, new RegExp(jobId));
  });
});

test("failed compaction follow-up send stays queued and retries only on a later lifecycle flush", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    let attempts = 0;
    api.sendMessage = (message: unknown, options: unknown): void => {
      attempts += 1;
      if (attempts === 1) throw new Error("injected compaction follow-up rejection");
      api.sentMessages.push({ message, options });
    };
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);
    const context = createContext(dir, true);
    await api.emit("session_start", { type: "session_start" }, context);
    await shellStart.execute(
      "tool-call-id",
      { commands: [{ command: "sleep 7", cwd: dir, job_name: "compaction-follow-up", completionDelivery: "followUp" }] } as never,
      new AbortController().signal,
      undefined,
      context
    );
    for (let attempt = 0; attempt < 160 && attempts === 0; attempt += 1) await delay(25);
    assert.equal(attempts, 1);
    assert.equal(api.sentMessages.length, 0, "a rejected send is not accepted or lost");
    assert.match(await buildAsyncShellStatusText(context), /0 claimed in 0 unreceipted batches; 1 unsent/);
    await api.emit("turn_end", { type: "turn_end", turnIndex: 0, timestamp: Date.now(), message: {}, toolResults: [] }, context);
    assert.equal(attempts, 2);
    assert.equal(api.sentMessages.length, 1);
    await api.emit("turn_end", { type: "turn_end", turnIndex: 1, timestamp: Date.now(), message: {}, toolResults: [] }, context);
    assert.equal(attempts, 2, "the accepted retry remains claimed without ambiguous replay");
  });
});

test("shell_start does not replay an unacknowledged completion after session shutdown", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellRead = required(api.registeredTools.find((tool) => tool.name === "shell_read"), "shell_read tool");
    assert.ok(shellStart.execute);
    assert.ok(shellRead.execute);
    let stale = false;
    const context = createContext(dir, () => {
      if (stale) {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      }
      return false;
    });

    const startResult = await shellStart.execute(
      "tool-call-id",
      {
        commands: [
          { command: "sleep 7; printf one", cwd: dir, job_name: "one" },
          { command: "sleep 7; printf two", cwd: dir, job_name: "two" }
        ]
      } as never,
      new AbortController().signal,
      undefined,
      context
    );
    const jobs = (startResult.details as { jobs: Array<{ jobId: string; logDir?: string }> }).jobs;

    stale = true;
    await api.emit("session_shutdown", { reason: "reload" }, context);
    await delay(2500);
    assert.equal(api.sentMessages.length, 0);

    const replacementContext = createContext(dir);
    await api.emit("turn_end", { type: "turn_end", turnIndex: 0, timestamp: Date.now(), message: {}, toolResults: [] }, replacementContext);
    await delay(50);
    assert.equal(api.sentMessages.length, 0, "a replacement lifecycle must not replay the old runtime's ambiguous completion");

    await shellRead.execute(
      "read-observed-completion",
      { jobId: jobs[0].jobId, mode: "tail" } as never,
      new AbortController().signal,
      undefined,
      replacementContext
    );
    const observed = JSON.parse(await readFile(path.join(dir, ".pi", "async-shell", "jobs", jobs[0].jobId, "meta.json"), "utf8")) as { completionNotified: boolean };
    assert.equal(observed.completionNotified, true, "explicit historical observation safely acknowledges uncertain delivery");
  });
});

test("per-command notifyOnExit false suppresses deferred completion notices", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);

    await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "sleep 7; printf ignored", cwd: dir, notifyOnExit: false }]
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    await delay(2500);

    assert.equal(api.sentMessages.length, 0);
  });
});

test("shell_start rejects a pre-aborted call before creating durable job state", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      shellStart.execute!(
        "tool-call-id",
        { commands: [{ command: "printf never", cwd: dir, notifyOnExit: false }] } as never,
        controller.signal,
        undefined,
        createContext(dir)
      ),
      { name: "AbortError" }
    );
    await assert.rejects(stat(path.join(dir, ".pi", "async-shell")), /ENOENT/);
  });
});

test("shell_start interruption ends only the foreground grace wait and preserves the durable job", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 50);

    const started = await shellStart.execute!(
      "tool-call-id",
      { commands: [{ command: "sleep 0.3; printf survived", cwd: dir, notifyOnExit: false }] } as never,
      controller.signal,
      undefined,
      createContext(dir)
    );
    assert.ok(Date.now() - startedAt < 1_000, "foreground grace wait should settle promptly after interruption");
    const startedJob = (started.details as { jobs: Array<{ jobId: string; status: string; stdoutLog: string }> }).jobs[0];
    assert.equal(startedJob.status, "running");

    await delay(500);
    const status = await shellStatus.execute!(
      "tool-call-id",
      { jobId: startedJob.jobId } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );
    assert.equal((status.details as { job: { status: string } }).job.status, "exited");
    assert.equal(await readFile(startedJob.stdoutLog, "utf8"), "survived");
    assert.equal(api.sentMessages.length, 0);
  });
});

test("shell_start reports spawn errors for missing shells", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);

    const result = await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "printf never", cwd: dir, shell: "/no/such/shell", notifyOnExit: false }]
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { jobs: Array<{ status: string; error?: string; pid?: number; stdoutLog: string }> };
    assert.equal(details.jobs[0].status, "failed");
    assert.match(details.jobs[0].error ?? "", /ENOENT|no such|process id/i);
    assert.equal((details.jobs[0] as { pid?: number }).pid, undefined);
    const persisted = JSON.parse(await readFile(path.join(path.dirname(details.jobs[0].stdoutLog), "meta.json"), "utf8")) as { status: string; pid?: number };
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.pid, undefined);
    assert.deepEqual((await readdir(path.join(dir, ".pi", "async-shell", "jobs"))).filter((entry) => entry.startsWith(".pending-")), []);
  });
});

test("shell_start expands home in per-command cwd", async () => {
  await withTempDir(async (dir) => {
    const previousHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      const api = createFakeApi();
      asyncShellExtension(api);
      const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
      assert.ok(shellStart.execute);

      const result = await shellStart.execute(
        "tool-call-id",
        {
          commands: [{ command: "pwd", cwd: "~", notifyOnExit: false }]
        } as never,
        new AbortController().signal,
        undefined,
        createContext(path.join(dir, "project"))
      );

      const details = result.details as { jobs: Array<{ cwd: string; stdoutLog: string }> };
      assert.equal(details.jobs[0].cwd, dir);
      assert.equal(path.basename((await readFile(details.jobs[0].stdoutLog, "utf8")).trim()), path.basename(dir));
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });
});

test("shell_start preserves raw output bytes", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);

    const result = await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "node -e 'process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 50)'", cwd: dir, notifyOnExit: false }]
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const details = result.details as { jobs: Array<{ stdoutLog: string; outputBytes: { stdout: number } }> };
    assert.equal(details.jobs[0].outputBytes.stdout, 2);
    assert.equal((await stat(details.jobs[0].stdoutLog)).size, 2);
    assert.deepEqual([...(await readFile(details.jobs[0].stdoutLog))], [0xc3, 0xa9]);
    assert.equal(await readFile(details.jobs[0].stdoutLog, "utf8"), "é");
  });
});

test("shell_read tail mode reads stdout and stderr separately", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellRead = required(api.registeredTools.find((tool) => tool.name === "shell_read"), "shell_read tool");
    assert.ok(shellStart.execute);
    assert.ok(shellRead.execute);
    assert.equal(api.registeredTools.some((tool) => tool.name === "shell_tail"), false);

    const started = await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "printf out; printf err >&2", cwd: dir, notifyOnExit: false }]
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );
    const jobId = (started.details as { jobs: Array<{ jobId: string }> }).jobs[0].jobId;

    const stdoutOnly = await shellRead.execute("tool-call-id", { jobId, mode: "tail", stream: "stdout" } as never, new AbortController().signal, undefined, createContext(dir));
    const stderrOnly = await shellRead.execute("tool-call-id", { jobId, mode: "tail", stream: "stderr" } as never, new AbortController().signal, undefined, createContext(dir));
    const both = await shellRead.execute("tool-call-id", { jobId } as never, new AbortController().signal, undefined, createContext(dir));

    const stdoutDetails = stdoutOnly.details as { streams: Array<{ stream: string; mode: string; requestedLines?: number; previewLines: string[] }> };
    const stderrDetails = stderrOnly.details as { streams: Array<{ stream: string; mode: string; requestedLines?: number; previewLines: string[] }> };
    const bothDetails = both.details as { streams: Array<{ stream: string; mode: string; previewLines: string[] }> };
    assert.deepEqual(stdoutDetails.streams, [{ stream: "stdout", mode: "tail", logPath: path.join(dir, ".pi", "async-shell", "jobs", jobId, "stdout.log"), requestedLines: 80, requestedMaxChars: 20000, previewLines: ["out"] }]);
    assert.deepEqual(stderrDetails.streams, [{ stream: "stderr", mode: "tail", logPath: path.join(dir, ".pi", "async-shell", "jobs", jobId, "stderr.log"), requestedLines: 80, requestedMaxChars: 20000, previewLines: ["err"] }]);
    assert.deepEqual(bothDetails.streams.map((stream) => [stream.stream, stream.mode, stream.previewLines[0]]), [["stdout", "tail", "out"], ["stderr", "tail", "err"]]);
    const stdoutText = JSON.stringify(stdoutOnly.content);
    const stderrText = JSON.stringify(stderrOnly.content);
    assert.match(stdoutText, /--- stdout tail .*last up to 80 lines, 20 KB max\) ---\\nout/);
    assert.doesNotMatch(stdoutText, /stderr tail/);
    assert.match(stderrText, /--- stderr tail .*last up to 80 lines, 20 KB max\) ---\\nerr/);
    assert.doesNotMatch(stderrText, /stdout tail/);
  });
});

test("shell_read explicitly acknowledges a historical uncertain completion", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellRead = required(api.registeredTools.find((tool) => tool.name === "shell_read"), "shell_read tool");
    assert.ok(shellRead.execute);
    const jobId = "job_20260918010000_observed";
    await writeJobMeta(dir, jobId, {
      status: "exited",
      notifyOnExit: true,
      completionNotified: false
    });
    const logDir = path.join(dir, ".pi", "async-shell", "jobs", jobId);
    await writeFile(path.join(logDir, "stdout.log"), "reviewed\n");
    await writeFile(path.join(logDir, "stderr.log"), "");

    await shellRead.execute(
      "read-historical-completion",
      { jobId, mode: "tail" } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const meta = JSON.parse(await readFile(path.join(logDir, "meta.json"), "utf8")) as { completionNotified: boolean };
    assert.equal(meta.completionNotified, true);
  });
});

test("shell_read reads stdout and stderr ranges by jobId with offset and limit", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellRead = required(api.registeredTools.find((tool) => tool.name === "shell_read"), "shell_read tool");
    assert.ok(shellStart.execute);
    assert.ok(shellRead.execute);

    const started = await shellStart.execute(
      "tool-call-id",
      {
        commands: [{ command: "printf 'out1\\nout2\\nout3\\n'; printf 'err1\\nerr2\\n' >&2", cwd: dir, notifyOnExit: false }]
      } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );
    const jobId = (started.details as { jobs: Array<{ jobId: string }> }).jobs[0].jobId;

    const stdoutRange = await shellRead.execute(
      "tool-call-id",
      { jobId, stream: "stdout", offset: 2, limit: 1 } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );
    const bothRanges = await shellRead.execute(
      "tool-call-id",
      { jobId, offset: 1, limit: 1 } as never,
      new AbortController().signal,
      undefined,
      createContext(dir)
    );

    const stdoutDetails = stdoutRange.details as { streams: Array<{ stream: string; mode: string; offset: number; requestedLimit?: number; truncation: { nextOffset?: number; totalLines: number; outputLines: number }; previewLines: string[] }> };
    assert.deepEqual(stdoutDetails.streams.map((stream) => stream.stream), ["stdout"]);
    assert.equal(stdoutDetails.streams[0].offset, 2);
    assert.equal(stdoutDetails.streams[0].requestedLimit, 1);
    assert.equal(stdoutDetails.streams[0].truncation.nextOffset, 3);
    assert.deepEqual(stdoutDetails.streams[0].previewLines, ["out2"]);
    assert.equal(stdoutDetails.streams[0].mode, "range");
    assert.match(JSON.stringify(stdoutRange.content), /--- stdout range .*lines 2-2 of 4\) ---\\nout2/);
    assert.match(JSON.stringify(stdoutRange.content), /continue with mode=range offset=3/);

    const bothDetails = bothRanges.details as { streams: Array<{ stream: string; truncation: { nextOffset?: number } }> };
    assert.deepEqual(bothDetails.streams.map((stream) => stream.stream), ["stdout", "stderr"]);
    assert.deepEqual(bothDetails.streams.map((stream) => stream.truncation.nextOffset), [2, 2]);
  });
});

test("shell_cancel transitions a running job to cancelled and suppresses completion notices", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const statuses: Array<string | undefined> = [];
    const context = {
      ...createContext(dir),
      mode: "tui",
      hasUI: true,
      ui: {
        theme: plainTheme,
        setStatus(_key: string, text: string | undefined): void { statuses.push(text); }
      }
    } as unknown as ExtensionContext;
    await api.emit("session_start", { reason: "startup" }, context);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    const shellCancel = required(api.registeredTools.find((tool) => tool.name === "shell_cancel"), "shell_cancel tool");
    const shellStatus = required(api.registeredTools.find((tool) => tool.name === "shell_status"), "shell_status tool");
    assert.ok(shellStart.execute);
    assert.ok(shellCancel.execute);
    assert.ok(shellStatus.execute);

    const started = await shellStart.execute(
      "tool-call-id",
      { commands: [{ command: "sleep 30", cwd: dir }] } as never,
      new AbortController().signal,
      undefined,
      context
    );
    const jobId = (started.details as { jobs: Array<{ jobId: string }> }).jobs[0].jobId;

    assert.equal(statuses.at(-1), "sh1", "a still-running shell_start job is counted");
    const cancelled = await shellCancel.execute("tool-call-id", { jobId, signal: "SIGTERM" } as never, new AbortController().signal, undefined, context);
    assert.equal((cancelled.details as { job: { notifyOnExit: boolean } }).job.notifyOnExit, false);
    await delay(500);

    const status = await shellStatus.execute("tool-call-id", { jobId } as never, new AbortController().signal, undefined, context);
    const job = (status.details as { job: { status: string; notifyOnExit: boolean; signal?: string | null } }).job;
    assert.equal(job.status, "cancelled");
    assert.equal(job.notifyOnExit, false);
    assert.equal(job.signal, "SIGTERM");
    await delay(50);
    assert.equal(api.sentMessages.length, 0);
    assert.equal(statuses.at(-1), undefined, "shell cancellation clears activity");
    await api.emit("session_shutdown", { reason: "quit" }, context);
  });
});

test("managed worker shell launch fails closed outside its Sandbox runtime", async () => {
  await withTempDir(async (dir) => {
    await Promise.all([
      mkdir(path.join(dir, "cache", "config"), { recursive: true }),
      mkdir(path.join(dir, "cache", "data"), { recursive: true }),
      mkdir(path.join(dir, "cache", "state"), { recursive: true }),
      mkdir(path.join(dir, "tmp"), { recursive: true }),
      mkdir(path.join(dir, "worker-state", "async-shell"), { recursive: true })
    ]);
    await withEnv({
      PI_WORKER_ID: "worker-test",
      PI_WORKER_RUN_ID: "run-missing-container",
      PI_WORKER_WORKSPACE_ROOT: dir,
      PI_WORKER_STATE_ROOT: path.join(dir, "worker-state"),
      PI_WORKER_ASYNC_JOB_ROOT: path.join(dir, "worker-state", "async-shell")
    }, async () => {
      const api = createFakeApi();
      asyncShellExtension(api);
      assert.throws(() => startManagedAsyncJob(api, createContext(dir), {
        jobId: "job_20260917150000_nocontainer",
        command: "must not run",
        cwd: dir,
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        notifyOnExit: false
      }), /requires the in-Sandbox runtime/);
    });
  });
});

test("managed worker owner cancellation settles every owned async-shell job", { skip: process.platform !== "darwin" }, async () => {
  await withTempDir(async (dir) => {
    await Promise.all([
      mkdir(path.join(dir, "cache", "config"), { recursive: true }),
      mkdir(path.join(dir, "cache", "data"), { recursive: true }),
      mkdir(path.join(dir, "cache", "state"), { recursive: true }),
      mkdir(path.join(dir, "tmp"), { recursive: true }),
      mkdir(path.join(dir, "worker-state", "async-shell"), { recursive: true })
    ]);
    await withEnv({
      PI_WORKER_ID: "worker-test",
      PI_WORKER_RUN_ID: "run-test",
      PI_WORKER_NATIVE_TEST_SHELL: "1",
      PI_WORKER_WORKSPACE_ROOT: dir,
      PI_WORKER_STATE_ROOT: path.join(dir, "worker-state"),
      PI_WORKER_ASYNC_JOB_ROOT: path.join(dir, "worker-state", "async-shell")
    }, async () => {
      const api = createFakeApi();
      asyncShellExtension(api);
      const context = createContext(dir);
      const handle = startManagedAsyncJob(api, context, {
        jobId: "job_20260910193000_ownedtest",
        command: "long owned job",
        cwd: dir,
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        notifyOnExit: false
      });
      const owner = { kind: "worker-run" as const, workerId: "worker-test", runId: "run-test" };
      assert.deepEqual(activeAsyncShellJobsForOwner(owner).map((job) => job.jobId), [handle.jobId]);

      const cancelled = await cancelAsyncShellJobsForOwner(owner, "SIGTERM", 1_000);
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0].status, "cancelled");
      assert.equal((await handle.completion).status, "cancelled");
      assert.deepEqual(activeAsyncShellJobsForOwner(owner), []);

      const marker = path.join(dir, "persisted-owned.pid");
      const persistedHandle = startManagedAsyncJob(api, context, {
        jobId: "job_20260910193000_persisted",
        command: "persisted owned job",
        cwd: dir,
        executable: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],
        notifyOnExit: false
      });
      for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) await delay(10);
      assert.ok(existsSync(marker));
      const persistedPid = Number.parseInt(await readFile(marker, "utf8"), 10);
      const persisted = await cancelPersistedAsyncShellJobsForOwner(path.join(dir, "worker-state", "async-shell"), owner, 100);
      assert.equal(persisted.map((job) => job.jobId).includes(persistedHandle.jobId), true);
      const persistedKeepAlive = setInterval(() => {}, 20);
      const persistedCompletion = await persistedHandle.completion.finally(() => clearInterval(persistedKeepAlive));
      assert.ok(["failed", "cancelled"].includes(persistedCompletion.status));
      let persistedAlive = true;
      for (let attempt = 0; attempt < 200 && persistedAlive; attempt += 1) {
        try { process.kill(persistedPid, 0); await delay(10); } catch { persistedAlive = false; }
      }
      assert.equal(persistedAlive, false);
    });
  });
});

test("persisted owner cancellation never signals a terminal job's reused pid", async () => {
  await withTempDir(async (directory) => {
    const asyncRoot = path.join(directory, "async-shell");
    const jobId = "job_20260910193000_terminalpid";
    const logDir = path.join(asyncRoot, "jobs", jobId);
    await mkdir(logDir, { recursive: true });
    const victim = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore"
    });
    assert.ok(victim.pid);
    const owner = { kind: "worker-run" as const, workerId: "worker-test", runId: "run-terminal" };
    await Promise.all([
      writeFile(path.join(logDir, "stdout.log"), ""),
      writeFile(path.join(logDir, "stderr.log"), ""),
      writeFile(path.join(logDir, "meta.json"), `${JSON.stringify({
        jobId,
        command: "historical terminal job",
        cwd: directory,
        shell: process.execPath,
        status: "exited",
        pid: victim.pid,
        processToken: "historical-token-that-does-not-match",
        startedAt: "2026-09-10T19:30:00.000Z",
        endedAt: "2026-09-10T19:30:01.000Z",
        notifyOnExit: false,
        completionNotified: true,
        owner,
        logDir,
        stdoutLog: path.join(logDir, "stdout.log"),
        stderrLog: path.join(logDir, "stderr.log"),
        outputBytes: { stdout: 0, stderr: 0 }
      })}\n`)
    ]);
    const cancelled = await cancelPersistedAsyncShellJobsForOwner(asyncRoot, owner, 50);
    assert.deepEqual(cancelled, []);
    assert.doesNotThrow(() => process.kill(victim.pid!, 0));
    try { process.kill(-victim.pid, "SIGKILL"); } catch {}
  });
});

test("worker shell output is captured in trusted state outside the writable workspace", { skip: process.platform !== "darwin" }, async () => {
  await withTempDir(async (directory) => {
    const workspace = path.join(directory, "workspace");
    const stateRoot = path.join(directory, "state");
    const asyncRoot = path.join(stateRoot, "async-shell");
    await Promise.all([
      mkdir(path.join(workspace, "cache", "config"), { recursive: true }),
      mkdir(path.join(workspace, "cache", "data"), { recursive: true }),
      mkdir(path.join(workspace, "cache", "state"), { recursive: true }),
      mkdir(path.join(workspace, "tmp"), { recursive: true }),
      mkdir(asyncRoot, { recursive: true })
    ]);
    await withEnv({
      PI_WORKER_ID: "worker-test",
      PI_WORKER_RUN_ID: "run-external-logs",
      PI_WORKER_NATIVE_TEST_SHELL: "1",
      PI_WORKER_WORKSPACE_ROOT: workspace,
      PI_WORKER_STATE_ROOT: stateRoot,
      PI_WORKER_ASYNC_JOB_ROOT: asyncRoot
    }, async () => {
      const api = createFakeApi();
      asyncShellExtension(api);
      const handle = startManagedAsyncJob(api, createContext(workspace), {
        jobId: "job_20260910193000_extlogs",
        command: "trusted external log probe",
        cwd: workspace,
        executable: process.execPath,
        args: ["-e", "console.log('TRUSTED_EXTERNAL_LOG')"],
        notifyOnExit: false
      });
      const keepAlive = setInterval(() => {}, 20);
      const job = await handle.completion.finally(() => clearInterval(keepAlive));
      assert.equal(job.status, "exited", await readFile(job.stderrLog, "utf8"));
      assert.equal(await readFile(job.stdoutLog, "utf8"), "TRUSTED_EXTERNAL_LOG\n");
      assert.equal(job.stdoutLog.startsWith(workspace), false);
    });
  });
});

test("worker shell_read rejects traversal IDs and forged metadata log paths", async () => {
  await withTempDir(async (dir) => {
    const stateRoot = path.join(dir, "worker-state");
    const asyncRoot = path.join(stateRoot, "async-shell");
    const forgedDir = path.join(asyncRoot, "jobs", "job_forged");
    await Promise.all([
      mkdir(path.join(dir, "cache", "config"), { recursive: true }),
      mkdir(path.join(dir, "cache", "data"), { recursive: true }),
      mkdir(path.join(dir, "cache", "state"), { recursive: true }),
      mkdir(path.join(dir, "tmp"), { recursive: true }),
      mkdir(forgedDir, { recursive: true })
    ]);
    const secret = path.join(stateRoot, "host.json");
    await writeFile(secret, "trusted-secret");
    await writeFile(path.join(forgedDir, "meta.json"), `${JSON.stringify({
      jobId: "job_forged",
      command: "forged",
      cwd: dir,
      shell: "/bin/zsh",
      status: "exited",
      startedAt: "2026-09-10T19:30:00.000Z",
      notifyOnExit: false,
      completionNotified: true,
      owner: { kind: "worker-run", workerId: "worker-test", runId: "run-forged" },
      logDir: forgedDir,
      stdoutLog: secret,
      stderrLog: path.join(forgedDir, "stderr.log"),
      outputBytes: { stdout: 0, stderr: 0 }
    })}\n`);
    await withEnv({
      PI_WORKER_ID: "worker-test",
      PI_WORKER_RUN_ID: "run-forged",
      PI_WORKER_WORKSPACE_ROOT: dir,
      PI_WORKER_STATE_ROOT: stateRoot,
      PI_WORKER_ASYNC_JOB_ROOT: asyncRoot
    }, async () => {
      const api = createFakeApi();
      asyncShellExtension(api);
      const read = api.registeredTools.find((tool) => tool.name === "shell_read");
      assert.ok(read?.execute);
      await assert.rejects(read.execute("read-traversal", { jobId: "../host" } as never, undefined, undefined, createContext(dir)), /Invalid async shell job id/);
      await assert.rejects(read.execute("read-forged", { jobId: "job_forged" } as never, undefined, undefined, createContext(dir)), /Unknown async shell job/);
    });
  });
});

test("owned jobs remain active until background process-group descendants settle", { skip: process.platform !== "darwin" }, async () => {
  await withTempDir(async (dir) => {
    await Promise.all([
      mkdir(path.join(dir, "cache", "config"), { recursive: true }),
      mkdir(path.join(dir, "cache", "data"), { recursive: true }),
      mkdir(path.join(dir, "cache", "state"), { recursive: true }),
      mkdir(path.join(dir, "tmp"), { recursive: true }),
      mkdir(path.join(dir, "worker-state", "async-shell"), { recursive: true })
    ]);
    await withEnv({
      PI_WORKER_ID: "worker-test",
      PI_WORKER_RUN_ID: "run-background",
      PI_WORKER_NATIVE_TEST_SHELL: "1",
      PI_WORKER_WORKSPACE_ROOT: dir,
      PI_WORKER_STATE_ROOT: path.join(dir, "worker-state"),
      PI_WORKER_ASYNC_JOB_ROOT: path.join(dir, "worker-state", "async-shell")
    }, async () => {
      const api = createFakeApi();
      asyncShellExtension(api);
      const marker = path.join(dir, "background.pid");
      const childSource = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
      const source = `const{spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));child.unref();`;
      const handle = startManagedAsyncJob(api, createContext(dir), {
        jobId: "job_20260910193000_background",
        command: "background descendant probe",
        cwd: dir,
        executable: process.execPath,
        args: ["-e", source],
        notifyOnExit: false
      });
      for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) await delay(10);
      assert.ok(existsSync(marker));
      const descendantPid = Number.parseInt(await readFile(marker, "utf8"), 10);
      await delay(100);
      const owner = { kind: "worker-run" as const, workerId: "worker-test", runId: "run-background" };
      assert.deepEqual(activeAsyncShellJobsForOwner(owner).map((job) => job.jobId), [handle.jobId]);
      const cancelled = await cancelAsyncShellJobsForOwner(owner, "SIGTERM", 100);
      assert.equal(cancelled[0].status, "cancelled");
      let alive = true;
      for (let attempt = 0; attempt < 200 && alive; attempt += 1) {
        try {
          process.kill(descendantPid, 0);
          await delay(10);
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false, `background descendant ${descendantPid} survived process-group cancellation`);
    });
  });
});

test("managed spawn metadata failure retains and settles the spawned process", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const jobId = "job_20260910193000_metafail";
    const jobsDirectory = path.join(dir, ".pi", "async-shell", "jobs");
    const logDirectory = path.join(jobsDirectory, jobId);
    const handle = startManagedAsyncJob(api, createContext(dir), {
      jobId,
      command: "post-spawn metadata failure probe",
      cwd: dir,
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      notifyOnExit: false,
      settleProcessGroup: true,
      persistSpawnedMetadata: () => {
        assert.equal(existsSync(logDirectory), false, "final job directory must remain unpublished until metadata is complete");
        throw new Error("injected metadata write failure");
      }
    });
    const pid = handle.snapshot().pid;
    assert.ok(pid);
    const keepAlive = setInterval(() => {}, 20);
    const job = await handle.completion.finally(() => clearInterval(keepAlive));
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /injected metadata write failure/);
    const persisted = JSON.parse(await readFile(path.join(logDirectory, "meta.json"), "utf8"));
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.pid, pid);
    assert.deepEqual((await readdir(jobsDirectory)).filter((entry) => entry.startsWith(".pending-")), []);
    let alive = true;
    for (let attempt = 0; attempt < 200 && alive; attempt += 1) {
      try { process.kill(pid, 0); await delay(10); } catch { alive = false; }
    }
    assert.equal(alive, false);
  });
});


test("persistent startup metadata failure settles once and leaves a classified exact pending artifact", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const jobId = "job_20260910193000_metacollide";
    const jobsDirectory = path.join(dir, ".pi", "async-shell", "jobs");
    const logDirectory = path.join(jobsDirectory, jobId);
    const handle = startManagedAsyncJob(api, createContext(dir), {
      jobId,
      command: "persistent metadata collision",
      cwd: dir,
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      notifyOnExit: false,
      persistSpawnedMetadata: () => mkdirSync(path.join(logDirectory, "collision"), { recursive: true })
    });
    const completion = await waitWithRefTimeout(handle.completion);
    assert.equal(completion.status, "failed");
    assert.match(completion.error ?? "", /persist spawned async job metadata/i);
    const endedAt = completion.endedAt;
    const pid = handle.snapshot().pid;
    if (pid !== undefined) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try { process.kill(pid, 0); await delay(10); } catch { break; }
      }
    }
    assert.equal(handle.snapshot().endedAt, endedAt, "close/error races cannot settle the job twice");
    const leftovers = await listEligibleAsyncShellPrune({ cwd: dir }, undefined, 100, "leftovers");
    const pending = required(leftovers.entries.find((entry) => entry.kind === "pending"), "classified pending metadata artifact");
    assert.equal(previewAsyncShellPrune({ cwd: dir }, [pending.name])[0]?.kind, "pending");
    assert.equal(pruneAsyncShellJobs({ cwd: dir }, [pending.name]).length, 1);
  });
});

test("terminal metadata write failure cannot escape the child lifecycle or strand waiters", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const handle = startManagedAsyncJob(api, createContext(dir), {
      jobId: "job_20260910193000_terminalmeta",
      command: "terminal metadata failure",
      cwd: dir,
      executable: process.execPath,
      args: ["-e", "setTimeout(()=>process.exit(0),300)"],
      notifyOnExit: false
    });
    const metaPath = path.join(handle.snapshot().logDir, "meta.json");
    await rm(metaPath);
    await mkdir(metaPath);
    const completion = await waitWithRefTimeout(handle.completion);
    assert.equal(completion.status, "failed");
    assert.match(completion.error ?? "", /terminal metadata persistence failed/i);
    const endedAt = completion.endedAt;
    await delay(50);
    assert.equal(handle.snapshot().endedAt, endedAt, "terminal persistence failure settles exactly once");
  });
});


test("grace-period metadata failure never rejects the batch or strands a sibling completion", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);
    const context = createContext(dir, true);
    let started: Array<{ jobId: string; stdoutLog: string }> = [];
    const controller = new AbortController();
    const resultPromise = shellStart.execute(
      "metadata-grace-batch",
      { commands: [
        { command: "sleep 0.4", cwd: dir, job_name: "blocked-meta" },
        { command: "sleep 1.2", cwd: dir, job_name: "sibling" }
      ] } as never,
      controller.signal,
      (update) => { started = (update.details as { jobs: Array<{ jobId: string; stdoutLog: string }> }).jobs; },
      context
    );
    for (let attempt = 0; attempt < 100 && started.length === 0; attempt += 1) await delay(5);
    assert.equal(started.length, 2);
    const blockedMeta = path.join(path.dirname(started[0]!.stdoutLog), "meta.json");
    await rm(blockedMeta);
    await mkdir(blockedMeta);
    await delay(650);
    controller.abort();
    const result = await resultPromise;
    const details = result.details as { jobs: Array<{ status: string; error?: string }> };
    assert.equal(details.jobs[0]?.status, "failed");
    assert.match(details.jobs[0]?.error ?? "", /metadata persistence failed/i);
    assert.match(String(result.content[0]?.type === "text" ? result.content[0].text : ""), /failed \(process exit 0\)/);
    for (let attempt = 0; attempt < 160 && api.sentMessages.length === 0; attempt += 1) await delay(25);
    assert.equal(api.sentMessages.length, 1, "the sibling clears its barrier and delivers once");
    assert.match(JSON.stringify(api.sentMessages[0]?.message), /sibling/);
    assert.doesNotMatch(JSON.stringify(api.sentMessages[0]?.message), /blocked-meta/);
  });
});

test("cancellation signals and settles even when cancellation metadata cannot persist", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const handle = startManagedAsyncJob(api, createContext(dir), {
      jobId: "job_20260910193000_cancelmeta",
      command: "cancel metadata failure",
      cwd: dir,
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      notifyOnExit: false
    });
    const metaPath = path.join(handle.snapshot().logDir, "meta.json");
    await rm(metaPath);
    await mkdir(metaPath);
    assert.doesNotThrow(() => handle.cancel("SIGTERM"));
    const completion = await waitWithRefTimeout(handle.completion);
    assert.equal(completion.status, "failed");
    assert.match(completion.error ?? "", /Cancellation metadata persistence failed/);
    assert.match(completion.error ?? "", /Terminal metadata persistence failed/);
  });
});

test("shell_read remains available and reports unacknowledged state when acknowledgement persistence fails", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const context = createContext(dir);
    const shellRead = required(api.registeredTools.find((tool) => tool.name === "shell_read"), "shell_read tool");
    assert.ok(shellRead.execute);
    const handle = startManagedAsyncJob(api, context, {
      jobId: "job_20260910193000_ackmeta",
      command: "ack metadata failure",
      cwd: dir,
      executable: process.execPath,
      args: ["-e", "process.stdout.write('available')"],
      notifyOnExit: false
    });
    await waitWithRefTimeout(handle.completion);
    const metaPath = path.join(handle.snapshot().logDir, "meta.json");
    await rm(metaPath);
    await mkdir(metaPath);
    const result = await shellRead.execute("read-ack-failure", { jobId: handle.jobId, mode: "tail" } as never, new AbortController().signal, undefined, context);
    const job = (result.details as { job: { status: string; completionNotified: boolean; error?: string } }).job;
    assert.equal(job.status, "failed");
    assert.equal(job.completionNotified, false);
    assert.match(job.error ?? "", /Completion acknowledgement persistence failed/);
    assert.match(JSON.stringify(result.content), /available/);
  });
});

test("partial batch startup failure releases earlier job barriers", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const shellStart = required(api.registeredTools.find((tool) => tool.name === "shell_start"), "shell_start tool");
    assert.ok(shellStart.execute);
    const context = createContext(dir, true);
    let startupError: unknown;
    try {
      await shellStart.execute(
        "partial-start-failure",
        { commands: [
          { command: "sleep 0.5", cwd: dir, job_name: "started-before-failure" },
          { command: "never", cwd: dir, shell: "bad\0shell", job_name: "invalid-spawn" }
        ] } as never,
        new AbortController().signal,
        undefined,
        context
      );
    } catch (error) {
      startupError = error;
    }
    assert.match(String(startupError), /null bytes|must be a string without null bytes|invalid/i);
    assert.match(String(startupError), /already-started async job IDs: job_/);
    for (let attempt = 0; attempt < 160 && api.sentMessages.length === 0; attempt += 1) await delay(25);
    assert.equal(api.sentMessages.length, 1);
    assert.match(JSON.stringify(api.sentMessages[0]?.message), /started-before-failure/);
  });
});

test("managed process-group settlement waits when the host leader exits before its descendant", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const marker = path.join(dir, "managed-host-descendant.pid");
    const childSource = "setInterval(()=>{},1000)";
    const source = `const{spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));setImmediate(()=>process.exit(0));`;
    const handle = startManagedAsyncJob(api, createContext(dir), {
      jobId: "job_20260910193000_hostgroup",
      command: "managed host descendant settlement probe",
      cwd: dir,
      executable: process.execPath,
      args: ["-e", source],
      notifyOnExit: false,
      settleProcessGroup: true
    });
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) await delay(10);
    assert.ok(existsSync(marker));
    const leaderPid = required(handle.snapshot().pid, "managed host leader pid");
    let leaderAlive = true;
    for (let attempt = 0; attempt < 200 && leaderAlive; attempt += 1) {
      try { process.kill(leaderPid, 0); await delay(10); } catch { leaderAlive = false; }
    }
    assert.equal(leaderAlive, false, "the command leader must exit before descendant settlement is tested");
    let completed = false;
    void handle.completion.then(() => { completed = true; });
    await delay(100);
    assert.equal(completed, false, "managed host completion must wait for its original process group descendant");
    handle.cancel("SIGTERM");
    const keepAlive = setInterval(() => {}, 20);
    const job = await handle.completion.finally(() => clearInterval(keepAlive));
    assert.equal(job.status, "cancelled");
    const pid = Number.parseInt(await readFile(marker, "utf8"), 10);
    let alive = true;
    for (let attempt = 0; attempt < 200 && alive; attempt += 1) {
      try { process.kill(pid, 0); await delay(10); } catch { alive = false; }
    }
    assert.equal(alive, false);
  });
});

test("ordinary async-shell completion remains tied to the requested command leader", async () => {
  await withTempDir(async (dir) => {
    const api = createFakeApi();
    asyncShellExtension(api);
    const marker = path.join(dir, "ordinary-background.pid");
    const childSource = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const source = `const{spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));child.unref();`;
    const handle = startManagedAsyncJob(api, createContext(dir), {
      jobId: "job_20260910193000_ordinary",
      command: "ordinary background compatibility probe",
      cwd: dir,
      executable: process.execPath,
      args: ["-e", source],
      notifyOnExit: false
    });
    const keepAlive = setInterval(() => {}, 20);
    const job = await handle.completion.finally(() => clearInterval(keepAlive));
    assert.equal(job.status, "exited");
    const pid = Number.parseInt(await readFile(marker, "utf8"), 10);
    assert.doesNotThrow(() => process.kill(pid, 0));
    try { process.kill(pid, "SIGKILL"); } catch {}
  });
});

test("worker ownership token tracks and cancels children that create a detached process group", { skip: process.platform !== "darwin" }, async () => {
  await withTempDir(async (dir) => {
    const stateRoot = path.join(dir, "worker-state");
    const asyncRoot = path.join(stateRoot, "async-shell");
    await Promise.all([
      mkdir(path.join(dir, "cache", "config"), { recursive: true }),
      mkdir(path.join(dir, "cache", "data"), { recursive: true }),
      mkdir(path.join(dir, "cache", "state"), { recursive: true }),
      mkdir(path.join(dir, "tmp"), { recursive: true }),
      mkdir(asyncRoot, { recursive: true })
    ]);
    await withEnv({
      PI_WORKER_ID: "worker-test",
      PI_WORKER_RUN_ID: "run-detached",
      PI_WORKER_NATIVE_TEST_SHELL: "1",
      PI_WORKER_WORKSPACE_ROOT: dir,
      PI_WORKER_STATE_ROOT: stateRoot,
      PI_WORKER_ASYNC_JOB_ROOT: asyncRoot
    }, async () => {
      const api = createFakeApi();
      asyncShellExtension(api);
      const marker = path.join(dir, "detached.pid");
      const childSource = "setInterval(()=>{},1000)";
      const source = `const{spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));child.unref();`;
      const handle = startManagedAsyncJob(api, createContext(dir), {
        jobId: "job_20260910193000_detached",
        command: "detached escape probe",
        cwd: dir,
        executable: process.execPath,
        args: ["-e", source],
        notifyOnExit: false
      });
      for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) await delay(10);
      assert.ok(existsSync(marker));
      const pid = Number.parseInt(await readFile(marker, "utf8"), 10);
      const owner = { kind: "worker-run" as const, workerId: "worker-test", runId: "run-detached" };
      await delay(100);
      assert.deepEqual(activeAsyncShellJobsForOwner(owner).map((job) => job.jobId), [handle.jobId]);
      await cancelAsyncShellJobsForOwner(owner, "SIGTERM", 100);
      await handle.completion;
      let alive = true;
      for (let attempt = 0; attempt < 200 && alive; attempt += 1) {
        try {
          process.kill(pid, 0);
          await delay(10);
        } catch {
          alive = false;
        }
      }
      if (alive) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      assert.equal(alive, false, `detached worker child ${pid} escaped ownership-token cancellation`);
    });
  });
});

test("async-shell does not register a polling wait tool", () => {
  const api = createFakeApi();
  asyncShellExtension(api);

  assert.equal(api.registeredTools.some((tool) => tool.name === "shell_wait"), false);
});
