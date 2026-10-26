import { readFileSync } from "node:fs";
import { adoptCleanupWorkers, type CleanupSnapshotWorker } from "../../extensions/worker/cleanup.js";
import { openWorkerRegistry } from "../../extensions/worker/registry.js";

const [runtimeRoot,parentSessionFile,snapshotFile]=process.argv.slice(2);
if(!runtimeRoot||!parentSessionFile||!snapshotFile)throw new Error("invalid cleanup-crash fixture arguments");
const snapshots=JSON.parse(readFileSync(snapshotFile,"utf8")) as CleanupSnapshotWorker[];
if(snapshots.length!==1)throw new Error("cleanup-crash fixture requires one exact worker");
const registry=openWorkerRegistry(runtimeRoot),nonce=`0-crash-${process.pid}`;
adoptCleanupWorkers(registry,{snapshots,newParentSessionFile:parentSessionFile,claimWorkerIds:[snapshots[0]!.item.workerId],nonce,now:new Date().toISOString(),pendingAcknowledged:new Set(),claimedAcknowledged:new Set(),recoveryAcknowledged:new Set(),consent:{token:`cleanup_${"c".repeat(48)}`,snapshotHash:"d".repeat(64),openTaskAbandonmentAcknowledged:[snapshots[0]!.item.workerId],artifactLossAcknowledged:[],pendingDeliveryTakeoverAcknowledged:[],claimedDeliveryTakeoverAcknowledged:[],recoveryAcknowledged:[]},ownerAuthority:(owner)=>snapshots.find((item)=>item.item.ownerSession===owner)?.authority??{state:"missing"}});
registry.close();process.send?.({event:"adopted",nonce});
