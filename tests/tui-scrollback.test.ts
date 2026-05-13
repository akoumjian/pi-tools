import assert from "node:assert/strict";
import test from "node:test";
import tuiScrollbackExtension, {
  buildTuiScrollbackStatusText,
  CLEAR_SCROLLBACK_SEQUENCE,
  countClearScrollbackSequences,
  getTuiScrollbackPatchStatus,
  installTuiScrollbackPatch,
  stripClearScrollback
} from "../extensions/tui-scrollback/index.js";

class FakeTerminal {
  writes: string[] = [];

  write(data: string): void {
    this.writes.push(data);
  }
}

type FakeApi = {
  commands: Map<string, { description: string; handler: Function }>;
  registerCommand(name: string, command: { description: string; handler: Function }): void;
};

function createFakeApi(): FakeApi {
  const commands = new Map<string, { description: string; handler: Function }>();
  return {
    commands,
    registerCommand(name, command): void {
      commands.set(name, command);
    }
  };
}

test("stripClearScrollback removes only clear-scrollback escapes", () => {
  const input = `before${CLEAR_SCROLLBACK_SEQUENCE}middle\x1b[2Jafter${CLEAR_SCROLLBACK_SEQUENCE}`;

  assert.equal(countClearScrollbackSequences(input), 2);
  assert.equal(stripClearScrollback(input), "beforemiddle\x1b[2Jafter");
});

test("installTuiScrollbackPatch patches terminal writes idempotently", () => {
  const constructor = FakeTerminal as unknown as { prototype: { write(data: string): void } };

  const firstStatus = installTuiScrollbackPatch(constructor);
  const secondStatus = installTuiScrollbackPatch(constructor);
  assert.equal(firstStatus.installed, true);
  assert.equal(secondStatus.installedAt, firstStatus.installedAt);

  const terminal = new FakeTerminal();
  terminal.write(`keep${CLEAR_SCROLLBACK_SEQUENCE}screen`);
  terminal.write("plain");

  assert.deepEqual(terminal.writes, ["keepscreen", "plain"]);
  assert.equal(getTuiScrollbackPatchStatus(constructor).strippedSequences, 1);
});

test("tui-scrollback extension registers a status command", async () => {
  const api = createFakeApi();
  tuiScrollbackExtension(api as never);

  assert.ok(api.commands.has("scrollback:status"));
  assert.equal(api.commands.has("tui-scrollback-status"), false, "deprecated kebab alias removed");
  assert.match(buildTuiScrollbackStatusText(), /TUI scrollback status/);
});
