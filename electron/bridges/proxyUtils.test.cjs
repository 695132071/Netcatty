const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { once } = require("node:events");
const net = require("node:net");
const { Client } = require("ssh2");

const {
  createProxySocket,
  runWhenProxyConnectionReady,
  substituteProxyCommand,
} = require("./proxyUtils.cjs");

const SSH_BANNER = Buffer.from("SSH-2.0-Fixture\r\n");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ssh2 only records the peer banner after it parses an identification line.
// "Connection lost before handshake" means those bytes never reached it.
function remoteIdent(socket) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (error, ident) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setImmediate(() => {
        try { client.destroy(); } catch { /* ignore */ }
      });
      if (error) reject(error);
      else resolve(ident);
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for remote SSH ident")), 1500);
    timer.unref();
    client.on("error", (err) => {
      if (/Connection lost before handshake/.test(err.message)) finish(err);
    });
    client.connect({
      sock: socket,
      username: "fixture",
      readyTimeout: 1500,
      debug(message) {
        const match = /Remote ident: (.*)/.exec(message);
        if (match) finish(null, match[1]);
      },
    });
  });
}

test("substituteProxyCommand replaces OpenSSH-style host and port tokens for POSIX shells", () => {
  assert.equal(
    substituteProxyCommand(
      "cloudflared access ssh --hostname %h --port %p --literal %%",
      "server's.example.com",
      2222,
      { platform: "linux" },
    ),
    "cloudflared access ssh --hostname 'server'\\''s.example.com' --port '2222' --literal %",
  );
});

test("substituteProxyCommand quotes safe OpenSSH-style host and port tokens for Windows cmd.exe", () => {
  assert.equal(
    substituteProxyCommand(
      "cloudflared access ssh --hostname %h --port %p --literal %%",
      "server.example.com",
      2222,
      { platform: "win32" },
    ),
    'cloudflared access ssh --hostname "server.example.com" --port "2222" --literal %',
  );
});

test("substituteProxyCommand rejects unsafe Windows cmd.exe placeholder values", () => {
  assert.throws(
    () => substituteProxyCommand("proxy --host %h", 'server" & whoami & "', 22, { platform: "win32" }),
    /cannot be safely substituted/,
  );
  assert.throws(
    () => substituteProxyCommand("proxy --host %h", "%USERPROFILE%.example.com", 22, { platform: "win32" }),
    /cannot be safely substituted/,
  );
});

test("createProxySocket exposes ProxyCommand stdout as socket data", async () => {
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('hello')")}`;
  const socket = await createProxySocket(
    { type: "command", host: "", port: 0, command },
    "server.example.com",
    22,
  );

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Timed out waiting for ProxyCommand output")), 1000).unref();
  });

  try {
    const data = await Promise.race([
      once(socket, "data").then(([chunk]) => chunk),
      timeout,
    ]);

    assert.equal(data.toString(), "hello");
  } finally {
    socket.destroy();
  }
});

test("createProxySocket times out a ProxyCommand that never produces a connection", async () => {
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => {}, 1000)")}`;
  const socket = await createProxySocket(
    { type: "command", host: "", port: 0, command },
    "server.example.com",
    22,
    { timeoutMs: 20 },
  );

  const [error] = await once(socket, "error");
  assert.match(error.message, /ProxyCommand connection timeout to server\.example\.com:22/);
  assert.equal(socket.destroyed, true);
});

test("ProxyCommand reports network readiness only after it produces connection data", async () => {
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    "setTimeout(() => process.stdout.write('ready'), 50)",
  )}`;
  const socket = await createProxySocket(
    { type: "command", host: "", port: 0, command },
    "server.example.com",
    22,
    { timeoutMs: 500 },
  );
  let ready = false;
  runWhenProxyConnectionReady(socket, () => {
    ready = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(ready, false);
  await once(socket, "data");
  assert.equal(ready, true);
  socket.destroy();
});

test("ProxyCommand spawn restores launch-time proxy env under Direct mode", async () => {
  const {
    applyNodeProxyEnv,
    resetProxyEnvOwnershipForTests,
  } = require("./httpNetworkProxyBridge.cjs");
  resetProxyEnvOwnershipForTests();

  const previous = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
  };
  process.env.HTTP_PROXY = "launch-proxy";
  process.env.HTTPS_PROXY = "launch-proxy";
  process.env.NO_PROXY = "localhost";
  applyNodeProxyEnv({ mode: "direct", url: "", bypass: "<local>" }, process.env);
  assert.equal(process.env.HTTP_PROXY, undefined);

  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    "process.stdout.write(process.env.HTTP_PROXY || '')",
  )}`;
  const socket = await createProxySocket(
    { type: "command", host: "", port: 0, command },
    "server.example.com",
    22,
  );

  try {
    const data = await Promise.race([
      once(socket, "data").then(([chunk]) => chunk.toString()),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for ProxyCommand env")), 1000).unref();
      }),
    ]);
    assert.equal(data, "launch-proxy");
  } finally {
    socket.destroy();
    // Restore process.env ownership and prior values for later tests.
    applyNodeProxyEnv({ mode: "system", url: "", bypass: "<local>" }, process.env);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetProxyEnvOwnershipForTests();
  }
});

test("createProxySocket times out stalled HTTP proxy handshakes", async (t) => {
  const originalConnect = net.connect;
  let socketDestroyed = false;
  const keepAlive = setTimeout(() => {}, 100);
  t.after(() => {
    clearTimeout(keepAlive);
    net.connect = originalConnect;
  });
  net.connect = () => {
    const socket = new EventEmitter();
    socket.setNoDelay = () => socket;
    socket.destroy = () => {
      socketDestroyed = true;
      socket.emit("close");
      return socket;
    };
    socket.write = () => true;
    return socket;
  };

  await assert.rejects(
    () => createProxySocket(
      { type: "http", host: "127.0.0.1", port: 8080 },
      "server.example.com",
      22,
      { timeoutMs: 20 },
    ),
    /Proxy connection timeout to server\.example\.com:22/,
  );
  assert.equal(socketDestroyed, true);
});

test("HTTP CONNECT keeps an SSH banner coalesced with the proxy reply", async (t) => {
  const sockets = new Set();
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write(Buffer.concat([
        Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"),
        SSH_BANNER,
      ]));
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await closeServer(proxy);
  });
  const port = await listen(proxy);
  const socket = await createProxySocket(
    { type: "http", host: "127.0.0.1", port },
    "203.0.113.10",
    22,
  );
  sockets.add(socket);
  assert.match(await remoteIdent(socket), /SSH-2\.0-Fixture/);
});

test("SOCKS5 keeps an SSH banner coalesced with the connect reply", async (t) => {
  const sockets = new Set();
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write(Buffer.from([0x05, 0x00]));
      socket.once("data", () => {
        // IPv4 bind address is 10 bytes; the banner shares this write.
        const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 22]);
        socket.write(Buffer.concat([reply, SSH_BANNER]));
      });
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await closeServer(proxy);
  });
  const port = await listen(proxy);
  const socket = await createProxySocket(
    { type: "socks5", host: "127.0.0.1", port },
    "203.0.113.10",
    22,
  );
  sockets.add(socket);
  assert.match(await remoteIdent(socket), /SSH-2\.0-Fixture/);
});
