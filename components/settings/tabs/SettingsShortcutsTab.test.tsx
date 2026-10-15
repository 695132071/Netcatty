import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { DEFAULT_KEY_BINDINGS } from "../../../domain/models/keyBindings";
import { createDomRenderer, dispatchDomEvent, installDomEnvironment } from "../../test-support/renderReactDom";

async function setup(t: TestContext, label: string) {
  const env = installDomEnvironment();
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    DocumentFragment: env.window.DocumentFragment,
    MutationObserver: env.window.MutationObserver,
    Element: env.window.Element,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { default: SettingsShortcutsTab } = await import("./SettingsShortcutsTab");
  const { I18nProvider } = await import("../../../application/i18n/I18nProvider");
  const { Tabs } = await import("../../ui/tabs");
  const renderer = await createDomRenderer(env.document);
  t.after(async () => {
    await renderer.unmount();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    env.cleanup();
  });
  const updates: string[][] = [];
  await renderer.render(<I18nProvider locale="en"><Tabs value="shortcuts"><SettingsShortcutsTab
    hotkeyScheme="pc" setHotkeyScheme={() => {}}
    shellOnlyTabNumberShortcuts={false} setShellOnlyTabNumberShortcuts={() => {}}
    showTabNumberBadges={true} setShowTabNumberBadges={() => {}}
    disableTerminalFontZoom={false} setDisableTerminalFontZoom={() => {}}
    keyBindings={DEFAULT_KEY_BINDINGS} resetAllKeyBindings={() => {}}
    updateKeyBinding={(...args) => { updates.push(args); }}
  /></Tabs></I18nProvider>);
  const row = [...env.document.querySelectorAll("span")].find((span) => span.textContent === label)?.parentElement;
  const button = row?.querySelector("button");
  assert.ok(button);
  await dispatchDomEvent(button, new env.window.MouseEvent("click", { bubbles: true }));
  const key = (type: "keydown" | "keyup", init: KeyboardEventInit) => dispatchDomEvent(
    env.window, new env.window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }),
  );
  return { updates, key, button };
}

test("the tab modifier editor saves left Alt on release without requiring a digit", async (t) => {
  const { updates, key } = await setup(t, "Switch to Tab [1...9]");
  await key("keydown", { key: "Alt", code: "AltLeft", altKey: true });
  assert.deepEqual(updates, []);
  await key("keyup", { key: "Alt", code: "AltLeft" });
  assert.deepEqual(updates, [["switch-tab-1-9", "pc", "Alt + [1...9]"]]);
});

test("the modifier editor waits for the full modifier chord to be released", async (t) => {
  const { updates, key } = await setup(t, "Switch to Tab [1...9]");
  await key("keydown", { key: "Control", ctrlKey: true });
  await key("keydown", { key: "Alt", ctrlKey: true, altKey: true });
  await key("keyup", { key: "Alt", ctrlKey: true });
  assert.deepEqual(updates, []);
  await key("keyup", { key: "Control" });
  assert.deepEqual(updates, [["switch-tab-1-9", "pc", "Ctrl + Alt + [1...9]"]]);
});

test("ordinary shortcuts still require a non-modifier key", async (t) => {
  const { updates, key } = await setup(t, "Next Tab");
  await key("keydown", { key: "Alt", altKey: true });
  await key("keyup", { key: "Alt" });
  assert.deepEqual(updates, []);
  await key("keydown", { key: "ArrowRight", altKey: true });
  assert.deepEqual(updates, [["next-tab", "pc", "Alt + \u2192"]]);
});

test("Escape cancels an unfinished modifier recording", async (t) => {
  const { updates, key, button } = await setup(t, "Switch to Tab [1...9]");
  await key("keydown", { key: "Alt", altKey: true });
  await key("keydown", { key: "Escape", altKey: true });
  await key("keyup", { key: "Alt" });
  assert.deepEqual(updates, []);
  assert.equal(button.textContent, "Ctrl");
});
