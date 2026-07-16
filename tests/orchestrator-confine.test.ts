import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { assertPathWithinRoot, createAllowedRootExtension, resolveToolPath } from "../extensions/orchestrator/confine.js";

test("path confinement accepts existing and new paths inside root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orch-confine-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "existing.ts"), "export {};\n", "utf8");
    assert.equal(await assertPathWithinRoot(root, root, "src/existing.ts"), path.join(root, "src", "existing.ts"));
    assert.equal(await assertPathWithinRoot(root, root, "src/new.ts"), path.join(root, "src", "new.ts"));
    assert.equal(resolveToolPath(root, "@src/new.ts"), path.join(root, "src", "new.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("path confinement rejects traversal, absolute escapes, and symlink escapes", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "pi-orch-confine-escape-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, path.join(root, "escape"));
    await assert.rejects(() => assertPathWithinRoot(root, root, "../outside/file.ts"), /escapes allowed root/);
    await assert.rejects(() => assertPathWithinRoot(root, root, path.join(outside, "file.ts")), /escapes allowed root/);
    await assert.rejects(() => assertPathWithinRoot(root, root, "escape/file.ts"), /symlink outside allowed root/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("allowed-root extension blocks escaping write_many calls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-orch-confine-hook-"));
  let handler: ((event: ToolCallEvent) => Promise<unknown>) | undefined;
  const api = {
    on(event: string, callback: (event: ToolCallEvent) => Promise<unknown>): void {
      if (event === "tool_call") handler = callback;
    }
  } as unknown as ExtensionAPI;
  const recordedBlocks: Array<{ toolName: string; reason: string }> = [];
  createAllowedRootExtension(root, (toolName, reason) => recordedBlocks.push({ toolName, reason }), ["shell_start", "shell_read"])(api);
  assert.ok(handler);
  try {
    const allowed = await handler!({ type: "tool_call", toolCallId: "1", toolName: "write_many", input: { writes: [{ path: "inside.ts", content: "ok" }] } } as ToolCallEvent);
    assert.equal(allowed, undefined);
    const blocked = await handler!({ type: "tool_call", toolCallId: "2", toolName: "write_many", input: { writes: [{ path: "../outside.ts", content: "bad" }] } } as ToolCallEvent) as { block: boolean; reason: string };
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /escapes allowed root/);
    const unsupported = await handler!({ type: "tool_call", toolCallId: "3", toolName: "web_fetch_many", input: { urls: [] } } as ToolCallEvent) as { block: boolean; reason: string };
    assert.equal(unsupported.block, true);
    assert.match(unsupported.reason, /not permitted in a confined writer session/);
    const shellStart = await handler!({ type: "tool_call", toolCallId: "4", toolName: "shell_start", input: { commands: [{ command: "npm test", cwd: root }] } } as ToolCallEvent);
    assert.equal(shellStart, undefined, "configured shell tools pass through to tool-safety's judged policy");
    const shellStatus = await handler!({ type: "tool_call", toolCallId: "5", toolName: "shell_status", input: {} } as ToolCallEvent) as { block: boolean; reason: string };
    assert.equal(shellStatus.block, true, "tools outside the passthrough list stay blocked");
    assert.deepEqual(recordedBlocks.map((entry) => entry.toolName), ["write_many", "web_fetch_many", "shell_status"]);
    assert.match(recordedBlocks[0].reason, /escapes allowed root/);
    assert.match(recordedBlocks[1].reason, /not permitted in a confined writer session/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
