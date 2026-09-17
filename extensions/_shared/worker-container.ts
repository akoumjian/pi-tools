import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const WORKER_CONTAINER_VERSION = 1;
export const WORKER_CONTAINER_IMAGE = "alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce";

const WORKER_CONTAINER_READY_FILE = "/run/pi-worker-ready";
const WORKER_CONTAINER_START_TIMEOUT_MS = 120_000;
const WORKER_CONTAINER_STOP_TIMEOUT_SECONDS = 4;
const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const CONTAINER_BOOTSTRAP = [
  "set -eu",
  "apk add --no-cache bash bind-tools build-base ca-certificates coreutils curl file findutils git iproute2 jq nodejs npm openssh-client patch procps py3-pip python3 ripgrep tar util-linux zip >/var/log/pi-worker-apk.log 2>&1",
  "mkdir -p /run/pi-jobs",
  "rm -rf /run/pi-jobs/*",
  `cut -d ' ' -f 22 /proc/1/stat > ${WORKER_CONTAINER_READY_FILE}`,
  "on_term() { trap '' TERM INT; sleep 30; }",
  "trap on_term TERM INT",
  "while :; do",
  "  for ready in /run/pi-jobs/*/ready; do",
  "    [ -f \"$ready\" ] || continue",
  "    job=${ready%/ready}",
  "    mv \"$ready\" \"$job/accepted\" 2>/dev/null || continue",
  "    /bin/sh \"$job/launch\" &",
  "  done",
  "  sleep 0.05",
  "done"
].join("\n");

export type WorkerContainerReference = {
  version: typeof WORKER_CONTAINER_VERSION;
  workerId: string;
  runId: string;
  name: string;
  nonce: string;
  image: string;
  codeRoot: string;
  workspaceRoot: string;
  containerId?: string;
};

export type WorkerContainerProcess = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export function planWorkerContainer(input: {
  workerId: string;
  runId: string;
  nonce: string;
  workspaceRoot: string;
  codeRoot?: string;
}): WorkerContainerReference {
  const workspaceRoot = realDirectory(input.workspaceRoot, "worker workspace");
  const codeRoot = realDirectory(input.codeRoot ?? path.join(homedir(), "Code"), "worker read-only source root");
  return {
    version: WORKER_CONTAINER_VERSION,
    workerId: input.workerId,
    runId: input.runId,
    name: workerContainerName(input.workerId, input.runId),
    nonce: input.nonce,
    image: WORKER_CONTAINER_IMAGE,
    codeRoot,
    workspaceRoot
  };
}

export function createWorkerContainer(
  dockerPath: string,
  reference: WorkerContainerReference
): WorkerContainerReference & { containerId: string } {
  assertWorkerContainerReference(reference);
  assertExecutable(dockerPath, "Docker CLI");
  const existing = inspectWorkerContainer(dockerPath, reference);
  if (existing) {
    if (existing.state.Running) parkWorkerContainer(dockerPath, { ...reference, containerId: existing.id });
    execDocker(dockerPath, ["start", existing.id]);
    waitForWorkerContainerReady(dockerPath, existing.id, reference);
    return { ...reference, containerId: existing.id };
  }
  if (reference.containerId) {
    throw new Error(`Docker worker container ${reference.name} disappeared; refusing to replace its exact persisted identity.`);
  }
  assertWorkerContainerImageAvailable(dockerPath, reference.image);

  let containerId: string | undefined;
  try {
    containerId = execDocker(dockerPath, [
      "create",
      "--platform", "linux/arm64",
      "--name", reference.name,
      "--hostname", reference.workerId,
      "--label", `pi.worker=${reference.workerId}`,
      "--label", `pi.run=${reference.runId}`,
      "--label", `pi.nonce=${reference.nonce}`,
      "--mount", bindMount(reference.codeRoot, true),
      "--mount", bindMount(reference.workspaceRoot, false),
      "--workdir", reference.workspaceRoot,
      "--network", "bridge",
      "--restart", "no",
      "--init",
      "--stop-signal", "SIGTERM",
      "--stop-timeout", String(WORKER_CONTAINER_STOP_TIMEOUT_SECONDS),
      "--pids-limit", "4096",
      "--security-opt", "no-new-privileges=true",
      "--entrypoint", "/bin/sh",
      reference.image,
      "-c", CONTAINER_BOOTSTRAP
    ]).trim();
    if (!/^[a-f0-9]{64}$/.test(containerId)) {
      throw new Error(`Docker returned an invalid worker container id: ${containerId || "(empty)"}.`);
    }
    execDocker(dockerPath, ["start", containerId]);
    waitForWorkerContainerReady(dockerPath, containerId, reference);
    return { ...reference, containerId };
  } catch (cause) {
    if (containerId) removeContainerByIdBestEffort(dockerPath, containerId);
    throw new Error(
      `Unable to start Docker worker container ${reference.name}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
}

export function parkWorkerContainer(dockerPath: string, reference: WorkerContainerReference): void {
  assertWorkerContainerReference(reference);
  assertExecutable(dockerPath, "Docker CLI");
  const inspected = inspectWorkerContainer(dockerPath, reference);
  if (!inspected) throw new Error(`Docker worker container ${reference.name} disappeared before it could be parked.`);

  if (inspected.state.Running) {
    try {
      execDocker(dockerPath, [
        "stop",
        "--signal", "SIGTERM",
        "--timeout", String(WORKER_CONTAINER_STOP_TIMEOUT_SECONDS),
        inspected.id
      ], 15_000);
    } catch {
      if (inspectWorkerContainer(dockerPath, reference)?.state.Running) {
        execDocker(dockerPath, ["kill", "--signal", "SIGKILL", inspected.id]);
      }
    }
  }
  if (inspectWorkerContainer(dockerPath, reference)?.state.Running) {
    execDocker(dockerPath, ["kill", "--signal", "SIGKILL", inspected.id]);
  }
  execDocker(dockerPath, ["wait", inspected.id]);
  const parked = inspectWorkerContainer(dockerPath, reference);
  if (!parked || parked.state.Running) {
    throw new Error(`Docker worker container ${reference.name} did not reach a verified stopped state.`);
  }
}

export function settleWorkerContainer(dockerPath: string, reference: WorkerContainerReference): void {
  assertWorkerContainerReference(reference);
  assertExecutable(dockerPath, "Docker CLI");
  if (!inspectWorkerContainer(dockerPath, reference)) return;
  parkWorkerContainer(dockerPath, reference);
  execDocker(dockerPath, ["rm", reference.containerId ?? reference.name]);
  if (inspectWorkerContainer(dockerPath, reference)) {
    throw new Error(`Docker worker container ${reference.name} still exists after removal.`);
  }
}

export function prepareWorkerContainerProcess(input: {
  dockerPath: string;
  container: WorkerContainerReference;
  jobId: string;
  cwd: string;
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): WorkerContainerProcess {
  assertWorkerContainerReference(input.container);
  assertExecutable(input.dockerPath, "Docker CLI");
  const cwd = realDirectory(input.cwd, "worker shell cwd");
  assertContainerPath(cwd, input.container);
  const config = {
    version: 1,
    dockerPath: path.resolve(input.dockerPath),
    container: input.container,
    jobId: input.jobId,
    cwd,
    executable: input.executable,
    args: [...input.args],
    env: buildWorkerContainerEnvironment(input.env, input.container.workspaceRoot)
  };
  return {
    executable: process.execPath,
    args: [resolveWorkerShellHostScript(), JSON.stringify(config)],
    env: input.env
  };
}

export function signalWorkerContainerJob(
  dockerPath: string,
  container: WorkerContainerReference,
  jobId: string,
  signal: NodeJS.Signals
): void {
  assertWorkerContainerReference(container);
  assertExecutable(dockerPath, "Docker CLI");
  if (!/^SIG[A-Z0-9]+$/.test(signal) || !/^job_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(jobId)) {
    throw new Error("Managed worker container cancellation identity is invalid.");
  }
  const controlDirectory = `/run/pi-jobs/${jobId}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      execDocker(dockerPath, [
        "exec", container.containerId ?? container.name,
        "/bin/sh", "-c",
        'pgid=$(cat "$1/pgid" 2>/dev/null) || exit 2; kill -"$2" -- "-$pgid" 2>/dev/null || test -f "$1/done"',
        "pi-worker-signal", controlDirectory, signal
      ], 5_000);
      return;
    } catch {
      sleep(20);
    }
  }
  throw new Error(`Unable to signal managed worker container job ${jobId}.`);
}

export function buildWorkerContainerEnvironment(
  source: NodeJS.ProcessEnv,
  workspaceRoot: string
): NodeJS.ProcessEnv {
  const root = path.resolve(workspaceRoot);
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    USER: "root",
    LOGNAME: "root",
    PATH: CONTAINER_PATH,
    SHELL: "/bin/bash",
    TMPDIR: path.join(root, "tmp"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "cache", "config"),
    XDG_DATA_HOME: path.join(root, "cache", "data"),
    XDG_STATE_HOME: path.join(root, "cache", "state"),
    npm_config_cache: path.join(root, "cache", "npm"),
    PIP_CACHE_DIR: path.join(root, "cache", "pip"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never"
  };
  for (const name of ["LANG", "TERM", "COLORTERM", "CI", "NO_COLOR", "FORCE_COLOR"]) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith("LC_") && value !== undefined) env[name] = value;
  }
  return env;
}

export function workerContainerFromEnvironment(): WorkerContainerReference | undefined {
  const raw = process.env.PI_WORKER_CONTAINER?.trim();
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Managed worker Docker identity is invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  assertWorkerContainerReference(value);
  return value;
}

export function resolveDockerPath(pathValue = process.env.PATH): string {
  for (const directory of (pathValue ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "docker");
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {}
  }
  throw new Error("Managed workers require the Docker CLI on PATH.");
}

function assertWorkerContainerImageAvailable(dockerPath: string, image: string): void {
  try {
    execDocker(dockerPath, ["image", "inspect", image]);
  } catch {
    throw new Error(`Required worker image is unavailable. Run: docker pull --platform linux/arm64 ${image}`);
  }
}

function waitForWorkerContainerReady(
  dockerPath: string,
  containerId: string,
  reference: WorkerContainerReference
): void {
  const deadline = Date.now() + WORKER_CONTAINER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const inspected = inspectWorkerContainer(dockerPath, { ...reference, containerId });
    if (!inspected) throw new Error(`Docker worker container ${reference.name} disappeared during startup.`);
    if (!inspected.state.Running) {
      const logs = dockerLogs(dockerPath, containerId);
      throw new Error(`Docker worker container exited during startup (${inspected.state.ExitCode ?? "unknown"}).${logs ? `\n${logs}` : ""}`);
    }
    try {
      execDocker(dockerPath, [
        "exec", containerId, "/bin/sh", "-c",
        `test "$(cat ${WORKER_CONTAINER_READY_FILE} 2>/dev/null)" = "$(cut -d ' ' -f 22 /proc/1/stat)"`
      ]);
      return;
    } catch {}
    sleep(100);
  }
  throw new Error(`Docker worker container ${reference.name} did not become ready within ${WORKER_CONTAINER_START_TIMEOUT_MS}ms.`);
}

function inspectWorkerContainer(
  dockerPath: string,
  reference: WorkerContainerReference
): { id: string; state: { Running: boolean; ExitCode?: number }; labels: Record<string, string> } | undefined {
  const target = reference.containerId ?? reference.name;
  let output: string;
  try {
    output = execDocker(dockerPath, ["container", "inspect", target]);
  } catch (cause) {
    if (isNoSuchDockerObject(cause)) return undefined;
    throw cause;
  }
  const values = JSON.parse(output) as Array<{
    Id?: unknown;
    State?: { Running?: unknown; ExitCode?: unknown };
    Config?: { Labels?: unknown };
  }>;
  const value = values[0];
  if (!value || typeof value.Id !== "string" || typeof value.State?.Running !== "boolean") {
    throw new Error(`Docker returned invalid inspection data for ${reference.name}.`);
  }
  const labels = value.Config?.Labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    throw new Error(`Docker worker container ${reference.name} has invalid labels.`);
  }
  const typedLabels = labels as Record<string, string>;
  if (
    typedLabels["pi.worker"] !== reference.workerId ||
    typedLabels["pi.run"] !== reference.runId ||
    typedLabels["pi.nonce"] !== reference.nonce ||
    (reference.containerId !== undefined && value.Id !== reference.containerId)
  ) {
    throw new Error(`Docker worker container identity mismatch for ${reference.workerId}/${reference.runId}.`);
  }
  return {
    id: value.Id,
    state: {
      Running: value.State.Running,
      ExitCode: typeof value.State.ExitCode === "number" ? value.State.ExitCode : undefined
    },
    labels: typedLabels
  };
}

function assertWorkerContainerReference(value: unknown): asserts value is WorkerContainerReference {
  const candidate = value as Partial<WorkerContainerReference> | undefined;
  if (
    candidate?.version !== WORKER_CONTAINER_VERSION ||
    typeof candidate.workerId !== "string" || !candidate.workerId ||
    typeof candidate.runId !== "string" || !candidate.runId ||
    typeof candidate.name !== "string" || !candidate.name ||
    typeof candidate.nonce !== "string" || !candidate.nonce ||
    typeof candidate.image !== "string" || !candidate.image ||
    typeof candidate.codeRoot !== "string" || !path.isAbsolute(candidate.codeRoot) ||
    typeof candidate.workspaceRoot !== "string" || !path.isAbsolute(candidate.workspaceRoot) ||
    (candidate.containerId !== undefined && !/^[a-f0-9]{64}$/.test(candidate.containerId))
  ) {
    throw new Error("Managed worker Docker identity is invalid.");
  }
}

function assertContainerPath(value: string, container: WorkerContainerReference): void {
  const resolved = path.resolve(value);
  const allowed = [container.workspaceRoot, container.codeRoot].some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)
  );
  if (!allowed) {
    throw new Error(`Managed worker shell cwd is not mounted in its Docker container: ${resolved}`);
  }
}

function bindMount(root: string, readonly: boolean): string {
  return `type=bind,src=${root},dst=${root},${readonly ? "readonly," : ""}bind-propagation=rprivate`;
}

function workerContainerName(workerId: string, runId: string): string {
  const value = `pi-${workerId}-${runId}`.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
  if (value.length <= 128) return value;
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${value.slice(0, 111)}-${suffix}`;
}

function resolveWorkerShellHostScript(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(current, "scripts", "worker-shell-host.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Worker shell host script is missing above ${fileURLToPath(import.meta.url)}.`);
    current = parent;
  }
}

function removeContainerByIdBestEffort(dockerPath: string, containerId: string): void {
  try { execDocker(dockerPath, ["rm", "--force", containerId], 15_000); } catch {}
}

function dockerLogs(dockerPath: string, containerId: string): string {
  try { return execDocker(dockerPath, ["logs", "--tail", "80", containerId]).trim(); } catch { return ""; }
}

function execDocker(dockerPath: string, args: string[], timeout = 30_000): string {
  try {
    return execFileSync(dockerPath, args, {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      timeout
    });
  } catch (cause) {
    const error = cause as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = typeof error.stderr === "string" ? error.stderr : error.stderr?.toString("utf8");
    const stdout = typeof error.stdout === "string" ? error.stdout : error.stdout?.toString("utf8");
    throw new Error([error.message, stderr?.trim(), stdout?.trim()].filter(Boolean).join("\n"));
  }
}

function isNoSuchDockerObject(cause: unknown): boolean {
  return cause instanceof Error && /no such (object|container)/i.test(cause.message);
}

function assertExecutable(filePath: string, label: string): void {
  const resolved = path.resolve(filePath);
  if (!statSync(resolved).isFile()) throw new Error(`${label} is not a file: ${resolved}`);
}

function realDirectory(value: string, label: string): string {
  const resolved = realpathSync(path.resolve(value));
  if (!statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  return resolved;
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
