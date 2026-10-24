import { createHash, randomUUID } from "node:crypto";
import { asyncJobProcessStartToken } from "../../extensions/_shared/async-job.js";
import { claimWorkerRun, openWorkerRegistry, registerParentRuntimeAndRecoverClaims, retireParentRuntime } from "../../extensions/worker/registry.js";

const [runtimeRoot, parentSessionFile, workerId, runId, claimKind, mode = "hold"] = process.argv.slice(2);
if (!runtimeRoot || !parentSessionFile || !workerId || !runId || !["launch", "settlement"].includes(claimKind ?? "")) throw new Error("invalid lifecycle-owner fixture arguments");
const processStartToken = asyncJobProcessStartToken(process.pid);
if (!processStartToken) throw new Error("fixture could not read its process start token");
const registry = openWorkerRegistry(runtimeRoot);
const runtimeId = `child-${process.pid}-${randomUUID()}`;
const generation = registerParentRuntimeAndRecoverClaims(registry, parentSessionFile, runtimeId, new Date().toISOString(), () => true, { pid: process.pid, processStartToken });
const claimNonce = `${generation}-${process.pid}-${createHash("sha256").update(processStartToken).digest("hex")}-${randomUUID()}`;
const claimed = claimWorkerRun(registry, workerId, runId, claimKind as "launch" | "settlement", claimNonce, claimKind === "launch" ? ["queued"] : ["running"], generation);
if (!claimed) throw new Error(`fixture could not claim ${workerId}/${runId} for ${claimKind}`);
process.send?.({ event: "claimed", generation, runtimeId, claimNonce });
if (mode === "retire") {
  retireParentRuntime(registry, parentSessionFile, runtimeId, new Date().toISOString());
  process.send?.({ event: "retired" });
  setImmediate(() => process.exit(0));
} else {
  process.on("disconnect", () => process.exit(0));
  setInterval(() => {}, 1_000).unref();
}
