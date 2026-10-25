import assert from "node:assert/strict";
import test from "node:test";
import { checkedWorkerPrompt, requestBoundedInjectedWorkerPrompt } from "../extensions/_shared/worker-rpc-prompt.js";

test("checked worker prompt preserves exact rejection causes", async () => {
  await assert.rejects(() => checkedWorkerPrompt({ send: async () => ({ type: "response", command: "prompt", success: false, error: "exact rejection" }) }, "initial"), /exact rejection/);
});

test("bounded injected prompt treats a busy active turn as its one opportunity", async () => {
  const commands: any[] = []; const client = {
    send: async (command: any) => { commands.push(command); return { type: "response", command: "prompt", success: false, error: "Agent is already processing a request" }; },
    getState: async () => ({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 })
  };
  await requestBoundedInjectedWorkerPrompt(client, "repair");
  assert.equal(commands.length, 1); assert.equal(commands[0].streamingBehavior, "followUp");
});

test("bounded injected prompt retries one rejected idle race without duplicate acceptance", async () => {
  const commands: any[] = []; const client = {
    send: async (command: any) => { commands.push(command); return commands.length === 1
      ? { type: "response", command: "prompt", success: false, error: "Agent is already processing a request" }
      : { type: "response", command: "prompt", success: true }; },
    getState: async () => ({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 })
  };
  await requestBoundedInjectedWorkerPrompt(client, "follow up"); assert.equal(commands.length, 2);
});
