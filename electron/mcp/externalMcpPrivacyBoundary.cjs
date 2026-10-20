"use strict";

const { createRedactionSession, normalizeRedactionConfig } = require("./externalMcpRedaction.cjs");

const RECONNECT_MESSAGE = "External MCP privacy settings changed. Reconnect the MCP client before continuing.";

/** One boundary belongs to one stdio process or HTTP MCP session, never a chat scope. */
function createPrivacyBoundary(rpcCall, getConfig) {
  let fingerprint;
  let session;

  function checkConfig() {
    let config;
    try {
      config = normalizeRedactionConfig(getConfig());
    } catch {
      throw new Error("External MCP privacy configuration is unavailable or invalid. Check Settings and reconnect.");
    }
    const current = JSON.stringify(config);
    if (fingerprint !== undefined && current !== fingerprint) {
      throw new Error(RECONNECT_MESSAGE);
    }
    if (fingerprint === undefined) {
      fingerprint = current;
      session = config.enabled ? createRedactionSession(config) : null;
    }
    return session;
  }

  return async (method, params) => {
    const protection = checkConfig();
    // Restoration precedes the main-process validation, command policy and approval UI.
    const restored = protection ? protection.restore(params) : params;
    let result;
    try {
      result = await rpcCall(method, restored);
    } catch (error) {
      checkConfig();
      if (!protection) throw error;
      throw new Error(protection.redact(String(error?.message || "Netcatty tool failed.")));
    }
    checkConfig();
    if (protection && method === "netcatty/readAttachment" && typeof result?.text === "string") {
      // The public attachment tool sends text instead of its encoded duplicate.
      const { base64Data: _encoded, ...textPayload } = result;
      result = textPayload;
    }
    return protection ? protection.redact(result, { preserveRootKeys: true }) : result;
  };
}

module.exports = { createPrivacyBoundary, RECONNECT_MESSAGE };
