"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { PluginViewHost, normalizeBounds } = require("./pluginViewHost.cjs");

function fixture(options = {}) {
  const ipcHandlers = new Map();
  const senderOwners = new Map();
  const sessions = [];
  const views = [];
  let nextContentsId = 10;
  class FakeContents extends EventEmitter {
    constructor() {
      super();
      this.id = nextContentsId++;
      this.sent = [];
      this.destroyed = false;
    }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
    async loadURL(url) {
      this.loadedUrl = url;
      if (options.loadURL) await options.loadURL(this);
    }
    send(channel, payload) { this.sent.push([channel, payload]); }
    focus() { this.emit("focus"); }
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit("destroyed"); }
  }
  class FakeWebContentsView {
    constructor(optionsValue) {
      this.options = optionsValue;
      this.webContents = new FakeContents();
      views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
  }
  const electron = {
    ipcMain: { handle(channel, handler) { ipcHandlers.set(channel, handler); } },
    BrowserWindow: { fromWebContents(sender) { return senderOwners.get(sender) ?? null; } },
    WebContentsView: FakeWebContentsView,
    session: {
      fromPartition(partition, sessionOptions) {
        const pluginSession = new EventEmitter();
        pluginSession.partition = partition;
        pluginSession.options = sessionOptions;
        pluginSession.permissions = {};
        pluginSession.webRequest = {
          onBeforeRequest(handler) { pluginSession.beforeRequest = handler; },
        };
        pluginSession.setProxy = options.setProxy ?? (async (proxy) => { pluginSession.proxy = proxy; });
        pluginSession.setPermissionCheckHandler = (handler) => { pluginSession.permissions.check = handler; };
        pluginSession.setPermissionRequestHandler = (handler) => { pluginSession.permissions.request = handler; };
        pluginSession.setDevicePermissionHandler = (handler) => { pluginSession.permissions.device = handler; };
        sessions.push(pluginSession);
        return pluginSession;
      },
    },
  };
  const disposals = [];
  const protocol = {
    registerView() {
      return {
        token: "view-token",
        url: "netcatty-plugin://view-token/package/view.html",
        dispose() {
          disposals.push("view");
          if (options.disposeViewThrows) throw new Error("view cleanup failed");
        },
      };
    },
    registerSession() {
      return { dispose() {
        disposals.push("session");
        if (options.disposeSessionThrows) throw new Error("session cleanup failed");
      } };
    },
  };
  let viewListener;
  let changeListener;
  let activationCurrent = true;
  let activationChecks = 0;
  const contributionService = {
    runtimeSupervisor: { async notify(...args) { return args; } },
    onDidPostViewMessage(listener) { viewListener = listener; return { dispose() {} }; },
    onDidChange(listener) { changeListener = listener; return { dispose() {} }; },
    async activateView() {
      await options.activateView?.();
      return {
        plugin: { id: "com.example.view", activeVersion: "1.0.0" },
        view: { id: "com.example.view.panel", entry: "view.html", location: options.location ?? "aside" },
        identity: { runtimeId: "runtime-view-1", pluginVersion: "1.0.0" },
      };
    },
    assertViewActivationCurrent(expected) {
      activationChecks += 1;
      if (!activationCurrent) throw new Error("Plugin view ownership changed while opening");
      assert.deepEqual(expected, {
        pluginId: "com.example.view",
        pluginVersion: "1.0.0",
        viewId: "com.example.view.panel",
        runtimeId: "runtime-view-1",
      });
      return expected;
    },
    async executeCommand(command, args, invocation) { return { command, args, invocation }; },
  };
  const state = new Map();
  const host = new PluginViewHost({
    electron,
    protocol,
    packageStore: {
      async preparePackageRoot() {
        if (options.preparePackageRoot) await options.preparePackageRoot();
        return "/package";
      },
    },
    database: {
      getViewState(pluginId, viewId, scopeId) { return state.get(`${pluginId}:${viewId}:${scopeId}`); },
      setViewState(pluginId, viewId, scopeId, value) { state.set(`${pluginId}:${viewId}:${scopeId}`, value); },
    },
    contributionService,
    isLocked: options.isLocked,
    subscribeLock: options.subscribeLock,
    preloadPath: "/runtime/viewPreload.cjs",
  });
  function createOwner() {
    const owner = new EventEmitter();
    owner.children = [];
    owner.isDestroyed = () => false;
    owner.contentView = {
      addChildView(view) { owner.children.push(view); },
      removeChildView(view) { owner.children = owner.children.filter((entry) => entry !== view); },
    };
    const sender = new EventEmitter();
    senderOwners.set(sender, owner);
    return { owner, sender };
  }
  return {
    changeListener: () => changeListener,
    contributionService,
    createOwner,
    disposals,
    host,
    ipcHandlers,
    sessions,
    activationChecks: () => activationChecks,
    setActivationCurrent(value) { activationCurrent = value; },
    viewListener: () => viewListener,
    views,
  };
}

test("plugin view bounds reject unsafe or oversized geometry", () => {
  assert.deepEqual(normalizeBounds({ x: 1, y: 2, width: 640, height: 480 }), { x: 1, y: 2, width: 640, height: 480 });
  assert.throws(() => normalizeBounds({ x: 0.5, y: 0, width: 1, height: 1 }), /safe integers/u);
  assert.throws(() => normalizeBounds({ x: 0, y: 0, width: 20_000, height: 1 }), /invalid/u);
});

test("custom views use an ephemeral sandbox and deny direct browser capabilities", async () => {
  const value = fixture();
  const { owner, sender } = value.createOwner();
  const opened = await value.host.open({
    viewId: "com.example.view.panel",
    scopeId: "window-1",
    instanceId: "view-1",
    bounds: { x: 5, y: 6, width: 700, height: 500 },
  }, sender);
  assert.deepEqual(opened, { instanceId: "view-1" });
  const contentsView = value.views[0];
  assert.deepEqual(contentsView.options.webPreferences, {
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    webSecurity: true,
    devTools: false,
    disableDialogs: true,
    navigateOnDragDrop: false,
    session: value.sessions[0],
    preload: "/runtime/viewPreload.cjs",
  });
  assert.match(value.sessions[0].partition, /^netcatty-plugin-view-/u);
  assert.deepEqual(value.sessions[0].options, { cache: false });
  assert.equal(value.sessions[0].permissions.check(), false);
  assert.equal(value.sessions[0].permissions.device(), false);
  let permissionDecision;
  value.sessions[0].permissions.request(null, "camera", (decision) => { permissionDecision = decision; });
  assert.equal(permissionDecision, false);
  let allowed;
  value.sessions[0].beforeRequest({ url: "netcatty-plugin://view-token/package/view.js" }, (decision) => { allowed = decision; });
  assert.deepEqual(allowed, { cancel: false });
  value.sessions[0].beforeRequest({ url: "https://example.com/track" }, (decision) => { allowed = decision; });
  assert.deepEqual(allowed, { cancel: true });
  assert.deepEqual(contentsView.webContents.windowOpenHandler(), { action: "deny" });
  const navigation = { prevented: false, preventDefault() { this.prevented = true; } };
  contentsView.webContents.emit("will-navigate", navigation, "https://example.com");
  assert.equal(navigation.prevented, true);
  assert.deepEqual(contentsView.bounds, { x: 5, y: 6, width: 700, height: 500 });
  assert.equal(owner.children.length, 1);
  assert.equal(value.activationChecks(), 2);
  const environment = {
    locale: "zh-CN",
    theme: "dark",
    reducedMotion: true,
    highContrast: false,
    themeTokens: { "--background": "220 10% 10%" },
  };
  value.host.setEnvironment(environment);
  assert.deepEqual(await value.ipcHandlers.get("netcatty-plugin-view:get-environment")(
    { sender: contentsView.webContents },
  ), environment);
  value.host.setVisible("view-1", false, sender);
  assert.equal(contentsView.visible, false);
  assert.deepEqual(await value.ipcHandlers.get("netcatty-plugin-view:execute-command")(
    { sender: contentsView.webContents },
    { command: "com.example.view.run", args: { selected: 1 } },
  ), {
    command: "com.example.view.run",
    args: { selected: 1 },
    invocation: {
      source: "view",
      callerPluginId: "com.example.view",
      context: { "netcatty.view": "com.example.view.panel" },
    },
  });

  const other = value.createOwner();
  assert.throws(() => value.host.setVisible("view-1", true, other.sender), /another window/u);
  assert.throws(() => value.host.setBounds("view-1", { x: 0, y: 0, width: 1, height: 1 }, other.sender), /another window/u);
  await assert.rejects(value.host.close("view-1", other.sender), /another window/u);
  owner.emit("closed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(owner.children.length, 0);
  assert.deepEqual(value.disposals.sort(), ["session", "view"]);
});

test("view setup failures dispose protocol registrations before exposing an instance", async () => {
  const value = fixture({ setProxy: async () => { throw new Error("proxy unavailable"); } });
  const { sender } = value.createOwner();
  await assert.rejects(value.host.open({
    viewId: "com.example.view.panel",
    scopeId: "window-1",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
  }, sender), /proxy unavailable/u);
  assert.deepEqual(value.disposals.sort(), ["session", "view"]);
  assert.equal(value.views.length, 0);
});

test("terminal runtime states close every open view owned by the plugin", async () => {
  for (const reason of ["runtime-stopped", "runtime-error", "runtime-quarantined"]) {
    const value = fixture();
    const { owner, sender } = value.createOwner();
    await value.host.open({
      viewId: "com.example.view.panel",
      scopeId: "window-1",
      instanceId: `view-${reason}`,
      bounds: { x: 0, y: 0, width: 320, height: 240 },
    }, sender);
    assert.equal(owner.children.length, 1);

    value.changeListener()({ reason, pluginId: "com.example.view" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(owner.children.length, 0);
    assert.deepEqual(value.disposals.sort(), ["session", "view"]);
  }
});

test("plugin replacement during package preparation cannot publish a stale view", async () => {
  let releasePackage;
  const packageReady = new Promise((resolve) => { releasePackage = resolve; });
  const value = fixture({ preparePackageRoot: () => packageReady });
  const { owner, sender } = value.createOwner();
  const opening = value.host.open({
    viewId: "com.example.view.panel",
    scopeId: "window-1",
    instanceId: "view-replaced",
    bounds: { x: 0, y: 0, width: 320, height: 240 },
  }, sender);
  value.setActivationCurrent(false);
  releasePackage();

  await assert.rejects(opening, /ownership changed/u);
  assert.equal(owner.children.length, 0);
  assert.equal(value.views.length, 0);
});

test("runtime shutdown cancels an in-flight view before it attaches and publishes a close event", async () => {
  let releaseLoad;
  const loadReady = new Promise((resolve) => { releaseLoad = resolve; });
  const value = fixture({ loadURL: () => loadReady });
  const { owner, sender } = value.createOwner();
  const closed = [];
  value.host.onDidClose((event) => closed.push(event));
  const opening = value.host.open({
    viewId: "com.example.view.panel",
    scopeId: "window-1",
    instanceId: "view-opening",
    bounds: { x: 0, y: 0, width: 320, height: 240 },
  }, sender);
  while (value.views.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(owner.children.length, 0);

  value.changeListener()({ reason: "runtime-stopped", pluginId: "com.example.view" });
  await new Promise((resolve) => setImmediate(resolve));
  releaseLoad();

  await assert.rejects(opening, /ownership changed/u);
  assert.equal(owner.children.length, 0);
  assert.equal(value.views[0].webContents.destroyed, true);
  assert.deepEqual(closed, [{
    instanceId: "view-opening",
    pluginId: "com.example.view",
    viewId: "com.example.view.panel",
    reason: "runtime-stopped",
  }]);
});

test("view cleanup failures cannot suppress owner removal or the renderer close signal", async () => {
  const value = fixture({ disposeViewThrows: true, disposeSessionThrows: true });
  const { owner, sender } = value.createOwner();
  const closed = [];
  value.host.onDidClose((event) => closed.push(event));
  await value.host.open({
    viewId: "com.example.view.panel",
    scopeId: "window-1",
    instanceId: "view-cleanup-failure",
    bounds: { x: 0, y: 0, width: 320, height: 240 },
  }, sender);

  await value.host.close("view-cleanup-failure", sender);

  assert.equal(owner.children.length, 0);
  assert.equal(value.views[0].webContents.destroyed, true);
  assert.deepEqual(value.disposals, ["view", "session"]);
  assert.deepEqual(closed, [{
    instanceId: "view-cleanup-failure",
    pluginId: "com.example.view",
    viewId: "com.example.view.panel",
    reason: "renderer-requested",
  }]);
});

test("Vault pages start hidden and are withdrawn when their current contribution is no longer available", async () => {
  const value = fixture({ location: "vault-page" });
  const { owner, sender } = value.createOwner();
  const result = await value.host.open({ viewId: "com.example.view.panel", scopeId: "window-1:vault-page" }, sender);
  assert.equal(owner.children.length, 1);
  assert.equal(value.views[0].visible, false, "host modal checks precede native visibility");
  value.host.setVisible(result.instanceId, true, sender);
  assert.equal(value.views[0].visible, true);
  value.setActivationCurrent(false);
  value.changeListener()({ reason: "context-key-changed" });
  assert.equal(owner.children.length, 0);
  assert.equal(value.views[0].webContents.destroyed, true);
  await value.host.shutdown();
});

test("closing a reserved owner instance cancels activation before any native page is constructed", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const value = fixture({ location: "vault-page", activateView: () => gate });
  const { owner, sender } = value.createOwner();
  const other = value.createOwner();
  const opening = value.host.open({ viewId: "com.example.view.panel", scopeId: "window-1:vault-page", instanceId: "reserved-page" }, sender);
  await assert.rejects(value.host.close("reserved-page", other.sender), /Untrusted/);
  await value.host.close("reserved-page", sender);
  release();
  await assert.rejects(opening, /cancelled/);
  assert.equal(value.views.length, 0);
  assert.equal(owner.children.length, 0);
  assert.equal(value.host.opening.size, 0);
  await value.host.shutdown();
});

test("app lock closes attached pages and cancels pending opens, with subscription cleanup", async () => {
  let listener, locked = false, disposed = 0;
  const value = fixture({ location: "vault-page", isLocked: () => locked,
    subscribeLock(fn) { listener = fn; return () => { disposed++; }; } });
  const { owner, sender } = value.createOwner();
  const result = await value.host.open({ viewId: "com.example.view.panel", scopeId: "window-1:vault-page" }, sender);
  locked = true; listener({ locked: true });
  assert.equal(owner.children.length, 0);
  assert.equal(value.views[0].webContents.destroyed, true);
  await assert.rejects(value.host.open({ viewId: "com.example.view.panel", scopeId: "window-1:vault-page" }, sender), /unavailable/);
  assert.throws(() => value.host.setVisible(result.instanceId, true, sender));
  await value.host.shutdown();
  assert.equal(disposed, 1);
});

test("browser Scratchpad saves, reopens and clears only its own view state through the real host IPC", async () => {
  const { readFile } = require("node:fs/promises");
  const path = require("node:path");
  const { JSDOM } = require("jsdom");
  const { VIEW_CHANNELS } = require("./pluginViewHost.cjs");
  const html = await readFile(path.join(__dirname, "../../examples/plugins/vault-scratchpad/page.html"), "utf8");
  const script = await readFile(path.join(__dirname, "../../examples/plugins/vault-scratchpad/page.js"), "utf8");
  const value = fixture({ location: "vault-page" });
  const { sender } = value.createOwner();
  async function open(scopeId) {
    const result = await value.host.open({ viewId: "com.example.view.panel", scopeId }, sender);
    const contents = value.host.instances.get(result.instanceId).contents;
    const dom = new JSDOM(html, { runScripts: "outside-only" });
    dom.window.netcattyView = {
      getState: async () => value.ipcHandlers.get(VIEW_CHANNELS.getState)({ sender: contents }),
      setState: async (state) => value.ipcHandlers.get(VIEW_CHANNELS.setState)({ sender: contents }, structuredClone(state)),
    };
    dom.window.eval(script);
    await new Promise((resolve) => setImmediate(resolve));
    return { dom, document: dom.window.document, id: result.instanceId, contents };
  }
  const first = await open("window-1:vault-page");
  first.document.getElementById("draft").value = "synthetic private draft";
  first.document.getElementById("save").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(first.document.getElementById("status").textContent, /saved/);
  await value.host.close(first.id, sender); first.dom.window.close();
  const separate = await open("window-2:vault-page");
  assert.equal(separate.document.getElementById("draft").value, "", "a different host-owned state scope does not inherit this draft");
  const reopened = await open("window-1:vault-page");
  assert.equal(reopened.document.getElementById("draft").value, "synthetic private draft");
  reopened.document.getElementById("clear").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reopened.document.getElementById("draft").value, "");
  const cleared = await open("window-1:vault-page");
  assert.equal(cleared.document.getElementById("draft").value, "");
  await value.host.shutdown();
  assert.throws(() => value.ipcHandlers.get(VIEW_CHANNELS.getState)({ sender: reopened.contents }), /Untrusted/);
  for (const panel of [separate, reopened, cleared]) panel.dom.window.close();
});

test("host reload, host/view renderer exit, and host Escape close embedded pages", async () => {
  for (const action of ["reload", "host-exit", "view-exit", "escape"]) {
    const value = fixture({ location: "vault-page" });
    const { sender, owner } = value.createOwner();
    const opened = await value.host.open({ viewId: "com.example.view.panel", scopeId: "window-1:vault-page" }, sender);
    const contents = value.views[0].webContents;
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    assert.equal(owner.children.length, 1);
    if (action === "reload") sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    if (action === "host-exit") sender.emit("render-process-gone");
    if (action === "view-exit") contents.emit("render-process-gone");
    if (action === "escape") {
      let prevented = false;
      contents.emit("before-input-event", { preventDefault() { prevented = true; } }, { type: "keyDown", key: "Escape" });
      assert.equal(prevented, true);
    }
    assert.equal(owner.children.length, 0, action);
    assert.equal(value.host.instances.has(opened.instanceId), false, action);
    assert.equal(sender.listenerCount("render-process-gone"), 0, action);
    await value.host.shutdown();
  }
});

test("sidebar native focus is explicit, owner-bound and cannot raise a hidden or locked page", async () => {
  let locked = false;
  const value = fixture({ location: "terminal-sidebar", isLocked: () => locked });
  const { owner, sender } = value.createOwner(); const other = value.createOwner();
  const events = [];
  sender.send = (channel, event) => events.push({ channel, event }); owner.webContents = sender; owner.isFocused = () => true;
  const { instanceId } = await value.host.open({ viewId: "com.example.view.panel", scopeId: "window-1:terminal-sidebar" }, sender);
  assert.equal(value.views[0].visible, false);
  value.host.focus(instanceId, sender); assert.deepEqual(events, []);
  value.host.setVisible(instanceId, true, sender); assert.deepEqual(events, [], "revealing multiple panes does not focus each one");
  assert.throws(() => value.host.focus(instanceId, other.sender), /another window/i);
  value.host.focus(instanceId, sender);
  assert.deepEqual(events, [{ channel: "netcatty:plugins:view-focused", event: { instanceId } }]);
  locked = true; value.host.focus(instanceId, sender); assert.equal(events.length, 1);
  locked = false; value.setActivationCurrent(false); value.changeListener()({ reason: "context-key-changed" });
  assert.equal(owner.children.length, 0); await value.host.shutdown();
});
