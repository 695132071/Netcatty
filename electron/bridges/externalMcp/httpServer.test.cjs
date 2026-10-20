"use strict";

const http = require("node:http");
const net = require("node:net");
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const { createExternalMcpHttpServer } = require("./httpServer.cjs");
const { EXTERNAL_MCP_CHAT_SESSION_ID } = require("../../cli/externalMcpDiscoveryPath.cjs");

const TOKEN = "test-bearer-token";

function postJson(url, { token, host, origin, body, sessionId, accept }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (accept) headers.Accept = accept;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (host) headers.Host = host;
    if (origin) headers.Origin = origin;
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
          sessionId: res.headers["mcp-session-id"] || "",
        });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function requestSession(url, method, sessionId) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function startServer(overrides = {}) {
  const calls = [];
  const server = createExternalMcpHttpServer({
    getToken: () => TOKEN,
    isEnabled: () => true,
    dispatchRpc: async (method, params, context) => {
      calls.push({ method, params, context });
      if (method === "netcatty/exec") {
        return { ok: true, stdout: "from-handler", stderr: "", exitCode: 0 };
      }
      if (method === "netcatty/getContext") {
        return { hosts: [] };
      }
      return { ok: true };
    },
    ...overrides,
  });
  const state = await server.start({ host: "127.0.0.1", port: 0 });
  return {
    server,
    calls,
    url: `http://127.0.0.1:${state.port}/mcp`,
    port: state.port,
  };
}

describe("external MCP streamable HTTP server", () => {
  let active = null;

  afterEach(async () => {
    if (active) {
      await active.server.stop();
      active = null;
    }
  });

  it("rejects missing and wrong bearer tokens with the same status", async () => {
    active = await startServer();
    const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const missing = await postJson(active.url, { body });
    const wrong = await postJson(active.url, { token: "nope", body });
    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(missing.body, wrong.body);
    assert.equal(active.calls.length, 0);
  });

  it("rejects a request whose token was rotated while the body was incomplete", async () => {
    let token = TOKEN;
    let releaseAuth = () => {};
    const authSeen = new Promise((resolve) => {
      releaseAuth = resolve;
    });
    let tokenReads = 0;
    active = await startServer({
      getToken: () => {
        tokenReads += 1;
        if (tokenReads === 1) releaseAuth();
        return token;
      },
    });
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    const result = await new Promise((resolve, reject) => {
      const target = new URL(active.url);
      const req = http.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${TOKEN}`,
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      req.on("error", reject);
      req.write(payload.slice(0, 8));
      authSeen.then(() => {
        token = "rotated-token";
        req.end(payload.slice(8));
      }).catch(reject);
    });
    await Promise.race([
      authSeen,
      new Promise((_, reject) => setTimeout(() => reject(new Error("auth was not checked")), 2000)),
    ]);
    assert.equal(result.status, 401);
    assert.ok(tokenReads >= 2);
    assert.equal(active.calls.length, 0);
  });

  it("detaches the approval client when initialize is rejected before a session exists", async () => {
    const attached = [];
    active = await startServer({
      attachExternalClient: (client) => {
        attached.push(client);
        return () => client.destroy();
      },
    });
    const rejected = await postJson(active.url, {
      token: TOKEN,
      accept: "application/json",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "reject-test", version: "1.0.0" },
        },
      },
    });
    assert.equal(rejected.status, 406);
    assert.equal(attached.length, 1);
    assert.equal(attached[0].destroyed, true);
    assert.equal(active.calls.length, 0);
  });

  it("rejects a rebinding Host and a foreign Origin before any tool dispatch", async () => {
    active = await startServer();
    const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
    const host = await postJson(active.url, {
      token: TOKEN,
      host: `evil.example:${active.port}`,
      body,
    });
    const origin = await postJson(active.url, {
      token: TOKEN,
      origin: "https://evil.example",
      body,
    });
    assert.equal(host.status, 421);
    assert.equal(origin.status, 403);
    assert.equal(active.calls.length, 0);
  });

  it("lists tools and dispatches terminal_execute through the shared RPC handler", async () => {
    active = await startServer();
    const client = new Client({ name: "netcatty-http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(active.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "terminal_execute"));
      const result = await client.callTool({
        name: "terminal_execute",
        arguments: { sessionId: "sess-1", command: "pwd" },
      });
      assert.match(JSON.stringify(result), /from-handler/);
      const execCall = active.calls.find((call) => call.method === "netcatty/exec");
      assert.ok(execCall, "terminal_execute did not reach dispatchRpc");
      assert.equal(execCall.params.chatSessionId, EXTERNAL_MCP_CHAT_SESSION_ID);
      assert.equal(execCall.params.sessionId, "sess-1");
      assert.equal(execCall.params.command, "pwd");
      assert.ok(execCall.context.externalClient);
    } finally {
      await client.close();
    }
  });

  it("isolates reversible masking per HTTP session and covers the environment resource", async () => {
    const writes = [];
    active = await startServer({
      getRedactionConfig: () => ({ enabled: true }),
      dispatchRpc: async (method, params) => {
        if (method === "netcatty/exec") {
          writes.push(params.command);
          return { ok: true, stdout: params.command, exitCode: 0 };
        }
        return { ok: true, text: "192.0.2.10", password: "synthetic-password" };
      },
    });
    const clients = [1, 2].map(() => new Client({ name: "privacy-test", version: "1" }));
    try {
      for (const client of clients) {
        await client.connect(new StreamableHTTPClientTransport(new URL(active.url), {
          requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
        }));
      }
      const result = await clients[0].callTool({ name: "get_environment", arguments: {} });
      const data = JSON.parse(result.content[0].text);
      assert.doesNotMatch(JSON.stringify(result), /192\.0\.2\.10|synthetic-password/);
      const resource = await clients[0].readResource({ uri: "netcatty://context" });
      assert.equal(JSON.parse(resource.contents[0].text).text, data.text);
      await clients[0].callTool({ name: "terminal_execute", arguments: { sessionId: "s", command: `echo ${data.text}` } });
      assert.deepEqual(writes, ["echo 192.0.2.10"]);
      const rejected = await clients[1].callTool({ name: "terminal_execute", arguments: { sessionId: "s", command: `echo ${data.text}` } });
      assert.equal(rejected.isError, true);
      assert.equal(writes.length, 1);
    } finally {
      for (const client of clients) await client.close();
    }
  });

  it("expires an HTTP session that never sends DELETE", async () => {
    active = await startServer({ sessionIdleMs: 40, sessionSweepMs: 15 });
    const initialized = await postJson(active.url, {
      token: TOKEN,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "expire-test", version: "1.0.0" },
        },
      },
    });
    assert.equal(initialized.status, 200);
    assert.ok(initialized.sessionId);
    const live = await postJson(active.url, {
      token: TOKEN,
      sessionId: initialized.sessionId,
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    assert.equal(live.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const expired = await postJson(active.url, {
      token: TOKEN,
      sessionId: initialized.sessionId,
      body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    });
    assert.equal(expired.status, 404);
    const expiredGet = await requestSession(active.url, "GET", initialized.sessionId);
    const expiredDelete = await requestSession(active.url, "DELETE", initialized.sessionId);
    assert.equal(expiredGet.status, 404);
    assert.equal(expiredDelete.status, 404);
    const missing = await requestSession(active.url, "GET", "");
    assert.equal(missing.status, 400);
  });

  it("is not listening after stop", async () => {
    active = await startServer();
    const port = active.port;
    await active.server.stop();
    await assert.rejects(
      postJson(`http://127.0.0.1:${port}/mcp`, {
        token: TOKEN,
        body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      }),
      (error) => error.code === "ECONNREFUSED",
    );
    assert.equal(active.server.getState().listening, false);
    active = null;
  });

  it("returns 413 before closing an oversized request", async () => {
    active = await startServer();
    const payload = Buffer.alloc((4 * 1024 * 1024) + 64, 0x61);
    const result = await new Promise((resolve, reject) => {
      const target = new URL(active.url);
      const req = http.request({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": payload.length,
          Authorization: `Bearer ${TOKEN}`,
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      req.on("error", reject);
      req.end(payload);
    });
    assert.equal(result.status, 413);
    assert.match(result.body, /Payload too large/);
  });

  it("stop finishes while a client holds an incomplete request", async () => {
    active = await startServer();
    const socket = net.connect(active.port, "127.0.0.1");
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${active.port}\r\nContent-Length: 100\r\n\r\n`);
    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
    }, 2000);
    await active.server.stop();
    clearTimeout(timer);
    socket.destroy();
    assert.equal(hung, false);
    assert.equal(active.server.getState().listening, false);
    active = null;
  });

  it("reports port in use instead of switching ports", async () => {
    const blocker = http.createServer((_req, res) => res.end("busy"));
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = blocker.address().port;
    const server = createExternalMcpHttpServer({ getToken: () => TOKEN });
    active = { server, calls: [], url: "", port };
    await assert.rejects(
      server.start({ host: "127.0.0.1", port }),
      (error) => error.code === "EADDRINUSE",
    );
    assert.equal(server.getState().listening, false);
    await new Promise((resolve) => blocker.close(() => resolve()));
  });
});
