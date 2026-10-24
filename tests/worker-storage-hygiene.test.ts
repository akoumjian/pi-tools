import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertWorkerStoragePaths, snapshotAdditionalInputs } from "../extensions/worker/index.js";
import { provisionWorkerPaths, workerPaths } from "../extensions/worker/identity.js";

test("worker skeleton recreates missing ordinary directories but rejects symlink and file replacements", async () => {
 const root=await mkdtemp(path.join(tmpdir(),"worker-storage-")); try { const roots={stateRoot:path.join(root,"state"),workspaceRoot:path.join(root,"work"),supervisionRoot:path.join(root,"supervision")}; const paths=workerPaths(roots,"worker_20260101000000_aaaaaaaa"); provisionWorkerPaths(paths); await rm(paths.scratchDir,{recursive:true}); assertWorkerStoragePaths(paths); assert.equal((await lstat(paths.scratchDir)).isDirectory(),true); await rm(paths.artifactsDir,{recursive:true}); await symlink(paths.tempDir,paths.artifactsDir); assert.throws(()=>assertWorkerStoragePaths(paths),/symbolic|ordinary|beneath/i); await rm(paths.artifactsDir); await writeFile(paths.artifactsDir,"not a directory"); assert.throws(()=>assertWorkerStoragePaths(paths),/ordinary directory/i); } finally { await rm(root,{recursive:true,force:true}); }
});

test("additional inputs become bounded immutable collision-free supervision snapshots", async () => {
 const root=await mkdtemp(path.join(tmpdir(),"worker-inputs-")); try { const left=path.join(root,"left"),right=path.join(root,"right"),evidence=path.join(root,"supervision","inputs"); await mkdir(left); await mkdir(right); const a=path.join(left,"same.txt"),b=path.join(right,"same.txt"); await writeFile(a,"one"); await writeFile(b,"two"); const snapshots=snapshotAdditionalInputs(evidence,[logical(a),logical(b)]); assert.notEqual(snapshots[0]!.mountedPath,snapshots[1]!.mountedPath); await writeFile(a,"changed"); assert.equal(await readFile(snapshots[0]!.mountedPath,"utf8"),"one"); assert.equal((await lstat(snapshots[0]!.mountedPath)).mode & 0o777,0o400); const nested=path.join(left,"nested"); await mkdir(nested); await symlink(b,path.join(nested,"link")); assert.throws(()=>snapshotAdditionalInputs(evidence,[{...logical(nested),type:"directory"}]),/symbolic links/); } finally { await chmod(root,0o700).catch(()=>{}); await rm(root,{recursive:true,force:true}); }
});
function logical(source:string){return {source,target:source,sourcePath:source,mountedPath:source,type:"file" as const};}
