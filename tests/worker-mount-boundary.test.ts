import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * Production-shaped kernel proof for the mount ordering used by sbx: a writable
 * guest bind is installed first and an exact descendant is then over-mounted
 * read-only. The CI worker may lack user/mount namespaces; that capability is
 * reported as a skip rather than replacing the required final-Kit sbx probe.
 */
test("Linux nested bind keeps approved run inputs read-only beneath a writable guest mount", (t) => {
  if (process.platform !== "linux") { t.skip("Linux mount namespaces are required"); return; }
  if (!existsSync("/usr/bin/unshare") || !existsSync("/usr/bin/mount")) { t.skip("unshare and mount are unavailable"); return; }
  const root=mkdtempSync(path.join(tmpdir(),"pi-worker-nested-mount-"));
  try {
    const guest=path.join(root,"source","guest"),runInput=path.join(guest,"run-inputs","run_test"),view=path.join(root,"view");
    mkdirSync(path.join(guest,"workspace"),{recursive:true});mkdirSync(runInput,{recursive:true});mkdirSync(view,{recursive:true});writeFileSync(path.join(runInput,"context.json"),"trusted\n",{mode:0o400});chmodSync(runInput,0o700);
    const script=String.raw`set -eu
mount --make-rprivate /
mount --bind "$1" "$3"
mount --bind "$2" "$3/run-inputs/run_test"
mount -o remount,bind,ro "$3/run-inputs/run_test"
printf 'guest-write\n' > "$3/workspace/allowed.txt"
if printf 'mutated\n' > "$3/run-inputs/run_test/context.json" 2>/dev/null; then exit 41; fi
if mkdir "$3/run-inputs/run_test/new-entry" 2>/dev/null; then exit 42; fi
awk -v target="$3/run-inputs/run_test" '$5==target && $6 ~ /(^|,)ro(,|$)/ { found=1 } END { exit(found?0:43) }' /proc/self/mountinfo
printf 'nested-ro-ok\n'`;
    const probe=spawnSync("/usr/bin/unshare",["--user","--map-root-user","--mount","/bin/sh","-ceu",script,"nested-mount-probe",guest,runInput,view],{encoding:"utf8",timeout:15_000});
    const diagnostic=`${probe.stderr??""}\n${probe.stdout??""}`;
    if (probe.status!==0&&/unshare failed|operation not permitted|permission denied/i.test(diagnostic)) { t.skip(`mount namespace capability unavailable: ${diagnostic.trim().split("\n")[0]??"denied"}`); return; }
    assert.equal(probe.status,0,`nested read-only mount probe failed (${probe.status}/${probe.signal}): ${diagnostic}`);
    assert.match(probe.stdout,/nested-ro-ok/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
