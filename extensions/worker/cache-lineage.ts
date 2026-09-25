import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
const CAPTURE_HOLDER_VERSION = 2;
const ADOPTION_VERSION = 3;
const LINEAGE_SUMMARY_VERSION = 1;
const RETIREMENT_VERSION = 1;
const CAPTURE_HOLDER_MAX_SESSIONS = 4;

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
      retirementFile: string;
      summaryFile: string;
    };

type PendingParentHeaders = {
  provider: typeof CODEX_CACHE_LINEAGE_PROVIDER;
  api: typeof CODEX_CACHE_LINEAGE_API;
  model: string;
  baseUrl: string;
  thinkingLevel: string;
  parentSessionFileSha256: string;
  parentSessionIdSha256: string;
  candidateCacheAffinitySessionId: string;
  observedCacheAffinitySessionId?: string;
  capturedAt: string;
};
type CaptureHolder = {
  version: typeof CAPTURE_HOLDER_VERSION;
  generation: number;
  pendingHeadersBySessionFile: Map<string, PendingParentHeaders>;
  latestBySessionFile: Map<string, ParentCacheLineageCapture & { generation: number }>;
};

export type WorkerCacheLineageSummary = {
  mode: "eligible" | "adopted" | "fresh" | "retired" | "failed" | "unavailable";
  reason?: string;
};

export type WorkerCacheLineageRuntimeStatus = WorkerCacheLineageSummary;

type PersistedLineageSummary = {
  version: typeof LINEAGE_SUMMARY_VERSION;
  markerSha256: string;
  snapshotSha256: string;
  mode: "eligible" | "adopted" | "fresh" | "retired" | "failed";
  reason?: string;
};

function captureHolder(): CaptureHolder {
  const existing = Reflect.get(globalThis, CAPTURE_HOLDER_KEY) as Partial<CaptureHolder> | undefined;
  if (
    existing !== undefined &&
    existing !== null &&
    typeof existing === "object" &&
    existing.version === CAPTURE_HOLDER_VERSION &&
    typeof existing.generation === "number" &&
    existing.pendingHeadersBySessionFile instanceof Map &&
    existing.latestBySessionFile instanceof Map
  ) return existing as CaptureHolder;
  const created: CaptureHolder = {
    version: CAPTURE_HOLDER_VERSION,
    generation: 0,
    pendingHeadersBySessionFile: new Map(),
    latestBySessionFile: new Map()
  };
  Reflect.set(globalThis, CAPTURE_HOLDER_KEY, created);
  return created;
}

export function registerParentCacheLineageCapture(
  api: ExtensionAPI,
  stateRoot: string,
  now: () => Date = () => new Date()
): void {
  const holder = captureHolder();
  const generation = ++holder.generation;
  holder.pendingHeadersBySessionFile.clear();
  holder.latestBySessionFile.clear();
  // Version 1 wrote one parent artifact per session. Snapshots are self-contained,
  // so these legacy request-time files are unreferenced and safe to prune.
  rmSync(path.join(path.resolve(stateRoot), ".cache-lineage"), { recursive: true, force: true });

  // Pi 0.84.4 applies ModelRuntime.transformHeaders before the Codex adapter calls
  // onPayload. Record only small route/header metadata here; pair it with the
  // subsequently emitted payload in before_provider_request.
  api.on("before_provider_headers", (event, context) => {
    if (holder.generation !== generation || process.env.PI_WORKER_ID) return;
    const sessionFile = context.sessionManager.getSessionFile();
    const model = context.model;
    if (!sessionFile) return;
    const resolvedSessionFile = path.resolve(sessionFile);
    holder.latestBySessionFile.delete(resolvedSessionFile);
    if (
      !model ||
      model.provider !== CODEX_CACHE_LINEAGE_PROVIDER ||
      model.api !== CODEX_CACHE_LINEAGE_API
    ) return;
    const candidateCacheAffinitySessionId = clampCodexSessionId(context.sessionManager.getSessionId());
    setBoundedCaptureEntry(holder.pendingHeadersBySessionFile, resolvedSessionFile, {
      provider: CODEX_CACHE_LINEAGE_PROVIDER,
      api: CODEX_CACHE_LINEAGE_API,
      model: model.id,
      baseUrl: normalizeCodexBaseUrl(model.baseUrl),
      thinkingLevel: String(context.thinkingLevel),
      parentSessionFileSha256: sha256(resolvedSessionFile),
      parentSessionIdSha256: sha256(context.sessionManager.getSessionId()),
      candidateCacheAffinitySessionId,
      observedCacheAffinitySessionId: boundedCodexSessionHeader(event.headers),
      capturedAt: now().toISOString()
    });
  });

  api.on("before_provider_request", (event, context) => {
    if (holder.generation !== generation || process.env.PI_WORKER_ID) return;
    const sessionFile = context.sessionManager.getSessionFile();
    const model = context.model;
    if (!sessionFile || !model || !isJsonObject(event.payload)) return;
    const resolvedSessionFile = path.resolve(sessionFile);
    const pending = holder.pendingHeadersBySessionFile.get(resolvedSessionFile);
    holder.pendingHeadersBySessionFile.delete(resolvedSessionFile);
    if (
      !pending ||
      pending.provider !== model.provider ||
      pending.api !== model.api ||
      pending.model !== model.id ||
      pending.baseUrl !== normalizeCodexBaseUrl(model.baseUrl) ||
      pending.thinkingLevel !== String(context.thinkingLevel)
    ) return;
    if (!jsonValueFitsBound(event.payload, WORKER_CACHE_LINEAGE_MAX_BYTES)) {
      holder.latestBySessionFile.delete(resolvedSessionFile);
      return;
    }
    const cacheAffinitySessionId = pending.observedCacheAffinitySessionId ?? (
      event.payload.prompt_cache_key === pending.candidateCacheAffinitySessionId
        ? pending.candidateCacheAffinitySessionId
        : undefined
    );
    if (!cacheAffinitySessionId) {
      holder.latestBySessionFile.delete(resolvedSessionFile);
      return;
    }
    const data: ParentCaptureData = {
      version: 1,
      api: CODEX_CACHE_LINEAGE_API,
      provider: CODEX_CACHE_LINEAGE_PROVIDER,
      model: pending.model,
      baseUrl: pending.baseUrl,
      thinkingLevel: pending.thinkingLevel,
      parentSessionFileSha256: pending.parentSessionFileSha256,
      parentSessionIdSha256: pending.parentSessionIdSha256,
      capturedAt: pending.capturedAt,
      payload: event.payload,
      payloadSha256: "",
      cacheAffinitySessionId
    };
    setBoundedCaptureEntry(holder.latestBySessionFile, resolvedSessionFile, {
      data,
      integritySha256: "",
      generation
    });
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
  const resolvedParentSessionFile = path.resolve(input.parentSessionFile);
  const holder = captureHolder();
  const heldCapture = holder.latestBySessionFile.get(resolvedParentSessionFile);
  if (!heldCapture || heldCapture.generation !== holder.generation) {
    return freshLineage("No validated parent Codex request capture is available.");
  }
  const now = input.now ?? new Date();
  const ageMs = now.getTime() - Date.parse(heldCapture.data.capturedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > WORKER_CACHE_LINEAGE_MAX_AGE_MS) {
    return freshLineage("Parent Codex request capture is stale.");
  }
  if (
    heldCapture.data.parentSessionFileSha256 !== sha256(resolvedParentSessionFile) ||
    heldCapture.data.parentSessionIdSha256 !== sha256(input.parentSessionId)
  ) {
    return freshLineage("Parent Codex request capture is bound to another parent session.");
  }
  if (
    heldCapture.data.provider !== input.route.provider ||
    heldCapture.data.model !== input.route.model ||
    heldCapture.data.thinkingLevel !== input.route.thinkingLevel
  ) {
    return freshLineage("Parent Codex request capture route does not exactly match the worker route.");
  }
  const payloadJson = tryStringifyBounded(heldCapture.data.payload);
  if (payloadJson === undefined) return freshLineage("The latest parent Codex request exceeds the bounded snapshot limit.");
  const payload: unknown = JSON.parse(payloadJson);
  if (!isJsonObject(payload)) return freshLineage("The latest parent Codex request is not a JSON object.");
  const data: ParentCaptureData = { ...heldCapture.data, payload, payloadSha256: sha256(payloadJson) };
  const capture: ParentCacheLineageCapture = {
    data,
    integritySha256: sha256(stringifyBounded(data, "parent Codex lineage data"))
  };
  mkdirSync(input.workerStateDir, { recursive: true, mode: 0o700 });
  const snapshotFile = path.join(input.workerStateDir, "cache-lineage.json");
  const snapshotJson = stringifyBounded(capture, "worker cache-lineage snapshot");
  writePrivateText(snapshotFile, `${snapshotJson}\n`);
  const marker = normalizeMarker(input.marker ?? randomUUID());
  const record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }> = {
    version: 1,
    mode: "eligible",
    provider: CODEX_CACHE_LINEAGE_PROVIDER,
    model: input.route.model,
    thinkingLevel: input.route.thinkingLevel,
    snapshotFile,
    snapshotSha256: sha256(`${snapshotJson}\n`),
    marker,
    adoptionFile: path.join(input.workerStateDir, "cache-lineage-adopted.json"),
    fallbackFile: path.join(input.workerStateDir, "cache-lineage-fallback.json"),
    retirementFile: path.join(input.workerStateDir, "cache-lineage-retired.json"),
    summaryFile: path.join(input.workerStateDir, "cache-lineage-summary.json")
  };
  writeLineageSummary(record, "eligible");
  return record;
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
    typeof value.retirementFile === "string" && path.isAbsolute(value.retirementFile) && path.basename(value.retirementFile) === "cache-lineage-retired.json" &&
    typeof value.summaryFile === "string" && path.isAbsolute(value.summaryFile) && path.basename(value.summaryFile) === "cache-lineage-summary.json" &&
    path.dirname(value.snapshotFile) === path.dirname(value.adoptionFile) &&
    path.dirname(value.snapshotFile) === path.dirname(value.fallbackFile) &&
    path.dirname(value.snapshotFile) === path.dirname(value.retirementFile) &&
    path.dirname(value.snapshotFile) === path.dirname(value.summaryFile);
}

export function summarizeWorkerCacheLineage(
  record: WorkerCacheLineageRecord | undefined
): WorkerCacheLineageSummary | undefined {
  if (!record) return undefined;
  if (record.mode === "fresh") return { mode: "fresh", reason: record.reason };
  try {
    return readLineageSummary(record);
  } catch {
    return { mode: "unavailable", reason: "Cache-lineage summary is unavailable or invalid." };
  }
}
export type WorkerCacheLineageRuntime = {
  transformPayload(payload: unknown, context: ExtensionContext): unknown;
  transformHeaders(headers: Record<string, string | null | undefined>, context: ExtensionContext): void;
  observeProviderResponse(status: number): void;
  observeAssistantMessage(message: unknown, context: ExtensionContext): void;
  retireAfterCompaction(reason: "manual" | "threshold" | "overflow"): void;
  guardTool(toolName: string): { block: true; reason: string; terminate: true } | undefined;
  status(): WorkerCacheLineageRuntimeStatus;
  restoreNetwork(): void;
};

export function registerWorkerCacheLineageRuntimeHooks(api: ExtensionAPI, cacheLineage: WorkerCacheLineageRuntime): void {
  api.on("before_provider_request", (event, context) => cacheLineage.transformPayload(event.payload, context));
  api.on("before_provider_headers", (event, context) => cacheLineage.transformHeaders(event.headers, context));
  api.on("after_provider_response", (event) => cacheLineage.observeProviderResponse(event.status));
  api.on("message_end", (event, context) => cacheLineage.observeAssistantMessage(event.message, context));
  api.on("session_compact", (event) => cacheLineage.retireAfterCompaction(event.reason));
  api.on("tool_call", (event) => cacheLineage.guardTool(event.toolName));
  api.on("session_shutdown", () => cacheLineage.restoreNetwork());
}

export function createWorkerCacheLineageRuntime(record: WorkerCacheLineageRecord | undefined): WorkerCacheLineageRuntime {
  if (!record || record.mode === "fresh") {
    return {
      transformPayload: (payload) => payload,
      transformHeaders: () => {},
      observeProviderResponse: () => {},
      observeAssistantMessage: () => {},
      retireAfterCompaction: () => {},
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
    observeProviderResponse: (status) => controller.observeProviderResponse(status),
    observeAssistantMessage: (message, context) => controller.observeAssistantMessage(message, context),
    retireAfterCompaction: (reason) => controller.retireAfterCompaction(reason),
    guardTool: guardManagedWorkerTool,
    status: () => controller.status(),
    restoreNetwork: () => controller.restoreNetwork()
  };
}

type AdoptionState = {
  workerToolsSha256: string;
  workerInstructionsSha256: string;
  forkBoundarySha256: string;
  initialAssignmentSha256: string;
  preAssignmentItemsSha256: string;
  assignmentInputIndex: number;
};

type RetirementState = {
  reason: string;
  firstFreshRequestPending: boolean;
};

class EligibleRuntimeController {
  private readonly capture: ParentCacheLineageCapture;
  private adoption: AdoptionState | undefined;
  private pendingAdoption: AdoptionState | undefined;
  private disabledReason: string | undefined;
  private retired: RetirementState | undefined;
  private retiredFreshRequestInFlight = false;
  private fatalReason: string | undefined;
  private networkArmed = false;
  private transportPayload: JsonObject | undefined;
  private originalFetch: typeof globalThis.fetch | undefined;
  private originalWebSocket: typeof globalThis.WebSocket | undefined;

  constructor(private readonly record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }>) {
    this.capture = readWorkerSnapshot(record);
    const hasAdoption = existsSync(record.adoptionFile);
    const hasFallback = existsSync(record.fallbackFile);
    const hasRetirement = existsSync(record.retirementFile);
    if (!hasRetirement && hasAdoption && hasFallback) {
      throw new Error("Worker cache-lineage has conflicting persisted decisions.");
    }
    if (hasRetirement) {
      this.retired = readRetirement(record.retirementFile, record, this.capture);
      writeLineageSummary(record, "retired", this.retired.reason);
    } else if (hasAdoption) {
      this.adoption = readAdoption(record.adoptionFile, record, this.capture);
      writeLineageSummary(record, "adopted");
    } else if (hasFallback) {
      this.disabledReason = readFallback(record.fallbackFile, record, this.capture);
      writeLineageSummary(record, "fresh", this.disabledReason);
    }
  }

  transformPayload(payload: unknown, context: ExtensionContext): unknown {
    if (this.fatalReason) {
      this.transportPayload = undefined;
      return failClosedPayload(payload, this.record.marker);
    }
    if (this.retired) return this.transformRetiredPayload(payload);
    if (this.disabledReason) {
      this.transportPayload = undefined;
      return stripPreviousResponseId(payload);
    }
    try {
      if (!this.adoption && this.pendingAdoption) {
        this.persistFallback("Initial Codex lineage request did not receive trusted provider acceptance.");
        return stripPreviousResponseId(payload);
      }
      const transformed = this.transformPayloadOrThrow(payload, context, this.adoption);
      if (!this.adoption) this.pendingAdoption = transformed.adoption;
      this.transportPayload = transformed.payload;
      this.networkArmed = true;
      return transformed.payload;
    } catch (error) {
      const reason = boundedReason(error);
      if (!this.adoption) {
        try {
          this.persistFallback(reason);
          return stripPreviousResponseId(payload);
        } catch (persistenceError) {
          this.setFatal(`Unable to persist pre-adoption fallback: ${boundedReason(persistenceError)}`);
          return failClosedPayload(payload, this.record.marker);
        }
      }
      this.setFatal(reason);
      return failClosedPayload(payload, this.record.marker);
    }
  }

  transformHeaders(headers: Record<string, string | null | undefined>, context: ExtensionContext): void {
    if (this.fatalReason) {
      this.networkArmed = true;
      return;
    }
    if (this.retired || this.disabledReason) {
      deleteHeader(headers, "session-id");
      this.networkArmed = false;
      this.transportPayload = undefined;
      return;
    }
    const drift = routeDriftReason(context, this.record, this.capture.data.baseUrl);
    if (drift) {
      if (this.adoption) {
        this.setFatal(drift);
      } else {
        try {
          this.persistFallback(drift);
        } catch (error) {
          this.setFatal(`Unable to persist pre-adoption fallback: ${boundedReason(error)}`);
        }
      }
      deleteHeader(headers, "session-id");
      return;
    }
    if (!this.adoption) return;
    setHeader(headers, "session-id", this.capture.data.cacheAffinitySessionId);
    // x-client-request-id intentionally remains the child's independent request identity.
    this.networkArmed = true;
  }

  observeProviderResponse(status: number): void {
    if (!Number.isInteger(status)) return;
    if (this.retired && this.retiredFreshRequestInFlight) {
      this.consumeRetiredFreshRequest();
      return;
    }
    if (!this.pendingAdoption) {
      if (this.adoption && status >= 200 && status < 300) this.networkArmed = false;
      return;
    }
    try {
      if (status >= 200 && status < 300) this.commitPendingAdoption();
      else this.persistFallback(`Initial Codex lineage request was rejected with HTTP status ${status}.`);
    } catch (error) {
      this.setFatal(`Unable to persist provider-observed lineage decision: ${boundedReason(error)}`);
    }
  }

  observeAssistantMessage(message: unknown, context: ExtensionContext): void {
    if (!isJsonObject(message)) return;
    if (
      this.retired &&
      this.retiredFreshRequestInFlight &&
      message.role === "assistant" &&
      message.provider === this.record.provider &&
      message.model === this.record.model &&
      message.api === CODEX_CACHE_LINEAGE_API
    ) {
      this.consumeRetiredFreshRequest();
      return;
    }
    if (!this.pendingAdoption) {
      if (
        this.adoption &&
        message.role === "assistant" &&
        message.provider === this.record.provider &&
        message.model === this.record.model &&
        message.api === CODEX_CACHE_LINEAGE_API
      ) this.networkArmed = false;
      return;
    }
    try {
      const drift = routeDriftReason(context, this.record, this.capture.data.baseUrl);
      if (drift) {
        this.persistFallback(drift);
        return;
      }
      if (
        message.role !== "assistant" ||
        message.provider !== this.record.provider ||
        message.model !== this.record.model ||
        message.api !== CODEX_CACHE_LINEAGE_API
      ) return;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        this.persistFallback("Initial Codex lineage request was not accepted by the provider.");
        return;
      }
      this.commitPendingAdoption();
    } catch (error) {
      this.setFatal(`Unable to persist provider-observed lineage decision: ${boundedReason(error)}`);
    }
  }

  retireAfterCompaction(reason: "manual" | "threshold" | "overflow"): void {
    if (this.retired || !this.adoption) return;
    const bounded = `Cache lineage retired after trusted Pi ${reason} compaction.`;
    const retirement = { reason: bounded, firstFreshRequestPending: true };
    try {
      writeRetirement(this.record.retirementFile, this.record, this.capture, retirement);
    } catch (error) {
      this.setFatal(`Unable to persist trusted compaction retirement: ${boundedReason(error)}`);
      return;
    }
    this.retired = retirement;
    this.adoption = undefined;
    this.pendingAdoption = undefined;
    this.disabledReason = undefined;
    this.fatalReason = undefined;
    this.networkArmed = false;
    this.transportPayload = undefined;
    writeLineageSummary(this.record, "retired", bounded);
  }

  status(): WorkerCacheLineageRuntimeStatus {
    if (this.fatalReason) return { mode: "failed", reason: this.fatalReason };
    if (this.retired) return { mode: "retired", reason: this.retired.reason };
    if (this.disabledReason) return { mode: "fresh", reason: this.disabledReason };
    return { mode: this.adoption ? "adopted" : "eligible" };
  }

  installNetworkGuards(): void {
    if (typeof globalThis.fetch === "function") {
      this.originalFetch = globalThis.fetch;
      const controller = this;
      globalThis.fetch = (async function lineageFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        if (!controller.networkArmed || !isCodexHttpTarget(input)) {
          return controller.originalFetch!.call(globalThis, input, init);
        }
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
      globalThis.WebSocket = new Proxy(Original, {
        construct(target, args, newTarget) {
          const [url, protocolsOrOptions, callerOptions] = args as [
            string | URL,
            string | string[] | Record<string, unknown> | undefined,
            Record<string, unknown> | undefined
          ];
          if (!controller.networkArmed || !isCodexWebSocketTarget(url)) return Reflect.construct(target, args, newTarget);
          controller.assertNetworkAllowed();
          if (typeof protocolsOrOptions === "string" || Array.isArray(protocolsOrOptions)) {
            const options = isJsonObject(callerOptions) ? { ...callerOptions } : {};
            const headers = new Headers(isJsonObject(options.headers) ? options.headers as Record<string, string> : undefined);
            headers.set("session-id", controller.capture.data.cacheAffinitySessionId);
            options.headers = Object.fromEntries(headers.entries());
            const socket = Reflect.construct(target, [url, protocolsOrOptions, options], newTarget) as WebSocket;
            return controller.guardWebSocketSend(socket);
          }
          const options = isJsonObject(protocolsOrOptions) ? { ...protocolsOrOptions } : {};
          const headers = new Headers(isJsonObject(options.headers) ? options.headers as Record<string, string> : undefined);
          headers.set("session-id", controller.capture.data.cacheAffinitySessionId);
          options.headers = Object.fromEntries(headers.entries());
          const socket = Reflect.construct(target, [url, options], newTarget) as WebSocket;
          return controller.guardWebSocketSend(socket);
        }
      }) as typeof globalThis.WebSocket;
    }
  }

  restoreNetwork(): void {
    if (this.originalFetch) globalThis.fetch = this.originalFetch;
    if (this.originalWebSocket) globalThis.WebSocket = this.originalWebSocket;
  }

  private guardWebSocketSend(socket: WebSocket): WebSocket {
    const originalSend = socket.send.bind(socket);
    socket.send = ((data: Parameters<WebSocket["send"]>[0]) => {
      if (!this.networkArmed) return originalSend(data);
      this.assertNetworkAllowed();
      if (!this.transportPayload || typeof data !== "string") {
        throw new Error("Managed-worker Codex WebSocket request cannot prove its full replay payload.");
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(data);
      } catch {
        throw new Error("Managed-worker Codex WebSocket request is not valid JSON.");
      }
      if (!isJsonObject(envelope) || envelope.type !== "response.create") {
        throw new Error("Managed-worker Codex WebSocket request is not a response.create frame.");
      }
      return originalSend(JSON.stringify({ ...this.transportPayload, type: "response.create" }));
    }) as WebSocket["send"];
    return socket;
  }

  private transformPayloadOrThrow(
    payload: unknown,
    context: ExtensionContext,
    adoption: AdoptionState | undefined
  ): { payload: JsonObject; adoption: AdoptionState } {
    const drift = routeDriftReason(context, this.record, this.capture.data.baseUrl);
    if (drift) throw new Error(drift);
    if (!isJsonObject(payload)) throw new Error("Worker Codex provider payload is not an object.");
    if (payload.model !== this.record.model) throw new Error("Worker Codex payload model drifted before lineage adoption.");
    const workerInstructions = boundedWorkerInstructions(payload.instructions);
    const workerInstructionsSha256 = sha256(workerInstructions);
    const currentInput = asObjectArray(payload.input, "worker Codex input");
    const parentInput = asObjectArray(this.capture.data.payload.input, "captured parent Codex input");
    if (currentInput.length < parentInput.length || !equalJson(currentInput.slice(0, parentInput.length), parentInput)) {
      throw new Error("Worker Codex input does not preserve the exact captured parent prefix.");
    }
    const rawSuffix = currentInput.slice(parentInput.length);
    const workerTools = collectWorkerTools(payload, rawSuffix);
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
        if (!equalJson(inherited, workerTool)) throw new Error(`Inherited parent tool schema conflicts with managed-worker tool ${name}.`);
      } else {
        appendedTools.push(workerTool);
      }
    }

    let assignmentInputIndex: number;
    if (adoption) {
      assignmentInputIndex = adoption.assignmentInputIndex;
      if (assignmentInputIndex < parentInput.length || assignmentInputIndex >= currentInput.length) {
        throw new Error("Managed-worker initial assignment position drifted after Codex lineage adoption.");
      }
    } else {
      const markerOccurrences = rawSuffix.reduce(
        (total, item) => total + markerOccurrencesInInputItem(item, this.record.marker),
        0
      );
      const markerIndexes = rawSuffix.flatMap((item, index) =>
        inputItemContainsMarker(item, this.record.marker) ? [parentInput.length + index] : []
      );
      if (markerOccurrences !== 1 || markerIndexes.length !== 1) {
        throw new Error(`Worker Codex input must contain exactly one initial assignment marker; found ${markerOccurrences}.`);
      }
      assignmentInputIndex = markerIndexes[0]!;
    }
    const initialAssignment = currentInput[assignmentInputIndex]!;
    const initialAssignmentSha256 = sha256(stringifyBounded(initialAssignment, "managed-worker initial assignment"));
    const preAssignmentItems = currentInput.slice(parentInput.length, assignmentInputIndex);
    const preAssignmentItemsSha256 = sha256(stringifyBounded(preAssignmentItems, "managed-worker pre-assignment items"));

    const boundary: JsonObject[] = [];
    if (appendedTools.length > 0) boundary.push({ type: "additional_tools", role: "developer", tools: appendedTools });
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
    const nextAdoption: AdoptionState = {
      workerToolsSha256: sha256(stringifyBounded(workerTools, "managed-worker Codex tool schemas")),
      workerInstructionsSha256,
      forkBoundarySha256: sha256(stringifyBounded(boundary, "managed-worker Codex fork boundary")),
      initialAssignmentSha256,
      preAssignmentItemsSha256,
      assignmentInputIndex
    };
    if (adoption) assertAdoptionUnchanged(adoption, nextAdoption);

    const suffixBeforeAssignment = currentInput
      .slice(parentInput.length, assignmentInputIndex)
      .filter((item) => item.type !== "additional_tools");
    const suffixFromAssignment = currentInput
      .slice(assignmentInputIndex)
      .filter((item) => item.type !== "additional_tools");
    const transformed = cloneJsonObject(this.capture.data.payload);
    transformed.input = [...parentInput, ...suffixBeforeAssignment, ...boundary, ...suffixFromAssignment];
    transformed.tool_choice = {
      type: "allowed_tools",
      mode: "auto",
      tools: workerToolNames.map((name) => ({ type: "function", name }))
    };
    delete transformed.previous_response_id;
    return { payload: transformed, adoption: nextAdoption };
  }

  private transformRetiredPayload(payload: unknown): unknown {
    this.networkArmed = false;
    this.transportPayload = undefined;
    if (!this.retired?.firstFreshRequestPending) return payload;
    this.retiredFreshRequestInFlight = true;
    return stripPreviousResponseId(payload);
  }

  private consumeRetiredFreshRequest(): void {
    if (!this.retired?.firstFreshRequestPending) return;
    const next = { ...this.retired, firstFreshRequestPending: false };
    try {
      writeRetirement(this.record.retirementFile, this.record, this.capture, next);
      this.retired = next;
      this.retiredFreshRequestInFlight = false;
    } catch (error) {
      this.setFatal(`Unable to persist post-compaction fresh request: ${boundedReason(error)}`);
    }
  }

  private commitPendingAdoption(): void {
    if (!this.pendingAdoption || this.adoption || this.retired || this.disabledReason) return;
    writeAdoption(this.record.adoptionFile, this.record, this.capture, this.pendingAdoption);
    this.adoption = this.pendingAdoption;
    this.pendingAdoption = undefined;
    this.networkArmed = false;
    this.transportPayload = undefined;
    writeLineageSummary(this.record, "adopted");
  }

  private persistFallback(reason: string): void {
    const bounded = boundedTextReason(reason);
    writeFallback(this.record.fallbackFile, this.record, this.capture, bounded);
    this.pendingAdoption = undefined;
    this.disabledReason = bounded;
    this.networkArmed = false;
    this.transportPayload = undefined;
    writeLineageSummary(this.record, "fresh", bounded);
  }

  private setFatal(reason: string): void {
    this.fatalReason = boundedTextReason(reason);
    this.networkArmed = true;
    this.transportPayload = undefined;
    try {
      writeLineageSummary(this.record, "failed", this.fatalReason);
    } catch {
      // Transport remains fail-closed even when diagnostic persistence fails.
    }
  }

  private assertNetworkAllowed(): void {
    if (this.fatalReason) throw new Error(`Managed-worker Codex cache lineage failed closed: ${this.fatalReason}`);
    if (!this.adoption && !this.pendingAdoption) {
      throw new Error("Managed-worker Codex cache lineage was not verified before transport.");
    }
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
    typeof data.cacheAffinitySessionId !== "string" || !data.cacheAffinitySessionId || Array.from(data.cacheAffinitySessionId).length > 64
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
  adoption: AdoptionState
): void {
  const value = {
    version: ADOPTION_VERSION,
    marker: record.marker,
    snapshotSha256: record.snapshotSha256,
    payloadSha256: capture.data.payloadSha256,
    markerSha256: sha256(record.marker),
    provider: record.provider,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    ...adoption
  };
  if (existsSync(file)) {
    assertAdoptionUnchanged(readAdoption(file, record, capture), adoption);
    return;
  }
  writePrivateJson(file, value);
}

function readAdoption(
  file: string,
  record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }>,
  capture: ParentCacheLineageCapture
): AdoptionState {
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
    typeof value.initialAssignmentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.initialAssignmentSha256) ||
    typeof value.preAssignmentItemsSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.preAssignmentItemsSha256) ||
    !Number.isInteger(value.assignmentInputIndex) || (value.assignmentInputIndex as number) < 0 || (value.assignmentInputIndex as number) > 1_000_000
  ) throw new Error("Worker cache-lineage adoption marker does not match its persisted lineage.");
  return {
    workerToolsSha256: value.workerToolsSha256,
    workerInstructionsSha256: value.workerInstructionsSha256,
    forkBoundarySha256: value.forkBoundarySha256,
    initialAssignmentSha256: value.initialAssignmentSha256,
    preAssignmentItemsSha256: value.preAssignmentItemsSha256,
    assignmentInputIndex: value.assignmentInputIndex as number
  };
}

function assertAdoptionUnchanged(expected: AdoptionState, actual: AdoptionState): void {
  const checks: Array<[keyof AdoptionState, string]> = [
    ["workerToolsSha256", "Managed-worker tool schemas drifted after Codex lineage adoption."],
    ["workerInstructionsSha256", "Managed-worker system instructions drifted after Codex lineage adoption."],
    ["forkBoundarySha256", "Managed-worker fork boundary drifted after Codex lineage adoption."],
    ["initialAssignmentSha256", "Managed-worker initial assignment drifted after Codex lineage adoption."],
    ["preAssignmentItemsSha256", "Managed-worker pre-assignment history drifted after Codex lineage adoption."],
    ["assignmentInputIndex", "Managed-worker initial assignment position drifted after Codex lineage adoption."]
  ];
  for (const [field, message] of checks) {
    if (expected[field] !== actual[field]) throw new Error(message);
  }
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

function writeRetirement(
  file: string,
  record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }>,
  capture: ParentCacheLineageCapture,
  retirement: RetirementState
): void {
  writePrivateJson(file, {
    version: RETIREMENT_VERSION,
    markerSha256: sha256(record.marker),
    snapshotSha256: record.snapshotSha256,
    payloadSha256: capture.data.payloadSha256,
    provider: record.provider,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    reason: truncateUtf8(retirement.reason, 400),
    firstFreshRequestPending: retirement.firstFreshRequestPending
  });
}

function readRetirement(
  file: string,
  record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }>,
  capture: ParentCacheLineageCapture
): RetirementState {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 4096) {
    throw new Error("Worker cache-lineage retirement marker is invalid.");
  }
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !isJsonObject(value) ||
    value.version !== RETIREMENT_VERSION ||
    value.markerSha256 !== sha256(record.marker) ||
    value.snapshotSha256 !== record.snapshotSha256 ||
    value.payloadSha256 !== capture.data.payloadSha256 ||
    value.provider !== record.provider ||
    value.model !== record.model ||
    value.thinkingLevel !== record.thinkingLevel ||
    typeof value.reason !== "string" || !value.reason || Buffer.byteLength(value.reason, "utf8") > 400 ||
    typeof value.firstFreshRequestPending !== "boolean"
  ) throw new Error("Worker cache-lineage retirement marker does not match its persisted lineage.");
  return { reason: value.reason, firstFreshRequestPending: value.firstFreshRequestPending };
}

function writeLineageSummary(
  record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }>,
  mode: PersistedLineageSummary["mode"],
  reason?: string
): void {
  try {
    writePrivateJson(record.summaryFile, {
      version: LINEAGE_SUMMARY_VERSION,
      markerSha256: sha256(record.marker),
      snapshotSha256: record.snapshotSha256,
      mode,
      ...(reason ? { reason: truncateUtf8(reason, 512) } : {})
    });
  } catch {
    // Never leave stale observational state after an authoritative transition.
    try { rmSync(record.summaryFile, { force: true }); } catch {}
  }
}

function readLineageSummary(
  record: Extract<WorkerCacheLineageRecord, { mode: "eligible" }>
): WorkerCacheLineageSummary {
  const metadata = lstatSync(record.summaryFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 2048) {
    throw new Error("Worker cache-lineage summary is invalid.");
  }
  const value: unknown = JSON.parse(readFileSync(record.summaryFile, "utf8"));
  if (
    !isJsonObject(value) ||
    value.version !== LINEAGE_SUMMARY_VERSION ||
    value.markerSha256 !== sha256(record.marker) ||
    value.snapshotSha256 !== record.snapshotSha256 ||
    !["eligible", "adopted", "fresh", "retired", "failed"].includes(String(value.mode)) ||
    (value.reason !== undefined && (typeof value.reason !== "string" || !value.reason || Buffer.byteLength(value.reason, "utf8") > 512))
  ) throw new Error("Worker cache-lineage summary does not match its record.");
  return {
    mode: value.mode as WorkerCacheLineageSummary["mode"],
    ...(typeof value.reason === "string" ? { reason: value.reason } : {})
  };
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

function stripPreviousResponseId(payload: unknown): unknown {
  if (!isJsonObject(payload) || payload.previous_response_id === undefined) return payload;
  const stripped = cloneJsonObject(payload);
  delete stripped.previous_response_id;
  return stripped;
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
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function setBoundedCaptureEntry<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > CAPTURE_HOLDER_MAX_SESSIONS) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function jsonValueFitsBound(value: unknown, maxBytes: number): boolean {
  try {
    const seen = new WeakSet<object>();
    let budget = maxBytes;
    const stack: unknown[] = [value];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === null || typeof current === "boolean") budget -= 5;
      else if (typeof current === "number") budget -= 32;
      else if (typeof current === "string") budget -= current.length * 6 + 2;
      else if (Array.isArray(current)) {
        if (seen.has(current)) return false;
        seen.add(current);
        budget -= current.length + 2;
        for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
      } else if (isJsonObject(current)) {
        if (seen.has(current)) return false;
        seen.add(current);
        const entries = Object.entries(current);
        budget -= entries.length + 2;
        for (const [key, child] of entries) {
          budget -= key.length * 6 + 3;
          if (typeof child === "undefined" || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") return false;
          stack.push(child);
        }
      } else return false;
      if (budget < 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function tryStringifyBounded(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > WORKER_CACHE_LINEAGE_MAX_BYTES) return undefined;
    return serialized;
  } catch {
    return undefined;
  }
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

function boundedCodexSessionHeader(headers: Record<string, string | null | undefined>): string | undefined {
  const value = readHeader(headers, "session-id");
  return value && Array.from(value).length <= 64 ? value : undefined;
}

function setHeader(headers: Record<string, string | null | undefined>, name: string, value: string): void {
  const expected = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === expected) delete headers[key];
  }
  headers[name] = value;
}

function deleteHeader(headers: Record<string, string | null | undefined>, name: string): void {
  const expected = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === expected) delete headers[key];
  }
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

function boundedTextReason(value: string): string {
  return truncateUtf8(value.replace(/\s+/g, " ").trim() || "unknown cache-lineage state transition", 400);
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundedTextReason(message || "unknown cache-lineage validation failure");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
