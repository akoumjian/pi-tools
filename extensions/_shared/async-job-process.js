import { execFileSync } from "node:child_process";

export function asyncJobTokenProcessIds(token) {
  if (!token || process.platform !== "darwin") return [];
  let output;
  try {
    output = execFileSync("/bin/ps", ["eww", "-axo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024
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

export function isAsyncJobExecutionAlive(pid, token) {
  if (!token) return isAsyncJobProcessGroupAlive(pid);
  try {
    return asyncJobTokenProcessIds(token).length > 0;
  } catch {
    return true;
  }
}

export function isAsyncJobProcessGroupAlive(pid) {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return isAsyncJobProcessAlive(pid);
  }
}

export function isAsyncJobProcessAlive(pid) {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
