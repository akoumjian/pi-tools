import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

/** Add the Pi 1.5 tool-only context surface to direct-execution fixtures. */
export function extensionToolContext<T extends ExtensionContext>(context: T): T & ExtensionToolContext {
  return Object.assign(context, {
    tools: [] as ExtensionToolContext["tools"],
    executeTool: async (): ReturnType<ExtensionToolContext["executeTool"]> => {
      throw new Error("Nested tool execution is not configured for this fixture.");
    }
  });
}
