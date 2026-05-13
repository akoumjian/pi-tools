import { registerCommandWithAliases } from "../_shared/deprecated-command.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ProcessTerminal } from "@mariozechner/pi-tui";

export const CLEAR_SCROLLBACK_SEQUENCE = "\x1b[3J";

type WriteMethod = (data: string) => void;

type TerminalPrototype = {
  write: WriteMethod;
};

type TerminalConstructor = {
  prototype: TerminalPrototype;
};

type PatchState = {
  installedAt: string;
  strippedSequences: number;
};

export type TuiScrollbackPatchStatus = {
  installed: boolean;
  installedAt?: string;
  strippedSequences: number;
};

const patchStates = new WeakMap<TerminalPrototype, PatchState>();

export default function tuiScrollbackExtension(api: ExtensionAPI): void {
  installTuiScrollbackPatch();

  registerCommandWithAliases(
    api,
    "scrollback:status",
    {
      description: "Show TUI scrollback preservation status",
      handler: async (_args, context) => {
        context.ui.notify(buildTuiScrollbackStatusText(), "info");
      }
    },
    []
  );
}

export function installTuiScrollbackPatch(
  terminalConstructor: TerminalConstructor = ProcessTerminal as TerminalConstructor
): TuiScrollbackPatchStatus {
  const prototype = terminalConstructor.prototype;
  const existing = patchStates.get(prototype);
  if (existing !== undefined) {
    return toStatus(existing);
  }

  if (typeof prototype.write !== "function") {
    throw new Error("TUI scrollback preservation could not patch ProcessTerminal.write; Pi TUI API changed.");
  }

  const state: PatchState = {
    installedAt: new Date().toISOString(),
    strippedSequences: 0
  };
  const originalWrite = prototype.write;

  prototype.write = function writeWithoutClearScrollback(data: string): void {
    const strippedCount = countClearScrollbackSequences(data);
    if (strippedCount > 0) {
      state.strippedSequences += strippedCount;
      originalWrite.call(this, stripClearScrollback(data));
      return;
    }

    originalWrite.call(this, data);
  };

  patchStates.set(prototype, state);
  return toStatus(state);
}

export function getTuiScrollbackPatchStatus(
  terminalConstructor: TerminalConstructor = ProcessTerminal as TerminalConstructor
): TuiScrollbackPatchStatus {
  const state = patchStates.get(terminalConstructor.prototype);
  return state === undefined ? { installed: false, strippedSequences: 0 } : toStatus(state);
}

export function buildTuiScrollbackStatusText(): string {
  const status = getTuiScrollbackPatchStatus();
  return [
    "TUI scrollback status",
    "",
    `Patch installed: ${status.installed ? "yes" : "no"}`,
    status.installedAt === undefined ? undefined : `Installed at: ${status.installedAt}`,
    `Clear-scrollback sequences stripped: ${status.strippedSequences}`,
    "Purpose: preserve terminal scrollback when Pi full-redraws after compaction or other large transcript rebuilds."
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function stripClearScrollback(data: string): string {
  return data.split(CLEAR_SCROLLBACK_SEQUENCE).join("");
}

export function countClearScrollbackSequences(data: string): number {
  return data.split(CLEAR_SCROLLBACK_SEQUENCE).length - 1;
}

function toStatus(state: PatchState): TuiScrollbackPatchStatus {
  return {
    installed: true,
    installedAt: state.installedAt,
    strippedSequences: state.strippedSequences
  };
}
