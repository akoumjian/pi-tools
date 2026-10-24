#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const manifestPath = process.env.PI_WORKER_SANDBOX_LAUNCH_MANIFEST;
if (!manifestPath) throw new Error("PI_WORKER_SANDBOX_LAUNCH_MANIFEST is required.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest?.version !== 1 || manifest?.sandbox?.kind !== "docker-sandbox") throw new Error("Invalid Worker Sandbox launch manifest.");
if (!/^pi-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(manifest.sandbox.sandboxName)) throw new Error("Invalid Worker Sandbox name.");
if (typeof manifest.sbxPath !== "string" || !path.isAbsolute(manifest.sbxPath)) throw new Error("Invalid sbx executable path.");
if (typeof manifest.sandbox.rpcLauncher !== "string" || !path.posix.isAbsolute(manifest.sandbox.rpcLauncher)) throw new Error("Invalid guest RPC launcher path.");
if (typeof manifest.sandbox.workingDirectory !== "string" || !path.isAbsolute(manifest.sandbox.workingDirectory)) throw new Error("Invalid exact guest working directory.");
const rpcArgs = process.argv.slice(2); if (rpcArgs[0] !== "--mode" || rpcArgs[1] !== "rpc") throw new Error("Worker Sandbox shim accepts Pi RPC mode only.");
const environment = Object.entries(manifest.guestEnvironment ?? {}).map(([key, value]) => { if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || typeof value !== "string" || value.includes("\0")) throw new Error("Invalid Worker Sandbox guest environment."); return `${key}=${value}`; });
const child = spawn(manifest.sbxPath, ["exec", "--workdir", manifest.sandbox.workingDirectory, manifest.sandbox.sandboxName, "env", ...environment, manifest.sandbox.rpcLauncher, ...rpcArgs], { stdio: ["inherit", "inherit", "inherit"] });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.once("error", (error) => { console.error(`Worker Sandbox exec failed: ${error.message}`); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = signal ? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[signal] ?? 1) : code ?? 1; });
