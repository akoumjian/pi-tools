import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand
} from "@earendil-works/pi-coding-agent";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

/**
 * Register a slash command under its primary (namespaced) name plus any number
 * of deprecated kebab-style aliases. Aliases delegate to the same handler but
 * emit a one-line deprecation warning before running so users migrate to the
 * new name.
 *
 * Aliases that match the primary name are silently skipped to make this safe
 * to call with build-time flags.
 */
export function registerCommandWithAliases(
  api: ExtensionAPI,
  primaryName: string,
  options: CommandOptions,
  deprecatedAliases: readonly string[]
): void {
  api.registerCommand(primaryName, options);
  const seen = new Set<string>([primaryName]);
  for (const alias of deprecatedAliases) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    const aliasOptions: CommandOptions = {
      ...options,
      description: `Deprecated alias for /${primaryName}. Use /${primaryName} instead.`,
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        ctx.ui.notify(`/${alias} is deprecated; use /${primaryName} instead.`, "warning");
        await options.handler(args, ctx);
      }
    };
    api.registerCommand(alias, aliasOptions);
  }
}
