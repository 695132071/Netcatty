const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { connectClient } = require("./netcattyRpcClient.cjs");
const { TOOL_CLI_DISCOVERY_ENV_VAR } = require("./discoveryPath.cjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STALE_AUTH_MESSAGE = "Authentication required. Send auth/verify with valid token first.";

// Minimal NDJSON bridge stand-in. acceptToken rejects every other token the
// way the live host does (RPC -32001, then close). authResult "not-ok"
// returns `{ ok: false }` instead, which connectClient maps to AUTH_FAILED.
function startFakeBridge({
  port = 0,
  acceptToken = null,
  authResult = "ok",
  closeDuringAuth = null,
} = {}) {
  let authAttempts = 0;
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("error", () => {});
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.trim()) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message?.id == null) continue;
          if (message.method === "auth/verify") {
            authAttempts += 1;
            if (closeDuringAuth && authAttempts === 1) {
              if (closeDuringAuth === "reset") {
                socket.destroy(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
              } else {
                socket.destroy();
              }
              return;
            }
            const presented = message.params?.token;
            const accepted = acceptToken == null || presented === acceptToken;
            if (!accepted && authResult === "not-ok") {
              socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: false } })}\n`);
              continue;
            }
            if (!accepted) {
              socket.write(`${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32001, message: STALE_AUTH_MESSAGE },
              })}\n`);
              return;
            }
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } })}\n`);
            continue;
          }
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
        }
      });
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

// Reserve a port and release it so connections to it are refused, simulating
// a bridge that died after the CLI read the discovery file.
function getDeadPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function writeDiscoveryFile(discoveryPath, port, token, pid = 424242) {
  fs.writeFileSync(discoveryPath, `${JSON.stringify({ port, token, pid })}\n`);
}

function setupDiscoveryEnv(t, discoveryPath) {
  const previous = process.env[TOOL_CLI_DISCOVERY_ENV_VAR];
  process.env[TOOL_CLI_DISCOVERY_ENV_VAR] = discoveryPath;
  t.after(() => {
    if (previous === undefined) {
      delete process.env[TOOL_CLI_DISCOVERY_ENV_VAR];
    } else {
      process.env[TOOL_CLI_DISCOVERY_ENV_VAR] = previous;
    }
  });
}

function countConnectAttempts(t) {
  const original = net.createConnection;
  let attempts = 0;
  net.createConnection = (...args) => {
    attempts += 1;
    return original(...args);
  };
  t.after(() => {
    net.createConnection = original;
  });
  return () => attempts;
}

function countDiscoveryReads(t, discoveryPath, onRead) {
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (filePath, ...args) {
    if (filePath === discoveryPath) {
      reads += 1;
      if (onRead) {
        const stub = onRead(reads);
        if (stub !== undefined) return stub;
      }
    }
    return original.call(this, filePath, ...args);
  };
  t.after(() => {
    fs.readFileSync = original;
  });
  return () => reads;
}

function isOriginalConnectError(err) {
  return err?.code === "CONNECT_FAILED"
    && typeof err?.message === "string"
    && err.message.startsWith("Failed to connect to Netcatty TCP bridge: ");
}

test("connectClient retries with a refreshed discovery file after a stale-port failure", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);

  const deadPort = await getDeadPort();
  const { server, port: bridgePort } = await startFakeBridge();
  t.after(() => {
    server.close();
  });
  const token = "test-token";
  writeDiscoveryFile(discoveryPath, deadPort, token);

  // Simulate the app finishing its restart: discovery is rewritten with the
  // new ephemeral port while the CLI is inside its first retry delay.
  const refresh = (async () => {
    await sleep(50);
    writeDiscoveryFile(discoveryPath, bridgePort, token);
  })();

  const client = await connectClient();
  await refresh;
  assert.equal(client.discovery.port, bridgePort);
  assert.equal(getAttempts(), 2);

  // The connection is usable end-to-end.
  await client.call("netcatty/getStatus", {});
  client.close();
  await sleep(20);
});

test("connectClient stops retrying and surfaces the original error when discovery identity is unchanged", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);
  const getReads = countDiscoveryReads(t, discoveryPath);

  const deadPort = await getDeadPort();
  writeDiscoveryFile(discoveryPath, deadPort, "test-token");

  const startedAt = Date.now();
  await assert.rejects(connectClient(), isOriginalConnectError);
  const elapsed = Date.now() - startedAt;

  // Same port, token, and pid: do not open another TCP connection, but keep
  // both delays so a later rewrite is still visible.
  assert.equal(getAttempts(), 1);
  assert.equal(getReads(), 3);
  assert.ok(elapsed >= 1100, `unchanged identity should keep the remaining delay, elapsed ${elapsed}ms`);
});

test("connectClient keeps polling when discovery disappears and surfaces the original connect error", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);
  const getReads = countDiscoveryReads(t, discoveryPath);

  const deadPort = await getDeadPort();
  writeDiscoveryFile(discoveryPath, deadPort, "test-token");

  const refresh = (async () => {
    await sleep(50);
    fs.rmSync(discoveryPath, { force: true });
  })();

  const startedAt = Date.now();
  await assert.rejects(connectClient(), isOriginalConnectError);
  const elapsed = Date.now() - startedAt;
  await refresh;

  // Missing file is transient: both bounded delays are consumed, and the
  // original connect error is what the caller sees.
  assert.equal(getAttempts(), 1);
  assert.equal(getReads(), 3);
  assert.ok(elapsed >= 1100, `missing discovery should consume both delays, elapsed ${elapsed}ms`);
});

test("connectClient connects after a transient missing discovery file is rewritten", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);

  const deadPort = await getDeadPort();
  const { server, port: bridgePort } = await startFakeBridge();
  t.after(() => {
    server.close();
  });
  writeDiscoveryFile(discoveryPath, deadPort, "stale-token", 1);
  const getReads = countDiscoveryReads(t, discoveryPath, (reads) => {
    if (reads === 2) {
      const err = new Error("ENOENT: no such file or directory");
      err.code = "ENOENT";
      throw err;
    }
    if (reads >= 3) {
      return `${JSON.stringify({ port: bridgePort, token: "fresh-token", pid: 2 })}\n`;
    }
    return undefined;
  });

  const client = await connectClient();
  assert.equal(client.discovery.port, bridgePort);
  assert.equal(client.discovery.token, "fresh-token");
  assert.equal(client.discovery.pid, 2);
  assert.equal(getAttempts(), 2);
  assert.equal(getReads(), 3);
  client.close();
  await sleep(20);
});

test("connectClient treats unparseable discovery as transient and keeps the original connect error", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);

  const deadPort = await getDeadPort();
  writeDiscoveryFile(discoveryPath, deadPort, "test-token");
  const getReads = countDiscoveryReads(t, discoveryPath, (reads) => (
    reads > 1 ? "{not json" : undefined
  ));

  const startedAt = Date.now();
  await assert.rejects(connectClient(), isOriginalConnectError);
  const elapsed = Date.now() - startedAt;

  assert.equal(getAttempts(), 1);
  assert.equal(getReads(), 3);
  assert.ok(elapsed >= 1100, `invalid discovery should consume both delays, elapsed ${elapsed}ms`);
});

test("connectClient retries when a restarted bridge reuses the port with a new token and pid", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);

  const { server, port } = await startFakeBridge({ acceptToken: "fresh-token" });
  t.after(() => {
    server.close();
  });
  const getReads = countDiscoveryReads(t, discoveryPath, (reads) => {
    const record = reads === 1
      ? { port, token: "stale-token", pid: 1 }
      : { port, token: "fresh-token", pid: 2 };
    return `${JSON.stringify(record)}\n`;
  });

  // The replacement bridge already owns the same ephemeral port. The first
  // TCP attempt still fails because the CLI is holding the pre-restart record.
  const originalConnect = net.createConnection;
  let attempts = 0;
  net.createConnection = (...args) => {
    attempts += 1;
    if (attempts === 1) {
      const socket = new net.Socket();
      process.nextTick(() => {
        const err = new Error("connect ECONNREFUSED 127.0.0.1");
        err.code = "ECONNREFUSED";
        socket.emit("error", err);
      });
      return socket;
    }
    return originalConnect(...args);
  };
  t.after(() => {
    net.createConnection = originalConnect;
  });

  const client = await connectClient();
  assert.equal(client.discovery.port, port);
  assert.equal(client.discovery.token, "fresh-token");
  assert.equal(client.discovery.pid, 2);
  assert.equal(attempts, 2);
  assert.equal(getReads(), 2);
  await client.call("netcatty/getStatus", {});
  client.close();
  await sleep(20);
});

test("connectClient refreshes discovery after a stale-token auth rejection on a reused port", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);

  const { server, port } = await startFakeBridge({ acceptToken: "fresh-token" });
  t.after(() => {
    server.close();
  });
  const getReads = countDiscoveryReads(t, discoveryPath, (reads) => {
    const record = reads === 1
      ? { port, token: "stale-token", pid: 11 }
      : { port, token: "fresh-token", pid: 22 };
    return `${JSON.stringify(record)}\n`;
  });

  const client = await connectClient();
  assert.equal(client.discovery.port, port);
  assert.equal(client.discovery.token, "fresh-token");
  assert.equal(client.discovery.pid, 22);
  assert.equal(getAttempts(), 2);
  assert.equal(getReads(), 2);
  await client.call("netcatty/getStatus", {});
  client.close();
  await sleep(20);
});

test("connectClient surfaces the original auth error when a stale token's discovery identity is unchanged", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);
  const getReads = countDiscoveryReads(t, discoveryPath);

  const { server, port } = await startFakeBridge({ acceptToken: "fresh-token", authResult: "not-ok" });
  t.after(() => {
    server.close();
  });
  writeDiscoveryFile(discoveryPath, port, "stale-token", 11);

  await assert.rejects(
    connectClient(),
    (err) => err?.code === "AUTH_FAILED"
      && err.message === "Failed to authenticate to Netcatty TCP bridge.",
  );

  assert.equal(getAttempts(), 1);
  assert.equal(getReads(), 3);
});

test("connectClient surfaces the bridge auth error when the stale token's discovery identity is unchanged", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);
  const getReads = countDiscoveryReads(t, discoveryPath);

  const { server, port } = await startFakeBridge({ acceptToken: "fresh-token" });
  t.after(() => {
    server.close();
  });
  writeDiscoveryFile(discoveryPath, port, "stale-token", 11);

  await assert.rejects(
    connectClient(),
    (err) => err?.code === "RPC_ERROR" && err.message === STALE_AUTH_MESSAGE,
  );

  assert.equal(getAttempts(), 1);
  assert.equal(getReads(), 3);
});

test("connectClient polls an initially missing discovery file and then connects", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);

  const { server, port } = await startFakeBridge();
  t.after(() => {
    server.close();
  });
  const getReads = countDiscoveryReads(t, discoveryPath, (reads) => {
    if (reads === 1) {
      const err = new Error("ENOENT: no such file or directory");
      err.code = "ENOENT";
      throw err;
    }
    return `${JSON.stringify({ port, token: "fresh-token", pid: 7 })}\n`;
  });

  const client = await connectClient();
  assert.equal(client.discovery.port, port);
  assert.equal(client.discovery.token, "fresh-token");
  assert.equal(getAttempts(), 1);
  assert.equal(getReads(), 2);
  client.close();
  await sleep(20);
});

test("connectClient retries when the initial discovery file is unreadable", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);

  const { server, port } = await startFakeBridge();
  t.after(() => {
    server.close();
  });
  countDiscoveryReads(t, discoveryPath, (reads) => {
    if (reads === 1) {
      const err = new Error("EACCES: permission denied");
      err.code = "EACCES";
      throw err;
    }
    return `${JSON.stringify({ port, token: "fresh-token", pid: 8 })}\n`;
  });

  const client = await connectClient();
  assert.equal(client.discovery.port, port);
  assert.equal(getAttempts(), 1);
  client.close();
  await sleep(20);
});

test("connectClient treats an initially partial discovery file as transient", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);

  const { server, port } = await startFakeBridge();
  t.after(() => {
    server.close();
  });
  countDiscoveryReads(t, discoveryPath, (reads) => (
    reads === 1
      ? "{not json"
      : `${JSON.stringify({ port, token: "fresh-token", pid: 9 })}\n`
  ));

  const client = await connectClient();
  assert.equal(client.discovery.port, port);
  assert.equal(getAttempts(), 1);
  client.close();
  await sleep(20);
});

test("connectClient surfaces the original APP_NOT_RUNNING error when discovery never appears", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);
  const getReads = countDiscoveryReads(t, discoveryPath);

  const startedAt = Date.now();
  await assert.rejects(
    connectClient(),
    (err) => err?.code === "APP_NOT_RUNNING"
      && err.message.startsWith(`Netcatty discovery file is missing at ${discoveryPath}.`),
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(getAttempts(), 0);
  assert.equal(getReads(), 3);
  assert.ok(elapsed >= 1100, `missing startup discovery should consume both delays, elapsed ${elapsed}ms`);
});

test("connectClient retries when the socket closes during auth and discovery changes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);

  const { server, port } = await startFakeBridge({ closeDuringAuth: "close" });
  t.after(() => {
    server.close();
  });
  const getReads = countDiscoveryReads(t, discoveryPath, (reads) => {
    const record = reads === 1
      ? { port, token: "token", pid: 1 }
      : { port, token: "token", pid: 2 };
    return `${JSON.stringify(record)}\n`;
  });

  const client = await connectClient();
  assert.equal(client.discovery.pid, 2);
  assert.equal(getAttempts(), 2);
  assert.equal(getReads(), 2);
  await client.call("netcatty/getStatus", {});
  client.close();
  await sleep(20);
});

test("connectClient surfaces the original transport error when auth is reset and discovery is unchanged", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);
  const getReads = countDiscoveryReads(t, discoveryPath);

  const { server, port } = await startFakeBridge({ closeDuringAuth: "reset" });
  t.after(() => {
    server.close();
  });
  writeDiscoveryFile(discoveryPath, port, "token", 4);

  await assert.rejects(
    connectClient(),
    (err) => (err?.code === "CONNECTION_CLOSED" || err?.code === "CONNECTION_ERROR")
      && typeof err?.message === "string"
      && (
        err.message === "Connection to Netcatty TCP bridge closed."
        || err.message.startsWith("Connection to Netcatty TCP bridge failed: ")
      ),
  );

  assert.equal(getAttempts(), 1);
  assert.equal(getReads(), 3);
});

test("connectClient observes a discovery rewrite after an unchanged reread", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-connect-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setupDiscoveryEnv(t, discoveryPath);
  const getAttempts = countConnectAttempts(t);

  const deadPort = await getDeadPort();
  const { server, port: bridgePort } = await startFakeBridge();
  t.after(() => {
    server.close();
  });
  const getReads = countDiscoveryReads(t, discoveryPath, (reads) => {
    if (reads < 3) {
      return `${JSON.stringify({ port: deadPort, token: "stale-token", pid: 1 })}\n`;
    }
    return `${JSON.stringify({ port: bridgePort, token: "fresh-token", pid: 2 })}\n`;
  });

  const startedAt = Date.now();
  const client = await connectClient();
  const elapsed = Date.now() - startedAt;
  assert.equal(client.discovery.port, bridgePort);
  assert.equal(client.discovery.pid, 2);
  assert.equal(getAttempts(), 2);
  assert.equal(getReads(), 3);
  assert.ok(elapsed >= 1100, `later rewrite should wait out both delays, elapsed ${elapsed}ms`);
  client.close();
  await sleep(20);
});
