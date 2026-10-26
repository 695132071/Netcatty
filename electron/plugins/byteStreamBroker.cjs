"use strict";

// Host-only transport core. Public RPC/SDK wiring awaits the shared contract
// checkpoint. No protocol, credential lookup, or plugin-supplied Node runs here.
const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns/promises");
const { randomUUID } = require("node:crypto");
const { PluginRpcError, RPC_ERRORS, raceWithAbort } = require("./rpcRouter.cjs");

const LIMITS = Object.freeze({
  connectionsPerRuntime: 4,
  connectionsTotal: 64,
  chunkBytes: 64 * 1024,
  bufferBytes: 64 * 1024,
  connectionBytes: 8 * 1024 * 1024,
  connectMs: 10_000,
  idleMs: 30_000,
  lifetimeMs: 120_000,
});

function failure(code, message) { return new PluginRpcError(RPC_ERRORS[code], message); }

function canonicalizeStreamEndpoint(value) {
  if (typeof value !== "string" || value.length > 512) {
    throw failure("invalidArgument", "Byte stream endpoint is invalid");
  }
  // URL's permissive non-special scheme parser accepts paths, userinfo, and
  // alternate IPv4 spellings. Require a complete unambiguous authority instead.
  const match = /^(tcp|tls):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/u.exec(value);
  if (!match) throw failure("invalidArgument", "Byte streams require an exact TCP or TLS host and port");
  let host = match[2].toLowerCase();
  const port = Number(match[3]);
  if (port < 1 || port > 65535 || String(port) !== match[3]) {
    throw failure("invalidArgument", "Byte stream port is invalid");
  }
  if (host.startsWith("[")) {
    host = host.slice(1, -1);
    if (net.isIP(host) !== 6) throw failure("invalidArgument", "Byte stream IPv6 address is invalid");
    host = new URL(`http://[${host}]`).hostname.slice(1, -1);
  } else if (!net.isIP(host)) {
    if (host.length > 253 || /^[0-9.]+$/u.test(host) || host.split(".").some((label) => (
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)
    ))) throw failure("invalidArgument", "Byte stream hostname is invalid");
  }
  return Object.freeze({
    endpoint: `${match[1]}://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`,
    transport: match[1], host, port,
  });
}

function isLocalControlAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254);
  }
  if (net.isIP(address) !== 6) return true;
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  if (canonical.startsWith("::ffff:")) {
    const words = canonical.slice(7).split(":");
    const n = (parseInt(words[0], 16) * 65536) + parseInt(words[1], 16);
    return isLocalControlAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  // Also exclude compatible/tunnel addresses that can obscure a local IPv4 peer.
  return canonical.startsWith("::") || canonical.startsWith("ff")
    || /^fe[89ab]/u.test(canonical) || canonical.startsWith("2002:")
    || canonical.startsWith("2001:0:");
}

class PluginByteStreamBroker {
  constructor(options) {
    this.permissionEngine = options.permissionEngine;
    this.quotaManager = options.quotaManager;
    this.audit = options.audit ?? (() => {});
    this.lookup = options.lookup ?? dns.lookup;
    this.connectSocket = options.connectSocket ?? ((params) => net.createConnection(params));
    this.connectTls = options.connectTls ?? ((params) => tls.connect(params));
    // Only a host test harness can opt a specific loopback endpoint in. The
    // production default excludes all loopback/link-local control surfaces.
    this.testLocalEndpoints = new Set(options.testLocalEndpoints ?? []);
    this.isControlEndpoint = options.isControlEndpoint ?? (() => false);
    this.connections = new Map();
    this.closed = false;
    this.revocation = this.permissionEngine.onDidRevoke((event) => {
      for (const state of this.connections.values()) {
        if (state.pluginId === event.pluginId
          && (event.permission === undefined || event.permission === "network.stream")
          && (event.resource === undefined || event.resource === state.endpoint)) {
          this.finish(state, failure("permissionDenied", "Byte stream permission was revoked"));
        }
      }
    });
  }

  record(state, operation) {
    // Audit only host-observed generic operations, never bytes or peer messages.
    try { this.audit(state.pluginId, `network.stream.${operation}`, {
      runtimeId: state.runtimeId, endpoint: state.endpoint,
      handleId: state.id, bytesRead: state.bytesRead, bytesWritten: state.bytesWritten,
    }); } catch { /* An audit sink cannot keep a revoked socket alive. */ }
  }

  finish(state, reason) {
    if (state.closed) return;
    state.closed = true;
    clearTimeout(state.connectTimer);
    clearTimeout(state.idleTimer);
    clearTimeout(state.lifetimeTimer);
    state.error = reason;
    this.connections.delete(state.id);
    state.controller.abort(reason ?? failure("cancelled", "Byte stream closed"));
    state.socket?.destroy();
    this.record(state, "close");
  }

  touch(state) {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => this.finish(state,
      failure("deadlineExceeded", "Byte stream idle timeout")), LIMITS.idleMs);
    state.idleTimer.unref?.();
  }

  async active(state, context) {
    if (this.closed || state.closed || this.connections.get(state.id) !== state) {
      throw state.error ?? failure("unavailable", "Byte stream is closed");
    }
    await context.assertActive();
    if (state.closed) throw state.error ?? failure("unavailable", "Byte stream is closed");
    state.controller.signal.throwIfAborted();
  }

  async connect(endpoint, context) {
    const target = canonicalizeStreamEndpoint(endpoint);
    if (this.closed) throw failure("unavailable", "Byte stream broker stopped");
    if (!context.runtimeId || !context.pluginId || typeof context.assertActive !== "function") {
      throw failure("unauthenticated", "Byte streams require a host runtime identity");
    }
    const count = [...this.connections.values()].filter((state) => state.runtimeId === context.runtimeId).length;
    if (count >= LIMITS.connectionsPerRuntime || this.connections.size >= LIMITS.connectionsTotal) {
      throw failure("resourceExhausted", "Byte stream connection limit exceeded");
    }
    const state = {
      ...target, id: randomUUID(), pluginId: context.pluginId, runtimeId: context.runtimeId,
      controller: new AbortController(), bytesRead: 0, bytesWritten: 0,
      closed: false, reading: false, writing: false, socket: null,
    };
    this.connections.set(state.id, state);
    const onAbort = () => this.finish(state, failure("cancelled", "Byte stream connection cancelled"));
    context.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.active(state, context);
      await raceWithAbort(Promise.resolve(this.permissionEngine.authorize(context, {
        permission: "network.stream", resources: [target.endpoint],
        reason: `Open byte stream to ${target.endpoint}`,
        operationId: `network.stream:${target.endpoint}`,
      })), state.controller.signal);
      await this.active(state, context);
      state.connectTimer = setTimeout(() => this.finish(state,
        failure("deadlineExceeded", "Byte stream connect timeout")), LIMITS.connectMs);
      const addresses = net.isIP(target.host)
        ? [{ address: target.host, family: net.isIP(target.host) }]
        : await raceWithAbort(Promise.resolve(this.lookup(target.host, { all: true, verbatim: true })), state.controller.signal);
      await this.active(state, context);
      if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 64) {
        throw failure("unavailable", "Byte stream hostname could not be resolved");
      }
      // Validate the whole DNS answer and pin one literal address. No second
      // lookup, redirect, proxy discovery, or reconnect can change the peer.
      for (const peer of addresses) {
        if (![4, 6].includes(peer.family) || net.isIP(peer.address) !== peer.family) {
          throw failure("unavailable", "Byte stream resolver returned an invalid address");
        }
        const local = isLocalControlAddress(peer.address);
        const allowedTestPeer = this.testLocalEndpoints.has(target.endpoint)
          && !this.isControlEndpoint(peer.address, target.port);
        if ((local && !allowedTestPeer) || (!local && this.isControlEndpoint(peer.address, target.port))) {
          throw failure("permissionDenied", "Byte streams cannot reach local or application control endpoints");
        }
      }
      const peer = addresses[0];
      const params = {
        host: peer.address, port: target.port, family: peer.family,
        highWaterMark: LIMITS.bufferBytes,
      };
      if (target.transport === "tls") {
        Object.assign(params, {
          rejectUnauthorized: true, minVersion: "TLSv1.2",
          ...(net.isIP(target.host) ? {} : { servername: target.host }),
          checkServerIdentity: (_name, certificate) => tls.checkServerIdentity(target.host, certificate),
        });
      }
      const socket = target.transport === "tls" ? this.connectTls(params) : this.connectSocket(params);
      state.socket = socket;
      socket.on("error", () => this.finish(state, failure("unavailable", "Byte stream transport failed")));
      socket.on("close", () => this.finish(state,
        state.eof ? undefined : failure("unavailable", "Byte stream transport closed")));
      socket.on("end", () => { state.eof = true; });
      socket.pause();
      await raceWithAbort(new Promise((resolve) => socket.once(
        target.transport === "tls" ? "secureConnect" : "connect", resolve,
      )), state.controller.signal);
      await this.active(state, context);
      if (target.transport === "tls" && !socket.authorized) {
        throw failure("permissionDenied", "Byte stream TLS validation failed");
      }
      clearTimeout(state.connectTimer);
      state.lifetimeTimer = setTimeout(() => this.finish(state,
        failure("deadlineExceeded", "Byte stream lifetime exceeded")), LIMITS.lifetimeMs);
      state.lifetimeTimer.unref?.();
      this.touch(state);
      this.record(state, "open");
      return Object.freeze({ handleId: state.id, endpoint: state.endpoint });
    } catch (error) {
      this.finish(state, error);
      throw error;
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
    }
  }

  get(id, context) {
    const state = this.connections.get(id);
    if (!state || state.pluginId !== context.pluginId || state.runtimeId !== context.runtimeId) {
      throw failure("permissionDenied", "Byte stream handle does not belong to this runtime");
    }
    return state;
  }

  charge(state, direction, size) {
    if (state.bytesRead + state.bytesWritten + size > LIMITS.connectionBytes) {
      throw failure("resourceExhausted", "Byte stream byte limit exceeded");
    }
    this.quotaManager?.chargeBytes(state.runtimeId, "network.stream", size);
    state[direction] += size;
    this.touch(state);
  }

  async read(id, context) {
    const state = this.get(id, context);
    if (state.reading) throw failure("failedPrecondition", "Byte stream has a pending read");
    state.reading = true;
    const onAbort = () => this.finish(state, failure("cancelled", "Byte stream read cancelled"));
    context.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.active(state, context);
      while (true) {
        const available = state.socket.readableLength;
        const bytes = state.socket.read(Math.min(available || LIMITS.chunkBytes, LIMITS.chunkBytes));
        if (bytes !== null) {
          this.charge(state, "bytesRead", bytes.byteLength);
          await this.active(state, context);
          return new Uint8Array(bytes);
        }
        if (state.eof || state.socket.readableEnded) { this.finish(state); return null; }
        await raceWithAbort(new Promise((resolve) => {
          const readable = () => {
            state.socket.off("end", readable);
            state.socket.off("readable", readable);
            state.controller.signal.removeEventListener("abort", readable);
            resolve();
          };
          state.socket.once("readable", readable);
          state.socket.once("end", readable);
          // Remove listeners even when cancellation wins the race.
          state.controller.signal.addEventListener("abort", readable, { once: true });
        }), state.controller.signal);
        await this.active(state, context);
      }
    } catch (error) {
      this.finish(state, error);
      throw error;
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
      state.reading = false;
    }
  }

  async write(id, bytes, context) {
    const state = this.get(id, context);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > LIMITS.chunkBytes) {
      throw failure("invalidArgument", "Byte stream chunk size is invalid");
    }
    if (state.writing) throw failure("resourceExhausted", "Byte stream has a pending write");
    state.writing = true;
    const onAbort = () => this.finish(state, failure("cancelled", "Byte stream write cancelled"));
    context.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.active(state, context);
      this.charge(state, "bytesWritten", bytes.byteLength);
      const owned = Buffer.from(bytes);
      await raceWithAbort(new Promise((resolve, reject) => {
        state.socket.write(owned, (error) => error ? reject(error) : resolve());
      }), state.controller.signal);
      await this.active(state, context);
    } catch (error) {
      this.finish(state, error);
      throw error;
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
      state.writing = false;
    }
  }

  close(id, context) { this.finish(this.get(id, context)); }

  releaseRuntime(runtimeId) {
    for (const state of this.connections.values()) {
      if (state.runtimeId === runtimeId) this.finish(state,
        failure("unavailable", "Byte stream runtime stopped"));
    }
  }

  shutdown() {
    this.closed = true;
    for (const state of this.connections.values()) this.finish(state,
      failure("unavailable", "Byte stream broker stopped"));
    this.revocation.dispose();
  }
}

module.exports = { LIMITS, PluginByteStreamBroker, canonicalizeStreamEndpoint, isLocalControlAddress };
