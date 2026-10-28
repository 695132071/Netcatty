"use strict";

const { randomUUID } = require("node:crypto");
const path = require("node:path");

const { assertJsonValue } = require("./contributionService.cjs");
const { PLUGIN_PROTOCOL_SCHEME } = require("./constants.cjs");

const VIEW_CHANNELS = Object.freeze({
  postMessage: "netcatty-plugin-view:post-message",
  executeCommand: "netcatty-plugin-view:execute-command",
  getState: "netcatty-plugin-view:get-state",
  getEnvironment: "netcatty-plugin-view:get-environment",
  setState: "netcatty-plugin-view:set-state",
});

function normalizeBounds(bounds) {
  const value = bounds ?? { x: 0, y: 0, width: 480, height: 320 };
  const normalized = {};
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isSafeInteger(value[key])) throw new TypeError("Plugin view bounds must use safe integers");
    normalized[key] = value[key];
  }
  if (normalized.width < 1 || normalized.height < 1 || normalized.width > 16_384 || normalized.height > 16_384) {
    throw new TypeError("Plugin view bounds are invalid");
  }
  return normalized;
}

class PluginViewHost {
  constructor(options) {
    this.electron = options.electron;
    this.protocol = options.protocol;
    this.packageStore = options.packageStore;
    this.database = options.database;
    this.contributionService = options.contributionService;
    this.preloadPath = options.preloadPath ?? path.join(__dirname, "runtime", "viewPreload.cjs");
    this.instances = new Map();
    this.opening = new Map();
    this.closed = false;
    this.isLocked = options.isLocked ?? (() => false);
    this.subscriptions = [];
    const unsubscribeLock = options.subscribeLock?.((state) => {
      if (!state.locked) return;
      for (const opening of this.opening.values()) opening.cancelled = true;
      for (const instanceId of [...this.instances.keys()]) void this.close(instanceId, undefined, "app-locked");
    });
    this.subscriptions.push({ dispose: () => unsubscribeLock?.() });
    this.byWebContentsId = new Map();
    this.closeListeners = new Set();
    this.environment = { locale: "en", theme: "system", reducedMotion: false, highContrast: false };
    this.#registerIpc();
    this.subscriptions.push(this.contributionService.onDidPostViewMessage((event) => {
      for (const instance of this.instances.values()) {
        if (instance.pluginId === event.pluginId && instance.viewId === event.viewId) {
          instance.contents.send("netcatty-plugin-view:message", event.message);
        }
      }
    }));
    this.subscriptions.push(this.contributionService.onDidChange?.((event) => {
      for (const instance of [...this.instances.values()]) {
        if (["plugin-disabled", "runtime-stopped", "runtime-error", "runtime-quarantined"].includes(event.reason)
          && instance.pluginId === event.pluginId) {
          void this.close(instance.instanceId, undefined, event.reason);
        } else if (["vault-page", "terminal-sidebar"].includes(instance.location)) {
          try { this.contributionService.assertViewActivationCurrent(instance.activation, { context: instance.context }); }
          catch { void this.close(instance.instanceId, undefined, "contribution-unavailable"); }
        }
      }
    }));
  }

  onDidClose(listener) {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  #registerIpc() {
    const ipcMain = this.electron.ipcMain;
    if (!ipcMain?.handle) return;
    const instanceFor = (event) => {
      const instance = this.byWebContentsId.get(event.sender?.id);
      if (!instance || instance.contents !== event.sender) throw new Error("Untrusted plugin view sender");
      return instance;
    };
    ipcMain.handle(VIEW_CHANNELS.postMessage, async (event, message) => {
      const instance = instanceFor(event);
      assertJsonValue(message, "view message");
      await this.contributionService.runtimeSupervisor.notify(instance.pluginId, "plugin.view.message", {
        viewId: instance.viewId,
        message,
      });
      return null;
    });
    ipcMain.handle(VIEW_CHANNELS.executeCommand, (event, payload) => {
      const instance = instanceFor(event);
      return this.contributionService.executeCommand(payload?.command, payload?.args, {
        source: "view",
        callerPluginId: instance.pluginId,
        context: { "netcatty.view": instance.viewId },
      });
    });
    ipcMain.handle(VIEW_CHANNELS.getState, (event) => {
      const instance = instanceFor(event);
      return this.database.getViewState(instance.pluginId, instance.viewId, instance.scopeId);
    });
    ipcMain.handle(VIEW_CHANNELS.getEnvironment, (event) => {
      instanceFor(event);
      return structuredClone(this.environment);
    });
    ipcMain.handle(VIEW_CHANNELS.setState, (event, state) => {
      const instance = instanceFor(event);
      assertJsonValue(state, "view state");
      this.database.setViewState(instance.pluginId, instance.viewId, instance.scopeId, state);
      return null;
    });
  }

  #ownedInstance(instanceId, sender) {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Plugin view was not found: ${instanceId}`);
    if (sender) {
      const owner = this.electron.BrowserWindow.fromWebContents(sender);
      if (!owner || instance.owner !== owner) throw new Error("Plugin view belongs to another window");
    }
    return instance;
  }

  async open(payload, sender) {
    if (!payload || typeof payload !== "object") throw new TypeError("Plugin view request is invalid");
    const owner = this.electron.BrowserWindow.fromWebContents(sender);
    if (this.closed || this.isLocked() || !owner || owner.isDestroyed()) throw new Error("Plugin view owner is unavailable");
    const instanceId = typeof payload.instanceId === "string" && payload.instanceId.length <= 128
      ? payload.instanceId : randomUUID();
    if (this.instances.has(instanceId) || this.opening.has(instanceId)) throw new Error(`Plugin view already exists: ${instanceId}`);
    const opening = { owner, cancelled: false };
    const cancel = () => { opening.cancelled = true; };
    const rendererGone = () => { void this.close(instanceId, undefined, "owner-renderer-gone"); };
    const navigate = (details, _url, isInPlace, isMainFrame) => {
      if ((details?.isMainFrame ?? isMainFrame) !== false && (details?.isSameDocument ?? isInPlace) !== true) rendererGone();
    };
    const cleanupOwner = () => {
      sender.removeListener?.("render-process-gone", rendererGone);
      sender.removeListener?.("did-start-navigation", navigate);
    };
    this.opening.set(instanceId, opening);
    owner.once?.("closed", cancel);
    sender.on?.("render-process-gone", rendererGone);
    sender.on?.("did-start-navigation", navigate);
    try { return await this.#open({ ...payload, instanceId }, sender, opening); }
    finally {
      owner.removeListener?.("closed", cancel);
      const instance = this.instances.get(instanceId);
      if (instance) instance.cleanupOwner = cleanupOwner;
      else cleanupOwner();
      if (this.opening.get(instanceId) === opening) this.opening.delete(instanceId);
    }
  }

  #assertOpening(opening) {
    if (this.closed || this.isLocked() || opening.cancelled || opening.owner.isDestroyed()) throw new Error("Plugin view opening was cancelled");
  }

  async #open(payload, sender, opening) {
    const { plugin, view, identity } = await this.contributionService.activateView(
      payload.viewId,
      { context: payload.context },
    );
    this.#assertOpening(opening);
    const activation = Object.freeze({
      pluginId: plugin.id,
      pluginVersion: plugin.activeVersion,
      viewId: view.id,
      runtimeId: identity?.runtimeId ?? null,
    });
    if (!activation.runtimeId) throw new Error("Plugin view runtime identity is unavailable");
    const scopeId = typeof payload.scopeId === "string" && payload.scopeId.length <= 256 ? payload.scopeId : null;
    if (!scopeId) throw new TypeError("Plugin view scope ID is required");
    const owner = this.electron.BrowserWindow.fromWebContents(sender);
    if (!owner || owner.isDestroyed()) throw new Error("Plugin view owner is unavailable");
    const instanceId = typeof payload.instanceId === "string" && payload.instanceId.length <= 128
      ? payload.instanceId
      : randomUUID();
    if (this.instances.has(instanceId)) throw new Error(`Plugin view already exists: ${instanceId}`);
    const packageRoot = await this.packageStore.preparePackageRoot(plugin);
    this.#assertOpening(opening);
    this.contributionService.assertViewActivationCurrent(activation, { context: payload.context });
    const partition = `netcatty-plugin-view-${randomUUID()}`;
    const pluginSession = this.electron.session.fromPartition(partition, { cache: false });
    let registration;
    let sessionRegistration;
    try {
      registration = this.protocol.registerView({
        pluginId: plugin.id,
        packageRoot,
        entry: view.entry,
      });
      sessionRegistration = this.protocol.registerSession(pluginSession);
      await pluginSession.setProxy({
        mode: "fixed_servers",
        proxyRules: "http=127.0.0.1:9;https=127.0.0.1:9;socks=127.0.0.1:9",
        proxyBypassRules: "<-loopback>",
      });
      pluginSession.on("will-download", (event) => event.preventDefault());
      pluginSession.setPermissionCheckHandler?.(() => false);
      pluginSession.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));
      pluginSession.setDevicePermissionHandler?.(() => false);
      pluginSession.webRequest.onBeforeRequest((details, callback) => {
        try {
          const url = new URL(details.url);
          callback({ cancel: url.protocol !== `${PLUGIN_PROTOCOL_SCHEME}:` || url.hostname !== registration.token });
        } catch { callback({ cancel: true }); }
      });
      const contentsView = new this.electron.WebContentsView({
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          contextIsolation: true,
          webSecurity: true,
          devTools: false,
          disableDialogs: true,
          navigateOnDragDrop: false,
          session: pluginSession,
          preload: this.preloadPath,
        },
      });
      const contents = contentsView.webContents;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", (event, url) => {
        if (url !== registration.url) event.preventDefault();
      });
      contents.on("will-attach-webview", (event) => event.preventDefault());
      contents.once("render-process-gone", () => { void this.close(instanceId, undefined, "view-renderer-gone"); });
      if (["vault-page", "terminal-sidebar"].includes(view.location)) contents.on("before-input-event", (event, input) => {
        if (input.type === "keyDown" && input.key === "Escape" && !input.control && !input.meta && !input.alt && !input.shift) {
          event.preventDefault();
          void this.close(instanceId, undefined, "host-escape");
        }
      });
      const ownerClosed = () => { void this.close(instanceId, undefined, "owner-closed"); };
      const instance = {
        instanceId,
        pluginId: plugin.id,
        viewId: view.id,
        scopeId,
        location: view.location,
        activation,
        context: structuredClone(payload.context ?? {}),
        owner,
        ownerClosed,
        view: contentsView,
        contents,
        registration,
        sessionRegistration,
        state: "opening",
        attached: false,
        visible: !["vault-page", "terminal-sidebar"].includes(view.location),
      };
      this.instances.set(instanceId, instance);
      contents.on("focus", () => {
        if (this.instances.get(instanceId) !== instance || instance.state !== "open") return;
        try { owner.webContents?.send("netcatty:plugins:view-focused", { instanceId }); } catch {}
      });
      this.byWebContentsId.set(contents.id, instance);
      owner.once?.("closed", ownerClosed);
      contents.once("destroyed", () => { void this.close(instanceId, undefined, "contents-destroyed"); });
      await contents.loadURL(registration.url);
      this.contributionService.assertViewActivationCurrent(activation, { context: payload.context });
      if (this.instances.get(instanceId) !== instance || instance.state !== "opening"
        || owner.isDestroyed() || contents.isDestroyed()) {
        throw new Error("Plugin view ownership changed while opening");
      }
      this.#assertOpening(opening);
      // Embedded pages start hidden until the trusted renderer checks host
      // dialogs/lock/popovers. A late open must never cover a security surface.
      if (["vault-page", "terminal-sidebar"].includes(view.location)) contentsView.setVisible(false);
      owner.contentView.addChildView(contentsView);
      instance.attached = true;
      contentsView.setBounds(normalizeBounds(payload.bounds));
      instance.state = "open";
      contents.send("netcatty-plugin-view:environment", this.environment);
      return { instanceId };
    } catch (error) {
      if (this.instances.has(instanceId)) await this.close(instanceId, undefined, "open-failed");
      else {
        try { registration?.dispose(); } catch {}
        try { sessionRegistration?.dispose(); } catch {}
      }
      throw error;
    }
  }

  setBounds(instanceId, bounds, sender) {
    const instance = this.#ownedInstance(instanceId, sender);
    instance.view.setBounds(normalizeBounds(bounds));
  }

  setVisible(instanceId, visible, sender) {
    if (typeof visible !== "boolean") throw new TypeError("Plugin view visibility must be a boolean");
    const instance = this.#ownedInstance(instanceId, sender);
    if (visible && this.isLocked()) throw new Error("Plugin view owner is unavailable");
    const rising = visible && !instance.visible;
    instance.visible = visible;
    instance.view.setVisible(visible);
    if (rising && instance.location === "vault-page" && instance.owner.isFocused?.()) instance.contents.focus?.();
  }

  focus(instanceId, sender) {
    const instance = this.#ownedInstance(instanceId, sender);
    if (!instance.visible || this.isLocked() || instance.owner.isFocused?.() !== true) return;
    instance.contents.focus?.();
  }

  async postMessage(instanceId, message, sender) {
    const instance = this.#ownedInstance(instanceId, sender);
    assertJsonValue(message, "view message");
    instance.contents.send("netcatty-plugin-view:message", message);
  }

  setEnvironment(environment) {
    assertJsonValue(environment, "environment");
    this.environment = { ...environment };
    for (const instance of this.instances.values()) {
      instance.contents.send("netcatty-plugin-view:environment", this.environment);
    }
  }

  async close(instanceId, sender, reason = sender ? "renderer-requested" : "host-requested") {
    const opening = this.opening.get(instanceId);
    if (opening) {
      if (sender && this.electron.BrowserWindow.fromWebContents(sender) !== opening.owner) throw new Error("Untrusted plugin view owner");
      opening.cancelled = true;
    }
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    if (sender) this.#ownedInstance(instanceId, sender);
    this.instances.delete(instanceId);
    this.byWebContentsId.delete(instance.contents.id);
    try { instance.cleanupOwner?.(); } catch {}
    try { instance.owner.removeListener?.("closed", instance.ownerClosed); } catch {}
    if (instance.attached) {
      try { instance.owner.contentView.removeChildView(instance.view); } catch {}
    }
    try { instance.registration.dispose(); } catch {}
    try { instance.sessionRegistration.dispose(); } catch {}
    try {
      if (!instance.contents.isDestroyed()) {
        if (typeof instance.contents.close === "function") instance.contents.close();
        else instance.contents.destroy?.();
      }
    } catch {}
    const event = Object.freeze({
      instanceId: instance.instanceId,
      pluginId: instance.pluginId,
      viewId: instance.viewId,
      reason,
    });
    for (const listener of this.closeListeners) {
      try { listener(event); } catch {}
    }
  }

  async shutdown() {
    this.closed = true;
    for (const opening of this.opening.values()) opening.cancelled = true;
    await Promise.all([...this.instances.keys()].map((instanceId) => this.close(instanceId)));
    for (const subscription of this.subscriptions.splice(0)) subscription?.dispose?.();
    this.closeListeners.clear();
  }
}

module.exports = { PluginViewHost, VIEW_CHANNELS, normalizeBounds };
