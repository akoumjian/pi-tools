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
const guest = ["env", ...environment, manifest.sandbox.rpcLauncher, ...rpcArgs];
const overlay = manifest.sandbox.reviewOverlay;
const command = overlay === undefined ? ordinaryWorkerLaunchCommand(guest) : reviewOverlayLaunchCommand(overlay, guest);
const execArgs = ["exec", "--user", "root", "--workdir", manifest.sandbox.workingDirectory, manifest.sandbox.sandboxName, ...command];
const child = spawn(manifest.sbxPath, execArgs, { stdio: ["inherit", "inherit", "inherit"] });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.once("error", (error) => { console.error(`Worker Sandbox exec failed: ${error.message}`); process.exitCode = 1; });
child.once("exit", (code, signal) => { process.exitCode = signal ? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[signal] ?? 1) : code ?? 1; });

function ordinaryWorkerLaunchCommand(guest) {
  const script = String.raw`set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset BASH_ENV ENV
root=$1
shift
test "$(id -u)" = 0
test "$root" = /run/pi-worker
rm -rf "$root"
mkdir -p "$root"
chown 1000:1000 "$root"
chmod 0700 "$root"
test "$(stat -c "%u:%g:%a" "$root")" = 1000:1000:700
test -x /usr/bin/setpriv
exec /usr/bin/setpriv --reuid=1000 --regid=1000 --init-groups -- /bin/sh -ceu '
root=$1
shift
test "$(id -u)" = 1000
test "$(id -g)" = 1000
test "$(stat -c "%u:%g:%a" "$root")" = 1000:1000:700
exec "$@"
' pi-worker-agent-launch "$root" "$@"`;
  return ["/usr/bin/env", "-u", "BASH_ENV", "-u", "ENV", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "/bin/sh", "-ceu", script, "pi-worker-runtime-launch", "/run/pi-worker", ...guest];
}

function reviewOverlayLaunchCommand(value, guest) {
  if (value?.version !== 1 || !/^[a-f0-9]{64}$/.test(value.setupEvidenceSha256 ?? "") || value.mergedDirectory !== "/review/subject") throw new Error("Invalid review OverlayFS launch evidence.");
  if (![value.lowerDirectory, value.scratchDirectory, value.upperDirectory, value.workDirectory].every((entry) => typeof entry === "string" && path.posix.isAbsolute(entry) && path.posix.normalize(entry) === entry)) throw new Error("Invalid review OverlayFS launch paths.");
  if (/[\u0000-\u0020,:\\]/.test(value.lowerDirectory)) throw new Error("Unsafe review OverlayFS lower path.");
  if (!/^\/run\/pi-worker\/review-overlays\/[a-f0-9]{24}$/.test(value.scratchDirectory) || value.upperDirectory !== `${value.scratchDirectory}/upper` || value.workDirectory !== `${value.scratchDirectory}/work`) throw new Error("Invalid exact review OverlayFS launch paths.");
  const script = String.raw`set -eu
lower=$1
upper=$2
work=$3
merged=$4
shift 4
test "$(id -u)" = 0
options=$(awk -v merged="$merged" '$2 == merged && $3 == "overlay" { count += 1; options = $4 } END { if (count != 1) exit 70; print options }' /proc/mounts)
case ",$options," in *",lowerdir=$lower,"*) ;; *) exit 71 ;; esac
case ",$options," in *",upperdir=$upper,"*) ;; *) exit 72 ;; esac
case ",$options," in *",workdir=$work,"*) ;; *) exit 73 ;; esac
test -d "$lower" -a -d "$upper" -a -d "$work" -a -d "$merged"
exec "$@"`;
  return ["/bin/sh", "-ceu", script, "pi-review-overlay-launch", value.lowerDirectory, value.upperDirectory, value.workDirectory, value.mergedDirectory, ...guest];
}
