"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Duplex } = require("node:stream");

const {
  buildAuthHandler,
  getAvailableAgentSocket,
  getAvailableForwardingAgentSocket,
  getNativeOpenSshAgentSocket,
  cygwinAgentConnectable,
  isWindowsNamedPipe,
  socketAgentConnectable,
  socketAgentIdentityCount,
  ssh2AgentConnectable,
  resolveIdentityAgentPath,
} = require("./sshAuthHelper.cjs");

test("macOS forwarding prefers a Bitwarden agent with identities over an empty inherited agent", async () => {
  const inheritedSocket = "/private/tmp/com.apple.launchd.test/Listeners";
  const bitwardenSocket = "/Users/alice/.bitwarden-ssh-agent.sock";
  const checked = [];

  const result = await getAvailableForwardingAgentSocket(undefined, {
    platform: "darwin",
    localEnv: { SSH_AUTH_SOCK: inheritedSocket },
    homedir: "/Users/alice",
    getAvailableAgentSocketImpl: async (candidate) => {
      checked.push(candidate);
      return candidate;
    },
    socketAgentIdentityCount: async (candidate) => (
      candidate === bitwardenSocket ? 1 : 0
    ),
  });

  assert.equal(result, bitwardenSocket);
  assert.deepEqual(checked, [inheritedSocket, bitwardenSocket]);
});

test("forwarding keeps an explicitly configured agent authoritative", async () => {
  let identityChecks = 0;
  const result = await getAvailableForwardingAgentSocket("/tmp/selected-agent.sock", {
    platform: "darwin",
    getAvailableAgentSocketImpl: async (candidate) => candidate,
    socketAgentIdentityCount: async () => {
      identityChecks += 1;
      return 0;
    },
  });

  assert.equal(result, "/tmp/selected-agent.sock");
  assert.equal(identityChecks, 0);
});

test("IdentityAgent none disables login but still allows forwarding discovery", async () => {
  const inheritedSocket = "/private/tmp/com.apple.launchd.test/Listeners";
  const bitwardenSocket = "/Users/alice/.bitwarden-ssh-agent.sock";
  const result = await getAvailableForwardingAgentSocket("none", {
    platform: "darwin",
    localEnv: { SSH_AUTH_SOCK: inheritedSocket },
    homedir: "/Users/alice",
    getAvailableAgentSocketImpl: async (candidate) => candidate,
    socketAgentIdentityCount: async (candidate) => candidate === bitwardenSocket ? 1 : 0,
  });

  assert.equal(result, bitwardenSocket);
});

test("macOS forwarding preserves the inherited agent when discovered providers are empty", async () => {
  const inheritedSocket = "/private/tmp/com.apple.launchd.test/Listeners";
  const result = await getAvailableForwardingAgentSocket(undefined, {
    platform: "darwin",
    localEnv: { SSH_AUTH_SOCK: inheritedSocket },
    homedir: "/Users/alice",
    getAvailableAgentSocketImpl: async (candidate) => candidate,
    socketAgentIdentityCount: async () => 0,
  });

  assert.equal(result, inheritedSocket);
});

test("forwarding ignores a remote terminal env when reading the local agent", async () => {
  const inheritedSocket = "/private/tmp/com.apple.launchd.test/Listeners";
  const checked = [];
  await getAvailableForwardingAgentSocket(undefined, {
    platform: "darwin",
    env: { TERM: "xterm-256color" },
    localEnv: { SSH_AUTH_SOCK: inheritedSocket },
    homedir: "/Users/alice",
    getAvailableAgentSocketImpl: async (candidate) => {
      checked.push(candidate);
      return null;
    },
    socketAgentIdentityCount: async () => 0,
  });

  assert.equal(checked[0], inheritedSocket);
});

test("forwarding does not report an empty auto-discovered provider as available", async () => {
  const result = await getAvailableForwardingAgentSocket(undefined, {
    platform: "darwin",
    localEnv: {},
    homedir: "/Users/alice",
    getAvailableAgentSocketImpl: async (candidate) => candidate,
    socketAgentIdentityCount: async () => 0,
  });

  assert.equal(result, null);
});

test("non-macOS forwarding keeps the existing agent resolution path", async () => {
  const calls = [];
  const result = await getAvailableForwardingAgentSocket(undefined, {
    platform: "linux",
    getAvailableAgentSocketImpl: async (candidate) => {
      calls.push(candidate);
      return "/tmp/agent.sock";
    },
    socketAgentIdentityCount: async () => {
      throw new Error("must not inspect identities outside macOS discovery");
    },
  });

  assert.equal(result, "/tmp/agent.sock");
  assert.deepEqual(calls, [undefined]);
});

test("explicit agent opt-out suppresses automatic socket fallback", () => {
  const auth = buildAuthHandler({
    username: "deploy",
    allowAgentFallback: false,
    sshAgentSocketOverride: "/tmp/agent.sock",
  });

  assert.equal(auth.agent, null);
});

test("IdentityAgent paths expand standard OpenSSH connection tokens", () => {
  const resolved = resolveIdentityAgentPath(
    "%d/.ssh/agent-%h-%p-%r-%u-%l-%L-%i-%%-%C.sock",
    {
      hostname: "server.example.com",
      port: 2222,
      username: "deploy",
      localHostname: "mac.example.net",
      localUsername: "alice",
      uid: 501,
    },
  );

  assert.match(
    resolved,
    new RegExp(`^${os.homedir().replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}/\\.ssh/agent-server\\.example\\.com-2222-deploy-alice-mac\\.example\\.net-mac-501-%-[a-f0-9]{40}\\.sock$`),
  );
});

test("Windows named pipe detection accepts both slash styles", () => {
  assert.equal(isWindowsNamedPipe("\\\\.\\pipe\\openssh-ssh-agent"), true);
  assert.equal(isWindowsNamedPipe("//./pipe/openssh-ssh-agent"), true);
  assert.equal(isWindowsNamedPipe("pageant"), false);
  assert.equal(isWindowsNamedPipe("C:\\cygwin\\agent.socket"), false);
});

test("Windows Pageant and Cygwin overrides use ssh2 agent validation", async () => {
  const checked = [];
  const injected = {
    platform: "win32",
    windowsPipeConnectable: async () => {
      throw new Error("named-pipe validation should not run");
    },
    ssh2AgentConnectable: async (agentPath) => {
      checked.push(agentPath);
      return true;
    },
    cygwinAgentConnectable: async (agentPath) => {
      checked.push(agentPath);
      return true;
    },
  };

  assert.equal(await getAvailableAgentSocket("pageant", injected), "pageant");
  assert.equal(
    await getAvailableAgentSocket("C:\\cygwin\\agent.socket", injected),
    "C:\\cygwin\\agent.socket",
  );
  assert.deepEqual(checked, ["pageant", "C:\\cygwin\\agent.socket"]);
});

test("Windows named pipe overrides retain the lightweight pipe probe", async () => {
  const pipePath = "\\\\.\\pipe\\custom-agent";
  let checkedPath = null;
  const result = await getAvailableAgentSocket(pipePath, {
    platform: "win32",
    windowsPipeConnectable: async (value) => {
      checkedPath = value;
      return true;
    },
    ssh2AgentConnectable: async () => {
      throw new Error("ssh2 validation should not run for a named pipe");
    },
  });

  assert.equal(result, pipePath);
  assert.equal(checkedPath, pipePath);
});

test("ssh2 agent validation times out when an agent does not respond", async () => {
  const start = Date.now();
  const stream = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback(); },
  });
  const available = await ssh2AgentConnectable("pageant", {
    timeoutMs: 20,
    createAgentImpl: () => ({ getStream(callback) { callback(null, stream); } }),
  });

  assert.equal(available, false);
  assert.equal(stream.destroyed, true);
  assert.ok(Date.now() - start < 500);
});

test("Pageant validation destroys a stream delivered after timeout", async () => {
  let deliverStream;
  const stream = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback(); },
  });
  const available = await ssh2AgentConnectable("pageant", {
    timeoutMs: 20,
    createAgentImpl: () => ({
      getStream(callback) { deliverStream = callback; },
    }),
  });
  assert.equal(available, false);
  deliverStream(null, stream);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stream.destroyed, true);
});

test("Cygwin agent validation closes a stalled negotiation socket", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cygwin-agent-"));
  const descriptorPath = path.join(dir, "agent.socket");
  const server = net.createServer();
  let acceptedSocket = null;
  let acceptedSocketClosed;
  const closed = new Promise((resolve) => { acceptedSocketClosed = resolve; });
  server.on("connection", (socket) => {
    acceptedSocket = socket;
    socket.resume();
    socket.once("close", acceptedSocketClosed);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  fs.writeFileSync(
    descriptorPath,
    `!<socket >${address.port} s 00000000-00000000-00000000-00000000`,
  );
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The timeout covers a stalled negotiation. Reading the descriptor from
  // memory keeps a slow filesystem from expiring that budget before the
  // socket exists, which otherwise looks like a connection that stayed open.
  assert.equal(await cygwinAgentConnectable(descriptorPath, {
    timeoutMs: 20,
    readFileImpl: async () => fs.readFileSync(descriptorPath, "utf8"),
  }), false);
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Cygwin probe connection stayed open")), 2_000)),
  ]);
  assert.equal(acceptedSocket?.destroyed, true);
});

test("Cygwin validation does not connect when descriptor reading finishes after timeout", async () => {
  let finishRead;
  let connectionAttempts = 0;
  const availablePromise = cygwinAgentConnectable("C:\\cygwin\\agent.socket", {
    timeoutMs: 20,
    readFileImpl: () => new Promise((resolve) => { finishRead = resolve; }),
    createConnectionImpl: () => {
      connectionAttempts += 1;
      throw new Error("must not connect after timeout");
    },
  });
  assert.equal(await availablePromise, false);
  finishRead("!<socket >1234 s 00000000-00000000-00000000-00000000");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectionAttempts, 0);
});

test("Cygwin validation converts POSIX-style descriptor paths", async () => {
  const readPaths = [];
  let convertedPath = null;
  let connectionAttempts = 0;
  const available = await cygwinAgentConnectable("/tmp/agent.socket", {
    timeoutMs: 20,
    readFileImpl: async (value) => {
      readPaths.push(value);
      if (value === "/tmp/agent.socket") throw new Error("ENOENT");
      return "!<socket >1234 s 00000000-00000000-00000000-00000000";
    },
    resolveCygwinPathImpl: async (value) => {
      assert.equal(value, "/tmp/agent.socket");
      convertedPath = "C:\\cygwin64\\tmp\\agent.socket";
      return convertedPath;
    },
    createConnectionImpl: () => {
      connectionAttempts += 1;
      return new Duplex({
        read() {},
        write(_chunk, _encoding, callback) { callback(); },
      });
    },
  });

  assert.equal(available, false);
  assert.deepEqual(readPaths, ["/tmp/agent.socket", convertedPath]);
  assert.equal(connectionAttempts, 1);
});

test("Cygwin agent validation completes the two-stage handshake", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cygwin-agent-ok-"));
  const descriptorPath = path.join(dir, "agent.socket");
  const server = net.createServer();
  let connectionIndex = 0;
  let retryCredentials = null;
  server.on("connection", (socket) => {
    connectionIndex += 1;
    const currentConnection = connectionIndex;
    let state = "secret";
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (true) {
        const needed = state === "secret" ? 16 : state === "credentials" ? 12 : 5;
        if (buffered.length < needed) return;
        const value = buffered.subarray(0, needed);
        buffered = buffered.subarray(needed);
        if (state === "secret") {
          socket.write(value);
          state = "credentials";
        } else if (state === "credentials") {
          if (currentConnection === 2) retryCredentials = Buffer.from(value);
          socket.write(currentConnection === 1 ? Buffer.alloc(12, 7) : Buffer.alloc(12, 9));
          state = currentConnection === 1 ? "done" : "agent";
        } else if (state === "agent") {
          socket.write(Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0]));
          state = "done";
        } else {
          return;
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  fs.writeFileSync(
    descriptorPath,
    `!<socket >${address.port} s 00000000-00000000-00000000-00000000`,
  );
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(await cygwinAgentConnectable(descriptorPath, {
    timeoutMs: 500,
    processId: 4242,
  }), true);
  assert.equal(connectionIndex, 2);
  assert.equal(retryCredentials.readUInt32LE(0), 4242);
  assert.deepEqual(retryCredentials.subarray(4), Buffer.alloc(8, 7));
});

test("Unix agent availability requires a working agent protocol response", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-agent-socket-"));
  const socketPath = path.join(dir, "agent.sock");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(await getAvailableAgentSocket(socketPath, {
    platform: "linux",
    socketAgentConnectable: async () => false,
  }), null);
  assert.equal(await getAvailableAgentSocket(socketPath, {
    platform: "linux",
    socketAgentConnectable: async () => true,
  }), socketPath);
});

test("Unix agent protocol probe closes a connection that never responds", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-agent-hung-"));
  const socketPath = path.join(dir, "agent.sock");
  const server = net.createServer();
  let acceptedSocket = null;
  let probeSocket = null;
  let acceptedSocketClosed;
  const closed = new Promise((resolve) => { acceptedSocketClosed = resolve; });
  server.on("connection", (socket) => {
    acceptedSocket = socket;
    socket.resume();
    socket.once("close", acceptedSocketClosed);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(await socketAgentConnectable(socketPath, {
    timeoutMs: 20,
    createConnectionImpl: (value) => {
      probeSocket = net.createConnection(value);
      return probeSocket;
    },
  }), false);
  assert.equal(probeSocket?.destroyed, true);
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("agent probe connection stayed open")), 500)),
  ]);
  assert.equal(acceptedSocket?.destroyed, true);
});

test("Unix agent identity probe reads the advertised identity count", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-agent-identities-"));
  const socketPath = path.join(dir, "agent.sock");
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write(Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 2]));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(await socketAgentIdentityCount(socketPath), 2);
});

test("native OpenSSH modes reject Pageant and Cygwin-only adapters clearly", async () => {
  await assert.rejects(
    getNativeOpenSshAgentSocket("pageant", {
      platform: "win32",
      ssh2AgentConnectable: async () => true,
    }),
    (error) => {
      assert.equal(error.code, "ERR_SSH_AGENT_NATIVE_UNSUPPORTED");
      assert.match(error.message, /named-pipe agent/);
      return true;
    },
  );
});
