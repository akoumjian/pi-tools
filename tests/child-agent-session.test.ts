import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createFailClosedChildUI, validateChildToolAllowlist } from "../extensions/_shared/child-agent-session.js";

function fakeParentUI(notifications: Array<{ message: string; type?: string }>, confirmCalls: string[]): ExtensionUIContext {
  return {
    async confirm(title: string): Promise<boolean> {
      confirmCalls.push(title);
      return true;
    },
    async select(): Promise<string | undefined> { return "picked"; },
    async input(): Promise<string | undefined> { return "typed"; },
    async editor(): Promise<string | undefined> { return "edited"; },
    notify(message: string, type?: string): void { notifications.push({ message, type }); },
    setStatus(): void {},
    setWorkingMessage(): void {}
  } as unknown as ExtensionUIContext;
}

test("child UI fails interactive dialogs closed and notifies the parent", async () => {
  const notifications: Array<{ message: string; type?: string }> = [];
  const confirmCalls: string[] = [];
  const denials: Array<{ method: string; title: string }> = [];
  const childUI = createFailClosedChildUI(fakeParentUI(notifications, confirmCalls), (method, title) => denials.push({ method, title }));

  assert.equal(await childUI.confirm("Approve risky write?", "body"), false);
  assert.equal(await childUI.select("Pick an option", ["a", "b"]), undefined);
  assert.equal(await childUI.input("Enter value"), undefined);
  assert.equal(await childUI.editor("Edit text"), undefined);

  assert.equal(confirmCalls.length, 0, "parent confirm must never be invoked from a child session");
  assert.equal(notifications.length, 4);
  for (const notification of notifications) {
    assert.equal(notification.type, "warning");
    assert.match(notification.message, /fail closed and cannot prompt the user/);
  }
  assert.match(notifications[0].message, /confirm\("Approve risky write\?"\)/);
  assert.deepEqual(denials, [
    { method: "confirm", title: "Approve risky write?" },
    { method: "select", title: "Pick an option" },
    { method: "input", title: "Enter value" },
    { method: "editor", title: "Edit text" }
  ]);
});

test("child UI delegates non-interactive members to the parent with bound this", () => {
  const notifications: Array<{ message: string; type?: string }> = [];
  const childUI = createFailClosedChildUI(fakeParentUI(notifications, []));
  childUI.notify("status update", "info");
  assert.deepEqual(notifications, [{ message: "status update", type: "info" }]);
  assert.doesNotThrow(() => childUI.setStatus("key", "text"));
});

test("tool allowlist validation reports missing tools with config source", () => {
  assert.doesNotThrow(() => validateChildToolAllowlist([{ name: "read_many" }], ["read_many"], "Test", "defaults"));
  assert.throws(
    () => validateChildToolAllowlist([{ name: "read_many" }], ["read_many", "edit_many"], "Test", "defaults"),
    /Test configured tools are unavailable: edit_many.*defaults/
  );
});
