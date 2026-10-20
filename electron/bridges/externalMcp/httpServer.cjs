"use strict";

const { createPrivacyBoundary } = require("../../mcp/externalMcpPrivacyBoundary.cjs");

/**
 * Optional Streamable HTTP endpoint for External MCP.
 * Tool calls go through the same progressive MCP registry and
 * mcpServerBridge.dispatchBuiltinRpc path as the stdio launcher.
 * Legacy HTTP+SSE (protocol 2024-11-05, GET /sse + POST /messages) is not
 * mounted: it is a second transport, not a free extra of Streamable HTTP.
 */

const http = require("node:http");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { EventEmitter } = require("node:events");

const { EXTERNAL_MCP_CHAT_SESSION_ID } = require("../../cli/externalMcpDiscoveryPath.cjs");
const { normalizeMcpJsonRpcMessage } = require("../../mcp/normalizeMcpCallArguments.cjs");
const {
  DEFAULT_EXTERNAL_MCP_HTTP_HOST,
  DEFAULT_EXTERNAL_MCP_HTTP_PORT,
  EXTERNAL_MCP_HTTP_PATH,
  readBearerToken,
  tokensEqual,
  validateRequestHeaders,
} = require("./httpSecurity.cjs");

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_SESSION_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_SWEEP_MS = 60 * 1000;
const requestContext = new AsyncLocalStorage();

class ExternalMcpHttpClient extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

function trackConnections(server) {
  const owned = new Set();
  server.on("connection", (socket) => {
    owned.add(socket);
    socket.on("close", () => owned.delete(socket));
  });
  return owned;
}

function closeHttpServer(server, owned) {
  return new Promise((resolve) => {
    // requestTimeout is disabled so a half-open POST does not get cut off
    // during a long tool call. close() waits for those sockets, so destroy
    // them before awaiting the callback or disable/reconfigure hangs.
    server.close(() => resolve());
    if (!owned) return;
    for (const socket of owned) socket.destroy();
    owned.clear();
  });
}

function jsonRpcError(message, code = -32000) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function sendJson(res, status, body, extraHeaders) {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function headerValue(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", fail);
  });
}

function loadMcpRuntime() {
  const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");
  const { getCatalogToolDescription } = require("../../mcp/catalogToolMetadata.cjs");
  const { NETCATTY_MCP_SERVER_INSTRUCTIONS } = require("../../mcp/netcattyMcpInstructions.cjs");
  const { registerProgressiveMcpTools } = require("../../mcp/progressiveMcpTools.cjs");
  return {
    McpServer,
    StreamableHTTPServerTransport,
    isInitializeRequest,
    getCatalogToolDescription,
    NETCATTY_MCP_SERVER_INSTRUCTIONS,
    registerProgressiveMcpTools,
  };
}

function createExternalMcpHttpServer(deps = {}) {
  const chatSessionId = deps.chatSessionId || EXTERNAL_MCP_CHAT_SESSION_ID;
  const dispatchRpc = deps.dispatchRpc;
  const getPermissionMode = deps.getPermissionMode || (() => "confirm");
  const isEnabled = deps.isEnabled || (() => true);
  const recordActivity = deps.recordActivity || (() => {});
  const attachExternalClient = deps.attachExternalClient || ((client) => () => client.destroy());
  const getToken = deps.getToken || (() => "");
  const sessionIdleMs = Number.isFinite(deps.sessionIdleMs) && deps.sessionIdleMs >= 0
    ? deps.sessionIdleMs
    : DEFAULT_SESSION_IDLE_MS;
  const sessionSweepMs = Number.isFinite(deps.sessionSweepMs) && deps.sessionSweepMs > 0
    ? deps.sessionSweepMs
    : DEFAULT_SESSION_SWEEP_MS;

  let mcpRuntime = null;
  let httpServer = null;
  let listenAddress = DEFAULT_EXTERNAL_MCP_HTTP_HOST;
  let listenPort = null;
  let sessions = new Map();
  let activeSockets = new Set();
  let startChain = Promise.resolve();
  let generation = 0;
  let sweepTimer = null;

  function runtime() {
    if (!mcpRuntime) mcpRuntime = loadMcpRuntime();
    return mcpRuntime;
  }

  function guardWriteOperation() {
    if (getPermissionMode() === "observer") {
      return 'Operation denied: permission mode is "observer" (read-only). Change to "confirm" or "auto" in Settings → AI → Safety to allow this action.';
    }
    return null;
  }

  async function rpcCall(method, params) {
    if (!isEnabled()) {
      throw new Error("External MCP is disabled. Re-enable it in Netcatty Settings → AI.");
    }
    if (typeof dispatchRpc !== "function") {
      throw new Error("External MCP HTTP dispatch is unavailable.");
    }
    try {
      recordActivity();
    } catch {
      // Activity bookkeeping must not fail the tool call.
    }
    const store = requestContext.getStore();
    return await dispatchRpc(method, {
      ...(params || {}),
      chatSessionId,
    }, {
      externalClient: store?.externalClient || null,
    });
  }

  function createSessionServer() {
    const protectedRpcCall = createPrivacyBoundary(rpcCall, deps.getRedactionConfig || (() => undefined));
    const {
      McpServer,
      getCatalogToolDescription,
      NETCATTY_MCP_SERVER_INSTRUCTIONS,
      registerProgressiveMcpTools,
    } = runtime();
    const server = new McpServer({
      name: "netcatty-remote-hosts",
      version: "1.0.0",
    }, {
      instructions: NETCATTY_MCP_SERVER_INSTRUCTIONS,
    });
    server.resource(
      "environment",
      "netcatty://context",
      { description: "Current Netcatty workspace context: connected hosts, session IDs, and environment description." },
      async () => {
        const ctx = await protectedRpcCall("netcatty/getContext", { chatSessionId });
        return {
          contents: [{
            uri: "netcatty://context",
            mimeType: "application/json",
            text: JSON.stringify(ctx, null, 2),
          }],
        };
      },
    );
    registerProgressiveMcpTools(server, {
      rpcCall: protectedRpcCall,
      scopeParams: { chatSessionId },
      guardWriteOperation,
      catalogDescription(toolName, fallback) {
        return getCatalogToolDescription(toolName) || fallback;
      },
    });
    return server;
  }

  function dropSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || session.closing) return;
    session.closing = true;
    sessions.delete(sessionId);
    try {
      session.detach?.();
    } catch {
      // Best-effort approval-client detach.
    }
    void Promise.resolve(session.server?.close?.()).catch(() => {});
  }

  function expireIdleSessions() {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (session.inFlight > 0) continue;
      if (now - session.lastActivityAt < sessionIdleMs) continue;
      dropSession(sessionId);
    }
  }

  function startSessionSweep() {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = setInterval(expireIdleSessions, sessionSweepMs);
    sweepTimer.unref?.();
  }

  function stopSessionSweep() {
    if (!sweepTimer) return;
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  async function withSession(session, run) {
    session.inFlight += 1;
    session.lastActivityAt = Date.now();
    try {
      await run();
    } finally {
      session.inFlight = Math.max(0, session.inFlight - 1);
      session.lastActivityAt = Date.now();
    }
  }

  async function closeSessions() {
    const current = Array.from(sessions.values());
    sessions = new Map();
    await Promise.all(current.map(async (session) => {
      try {
        await session.transport?.close?.();
      } catch {
        // Closing a finished transport is best-effort.
      }
      try {
        session.detach?.();
      } catch {
        // Best-effort approval-client detach.
      }
      try {
        await session.server?.close?.();
      } catch {
        // Best-effort MCP server close.
      }
    }));
  }

  async function openSession(req, res, body) {
    const { StreamableHTTPServerTransport } = runtime();
    const externalClient = new ExternalMcpHttpClient();
    let detach = () => externalClient.destroy();
    try {
      const attached = attachExternalClient(externalClient);
      if (typeof attached === "function") detach = attached;
    } catch {
      detach = () => externalClient.destroy();
    }
    const server = createSessionServer();
    const session = {
      server,
      externalClient,
      detach,
      transport: null,
      sessionId: null,
      lastActivityAt: Date.now(),
      inFlight: 0,
      closing: false,
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        session.sessionId = sessionId;
        sessions.set(sessionId, session);
      },
    });
    session.transport = transport;
    transport.onclose = () => {
      if (session.sessionId) dropSession(session.sessionId);
    };
    transport.onmessage = (message) => {
      normalizeMcpJsonRpcMessage(message);
    };
    try {
      await server.connect(transport);
      await withSession(session, () => (
        requestContext.run({ externalClient }, () => transport.handleRequest(req, res, body))
      ));
      // The SDK answers 406/415 before onsessioninitialized. That is not a throw,
      // so the synthetic approval client and MCP server would otherwise stay up.
      if (!session.sessionId) {
        detach();
        try {
          await server.close?.();
        } catch {
          // Ignore close failures after a rejected handshake.
        }
      }
    } catch (error) {
      if (session.sessionId) dropSession(session.sessionId);
      else detach();
      try {
        await server.close?.();
      } catch {
        // Ignore close failures after a failed handshake.
      }
      throw error;
    }
  }

  async function routeRequest(req, res) {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (pathname !== EXTERNAL_MCP_HTTP_PATH) {
      sendJson(res, 404, jsonRpcError("Not found"));
      return;
    }
    if (!isEnabled()) {
      sendJson(res, 503, jsonRpcError("External MCP is disabled."));
      return;
    }
    const presented = readBearerToken(headerValue(req, "authorization"));
    if (!tokensEqual(presented, getToken())) {
      sendJson(res, 401, jsonRpcError("Unauthorized", -32001));
      return;
    }
    const headerCheck = validateRequestHeaders({
      hostHeader: headerValue(req, "host"),
      originHeader: headerValue(req, "origin"),
      listenAddress,
      port: listenPort,
    });
    if (!headerCheck.ok) {
      sendJson(res, headerCheck.status, jsonRpcError(headerCheck.message));
      return;
    }

    const method = req.method || "GET";
    if (method === "POST") {
      let raw = "";
      try {
        raw = await readBody(req);
      } catch (error) {
        if (error.statusCode === 413) {
          res.once("finish", () => req.destroy());
        }
        sendJson(res, error.statusCode || 400, jsonRpcError(error.statusCode === 413 ? "Payload too large" : "Invalid request body"));
        return;
      }
      // Auth ran before the body so a half-open POST could not stall the
      // socket forever. Recheck after the body arrives so a token rotated
      // while this request was incomplete cannot still dispatch.
      if (!tokensEqual(presented, getToken())) {
        sendJson(res, 401, jsonRpcError("Unauthorized", -32001));
        return;
      }
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        sendJson(res, 400, jsonRpcError("Invalid JSON"));
        return;
      }
      const sessionId = headerValue(req, "mcp-session-id");
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          sendJson(res, 404, jsonRpcError("Session not found"));
          return;
        }
        await withSession(session, () => requestContext.run({ externalClient: session.externalClient }, () => (
          session.transport.handleRequest(req, res, body)
        )));
        return;
      }
      if (!runtime().isInitializeRequest(body)) {
        sendJson(res, 400, jsonRpcError("Bad Request: missing session"));
        return;
      }
      await openSession(req, res, body);
      return;
    }

    if (method === "GET" || method === "DELETE") {
      const sessionId = headerValue(req, "mcp-session-id");
      if (!sessionId) {
        sendJson(res, 400, jsonRpcError("Bad Request: missing session"));
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        sendJson(res, 404, jsonRpcError("Session not found"));
        return;
      }
      await withSession(session, () => requestContext.run({ externalClient: session.externalClient }, () => (
        session.transport.handleRequest(req, res)
      )));
      return;
    }

    sendJson(res, 405, jsonRpcError("Method not allowed"), { Allow: "GET, POST, DELETE" });
  }

  async function onRequest(req, res) {
    try {
      await routeRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, jsonRpcError(error?.message || "Internal error"));
      }
    }
  }

  async function startUnlocked({ host, port }) {
    const nextGeneration = ++generation;
    await stopUnlocked(nextGeneration);
    if (nextGeneration !== generation) return getState();
    listenAddress = host || DEFAULT_EXTERNAL_MCP_HTTP_HOST;
    const server = http.createServer((req, res) => {
      void onRequest(req, res);
    });
    server.requestTimeout = 0;
    server.timeout = 0;
    const ownedSockets = trackConnections(server);
    try {
      await new Promise((resolve, reject) => {
        const fail = (error) => {
          server.off("listening", succeed);
          reject(error);
        };
        const succeed = () => {
          server.off("error", fail);
          resolve();
        };
        server.once("error", fail);
        server.once("listening", succeed);
        server.listen(port, listenAddress);
      });
    } catch (error) {
      await closeHttpServer(server, ownedSockets);
      throw error;
    }
    if (nextGeneration !== generation) {
      await closeHttpServer(server, ownedSockets);
      return getState();
    }
    httpServer = server;
    activeSockets = ownedSockets;
    startSessionSweep();
    const address = server.address();
    listenPort = address && typeof address === "object" ? address.port : port;
    return getState();
  }

  async function stopUnlocked(expectedGeneration) {
    stopSessionSweep();
    const server = httpServer;
    const ownedSockets = activeSockets;
    httpServer = null;
    activeSockets = new Set();
    listenPort = null;
    await closeSessions();
    if (server) {
      await closeHttpServer(server, ownedSockets);
    }
    if (expectedGeneration != null && expectedGeneration !== generation) return;
  }

  function start(options) {
    const run = () => startUnlocked(options || {});
    const result = startChain.then(run, run);
    startChain = result.then(() => {}, () => {});
    return result;
  }

  function stop() {
    const nextGeneration = ++generation;
    const run = () => stopUnlocked(nextGeneration);
    const result = startChain.then(run, run);
    startChain = result.then(() => {}, () => {});
    return result;
  }

  function getState() {
    return {
      listening: Boolean(httpServer),
      host: listenAddress,
      port: listenPort,
    };
  }

  return {
    start,
    stop,
    getState,
    DEFAULT_EXTERNAL_MCP_HTTP_PORT,
  };
}

module.exports = {
  createExternalMcpHttpServer,
  ExternalMcpHttpClient,
};
