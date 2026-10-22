const test = require("node:test");
const assert = require("node:assert/strict");

const terminalBridge = require("./terminalBridge.cjs");
const {
  createConnectionRef,
  acquireConnectionRef,
  discardTransport,
  resetSshTransportRegistryForTests,
} = require("./sshConnectionPool.cjs");

// Verifies the terminalBridge close path respects connection multiplexing
// (issue #1204): closing one tab that shares an SSH connection must only close
// that tab's channel. Once the last tab is gone, the transport is parked briefly
// so a later same-host open can reuse it without another authentication round.

test.beforeEach(() => {
  resetSshTransportRegistryForTests();
});

test.afterEach(() => {
  resetSshTransportRegistryForTests();
});

function makeStream() {
  return {
    closed: 0,
    close() { this.closed += 1; },
  };
}

function makeConn() {
  return {
    ended: 0,
    end() { this.ended += 1; },
  };
}

function makeSession(conn, connRef) {
  return {
    stream: makeStream(),
    conn,
    chainConnections: [],
    connRef,
    zmodemSentry: { cancel() {} },
  };
}

test("closing a reused SSH tab keeps the shared connection alive", () => {
  const sessions = new Map();
  terminalBridge.init({ sessions, electronModule: {} });

  const conn = makeConn();
  const owner = makeSession(conn, null);
  const connRef = createConnectionRef(owner, conn, []);
  const copy = makeSession(conn, null);
  acquireConnectionRef(copy, connRef);

  sessions.set("owner", owner);
  sessions.set("copy", copy);
  assert.equal(connRef.count, 2);

  // Close the copy tab.
  terminalBridge.closeSession({ sender: {} }, { sessionId: "copy" });

  assert.equal(copy.stream.closed, 1, "copy channel closed");
  assert.equal(conn.ended, 0, "shared connection must stay up for the owner");
  assert.equal(connRef.count, 1);
  assert.equal(sessions.has("copy"), false);

  // Close the owner tab — now the last holder, so the connection is parked.
  terminalBridge.closeSession({ sender: {} }, { sessionId: "owner" });
  assert.equal(owner.stream.closed, 1, "owner channel closed");
  assert.equal(conn.ended, 0, "connection remains parked for same-host reuse");
  assert.equal(connRef.count, 0);
  assert.equal(connRef.state, "idle");
  assert.equal(discardTransport(connRef), true);
  assert.equal(conn.ended, 1, "parked connection is still reclaimable");
});

test("closing the owner tab first does not strand the copy's connection", () => {
  const sessions = new Map();
  terminalBridge.init({ sessions, electronModule: {} });

  const conn = makeConn();
  const owner = makeSession(conn, null);
  const connRef = createConnectionRef(owner, conn, []);
  const copy = makeSession(conn, null);
  acquireConnectionRef(copy, connRef);

  sessions.set("owner", owner);
  sessions.set("copy", copy);

  // Close the owner first.
  terminalBridge.closeSession({ sender: {} }, { sessionId: "owner" });
  assert.equal(conn.ended, 0, "connection survives for the still-open copy");
  assert.equal(connRef.count, 1);

  // Closing the copy (now last) parks the connection for reuse.
  terminalBridge.closeSession({ sender: {} }, { sessionId: "copy" });
  assert.equal(conn.ended, 0);
  assert.equal(connRef.state, "idle");
  assert.equal(discardTransport(connRef), true);
  assert.equal(conn.ended, 1);
});

test("legacy SSH session without connRef still ends its own connection + chain", () => {
  const sessions = new Map();
  terminalBridge.init({ sessions, electronModule: {} });

  const conn = makeConn();
  const chain = [makeConn(), makeConn()];
  const session = {
    stream: makeStream(),
    conn,
    chainConnections: chain,
    connRef: null,
    zmodemSentry: { cancel() {} },
  };
  sessions.set("legacy", session);

  terminalBridge.closeSession({ sender: {} }, { sessionId: "legacy" });
  assert.equal(session.stream.closed, 1);
  assert.equal(conn.ended, 1, "non-multiplexed connection ends directly");
  assert.equal(chain[0].ended, 1);
  assert.equal(chain[1].ended, 1);
});

test("destroying a copied child window closes only its shells on the shared SSH transport", () => {
  const EventEmitter = require("node:events");
  const { trackRendererSessionLifetime } = require("./rendererSessionLifetime.cjs");
  const sessions = new Map();
  terminalBridge.init({ sessions, electronModule: {} });

  const conn = makeConn();
  const mainA = makeSession(conn, null);
  const transport = createConnectionRef(mainA, conn, []);
  const mainB = makeSession(conn, null);
  const childA = makeSession(conn, null);
  const childB = makeSession(conn, null);
  acquireConnectionRef(mainB, transport);
  acquireConnectionRef(childA, transport);
  acquireConnectionRef(childB, transport);
  for (const [id, session] of [
    ["main-a", mainA],
    ["main-b", mainB],
    ["child-a", childA],
    ["child-b", childB],
  ]) {
    session.bootEpoch = 1;
    sessions.set(id, session);
  }
  assert.equal(transport.count, 4);
  assert.equal(transport.state, "live");

  const windowFor = (id) => {
    const contents = new EventEmitter();
    contents.id = id;
    contents.isDestroyed = () => false;
    return contents;
  };
  const mainWindow = windowFor(1);
  const childWindow = windowFor(2);
  trackRendererSessionLifetime(sessions, "main-a", mainWindow, terminalBridge.closeSession);
  trackRendererSessionLifetime(sessions, "main-b", mainWindow, terminalBridge.closeSession);
  trackRendererSessionLifetime(sessions, "child-a", childWindow, terminalBridge.closeSession);
  trackRendererSessionLifetime(sessions, "child-b", childWindow, terminalBridge.closeSession);

  childWindow.emit("destroyed");

  assert.equal(childA.stream.closed, 1);
  assert.equal(childB.stream.closed, 1);
  assert.equal(mainA.stream.closed, 0);
  assert.equal(mainB.stream.closed, 0);
  assert.equal(conn.ended, 0, "shared SSH connection stays up for the main window");
  assert.equal(transport.count, 2, "only the child window's shell leases are released");
  assert.equal(transport.state, "live");
  assert.equal(sessions.has("child-a"), false);
  assert.equal(sessions.has("child-b"), false);
  assert.equal(sessions.has("main-a"), true);
  assert.equal(sessions.has("main-b"), true);

  childWindow.emit("destroyed");
  assert.equal(transport.count, 2, "a repeated child-window destroy must not drop the main window's leases");
  assert.equal(conn.ended, 0);

  mainWindow.emit("destroyed");
  assert.equal(mainA.stream.closed, 1);
  assert.equal(mainB.stream.closed, 1);
  assert.equal(transport.count, 0);
  assert.equal(transport.state, "idle", "the last shells park the transport");
  assert.equal(conn.ended, 0, "parking does not end the shared connection");
});

test("renderer destruction closes its SSH shell through normal close while other shell and SFTP leases survive", () => {
  const EventEmitter = require("node:events");
  const { trackRendererSessionLifetime } = require("./rendererSessionLifetime.cjs");
  const { borrowTransport, returnTransport } = require("./sshConnectionPool.cjs");
  const sessions = new Map();
  terminalBridge.init({ sessions, electronModule: {} });
  const conn = makeConn();
  const owner = makeSession(conn, null);
  const transport = createConnectionRef(owner, conn, []);
  const copy = makeSession(conn, null);
  acquireConnectionRef(copy, transport);
  const sftpHolder = {};
  borrowTransport(transport, { kind: "sftp", holder: sftpHolder });
  sessions.set("owner", owner);
  sessions.set("copy", copy);
  const contents = new EventEmitter();
  contents.id = 7;
  trackRendererSessionLifetime(sessions, "copy", contents, terminalBridge.closeSession);
  contents.emit("destroyed");
  assert.equal(copy.stream.closed, 1);
  assert.equal(owner.stream.closed, 0);
  assert.equal(conn.ended, 0);
  assert.equal(transport.count, 2);
  assert.equal(sessions.has("copy"), false);
  assert.equal(sessions.has("owner"), true);
  terminalBridge.closeSession({}, { sessionId: "owner" });
  assert.equal(transport.count, 1, "SFTP lease survives the last shell closing");
  assert.equal(conn.ended, 0);
  returnTransport(sftpHolder);
  assert.equal(transport.state, "idle");
});
