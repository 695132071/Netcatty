"use strict";

const DEFAULT_MODE = "unfocused";

function normalizeExternalMcpApprovalAlertMode(value) {
  return value === "off" || value === "always" || value === "unfocused" ? value : DEFAULT_MODE;
}

function createWindowAttentionController({ app, getWindows, platform }) {
  let bounceId = -1;
  let flashing = false;
  let flashedWin = null;
  let watchingFocus = false;

  function onBrowserWindowFocus() {
    stop();
  }

  function startFocusWatch() {
    if (watchingFocus || typeof app?.on !== "function") return;
    app.on("browser-window-focus", onBrowserWindowFocus);
    watchingFocus = true;
  }

  function stopFocusWatch() {
    if (!watchingFocus) return;
    watchingFocus = false;
    try { app.removeListener("browser-window-focus", onBrowserWindowFocus); } catch { /* ignore */ }
  }

  function stop() {
    stopFocusWatch();
    if (flashing && flashedWin && !flashedWin.isDestroyed?.() && typeof flashedWin.flashFrame === "function") {
      try { flashedWin.flashFrame(false); } catch { /* ignore */ }
    }
    flashing = false;
    flashedWin = null;
    if (bounceId >= 0) {
      try { app?.dock?.cancelBounce?.(bounceId); } catch { /* ignore */ }
      bounceId = -1;
    }
  }

  function request() {
    const windows = (typeof getWindows === "function" ? getWindows() : [])
      .filter((win) => win && !win.isDestroyed?.());
    if (windows.length === 0) return { requested: false, reason: "no-window" };
    if (windows.some((win) => typeof win.isFocused === "function" && win.isFocused())) {
      return { requested: false, reason: "focused" };
    }

    if (platform === "darwin") {
      if (bounceId >= 0) return { requested: true, kind: "bounce" };
      const id = app?.dock?.bounce?.("informational");
      if (typeof id !== "number" || id < 0) return { requested: false, reason: "unavailable" };
      bounceId = id;
      startFocusWatch();
      return { requested: true, kind: "bounce" };
    }

    const win = windows[0];
    if (typeof win.flashFrame !== "function") return { requested: false, reason: "unavailable" };
    win.flashFrame(true);
    flashing = true;
    flashedWin = win;
    startFocusWatch();
    return { requested: true, kind: "flash" };
  }

  return { request, stop };
}

let mode = DEFAULT_MODE;
let controller = null;

function installWindowAttention(options) {
  controller?.stop?.();
  controller = createWindowAttentionController(options);
  return controller;
}

function setExternalMcpApprovalAlertMode(value) {
  mode = normalizeExternalMcpApprovalAlertMode(value);
  if (mode === "off") controller?.stop?.();
  return mode;
}

function getExternalMcpApprovalAlertMode() {
  return mode;
}

function syncExternalMcpApprovalAttention(pendingCount) {
  if (!controller) return { attention: false, reason: "uninstalled" };
  if (!(pendingCount > 0) || mode === "off") {
    controller.stop();
    return { attention: false };
  }
  return controller.request();
}

function resetWindowAttentionForTests() {
  controller?.stop?.();
  controller = null;
  mode = DEFAULT_MODE;
}

function registerExternalMcpApprovalAlertHandlers(ipcMain) {
  ipcMain.handle("netcatty:mcp:approval-alert-mode", (_event, payload) => {
    return { mode: setExternalMcpApprovalAlertMode(payload?.mode) };
  });
}

module.exports = {
  normalizeExternalMcpApprovalAlertMode,
  createWindowAttentionController,
  installWindowAttention,
  setExternalMcpApprovalAlertMode,
  getExternalMcpApprovalAlertMode,
  syncExternalMcpApprovalAttention,
  resetWindowAttentionForTests,
  registerExternalMcpApprovalAlertHandlers,
};
