import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { advanceCleanupScanCursor, buildCleanupInventory, loadCleanupScanCursor, type CleanupScanState } from "../../extensions/worker/cleanup.js";
import { openWorkerRegistry } from "../../extensions/worker/registry.js";

const count=Number(process.argv[2]);
if(!Number.isSafeInteger(count)||count<1)throw new Error("usage: cleanup-scan-stress <positive-directory-count>");
const root=realpathSync(mkdtempSync(path.join(tmpdir(),`pi-cleanup-scan-${count}-`))),runtimeRoot=path.join(root,"runtime"),workersRoot=path.join(runtimeRoot,"workers"),preparedRoot=path.join(root,"prepared"),jobsRoot=path.join(root,"project",".pi","async-shell","jobs"),parent=path.join(root,"parent.jsonl");
mkdirSync(workersRoot,{recursive:true});mkdirSync(preparedRoot,{recursive:true});mkdirSync(jobsRoot,{recursive:true});writeFileSync(parent,"");
const started=Date.now(),old=new Date("2025-01-01T00:00:00.000Z"),expected=new Set<string>();
try{
 for(let index=0;index<count;index+=1)mkdirSync(path.join(workersRoot,`ordinary-${index.toString().padStart(9,"0")}`));
 for(let index=0;index<50;index+=1){const workerId=`worker_20250101000000_${index.toString(16).padStart(8,"0")}`,directory=path.join(workersRoot,workerId);mkdirSync(directory);utimesSync(directory,old,old);expected.add(directory);}
 const registry=openWorkerRegistry(runtimeRoot);try{let cursor:string|undefined,state:CleanupScanState|undefined,pages=0,examined=0;const reached=new Set<string>();do{const inventory=await buildCleanupInventory(registry,{parentSessionFile:parent,allSessions:true,cwd:path.join(root,"project"),roots:{stateRoot:workersRoot,workspaceRoot:workersRoot},preparedRoot,limit:100,offset:0,scanState:state,now:new Date("2026-10-25T10:00:00.000Z")});pages+=1;examined+=inventory.scan.examinedFilesystemEntries;if(pages%5===0)console.error(JSON.stringify({progress:{count,pages,examined,position:inventory.scan.roots[0]?.position}}));for(const item of inventory.leftovers)if(expected.has(item.path))reached.add(item.path);assert.ok(inventory.scan.roots.every((entry)=>entry.examined<=5000),"every root page must remain independently bounded");const next=advanceCleanupScanCursor(registry,parent,cursor,inventory.scan.continuation,new Date().toISOString());if(!inventory.scan.partial){assert.equal(next,undefined);cursor=undefined;break;}assert.ok(next,"partial inventory must persist a continuation");cursor=next;state=loadCleanupScanCursor(registry,parent,cursor);assert.ok(pages<=Math.ceil((count+50)/5000)+4,"cursor failed to make eventual progress");}while(true);assert.equal(reached.size,expected.size,`only ${reached.size}/${expected.size} late leftovers were reachable`);console.log(JSON.stringify({count,leftovers:reached.size,pages,examined,durationMs:Date.now()-started,cursorExhausted:cursor===undefined}));}finally{registry.close();}
}finally{if(existsSync(root))rmSync(root,{recursive:true,force:true});}
