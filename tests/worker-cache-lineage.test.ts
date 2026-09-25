import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { InMemoryCredentialStore, type Context, type Model, type Tool } from "@earendil-works/pi-ai";
import { stream as streamOpenAICodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import {
  MANAGED_WORKER_TOOL_NAMES,
  WORKER_CACHE_LINEAGE_MAX_BYTES,
  createWorkerCacheLineageRuntime,
  prepareWorkerCacheLineage,
  registerParentCacheLineageCapture,
  registerWorkerCacheLineageRuntimeHooks,
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
  preAssignment?: Record<string, unknown>[];
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
      ...(options.preAssignment ?? []),
      ...assignments,
      ...(options.trailing ?? [])
    ],
    tools: MANAGED_WORKER_TOOL_NAMES.map(functionTool),
    reasoning: { effort: "xhigh", summary: "auto" },
    tool_choice: "auto",
    parallel_tool_calls: true
  };
}

function captureRecord(
  root: string,
  exposeSessionHeader = true,
  capturedPayload: Record<string, unknown> = parentPayload(),
  context: ExtensionContext = codexContext(),
  afterCapture?: () => void
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
  const headers: Record<string, string> = {
    Authorization: "secret-never-persisted",
    "x-client-request-id": "parent-request",
    ...(exposeSessionHeader ? { "session-id": inheritedAffinity } : {})
  };
  handlers.get("before_provider_headers")![0]!({ headers }, context);
  handlers.get("before_provider_request")![0]!({ payload: capturedPayload }, context);
  afterCapture?.();
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
  return record;
}

function captureAndPrepare(
  root: string,
  exposeSessionHeader = true,
  capturedPayload: Record<string, unknown> = parentPayload()
) {
  const record = captureRecord(root, exposeSessionHeader, capturedPayload);
  assert.equal(record.mode, "eligible");
  return record;
}

function successfulAssistantMessage(stopReason = "stop"): Record<string, unknown> {
  return {
    role: "assistant",
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: route.model,
    stopReason,
    content: []
  };
}

function completeSuccessfulResponse(
  runtime: ReturnType<typeof createWorkerCacheLineageRuntime>,
  context: ExtensionContext = codexContext()
): void {
  runtime.observeProviderResponse(200);
  runtime.observeAssistantMessage(successfulAssistantMessage(), context);
}

function sdkTool(name: string): Tool {
  return {
    name,
    description: `Trusted ${name} implementation`,
    parameters: { type: "object", properties: {}, additionalProperties: false }
  } as Tool;
}

function sessionTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `Trusted ${name} implementation`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({
      content: [{ type: "text", text: `${name} fixture result` }],
      details: {}
    })
  } as ToolDefinition;
}

function codexSseResponse(item: Record<string, unknown>, responseId: string): Response {
  const usage = {
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 }
  };
  const response = {
    id: responseId,
    object: "response",
    created_at: 1,
    status: "completed",
    model: route.model,
    output: [item],
    usage
  };
  const events = [
    { type: "response.created", response: { id: responseId } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response }
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function codexTextItem(id: string, text: string): Record<string, unknown> {
  return {
    id,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }]
  };
}

function codexToolCallItem(id: string, callId: string, name: string): Record<string, unknown> {
  return {
    id,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name,
    arguments: "{}"
  };
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
    const capturedPayload = parentPayload();
    const record = captureRecord(root, true, capturedPayload, codexContext(), () => {
      capturedPayload.instructions = "mutation after capture hook";
    });
    assert.equal(record.mode, "eligible");
    const snapshot = readFileSync(record.snapshotFile, "utf8");
    assert.match(snapshot, /parent-cache-affinity/);
    assert.doesNotMatch(snapshot, /secret-never-persisted/);
    assert.doesNotMatch(snapshot, /parent-request/);
    assert.doesNotMatch(snapshot, /Authorization/);
    assert.doesNotMatch(snapshot, /mutation after capture hook/);
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
      const initialHeaders: Record<string, string> = { "session-id": "child-local" };
      runtime.transformHeaders(initialHeaders, codexContext());
      assert.equal(initialHeaders["session-id"], "child-local", "header hook precedes provisional payload adoption");
      runtime.transformPayload(workerPayload(), codexContext());
      completeSuccessfulResponse(runtime);
      const adoptedHeaders: Record<string, string> = { "session-id": "child-next" };
      runtime.transformHeaders(adoptedHeaders, codexContext());
      assert.equal(adoptedHeaders["session-id"], parentSessionId);
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
    assert.equal(runtime.status().mode, "eligible");
    assert.equal(record.mode, "eligible");
    assert.equal(existsSync(record.adoptionFile), false);
    completeSuccessfulResponse(runtime);
    assert.equal(runtime.status().mode, "adopted");
    assert.equal(existsSync(record.adoptionFile), true);
    const adoption = JSON.parse(readFileSync(record.adoptionFile, "utf8")) as Record<string, unknown>;
    for (const field of [
      "markerSha256",
      "workerToolsSha256",
      "workerInstructionsSha256",
      "forkBoundarySha256",
      "initialAssignmentSha256",
      "preAssignmentItemsSha256"
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
    runtime.transformHeaders(requestHeaders, codexContext());
    const stream = streamOpenAICodexResponses(model, childContext, {
      apiKey: fakeJwt(),
      maxRetries: 0,
      transport: "sse",
      sessionId: "distinct-child-session-and-request-id",
      headers: requestHeaders,
      onPayload(payload) {
        return runtime!.transformPayload(payload, codexContext());
      },
      onResponse(response) {
        runtime!.observeProviderResponse(response.status);
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

test("Pi 0.84.4 dispatches header, payload, final transport, and acceptance hooks in the proven lineage order", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-real-pi-hooks-"));
  const cwd = path.join(root, "repo");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  const workerSessionDir = path.join(root, "worker-sessions");
  const stateRoot = path.join(root, "state");
  const workerStateDir = path.join(stateRoot, "worker");
  mkdirSync(cwd, { recursive: true });
  const originalFetch = globalThis.fetch;
  const trace: string[] = [];
  const requests: Array<{ headers: Headers; body: Record<string, any> }> = [];
  let parentSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let workerSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let workerRuntime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      trace.push(`fetch:${requests.length}`);
      const headers = new Headers(init?.headers);
      requests.push({ headers, body: decodeCodexRequestBody(init?.body, headers) });
      if (requests.length === 1) return codexSseResponse(codexTextItem("msg_parent", "parent completion"), "resp_parent");
      if (requests.length === 2) return codexSseResponse(
        codexToolCallItem("fc_worker", "call_worker", "shell_status"),
        "resp_worker_tool"
      );
      return codexSseResponse(codexTextItem("msg_worker", "worker done"), "resp_worker_done");
    }) as typeof globalThis.fetch;

    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai-codex", async () => ({
      type: "oauth",
      access: fakeJwt(),
      refresh: "fixture-refresh-never-used",
      expires: Date.now() + 60 * 60 * 1000
    }));
    const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    const model = modelRuntime.getModel("openai-codex", "gpt-5.6-sol");
    assert.ok(model);
    assert.ok(await modelRuntime.checkAuth("openai-codex"));

    const parentSettings = SettingsManager.create(cwd, agentDir);
    parentSettings.setTransport("sse");
    const parentLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: parentSettings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "REAL PI EXACT PARENT INSTRUCTIONS",
      extensionFactories: [
        { name: "lineage-parent", factory: (api) => registerParentCacheLineageCapture(api, stateRoot) },
        { name: "lineage-trace", factory: (api) => {
          api.on("before_provider_headers", () => { trace.push("parent:headers"); });
          api.on("before_provider_request", () => { trace.push("parent:payload"); });
          api.on("after_provider_response", () => { trace.push("parent:response"); });
        } }
      ]
    });
    await parentLoader.reload();
    const parentManager = SessionManager.create(cwd, sessionDir);
    ({ session: parentSession } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: "xhigh",
      settingsManager: parentSettings,
      resourceLoader: parentLoader,
      sessionManager: parentManager,
      customTools: [sessionTool("parent_only"), sessionTool("shell_start")],
      tools: ["parent_only", "shell_start"]
    }));
    await parentSession.prompt("stable adapter parent");
    assert.deepEqual(trace.slice(0, 4), ["parent:headers", "parent:payload", "fetch:0", "parent:response"]);
    const parentSessionFile = parentManager.getSessionFile();
    assert.ok(parentSessionFile);
    const record = prepareWorkerCacheLineage({
      stateRoot,
      workerStateDir,
      parentSessionFile,
      parentSessionId: parentManager.getSessionId(),
      route,
      marker: forkMarker
    });
    assert.equal(record.mode, "eligible");
    parentSession.dispose();
    parentSession = undefined;

    workerRuntime = createWorkerCacheLineageRuntime(record);
    const workerSettings = SettingsManager.create(cwd, agentDir);
    const workerLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: workerSettings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: workerInstructions,
      extensionFactories: [
        { name: "lineage-worker", factory: (api) => registerWorkerCacheLineageRuntimeHooks(api, workerRuntime!) },
        { name: "lineage-worker-trace", factory: (api) => {
          api.on("before_provider_headers", () => { trace.push("worker:headers"); });
          api.on("before_provider_request", () => { trace.push("worker:payload"); });
          api.on("after_provider_response", () => { trace.push("worker:response"); });
          api.on("session_before_compact", (event) => ({
            compaction: {
              summary: "trusted fixture compaction",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore
            }
          }));
        } }
      ]
    });
    await workerLoader.reload();
    workerSettings.applyOverrides({
      transport: "sse",
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 }
    });
    assert.deepEqual(workerSettings.getCompactionSettings(), {
      enabled: true,
      reserveTokens: 100,
      keepRecentTokens: 1
    });
    const workerManager = SessionManager.forkFrom(parentSessionFile, cwd, workerSessionDir);
    ({ session: workerSession } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: "xhigh",
      settingsManager: workerSettings,
      resourceLoader: workerLoader,
      sessionManager: workerManager,
      customTools: MANAGED_WORKER_TOOL_NAMES.map(sessionTool),
      tools: [...MANAGED_WORKER_TOOL_NAMES]
    }));
    await workerSession.prompt(`initial worker assignment ${forkMarker}`);

    assert.equal(requests.length, 3, "the tool-call-only response triggers a second full-replay request");
    assert.deepEqual(trace.slice(4), [
      "worker:headers", "worker:payload", "fetch:1", "worker:response",
      "worker:headers", "worker:payload", "fetch:2", "worker:response"
    ]);
    assert.equal(requests[1]!.headers.get("session-id"), parentManager.getSessionId());
    assert.equal(requests[2]!.headers.get("session-id"), parentManager.getSessionId());
    assert.notEqual(requests[1]!.headers.get("x-client-request-id"), parentManager.getSessionId());
    assert.deepEqual(requests[1]!.body.input.slice(0, requests[0]!.body.input.length), requests[0]!.body.input);
    assert.equal(requests[1]!.body.previous_response_id, undefined);
    assert.equal(requests[2]!.body.previous_response_id, undefined);
    const boundaryIndex = requests[1]!.body.input.findIndex((item: Record<string, unknown>) => item.type === "additional_tools");
    assert.ok(boundaryIndex > requests[0]!.body.input.length);
    assert.deepEqual(
      requests[2]!.body.input.slice(0, boundaryIndex + 3),
      requests[1]!.body.input.slice(0, boundaryIndex + 3),
      "turn two preserves the exact inherited prefix, intervening items, fork boundary, and assignment"
    );
    assert.equal(workerRuntime.status().mode, "adopted");

    await workerSession.prompt("pre-compaction second worker turn");
    assert.equal(requests.length, 4, "a second user turn exercises adopted full replay before compaction");
    assert.equal(requests[3]!.body.previous_response_id, undefined);
    assert.equal(workerRuntime.status().mode, "adopted");

    const traceBeforeCompaction = trace.length;
    await workerSession.compact("exercise the trusted Pi compaction lifecycle");
    assert.equal(requests.length, 4, "extension-provided compaction does not issue another provider request");
    assert.equal(trace.length, traceBeforeCompaction);
    assert.deepEqual(workerRuntime.status(), {
      mode: "retired",
      reason: "Cache lineage retired after trusted Pi manual compaction."
    });

    await workerSession.prompt("ordinary post-compaction worker turn");
    assert.equal(requests.length, 5);
    assert.deepEqual(trace.slice(traceBeforeCompaction), [
      "worker:headers", "worker:payload", "fetch:4", "worker:response"
    ]);
    assert.equal(requests[4]!.headers.get("session-id"), workerManager.getSessionId());
    assert.notEqual(requests[4]!.headers.get("session-id"), parentManager.getSessionId());
    assert.equal(requests[4]!.body.previous_response_id, undefined);
    assert.equal(
      requests[4]!.body.input.some((item: Record<string, unknown>) => item.type === "additional_tools"),
      false,
      "retired lineage uses Pi's ordinary fresh post-compaction payload"
    );
    assert.deepEqual(summarizeWorkerCacheLineage(record), {
      mode: "retired",
      reason: "Cache lineage retired after trusted Pi manual compaction."
    });
  } finally {
    workerSession?.dispose();
    parentSession?.dispose();
    workerRuntime?.restoreNetwork();
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
    completeSuccessfulResponse(adoptedRuntime);
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

test("Codex lineage strips previous_response_id from every transformed full replay", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-continuation-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root, true, parentPayload());
    runtime = createWorkerCacheLineageRuntime(record);
    const initial = workerPayload();
    initial.previous_response_id = "must-not-cross-the-fork";
    const first = runtime.transformPayload(initial, codexContext()) as Record<string, unknown>;
    assert.equal(first.previous_response_id, undefined);
    assert.equal(runtime.status().mode, "eligible");
    completeSuccessfulResponse(runtime);
    const continuation = workerPayload({ trailing: [
      { role: "assistant", content: [{ type: "output_text", text: "tool-call-only response is valid" }] },
      { role: "user", content: [{ type: "input_text", text: "turn two" }] }
    ] });
    continuation.previous_response_id = "also-must-not-cross";
    const second = runtime.transformPayload(continuation, codexContext()) as Record<string, unknown>;
    assert.equal(second.previous_response_id, undefined);
    assert.equal(runtime.status().mode, "adopted");
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
    completeSuccessfulResponse(runtime);
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
    assert.equal(second.previous_response_id, undefined);

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

test("Codex lineage discovers the marker only initially and ignores marker-like later content", () => {
  const beforeRoot = mkdtempSync(path.join(tmpdir(), "worker-lineage-marker-before-"));
  const afterRoot = mkdtempSync(path.join(tmpdir(), "worker-lineage-marker-after-"));
  let before: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  let after: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const beforeRecord = captureAndPrepare(beforeRoot);
    before = createWorkerCacheLineageRuntime(beforeRecord);
    const original = workerPayload({ markerItems: 0 });
    assert.deepEqual(before.transformPayload(original, codexContext()), original);
    assert.deepEqual(before.status(), {
      mode: "fresh",
      reason: "Worker Codex input must contain exactly one initial assignment marker; found 0."
    });

    const afterRecord = captureAndPrepare(afterRoot);
    after = createWorkerCacheLineageRuntime(afterRecord);
    after.transformPayload(workerPayload(), codexContext());
    completeSuccessfulResponse(after);
    const laterMarkerText = `quoted handoff, completion notice, resume instruction, and model output may repeat ${forkMarker}`;
    const transformed = after.transformPayload(workerPayload({ trailing: [
      { role: "assistant", content: [{ type: "output_text", text: laterMarkerText }] },
      { role: "user", content: [{ type: "input_text", text: laterMarkerText }] },
      { type: "function_call_output", call_id: "call_fixture", output: laterMarkerText }
    ] }), codexContext()) as Record<string, any>;
    assert.equal(transformed.model, route.model);
    assert.equal(after.status().mode, "adopted");
    assert.equal((transformed.input as unknown[]).length > 5, true);
  } finally {
    before?.restoreNetwork();
    after?.restoreNetwork();
    rmSync(beforeRoot, { recursive: true, force: true });
    rmSync(afterRoot, { recursive: true, force: true });
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
    completeSuccessfulResponse(runtime);
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
    completeSuccessfulResponse(runtime);
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
    completeSuccessfulResponse(runtime);
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

test("noncanonical Codex base URLs fall back before child runtime construction", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-base-url-"));
  try {
    const context = codexContext({
      model: {
        provider: "openai-codex",
        id: route.model,
        api: "openai-codex-responses",
        baseUrl: "https://example.invalid/backend-api"
      }
    });
    assert.deepEqual(captureRecord(root, true, parentPayload(), context), {
      version: 1,
      mode: "fresh",
      reason: "The latest parent Codex request uses a noncanonical base URL."
    });
    assert.equal(existsSync(path.join(root, "worker-one", "cache-lineage.json")), false);
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
  const websocketProtocols: Array<string | string[] | undefined> = [];
  const websocketMessages: string[] = [];
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly url: string;
    constructor(
      url: string | URL,
      protocolsOrOptions?: string | string[] | { headers?: Record<string, string> },
      options?: { headers?: Record<string, string> }
    ) {
      this.url = url.toString();
      websocketProtocols.push(typeof protocolsOrOptions === "string" || Array.isArray(protocolsOrOptions)
        ? protocolsOrOptions
        : undefined);
      websocketHeaders = (typeof protocolsOrOptions === "object" && !Array.isArray(protocolsOrOptions)
        ? protocolsOrOptions
        : options)?.headers;
    }
    send(data: string): void {
      websocketMessages.push(data);
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

    new globalThis.WebSocket("wss://chatgpt.com/backend-api/codex/responses", "responses.v1");
    assert.equal(websocketProtocols.at(-1), "responses.v1");
    assert.equal(new Headers(websocketHeaders).get("session-id"), inheritedAffinity);
    const socket = Reflect.construct(globalThis.WebSocket, [
      "wss://chatgpt.com/backend-api/codex/responses",
      ["responses.v1", "fixture.v2"],
      { headers: { "x-client-request-id": "child-websocket-array" } }
    ]) as WebSocket;
    assert.deepEqual(websocketProtocols.at(-1), ["responses.v1", "fixture.v2"]);
    assert.equal(new Headers(websocketHeaders).get("session-id"), inheritedAffinity);
    assert.equal(new Headers(websocketHeaders).get("x-client-request-id"), "child-websocket-array");
    socket.send(JSON.stringify({
      type: "response.create",
      previous_response_id: "must-not-survive-adapter-continuation",
      input: [{ role: "user", content: [{ type: "input_text", text: "delta only" }] }]
    }));
    const websocketBody = JSON.parse(websocketMessages.at(-1)!) as Record<string, any>;
    assert.equal(websocketBody.previous_response_id, undefined);
    assert.deepEqual(websocketBody.input.slice(0, 1), parentPayload().input);
    assert.equal(websocketBody.input.some((item: Record<string, unknown>) => item.type === "additional_tools"), true);
  } finally {
    runtime?.restoreNetwork();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    rmSync(root, { recursive: true, force: true });
  }
});


test("fresh fallback closes inherited WebSockets before child-session reuse", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-websocket-reuse-"));
  const originalWebSocket = globalThis.WebSocket;
  const sockets: FakeWebSocket[] = [];
  class FakeWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readyState = FakeWebSocket.OPEN;
    readonly headers: Record<string, string>;
    constructor(
      _url: string | URL,
      options?: { headers?: Record<string, string> }
    ) {
      this.headers = options?.headers ?? {};
      sockets.push(this);
    }
    send(): void {}
    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket;
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    runtime.transformPayload(workerPayload(), codexContext());
    const cached = new globalThis.WebSocket("wss://chatgpt.com/backend-api/codex/responses", {
      headers: { "session-id": "child-session" }
    } as unknown as string[]) as unknown as FakeWebSocket;
    assert.equal(new Headers(cached.headers).get("session-id"), inheritedAffinity);

    runtime.observeProviderResponse(429);
    assert.equal(cached.readyState, FakeWebSocket.CLOSED, "fallback closes the inherited-handshake socket");

    const unprovenDelta = {
      previous_response_id: "child-continuation",
      input: [{ role: "user", content: [{ type: "input_text", text: "delta" }] }]
    };
    assert.equal(
      (runtime.transformPayload(unprovenDelta, codexContext()) as Record<string, unknown>).previous_response_id,
      "child-continuation",
      "fresh fallback does not strip an unproven delta continuation"
    );
    const childHeaders: Record<string, string> = { "session-id": "child-session" };
    runtime.transformHeaders(childHeaders, codexContext());
    assert.equal(childHeaders["session-id"], undefined);

    // Faithfully model Pi's child-session socket cache: a closed inherited
    // handshake cannot be selected, so the fresh request opens a new socket.
    const fresh = Number(cached.readyState) === FakeWebSocket.OPEN
      ? cached
      : new globalThis.WebSocket("wss://chatgpt.com/backend-api/codex/responses", {
          headers: { "session-id": "child-session" }
        } as unknown as string[]) as unknown as FakeWebSocket;
    assert.notEqual(fresh, cached);
    assert.equal(new Headers(fresh.headers).get("session-id"), "child-session");
    assert.equal(sockets.length, 2);
  } finally {
    runtime?.restoreNetwork();
    globalThis.WebSocket = originalWebSocket;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex lineage persists pre-adoption route drift as a stable fresh fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-route-fallback-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  let resumed: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    const headers: Record<string, string> = { "session-id": "child-local" };
    runtime.transformHeaders(headers, codexContext({
      model: { provider: "openai-codex", id: "drifted-model", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }
    }));
    assert.equal(headers["session-id"], undefined);
    assert.deepEqual(runtime.status(), {
      mode: "fresh",
      reason: "Worker provider/model/API/thinking route drifted from the persisted Codex lineage."
    });
    assert.equal(existsSync(record.fallbackFile), true);
    runtime.restoreNetwork();
    runtime = undefined;
    resumed = createWorkerCacheLineageRuntime(record);
    assert.deepEqual(resumed.status(), {
      mode: "fresh",
      reason: "Worker provider/model/API/thinking route drifted from the persisted Codex lineage."
    });
  } finally {
    runtime?.restoreNetwork();
    resumed?.restoreNetwork();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex lineage adopts only after acceptance and rejected first requests remain fresh", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-rejected-adoption-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  let resumed: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    runtime.transformPayload(workerPayload(), codexContext());
    runtime.observeProviderResponse(429);
    assert.deepEqual(runtime.status(), {
      mode: "fresh",
      reason: "Initial Codex lineage request was rejected with HTTP status 429."
    });
    runtime.observeAssistantMessage({
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: route.model,
      stopReason: "error",
      content: [],
      errorMessage: "fixture rejection"
    }, codexContext());
    assert.equal(runtime.status().mode, "fresh");
    assert.equal(existsSync(record.adoptionFile), false);
    assert.equal(existsSync(record.fallbackFile), true);
    runtime.restoreNetwork();
    runtime = undefined;
    resumed = createWorkerCacheLineageRuntime(record);
    assert.equal(resumed.status().mode, "fresh");
    assert.deepEqual(resumed.transformPayload(workerPayload(), codexContext()), workerPayload());
  } finally {
    runtime?.restoreNetwork();
    resumed?.restoreNetwork();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP success waits for a matching successful assistant completion", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-completion-adoption-"));
  try {
    for (const stopReason of ["error", "aborted"] as const) {
      const caseRoot = path.join(root, stopReason);
      const record = captureAndPrepare(caseRoot);
      const runtime = createWorkerCacheLineageRuntime(record);
      try {
        runtime.transformPayload(workerPayload(), codexContext());
        runtime.observeProviderResponse(200);
        assert.equal(runtime.status().mode, "eligible");
        assert.equal(existsSync(record.adoptionFile), false);
        runtime.observeAssistantMessage({ ...successfulAssistantMessage(), model: "other-model" }, codexContext());
        assert.equal(runtime.status().mode, "eligible", "a mismatched completion cannot adopt lineage");
        const incomplete = successfulAssistantMessage();
        delete incomplete.stopReason;
        runtime.observeAssistantMessage(incomplete, codexContext());
        assert.equal(runtime.status().mode, "eligible", "an incomplete assistant message cannot adopt lineage");
        runtime.observeAssistantMessage(successfulAssistantMessage(stopReason), codexContext());
        assert.equal(runtime.status().mode, "fresh");
        assert.equal(existsSync(record.adoptionFile), false);
        assert.equal(existsSync(record.fallbackFile), true);
      } finally {
        runtime.restoreNetwork();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex lineage accepts a tool-call-only first response without an assistant-text heuristic", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-tool-call-adoption-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    runtime.transformPayload(workerPayload(), codexContext());
    runtime.observeAssistantMessage({
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: route.model,
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call_fixture", name: "shell_status", arguments: {} }]
    }, codexContext());
    assert.equal(runtime.status().mode, "adopted");
    assert.equal(existsSync(record.adoptionFile), true);
  } finally {
    runtime?.restoreNetwork();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex lineage digests every pre-assignment suffix item", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-pre-assignment-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    const preAssignment = [{ role: "assistant", content: [{ type: "output_text", text: "stable intervening item" }] }];
    runtime.transformPayload(workerPayload({ preAssignment }), codexContext());
    completeSuccessfulResponse(runtime);
    const blocked = runtime.transformPayload(workerPayload({ preAssignment: [
      { role: "assistant", content: [{ type: "output_text", text: "drifted intervening item" }] }
    ] }), codexContext()) as Record<string, unknown>;
    assert.match(String(blocked.model), /^pi-cache-lineage-blocked-/);
    assert.deepEqual(runtime.status(), {
      mode: "failed",
      reason: "Managed-worker pre-assignment history drifted after Codex lineage adoption."
    });
  } finally {
    runtime?.restoreNetwork();
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted Pi compaction retires adopted lineage and survives runtime reconstruction", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-retirement-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  let resumed: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    const handlers = new Map<string, Array<(event: any, context: ExtensionContext) => unknown>>();
    registerWorkerCacheLineageRuntimeHooks({
      on(event: string, handler: (event: any, context: ExtensionContext) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }
    } as unknown as ExtensionAPI, runtime);
    handlers.get("before_provider_request")![0]!({ payload: workerPayload() }, codexContext());
    handlers.get("after_provider_response")![0]!({ status: 200 }, codexContext());
    assert.equal(runtime.status().mode, "eligible", "HTTP success alone does not commit adoption");
    handlers.get("message_end")![0]!({ message: successfulAssistantMessage() }, codexContext());
    assert.equal(runtime.status().mode, "adopted");
    handlers.get("session_compact")![0]!({ reason: "manual" }, codexContext());
    assert.deepEqual(runtime.status(), {
      mode: "retired",
      reason: "Cache lineage retired after trusted Pi manual compaction."
    });
    assert.deepEqual(summarizeWorkerCacheLineage(record), {
      mode: "retired",
      reason: "Cache lineage retired after trusted Pi manual compaction."
    });
    runtime.restoreNetwork();
    runtime = undefined;

    resumed = createWorkerCacheLineageRuntime(record);
    const headers: Record<string, string> = { "session-id": inheritedAffinity };
    resumed.transformHeaders(headers, codexContext());
    assert.equal(headers["session-id"], undefined);
    const firstFresh = workerPayload();
    firstFresh.previous_response_id = "inherited-continuation";
    const transformed = resumed.transformPayload(firstFresh, codexContext()) as Record<string, unknown>;
    assert.equal(transformed.previous_response_id, undefined);
    assert.deepEqual(transformed.input, firstFresh.input, "retirement uses ordinary fresh payloads without inherited boundaries");
    resumed.observeProviderResponse(500);
    resumed.observeAssistantMessage(successfulAssistantMessage("error"), codexContext());
    assert.equal(JSON.parse(readFileSync(record.retirementFile, "utf8")).firstFreshRequestPending, true);

    const abortedRetry = workerPayload();
    abortedRetry.previous_response_id = "still-inherited";
    assert.equal(
      (resumed.transformPayload(abortedRetry, codexContext()) as Record<string, unknown>).previous_response_id,
      undefined,
      "a failed HTTP/stream attempt leaves the one-time strip pending"
    );
    resumed.observeProviderResponse(200);
    resumed.observeAssistantMessage(successfulAssistantMessage("aborted"), codexContext());
    assert.equal(JSON.parse(readFileSync(record.retirementFile, "utf8")).firstFreshRequestPending, true);

    const successfulRetry = workerPayload();
    successfulRetry.previous_response_id = "retry-after-abort";
    assert.equal(
      (resumed.transformPayload(successfulRetry, codexContext()) as Record<string, unknown>).previous_response_id,
      undefined
    );
    completeSuccessfulResponse(resumed);
    assert.equal(JSON.parse(readFileSync(record.retirementFile, "utf8")).firstFreshRequestPending, false);
    resumed.restoreNetwork();
    resumed = createWorkerCacheLineageRuntime(record);
    const normalContinuation = workerPayload();
    normalContinuation.previous_response_id = "new-worker-continuation";
    assert.equal(
      (resumed.transformPayload(normalContinuation, codexContext()) as Record<string, unknown>).previous_response_id,
      "new-worker-continuation",
      "only the first post-compaction request strips continuation state"
    );
  } finally {
    runtime?.restoreNetwork();
    resumed?.restoreNetwork();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lineage summaries remain cheap, bounded, and non-throwing", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-summary-"));
  let runtime: ReturnType<typeof createWorkerCacheLineageRuntime> | undefined;
  try {
    const record = captureAndPrepare(root);
    runtime = createWorkerCacheLineageRuntime(record);
    runtime.transformPayload(workerPayload(), codexContext());
    completeSuccessfulResponse(runtime);
    writeFileSync(record.snapshotFile, "corrupt large snapshot that operational summaries must not parse");
    for (let index = 0; index < 100; index += 1) {
      assert.deepEqual(summarizeWorkerCacheLineage(record), { mode: "adopted" });
    }
    writeFileSync(record.summaryFile, "not-json");
    assert.deepEqual(summarizeWorkerCacheLineage(record), {
      mode: "unavailable",
      reason: "Cache-lineage summary is unavailable or invalid."
    });
  } finally {
    runtime?.restoreNetwork();
    rmSync(root, { recursive: true, force: true });
  }
});

test("large ASCII parent payloads use their encoded size rather than a worst-case expansion", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-large-ascii-"));
  try {
    const payload = parentPayload();
    payload.input = [{
      role: "user",
      content: [{ type: "input_text", text: "x".repeat(2 * 1024 * 1024) }]
    }];
    const record = captureAndPrepare(root, false, payload);
    assert.equal(record.mode, "eligible");
    assert.ok(statSync(record.snapshotFile).size < WORKER_CACHE_LINEAGE_MAX_BYTES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JSON-compatible shared references and omitted values remain eligible", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-json-semantics-"));
  try {
    const payload = parentPayload() as Record<string, unknown>;
    const shared = { nested: "shared" };
    payload.first = shared;
    payload.second = shared;
    payload.omitted = undefined;
    payload.omittedFunction = () => "not serialized";
    payload.omittedSymbol = Symbol("not serialized");
    payload.arraySemantics = [undefined, () => "not serialized", Symbol("not serialized"), Number.NaN, Infinity, -0];
    const record = captureAndPrepare(root, false, payload);
    assert.equal(record.mode, "eligible");
    const snapshot = JSON.parse(readFileSync(record.snapshotFile, "utf8")) as {
      data: { payload: Record<string, unknown> };
    };
    assert.deepEqual(snapshot.data.payload.first, shared);
    assert.deepEqual(snapshot.data.payload.second, shared);
    assert.equal(Object.hasOwn(snapshot.data.payload, "omitted"), false);
    assert.equal(Object.hasOwn(snapshot.data.payload, "omittedFunction"), false);
    assert.equal(Object.hasOwn(snapshot.data.payload, "omittedSymbol"), false);
    assert.deepEqual(snapshot.data.payload.arraySemantics, [null, null, null, null, null, 0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture eligibility accounts for the bounded persisted snapshot envelope", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-envelope-bound-"));
  try {
    const payload = parentPayload();
    const baseBytes = Buffer.byteLength(JSON.stringify({ ...payload, padding: "" }), "utf8");
    payload.padding = "x".repeat(WORKER_CACHE_LINEAGE_MAX_BYTES - baseBytes - 64);
    assert.deepEqual(captureRecord(root, false, payload), {
      version: 1,
      mode: "fresh",
      reason: "Parent Codex request snapshot exceeds the bounded size limit."
    });
    assert.equal(existsSync(path.join(root, "worker-one", "cache-lineage.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture freezes payloads and rejects accessors, toJSON, proxies, and exotic objects", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-live-shapes-"));
  try {
    let getterCalls = 0;
    const accessorPayload = parentPayload();
    Object.defineProperty(accessorPayload, "unstable", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("capture must not invoke getters");
      }
    });
    assert.deepEqual(captureRecord(path.join(root, "accessor"), false, accessorPayload), {
      version: 1,
      mode: "fresh",
      reason: "Parent Codex request payload is not bounded JSON within the snapshot limit."
    });
    assert.equal(getterCalls, 0);

    const toJsonPayload = parentPayload();
    toJsonPayload.toJSON = () => parentPayload();
    assert.equal(captureRecord(path.join(root, "to-json"), false, toJsonPayload).mode, "fresh");

    const proxyPayload = new Proxy(parentPayload(), {
      ownKeys() {
        throw new Error("capture must not traverse proxies");
      }
    });
    assert.doesNotThrow(() => captureRecord(path.join(root, "proxy"), false, proxyPayload));
    assert.equal(captureRecord(path.join(root, "proxy-result"), false, proxyPayload).mode, "fresh");

    const exoticPayload = parentPayload();
    exoticPayload.exotic = new Date(0);
    assert.equal(captureRecord(path.join(root, "exotic"), false, exoticPayload).mode, "fresh");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture validation rejects sparse and deeply nested payloads without unbounded traversal", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-structural-bounds-"));
  try {
    const sparse = parentPayload();
    sparse.input = new Array(Math.floor(WORKER_CACHE_LINEAGE_MAX_BYTES / 2) + 1);
    assert.doesNotThrow(() => captureRecord(path.join(root, "sparse"), false, sparse));
    assert.deepEqual(captureRecord(path.join(root, "sparse-result"), false, sparse), {
      version: 1,
      mode: "fresh",
      reason: "Parent Codex request payload is not bounded JSON within the snapshot limit."
    });

    const deep = parentPayload();
    let nested: Record<string, unknown> = {};
    deep.deep = nested;
    for (let depth = 0; depth < 130; depth += 1) {
      const child: Record<string, unknown> = {};
      nested.child = child;
      nested = child;
    }
    assert.deepEqual(captureRecord(path.join(root, "deep"), false, deep), {
      version: 1,
      mode: "fresh",
      reason: "Parent Codex request payload is not bounded JSON within the snapshot limit."
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized parent payloads skip capture without throwing or persisting request artifacts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-oversized-"));
  try {
    const legacyCaptureDir = path.join(root, ".cache-lineage");
    mkdirSync(legacyCaptureDir, { recursive: true });
    writeFileSync(path.join(legacyCaptureDir, "unreferenced-request.json"), "legacy");
    const handlers = new Map<string, Array<(event: any, context: ExtensionContext) => unknown>>();
    registerParentCacheLineageCapture({
      on(event: string, handler: (event: any, context: ExtensionContext) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }
    } as unknown as ExtensionAPI, root, () => new Date("2026-09-24T12:00:00.000Z"));
    const context = codexContext();
    assert.doesNotThrow(() => handlers.get("before_provider_headers")![0]!({
      headers: { "session-id": inheritedAffinity }
    }, context));
    const oversized = parentPayload();
    oversized.instructions = "x".repeat(WORKER_CACHE_LINEAGE_MAX_BYTES);
    assert.doesNotThrow(() => handlers.get("before_provider_request")![0]!({ payload: oversized }, context));
    handlers.get("before_provider_headers")![0]!({ headers: { "session-id": inheritedAffinity } }, context);
    const cyclic = parentPayload();
    cyclic.self = cyclic;
    assert.doesNotThrow(() => handlers.get("before_provider_request")![0]!({ payload: cyclic }, context));
    const record = prepareWorkerCacheLineage({
      stateRoot: root,
      workerStateDir: path.join(root, "worker"),
      parentSessionFile,
      parentSessionId,
      route,
      marker: forkMarker,
      now: new Date("2026-09-24T12:00:01.000Z")
    });
    assert.deepEqual(record, {
      version: 1,
      mode: "fresh",
      reason: "Parent Codex request payload is not bounded JSON within the snapshot limit."
    });
    assert.equal(existsSync(path.join(root, ".cache-lineage")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture holder generations invalidate templates owned by an obsolete extension registration", () => {
  const root = mkdtempSync(path.join(tmpdir(), "worker-lineage-generation-"));
  try {
    const firstRecord = captureAndPrepare(path.join(root, "first"));
    assert.equal(firstRecord.mode, "eligible");
    registerParentCacheLineageCapture({ on() {} } as unknown as ExtensionAPI, path.join(root, "second"));
    const stale = prepareWorkerCacheLineage({
      stateRoot: path.join(root, "second"),
      workerStateDir: path.join(root, "second", "worker"),
      parentSessionFile,
      parentSessionId,
      route,
      marker: forkMarker,
      now: new Date("2026-09-24T12:00:01.000Z")
    });
    assert.deepEqual(stale, {
      version: 1,
      mode: "fresh",
      reason: "No validated parent Codex request capture is available."
    });
  } finally {
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
        fallbackFile: path.join(root, "outside", "cache-lineage-fallback.json"),
        retirementFile: path.join(root, "outside", "cache-lineage-retired.json"),
        summaryFile: path.join(root, "outside", "cache-lineage-summary.json")
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
