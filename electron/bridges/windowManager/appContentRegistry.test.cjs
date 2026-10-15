"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const windowManager = require("../windowManager.cjs");

function windowStub(id) {
  return {
    id,
    isDestroyed: () => false,
    webContents: {
      id,
      isCrashed: () => false,
      isDestroyed: () => false,
    },
  };
}

test("lifecycle-only app windows are excluded from dirty-editor queries", (context) => {
  const editorWindow = windowStub(101);
  const terminalPopup = windowStub(102);
  context.after(() => {
    windowManager.unregisterAppContentWindow(editorWindow);
    windowManager.unregisterAppContentWindow(terminalPopup);
  });

  windowManager.registerAppContentWindow(editorWindow, { queryDirtyEditors: true });
  windowManager.registerAppContentWindow(terminalPopup);

  assert.deepEqual(windowManager.getAppContentWindows(), [editorWindow, terminalPopup]);
  assert.deepEqual(windowManager.getDirtyEditorWindows(), [editorWindow]);
  windowManager.unregisterAppContentWindow(editorWindow);
  assert.deepEqual(windowManager.getAppContentWindows(), [terminalPopup]);
  assert.deepEqual(windowManager.getDirtyEditorWindows(), []);
});

test("opacity applies and synchronizes to detached content windows without broadening other settings", (context) => {
  const main = windowStub(201);
  const detached = windowStub(202);
  const mainOpacity = [];
  const detachedOpacity = [];
  const mainMessages = [];
  const detachedMessages = [];
  main.setOpacity = (value) => mainOpacity.push(value);
  detached.setOpacity = (value) => detachedOpacity.push(value);
  main.webContents.send = (...args) => mainMessages.push(args);
  detached.webContents.send = (...args) => detachedMessages.push(args);
  windowManager.registerMainWindow(main);
  windowManager.registerAppContentWindow(detached);
  context.after(() => {
    windowManager.unregisterMainWindow(main);
    windowManager.unregisterAppContentWindow(detached);
    windowManager.applyWindowOpacity(1);
  });
  const handlers = new Map();
  windowManager.registerWindowHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => handlers.set(channel, handler),
  }, {});

  handlers.get("netcatty:setWindowOpacity")({ sender: detached.webContents }, 0.6);
  assert.deepEqual(mainOpacity, [0.6]);
  assert.deepEqual(detachedOpacity, [0.6]);
  const opacity = {
    key: "netcatty_window_opacity_v1",
    value: { opacity: 1, version: 2, preferredOpacity: 0.6 },
  };
  const broadcast = handlers.get("netcatty:settings:changed");
  broadcast({ sender: detached.webContents }, opacity);
  assert.deepEqual(mainMessages, [["netcatty:settings:changed", opacity]]);
  assert.deepEqual(detachedMessages, []);
  broadcast({ sender: main.webContents }, opacity);
  assert.deepEqual(detachedMessages, [["netcatty:settings:changed", opacity]]);
  broadcast({ sender: main.webContents }, { key: "netcatty_show_tray_icon_v1", value: true });
  assert.equal(detachedMessages.length, 1);
});
