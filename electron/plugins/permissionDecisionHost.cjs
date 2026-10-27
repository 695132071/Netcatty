"use strict";

const { randomBytes, timingSafeEqual } = require("node:crypto");
const { permissionDenied } = require("./permissionEngine.cjs");
const { describePluginPermission } = require("../../domain/pluginPermissionDescriptions.cjs");
const { escapePermissionText } = require("./nativePermissionDecision.cjs");
const CHANNEL = "netcatty:plugins:permission-prompt";

/** Main-window-only Ask decisions. Tokens are bound to one pending request and
 * consumed before any asynchronous work. Plugin windows never own this link. */
class PluginPermissionDecisionHost {
  constructor(options) {
    this.getWindow = options.getWindow;
    this.isLocked = options.isLocked ?? (() => true);
    this.pending = new Map();
    this.owner = null;
    this.closed = false;
    this.unsubscribeLock = options.subscribeLock?.((state) => { if (state.locked) this.cancelAll(); });
  }

  setReady(sender, ready) {
    if (this.closed) throw permissionDenied("Permission UI is closed");
    if (sender !== this.getWindow?.()?.webContents || sender.isDestroyed?.() || typeof ready !== "boolean") {
      throw permissionDenied("Permission UI sender is invalid");
    }
    this.cancelAll();
    this.cleanup?.(); this.cleanup = null;
    this.owner = ready ? sender : null;
    if (ready) {
      const window = this.getWindow();
      const cancel = () => this.cancelAll();
      const release = () => { this.cancelAll(); this.owner = null; };
      const navigate = (details, _url, inPlace, mainFrame) => {
        if ((details?.isMainFrame ?? mainFrame) !== false && (details?.isSameDocument ?? inPlace) !== true) release();
      };
      sender.on?.("destroyed", release); sender.on?.("render-process-gone", release); sender.on?.("did-start-navigation", navigate);
      window.on?.("hide", cancel); window.on?.("blur", cancel);
      this.cleanup = () => {
        sender.removeListener?.("destroyed", release); sender.removeListener?.("render-process-gone", release); sender.removeListener?.("did-start-navigation", navigate);
        window.removeListener?.("hide", cancel); window.removeListener?.("blur", cancel);
      };
    }
    return true;
  }

  assertOwner(sender = this.owner) {
    const window = this.getWindow?.();
    if (this.closed || !sender || sender !== this.owner || window?.webContents !== sender || sender.isDestroyed?.()
      || window.isDestroyed?.() || !window.isFocused?.() || !window.isVisible?.() || this.isLocked()) {
      throw permissionDenied("Permission UI requires the focused unlocked main window");
    }
  }

  request(request, { signal } = {}) {
    signal?.throwIfAborted(); this.assertOwner();
    if (!describePluginPermission(request.permission).known || this.pending.size >= 16) {
      throw permissionDenied("Permission prompt is unavailable");
    }
    const sender = this.owner;
    return new Promise((resolve, reject) => {
      const actionToken = randomBytes(32).toString("base64url");
      const finish = (decision, error) => {
        if (!this.pending.delete(request.requestId)) return;
        signal?.removeEventListener("abort", abort);
        try { sender.send(CHANNEL, { requestId: request.requestId, closed: true }); } catch {}
        if (error) reject(error); else resolve({ requestId: request.requestId, decision, ...(decision === "allow" ? { scope: request.allowedScopes && !request.allowedScopes.includes("once") && request.sessionId && request.allowedScopes.includes("session") ? "session" : "once" } : {}) });
      };
      const abort = () => finish(null, permissionDenied("Permission prompt was cancelled"));
      this.pending.set(request.requestId, { sender, actionToken, finish });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try {
        sender.send(CHANNEL, { ...request, actionToken,
          ...(request.pluginName ? { pluginName: escapePermissionText(request.pluginName) } : {}),
          resources: (request.resources ?? []).map((resource) => escapePermissionText(resource)),
          ...(request.relatedPermissions ? { relatedPermissions: request.relatedPermissions.map((item) => ({
            permission: item.permission, resources: item.resources.map((resource) => escapePermissionText(resource)),
          })) } : {}),
        });
      } catch { abort(); }
    });
  }

  respond(sender, response) {
    this.assertOwner(sender);
    if (!response || Object.keys(response).some((key) => !["requestId", "actionToken", "decision"].includes(key))
      || !["allow", "deny", "cancel"].includes(response.decision) || typeof response.actionToken !== "string") {
      throw permissionDenied("Permission response is invalid");
    }
    const entry = this.pending.get(response.requestId);
    if (!entry || entry.sender !== sender) return false;
    const expected = Buffer.from(entry.actionToken); const actual = Buffer.from(response.actionToken);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    entry.actionToken = "";
    entry.finish(response.decision);
    return true;
  }

  cancelAll() { for (const entry of [...this.pending.values()]) entry.finish("cancel"); }
  shutdown() { if (this.closed) return; this.closed = true; this.cancelAll(); this.cleanup?.(); this.unsubscribeLock?.(); this.owner = null; }
}
module.exports = { PluginPermissionDecisionHost, PLUGIN_PERMISSION_PROMPT_CHANNEL: CHANNEL };
