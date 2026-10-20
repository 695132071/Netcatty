"use strict";

const crypto = require("node:crypto");
const net = require("node:net");

const DEFAULT_EXTERNAL_MCP_HTTP_PORT = 47391;
const DEFAULT_EXTERNAL_MCP_HTTP_HOST = "127.0.0.1";
const EXTERNAL_MCP_HTTP_PATH = "/mcp";
const MIN_EXTERNAL_MCP_HTTP_PORT = 1024;
const MAX_EXTERNAL_MCP_HTTP_PORT = 65535;
const EXTERNAL_MCP_HTTP_BEARER_ENV = "NETCATTY_MCP_BEARER_TOKEN";

function isWildcardBind(address) {
  return address === "0.0.0.0" || address === "::";
}

function unbracketHostname(hostname) {
  const host = String(hostname || "");
  if (host.startsWith("[") && host.endsWith("]") && host.length > 2) return host.slice(1, -1);
  return host;
}

function isLoopbackHost(hostname) {
  const host = unbracketHostname(hostname).toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isIpLiteral(hostname) {
  return net.isIP(unbracketHostname(hostname)) !== 0;
}

function normalizeHttpPort(value) {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(parsed) || parsed < MIN_EXTERNAL_MCP_HTTP_PORT || parsed > MAX_EXTERNAL_MCP_HTTP_PORT) {
    return {
      ok: false,
      errorCode: "invalid_port",
      error: `Enter a port from ${MIN_EXTERNAL_MCP_HTTP_PORT} to ${MAX_EXTERNAL_MCP_HTTP_PORT}.`,
    };
  }
  return { ok: true, port: parsed };
}

function normalizeListenAddress(value) {
  const address = String(value ?? "").trim();
  if (!address || net.isIP(address) === 0) {
    return {
      ok: false,
      errorCode: "invalid_address",
      error: "Listen address must be an IP address such as 0.0.0.0 or a vEthernet address.",
    };
  }
  return { ok: true, address };
}

function resolveEffectiveListenAddress({ allowCustomBind, listenAddress }) {
  if (!allowCustomBind) return DEFAULT_EXTERNAL_MCP_HTTP_HOST;
  const normalized = normalizeListenAddress(listenAddress);
  if (!normalized.ok) {
    const error = new Error(normalized.error);
    error.code = "INVALID_ADDRESS";
    error.errorCode = normalized.errorCode;
    throw error;
  }
  return normalized.address;
}

function formatHostForUrl(host) {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function normalizeClientHost(value) {
  const address = String(value ?? "").trim();
  if (!address) return { ok: true, address: "" };
  if (net.isIP(address) === 0 || isWildcardBind(address)) {
    return {
      ok: false,
      errorCode: "invalid_client_host",
      error: "Client address must be a reachable IP, not 0.0.0.0 or ::.",
    };
  }
  return { ok: true, address };
}

function buildClientUrl(listenAddress, port, clientHost) {
  const host = isWildcardBind(listenAddress) ? String(clientHost || "").trim() : listenAddress;
  if (!host || isWildcardBind(host) || net.isIP(host) === 0) return null;
  return `http://${formatHostForUrl(host)}:${port}${EXTERNAL_MCP_HTTP_PATH}`;
}

function parseHostHeader(hostHeader) {
  const raw = String(hostHeader || "").trim();
  if (!raw) return null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end <= 1) return null;
    const hostname = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    if (rest === "") return { hostname, port: null };
    if (!rest.startsWith(":")) return null;
    const port = rest.slice(1);
    if (!/^\d+$/.test(port)) return null;
    return { hostname, port };
  }
  const colon = raw.lastIndexOf(":");
  if (colon === -1) return { hostname: raw, port: null };
  const hostname = raw.slice(0, colon);
  const port = raw.slice(colon + 1);
  if (!hostname || !/^\d+$/.test(port)) return null;
  return { hostname, port };
}

function isAllowedHostname(hostname, listenAddress) {
  const host = unbracketHostname(hostname);
  if (isLoopbackHost(host)) return true;
  if (isWildcardBind(listenAddress)) return isIpLiteral(host);
  return host.toLowerCase() === String(listenAddress || "").toLowerCase();
}

function invalidHost() {
  return { ok: false, status: 421, errorCode: "host", message: "Invalid Host header" };
}

function invalidOrigin() {
  return { ok: false, status: 403, errorCode: "origin", message: "Invalid Origin header" };
}

function validateHostHeader(hostHeader, listenAddress, port) {
  const parsed = parseHostHeader(hostHeader);
  if (!parsed || parsed.port == null) return invalidHost();
  if (parsed.port !== String(port)) return invalidHost();
  if (!isAllowedHostname(parsed.hostname, listenAddress)) return invalidHost();
  return { ok: true };
}

function validateOriginHeader(originHeader, listenAddress) {
  if (originHeader == null || originHeader === "") return { ok: true };
  let url;
  try {
    url = new URL(originHeader);
  } catch {
    return invalidOrigin();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return invalidOrigin();
  if (url.username || url.password) return invalidOrigin();
  if (!isAllowedHostname(url.hostname, listenAddress)) return invalidOrigin();
  return { ok: true };
}

function validateRequestHeaders({ hostHeader, originHeader, listenAddress, port }) {
  const host = validateHostHeader(hostHeader, listenAddress, port);
  if (!host.ok) return host;
  return validateOriginHeader(originHeader, listenAddress);
}

function readBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== "string") return "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader.trim());
  return match ? match[1] : "";
}

function tokensEqual(presented, expected) {
  if (typeof expected !== "string" || expected.length === 0) return false;
  const presentedText = typeof presented === "string" ? presented : "";
  const presentedHash = crypto.createHash("sha256").update(presentedText).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(presentedHash, expectedHash);
}

function describeListenError(error, port) {
  if (error?.code === "EADDRINUSE") {
    return { errorCode: "port_in_use", error: `Port ${port} is already in use.` };
  }
  if (error?.code === "INVALID_ADDRESS" || error?.errorCode === "invalid_address") {
    return { errorCode: "invalid_address", error: error.message };
  }
  return { errorCode: "listen_failed", error: error?.message || String(error) };
}

module.exports = {
  DEFAULT_EXTERNAL_MCP_HTTP_HOST,
  DEFAULT_EXTERNAL_MCP_HTTP_PORT,
  EXTERNAL_MCP_HTTP_BEARER_ENV,
  EXTERNAL_MCP_HTTP_PATH,
  MAX_EXTERNAL_MCP_HTTP_PORT,
  MIN_EXTERNAL_MCP_HTTP_PORT,
  buildClientUrl,
  describeListenError,
  normalizeClientHost,
  isAllowedHostname,
  isLoopbackHost,
  isWildcardBind,
  normalizeHttpPort,
  normalizeListenAddress,
  parseHostHeader,
  readBearerToken,
  resolveEffectiveListenAddress,
  tokensEqual,
  validateRequestHeaders,
};
