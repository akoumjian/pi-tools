import assert from "node:assert/strict";
import test from "node:test";

import tmuxScrollbackExtension, {
  buildTmuxScrollbackStatusText,
  getTmuxScrollbackStatus,
  installTmuxScrollbackPatch,
  isTmuxEnvironment,
  resetTmuxScrollbackState,
  stripTmuxConflictingSequences
} from "../extensions/tmux-scrollback/index.js";

type FakeTerminalInstance = {
  writes: string[];
  write: (data: string) => void;
};

type FakeTerminalConstructor = {
  new (): FakeTerminalInstance;
  prototype: FakeTerminalInstance;
};

type FakeApi = {
  commands: Map<string, { description: string; handler: Function }>;
  registerCommand(name: string, command: { description: string; handler: Function }): void;
};

function makeFakeTerminalConstructor(): FakeTerminalConstructor {
  class FakeTerminal implements FakeTerminalInstance {
    writes: string[] = [];

    write(data: string): void {
      this.writes.push(data);
    }
  }

  return FakeTerminal as unknown as FakeTerminalConstructor;
}

function createFakeApi(): FakeApi {
  const commands = new Map<string, { description: string; handler: Function }>();
  return {
    commands,
    registerCommand(name, command): void {
      commands.set(name, command);
    }
  };
}

test("tmux environment detection requires TMUX to be set", () => {
  assert.equal(isTmuxEnvironment({}), false);
  assert.equal(isTmuxEnvironment({ TMUX: "" }), false);
  assert.equal(isTmuxEnvironment({ TMUX: "/tmp/tmux-1000/default,1,0" }), true);
});

test("tmux conflicting private mode enables are stripped while unrelated modes remain", () => {
  const result = stripTmuxConflictingSequences(
    [
      "before",
      "\x1b[?1049h",
      "alt",
      "\x1b[?1000;1006h",
      "mouse",
      "\x1b[?25;1002h",
      "cursor",
      "\x1b[?1000l",
      "disable"
    ].join("")
  );

  assert.equal(
    result.text,
    [
      "before",
      "alt",
      "mouse",
      "\x1b[?25h",
      "cursor",
      "\x1b[?1000l",
      "disable"
    ].join("")
  );
  assert.equal(result.strippedPrivateModeEnables, 4);
});

test("tmux scrollback patch is inactive outside tmux", () => {
  const terminalConstructor = makeFakeTerminalConstructor();
  const outputWrites: string[] = [];

  const status = installTmuxScrollbackPatch(terminalConstructor, {}, { write: (data) => outputWrites.push(data) });
  const terminal = new terminalConstructor();
  terminal.write("\x1b[?1049hunchanged");

  assert.equal(status.installed, false);
  assert.equal(status.active, false);
  assert.deepEqual(outputWrites, []);
  assert.deepEqual(terminal.writes, ["\x1b[?1049hunchanged"]);
});

test("tmux scrollback patch strips conflicting sequences inside tmux", () => {
  const terminalConstructor = makeFakeTerminalConstructor();
  const outputWrites: string[] = [];

  const status = installTmuxScrollbackPatch(
    terminalConstructor,
    { TMUX: "/tmp/tmux-1000/default,1,0" },
    { write: (data) => outputWrites.push(data) }
  );
  const terminal = new terminalConstructor();
  terminal.write("\x1b[?1049hhello\x1b[?25;1000h");

  assert.equal(status.installed, true);
  assert.equal(status.active, true);
  assert.equal(outputWrites.length, 1);
  assert.match(outputWrites[0] ?? "", /\x1b\[\?1049l/);
  assert.deepEqual(terminal.writes, ["hello\x1b[?25h"]);

  const patchedStatus = getTmuxScrollbackStatus(terminalConstructor);
  assert.equal(patchedStatus.strippedPrivateModeEnables, 2);
});

test("tmux reset disables alternate screen and common mouse tracking modes", () => {
  const writes: string[] = [];
  resetTmuxScrollbackState({ write: (data) => writes.push(data) });

  assert.equal(writes.length, 1);
  assert.match(writes[0] ?? "", /\x1b\[\?1049l/);
  assert.match(writes[0] ?? "", /\x1b\[\?1000l/);
  assert.match(writes[0] ?? "", /\x1b\[\?1006l/);
});

test("tmux-scrollback extension registers a status command", () => {
  const originalTmux = process.env.TMUX;
  process.env.TMUX = "";

  try {
    const api = createFakeApi();
    tmuxScrollbackExtension(api as never);

    assert.ok(api.commands.has("tmux-scrollback:status"));
    assert.equal(api.commands.has("tmux-scrollback-status"), false, "deprecated kebab alias removed");
    assert.match(buildTmuxScrollbackStatusText(), /tmux scrollback status/);
  } finally {
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
  }
});
