import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

export function asyncJobTokenProcessIds(token) {
  if (!token) return [];
  if (process.platform === "linux") {
    const marker = `PI_WORKER_JOB_TOKEN=${token}`;
    let entries;
    try { entries = readdirSync("/proc", { withFileTypes: true }); }
    catch (cause) { throw new Error(`Unable to enumerate async-job ownership tokens: ${cause instanceof Error ? cause.message : String(cause)}`); }
    return entries.flatMap((entry) => {
      if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) return [];
      try {
        const environment = readFileSync(`/proc/${entry.name}/environ`, "utf8").split("\0");
        return environment.includes(marker) ? [Number(entry.name)] : [];
      } catch { return []; }
    });
  }
  if (process.platform !== "darwin") return [];
  let output;
  try {
    output = execFileSync("/bin/ps", ["eww", "-axo", "pid=,command="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024
    });
  } catch (cause) {
    throw new Error(`Unable to enumerate async-job ownership tokens: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const marker = `PI_WORKER_JOB_TOKEN=${token}`;
  return output.split("\n").flatMap((line) => {
    if (!line.includes(marker)) return [];
    const pid = Number.parseInt(line.trimStart().split(/\s+/, 1)[0] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? [pid] : [];
  });
}

export function asyncJobProcessStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      return startTicks ? `linux:${startTicks}` : undefined;
    } catch { return undefined; }
  }
  try {
    const started = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024
    }).trim();
    return started ? `${process.platform}:${started}` : undefined;
  } catch { return undefined; }
}

export function captureAsyncJobProcessIdentity(pid, processToken) {
  const processStartToken = asyncJobProcessStartToken(pid);
  if (!processToken || !processStartToken || !asyncJobTokenProcessIds(processToken).includes(pid)) {
    throw new Error(`Unable to capture exact async-job process identity for ${pid}.`);
  }
  return { pid, processToken, processStartToken };
}

export function probeAsyncJobProcessIdentity(identity, probes = {}) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0 || typeof identity.processToken !== "string" || !identity.processToken || typeof identity.processStartToken !== "string" || !identity.processStartToken) return "dead";
  const probePid = probes.probePid ?? probeAsyncJobPid;
  const readStartToken = probes.readStartToken ?? asyncJobProcessStartToken;
  const ownedProcessIds = probes.ownedProcessIds ?? asyncJobTokenProcessIds;
  const before = probePid(identity.pid);
  if (before === "dead") return "dead";
  // Permission ambiguity is not identity ambiguity when the immutable start
  // token is still observable. Compare it before deciding whether this exact
  // process requires recovery so a reused cross-user PID cannot pin a job.
  let processStartToken;
  try { processStartToken = readStartToken(identity.pid); }
  catch { return probePid(identity.pid) === "dead" ? "dead" : "unknown"; }
  if (!processStartToken) return probePid(identity.pid) === "dead" ? "dead" : "unknown";
  if (processStartToken !== identity.processStartToken) return "dead";
  let processIds;
  try { processIds = ownedProcessIds(identity.processToken); }
  catch { return probePid(identity.pid) === "dead" ? "dead" : "unknown"; }
  if (processIds.includes(identity.pid)) return "alive";
  return "dead";
}

export function isAsyncJobProcessIdentityAlive(identity) {
  return probeAsyncJobProcessIdentity(identity) === "alive";
}

function probeAsyncJobPid(pid) {
  try { process.kill(pid, 0); return "alive"; }
  catch (error) { return error && typeof error === "object" && error.code === "ESRCH" ? "dead" : "unknown"; }
}

export function isAsyncJobExecutionAlive(pid, token) {
  if (!token) return isAsyncJobProcessGroupAlive(pid);
  try { return asyncJobTokenProcessIds(token).length > 0; }
  catch { return true; }
}

export function isAsyncJobProcessGroupAlive(pid) {
  if (pid === undefined) return false;
  try { process.kill(-pid, 0); return true; }
  catch { return isAsyncJobProcessAlive(pid); }
}

export function signalAsyncJobExecution(pid, token, signal) {
  if (token) {
    for (const ownedPid of asyncJobTokenProcessIds(token)) {
      try {
        process.kill(ownedPid, signal);
      } catch {
        if (isAsyncJobProcessAlive(ownedPid)) throw new Error(`Unable to signal async job descendant ${ownedPid}.`);
      }
    }
    return;
  }
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (groupError) {
    try {
      process.kill(pid, signal);
    } catch {
      if (isAsyncJobProcessGroupAlive(pid)) throw groupError;
    }
  }
}

export function isAsyncJobProcessAlive(pid) {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
