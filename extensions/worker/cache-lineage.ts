import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkerRoute } from "./state.js";

export const CODEX_CACHE_LINEAGE_API = "openai-codex-responses";
export const CODEX_CACHE_LINEAGE_PROVIDER = "openai-codex";
export const WORKER_CACHE_LINEAGE_MAX_BYTES = 8 * 1024 * 1024;
export const WORKER_CACHE_LINEAGE_MAX_AGE_MS = 5 * 60 * 1000;
export const WORKER_CACHE_LINEAGE_MAX_INSTRUCTIONS_BYTES = 1024 * 1024;

export const MANAGED_WORKER_TOOL_NAMES = [
  "worker_handoff",
  "worker_task_read",
  "worker_task_update",
  "shell_start",
  "shell_status",
  "shell_read",
  "shell_cancel"
] as const;

const MANAGED_WORKER_TOOL_NAME_SET = new Set<string>(MANAGED_WORKER_TOOL_NAMES);
const CAPTURE_HOLDER_KEY = Symbol.for("@akoumjian/pi-tools/worker-cache-lineage-capture");
const CAPTURE_HOLDER_VERSION = 1;
const ADOPTION_VERSION = 2;

type JsonObject = Record<string, unknown>;

type ParentCaptureData = {
  version: 1;
  api: typeof CODEX_CACHE_LINEAGE_API;
  provider: typeof CODEX_CACHE_LINEAGE_PROVIDER;
  model: string;
  baseUrl: string;
  thinkingLevel: string;
  parentSessionFileSha256: string;
  parentSessionIdSha256: string;
  capturedAt: string;
  payload: JsonObject;
  payloadSha256: string;
  cacheAffinitySessionId: string;
};

export type ParentCacheLineageCapture = {
  data: ParentCaptureData;
  integritySha256: string;
};

export type WorkerCacheLineageRecord =
  | {
      version: 1;
      mode: "fresh";
      reason: string;
    }
  | {
      version: 1;
      mode: "eligible";
      provider: typeof CODEX_CACHE_LINEAGE_PROVIDER;
      model: string;
      thinkingLevel: string;
      snapshotFile: string;
      snapshotSha256: string;
      marker: string;
      adoptionFile: string;
      fallbackFile: string;
    };

type PendingCapture = Omit<ParentCaptureData, "cacheAffinitySessionId"> & {
  candidateCacheAffinitySessionId: string;
};
type CaptureHolder = {
  version: typeof CAPTURE_HOLDER_VERSION;
  pendingBySessionFile: Map<string, PendingCapture>;
};

export type WorkerCacheLineageRuntimeStatus = {
  mode: "fresh" | "eligible" | "adopted" | "failed";
  reason?: string;
};

function captureHolder(): CaptureHolder {
  const existing = Reflect.get(globalThis, CAPTURE_HOLDER_KEY) as Partial<CaptureHolder> | undefined;
  if (existing !== undefined) {
    if (
      existing === null ||
      typeof existing !== "object" ||
      existing.version !== CAPTURE_HOLDER_VERSION ||
      !(existing.pendingBySessionFile instanceof Map)
    ) {
      throw new Error(`Incompatible worker cache-lineage capture holder version ${CAPTURE_HOLDER_VERSION}.`);
    }
    return existing as CaptureHolder;
  }
  const created: CaptureHolder = {
    version: CAPTURE_HOLDER_VERSION,
    pendingBySessionFile: new Map()
  };
  Reflect.set(globalThis, CAPTURE_HOLDER_KEY, created);
  return created;
}

export function registerParentCacheLineageCapture(
  api: ExtensionAPI,
  stateRoot: string,
  now: () => Date = () => new Date()
): void {
  api.on("before_provider_request", (event, context) => {
    const sessionFile = context.sessionManager.getSessionFile();
    const model = context.model;
    if (
      !sessionFile ||
      !model ||
      model.provider !== CODEX_CACHE_LINEAGE_PROVIDER ||
      model.api !== CODEX_CACHE_LINEAGE_API ||
      !isJsonObject(event.payload)
    ) return;
    if (process.env.PI_WORKER_ID) return;
    const payload = cloneJsonObject(event.payload);
    const payloadJson = stringifyBounded(payload, "parent Codex provider payload");
    captureHolder().pendingBySessionFile.set(path.resolve(sessionFile), {
      version: 1,
      api: CODEX_CACHE_LINEAGE_API,
      provider: CODEX_CACHE_LINEAGE_PROVIDER,
      model: model.id,
      baseUrl: normalizeCodexBaseUrl(model.baseUrl),
      thinkingLevel: String(context.thinkingLevel),
      parentSessionFileSha256: sha256(path.resolve(sessionFile)),
      parentSessionIdSha256: sha256(context.sessionManager.getSessionId()),
      candidateCacheAffinitySessionId: clampCodexSessionId(context.sessionManager.getSessionId()),
      capturedAt: now().toISOString(),
      payload,
      payloadSha256: sha256(payloadJson)
    });
  });

  api.on("before_provider_headers", (event, context) => {
    if (process.env.PI_WORKER_ID) return;
    const sessionFile = context.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const resolvedSessionFile = path.resolve(sessionFile);
    const pending = captureHolder().pendingBySessionFile.get(resolvedSessionFile);
    if (!pending) return;
    captureHolder().pendingBySessionFile.delete(resolvedSessionFile);
    const observedSessionId = readHeader(event.headers, "session-id");
    const { candidateCacheAffinitySessionId, ...captured } = pending;
    // Pi 0.84.4 invokes before_provider_headers before the Codex adapter adds its
    // final transport headers. In that baseline, prompt_cache_key is built from
    // the same clamped session id that the adapter subsequently writes as
    // session-id, so require that exact payload equality before deriving it.
    const sessionId = observedSessionId ?? (
      pending.payload.prompt_cache_key === candidateCacheAffinitySessionId
        ? candidateCacheAffinitySessionId
        : undefined
    );
    if (!sessionId) return;
    const data: ParentCaptureData = { ...captured, cacheAffinitySessionId: sessionId };
    const capture: ParentCacheLineageCapture = {
      data,
      integritySha256: sha256(stringifyBounded(data, "parent Codex lineage data"))
    };
    writePrivateJson(parentCaptureFile(stateRoot, resolvedSessionFile), capture);
  });
}

export function prepareWorkerCacheLineage(input: {
  stateRoot: string;
  workerStateDir: string;
  parentSessionFile: string;
  parentSessionId: string;
  route: WorkerRoute;
  marker?: string;
  now?: Date;
}): WorkerCacheLineageRecord {
  const unsupportedReason = cacheLineageRouteReason(input.route);
  if (unsupportedReason) return freshLineage(unsupportedReason);
  const source = parentCaptureFile(input.stateRoot, input.parentSessionFile);
  if (!existsSync(source)) return freshLineage("No validated parent Codex request capture is available.");
  let capture: ParentCacheLineageCapture;
  try {
    capture = readParentCapture(source);
  } catch (error) {
    return freshLineage(`Parent Codex request capture is invalid: ${boundedReason(error)}`);
  }
  const now = input.now ?? new Date();
  const ageMs = now.getTime() - Date.parse(capture.data.capturedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > WORKER_CACHE_LINEAGE_MAX_AGE_MS) {
    return freshLineage("Parent Codex request capture is stale.");
  }
  if (
    capture.data.parentSessionFileSha256 !== sha256(path.resolve(input.parentSessionFile)) ||
    capture.data.parentSessionIdSha256 !== sha256(input.parentSessionId)
  ) {
    return freshLineage("Parent Codex request capture is bound to another parent session.");
  }
  if (
    capture.data.provider !== input.route.provider ||
    capture.data.model !== input.route.model ||
    capture.data.thinkingLevel !== input.route.thinkingLevel
  ) {
    return freshLineage("Parent Codex request capture route does not exactly match the worker route.");
  }
  mkdirSync(input.workerStateDir, { recursive: true, mode: 0o700 });
  const snapshotFile = path.join(input.workerStateDir, "cache-lineage.json");
  const snapshotJson = stringifyBounded(capture, "worker cache-lineage snapshot");
  writePrivateText(snapshotFile, `${snapshotJson}\n`);
  return {
    version: 1,
    mode: "eligible",
    provider: CODEX_CACHE_LINEAGE_PROVIDER,
    model: input.route.model,
    thinkingLevel: input.route.thinkingLevel,
    snapshotFile,
    snapshotSha256: sha256(`${snapshotJson}\n`),
    marker: normalizeMarker(input.marker ?? randomUUID()),
    adoptionFile: path.join(input.workerStateDir, "cache-lineage-adopted.json"),
    fallbackFile: path.join(input.workerStateDir, "cache-lineage-fallback.json")
  };
}

export function validateWorkerCacheLineageRecord(value: unknown): value is WorkerCacheLineageRecord {
  if (!isJsonObject(value) || value.version !== 1) return false;
  if (value.mode === "fresh") {
    return typeof value.reason === "string" && value.reason.length > 0 && Buffer.byteLength(value.reason, "utf8") <= 512;
  }
  return value.mode === "eligible" &&
    value.provider === CODEX_CACHE_LINEAGE_PROVIDER &&
    typeof value.model === "string" && value.model.length > 0 && value.model.length <= 256 &&
    typeof value.thinkingLevel === "string" && value.thinkingLevel.length > 0 && value.thinkingLevel.length <= 32 &&
    typeof value.snapshotFile === "string" && path.isAbsolute(value.snapshotFile) && path.basename(value.snapshotFile) === "cache-lineage.json" &&
    typeof value.snapshotSha256 === "string" && /^[0-9a-f]{64}$/.test(value.snapshotSha256) &&
    typeof value.marker === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value.marker) &&
    typeof value.adoptionFile === "string" && path.isAbsolute(value.adoptionFile) && path.basename(value.adoptionFile) === "cache-lineage-adopted.json" &&
    typeof value.fallbackFile === "string" && path.isAbsolute(value.fallbackFile) && path.basename(value.fallbackFile) === "cache-lineage-fallback.json" &&
    path.dirname(value.snapshotFile) === path.dirname(value.adoptionFile) &&
    path.dirname(value.snapshotFile) === path.dirname(value.fallbackFile);
}

export function summarizeWorkerCacheLineage(
  record: WorkerCacheLineageRecord | undefined
): { mode: "eligible" | "adopted" | "fresh"; reason?: string } | undefined {
  if (!record) return undefined;
  if (record.mode === "fresh") return { mode: "fresh", reason: record.reason };
  const capture = readWorkerSnapshot(record);
  const hasAdoption = existsSync(record.adoptionFile);
  const hasFallback = existsSync(record.fallbackFile);
  if (hasAdoption && hasFallback) throw new Error("Worker cache-lineage has conflicting persisted decisions.");
  if (hasAdoption) {
    readAdoption(record.adoptionFile, record, capture);
    return { mode: "adopted" };
  }
  if (hasFallback) return { mode: "fresh", reason: readFallback(record.fallbackFile, record, capture) };
  return { mode: "eligible" };
}

export function createWorkerCacheLineageRuntime(record: WorkerCacheLineageRecord | undefined): {
  transformPayload(payload: unknown, context: ExtensionContext): unknown;
  transformHeaders(headers: Record<string, string | null | undefined>, context: ExtensionContext): void;
  guardTool(toolName: string): { block: true; reason: string; terminate: true } | undefined;
  status(): WorkerCacheLineageRuntimeStatus;
  restoreNetwork(): void;
} {
  if (!record || record.mode === "fresh") {
    return {
      transformPayload: (payload) => payload,
      transformHeaders: () => {},
      guardTool: guardManagedWorkerTool,
      status: () => ({ mode: "fresh", reason: record?.reason ?? "Cache lineage was not configured." }),
      restoreNetwork: () => {}
    };
  }

  const controller = new EligibleRuntimeController(record);
  controller.installNetworkGuards();
  return {
    transformPayload: (payload, context) => controller.transformPayload(payload, context),
    transformHeaders: (headers, context) => controller.transformHeaders(headers, context),
    guardTool: guardManagedWorkerTool,
    status: () => controller.status(),
    restoreNetwork: () => controller.restoreNetwork()
  };
}

class EligibleRuntimeController {
  private readonly capture: ParentCacheLineageCapture;
  private adopted: boolean;
  private disabledReason: string | undefined;
  private fatalReason: string | undefined;
  private networkArmed = false;
  private adoptedWorkerToolsSha256: string | undefined;
  private adoptedWorkerInstructionsSha256: string | undefined;
  private adoptedForkBoundarySha256: string | undefined;
  private adoptedInitialAssignmentSha256: string | undefined;
  private originalFetch: typeof globalThis.fetch | undefined;
  private originalWebSocket: typeof globalThis.WebSocket | undefined;

  constructor(private readonly record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }>) {
    this.capture = readWorkerSnapshot(record);
    const hasAdoption = existsSync(record.adoptionFile);
    const hasFallback = existsSync(record.fallbackFile);
    if (hasAdoption && hasFallback) throw new Error("Worker cache-lineage has conflicting persisted decisions.");
    this.adopted = hasAdoption;
    if (hasAdoption) {
      const adoption = readAdoption(record.adoptionFile, record, this.capture);
      this.adoptedWorkerToolsSha256 = adoption.workerToolsSha256;
      this.adoptedWorkerInstructionsSha256 = adoption.workerInstructionsSha256;
      this.adoptedForkBoundarySha256 = adoption.forkBoundarySha256;
      this.adoptedInitialAssignmentSha256 = adoption.initialAssignmentSha256;
    } else if (hasFallback) {
      this.disabledReason = readFallback(record.fallbackFile, record, this.capture);
    }
  }

  transformPayload(payload: unknown, context: ExtensionContext): unknown {
    if (this.disabledReason) {
      if (isJsonObject(payload) && payload.previous_response_id !== undefined) {
        const freshPayload = cloneJsonObject(payload);
        delete freshPayload.previous_response_id;
        return freshPayload;
      }
      return payload;
    }
    const stripsInitialPreviousResponseId =
      !this.adopted && isJsonObject(payload) && payload.previous_response_id !== undefined;
    try {
      const transformed = this.transformPayloadOrThrow(payload, context);
      if (this.adoptedWorkerToolsSha256 && this.adoptedWorkerToolsSha256 !== transformed.workerToolsSha256) {
        throw new Error("Managed-worker tool schemas drifted after Codex lineage adoption.");
      }
      if (this.adoptedWorkerInstructionsSha256 && this.adoptedWorkerInstructionsSha256 !== transformed.workerInstructionsSha256) {
        throw new Error("Managed-worker system instructions drifted after Codex lineage adoption.");
      }
      if (this.adoptedForkBoundarySha256 && this.adoptedForkBoundarySha256 !== transformed.forkBoundarySha256) {
        throw new Error("Managed-worker fork boundary drifted after Codex lineage adoption.");
      }
      if (this.adoptedInitialAssignmentSha256 && this.adoptedInitialAssignmentSha256 !== transformed.initialAssignmentSha256) {
        throw new Error("Managed-worker initial assignment drifted after Codex lineage adoption.");
      }
      writeAdoption(
        this.record.adoptionFile,
        this.record,
        this.capture,
        transformed.workerToolsSha256,
        transformed.workerInstructionsSha256,
        transformed.forkBoundarySha256,
        transformed.initialAssignmentSha256
      );
      this.adoptedWorkerToolsSha256 = transformed.workerToolsSha256;
      this.adoptedWorkerInstructionsSha256 = transformed.workerInstructionsSha256;
      this.adoptedForkBoundarySha256 = transformed.forkBoundarySha256;
      this.adoptedInitialAssignmentSha256 = transformed.initialAssignmentSha256;
      this.adopted = true;
      return transformed.payload;
    } catch (error) {
      const reason = boundedReason(error);
      if (!this.adopted) {
        try {
          writeFallback(this.record.fallbackFile, this.record, this.capture, reason);
          this.disabledReason = reason;
          this.networkArmed = false;
          if (stripsInitialPreviousResponseId && isJsonObject(payload)) {
            const freshPayload = cloneJsonObject(payload);
            delete freshPayload.previous_response_id;
            return freshPayload;
          }
          return payload;
        } catch (persistenceError) {
          this.fatalReason = `Unable to persist pre-adoption fallback: ${boundedReason(persistenceError)}`;
          this.networkArmed = true;
          return failClosedPayload(payload, this.record.marker);
        }
      }
      this.fatalReason = reason;
      this.networkArmed = true;
      return failClosedPayload(payload, this.record.marker);
    }
  }

  transformHeaders(headers: Record<string, string | null | undefined>, context: ExtensionContext): void {
    if (this.disabledReason) return;
    const drift = routeDriftReason(context, this.record, this.capture.data.baseUrl);
    if (drift) {
      if (this.adopted) {
        this.fatalReason = drift;
        this.networkArmed = true;
      } else {
        this.disabledReason = drift;
      }
      return;
    }
    if (!this.adopted) return;
    setHeader(headers, "session-id", this.capture.data.cacheAffinitySessionId);
    // x-client-request-id intentionally remains the child's independently generated request identity.
    this.networkArmed = true;
  }

  status(): WorkerCacheLineageRuntimeStatus {
    if (this.fatalReason) return { mode: "failed", reason: this.fatalReason };
    if (this.disabledReason) return { mode: "fresh", reason: this.disabledReason };
    return { mode: this.adopted ? "adopted" : "eligible" };
  }

  installNetworkGuards(): void {
    if (typeof globalThis.fetch === "function") {
      this.originalFetch = globalThis.fetch;
      const controller = this;
      globalThis.fetch = (async function lineageFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        if (!controller.networkArmed) {
          return controller.originalFetch!.call(globalThis, input, init);
        }
        if (controller.fatalReason) controller.assertNetworkAllowed();
        if (!isCodexHttpTarget(input)) return controller.originalFetch!.call(globalThis, input, init);
        controller.assertNetworkAllowed();
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set("session-id", controller.capture.data.cacheAffinitySessionId);
        return controller.originalFetch!.call(globalThis, input, { ...init, headers });
      }) as typeof globalThis.fetch;
    }
    if (typeof globalThis.WebSocket === "function") {
      this.originalWebSocket = globalThis.WebSocket;
      const Original = this.originalWebSocket;
      const controller = this;
      const GuardedWebSocket = class extends Original {
        constructor(url: string | URL, protocolsOrOptions?: string | string[] | Record<string, unknown>) {
          if (!controller.networkArmed) {
            super(url, protocolsOrOptions as string | string[] | undefined);
            return;
          }
          if (controller.fatalReason) controller.assertNetworkAllowed();
          if (!isCodexWebSocketTarget(url)) {
            super(url, protocolsOrOptions as string | string[] | undefined);
            return;
          }
          controller.assertNetworkAllowed();
          const options = isJsonObject(protocolsOrOptions) ? { ...protocolsOrOptions } : {};
          const headers = new Headers(isJsonObject(options.headers) ? options.headers as Record<string, string> : undefined);
          headers.set("session-id", controller.capture.data.cacheAffinitySessionId);
          options.headers = Object.fromEntries(headers.entries());
          super(url, options as unknown as string[]);
        }
      };
      globalThis.WebSocket = GuardedWebSocket as typeof globalThis.WebSocket;
    }
  }

  restoreNetwork(): void {
    if (this.originalFetch) globalThis.fetch = this.originalFetch;
    if (this.originalWebSocket) globalThis.WebSocket = this.originalWebSocket;
  }

  private transformPayloadOrThrow(
    payload: unknown,
    context: ExtensionContext
  ): {
    payload: JsonObject;
    workerToolsSha256: string;
    workerInstructionsSha256: string;
    forkBoundarySha256: string;
    initialAssignmentSha256: string;
  } {
    const drift = routeDriftReason(context, this.record, this.capture.data.baseUrl);
    if (drift) throw new Error(drift);
    if (!isJsonObject(payload)) throw new Error("Worker Codex provider payload is not an object.");
    if (this.capture.data.payload.previous_response_id !== undefined) {
      throw new Error("Codex cache-lineage workers never inherit parent previous_response_id.");
    }
    if (payload.model !== this.record.model) throw new Error("Worker Codex payload model drifted before lineage adoption.");
    const workerInstructions = boundedWorkerInstructions(payload.instructions);
    const workerInstructionsSha256 = sha256(workerInstructions);
    const currentInput = asObjectArray(payload.input, "worker Codex input");
    const parentInput = asObjectArray(this.capture.data.payload.input, "captured parent Codex input");
    if (currentInput.length < parentInput.length || !equalJson(currentInput.slice(0, parentInput.length), parentInput)) {
      throw new Error("Worker Codex input does not preserve the exact captured parent prefix.");
    }
    const workerTools = collectWorkerTools(payload, currentInput.slice(parentInput.length));
    if (workerTools.length === 0) throw new Error("Worker Codex payload exposes no managed-worker tool schemas.");
    const workerToolNames = workerTools.map(toolName);
    if (workerToolNames.some((name) => !MANAGED_WORKER_TOOL_NAME_SET.has(name))) {
      throw new Error("Worker Codex payload exposes a tool outside the managed-worker allowlist.");
    }
    for (const required of MANAGED_WORKER_TOOL_NAMES) {
      if (!workerToolNames.includes(required)) throw new Error(`Worker Codex payload is missing required tool ${required}.`);
    }
    const parentTools = optionalObjectArray(this.capture.data.payload.tools, "captured parent Codex tools");
    const parentByName = new Map(parentTools.map((tool) => [toolName(tool), tool]));
    const appendedTools: JsonObject[] = [];
    for (const workerTool of workerTools) {
      const name = toolName(workerTool);
      const inherited = parentByName.get(name);
      if (inherited) {
        if (!equalJson(inherited, workerTool)) {
          throw new Error(`Inherited parent tool schema conflicts with managed-worker tool ${name}.`);
        }
      } else {
        appendedTools.push(workerTool);
      }
    }
    const rawSuffix = currentInput.slice(parentInput.length);
    const markerOccurrences = rawSuffix.reduce(
      (total, item) => total + markerOccurrencesInInputItem(item, this.record.marker),
      0
    );
    const markerItems = rawSuffix.filter((item) => inputItemContainsMarker(item, this.record.marker));
    if (markerOccurrences !== 1 || markerItems.length !== 1) {
      throw new Error(`Worker Codex input must contain exactly one initial assignment marker; found ${markerOccurrences}.`);
    }
    const initialAssignment = markerItems[0]!;
    const initialAssignmentSha256 = sha256(stringifyBounded(initialAssignment, "managed-worker initial assignment"));
    const suffix = rawSuffix.filter((item) => item.type !== "additional_tools");
    const forkBoundary = suffix.indexOf(initialAssignment);
    if (forkBoundary < 0) throw new Error("Worker Codex initial assignment marker is not in the stable suffix.");
    const previousResponseId = payload.previous_response_id;
    if (previousResponseId !== undefined) {
      if (
        !this.adopted ||
        typeof previousResponseId !== "string" ||
        !previousResponseId ||
        Buffer.byteLength(previousResponseId, "utf8") > 1024 ||
        !suffix.slice(forkBoundary + 1).some((item) => item.role === "assistant")
      ) {
        throw new Error("Worker Codex initial fork unexpectedly carries previous_response_id.");
      }
    }
    const boundary: JsonObject[] = [];
    if (appendedTools.length > 0) {
      boundary.push({ type: "additional_tools", role: "developer", tools: appendedTools });
    }
    boundary.push({
      role: "developer",
      content: [
        {
          type: "input_text",
          text: `This is an isolated managed-worker fork. Only these worker tools are executable: ${workerToolNames.join(", ")}. Parent tool schemas remain immutable historical cache context and are not executable.`
        },
        { type: "input_text", text: workerInstructions }
      ]
    });
    const transformed = cloneJsonObject(this.capture.data.payload);
    transformed.input = [
      ...parentInput,
      ...suffix.slice(0, forkBoundary),
      ...boundary,
      ...suffix.slice(forkBoundary)
    ];
    transformed.tool_choice = {
      type: "allowed_tools",
      mode: "auto",
      tools: workerToolNames.map((name) => ({ type: "function", name }))
    };
    if (previousResponseId !== undefined) transformed.previous_response_id = previousResponseId;
    else delete transformed.previous_response_id;
    return {
      payload: transformed,
      workerToolsSha256: sha256(stringifyBounded(workerTools, "managed-worker Codex tool schemas")),
      workerInstructionsSha256,
      forkBoundarySha256: sha256(stringifyBounded(boundary, "managed-worker Codex fork boundary")),
      initialAssignmentSha256
    };
  }

  private assertNetworkAllowed(): void {
    if (this.fatalReason) throw new Error(`Managed-worker Codex cache lineage failed closed: ${this.fatalReason}`);
    if (!this.adopted) throw new Error("Managed-worker Codex cache lineage was not adopted before transport.");
  }
}

function boundedWorkerInstructions(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Worker Codex system instructions are missing or empty.");
  }
  if (Buffer.byteLength(value, "utf8") > WORKER_CACHE_LINEAGE_MAX_INSTRUCTIONS_BYTES) {
    throw new Error("Worker Codex system instructions exceed the lineage size bound.");
  }
  return value;
}

function markerOccurrencesInInputItem(item: JsonObject, marker: string): number {
  if (item.role !== "user" || !Array.isArray(item.content)) return 0;
  return item.content.reduce((total, block) => {
    if (!isJsonObject(block) || block.type !== "input_text" || typeof block.text !== "string") return total;
    return total + block.text.split(marker).length - 1;
  }, 0);
}

function inputItemContainsMarker(item: JsonObject, marker: string): boolean {
  return markerOccurrencesInInputItem(item, marker) > 0;
}

function collectWorkerTools(payload: JsonObject, suffix: JsonObject[]): JsonObject[] {
  const collected = [...optionalObjectArray(payload.tools, "worker Codex tools")];
  for (const item of suffix) {
    if (item.type === "additional_tools") {
      collected.push(...asObjectArray(item.tools, "worker Codex additional_tools"));
    }
  }
  const unique = new Map<string, JsonObject>();
  for (const tool of collected) {
    const name = toolName(tool);
    const previous = unique.get(name);
    if (previous && !equalJson(previous, tool)) throw new Error(`Worker Codex tool ${name} has conflicting schemas.`);
    unique.set(name, tool);
  }
  return [...unique.values()];
}

function readWorkerSnapshot(record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }>): ParentCacheLineageCapture {
  const metadata = lstatSync(record.snapshotFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > WORKER_CACHE_LINEAGE_MAX_BYTES) {
    throw new Error("Worker cache-lineage snapshot is not a bounded regular file.");
  }
  const bytes = readFileSync(record.snapshotFile);
  if (sha256(bytes) !== record.snapshotSha256) throw new Error("Worker cache-lineage snapshot digest mismatch.");
  return parseParentCapture(bytes.toString("utf8"));
}

function readParentCapture(file: string): ParentCacheLineageCapture {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > WORKER_CACHE_LINEAGE_MAX_BYTES) {
    throw new Error("Parent cache-lineage capture is not a bounded regular file.");
  }
  return parseParentCapture(readFileSync(file, "utf8"));
}

function parseParentCapture(raw: string): ParentCacheLineageCapture {
  const parsed: unknown = JSON.parse(raw);
  if (!isJsonObject(parsed) || !isJsonObject(parsed.data) || typeof parsed.integritySha256 !== "string") {
    throw new Error("Cache-lineage capture envelope is invalid.");
  }
  const data = parsed.data;
  if (
    data.version !== 1 ||
    data.api !== CODEX_CACHE_LINEAGE_API ||
    data.provider !== CODEX_CACHE_LINEAGE_PROVIDER ||
    typeof data.model !== "string" || !data.model ||
    data.baseUrl !== "https://chatgpt.com/backend-api" ||
    typeof data.thinkingLevel !== "string" || !data.thinkingLevel ||
    typeof data.parentSessionFileSha256 !== "string" || !/^[0-9a-f]{64}$/.test(data.parentSessionFileSha256) ||
    typeof data.parentSessionIdSha256 !== "string" || !/^[0-9a-f]{64}$/.test(data.parentSessionIdSha256) ||
    typeof data.capturedAt !== "string" || !Number.isFinite(Date.parse(data.capturedAt)) ||
    !isJsonObject(data.payload) ||
    typeof data.payloadSha256 !== "string" || !/^[0-9a-f]{64}$/.test(data.payloadSha256) ||
    typeof data.cacheAffinitySessionId !== "string" || !data.cacheAffinitySessionId || data.cacheAffinitySessionId.length > 512
  ) throw new Error("Cache-lineage capture fields are invalid.");
  if (sha256(stringifyBounded(data.payload, "captured parent payload")) !== data.payloadSha256) {
    throw new Error("Captured parent payload digest mismatch.");
  }
  if (sha256(stringifyBounded(data, "captured parent lineage data")) !== parsed.integritySha256) {
    throw new Error("Cache-lineage capture integrity mismatch.");
  }
  return parsed as ParentCacheLineageCapture;
}

function writeAdoption(
  file: string,
  record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }>,
  capture: ParentCacheLineageCapture,
  workerToolsSha256: string,
  workerInstructionsSha256: string,
  forkBoundarySha256: string,
  initialAssignmentSha256: string
): void {
  const value = {
    version: ADOPTION_VERSION,
    marker: record.marker,
    snapshotSha256: record.snapshotSha256,
    payloadSha256: capture.data.payloadSha256,
    workerToolsSha256,
    workerInstructionsSha256,
    forkBoundarySha256,
    initialAssignmentSha256,
    markerSha256: sha256(record.marker),
    provider: record.provider,
    model: record.model,
    thinkingLevel: record.thinkingLevel
  };
  if (existsSync(file)) {
    const adoption = readAdoption(file, record, capture);
    if (adoption.workerToolsSha256 !== workerToolsSha256) {
      throw new Error("Worker cache-lineage adoption tool schema digest mismatch.");
    }
    if (adoption.workerInstructionsSha256 !== workerInstructionsSha256) {
      throw new Error("Worker cache-lineage adoption system instruction digest mismatch.");
    }
    if (adoption.forkBoundarySha256 !== forkBoundarySha256) {
      throw new Error("Worker cache-lineage adoption fork boundary digest mismatch.");
    }
    if (adoption.initialAssignmentSha256 !== initialAssignmentSha256) {
      throw new Error("Worker cache-lineage adoption initial assignment digest mismatch.");
    }
    return;
  }
  writePrivateJson(file, value);
}

function readAdoption(
  file: string,
  record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }>,
  capture: ParentCacheLineageCapture
): {
  workerToolsSha256: string;
  workerInstructionsSha256: string;
  forkBoundarySha256: string;
  initialAssignmentSha256: string;
} {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 4096) {
    throw new Error("Worker cache-lineage adoption marker is invalid.");
  }
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !isJsonObject(value) ||
    value.version !== ADOPTION_VERSION ||
    value.marker !== record.marker ||
    value.snapshotSha256 !== record.snapshotSha256 ||
    value.provider !== record.provider ||
    value.model !== record.model ||
    value.thinkingLevel !== record.thinkingLevel ||
    value.payloadSha256 !== capture.data.payloadSha256 ||
    value.markerSha256 !== sha256(record.marker) ||
    typeof value.workerToolsSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.workerToolsSha256) ||
    typeof value.workerInstructionsSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.workerInstructionsSha256) ||
    typeof value.forkBoundarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.forkBoundarySha256) ||
    typeof value.initialAssignmentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.initialAssignmentSha256)
  ) throw new Error("Worker cache-lineage adoption marker does not match its persisted lineage.");
  return {
    workerToolsSha256: value.workerToolsSha256,
    workerInstructionsSha256: value.workerInstructionsSha256,
    forkBoundarySha256: value.forkBoundarySha256,
    initialAssignmentSha256: value.initialAssignmentSha256
  };
}

function writeFallback(
  file: string,
  record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }>,
  capture: ParentCacheLineageCapture,
  reason: string
): void {
  const bounded = truncateUtf8(reason, 400);
  if (existsSync(file)) {
    const persisted = readFallback(file, record, capture);
    if (persisted !== bounded) throw new Error("Worker cache-lineage fallback reason changed.");
    return;
  }
  writePrivateJson(file, {
    version: 1,
    marker: record.marker,
    snapshotSha256: record.snapshotSha256,
    payloadSha256: capture.data.payloadSha256,
    provider: record.provider,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    reason: bounded
  });
}

function readFallback(
  file: string,
  record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }>,
  capture: ParentCacheLineageCapture
): string {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 4096) {
    throw new Error("Worker cache-lineage fallback marker is invalid.");
  }
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !isJsonObject(value) ||
    value.version !== 1 ||
    value.marker !== record.marker ||
    value.snapshotSha256 !== record.snapshotSha256 ||
    value.payloadSha256 !== capture.data.payloadSha256 ||
    value.provider !== record.provider ||
    value.model !== record.model ||
    value.thinkingLevel !== record.thinkingLevel ||
    typeof value.reason !== "string" || !value.reason || Buffer.byteLength(value.reason, "utf8") > 400
  ) throw new Error("Worker cache-lineage fallback marker does not match its persisted lineage.");
  return value.reason;
}

function cacheLineageRouteReason(route: WorkerRoute): string | undefined {
  if (route.provider !== CODEX_CACHE_LINEAGE_PROVIDER) {
    return "Cache-lineage proof is limited to the openai-codex provider.";
  }
  return undefined;
}

function routeDriftReason(
  context: ExtensionContext,
  record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }>,
  expectedBaseUrl: string
): string | undefined {
  if (!context.model) return "Worker model is unavailable during Codex lineage verification.";
  if (
    context.model.provider !== record.provider ||
    context.model.id !== record.model ||
    context.model.api !== CODEX_CACHE_LINEAGE_API ||
    normalizeCodexBaseUrl(context.model.baseUrl) !== expectedBaseUrl ||
    String(context.thinkingLevel) !== record.thinkingLevel
  ) return "Worker provider/model/API/thinking route drifted from the persisted Codex lineage.";
  return undefined;
}

function parentCaptureFile(stateRoot: string, parentSessionFile: string): string {
  return path.join(path.resolve(stateRoot), ".cache-lineage", `${sha256(path.resolve(parentSessionFile))}.json`);
}

function freshLineage(reason: string): WorkerCacheLineageRecord {
  return { version: 1, mode: "fresh", reason: truncateUtf8(reason, 512) };
}

function guardManagedWorkerTool(toolNameValue: string): { block: true; reason: string; terminate: true } | undefined {
  if (MANAGED_WORKER_TOOL_NAME_SET.has(toolNameValue)) return undefined;
  return {
    block: true,
    reason: `Managed worker tool ${toolNameValue} is not authorized by the worker runtime allowlist.`,
    terminate: true
  };
}

function failClosedPayload(payload: unknown, marker: string): JsonObject {
  const original = isJsonObject(payload) ? cloneJsonObject(payload) : {};
  original.model = `pi-cache-lineage-blocked-${marker}`;
  original.input = [];
  original.tools = [];
  original.tool_choice = "none";
  delete original.previous_response_id;
  return original;
}

function isCodexHttpTarget(input: RequestInfo | URL): boolean {
  const raw = input instanceof Request ? input.url : input.toString();
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/responses";
  } catch {
    return false;
  }
}

function isCodexWebSocketTarget(input: string | URL): boolean {
  try {
    const url = new URL(input.toString());
    return url.protocol === "wss:" && url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/responses";
  } catch {
    return false;
  }
}

function writePrivateJson(file: string, value: unknown): void {
  writePrivateText(file, `${stringifyBounded(value, "cache-lineage state")}\n`);
}

function writePrivateText(file: string, text: string): void {
  if (Buffer.byteLength(text, "utf8") > WORKER_CACHE_LINEAGE_MAX_BYTES) throw new Error("Cache-lineage state exceeds its bounded size.");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function stringifyBounded(value: unknown, label: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > WORKER_CACHE_LINEAGE_MAX_BYTES) {
    throw new Error(`${label} exceeds the cache-lineage size bound.`);
  }
  return serialized;
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return structuredClone(value) as JsonObject;
}

function optionalObjectArray(value: unknown, label: string): JsonObject[] {
  if (value === undefined) return [];
  return asObjectArray(value, label);
}

function asObjectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value) || value.some((item) => !isJsonObject(item))) throw new Error(`${label} is not an object array.`);
  return value as JsonObject[];
}

function toolName(tool: JsonObject): string {
  if (tool.type !== "function" || typeof tool.name !== "string" || !tool.name) {
    throw new Error("Managed-worker Codex tool schema is not a named function.");
  }
  return tool.name;
}

function normalizeMarker(value: string): string {
  const marker = value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
  if (marker.length < 8) throw new Error("Cache-lineage marker is too short.");
  return marker;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readHeader(headers: Record<string, string | null | undefined>, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function setHeader(headers: Record<string, string | null | undefined>, name: string, value: string): void {
  const expected = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === expected) delete headers[key];
  }
  headers[name] = value;
}

function normalizeCodexBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function clampCodexSessionId(value: string): string {
  return Array.from(value).slice(0, 64).join("");
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = value;
  while (result && Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return result;
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 400) || "unknown cache-lineage validation failure";
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
