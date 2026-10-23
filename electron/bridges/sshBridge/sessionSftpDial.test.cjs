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
    sessions, sessionId: "terminal", sender,
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
