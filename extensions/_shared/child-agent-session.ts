import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSessionEvent,
  type ExtensionContext,
  type ExtensionError,
  type ExtensionFactory,
  type ExtensionUIContext,
  type LoadExtensionsResult,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";

export type ChildAgentSession = Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];

export type ChildAgentSessionOptions = {
  cwd: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: string[];
  systemPrompts?: string[];
  customTools?: ToolDefinition[];
  extensionFactories?: ExtensionFactory[];
  extensionsOverride?: (result: LoadExtensionsResult) => LoadExtensionsResult;
  onEvent?: (event: AgentSessionEvent) => void;
  onError?: (error: ExtensionError) => void;
  onWarning?: (message: string) => void;
  onInteractiveDenial?: (method: string, title: string) => void;
  signal?: AbortSignal;
};

export async function withChildAgentSession<T>(
  context: Pick<ExtensionContext, "modelRegistry" | "ui">,
  options: ChildAgentSessionOptions,
  run: (session: ChildAgentSession) => Promise<T>
): Promise<T> {
  const tools = uniqueStrings(options.tools);
  const services = await createAgentSessionServices({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    modelRegistry: context.modelRegistry,
    resourceLoaderOptions: {
      appendSystemPromptOverride: options.systemPrompts?.length
        ? (base) => [...base, ...options.systemPrompts!.filter((prompt) => prompt.trim()).map((prompt) => prompt.trim())]
        : undefined,
      extensionFactories: [
        createChildToolAllowlistExtension(tools),
        ...(options.extensionFactories ?? [])
      ],
      extensionsOverride: options.extensionsOverride
    }
  });

  const errors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
  if (errors.length > 0) {
    throw new Error(`Child session failed to load resources: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`);
  }
  for (const warning of services.diagnostics.filter((diagnostic) => diagnostic.type === "warning")) {
    options.onWarning?.(warning.message);
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
  const abort = () => void session.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  await session.bindExtensions({
    uiContext: createFailClosedChildUI(context.ui, options.onInteractiveDenial),
    shutdownHandler: abort,
    onError: (error) => {
      if (options.onError) options.onError(error);
      else context.ui.notify(`Child extension error: ${formatExtensionError(error)}`, "warning");
    }
  });

  try {
    return await run(session);
  } finally {
    options.signal?.removeEventListener("abort", abort);
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
