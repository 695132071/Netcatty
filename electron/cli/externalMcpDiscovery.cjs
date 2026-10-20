"use strict";

const fs = require("node:fs");
const path = require("node:path");

function buildExternalDiscoveryPayload({
  host = "127.0.0.1",
  port,
  token,
  pid,
  permissionMode,
  chatSessionId,
  redaction,
}) {
  return {
    version: 1,
    host,
    port,
    token,
    pid,
    permissionMode: permissionMode || "confirm",
    chatSessionId: chatSessionId || "__external_mcp__",
    ...(redaction ? { redaction } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function writeExternalDiscovery(filePath, options) {
  const payload = buildExternalDiscoveryPayload(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return payload;
}

function removeExternalDiscovery(filePath) {
  if (!filePath) return;
  fs.rmSync(filePath, { force: true });
}

function readExternalDiscovery(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("External MCP discovery file is invalid.");
  }
  const port = Number(parsed.port);
  const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
  if (!Number.isFinite(port) || port <= 0 || !token) {
    throw new Error("External MCP discovery file is missing port or token.");
  }
  return {
    host: typeof parsed.host === "string" && parsed.host.trim() ? parsed.host.trim() : "127.0.0.1",
    port,
    token,
    permissionMode: typeof parsed.permissionMode === "string" ? parsed.permissionMode : "confirm",
    chatSessionId: typeof parsed.chatSessionId === "string" && parsed.chatSessionId
      ? parsed.chatSessionId
      : "__external_mcp__",
    pid: parsed.pid ?? null,
    redaction: parsed.redaction,
  };
}

module.exports = {
  buildExternalDiscoveryPayload,
  writeExternalDiscovery,
  removeExternalDiscovery,
  readExternalDiscovery,
};
