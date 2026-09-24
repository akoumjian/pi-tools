import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import type { Context, Model, Tool } from "@earendil-works/pi-ai";
import { stream as streamOpenAICodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
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
const forkMarker = "fork_marker_1234";
const workerInstructions = "WORKER_CWD_SENTINEL=/private/worker\nWORKER_TOOL_GUIDELINE_SENTINEL=use-only-managed-tools";
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

function workerPayload(options: {
  prefix?: boolean;
  markerItems?: number;
  instructions?: string;
  trailing?: Record<string, unknown>[];
} = {}): Record<string, unknown> {
  const parentInput = parentPayload().input as unknown[];
  const markerItems = options.markerItems ?? 1;
  const assignments = Array.from({ length: markerItems }, (_, index) => ({
    role: "user",
    content: [{
      type: "input_text",
      text: `${index === 0 ? "initial worker assignment" : `duplicate assignment ${index}`} ${forkMarker}`
    }]
  }));
  return {
    model: route.model,
    store: false,
    stream: true,
    instructions: options.instructions ?? workerInstructions,
    input: [
      ...(options.prefix === false ? [{ role: "user", content: [{ type: "input_text", text: "drift" }] }] : parentInput),
      { role: "assistant", content: [{ type: "output_text", text: "parent completion" }] },
      ...assignments,
      ...(options.trailing ?? [])
    ],
    tools: MANAGED_WORKER_TOOL_NAMES.map(functionTool),
    reasoning: { effort: "xhigh", summary: "auto" },
    tool_choice: "auto",
    parallel_tool_calls: true
  };
}

function captureAndPrepare(
  root: string,
  exposeSessionHeader = true,
  capturedPayload: Record<string, unknown> = parentPayload()
) {
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
  handlers.get("before_provider_request")![0]!({ payload: capturedPayload }, context);
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
    marker: forkMarker,
    now: new Date("2026-09-24T12:00:01.000Z")
  });
  assert.equal(record.mode, "eligible");
  return record;
}

function sdkTool(name: string): Tool {
  return {
    name,
    description: `Trusted ${name} implementation`,
    parameters: { type: "object", properties: {}, additionalProperties: false }
  } as Tool;
}

function fakeJwt(): string {
  return [
    "e30",
    Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture" } })).toString("base64url"),
    "fixture-signature"
  ].join(".");
}

async function captureAdapterPayload(model: Model<any>, context: Context): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let payload: unknown;
  const stream = streamOpenAICodexResponses(model, context, {
    apiKey: fakeJwt(),
    signal: controller.signal,
    maxRetries: 0,
    transport: "sse",
    sessionId: parentSessionId,
    onPayload(candidate) {
      payload = structuredClone(candidate);
      controller.abort();
    }
  });
  for await (const _event of stream) {
    // Abort in onPayload before network I/O after capturing the real adapter body.
  }
  assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
  return payload as Record<string, unknown>;
}

function decodeCodexRequestBody(body: BodyInit | null | undefined, headers: Headers): Record<string, unknown> {
  assert.ok(body);
  const raw = typeof body === "string"
    ? body
    : headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(Buffer.from(body as Uint8Array)).toString("utf8")
      : Buffer.from(body as Uint8Array).toString("utf8");
  return JSON.parse(raw) as Record<string, unknown>;
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
    assert.match(transformed.input[3].content[0].text, /Only these worker tools are executable/);
    assert.equal(transformed.input[3].content[1].text, workerInstructions);
    assert.equal(JSON.stringify(transformed.instructions).includes("WORKER_CWD_SENTINEL"), false);
    assert.match(transformed.input[4].content[0].text, new RegExp(forkMarker));
    assert.deepEqual(
      transformed.tool_choice.tools.map((tool: Record<string, unknown>) => tool.name),
      MANAGED_WORKER_TOOL_NAMES
    );
    assert.equal(transformed.previous_response_id, undefined);
    assert.equal(runtime.status().mode, "adopted");
    assert.equal(record.mode, "eligible");
    assert.equal(existsSync(record.adoptionFile), true);
    const adoption = JSON.parse(readFileSync(record.adoptionFile, "utf8")) as Record<string, unknown>;
    for (const field of [
      "markerSha256",
      "workerToolsSha256",
      "workerInstructionsSha256",
      "forkBoundarySha256",
      "initialAssignmentSha256"
    ]) assert.match(String(adoption[field]), /^[0-9a-f]{64}$/);
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

test("real Codex SSE adapter sends the inherited affinity with an exact stable fork boundary", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-adapter-"));
  const model = getBuiltinModel("openai-codex", "gpt-5.6-sol");
  assert.ok(model);
  const parentContext: Context = {
    systemPrompt: "ADAPTER EXACT PARENT INSTRUCTIONS",
    messages: [{ role: "user", content: "stable adapter parent", timestamp: 1 }],
    tools: [sdkTool("parent_only"), sdkTool("shell_start")]
  };
  const capturedParent = await captureAdapterPayload(model, parentContext);
  const originalFetch = globalThis.fetch;
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  let request: { headers: Headers; body: Record<string, unknown> } | undefined;
  try {
    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      request = { headers, body: decodeCodexRequestBody(init?.body, headers) };
      const completed = {
        type: "response.completed",
        response: {
          id: "resp_fixture",
          object: "response",
          created_at: 1,
          status: "completed",
          model: route.model,
          output: [],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
            input_tokens_details: { cached_tokens: 1 },
            output_tokens_details: { reasoning_tokens: 0 }
          }
        }
      };
      return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    };
    const record = captureAndPrepare(root, true, capturedParent);
    runtime = createWorkerCacheLineageRuntime(record);
    const requestHeaders: Record<string, string> = { "x-fixture": "adapter" };
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    };
    const childContext: Context = {
      systemPrompt: workerInstructions,
      messages: [
        ...parentContext.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "parent completion" }],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: route.model,
          usage,
          stopReason: "stop",
          timestamp: 2
        },
        { role: "user", content: `initial worker assignment ${forkMarker}`, timestamp: 3 }
      ],
      tools: MANAGED_WORKER_TOOL_NAMES.map(sdkTool)
    };
    const stream = streamOpenAICodexResponses(model, childContext, {
      apiKey: fakeJwt(),
      maxRetries: 0,
      transport: "sse",
      sessionId: "distinct-child-session-and-request-id",
      headers: requestHeaders,
      onPayload(payload) {
        const transformed = runtime!.transformPayload(payload, codexContext());
        runtime!.transformHeaders(requestHeaders, codexContext());
        return transformed;
      }
    });
    const adapterEvents: string[] = [];
    for await (const event of stream) {
      adapterEvents.push(event.type);
    }

    assert.equal(adapterEvents.at(-1), "done", "the real adapter accepted the deterministic SSE response");
    assert.equal(adapterEvents.includes("error"), false);
    assert.ok(request);
    assert.equal(request.headers.get("session-id"), inheritedAffinity);
    assert.equal(request.headers.get("x-client-request-id"), "distinct-child-session-and-request-id");
    const body = request.body as Record<string, any>;
    assert.equal(body.instructions, capturedParent.instructions);
    assert.deepEqual(body.input.slice(0, 1), capturedParent.input);
    assert.equal(body.input[2].type, "additional_tools");
    assert.deepEqual(
      body.input[2].tools.map((tool: Record<string, unknown>) => tool.name),
      MANAGED_WORKER_TOOL_NAMES.filter((name) => name !== "shell_start")
    );
    assert.equal(body.input[3].content[1].text, workerInstructions);
    assert.match(body.input[4].content[0].text, new RegExp(forkMarker));
    assert.deepEqual(
      body.tool_choice.tools.map((tool: Record<string, unknown>) => tool.name),
      MANAGED_WORKER_TOOL_NAMES
    );
    assert.equal(body.previous_response_id, undefined);
  } finally {
    runtime?.restoreNetwork();
    globalThis.fetch = originalFetch;
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
    const original = workerPayload({ prefix: false });
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

test("Codex lineage strips and rejects previous_response_id on the initial fork", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-initial-continuation-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    const initial = workerPayload();
    initial.previous_response_id = "must-not-cross-the-fork";
    const fresh = runtime.transformPayload(initial, codexContext()) as Record<string, unknown>;
    assert.equal(fresh.previous_response_id, undefined);
    assert.deepEqual(runtime.status(), {
      mode: "fresh",
      reason: "Worker Codex initial fork unexpectedly carries previous_response_id."
    });
    runtime.restoreNetwork();
    runtime = createWorkerCacheLineageRuntime(record);
    const resumedFresh = runtime.transformPayload(initial, codexContext()) as Record<string, unknown>;
    assert.equal(resumedFresh.previous_response_id, undefined, "persisted fresh fallback never forwards continuation state");
  } finally {
    runtime?.restoreNetwork();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex lineage keeps one immutable boundary across turns and persisted resume", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-multiturn-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  let resumed: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    const first = runtime.transformPayload(workerPayload(), codexContext()) as Record<string, any>;
    const fixedPrefix = structuredClone(first.input.slice(0, 5));
    assert.deepEqual(fixedPrefix[4], (workerPayload().input as unknown[])[2]);

    const trailing = [
      { role: "assistant", content: [{ type: "output_text", text: "first worker answer" }] },
      { role: "user", content: [{ type: "input_text", text: "second worker turn" }] }
    ];
    const continuation = workerPayload({ trailing });
    continuation.previous_response_id = "resp_worker_one";
    const second = runtime.transformPayload(continuation, codexContext()) as Record<string, any>;
    assert.deepEqual(second.input.slice(0, 5), fixedPrefix);
    assert.deepEqual(second.input.slice(5), trailing);
    assert.equal(second.previous_response_id, "resp_worker_one");

    runtime.restoreNetwork();
    runtime = undefined;
    resumed = createWorkerCacheLineageRuntime(record);
    const resumeTrailing = [
      ...trailing,
      { role: "assistant", content: [{ type: "output_text", text: "second worker answer" }] },
      { role: "user", content: [{ type: "input_text", text: "resume worker turn" }] }
    ];
    const resumedPayload = resumed.transformPayload(workerPayload({ trailing: resumeTrailing }), codexContext()) as Record<string, any>;
    assert.deepEqual(resumedPayload.input.slice(0, 5), fixedPrefix);
    assert.deepEqual(resumedPayload.input.slice(5), resumeTrailing);

    const instructionDrift = resumed.transformPayload(
      workerPayload({ instructions: `${workerInstructions}\nDRIFT` , trailing: resumeTrailing }),
      codexContext()
    ) as Record<string, unknown>;
    assert.match(String(instructionDrift.model), /^pi-cache-lineage-blocked-/);
    assert.deepEqual(resumed.status(), {
      mode: "failed",
      reason: "Managed-worker system instructions drifted after Codex lineage adoption."
    });
  } finally {
    runtime?.restoreNetwork();
    resumed?.restoreNetwork();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex lineage treats missing or duplicate initial assignment markers by adoption state", () => {
  for (const markerItems of [0, 2]) {
    const beforeRoot = mkdtempSync(path.join(tmpdir(), `worker-lineage-marker-before-${markerItems}-`));
    let before: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
    try {
      const record = captureAndPrepare(beforeRoot);
      before = createWorkerCacheLineageRuntime(record);
      const original = workerPayload({ markerItems });
      assert.deepEqual(before.transformPayload(original, codexContext()), original);
      assert.deepEqual(before.status(), {
        mode: "fresh",
        reason: `Worker Codex input must contain exactly one initial assignment marker; found ${markerItems}.`
      });
    } finally {
      before?.restoreNetwork();
      rmSync(beforeRoot, { recursive: true, force: true });
    }

    const afterRoot = mkdtempSync(path.join(tmpdir(), `worker-lineage-marker-after-${markerItems}-`));
    let after: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
    try {
      const record = captureAndPrepare(afterRoot);
      after = createWorkerCacheLineageRuntime(record);
      after.transformPayload(workerPayload(), codexContext());
      const blocked = after.transformPayload(workerPayload({ markerItems }), codexContext()) as Record<string, unknown>;
      assert.match(String(blocked.model), /^pi-cache-lineage-blocked-/);
      assert.deepEqual(after.status(), {
        mode: "failed",
        reason: `Worker Codex input must contain exactly one initial assignment marker; found ${markerItems}.`
      });
    } finally {
      after?.restoreNetwork();
      rmSync(afterRoot, { recursive: true, force: true });
    }
  }
});

test("Codex lineage rejects a marker repeated within one assignment item", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-marker-repeated-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    const repeated = workerPayload();
    const input = repeated.input as Array<Record<string, any>>;
    input[2].content[0].text += ` ${forkMarker}`;
    assert.deepEqual(runtime.transformPayload(repeated, codexContext()), repeated);
    assert.deepEqual(runtime.status(), {
      mode: "fresh",
      reason: "Worker Codex input must contain exactly one initial assignment marker; found 2."
    });
  } finally {
    runtime?.restoreNetwork();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex lineage fails closed when the marked initial assignment changes after adoption", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-assignment-drift-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    runtime.transformPayload(workerPayload(), codexContext());
    const drifted = workerPayload();
    const input = drifted.input as Array<Record<string, any>>;
    input[2].content[0].text = `changed initial assignment ${forkMarker}`;
    const blocked = runtime.transformPayload(drifted, codexContext()) as Record<string, unknown>;
    assert.match(String(blocked.model), /^pi-cache-lineage-blocked-/);
    assert.deepEqual(runtime.status(), {
      mode: "failed",
      reason: "Managed-worker initial assignment drifted after Codex lineage adoption."
    });
  } finally {
    runtime?.restoreNetwork();
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
