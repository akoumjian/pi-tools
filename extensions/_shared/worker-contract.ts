export const MAX_WORKER_TASK_IDS = 32;

export function workerResultAdmissionPath(resultFile: string): string {
  return `${resultFile}.admitting`;
}

export function workerMutationAdmissionPath(authorizationFile: string): string {
  return `${authorizationFile}.mutating`;
}
