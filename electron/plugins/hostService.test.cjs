"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPluginHostService } = require("./hostService.cjs");

function createOptions(root, configureRpcRegistry) {
  return {
    app: {
      getAppPath: () => process.cwd(),
      getPath: () => root,
      getVersion: () => "0.0.0",
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    electron: {},
    configureRpcRegistry,
  };
}

function transportContext() {
  return {
    signal: new AbortController().signal,
    logger: { write: async () => {} },
  };
}

test("host RPC registry configuration is complete before runtime initialization", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createPluginHostService(createOptions(root, (registry) => {
    registry.registerRequest("custom.test", () => null);
  }));
  context.after(() => service.database.close());
  const routes = service.rpcRegistry.createRoutes({
    pluginId: "com.example.service",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "browser",
  });
  assert.equal(typeof routes.requestHandlers["custom.test"], "function");
  assert.equal(typeof service.terminalProviderService.provide, "function");
});

test("async host RPC registry configuration fails before a service can start", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => createPluginHostService(createOptions(root, async () => {})),
    /must be synchronous/,
  );
});

test("host service forwards the transport quota guard to the runtime supervisor", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let guarded;
  const runtimeMessageGuard = (identity, message) => { guarded = { identity, message }; };
  const service = createPluginHostService({
    ...createOptions(root),
    runtimeMessageGuard,
  });
  context.after(() => service.database.close());
  const identity = { runtimeId: "runtime-1" };
  const message = { jsonrpc: "2.0" };
  service.runtimeSupervisor.runtimeMessageGuard(identity, message);
  assert.deepEqual(guarded, { identity, message });
});

test("host service seeds the latest contribution environment before runtime activation", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createPluginHostService(createOptions(root));
  context.after(() => service.manager.shutdown());
  const environment = { locale: "zh-CN", theme: "dark", reducedMotion: true, highContrast: false };

  await service.contributionService.setEnvironment(environment);

  assert.deepEqual(service.runtimeSupervisor.getInitialEnvironment(), environment);
});

test("runtime cleanup revokes leases before awaiting companion teardown", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createPluginHostService(createOptions(root));
  context.after(() => service.manager.shutdown());
  const events = [];
  let releaseCompanions;
  service.leaseStore.revokeRuntime = (runtimeId) => {
    events.push(`revoke:${runtimeId}`);
  };
  service.companionSupervisor.releaseRuntime = async (runtimeId) => {
    events.push(`release:${runtimeId}`);
    await new Promise((resolve) => {
      releaseCompanions = resolve;
    });
  };

  let settled = false;
  const cleanup = service.runtimeSupervisor.runtimeCleanup({ runtimeId: "runtime-1" })
    .finally(() => {
      settled = true;
    });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ["revoke:runtime-1", "release:runtime-1"]);
  assert.equal(settled, false);
  releaseCompanions();
  await cleanup;
  assert.equal(settled, true);
});

test("runtime trust placement precedes required and advanced permission prompts", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  const service = createPluginHostService({
    ...createOptions(root),
    resolveRuntimeKind: async () => {
      events.push("placement");
      return "utility";
    },
    requestPermissionDecision: async (request) => {
      events.push(`permission:${request.permission}`);
      return { requestId: request.requestId, decision: "allow", scope: "application" };
    },
  });
  context.after(() => service.manager.shutdown());
  const manifest = {
    manifestVersion: 1,
    id: "com.example.advanced",
    name: "advanced",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { node: "index.js" },
    permissions: { required: ["runtime.advanced", "storage"] },
  };
  assert.equal(await service.runtimeSupervisor.resolveRuntimeKind({
    plugin: { id: manifest.id, activeVersion: manifest.version, manifest },
    availableKinds: ["utility"],
    securityPrincipal: "verified:test-publisher-key",
    signal: new AbortController().signal,
  }), "utility");
  assert.deepEqual(events, [
    "placement",
    "permission:storage",
    "permission:runtime.advanced",
  ]);
});

test("first-party placement selects the utility runtime for companion manifests", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requested = [];
  const service = createPluginHostService({
    ...createOptions(root),
    requestPermissionDecision: async (request) => {
      requested.push(request.permission);
      return { requestId: request.requestId, decision: "allow", scope: "application" };
    },
  });
  context.after(() => service.manager.shutdown());
  const manifest = {
    manifestVersion: 1,
    id: "com.example.companion-placement",
    name: "companion-placement",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "browser.js", node: "node.js" },
    permissions: {
      required: [
        "runtime.advanced",
        {
          permission: "companion.execute",
          resources: ["com.example.companion-placement.helper"],
        },
      ],
    },
    companionExecutables: [{
      id: "com.example.companion-placement.helper",
      variants: [{
        path: "bin/helper",
        platforms: [`${process.platform}-${process.arch}`],
        sha256: "0".repeat(64),
      }],
    }],
  };

  assert.equal(await service.runtimeSupervisor.resolveRuntimeKind({
    plugin: { id: manifest.id, activeVersion: manifest.version, manifest },
    availableKinds: ["browser", "utility"],
    securityPrincipal: "unsigned-package:companion-placement",
    signal: new AbortController().signal,
  }), "utility");
  assert.deepEqual(requested, ["companion.execute", "runtime.advanced"]);
});

test("first-party placement selects utility for dual-entrypoint terminal interceptors", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requested = [];
  const service = createPluginHostService({
    ...createOptions(root),
    requestPermissionDecision: async (request) => {
      requested.push(request);
      return { requestId: request.requestId, decision: "allow", scope: "application" };
    },
  });
  context.after(() => service.manager.shutdown());
  const manifest = {
    manifestVersion: 1,
    id: "com.example.interceptor-placement",
    name: "interceptor-placement",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "browser.js", node: "node.js" },
    permissions: {
      required: ["runtime.advanced", "provider.terminal", "terminal.intercept.input"],
    },
    contributes: {
      providers: [{
        id: "com.example.interceptor-placement.input",
        label: "Input filter",
        kind: "terminal.interceptor.input",
      }],
    },
  };
  assert.equal(await service.runtimeSupervisor.resolveRuntimeKind({
    plugin: { id: manifest.id, activeVersion: manifest.version, manifest },
    availableKinds: ["browser", "utility"],
    securityPrincipal: "unsigned-package:interceptor-placement",
    signal: new AbortController().signal,
  }), "utility");
  assert.deepEqual(requested.map((request) => request.permission), [
    "provider.terminal",
    "terminal.intercept.input",
    "runtime.advanced",
  ]);
  assert.match(
    requested.find((request) => request.permission === "terminal.intercept.input")?.reason ?? "",
    /arbitrary no-echo input may not be detectable/u,
  );
});

test("secure host methods fail closed without an approver while public logging remains available", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createPluginHostService(createOptions(root));
  context.after(() => service.manager.shutdown());
  const routes = service.rpcRegistry.createRoutes({
    pluginId: "com.example.service",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: {
      id: "com.example.service",
      name: "service",
      publisher: "example",
      permissions: { required: ["storage"] },
    },
  });
  await assert.rejects(
    routes.requestHandlers["storage.set"]({ key: "answer", value: 42 }, transportContext()),
    /not granted/,
  );
  await routes.notificationHandlers["log.write"]({ level: "info", message: "hello" }, transportContext());
  assert.equal(service.database.getValue("com.example.service", "answer"), undefined);
});

test("approved host capabilities reuse application grants through the registry", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let prompts = 0;
  const service = createPluginHostService({
    ...createOptions(root),
    requestPermissionDecision: async (request) => {
      prompts += 1;
      return { requestId: request.requestId, decision: "allow", scope: "application" };
    },
  });
  context.after(() => service.manager.shutdown());
  const pluginManifest = {
    manifestVersion: 1,
    id: "com.example.service",
    name: "service",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "index.js" },
    permissions: { required: ["storage"] },
  };
  service.database.installVersion({
    pluginId: pluginManifest.id,
    version: pluginManifest.version,
    manifest: pluginManifest,
    archiveSha256: "a".repeat(64),
    packageRelativePath: "com.example.service/1.0.0/package",
  });
  const routes = service.rpcRegistry.createRoutes({
    pluginId: "com.example.service",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: pluginManifest,
  });
  await routes.requestHandlers["storage.set"]({ key: "answer", value: 42 }, transportContext());
  assert.deepEqual(
    await routes.requestHandlers["storage.get"]({ key: "answer" }, transportContext()),
    { found: true, value: 42 },
  );
  assert.equal(prompts, 1);
});

test("host service wires a handle-bound directory adapter without changing the RPC seam", async (context) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-")));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directoryPath = path.join(root, "enumerate");
  await fsp.mkdir(directoryPath);
  await fsp.writeFile(path.join(directoryPath, "entry.txt"), "entry");
  const service = createPluginHostService({
    ...createOptions(root),
    requestPermissionDecision: async (request) => ({
      requestId: request.requestId,
      decision: "allow",
      scope: "once",
    }),
    openPluginDirectoryHandle: async (directoryPath) => {
      const stats = await fsp.stat(directoryPath);
      const directory = await fsp.opendir(directoryPath);
      return {
        stat: async () => stats,
        read: () => directory.read(),
        close: async () => {
          try { await directory.close(); }
          catch (error) { if (error?.code !== "ERR_DIR_CLOSED") throw error; }
        },
      };
    },
  });
  context.after(() => service.manager.shutdown());
  const pluginManifest = {
    id: "com.example.directory",
    name: "directory",
    version: "1.0.0",
    publisher: "example",
    permissions: { optional: [{ permission: "filesystem.read", resources: [directoryPath] }] },
  };
  const routes = service.rpcRegistry.createRoutes({
    pluginId: pluginManifest.id,
    pluginVersion: pluginManifest.version,
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: pluginManifest,
  });
  assert.deepEqual(
    await routes.requestHandlers["filesystem.readDirectory"](
      { path: directoryPath },
      transportContext(),
    ),
    { entries: [{ name: "entry.txt", kind: "file" }] },
  );
});

test("custom host methods without an explicit authorization classification are denied", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-host-service-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createPluginHostService(createOptions(root, (registry) => {
    registry.registerRequest("custom.unclassified", () => ({ value: true }));
  }));
  context.after(() => service.manager.shutdown());
  const routes = service.rpcRegistry.createRoutes({
    pluginId: "com.example.service",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: { permissions: { optional: ["settings.read"] } },
  });
  await assert.rejects(
    routes.requestHandlers["custom.unclassified"]({}, transportContext()),
    /no authorization policy/,
  );
});

test("normal release blocks a custom utility placement before permission prompts", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-normal-mode-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let prompts = 0;
  const service = createPluginHostService({ ...createOptions(root), env: {}, resolveRuntimeKind: () => "utility", requestPermissionDecision: () => { prompts++; } });
  context.after(() => service.database.close());
  await assert.rejects(service.runtimeSupervisor.resolveRuntimeKind({
    plugin: { id: "com.example.safe", manifest: { main: { browser: "index.js" } } },
    availableKinds: ["browser", "utility"],
    signal: new AbortController().signal,
  }), /requires developer mode/);
  assert.equal(prompts, 0);
});
