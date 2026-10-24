import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isAsyncJobExecutionAlive } from "./async-job-process.js";

export const PI_TOOLS_MODULE_FINGERPRINT = "8f0425ce94d41954b06da147ed8983a91a5a55431fd7bf6da3e193d17003d8fb";

const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PROCESS_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_STATUSES = new Set(["running", "exited", "failed", "cancelled", "unknown"]);
const TERMINAL_JOB_STATUSES = new Set(["exited", "failed", "cancelled"]);

/**
 * Strictly parse one trusted-host worker async-job record. Both worker_result_submit
 * admission and worker-host settlement use this exact validator so malformed
 * metadata cannot fall through different checks.
 *
 * @param {string} jobsDirectory
 * @param {string} jobId
 * @returns {Record<string, any>}
 */
export function readStrictWorkerJobMeta(jobsDirectory, jobId) {
  const expectedLogDir = path.join(path.resolve(jobsDirectory), jobId);
  const metaFile = path.join(expectedLogDir, "meta.json");
  if (!existsSync(metaFile)) {
    throw new Error(`Worker async-shell job ${jobId} has no metadata; handoff cannot verify quiescence.`);
  }

  let meta;
  try {
    meta = JSON.parse(readFileSync(metaFile, "utf8"));
  } catch {
    throw invalidMetadata(jobId);
  }

  if (
    !isObject(meta?.owner) ||
    meta.owner.kind !== "worker-run" ||
    typeof meta.owner.workerId !== "string" ||
    !OWNER_ID_PATTERN.test(meta.owner.workerId) ||
    typeof meta.owner.runId !== "string" ||
    !OWNER_ID_PATTERN.test(meta.owner.runId)
  ) {
    throw new Error(`Worker async-shell job ${jobId} has unverifiable ownership metadata; handoff cannot verify quiescence.`);
  }

  const hasProcessIdentity = Number.isInteger(meta.pid) && meta.pid > 0 && meta.pid <= 2_147_483_647;
  const failedBeforeSpawn =
    meta.pid === undefined &&
    meta.status === "failed" &&
    typeof meta.error === "string" && meta.error.trim() !== "" &&
    typeof meta.endedAt === "string" && meta.endedAt.trim() !== "";
  const valid =
    meta.jobId === jobId &&
    typeof meta.command === "string" && meta.command.trim() !== "" &&
    typeof meta.cwd === "string" && path.isAbsolute(meta.cwd) &&
    typeof meta.shell === "string" && meta.shell.trim() !== "" &&
    (hasProcessIdentity || failedBeforeSpawn) &&
    typeof meta.processToken === "string" && PROCESS_TOKEN_PATTERN.test(meta.processToken) &&
    typeof meta.notifyOnExit === "boolean" &&
    typeof meta.completionNotified === "boolean" &&
    typeof meta.status === "string" && JOB_STATUSES.has(meta.status) &&
    isExactPhysicalPath(meta.logDir, expectedLogDir) &&
    isExactPhysicalPath(meta.stdoutLog, path.join(expectedLogDir, "stdout.log")) &&
    isExactPhysicalPath(meta.stderrLog, path.join(expectedLogDir, "stderr.log"));
  if (!valid) throw invalidMetadata(jobId);
  return meta;
}

/** @param {Record<string, any>} meta */
export function workerJobIsSettled(meta) {
  if (!TERMINAL_JOB_STATUSES.has(meta.status)) return false;
  if (meta.notifyOnExit && !meta.completionNotified) return false;
  return !isAsyncJobExecutionAlive(meta.pid, meta.processToken);
}

function invalidMetadata(jobId) {
  return new Error(`Worker async-shell job ${jobId} has invalid metadata; handoff cannot verify quiescence.`);
}

function isExactPhysicalPath(candidate, expected) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) return false;
  try {
    return realpathSync(candidate) === realpathSync(expected);
  } catch {
    return false;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
