#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const manifestPath = process.env.PI_WORKER_SANDBOX_LAUNCH_MANIFEST;
if (!manifestPath) throw new Error("PI_WORKER_SANDBOX_LAUNCH_MANIFEST is required.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest?.version !== 1 || manifest?.sandbox?.kind !== "docker-sandbox") throw new Error("Invalid Worker Sandbox launch manifest.");
if (!/^pi-[a-zA-Z0-9_-]{1,96}$/.test(manifest.sandbox.sandboxName)) throw new Error("Invalid Worker Sandbox name.");
if (typeof manifest.sbxPath !== "string" || !manifest.sbxPath.startsWith("/")) throw new Error("Invalid sbx executable path.");
if (typeof manifest.sandbox.rpcLauncher !== "string" || !manifest.sandbox.rpcLauncher.startsWith("/")) throw new Error("Invalid guest RPC launcher path.");
const rpcArgs = process.argv.slice(2);
if (rpcArgs[0] !== "--mode" || rpcArgs[1] !== "rpc") throw new Error("Worker Sandbox shim accepts Pi RPC mode only.");
const environment = Object.entries(manifest.guestEnvironment ?? {}).map(([key, value]) => {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || typeof value !== "string" || value.includes("\0")) throw new Error("Invalid Worker Sandbox guest environment.");
  return `${key}=${value}`;
});
const child = spawn(manifest.sbxPath, ["exec", manifest.sandbox.sandboxName, "env", ...environment, manifest.sandbox.rpcLauncher, ...rpcArgs], { stdio: ["inherit", "inherit", "inherit"] });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.once("error", (error) => { console.error(`Worker Sandbox exec failed: ${error.message}`); process.exit(1); });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
