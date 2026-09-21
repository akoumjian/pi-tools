export const WORKER_ID_PATTERN = "^worker_[0-9]{14}_[a-zA-Z0-9-]{8}$";

const workerIdPattern = new RegExp(WORKER_ID_PATTERN);

export function isWorkerId(value: unknown): value is string {
  return typeof value === "string" && workerIdPattern.test(value);
}
