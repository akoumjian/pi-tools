export type WorkerHostJobFormat = "sandbox" | "legacy";

export type WorkerHostManagedIdentity = {
  kind: "worker-host";
  workerId: string;
  runId: string;
};

export type WorkerHostJobIdentity = {
  workerId: string;
  runId: string;
  format: WorkerHostJobFormat;
  command: string;
  managedBy: WorkerHostManagedIdentity;
};

const WORKER_ID_SOURCE = "worker_[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const RUN_ID_SOURCE = "run_[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const WORKER_ID = new RegExp(`^${WORKER_ID_SOURCE}$`);
const RUN_ID = new RegExp(`^${RUN_ID_SOURCE}$`);
const SANDBOX_COMMAND = new RegExp(`^Pi Sandbox worker host (${WORKER_ID_SOURCE})/(${RUN_ID_SOURCE})$`);
const LEGACY_COMMAND = new RegExp(`^Pi worker host (${WORKER_ID_SOURCE})/(${RUN_ID_SOURCE})$`);

/** Construct the exact current Sandbox identity, or the exact retained legacy identity for compatibility tests/readers. */
export function workerHostJobIdentity(workerId: string, runId: string, format: WorkerHostJobFormat = "sandbox"): WorkerHostJobIdentity {
  if (!WORKER_ID.test(workerId) || !RUN_ID.test(runId)) throw new Error("Invalid worker-host job identity.");
  return {
    workerId,
    runId,
    format,
    command: format === "sandbox" ? `Pi Sandbox worker host ${workerId}/${runId}` : `Pi worker host ${workerId}/${runId}`,
    managedBy: { kind: "worker-host", workerId, runId }
  };
}

/**
 * Match only an exact current or legacy command. If managedBy is present it must
 * be the exact three-field worker-host identity bound to the same IDs. A
 * managedBy-only value is accepted so ordinary retention can conservatively
 * protect trusted worker-host markers even when command text is unavailable.
 */
export function matchWorkerHostJobIdentity(
  value: unknown,
  expected?: { workerId: string; runId: string }
): WorkerHostJobIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const command = value.command;
  if (typeof command !== "string") return undefined;
  const sandbox = SANDBOX_COMMAND.exec(command);
  const legacy = sandbox ? null : LEGACY_COMMAND.exec(command);
  const matched = sandbox ?? legacy;
  if (!matched) return undefined;
  let workerId: string | undefined = matched[1];
  let runId: string | undefined = matched[2];
  const format: WorkerHostJobFormat = sandbox ? "sandbox" : "legacy";
  if (value.managedBy !== undefined) {
    const managedBy = value.managedBy;
    if (!isRecord(managedBy) || Object.keys(managedBy).sort().join("\0") !== "kind\0runId\0workerId" || managedBy.kind !== "worker-host" || typeof managedBy.workerId !== "string" || typeof managedBy.runId !== "string") return undefined;
    if (workerId !== undefined && (managedBy.workerId !== workerId || managedBy.runId !== runId)) return undefined;
    workerId = managedBy.workerId;
    runId = managedBy.runId;
  }
  if (workerId === undefined || runId === undefined || !WORKER_ID.test(workerId) || !RUN_ID.test(runId)) return undefined;
  if (expected && (expected.workerId !== workerId || expected.runId !== runId)) return undefined;
  return workerHostJobIdentity(workerId, runId, format);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
