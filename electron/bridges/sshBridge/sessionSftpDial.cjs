"use strict";

const { randomUUID } = require("node:crypto");
const { buildConnectionReuseEndpoint, normalizeEndpoint, endpointAllowsReuse } = require("../sshConnectionPool.cjs");
const { classifyHostKey } = require("../hostKeyVerifier.cjs");

// Keep the authenticated dial profile in a closure, never in discovery metadata
// or persisted host data. The terminal still owns this profile's lifetime.
function attachSessionSftpDial(session, options, { sessions, sessionId, sender, openSftp, closeSftp, acceptedHostKeys = [] }) {
  // Pin this redial to the keys actually accepted for the live route, not the
  // renderer snapshot from before a first-trust / changed-key confirmation.
  // Do not retain an older trusted key alongside its accepted replacement.
  const dialOptions = {
    ...options,
    knownHosts: acceptedHostKeys.map((key) => ({ ...key })),
    hostKeyUnattended: true,
  };
  const routeEndpoint = (profile) => normalizeEndpoint({
    ...buildConnectionReuseEndpoint(profile),
    ...(profile.keepaliveIntervalMs != null ? {
      keepaliveIntervalMs: profile.keepaliveIntervalMs,
      keepaliveCountMax: profile.keepaliveCountMax,
    } : {}),
    ignoreKnownHostTrustForReuse: true,
    singleChannelSsh: false,
  });
  const originalRoute = routeEndpoint({
    ...options,
    agentForwarding: session._reuseEndpoint?.agentForwarding ?? options.agentForwarding,
  });
  const passwordlessRoute = options.sftpReuseOptions && !options.sftpReuseOptions.password
    ? routeEndpoint(options.sftpReuseOptions)
    : null;
  Object.defineProperty(session, "_matchesDedicatedSftpEndpoint", {
    value: (request) => {
      const requested = routeEndpoint(request);
      return endpointAllowsReuse(requested, originalRoute, "channel")
        || Boolean(passwordlessRoute
          && endpointAllowsReuse({ ...passwordlessRoute, authFingerprint: originalRoute?.authFingerprint }, originalRoute, "channel")
          && endpointAllowsReuse(requested, passwordlessRoute, "channel"));
    },
  });
  const assertCurrentTrust = (request) => {
    if (!request) return; // Explicit session operations use its accepted lifetime pin.
    const hops = [request, ...(Array.isArray(request.jumpHosts) ? request.jumpHosts : [])];
    const trusted = hops.every((hop) => {
      if ((hop.verifyHostKeys ?? request.verifyHostKeys) === false) return true;
      return dialOptions.knownHosts.some((key) =>
        String(key.hostname || "").trim().toLowerCase() === String(hop.hostname || "").trim().toLowerCase()
        && (Number(key.port) || 22) === (Number(hop.port) || 22)
        && classifyHostKey({
          knownHosts: Array.isArray(request.knownHosts) ? request.knownHosts : [],
          hostname: key.hostname, port: key.port || 22,
          keyType: key.keyType, fingerprint: key.fingerprint,
        }).status === "trusted");
    });
    if (!trusted) {
      const error = new Error("The terminal host key is no longer trusted. Reconnect the terminal to verify the host key before transferring files.");
      error.code = "ERR_HOST_KEY_UNVERIFIED";
      throw error;
    }
  };
  for (const key of ["sessionId", "sourceSessionId", "bootEpoch", "_connRef", "_sourceReuseState", "sftpReuseOptions", "sock"]) {
    delete dialOptions[key];
  }
  const assertActive = (signal) => {
    if (signal?.aborted) throw new DOMException("SFTP open cancelled", "AbortError");
    if (sessions.get(sessionId) !== session || sender?.isDestroyed?.()) {
      throw new Error("Source SSH session is no longer active");
    }
  };
  Object.defineProperty(session, "_openDedicatedSftp", {
    value: async (payload = {}) => {
      assertActive(payload.abortSignal);
      assertCurrentTrust(payload.expectedEndpoint);
      const controller = new AbortController();
      const abort = () => controller.abort();
      payload.abortSignal?.addEventListener("abort", abort, { once: true });
      session.stream?.once?.("close", abort);
      session.conn?.once?.("close", abort);
      try {
        const opened = await openSftp({ sender }, {
          ...dialOptions,
          sessionId: randomUUID(),
          sourceSessionId: sessionId,
          reuseTransport: false,
          singleChannelSsh: true,
          fileProtocol: payload.fileProtocol ?? session.sftpFileProtocol ?? "auto",
          sudo: Boolean(payload.sudo),
          abortSignal: controller.signal,
        });
        try {
          assertActive(controller.signal);
        } catch (err) {
          try { await closeSftp(null, { sftpId: opened.sftpId }); } catch { /* Preserve cancellation. */ }
          throw err;
        }
        return { ...opened, sourceSessionId: sessionId };
      } catch (err) {
        if (err?.code === "ERR_HOST_KEY_UNVERIFIED"
          || /Host denied \(verification failed\)|Host key rejected/i.test(String(err?.message || ""))) {
          err.code = "ERR_HOST_KEY_UNVERIFIED";
          err.message += ". Reconnect the terminal to verify the host key before transferring files.";
        }
        throw err;
      } finally {
        payload.abortSignal?.removeEventListener("abort", abort);
        session.stream?.removeListener?.("close", abort);
        session.conn?.removeListener?.("close", abort);
      }
    },
  });
}

module.exports = { attachSessionSftpDial };
