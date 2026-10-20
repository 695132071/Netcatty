"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const mcpServerBridge = require("./mcpServerBridge.cjs");
const {
  createWindowAttentionController,
  installWindowAttention,
  resetWindowAttentionForTests,
  setExternalMcpApprovalAlertMode,
  syncExternalMcpApprovalAttention,
} = require("./windowAttention.cjs");

function createWindow(overrides = {}) {
  const win = new EventEmitter();
  win.destroyed = false;
  win.focused = false;
  win.flashes = [];
  win.isDestroyed = () => win.destroyed;
  win.isFocused = () => win.focused;
  win.flashFrame = (flag) => { win.flashes.push(flag); };
  return Object.assign(win, overrides);
}

test("linux attention flashes until focus or stop", () => {
  const app = new EventEmitter();
  const win = createWindow();
  const controller = createWindowAttentionController({
    app,
    platform: "linux",
    getWindows: () => [win],
  });
  assert.deepEqual(controller.request(), { requested: true, kind: "flash" });
  assert.deepEqual(win.flashes, [true]);
  assert.equal(app.listenerCount("browser-window-focus"), 1);
  app.emit("browser-window-focus", {}, win);
  assert.deepEqual(win.flashes, [true, false]);
  assert.equal(app.listenerCount("browser-window-focus"), 0);

  assert.deepEqual(controller.request(), { requested: true, kind: "flash" });
  controller.stop();
  assert.deepEqual(win.flashes, [true, false, true, false]);
  assert.equal(app.listenerCount("browser-window-focus"), 0);
});

test("focus on a window created after attention starts clears the flash", () => {
  const app = new EventEmitter();
  const original = createWindow();
  const windows = [original];
  const controller = createWindowAttentionController({
    app,
    platform: "win32",
    getWindows: () => windows,
  });
  assert.deepEqual(controller.request(), { requested: true, kind: "flash" });

  const later = createWindow();
  windows.push(later);
  later.emit("focus");
  assert.deepEqual(original.flashes, [true]);

  app.emit("browser-window-focus", {}, later);
  assert.deepEqual(original.flashes, [true, false]);
  assert.equal(app.listenerCount("browser-window-focus"), 0);
  app.emit("browser-window-focus", {}, later);
  assert.deepEqual(original.flashes, [true, false]);
});

test("attention stays quiet while any window is focused", () => {
  const idle = createWindow();
  const active = createWindow({ focused: true });
  const controller = createWindowAttentionController({
    platform: "win32",
    getWindows: () => [idle, active],
  });
  assert.deepEqual(controller.request(), { requested: false, reason: "focused" });
  assert.deepEqual(idle.flashes, []);
});

test("macOS attention uses an informational dock bounce and cancels it", () => {
  const win = createWindow();
  const cancelled = [];
  const app = new EventEmitter();
  app.dock = {
    bounce(type) {
      assert.equal(type, "informational");
      return 4;
    },
    cancelBounce(id) { cancelled.push(id); },
  };
  const controller = createWindowAttentionController({
    platform: "darwin",
    app,
    getWindows: () => [win],
  });
  assert.deepEqual(controller.request(), { requested: true, kind: "bounce" });
  assert.deepEqual(controller.request(), { requested: true, kind: "bounce" });
  assert.equal(app.listenerCount("browser-window-focus"), 1);
  assert.deepEqual(win.flashes, []);
  controller.stop();
  assert.deepEqual(cancelled, [4]);
  app.emit("browser-window-focus", {}, win);
  assert.deepEqual(cancelled, [4]);
  assert.equal(app.listenerCount("browser-window-focus"), 0);
});

test("external MCP approvals flash while unfocused and stop when resolved", (t) => {
  const contents = new EventEmitter();
  contents.id = 42;
  contents.send = (channel, payload) => contents.emit("send", channel, payload);
  contents.isDestroyed = () => false;
  const win = createWindow();
  win.webContents = contents;

  installWindowAttention({
    platform: "linux",
    getWindows: () => [win],
  });
  setExternalMcpApprovalAlertMode("unfocused");
  mcpServerBridge.setMainWindowGetter(() => win);
  t.after(() => {
    mcpServerBridge.clearPendingApprovals();
    mcpServerBridge.setMainWindowGetter(() => null);
    resetWindowAttentionForTests();
  });

  const requests = [];
  contents.on("send", (channel, payload) => {
    if (channel === "netcatty:ai:mcp:approval-request") requests.push(payload);
  });

  const approval = mcpServerBridge.requestApprovalFromRenderer(
    "sftp.write",
    { path: "/tmp/x" },
    mcpServerBridge.EXTERNAL_MCP_CHAT_SESSION_ID,
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(win.flashes, [true]);

  mcpServerBridge.resolveApprovalFromRenderer(requests[0].approvalId, false);
  assert.deepEqual(win.flashes, [true, false]);
  return approval.then((approved) => {
    assert.equal(approved, false);
  });
});

test("approval attention follows the off preference and ignores in-app approvals", (t) => {
  const contents = new EventEmitter();
  contents.id = 7;
  contents.send = (channel, payload) => contents.emit("send", channel, payload);
  contents.isDestroyed = () => false;
  const win = createWindow();
  win.webContents = contents;

  installWindowAttention({
    platform: "linux",
    getWindows: () => [win],
  });
  setExternalMcpApprovalAlertMode("off");
  mcpServerBridge.setMainWindowGetter(() => win);
  t.after(() => {
    mcpServerBridge.clearPendingApprovals();
    mcpServerBridge.setMainWindowGetter(() => null);
    resetWindowAttentionForTests();
  });

  const external = mcpServerBridge.requestApprovalFromRenderer(
    "sftp.write",
    {},
    mcpServerBridge.EXTERNAL_MCP_CHAT_SESSION_ID,
  );
  const internal = mcpServerBridge.requestApprovalFromRenderer(
    "terminal.execute",
    {},
    "chat-1",
  );
  assert.deepEqual(win.flashes, []);
  assert.deepEqual(syncExternalMcpApprovalAttention(2), { attention: false });

  mcpServerBridge.clearPendingApprovals();
  return Promise.all([external, internal]).then((results) => {
    assert.deepEqual(results, [false, false]);
  });
});
