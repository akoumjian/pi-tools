import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type GuidedModelSetupArgs = {
  help: boolean;
  modelSpec?: string;
  guidance?: string;
  guidanceFile?: string;
  clearGuidance?: boolean;
};

const GUIDANCE_FLAGS = new Set(["--guidance", "--policy"]);
const GUIDANCE_FILE_FLAGS = new Set(["--guidance-file", "--policy-file"]);
const CLEAR_GUIDANCE_FLAGS = new Set(["--clear-guidance", "--no-guidance", "--clear-policy", "--no-policy"]);

export function parseGuidedModelSetupArgs(rawArgs: string, commandName: string): GuidedModelSetupArgs {
  const args = rawArgs.trim();
  if (!args || args === "--help" || args === "-h") {
    return { help: true };
  }

  const { token: modelSpec, rest } = takeToken(args);
  if (!modelSpec || modelSpec.startsWith("--")) {
    throw new Error(`${commandName} requires a provider/model[:thinking] argument before setup flags.`);
  }

  const parsed: GuidedModelSetupArgs = { help: false, modelSpec };
  parseSetupFlags(rest.trim(), parsed, commandName);
  if (parsed.guidance !== undefined && parsed.guidanceFile !== undefined) {
    throw new Error(`${commandName} accepts either --guidance or --guidance-file, not both.`);
  }
  return parsed;
}

export function readSetupGuidance(args: Pick<GuidedModelSetupArgs, "guidance" | "guidanceFile">, cwd: string): string | undefined {
  if (args.guidance !== undefined) {
    return normalizeGuidance(args.guidance, "--guidance");
  }
  if (args.guidanceFile === undefined) {
    return undefined;
  }

  const filePath = resolveSetupPath(args.guidanceFile, cwd);
  return normalizeGuidance(readFileSync(filePath, "utf8"), args.guidanceFile);
}

export function guidedModelSetupUsage(commandName: string): string {
  return [
    `Usage: ${commandName} provider/model[:thinking] [--guidance <natural language guidance> | --guidance-file <path> | --clear-guidance]`,
    "Note: --guidance consumes all remaining text; use --guidance-file for multi-line policy text."
  ].join("\n");
}

function parseSetupFlags(rawRest: string, parsed: GuidedModelSetupArgs, commandName: string): void {
  let rest = rawRest;
  while (rest.length > 0) {
    const equalMatch = rest.match(/^(--(?:guidance|policy|guidance-file|policy-file))=(.*)$/s);
    if (equalMatch) {
      assignSetupFlag(equalMatch[1], stripWrappingQuotes(equalMatch[2].trim()), parsed, commandName);
      return;
    }

    const { token: flag, rest: afterFlag } = takeToken(rest);
    if (CLEAR_GUIDANCE_FLAGS.has(flag)) {
      assignSetupFlag(flag, "", parsed, commandName);
      rest = afterFlag.trim();
      continue;
    }

    if (GUIDANCE_FLAGS.has(flag)) {
      const guidance = afterFlag.trim();
      if (!guidance) {
        throw new Error(`${flag} requires guidance text.`);
      }
      assignSetupFlag(flag, stripWrappingQuotes(guidance), parsed, commandName);
      return;
    }

    if (GUIDANCE_FILE_FLAGS.has(flag)) {
      const { token: value, rest: afterValue } = takeToken(afterFlag.trim());
      if (!value) {
        throw new Error(`${flag} requires a path.`);
      }
      assignSetupFlag(flag, stripWrappingQuotes(value), parsed, commandName);
      rest = afterValue.trim();
      continue;
    }

    throw new Error(`Unknown ${commandName} setup argument: ${flag}`);
  }
}

function assignSetupFlag(flag: string, value: string, parsed: GuidedModelSetupArgs, commandName: string): void {
  if (GUIDANCE_FLAGS.has(flag)) {
    if (parsed.guidance !== undefined || parsed.guidanceFile !== undefined || parsed.clearGuidance) {
      throw new Error(`${commandName} accepts only one guidance input.`);
    }
    parsed.guidance = value;
    return;
  }

  if (GUIDANCE_FILE_FLAGS.has(flag)) {
    if (parsed.guidance !== undefined || parsed.guidanceFile !== undefined || parsed.clearGuidance) {
      throw new Error(`${commandName} accepts only one guidance input.`);
    }
    parsed.guidanceFile = value;
    return;
  }

  if (CLEAR_GUIDANCE_FLAGS.has(flag)) {
    if (parsed.guidance !== undefined || parsed.guidanceFile !== undefined || parsed.clearGuidance) {
      throw new Error(`${commandName} accepts only one guidance input.`);
    }
    parsed.clearGuidance = true;
    return;
  }

  throw new Error(`Unknown ${commandName} setup argument: ${flag}`);
}

function takeToken(value: string): { token: string; rest: string } {
  const trimmed = value.trimStart();
  if (!trimmed) {
    return { token: "", rest: "" };
  }

  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { token: trimmed, rest: "" };
  }
  return { token: match[1], rest: match[2] ?? "" };
}

function normalizeGuidance(value: string, source: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Guidance from ${source} is empty.`);
  }
  return `${trimmed}\n`;
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  return (first === last && (first === '"' || first === "'")) ? value.slice(1, -1) : value;
}

function resolveSetupPath(input: string, cwd: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(homedir(), input.slice(2));
  }
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}
