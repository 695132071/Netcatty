"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { PluginByteStreamService } = require("./byteStreamService.cjs");
const { PluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");

async function fixture(t, options = {}) {
  let peer;
  const sockets = new Set();
  const server = net.createServer((socket) => { peer = socket; sockets.add(socket); socket.on("error", () => {}); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let service;
  t.after(async () => {
    service?.shutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  let source = "first";
  const endpoint = `tcp://127.0.0.1:${server.address().port}`;
  const identity = { pluginId: "com.netcatty.stream-source-test", pluginVersion: "0.1.0", runtimeId: "runtime-one",
    runtimeKind: "browser", sourceOwner: "opaque-first", sourceId: "first", securityPrincipal: "host-principal",
    manifest: { features: { required: ["network.byte-streams"] } },
  };
  const audit = [];
  const writes = [];
  const registry = new PluginHostRpcRegistry();
  service = new PluginByteStreamService({
    database: {
      getActivePlugin: () => ({ enabled: true, source: { id: source } }),
      getRetainedPluginSource: () => ({ id: source }),
      privateOwner: () => `opaque-${source}`,
      publicPluginId: (owner) => owner === `opaque-${source}` ? identity.pluginId : null,
      recordSecurityAudit: (...args) => audit.push(args),
    },
    permissionEngine: { onDidRevoke: () => ({ dispose() {} }), authorize: options.authorize ?? (async () => {}) },
    runtimeSupervisor: { getRuntimeIdentity: () => identity, openStream: options.openStream ?? (async () => ({
      write: async (bytes) => writes.push(bytes), end() {}, cancel() {},
    })) },
  });
  service.broker.testLocalEndpoints.add(endpoint);
  service.broker.isControlEndpoint = () => false;
  service.register(registry);
  const routes = registry.createRoutes({ ...identity, assertCurrent() {} });
  const call = (method, params) => routes.requestHandlers[method](params, { signal: new AbortController().signal });
  return { service, call, endpoint, audit, writes, swap: () => { source = "second"; }, peer: () => peer };
}

test("source changes before grant publication cannot create a socket or grant", async (t) => {
  let approve;
  let grants = 0;
  const f = await fixture(t, { authorize: async (_context, descriptor) => {
    await new Promise((resolve) => { approve = resolve; });
    descriptor.validateBeforeGrant();
    grants++;
  } });
  const pending = f.call("network.stream.connect", { endpoint: f.endpoint });
  while (!approve) await new Promise((resolve) => setImmediate(resolve));
  f.swap(); approve();
  await assert.rejects(pending, /source binding/u);
  assert.equal(grants, 0);
  assert.equal(f.peer(), undefined);
  assert.equal(f.service.broker.connections.size, 0);
  assert.equal(f.audit.length, 0);
});

test("source changes during a real pending read discard bytes and skip the new source audit", async (t) => {
  const f = await fixture(t);
  const descriptor = await f.call("network.stream.connect", { endpoint: f.endpoint });
  await f.call("network.stream.attach", { handleId: descriptor.handleId });
  f.swap();
  f.peer().write("synthetic old-source bytes");
  for (let attempt = 0; attempt < 100 && f.service.records.size; attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.writes.length, 0);
  assert.equal(f.service.records.size, 0);
  assert.equal(f.service.broker.connections.size, 0);
  assert.deepEqual(f.audit.map((entry) => entry[1]), ["network.stream.open"]);
  await assert.rejects(f.call("network.stream.close", { handleId: descriptor.handleId }), /source binding/u);
});

test("a stream opened after runtime release is cancelled before attach can succeed", async (t) => {
  let opened;
  let cancelled = 0;
  const f = await fixture(t, { openStream: () => new Promise((resolve) => { opened = resolve; }) });
  const descriptor = await f.call("network.stream.connect", { endpoint: f.endpoint });
  const attaching = f.call("network.stream.attach", { handleId: descriptor.handleId });
  while (!opened) await new Promise((resolve) => setImmediate(resolve));
  f.service.releaseRuntime("runtime-one");
  opened({ cancel() { cancelled++; }, write: async () => {}, end() {} });
  await assert.rejects(attaching, /cancelled/u);
  assert.equal(cancelled, 1);
  assert.equal(f.service.records.size, 0);
  assert.equal(f.service.broker.connections.size, 0);
});
