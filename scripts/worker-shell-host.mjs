#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";

const rawConfig = process.argv[2];
if (!rawConfig) throw new Error("Usage: worker-shell-host.mjs <json-config>");
const config = JSON.parse(rawConfig);
validateConfig(config);
verifyContainerIdentity();

const controlDirectory = `/run/pi-jobs/${config.jobId}`;
const launchScript = buildLaunchScript();
const observerScript = [
  "set -eu",
  "control=$1",
  "payload=$2",
  "rm -rf -- \"$control\"",
  "umask 077",
  "mkdir -p -- \"$control\"",
  ": > \"$control/stdout\"",
  ": > \"$control/stderr\"",
  "printf '%s' \"$payload\" | base64 -d > \"$control/launch\"",
  "chmod 700 \"$control/launch\"",
  "touch \"$control/ready\"",
  "out=0",
  "err=0",
  "while :; do",
  "  out_size=$(wc -c < \"$control/stdout\")",
  "  if [ \"$out_size\" -gt \"$out\" ]; then",
  "    count=$((out_size - out))",
  "    dd if=\"$control/stdout\" bs=1 skip=\"$out\" count=\"$count\" 2>/dev/null",
  "    out=$out_size",
  "  fi",
  "  err_size=$(wc -c < \"$control/stderr\")",
  "  if [ \"$err_size\" -gt \"$err\" ]; then",
  "    count=$((err_size - err))",
  "    dd if=\"$control/stderr\" bs=1 skip=\"$err\" count=\"$count\" 1>&2 2>/dev/null",
  "    err=$err_size",
  "  fi",
  "  [ ! -f \"$control/done\" ] || break",
  "  sleep 0.05",
  "done",
  "out_size=$(wc -c < \"$control/stdout\")",
  "if [ \"$out_size\" -gt \"$out\" ]; then",
  "  count=$((out_size - out))",
  "  dd if=\"$control/stdout\" bs=1 skip=\"$out\" count=\"$count\" 2>/dev/null",
  "fi",
  "err_size=$(wc -c < \"$control/stderr\")",
  "if [ \"$err_size\" -gt \"$err\" ]; then",
  "  count=$((err_size - err))",
  "  dd if=\"$control/stderr\" bs=1 skip=\"$err\" count=\"$count\" 1>&2 2>/dev/null",
  "fi",
  "status=$(cat \"$control/exit-code\")",
  "exit \"$status\""
].join("\n");
const dockerArgs = [
  "exec",
  config.container.containerId,
  "/bin/sh", "-c", observerScript, "pi-worker-client", controlDirectory,
  Buffer.from(launchScript).toString("base64")
];
const dockerEnvironment = { ...process.env };

let cancellation;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    cancellation ??= signalContainerGroup(signal === "SIGHUP" ? "SIGTERM" : signal);
  });
}

const child = spawn(config.dockerPath, dockerArgs, {
  env: dockerEnvironment,
  stdio: ["ignore", "inherit", "inherit"]
});
const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
});
if (cancellation) await cancellation;
process.exitCode = result.signal ? signalExitCode(result.signal) : result.code ?? 1;

function buildLaunchScript() {
  const environment = Object.entries(config.env)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  const command = [config.executable, ...config.args].map(shellQuote).join(" ");
  return [
    "#!/bin/sh",
    "set +e",
    `if ! cd -- ${shellQuote(config.cwd)}; then`,
    `  printf '%s\\n' ${shellQuote(`Unable to enter worker command cwd: ${config.cwd}`)} > ${shellQuote(`${controlDirectory}/stderr`)}`,
    `  printf '1\\n' > ${shellQuote(`${controlDirectory}/exit-code`)}`,
    `  touch ${shellQuote(`${controlDirectory}/done`)}`,
    "  exit 0",
    "fi",
    `setsid env -i ${environment} ${command} > ${shellQuote(`${controlDirectory}/stdout`)} 2> ${shellQuote(`${controlDirectory}/stderr`)} &`,
    "pgid=$!",
    `printf '%s\\n' \"$pgid\" > ${shellQuote(`${controlDirectory}/pgid`)}`,
    "wait \"$pgid\"",
    "status=$?",
    "while kill -0 -- \"-$pgid\" 2>/dev/null; do sleep 0.1; done",
    `printf '%s\\n' \"$status\" > ${shellQuote(`${controlDirectory}/exit-code`)}`,
    `touch ${shellQuote(`${controlDirectory}/done`)}`
  ].join("\n");
}

async function signalContainerGroup(signal) {
  const pgid = readContainerPgid();
  if (pgid === undefined) return;
  spawnSync(config.dockerPath, [
    "exec", config.container.containerId,
    "/bin/sh", "-c", 'kill -"$1" -- "-$2" 2>/dev/null || true',
    "pi-worker-signal", signal, String(pgid)
  ], {
    env: dockerEnvironment,
    stdio: "ignore",
    timeout: 5_000
  });
}

function readContainerPgid() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = spawnSync(config.dockerPath, [
      "exec", config.container.containerId,
      "cat", `${controlDirectory}/pgid`
    ], {
      encoding: "utf8",
      env: dockerEnvironment,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000
    });
    if (result.status === 0) {
      const value = Number.parseInt(result.stdout.trim(), 10);
      if (Number.isInteger(value) && value > 1) return value;
    }
    sleep(20);
  }
  return undefined;
}

function verifyContainerIdentity() {
  const result = spawnSync(config.dockerPath, ["container", "inspect", config.container.containerId], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000
  });
  if (result.status !== 0) {
    throw new Error(`Unable to inspect managed worker container: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  const inspected = JSON.parse(result.stdout)[0];
  const labels = inspected?.Config?.Labels;
  if (
    inspected?.Id !== config.container.containerId ||
    labels?.["pi.worker"] !== config.container.workerId ||
    labels?.["pi.run"] !== config.container.runId ||
    labels?.["pi.nonce"] !== config.container.nonce ||
    inspected?.State?.Running !== true
  ) {
    throw new Error(`Managed worker container identity mismatch for ${config.container.workerId}/${config.container.runId}.`);
  }
}

function validateConfig(value) {
  if (
    value?.version !== 1 ||
    typeof value.dockerPath !== "string" || !value.dockerPath.startsWith("/") ||
    typeof value.jobId !== "string" || !/^job_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.jobId) ||
    typeof value.cwd !== "string" || !value.cwd.startsWith("/") ||
    typeof value.executable !== "string" || !value.executable.startsWith("/") ||
    !Array.isArray(value.args) || value.args.some((entry) => typeof entry !== "string") ||
    !value.env || typeof value.env !== "object" || Array.isArray(value.env) ||
    Object.entries(value.env).some(([name, entry]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof entry !== "string") ||
    value.container?.version !== 1 ||
    typeof value.container.containerId !== "string" || !/^[a-f0-9]{64}$/.test(value.container.containerId) ||
    typeof value.container.workerId !== "string" ||
    typeof value.container.runId !== "string" ||
    typeof value.container.nonce !== "string"
  ) {
    throw new Error("Invalid managed worker shell host configuration.");
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function signalExitCode(signal) {
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 };
  return 128 + (numbers[signal] ?? 1);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
