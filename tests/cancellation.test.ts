import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  abortableDialogOptions,
  createAbortScope,
  settleAllOrThrow,
  throwIfAborted,
  withAbortableFileMutationQueue
} from "../extensions/_shared/cancellation.js";
import { withChildAgentSession } from "../extensions/_shared/child-agent-session.js";

test("shared cancellation helpers preserve the parent abort reason", () => {
  const controller = new AbortController();
  const parentError = new Error("parent interrupted");
  parentError.name = "AbortError";
  const scope = createAbortScope(controller.signal, 10_000);

  controller.abort(parentError);

  assert.equal(scope.signal.aborted, true);
  assert.equal(scope.signal.reason, parentError);
  assert.throws(() => throwIfAborted(scope.signal), (error: unknown) => error === parentError);
  scope.dispose();
});

test("abortable dialog options compose signal and timeout without inventing either", () => {
  const signal = new AbortController().signal;
  assert.equal(abortableDialogOptions(undefined, undefined), undefined);
  assert.deepEqual(abortableDialogOptions(undefined, 5_000), { timeout: 5_000 });
  assert.deepEqual(abortableDialogOptions(signal, undefined), { signal });
  assert.deepEqual(abortableDialogOptions(signal, 5_000), { signal, timeout: 5_000 });
});

test("settleAllOrThrow waits for every started operation before surfacing the first input-order error", async () => {
  const events: string[] = [];
  const first = Promise.reject(new Error("first failed"));
  const second = new Promise<string>((resolve) => {
    setTimeout(() => {
      events.push("second settled");
      resolve("ok");
    }, 20);
  });

  await assert.rejects(settleAllOrThrow([first, second]), /first failed/);
  assert.deepEqual(events, ["second settled"]);

  const completedController = new AbortController();
  completedController.abort();
  assert.deepEqual(await settleAllOrThrow([Promise.resolve("committed")], completedController.signal), ["committed"]);
});

test("an acquired mutation queue waits for an in-flight commit before settling interruption", async () => {
  const controller = new AbortController();
  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => {
    markAcquired = resolve;
  });
  let finishCommit!: () => void;
  const commitFinished = new Promise<void>((resolve) => {
    finishCommit = resolve;
  });
  let committed = false;

  const operation = withAbortableFileMutationQueue("/virtual/acquired-queue", controller.signal, async () => {
    markAcquired();
    await commitFinished;
    committed = true;
    return "done";
  });
  await acquired;
  controller.abort();

  const beforeCommit = await Promise.race([
    operation.then(() => "settled"),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20))
  ]);
  assert.equal(beforeCommit, "pending");
  assert.equal(committed, false);

  finishCommit();
  assert.equal(await operation, "done");
  assert.equal(committed, true);
});

test("child sessions fail before loading resources when the parent is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let ran = false;

  await assert.rejects(
    withChildAgentSession(
      {} as Pick<ExtensionContext, "modelRegistry" | "ui">,
      {
        cwd: "/repo",
        model: {} as never,
        thinkingLevel: "off",
        tools: [],
        signal: controller.signal
      },
      async () => {
        ran = true;
      }
    ),
    { name: "AbortError" }
  );
  assert.equal(ran, false);
});
