import type { ChildProcess } from "node:child_process";
import { withFileMutationQueue, type ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

const DEFAULT_ABORT_MESSAGE = "Operation aborted";
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;

export type AbortScope = {
  signal: AbortSignal;
  dispose: () => void;
};

export function createAbortError(message = DEFAULT_ABORT_MESSAGE): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function abortErrorFromSignal(signal: AbortSignal | undefined, message = DEFAULT_ABORT_MESSAGE): Error {
  return signal?.reason instanceof Error ? signal.reason : createAbortError(message);
}

export function throwIfAborted(signal: AbortSignal | undefined, message = DEFAULT_ABORT_MESSAGE): void {
  if (signal?.aborted) {
    throw abortErrorFromSignal(signal, message);
  }
}

export function createAbortScope(parent: AbortSignal | undefined, timeoutMs: number | undefined): AbortScope {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(abortErrorFromSignal(parent));
  const timeout = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        const error = new Error(`Operation timed out after ${timeoutMs}ms`);
        error.name = "TimeoutError";
        controller.abort(error);
      }, timeoutMs);
  timeout?.unref();

  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      parent?.removeEventListener("abort", abortFromParent);
    }
  };
}

export async function settleAllOrThrow<T>(
  promises: Iterable<PromiseLike<T>>,
  signal?: AbortSignal
): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected === undefined) {
    return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
  }
  throwIfAborted(signal);
  throw rejected.reason;
}

export function withAbortableFileMutationQueue<T>(
  filePath: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  throwIfAborted(signal);
  if (signal === undefined) {
    return withFileMutationQueue(filePath, run);
  }

  let acquired = false;
  const queued = withFileMutationQueue(filePath, async () => {
    acquired = true;
    throwIfAborted(signal);
    return run();
  });

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const abort = (): void => {
      if (!acquired) {
        settle(() => reject(abortErrorFromSignal(signal)));
      }
    };

    signal.addEventListener("abort", abort, { once: true });
    void queued.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    );
    if (signal.aborted) {
      abort();
    }
  });
}

export function abortableDialogOptions(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): ExtensionUIDialogOptions | undefined {
  if (signal === undefined && timeoutMs === undefined) {
    return undefined;
  }
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs })
  };
}

export function terminateProcessOnAbort(
  child: ChildProcess,
  signal: AbortSignal | undefined,
  options: { processGroup?: boolean; graceMs?: number } = {}
): () => void {
  if (signal === undefined) {
    return () => {};
  }

  let killTimer: NodeJS.Timeout | undefined;
  let disposed = false;
  const sendSignal = (processSignal: NodeJS.Signals): void => {
    if (options.processGroup === true && child.pid !== undefined) {
      try {
        process.kill(-child.pid, processSignal);
        return;
      } catch {
        // Fall back to the direct child when no detached process group exists.
      }
    }
    try {
      child.kill(processSignal);
    } catch {
      // The process may have exited between the abort and signal delivery.
    }
  };
  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", abort);
    child.removeListener("close", cleanup);
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
  };
  const abort = (): void => {
    if (disposed) return;
    sendSignal("SIGTERM");
    killTimer = setTimeout(() => sendSignal("SIGKILL"), options.graceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS);
    killTimer.unref();
  };

  child.once("close", cleanup);
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }

  return cleanup;
}
