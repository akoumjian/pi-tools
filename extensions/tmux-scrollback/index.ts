import { registerCommandWithAliases } from "../_shared/deprecated-command.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal } from "@earendil-works/pi-tui";

const TMUX_CONFLICTING_PRIVATE_MODES = new Set([
  "47",
  "1047",
  "1048",
  "1049",
  "1000",
  "1002",
  "1003",
  "1005",
  "1006",
  "1015"
]);

const CSI_PRIVATE_MODE_PATTERN = /\x1b\[\?([0-9;]+)([hl])/g;
const TMUX_RESET_SEQUENCE = [
  "\x1b[?1000l",
  "\x1b[?1002l",
  "\x1b[?1003l",
  "\x1b[?1005l",
  "\x1b[?1006l",
  "\x1b[?1015l",
  "\x1b[?1049l",
  "\x1b[?1047l",
  "\x1b[?1048l"
].join("");

type WriteMethod = (data: string) => void;

type TerminalPrototype = {
  write: WriteMethod;
};

type TerminalConstructor = {
  prototype: TerminalPrototype;
};

type WritableOutput = {
  write: (data: string) => unknown;
};

type PatchState = {
  installedAt: string;
  active: boolean;
  strippedPrivateModeEnables: number;
};

export type TmuxScrollbackStatus = {
  installed: boolean;
  active: boolean;
  installedAt?: string;
  strippedPrivateModeEnables: number;
};

const patchStates = new WeakMap<TerminalPrototype, PatchState>();

export default function tmuxScrollbackExtension(api: ExtensionAPI): void {
  installTmuxScrollbackPatch();

  registerCommandWithAliases(
    api,
    "tmux-scrollback:status",
    {
      description: "Show tmux scrollback compatibility status",
      handler: async (_args, context) => {
        context.ui.notify(buildTmuxScrollbackStatusText(), "info");
      }
    },
    []
  );
}

export function installTmuxScrollbackPatch(
  terminalConstructor: TerminalConstructor = ProcessTerminal as TerminalConstructor,
  env: NodeJS.ProcessEnv = process.env,
  output: WritableOutput = process.stdout
): TmuxScrollbackStatus {
  if (!isTmuxEnvironment(env)) {
    return { installed: false, active: false, strippedPrivateModeEnables: 0 };
  }

  const prototype = terminalConstructor.prototype;
  const existing = patchStates.get(prototype);
  if (existing !== undefined) {
    return toStatus(existing);
  }

  if (typeof prototype.write !== "function") {
    throw new Error("tmux scrollback compatibility could not patch ProcessTerminal.write; Pi TUI API changed.");
  }

  const state: PatchState = {
    installedAt: new Date().toISOString(),
    active: true,
    strippedPrivateModeEnables: 0
  };
  const originalWrite = prototype.write;

  prototype.write = function writeWithoutTmuxConflicts(data: string): void {
    const normalized = stripTmuxConflictingSequences(data);
    state.strippedPrivateModeEnables += normalized.strippedPrivateModeEnables;
    originalWrite.call(this, normalized.text);
  };

  patchStates.set(prototype, state);
  resetTmuxScrollbackState(output);
  return toStatus(state);
}

export function getTmuxScrollbackStatus(
  terminalConstructor: TerminalConstructor = ProcessTerminal as TerminalConstructor
): TmuxScrollbackStatus {
  const state = patchStates.get(terminalConstructor.prototype);
  return state === undefined ? { installed: false, active: false, strippedPrivateModeEnables: 0 } : toStatus(state);
}

export function buildTmuxScrollbackStatusText(): string {
  const status = getTmuxScrollbackStatus();
  return [
    "tmux scrollback status",
    "",
    `Active tmux session: ${isTmuxEnvironment() ? "yes" : "no"}`,
    `Patch installed: ${status.installed ? "yes" : "no"}`,
    status.installedAt === undefined ? undefined : `Installed at: ${status.installedAt}`,
    `Alternate-screen/mouse enable sequences stripped: ${status.strippedPrivateModeEnables}`,
    "Purpose: make Pi behave like transcript-first CLIs in tmux, so tmux copy-mode/history handles scrollback."
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function stripTmuxConflictingSequences(data: string): { text: string; strippedPrivateModeEnables: number } {
  let strippedPrivateModeEnables = 0;

  const text = data.replace(CSI_PRIVATE_MODE_PATTERN, (sequence, rawModes: string, finalByte: string) => {
    if (finalByte !== "h") {
      return sequence;
    }

    const modes = rawModes.split(";").filter((mode) => mode.length > 0);
    const keptModes = modes.filter((mode) => !TMUX_CONFLICTING_PRIVATE_MODES.has(mode));
    strippedPrivateModeEnables += modes.length - keptModes.length;

    if (keptModes.length === modes.length) {
      return sequence;
    }

    if (keptModes.length === 0) {
      return "";
    }

    return `\x1b[?${keptModes.join(";")}h`;
  });

  return { text, strippedPrivateModeEnables };
}

export function resetTmuxScrollbackState(output: WritableOutput = process.stdout): void {
  output.write(TMUX_RESET_SEQUENCE);
}

export function isTmuxEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.TMUX === "string" && env.TMUX.length > 0;
}

function toStatus(state: PatchState): TmuxScrollbackStatus {
  return {
    installed: true,
    active: state.active,
    installedAt: state.installedAt,
    strippedPrivateModeEnables: state.strippedPrivateModeEnables
  };
}
