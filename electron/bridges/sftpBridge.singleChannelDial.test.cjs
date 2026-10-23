"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const bridge = require("./sftpBridge.cjs");
const { buildConnectionReuseEndpoint, normalizeEndpoint } = require("./sshConnectionPool.cjs");

test("GUI vault reconnect finds the dedicated terminal dial without a source-session hint", async (t) => {
  t.mock.method(require("node:net").Socket.prototype, "connect", () => {
    throw new Error("Unexpected fresh vault dial instead of the terminal profile");
  });
  const options = {
    hostId: "vault-gateway", hostname: "gateway.example", username: "gateway/target/root",
    password: "test-only-password", authMethod: "password", port: 22, fileProtocol: "sftp",
  };
  let opened = 0;
  const clients = new Map([["gui-dedicated", {}]]);
  bridge.init({ sessions: new Map([["live-terminal", {
    singleChannelSsh: true, remoteSshVersion: "TERM-SSHD",
    _reuseEndpoint: normalizeEndpoint({ ...buildConnectionReuseEndpoint(options), singleChannelSsh: true }),
    _sftpReuseEndpoint: null,
    conn: { sftp() { throw new Error("terminal channel must not be borrowed"); } },
    async _openDedicatedSftp(payload) {
      opened++;
      assert.equal(payload.sessionId, "live-terminal");
      return { sftpId: "gui-dedicated", sourceSessionId: "live-terminal", fileProtocol: "sftp" };
    },
  }]]), sftpClients: clients, electronModule: {} });
  assert.equal((await bridge.openSftp({ sender: { isDestroyed: () => false } }, options)).sftpId, "gui-dedicated");
  assert.equal(opened, 1);
});

for (const mismatch of [null, "hostId", "hostname", "username", "password", "jumpHosts", "proxy", "agentForwarding"]) {
  test(`single-channel endpoint validation selects a dedicated dial only for matching identity (${mismatch})`, async () => {
    const options = {
      hostId: "gateway-target", hostname: "gateway.example", username: "gateway/target/root",
      password: "test-only-password", authMethod: "password", port: 22,
      jumpHosts: [{ hostname: "jump.example", username: "jump-user", password: "jump-test" }],
    };
    const requested = { ...options };
    if (mismatch === "hostId") requested.hostId = "other-profile";
    if (mismatch === "hostname") requested.hostname = "other.example";
    if (mismatch === "username") requested.username = "another-user";
    if (mismatch === "password") requested.password = "different-test-password";
    if (mismatch === "jumpHosts") requested.jumpHosts = [{ ...options.jumpHosts[0], hostname: "other-jump.example" }];
    if (mismatch === "proxy") requested.proxy = { type: "http", host: "proxy.example", port: 8080 };
    if (mismatch === "agentForwarding") requested.agentForwarding = true;
    let dedicatedDials = 0;
    const clients = new Map([["dedicated", {}]]);
    bridge.init({ sessions: new Map([["terminal", {
      singleChannelSsh: true, remoteSshVersion: "TERM-SSHD",
      _reuseEndpoint: normalizeEndpoint({ ...buildConnectionReuseEndpoint(options), singleChannelSsh: true }),
      conn: { sftp() { throw new Error("must not borrow a terminal channel"); } },
      async _openDedicatedSftp() { dedicatedDials++; return { sftpId: "dedicated", sourceSessionId: "terminal" }; },
    }]]), sftpClients: clients, electronModule: {} });
    const result = bridge.openSftpForSession(null, {
      sessionId: "terminal", expectedEndpoint: requested, requireExactSourceSession: true,
    });
    if (mismatch) {
      await assert.rejects(result, { code: "ERR_SFTP_SOURCE_ROUTE_MISMATCH" });
      assert.equal(dedicatedDials, 0);
    } else {
      assert.equal((await result).sftpId, "dedicated");
      assert.equal(dedicatedDials, 1);
    }
  });
}

for (const flag of [true, false]) {
  test(`single-channel session opens a dedicated SFTP connection (runtime flag=${flag})`, async () => {
    let terminalChannels = 0;
    const clients = new Map([["dedicated", {}]]);
    const controller = new AbortController();
    const payload = { sessionId: "terminal", abortSignal: controller.signal, fileProtocol: "sftp" };
    const session = {
      singleChannelSsh: flag, remoteSshVersion: "TERM-SSHD",
      conn: { sftp() { terminalChannels++; throw new Error("terminal must remain untouched"); } },
      async _openDedicatedSftp(received) {
        assert.equal(received, payload);
        return { sftpId: "dedicated", sourceSessionId: "terminal", fileProtocol: "sftp" };
      },
    };
    bridge.init({ sessions: new Map([["terminal", session]]), sftpClients: clients, electronModule: {} });
    assert.deepEqual(await bridge.openSftpForSession(null, payload), {
      sftpId: "dedicated", sourceSessionId: "terminal", fileProtocol: "sftp",
    });
    assert.equal(terminalChannels, 0);
    assert.equal(clients.get("dedicated").__netcattySourceSessionId, "terminal");
  });
}

test("legacy single-channel sessions retain the protection when no dial profile exists", async () => {
  bridge.init({ sessions: new Map([["terminal", {
    singleChannelSsh: true, conn: { sftp() { throw new Error("must not open"); } },
  }]]), sftpClients: new Map(), electronModule: {} });
  await assert.rejects(bridge.openSftpForSession(null, { sessionId: "terminal" }), {
    code: "ERR_SFTP_SINGLE_CHANNEL_BASTION",
  });
});
