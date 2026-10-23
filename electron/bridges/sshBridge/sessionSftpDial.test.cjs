"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { attachSessionSftpDial } = require("./sessionSftpDial.cjs");

test("dedicated session SFTP preserves the authenticated route and isolates its transport", async () => {
  const session = { sftpFileProtocol: "sftp" };
  const sessions = new Map([["terminal", session]]);
  const sender = { isDestroyed: () => false };
  const options = {
    hostname: "gateway.example", username: "user/target/root", password: "ephemeral",
    proxy: { host: "proxy.example" }, jumpHosts: [{ hostname: "jump.example" }],
    verifyHostKeys: true, knownHosts: [{ hostname: "gateway.example" }],
    sessionId: "terminal", _connRef: { neverReuse: true },
  };
  const calls = [];
  attachSessionSftpDial(session, options, {
    sessions, sessionId: "terminal", sender, acceptedHostKeys: options.knownHosts,
    openSftp: async (event, dial) => { calls.push({ event, dial }); return { sftpId: dial.sessionId }; },
  });
  const controller = new AbortController();
  const first = await session._openDedicatedSftp({ abortSignal: controller.signal, hostname: "untrusted.example" });
  const second = await session._openDedicatedSftp({});
  const { dial, event } = calls[0];
  assert.equal(dial.hostname, options.hostname);
  assert.equal(dial.password, options.password);
  assert.deepEqual(dial.proxy, options.proxy);
  assert.deepEqual(dial.jumpHosts, options.jumpHosts);
  assert.deepEqual(dial.knownHosts, options.knownHosts);
  assert.equal(dial.verifyHostKeys, true);
  assert.equal(dial.hostKeyUnattended, true);
  assert.equal(dial.reuseTransport, false);
  assert.equal(dial.singleChannelSsh, true);
  assert.equal(dial.fileProtocol, "sftp");
  assert.equal(dial.sourceSessionId, "terminal");
  assert.equal(dial.abortSignal.aborted, false);
  assert.equal(dial._connRef, undefined);
  assert.notEqual(first.sftpId, "terminal");
  assert.notEqual(first.sftpId, second.sftpId);
  assert.equal(event.sender, sender);
  assert.equal(options.reuseTransport, undefined);
  assert.equal(JSON.stringify(session).includes("ephemeral"), false);
  assert.equal(Object.keys(session).includes("_openDedicatedSftp"), false);
});

test("closing the terminal aborts a pending dedicated authentication", async () => {
  const { EventEmitter } = require("node:events");
  const session = { stream: new EventEmitter(), conn: new EventEmitter() };
  const sessions = new Map([["terminal", session]]);
  attachSessionSftpDial(session, {}, {
    sessions, sessionId: "terminal", sender: { isDestroyed: () => false },
    openSftp: async (_event, dial) => new Promise((_resolve, reject) => {
      dial.abortSignal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }),
  });
  const opening = session._openDedicatedSftp({});
  session.stream.emit("close");
  await assert.rejects(opening, { name: "AbortError" });
  assert.equal(session.stream.listenerCount("close"), 0);
  assert.equal(session.conn.listenerCount("close"), 0);
});

test("dedicated SFTP cannot redial a closed or replaced terminal", async () => {
  const session = {};
  const sessions = new Map([["terminal", session]]);
  let dials = 0;
  attachSessionSftpDial(session, {}, {
    sessions, sessionId: "terminal", sender: { isDestroyed: () => false },
    openSftp: async () => { dials++; },
  });
  sessions.set("terminal", {});
  await assert.rejects(session._openDedicatedSftp({}), /no longer active/i);
  assert.equal(dials, 0);
});

test("dedicated SFTP rejects an already cancelled open and a destroyed owner", async () => {
  const session = {};
  const sessions = new Map([["terminal", session]]);
  let destroyed = false;
  attachSessionSftpDial(session, {}, {
    sessions, sessionId: "terminal", sender: { isDestroyed: () => destroyed },
    openSftp: async () => { throw new Error("must not dial"); },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(session._openDedicatedSftp({ abortSignal: controller.signal }), { name: "AbortError" });
  destroyed = true;
  await assert.rejects(session._openDedicatedSftp({}), /no longer active/i);
});

test("a dedicated connection completing after cancellation is closed without touching the terminal", async () => {
  const session = {};
  const sessions = new Map([["terminal", session]]);
  const controller = new AbortController();
  const closed = [];
  attachSessionSftpDial(session, {}, {
    sessions, sessionId: "terminal", sender: { isDestroyed: () => false },
    openSftp: async () => { controller.abort(); return { sftpId: "late" }; },
    closeSftp: async (_event, payload) => { closed.push(payload.sftpId); },
  });
  await assert.rejects(session._openDedicatedSftp({ abortSignal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(closed, ["late"]);
});

test("dedicated trust is scoped to accepted host and port, with no stale fallback", async () => {
  const verifier = require("../hostKeyVerifier.cjs");
  const raw = Buffer.from("accepted-route-key");
  const info = verifier.describeHostKey(raw);
  for (const accepted of [[], [{ hostname: "other.example", port: 22, ...info }], [{ hostname: "target.example", port: 2222, ...info }]]) {
    const session = {};
    const sender = { isDestroyed: () => false, send() { throw new Error("no orphan host-key prompt"); } };
    attachSessionSftpDial(session, {
      hostname: "target.example", port: 22, verifyHostKeys: true,
      knownHosts: [{ hostname: "target.example", port: 22, ...info }],
      _acceptedHostKeys: [{ hostname: "target.example", port: 22, ...info }],
    }, {
      sessions: new Map([["terminal", session]]), sessionId: "terminal", sender,
      acceptedHostKeys: accepted,
      openSftp: async (_event, dial) => {
        assert.equal(dial.verifyHostKeys, true);
        const accepted = await new Promise(resolve => verifier.createHostVerifier({
          ...dial, sender, unattended: dial.hostKeyUnattended,
        })(raw, resolve));
        assert.equal(accepted, false);
        throw Object.assign(new Error("Host key rejected"), { code: "ERR_HOST_KEY_UNVERIFIED" });
      },
    });
    await assert.rejects(session._openDedicatedSftp(), { code: "ERR_HOST_KEY_UNVERIFIED" });
  }
});

test("jump-host verification rejection fails closed with a reconnect instruction", async () => {
  const session = {};
  attachSessionSftpDial(session, { verifyHostKeys: true }, {
    sessions: new Map([["terminal", session]]), sessionId: "terminal", sender: { isDestroyed: () => false },
    openSftp: async () => { throw new Error("Host denied (verification failed)"); },
  });
  await assert.rejects(session._openDedicatedSftp(), { code: "ERR_HOST_KEY_UNVERIFIED", message: /Reconnect the terminal/ });
});

test("dedicated route matching keeps credential and route boundaries plus constrained OTP alias", () => {
  const saved = { hostId: "vault", hostname: "gateway.example", username: "root", authMethod: "password", password: "", jumpHosts: [{ hostname: "jump.example", password: "jump" }] };
  const options = { ...saved, password: "captured-otp", sftpReuseOptions: saved };
  const session = {};
  attachSessionSftpDial(session, options, { sessions: new Map(), sessionId: "terminal" });
  assert.equal(session._matchesDedicatedSftpEndpoint(saved), true);
  assert.equal(session._matchesDedicatedSftpEndpoint(options), true);
  for (const mismatch of [
    { password: "changed" }, { hostname: "other.example" }, { hostId: "other" },
    { verifyHostKeys: false }, { proxy: { type: "http", host: "proxy.example", port: 8080 } },
    { jumpHosts: [{ ...saved.jumpHosts[0], password: "changed" }] }, { agentForwarding: true },
  ]) assert.equal(session._matchesDedicatedSftpEndpoint({ ...saved, ...mismatch }), false);
  const unsafeAlias = {};
  attachSessionSftpDial(unsafeAlias, { ...options, sftpReuseOptions: { ...saved, hostname: "other.example" } }, { sessions: new Map(), sessionId: "terminal" });
  assert.equal(unsafeAlias._matchesDedicatedSftpEndpoint({ ...saved, hostname: "other.example" }), false);
});
