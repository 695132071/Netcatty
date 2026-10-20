"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { createNdjsonRpcClient } = require("../capabilities/rpcTransport.cjs");
const bridge = require("./mcpServerBridge.cjs");
const privacy = require("../shared/aiPrivacyService.cjs");

test("managed TCP restores prompt aliases before approval and masks results across reconnects", { timeout: 10000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-privacy-"));
  const clients = [];
  const commands = [];
  let pendingApproval;
  let receiveApproval;
  t.after(() => {
    for (const client of clients) client.close();
    bridge.setMainWindowGetter(() => null);
    bridge.cleanup();
    privacy.configure({ enabled: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  privacy.configure({ enabled: true });
  const token = privacy.redact("managed-chat", "192.0.2.13");
  bridge.init({
    sessions: new Map(),
    cliDiscoveryFilePath: path.join(dir, "discovery.json"),
    terminalWorkerManager: {
      request: async (_method, payload) => {
        commands.push(payload);
        return { ok: true, stdout: "192.0.2.13", stderr: "", exitCode: 0 };
      },
    },
  });
  bridge.setMainWindowGetter(() => ({
    isDestroyed: () => false,
    webContents: { id: 99, send(channel, payload) {
      if (channel === "netcatty:ai:mcp:approval-request") {
        pendingApproval = payload;
        receiveApproval?.(payload);
      }
    } },
  }));
  bridge.setPermissionMode("confirm");
  bridge.setCommandBlocklist([]);
  bridge.updateSessionMetadata([{ sessionId: "ssh", hostname: "smoke.example", protocol: "ssh", connected: true }], "managed-chat");
  const port = await bridge.getOrCreateHost();
  const authToken = bridge.buildMcpServerConfig(port, [], "managed-chat").env.find((entry) => entry.name === "NETCATTY_MCP_TOKEN").value;
  async function connect() {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const client = createNdjsonRpcClient({ socket });
    clients.push(client);
    await client.call("auth/verify", { token: authToken });
    return client;
  }
  const client = await connect();
  const approval = new Promise((resolve) => { receiveApproval = resolve; });
  const request = client.call("netcatty/exec", { chatSessionId: "managed-chat", sessionId: "ssh", command: `echo ${token}` });
  const approved = await approval;
  assert.equal(approved.args.command, "echo 192.0.2.13");
  bridge.resolveApprovalFromRenderer(pendingApproval.approvalId, true, "once");
  assert.equal((await request).stdout, token);
  assert.equal(commands.length, 1);
  const next = await connect();
  const context = await next.call("netcatty/getContext", { chatSessionId: "managed-chat" });
  assert.doesNotMatch(JSON.stringify(context), /smoke\.example/);
  await assert.rejects(next.call("netcatty/getContext", { chatSessionId: "other-chat" }), /cannot change/);

  const callsBeforeApproval = commands.length;
  const nextApproval = new Promise((resolve) => { receiveApproval = resolve; });
  const staleRequest = client.call("netcatty/exec", { chatSessionId: "managed-chat", sessionId: "ssh", command: `echo ${token}` });
  const rejected = assert.rejects(staleRequest, /settings changed|unavailable/);
  const staleApproval = await nextApproval;
  privacy.configure({ enabled: false });
  bridge.resolveApprovalFromRenderer(staleApproval.approvalId, true, "once");
  await rejected;
  assert.equal(commands.length, callsBeforeApproval, "policy changes during approval must prevent execution");

});

test("privacy-disabled TCP preserves legacy multi-scope and unscoped calls on one socket", { timeout: 10000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-privacy-off-"));
  let client;
  t.after(() => {
    client?.close();
    bridge.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Production waits for the saved policy, even when it is explicitly off.
  privacy.configure({ enabled: false });
  bridge.init({
    sessions: new Map([
      ["off-terminal-one", { hostname: "one.example", pty: { write() {} } }],
      ["off-terminal-two", { hostname: "two.example", pty: { write() {} } }],
    ]),
    cliDiscoveryFilePath: path.join(dir, "discovery.json"),
  });
  bridge.setPermissionMode("observer");
  bridge.updateSessionMetadata([{ sessionId: "off-terminal-one", hostname: "one.example" }], "off-chat-one");
  bridge.updateSessionMetadata([{ sessionId: "off-terminal-two", hostname: "two.example" }], "off-chat-two");
  const port = await bridge.getOrCreateHost();
  const authToken = bridge.buildMcpServerConfig(port, [], "off-chat-one").env
    .find((entry) => entry.name === "NETCATTY_MCP_TOKEN").value;
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  client = createNdjsonRpcClient({ socket });
  await client.call("auth/verify", { token: authToken });
  const one = await client.call("netcatty/getContext", { chatSessionId: "off-chat-one" });
  const two = await client.call("netcatty/getContext", { chatSessionId: "off-chat-two" });
  const unscoped = await client.call("netcatty/getContext", { scopedSessionIds: ["off-terminal-one"] });
  assert.equal(one.hosts[0].sessionId, "off-terminal-one");
  assert.equal(two.hosts[0].sessionId, "off-terminal-two");
  assert.equal(unscoped.hosts[0].sessionId, "off-terminal-one");
  assert.equal(one.hosts[0].hostname, "one.example");
  assert.equal(two.hosts[0].hostname, "two.example");
});
