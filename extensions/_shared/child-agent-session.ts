import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ExtensionContext,
  type ExtensionError,
  type ExtensionFactory,
  type ExtensionUIContext,
  type LoadExtensionsResult,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { throwIfAborted } from "./cancellation.js";
import { assertChildAgentRouteAllowed } from "./model-spec.js";

export type ChildAgentSession = Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];

export type IsolatedChildSettings = {
  compaction: { enabled: false };
  retry: { enabled: false; maxRetries: 0; provider: { maxRetries: 0 } };
};

export function createIsolatedChildSettings(): IsolatedChildSettings {
  return {
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }
  };
}

export type ChildAgentSessionOptions = {
  cwd: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: string[];
  systemPrompts?: string[];
  customTools?: ToolDefinition[];
  extensionFactories?: ExtensionFactory[];
  /** Trusted in-process provider instrumentation applied only to this child session. */
  transformProvider?: (provider: Provider) => Provider;
  extensionsOverride?: (result: LoadExtensionsResult) => LoadExtensionsResult;
  onEvent?: (event: AgentSessionEvent) => void;
  onError?: (error: ExtensionError) => void;
  onWarning?: (message: string) => void;
  onInteractiveDenial?: (method: string, title: string) => void;
  /** Exact trusted system prompt plus in-memory settings and empty ambient resources. */
  isolatedSystemPrompt?: string;
  signal?: AbortSignal;
};

export async function withChildAgentSession<T>(
  context: Pick<ExtensionContext, "modelRegistry" | "ui">,
  options: ChildAgentSessionOptions,
  run: (session: ChildAgentSession) => Promise<T>
): Promise<T> {
  throwIfAborted(options.signal);
  assertChildAgentRouteAllowed(options.model, options.thinkingLevel);
  const tools = uniqueStrings(options.tools);
  const isolatedSystemPrompt = options.isolatedSystemPrompt?.trim();
  if (options.isolatedSystemPrompt !== undefined && !isolatedSystemPrompt) {
    throw new Error("An isolated child session requires a non-empty trusted system prompt.");
  }
  if (isolatedSystemPrompt && options.systemPrompts?.length) {
    throw new Error("An isolated child session cannot also append ambient system prompts.");
  }
  const services = await createAgentSessionServices({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    settingsManager: isolatedSystemPrompt ? SettingsManager.inMemory(createIsolatedChildSettings()) : undefined,
    resourceLoaderOptions: {
      ...(isolatedSystemPrompt ? {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: isolatedSystemPrompt,
        appendSystemPrompt: [],
        skillsOverride: () => ({ skills: [], diagnostics: [] }),
        promptsOverride: () => ({ prompts: [], diagnostics: [] }),
        themesOverride: () => ({ themes: [], diagnostics: [] }),
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        systemPromptOverride: () => isolatedSystemPrompt,
        appendSystemPromptOverride: () => []
      } : {
        appendSystemPromptOverride: options.systemPrompts?.length
          ? (base: string[]) => [...base, ...options.systemPrompts!.filter((prompt) => prompt.trim()).map((prompt) => prompt.trim())]
          : undefined,
        extensionsOverride: options.extensionsOverride
      }),
      extensionFactories: [
        createChildToolAllowlistExtension(tools),
        ...(options.extensionFactories ?? [])
      ]
    }
  });

  throwIfAborted(options.signal);
  const errors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
  if (errors.length > 0) {
    throw new Error(`Child session failed to load resources: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`);
  }
  for (const warning of services.diagnostics.filter((diagnostic) => diagnostic.type === "warning")) {
    options.onWarning?.(warning.message);
  }

  const parentProvider = context.modelRegistry.getProvider(options.model.provider);
  if (parentProvider) {
    const childProvider = options.transformProvider?.(parentProvider) ?? parentProvider;
    if (childProvider.id !== parentProvider.id) {
      throw new Error("Child provider instrumentation cannot change provider identity.");
    }
    services.modelRuntime.registerNativeProvider(childProvider);
  }
  if (await services.modelRuntime.getAuth(options.model) === undefined) {
    const parentAuth = await context.modelRegistry.getApiKeyAndHeaders(options.model);
    if (parentAuth.ok && parentAuth.apiKey) {
      await services.modelRuntime.setRuntimeApiKey(options.model.provider, parentAuth.apiKey);
    }
  }

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(options.cwd),
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    tools,
    customTools: options.customTools
  });
  const unsubscribe = options.onEvent ? session.subscribe(options.onEvent) : undefined;
  let abortPromise: Promise<void> | undefined;
  const abort = (): void => {
    abortPromise ??= session.abort();
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  try {
    await session.bindExtensions({
      uiContext: createFailClosedChildUI(context.ui, options.onInteractiveDenial),
      shutdownHandler: abort,
      onError: (error) => {
        if (options.onError) options.onError(error);
        else context.ui.notify(`Child extension error: ${formatExtensionError(error)}`, "warning");
      }
    });
    throwIfAborted(options.signal);
    const result = await run(session);
    throwIfAborted(options.signal);
    return result;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (abortPromise !== undefined) {
      await abortPromise;
    }
    unsubscribe?.();
    session.dispose();
  }
}

/**
 * Child sessions are never allowed to prompt the human. Interactive dialog
 * requests deterministically resolve to their declined value (confirm=false,
 * select/input/editor=undefined) with a parent notification, so extensions
 * like tool-safety fail closed instead of stacking mid-run dialogs or
 * hanging non-interactive orchestration.
 */
export function createFailClosedChildUI(
  parent: ExtensionUIContext,
  onDenial?: (method: string, title: string) => void
): ExtensionUIContext {
  const deny = (method: string, title: string): void => {
    parent.notify(`Child session denied interactive ${method}(${JSON.stringify(title)}): child sessions fail closed and cannot prompt the user.`, "warning");
    onDenial?.(method, title);
  };
  return new Proxy(parent, {
    get(target, property, receiver) {
      if (property === "confirm") return async (title: string) => { deny("confirm", title); return false; };
      if (property === "select") return async (title: string) => { deny("select", title); return undefined; };
      if (property === "input") return async (title: string) => { deny("input", title); return undefined; };
      if (property === "editor") return async (title: string) => { deny("editor", title); return undefined; };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as ExtensionUIContext;
}

export function createChildToolAllowlistExtension(toolNames: string[]): ExtensionFactory {
  const allowedToolNames = uniqueStrings(toolNames);
  return (api) => {
    const enforceAllowlist = () => api.setActiveTools(allowedToolNames);
    api.on("session_start", enforceAllowlist);
    api.on("session_tree", enforceAllowlist);
    api.on("before_agent_start", enforceAllowlist);
  };
}

export function validateChildToolAllowlist(
  availableTools: Array<{ name: string }>,
  toolNames: string[],
  label: string,
  configSource: string
): void {
  const available = new Set(availableTools.map((tool) => tool.name));
  const missing = uniqueStrings(toolNames).filter((toolName) => !available.has(toolName));
  if (missing.length === 0) return;
  throw new Error([
    `${label} configured tools are unavailable: ${missing.join(", ")}.`,
    `Config source: ${configSource}.`,
    "Adjust extension settings, package filters, or loaded extensions, then run /reload."
  ].join(" "));
}

function formatExtensionError(error: ExtensionError): string {
  return `${error.extensionPath} ${error.event}: ${error.error}`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
