import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultWorkerRoots, defaultWorkerRuntimeRoot } from "../extensions/worker/identity.js";
import { countWorkers, createWorkerAndRun, openWorkerRegistry, type WorkerRunRecord } from "../extensions/worker/registry.js";

function digestTree(root:string):string{const hash=createHash("sha256");const visit=(current:string)=>{for(const name of readdirSync(current).sort()){const value=path.join(current,name),metadata=lstatSync(value);hash.update(path.relative(root,value));hash.update("\0");hash.update(String(metadata.mode&0o777));hash.update("\0");if(metadata.isDirectory())visit(value);else{assert.equal(metadata.isFile(),true);hash.update(readFileSync(value));hash.update("\0");}}};visit(root);return hash.digest("hex");}
function settledRun(workerId:string,runId:string):WorkerRunRecord{return{runId,workerId,status:"settled",taskIds:["personal-archive"],completionDelivery:"steer",repositories:[],artifacts:[],errors:[],outcome:"completed",outcomeSource:"worker",createdAt:"2026-01-01T00:00:00.000Z",settledAt:"2026-01-01T00:00:01.000Z"};}

test("default managed-worker root is one fixed fresh sibling version and derives guest-host workers there",()=>{const home=mkdtempSync(path.join(tmpdir(),"pi-worker-root-home-"));try{const runtime=defaultWorkerRuntimeRoot(home),roots=defaultWorkerRoots(home);assert.equal(runtime,path.join(home,".local","share","agent","worker-runtime-v10"));assert.equal(roots.stateRoot,path.join(runtime,"workers"));assert.equal(roots.workspaceRoot,roots.stateRoot);assert.equal(path.dirname(runtime),path.join(home,".local","share","agent"));assert.notEqual(path.basename(runtime),"worker-runtime");assert.equal(existsSync(runtime),false,"deriving the fixed root during package load/install must be inert");}finally{rmSync(home,{recursive:true,force:true});}});

test("fresh versioned root neither reads nor imports a byte from the retained legacy sibling",()=>{const home=mkdtempSync(path.join(tmpdir(),"pi-worker-root-isolation-")),agent=path.join(home,".local","share","agent"),legacy=path.join(agent,"worker-runtime"),current=defaultWorkerRuntimeRoot(home),parent=path.join(home,"legacy-parent.jsonl"),workerId="worker_20260101000000_archive1",runId="run_20260101000000_archive1";mkdirSync(agent,{recursive:true});let oldRegistry:ReturnType<typeof openWorkerRegistry>|undefined,newRegistry:ReturnType<typeof openWorkerRegistry>|undefined;try{oldRegistry=openWorkerRegistry(legacy);createWorkerAndRun(oldRegistry,{workerId,parentSessionFile:parent,role:"work",status:"idle",latestRunId:runId,taskIds:["personal-archive"],workspaceRoot:path.join(legacy,"workers",workerId,"guest","workspace"),createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:01.000Z"},settledRun(workerId,runId));oldRegistry.close();oldRegistry=undefined;writeFileSync(path.join(legacy,"archive-sentinel"),"legacy archive must remain untouched\n");const before=digestTree(legacy);chmodSync(legacy,0o000);newRegistry=openWorkerRegistry(current,{strictCurrentRoot:true});assert.deepEqual(countWorkers(newRegistry,parent),{idle:0,queued:0,running:0});newRegistry.close();newRegistry=undefined;chmodSync(legacy,0o700);assert.equal(digestTree(legacy),before);oldRegistry=openWorkerRegistry(legacy);assert.ok(oldRegistry.database.prepare("SELECT 1 FROM workers WHERE worker_id=?").get(workerId),"legacy worker remains only in the archive registry");assert.equal(oldRegistry.database.prepare("SELECT 1 FROM workers WHERE worker_id=?").get("worker_20260101000000_current1"),undefined);}finally{try{chmodSync(legacy,0o700);}catch{}oldRegistry?.close();newRegistry?.close();rmSync(home,{recursive:true,force:true});}});

test("old and new Pi processes can coexist only in isolated sibling registries",()=>{const home=mkdtempSync(path.join(tmpdir(),"pi-worker-root-coexist-")),agent=path.join(home,".local","share","agent"),legacy=path.join(agent,"worker-runtime"),current=defaultWorkerRuntimeRoot(home);mkdirSync(agent,{recursive:true});const oldRegistry=openWorkerRegistry(legacy),newRegistry=openWorkerRegistry(current,{strictCurrentRoot:true});try{oldRegistry.database.prepare("INSERT INTO registry_meta(key,value) VALUES('isolation_probe','old')").run();newRegistry.database.prepare("INSERT INTO registry_meta(key,value) VALUES('isolation_probe','new')").run();assert.equal((oldRegistry.database.prepare("SELECT value FROM registry_meta WHERE key='isolation_probe'").get() as {value:string}).value,"old");assert.equal((newRegistry.database.prepare("SELECT value FROM registry_meta WHERE key='isolation_probe'").get() as {value:string}).value,"new");assert.notEqual(oldRegistry.databasePath,newRegistry.databasePath);}finally{oldRegistry.close();newRegistry.close();rmSync(home,{recursive:true,force:true});}});


test("concurrent first openers converge on the one exclusively initialized current registry", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "pi-worker-root-concurrent-"));
  const runtimeRoot = defaultWorkerRuntimeRoot(home);
  const registryModule = new URL("../extensions/worker/registry.js", import.meta.url).href;
  const script = `import { openWorkerRegistry } from ${JSON.stringify(registryModule)}; const registry = openWorkerRegistry(process.argv[1], { strictCurrentRoot: true }); registry.close();`;
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", script, runtimeRoot], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, stderr }));
    })));
    assert.deepEqual(results.map(({ code }) => code), Array(12).fill(0), results.map(({ stderr }) => stderr).join("\n"));
    const registry = openWorkerRegistry(runtimeRoot, { strictCurrentRoot: true });
    try { assert.equal(countWorkers(registry, path.join(home, "parent.jsonl")).idle, 0); }
    finally { registry.close(); }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
