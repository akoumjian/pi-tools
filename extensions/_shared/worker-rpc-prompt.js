export async function checkedWorkerPrompt(rpcClient, message, options = {}) {
  if (typeof rpcClient?.send !== "function") throw new Error("Worker RPC client cannot issue a checked prompt.");
  const response = await rpcClient.send({ type: "prompt", message, ...options });
  if (response?.type !== "response" || response.command !== "prompt") throw new Error("Worker RPC returned an invalid prompt response.");
  if (response.success !== true) throw new Error(typeof response.error === "string" && response.error ? response.error : "Worker RPC prompt was rejected.");
}

export async function requestBoundedInjectedWorkerPrompt(rpcClient, message) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await checkedWorkerPrompt(rpcClient, message, { streamingBehavior: "followUp" });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/Agent is already processing/i.test(error.message)) throw error;
      const state = await rpcClient.getState();
      if (state.isStreaming || state.isCompacting || state.pendingMessageCount !== 0) return;
      if (attempt === 1) throw error;
    }
  }
}
