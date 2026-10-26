"use strict";
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { MessageChannel } = require("node:worker_threads");
const { PluginRpcRouter } = require("./rpcRouter.cjs");
const { PluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");
const { PluginPermissionEngine } = require("./permissionEngine.cjs");
const { PluginHostInteractionService } = require("./hostInteractionService.cjs");

for (const source of ["compose", "share"]) test(`normal browser example completes the ${source} text workflow through permission middleware`, async () => {
  const { startPluginRuntime } = await import("./runtime/runtimePeer.mjs");
  const plugin = await import("../../examples/plugins/host-interactions/browser.js");
  const manifest = JSON.parse(await readFile(new URL("../../examples/plugins/host-interactions/netcatty.plugin.json", pathToFileURL(__filename)), "utf8"));
  const audit = [], copied = [], requests = [];
  let reads = 0, active = true;
  const database = { listPermissionGrants: () => [], recordSecurityAudit(...args) { audit.push(args); } };
  const permissionEngine = new PluginPermissionEngine({ database,
    requestDecision: async (request) => { requests.push(request.permission); return { requestId: request.requestId, decision: "allow", scope: "once" }; },
  });
  let service;
  const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false,
    send(_channel, message) {
      if (message.closed) return;
      queueMicrotask(() => {
        const action = message.request.kind === "clipboard.read" && message.phase === "request" ? "preview" : "submit";
        const value = message.request.kind === "quickPick" ? source : message.request.kind === "input" ? "synthetic output" : undefined;
        void service.respond(sender, { requestId: message.requestId, actionToken: message.actionToken, action, ...(value === undefined ? {} : { value }) }).catch(() => {});
      });
    },
  });
  const window = Object.assign(new EventEmitter(), { webContents: sender, isFocused: () => true, isVisible: () => true, isDestroyed: () => false });
  service = new PluginHostInteractionService({ database, permissionEngine, getWindow: () => window, isLocked: () => false,
    quotaManager: { chargeBytes() {} },
    clipboard: { readText() { reads++; return "synthetic private text"; }, writeText(text) { copied.push(text); } },
  });
  service.setReady(sender, true);
  const registry = new PluginHostRpcRegistry();
  registry.use(permissionEngine.createMiddleware()); service.registerRpcCapabilities(registry);
  const routes = registry.createRoutes({ pluginId: manifest.id, pluginVersion: manifest.version, runtimeId: "runtime-synthetic", runtimeKind: "browser", manifest,
    assertCurrent() { if (!active) throw new Error("stale runtime"); },
  });
  const { port1, port2 } = new MessageChannel();
  const host = new PluginRpcRouter({ pluginId: manifest.id, send: (message) => port1.postMessage(message), handlers: routes.requestHandlers });
  port1.on("message", (message) => { void host.accept(message); });
  const peer = await startPluginRuntime({ port: port2,
    config: { pluginId: manifest.id, pluginVersion: manifest.version, netcattyVersion: "0.0.0", apiVersion: "0.1.0-internal.1", enabledFeatures: ["host.interactions"] },
    loadPlugin: async () => plugin,
  });
  try {
    await host.request("plugin.initialize", { netcattyVersion: "0.0.0", apiVersion: "0.1.0-internal.1", supportedFeatures: ["host.interactions"] });
    await host.request("plugin.activate", {});
    const result = await host.request("plugin.command.execute", { command: "com.netcatty.host-interactions.text", invocation: { source: "palette" } });
    const output = source === "compose" ? "synthetic output" : "SYNTHETIC PRIVATE TEXT";
    assert.deepEqual(result, { copied: true, characters: output.length });
    assert.deepEqual(copied, [output]); assert.equal(reads, source === "share" ? 1 : 0);
    assert.ok(requests.includes("ui.interact")); assert.ok(requests.includes("clipboard.write"));
    assert.equal(requests.includes("clipboard.read"), source === "share");
    assert.equal(JSON.stringify(audit).includes("synthetic private text"), false);
    assert.equal(JSON.stringify(audit).includes("synthetic output"), false);
    assert.equal(service.pending.size, 0);
  } finally { active = false; await peer.dispose(); host.close(); port1.close(); service.shutdown(); permissionEngine.shutdown(); }
});
