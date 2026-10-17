"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const bridge = require("./sshBridge.cjs");
const pool = require("./sshConnectionPool.cjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function register(terminalWorkerManager) {
  const handlers = new Map();
  bridge.init({ sessions: new Map(), electronModule: {} });
  bridge.registerHandlers(
    { handle: (channel, handler) => handlers.set(channel, handler), on() {} },
    { terminalWorkerManager },
  );
  return handlers;
}
function event(id) {
  const sender = new EventEmitter();
  sender.id = id;
  return { sender };
}
test.afterEach(() => {
  bridge.stopAllMonitoring();
  pool.resetSshTransportRegistryForTests();
});
test("direct IPC owner teardown releases only closed windows' monitoring demand and leases", async () => {
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  const handlers = register();
  const a = event(1),
    b = event(2);
  const options = {
    hostname: "owner-fixture",
    username: "fixture",
    password: "fixture-only",
    useSshAgent: false,
    agentForwarding: false,
    verifyHostKeys: false,
  };
  const conn = new EventEmitter();
  conn._sock = { destroyed: false };
  conn.end = () => {};
  conn.exec = (_command, callback) =>
    callback(new Error("fixture has no stats"));
  const transport = pool.createTransport({
    conn,
    endpoint: pool.buildConnectionReuseEndpoint(options),
  });
  const terminal = {};
  pool.borrowTransport(transport, {
    kind: pool.LEASE_KINDS.shell,
    holder: terminal,
  });
  const demand = [{ id: "p", hosts: [{ id: "h", options }] }];
  await handlers.get("netcatty:monitor:update")(a, demand);
  await handlers.get("netcatty:monitor:update")(b, demand);
  await tick();
  await tick();
  assert.equal(transport.count, 2);
  handlers.get("netcatty:monitor:snapshot")(a);
  assert.equal(a.sender.listenerCount("destroyed"), 1);
  a.sender.emit("destroyed");
  let snapshot = handlers.get("netcatty:monitor:snapshot")(b);
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.hostCount, 1);
  assert.equal(transport.count, 2);
  b.sender.emit("destroyed");
  snapshot = handlers.get("netcatty:monitor:snapshot")(b);
  assert.equal(snapshot.count, 0);
  assert.equal(snapshot.hostCount, 0);
  assert.equal(transport.count, 1, "existing terminal keeps its own lease");
  pool.returnTransport(terminal);
});
test("worker IPC installs one owner teardown across all monitor handlers", async () => {
  const requests = [];
  const handlers = register({
    request: async (...args) => {
      requests.push(args);
      return {};
    },
  });
  const a = event(42);
  await handlers.get("netcatty:monitor:update")(a, []);
  await handlers.get("netcatty:monitor:snapshot")(a);
  await handlers.get("netcatty:monitor:retry")(a, "h");
  assert.equal(a.sender.listenerCount("destroyed"), 1);
  a.sender.emit("destroyed");
  assert.deepEqual(requests.at(-1), [
    "netcatty:monitor:owner-close",
    42,
    { webContentsId: 42 },
  ]);
});


test("worker receiving handlers accept the actual IPC sender without WebContents lifecycle methods", async () => {
  const { createWorkerSender } = require("../terminalWorker/process.cjs");
  const handlers = register();
  const e = { sender: createWorkerSender({ postMessage() {} }, 73) };
  assert.equal(e.sender.once, undefined);
  await handlers.get("netcatty:monitor:update")(e, [{ id: "p", hosts: [] }]);
  assert.equal(handlers.get("netcatty:monitor:snapshot")(e).count, 1);
  handlers.get("netcatty:monitor:retry")(e, "missing");
  handlers.get("netcatty:monitor:owner-close")(e, 73);
  assert.equal(handlers.get("netcatty:monitor:snapshot")(e).count, 0);
  handlers.get("netcatty:monitor:stop-all")(e);
});
