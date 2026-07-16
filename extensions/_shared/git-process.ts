import { spawn } from "node:child_process";

export type ProcessResult = { stdout: string; stderr: string; code: number };
export type GitCommandOptions = { allowFailure?: boolean; timeoutMs?: number };

export async function gitCommand(cwd: string, args: string[], options: GitCommandOptions = {}): Promise<ProcessResult> {
  const result = await runProcess("git", args, cwd, options.timeoutMs ?? 15_000);
  if (options.allowFailure !== true && result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}) in ${cwd}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`);
  }
  return result;
}

export async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) stderr += `${stderr ? "\n" : ""}process timed out after ${timeoutMs}ms`;
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}
