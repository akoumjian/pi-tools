import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MANAGED_WORKER_TOOL_NAMES,
  createWorkerCacheLineageRuntime,
  prepareWorkerCacheLineage,
  registerParentCacheLineageCapture,
  summarizeWorkerCacheLineage
} from "../extensions/worker/cache-lineage.js";
import {
  WORKER_RECORD_VERSION,
  provisionWorkerPaths,
  workerPaths,
  writeWorkerRecord
} from "../extensions/worker/state.js";

const parentSessionFile = "/trusted/sessions/parent.jsonl";
const parentSessionId = "parent-local-session";
const inheritedAffinity = "parent-cache-affinity";
const route = { provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "xhigh" };

function codexContext(overrides: Record<string, unknown> = {}): ExtensionContext {
  return {
    model: {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api"
    },
    thinkingLevel: "xhigh",
    sessionManager: {
      getSessionFile: () => parentSessionFile,
      getSessionId: () => parentSessionId
    },
    ...overrides
  } as unknown as ExtensionContext;
}

function functionTool(name: string): Record<string, unknown> {
  return {
    type: "function",
    name,
    description: `Trusted ${name} implementation`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: null
  };
}

function parentPayload(): Record<string, unknown> {
  return {
    model: route.model,
    store: false,
    stream: true,
    instructions: "EXACT PARENT INSTRUCTIONS",
    input: [{ role: "user", content: [{ type: "input_text", text: "stable parent prefix" }] }],
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: parentSessionId,
    tool_choice: "auto",
    parallel_tool_calls: true,
    tools: [functionTool("parent_only"), functionTool("shell_start")],
    reasoning: { effort: "xhigh", summary: "auto" }
  };
}

function workerPayload(prefix = true): Record<string, unknown> {
  const parentInput = parentPayload().input as unknown[];
  return {
    model: route.model,
    store: false,
    stream: true,
    instructions: "WORKER INSTRUCTIONS THAT MUST NOT REPLACE THE PREFIX",
    input: [
      ...(prefix ? parentInput : [{ role: "user", content: [{ type: "input_text", text: "drift" }] }]),
      { role: "assistant", content: [{ type: "output_text", text: "parent completion" }] },
      { role: "user", content: [{ type: "input_text", text: "worker assignment" }] }
    ],
    tools: MANAGED_WORKER_TOOL_NAMES.map(functionTool),
    reasoning: { effort: "xhigh", summary: "auto" },
    tool_choice: "auto",
    parallel_tool_calls: true
  };
}

function captureAndPrepare(root: string, exposeSessionHeader = true) {
  const handlers = new Map<string, Array<(event: any, context: ExtensionContext) => unknown>>();
  const api = {
    on(event: string, handler: (event: any, context: ExtensionContext) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }
  } as unknown as ExtensionAPI;
  registerParentCacheLineageCapture(api, root, () => new Date("2026-09-24T12:00:00.000Z"));
  const context = codexContext();
  handlers.get("before_provider_request")![0]!({ payload: parentPayload() }, context);
  const headers: Record<string, string> = {
    Authorization: "secret-never-persisted",
    "x-client-request-id": "parent-request",
    ...(exposeSessionHeader ? { "session-id": inheritedAffinity } : {})
  };
  handlers.get("before_provider_headers")![0]!({ headers }, context);
  const workerStateDir = path.join(root, "worker-one");
  const record = prepareWorkerCacheLineage({
    stateRoot: root,
    workerStateDir,
    parentSessionFile,
    parentSessionId,
    route,
    marker: "fork_marker_1234",
    now: new Date("2026-09-24T12:00:01.000Z")
  });
  assert.equal(record.mode, "eligible");
  return record;
}

test("Codex lineage capture persists only the payload and effective cache-affinity header", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-capture-"));
  try {
    const record = captureAndPrepare(root);
    assert.equal(record.mode, "eligible");
    const snapshot = readFileSync(record.snapshotFile, "utf8");
    assert.match(snapshot, /parent-cache-affinity/);
    assert.doesNotMatch(snapshot, /secret-never-persisted/);
    assert.doesNotMatch(snapshot, /parent-request/);
    assert.doesNotMatch(snapshot, /Authorization/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("Codex lineage derives the provider-final session-id when Pi's pre-provider hook does not expose it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-effective-header-"));
  try {
    const record = captureAndPrepare(root, false);
    assert.equal(record.mode, "eligible");
    const runtime = createWorkerCacheLineageRuntime(record);
    try {
      runtime.transformPayload(workerPayload(), codexContext());
      const headers: Record<string, string> = { "session-id": "child-local" };
      runtime.transformHeaders(headers, codexContext());
      assert.equal(headers["session-id"], parentSessionId);
    } finally {
      runtime.restoreNetwork();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex lineage restores the exact parent prefix and appends only managed-worker authority", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-transform-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    const transformed = runtime.transformPayload(workerPayload(), codexContext()) as Record<string, any>;
    const parent = parentPayload();
    assert.equal(transformed.instructions, parent.instructions);
    assert.deepEqual(transformed.reasoning, parent.reasoning);
    assert.deepEqual(transformed.tools, parent.tools);
    assert.deepEqual(transformed.input.slice(0, 1), parent.input);
    assert.deepEqual(transformed.input[1], (workerPayload().input as unknown[])[1]);
    assert.equal(transformed.input[2].type, "additional_tools");
    assert.deepEqual(
      transformed.input[2].tools.map((tool: Record<string, unknown>) => tool.name),
      MANAGED_WORKER_TOOL_NAMES.filter((name) => name !== "shell_start")
    );
    assert.match(transformed.input[3].content[0].text, /fork_marker_1234/);
    assert.deepEqual(
      transformed.tool_choice.tools.map((tool: Record<string, unknown>) => tool.name),
      MANAGED_WORKER_TOOL_NAMES
    );
    assert.equal(transformed.previous_response_id, undefined);
    assert.equal(runtime.status().mode, "adopted");
    assert.equal(record.mode, "eligible");
    assert.equal(existsSync(record.adoptionFile), true);
    assert.deepEqual(summarizeWorkerCacheLineage(record), { mode: "adopted" });

    const headers: Record<string, string> = {
      "session-id": "child-local-session",
      "x-client-request-id": "child-request-id"
    };
    runtime.transformHeaders(headers, codexContext());
    assert.equal(headers["session-id"], inheritedAffinity);
    assert.equal(headers["x-client-request-id"], "child-request-id");

    assert.equal(runtime.guardTool("shell_start"), undefined);
    assert.deepEqual(runtime.guardTool("worker_run"), {
      block: true,
      reason: "Managed worker tool worker_run is not authorized by the worker runtime allowlist.",
      terminate: true
    });
  } finally {
    runtime?.restoreNetwork();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex lineage falls back only before adoption, then fails closed on drift", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-fallback-"));
  let freshRuntime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  let adoptedRuntime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const firstRecord = captureAndPrepare(root);
    freshRuntime = createWorkerCacheLineageRuntime(firstRecord);
    const original = workerPayload(false);
    assert.deepEqual(freshRuntime.transformPayload(original, codexContext()), original);
    assert.equal(freshRuntime.status().mode, "fresh");
    assert.equal(firstRecord.mode, "eligible");
    assert.equal(existsSync(firstRecord.fallbackFile), true);
    assert.deepEqual(summarizeWorkerCacheLineage(firstRecord), {
      mode: "fresh",
      reason: "Worker Codex input does not preserve the exact captured parent prefix."
    });
    freshRuntime.restoreNetwork();
    freshRuntime = createWorkerCacheLineageRuntime(firstRecord);
    assert.equal(freshRuntime.status().mode, "fresh", "fallback remains stable across worker process resumes");
    freshRuntime.restoreNetwork();
    freshRuntime = undefined;

    rmSync(firstRecord.adoptionFile, { force: true });
    rmSync(firstRecord.fallbackFile, { force: true });
    const secondRecord = captureAndPrepare(root);
    adoptedRuntime = createWorkerCacheLineageRuntime(secondRecord);
    adoptedRuntime.transformPayload(workerPayload(), codexContext());
    const drifted = codexContext({
      model: { provider: "openai-codex", id: "other-model", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }
    });
    const blocked = adoptedRuntime.transformPayload(workerPayload(), drifted) as Record<string, unknown>;
    assert.match(String(blocked.model), /^pi-cache-lineage-blocked-/);
    assert.equal(adoptedRuntime.status().mode, "failed");
  } finally {
    freshRuntime?.restoreNetwork();
    adoptedRuntime?.restoreNetwork();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex lineage fails closed when managed-worker schemas drift after adoption", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-schema-drift-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    runtime.transformPayload(workerPayload(), codexContext());
    const drifted = workerPayload();
    const tools = drifted.tools as Array<Record<string, unknown>>;
    tools[0] = { ...tools[0], description: "drifted schema" };
    const blocked = runtime.transformPayload(drifted, codexContext()) as Record<string, unknown>;
    assert.match(String(blocked.model), /^pi-cache-lineage-blocked-/);
    assert.deepEqual(runtime.status(), {
      mode: "failed",
      reason: "Managed-worker tool schemas drifted after Codex lineage adoption."
    });
  } finally {
    runtime?.restoreNetwork();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex lineage snapshot and persisted adoption are integrity checked", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-integrity-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    runtime.transformPayload(workerPayload(), codexContext());
    runtime.restoreNetwork();
    runtime = undefined;

    writeFileSync(record.snapshotFile, `${readFileSync(record.snapshotFile, "utf8")} `);
    assert.throws(() => createWorkerCacheLineageRuntime(record), /snapshot digest mismatch/);
  } finally {
    runtime?.restoreNetwork();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported routes truthfully retain the fresh-worker path", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-route-"));
  try {
    const record = prepareWorkerCacheLineage({
      stateRoot: root,
      workerStateDir: path.join(root, "worker"),
      parentSessionFile,
      parentSessionId,
      route: { provider: "anthropic", model: "claude-opus-5-5", thinkingLevel: "xhigh" },
      marker: "fork_marker_1234"
    });
    assert.deepEqual(record, {
      version: 1,
      mode: "fresh",
      reason: "Cache-lineage proof is limited to the openai-codex provider."
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex lineage rewrites only final transport cache affinity and preserves request identity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-transport-"));
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let fetchedHeaders: Headers | undefined;
  let websocketHeaders: Record<string, string> | undefined;
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly url: string;
    constructor(url: string | URL, options?: { headers?: Record<string, string> }) {
      this.url = url.toString();
      websocketHeaders = options?.headers;
    }
  }
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchedHeaders = new Headers(init?.headers);
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket;
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    runtime.transformPayload(workerPayload(), codexContext());
    const stagedHeaders: Record<string, string> = {
      "session-id": "child-local",
      "x-client-request-id": "child-request"
    };
    runtime.transformHeaders(stagedHeaders, codexContext());

    await globalThis.fetch("https://chatgpt.com/backend-api/codex/responses", {
      headers: {
        "session-id": "provider-overwrite",
        "x-client-request-id": "child-request"
      }
    });
    assert.equal(fetchedHeaders?.get("session-id"), inheritedAffinity);
    assert.equal(fetchedHeaders?.get("x-client-request-id"), "child-request");

    new globalThis.WebSocket("wss://chatgpt.com/backend-api/codex/responses", {
      headers: {
        "session-id": "provider-overwrite",
        "x-client-request-id": "child-websocket-request"
      }
    } as unknown as string[]);
    assert.equal(new Headers(websocketHeaders).get("session-id"), inheritedAffinity);
    assert.equal(new Headers(websocketHeaders).get("x-client-request-id"), "child-websocket-request");
  } finally {
    runtime?.restoreNetwork();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    rmSync(root, { recursive: true, force: true });
  }
});


test("worker records confine eligible lineage artifacts to the exact worker state directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-record-"));
  try {
    const roots = { stateRoot: path.join(root, "state"), workspaceRoot: path.join(root, "workspaces") };
    const paths = workerPaths(roots, "worker_20260924120000_12345678");
    provisionWorkerPaths(paths);
    assert.throws(() => writeWorkerRecord(paths.recordFile, {
      version: WORKER_RECORD_VERSION,
      workerId: "worker_20260924120000_12345678",
      sessionId: "child-session",
      parentSessionFile,
      workspaceRoot: paths.workspaceRoot,
      taskIds: ["personal-test"],
      route,
      cacheLineage: {
        version: 1,
        mode: "eligible",
        provider: "openai-codex",
        model: route.model,
        thinkingLevel: route.thinkingLevel,
        snapshotFile: path.join(root, "outside", "cache-lineage.json"),
        snapshotSha256: "a".repeat(64),
        marker: "fork_marker_1234",
        adoptionFile: path.join(root, "outside", "cache-lineage-adopted.json"),
        fallbackFile: path.join(root, "outside", "cache-lineage-fallback.json")
      },
      status: "queued",
      updatedAt: "2026-09-24T12:00:00.000Z"
    }), /Invalid worker record/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex lineage eligibility requires fresh exact parent session and route bindings", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-eligibility-"));
  try {
    captureAndPrepare(root);
    const base = {
      stateRoot: root,
      workerStateDir: path.join(root, "other-worker"),
      parentSessionFile,
      parentSessionId,
      route,
      marker: "fork_marker_5678",
      now: new Date("2026-09-24T12:00:01.000Z")
    };
    const wrongSession = prepareWorkerCacheLineage({ ...base, parentSessionId: "different-parent-session" });
    assert.equal(wrongSession.mode, "fresh");
    assert.match(wrongSession.mode === "fresh" ? wrongSession.reason : "", /another parent session/);
    const wrongRoute = prepareWorkerCacheLineage({
      ...base,
      route: { ...route, model: "different-model" }
    });
    assert.equal(wrongRoute.mode, "fresh");
    assert.match(wrongRoute.mode === "fresh" ? wrongRoute.reason : "", /does not exactly match/);
    const stale = prepareWorkerCacheLineage({
      ...base,
      now: new Date("2026-09-24T12:06:00.000Z")
    });
    assert.equal(stale.mode, "fresh");
    assert.match(stale.mode === "fresh" ? stale.reason : "", /stale/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
