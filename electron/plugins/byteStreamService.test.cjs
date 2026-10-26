"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const os = require("node:os");
const { PluginByteStreamService } = require("./byteStreamService.cjs");

test("own-machine denial normalizes both interface and destination addresses without blocking private peers", async (t) => {
  let interfaces;
  t.mock.method(os, "networkInterfaces", () => interfaces);
  const service = new PluginByteStreamService({
    permissionEngine: { authorize: async () => {}, onDidRevoke: () => ({ dispose() {} }) },
  });
  t.after(() => service.shutdown());
  const dialed = [];
  service.broker.connectSocket = ({ host }) => {
    dialed.push(host);
    throw new Error("synthetic dialer reached");
  };
  const context = { pluginId: "synthetic", runtimeId: "synthetic", assertActive: async () => {} };
  for (const ownAddress of ["10.0.0.8", "::ffff:10.0.0.8", "::ffff:a00:8"]) {
    interfaces = { synthetic: [{ address: ownAddress }] };
    for (const endpoint of ["tcp://10.0.0.8:43210", "tcp://[::ffff:10.0.0.8]:43210", "tcp://[::ffff:a00:8]:43210"]) {
      await assert.rejects(service.broker.connect(endpoint, context), /control endpoints/u);
    }
  }
  assert.deepEqual(dialed, []);
  interfaces = { synthetic: [{ address: "2001:0db8:0:0:0:0:0:8" }] };
  await assert.rejects(service.broker.connect("tcp://[2001:db8::8]:43210", context), /control endpoints/u);
  interfaces = { synthetic: [{ address: "10.0.0.8" }] };
  for (const endpoint of ["tcp://10.0.0.9:43210", "tcp://[::ffff:10.0.0.9]:43210", "tcp://192.168.1.9:43210"]) {
    await assert.rejects(service.broker.connect(endpoint, context), /synthetic dialer reached/u);
  }
  assert.deepEqual(dialed, ["10.0.0.9", "::ffff:a00:9", "192.168.1.9"]);
  assert.equal(service.broker.connections.size, 0);
});
