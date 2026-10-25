import { readFileSync } from "node:fs";
import { deleteCleanupLeftover, type CleanupLeftover } from "../../extensions/worker/cleanup.js";
import { openWorkerRegistry } from "../../extensions/worker/registry.js";
import type { WorkerRoots } from "../../extensions/worker/identity.js";

const [runtimeRoot, inputFile] = process.argv.slice(2);
if (!runtimeRoot || !inputFile) throw new Error("usage: cleanup-leftover-crash <runtimeRoot> <inputFile>");
const input = JSON.parse(readFileSync(inputFile, "utf8")) as { item: CleanupLeftover; roots: WorkerRoots; preparedRoot: string; projectCwd: string; now: string };
const registry = openWorkerRegistry(runtimeRoot);
await deleteCleanupLeftover(registry, input.item, {
  roots: input.roots,
  preparedRoot: input.preparedRoot,
  projectCwd: input.projectCwd,
  now: new Date(input.now),
  afterLeftoverClaim: () => process.exit(73)
});
throw new Error("cleanup crash fixture did not exit at the claim boundary");
