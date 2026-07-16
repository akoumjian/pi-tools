import { access, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";

export function createAllowedRootExtension(
  allowedRoot: string,
  onBlocked?: (toolName: string, reason: string) => void,
  passthroughTools: string[] = []
): ExtensionFactory {
  const root = path.resolve(allowedRoot);
  const passthrough = new Set(passthroughTools);
  return (api) => {
    api.on("tool_call", async (event) => {
      // Passthrough tools (for example async-shell) are deliberately governed
      // by tool-safety's judged policy instead of this deterministic guard.
      if (passthrough.has(event.toolName)) return undefined;
      try {
        const paths = toolPaths(event);
        for (const rawPath of paths) await assertPathWithinRoot(root, root, rawPath);
        return undefined;
      } catch (error) {
        const reason = `Orchestrator confinement blocked ${event.toolName}: ${error instanceof Error ? error.message : String(error)}`;
        onBlocked?.(event.toolName, reason);
        return { block: true, reason };
      }
    });
  };
}

export async function assertPathWithinRoot(allowedRoot: string, cwd: string, rawPath: string): Promise<string> {
  const root = path.resolve(allowedRoot);
  const rootReal = await realpath(root);
  const candidate = resolveToolPath(cwd, rawPath);
  assertInsideOrEqual(candidate, root, `Path escapes allowed root ${root}: ${candidate}`);

  const existingAncestor = await nearestExistingAncestor(candidate);
  const ancestorReal = await realpath(existingAncestor);
  assertInsideOrEqual(ancestorReal, rootReal, `Path traverses a symlink outside allowed root ${root}: ${candidate}`);

  if (await pathExists(candidate)) {
    const candidateReal = await realpath(candidate);
    assertInsideOrEqual(candidateReal, rootReal, `Resolved path escapes allowed root ${root}: ${candidateReal}`);
  }
  return candidate;
}

export function resolveToolPath(cwd: string, rawPath: string): string {
  const normalized = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const expanded = normalized === "~"
    ? homedir()
    : normalized.startsWith("~/")
      ? path.join(homedir(), normalized.slice(2))
      : normalized;
  return path.resolve(cwd, expanded);
}

function toolPaths(event: ToolCallEvent): string[] {
  const input = event.input as Record<string, unknown>;
  if (event.toolName === "write_many") return itemPaths(input.writes);
  if (event.toolName === "edit_many") return itemPaths(input.files);
  if (event.toolName === "read_many") return itemPaths(input.files);
  if (event.toolName === "search_many") {
    if (!Array.isArray(input.searches)) throw new Error("search_many searches must be an array.");
    return input.searches.map((item) => {
      if (!isRecord(item)) throw new Error("search_many item must be an object.");
      return typeof item.path === "string" && item.path.trim() ? item.path : ".";
    });
  }
  throw new Error(`tool ${event.toolName} is not permitted in a confined writer session.`);
}

function itemPaths(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("tool path items must be an array.");
  return value.map((item) => {
    if (!isRecord(item) || typeof item.path !== "string" || !item.path.trim()) {
      throw new Error("tool item requires a non-empty path.");
    }
    return item.path;
  });
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing ancestor found for ${candidate}.`);
    current = parent;
  }
}

function assertInsideOrEqual(candidate: string, root: string, message: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(message);
}

async function pathExists(candidate: string): Promise<boolean> {
  try { await access(candidate); return true; } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
