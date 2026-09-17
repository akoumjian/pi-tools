import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  asyncJobTokenProcessIds,
  isAsyncJobExecutionAlive,
  isAsyncJobProcessAlive,
  isAsyncJobProcessGroupAlive
} from "./async-job-process.js";

export { asyncJobTokenProcessIds, isAsyncJobExecutionAlive, isAsyncJobProcessAlive, isAsyncJobProcessGroupAlive };

export type SpawnAsyncJobProcessInput = {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutLog: string;
  stderrLog: string;
};

export function spawnAsyncJobProcess(input: SpawnAsyncJobProcessInput): ChildProcess {
  mkdirSync(path.dirname(input.stdoutLog), { recursive: true });
  mkdirSync(path.dirname(input.stderrLog), { recursive: true });
  const stdoutFd = openSync(input.stdoutLog, "a", 0o600);
  const stderrFd = openSync(input.stderrLog, "a", 0o600);
  try {
    return spawn(input.executable, input.args, {
      cwd: path.resolve(input.cwd),
      env: input.env,
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd]
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

export function createAsyncJobId(now = new Date(), random: string = randomUUID()): string {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `job_${timestamp}_${random.slice(0, 8)}`;
}

export function asyncJobOutputBytes(stdoutLog: string, stderrLog: string): { stdout: number; stderr: number } {
  return {
    stdout: fileSize(stdoutLog),
    stderr: fileSize(stderrLog)
  };
}

export function signalAsyncJobProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) throw new Error("Cannot signal an async job without a process id.");
  try {
    process.kill(-pid, signal);
  } catch (groupError) {
    try {
      process.kill(pid, signal);
    } catch {
      throw groupError;
    }
  }
}

export function signalAsyncJobExecution(
  pid: number | undefined,
  token: string | undefined,
  signal: NodeJS.Signals
): void {
  if (token) {
    const ownedPids = asyncJobTokenProcessIds(token);
    for (const ownedPid of ownedPids) {
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
    signalAsyncJobProcessGroup(pid, signal);
  } catch {
    if (isAsyncJobProcessGroupAlive(pid)) throw new Error(`Unable to signal async job process group ${pid}.`);
  }
}

function fileSize(filePath: string): number {
  return existsSync(filePath) ? statSync(filePath).size : 0;
}
