"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const bridge = require("./sftpBridge.cjs");

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
