"use strict";

// An abandoned OPEN cannot be cancelled in SSH, but its physical connection
// may own unrelated terminals. Hold further opens until the late callback,
// transport closure, or a short abandon wait. If the callback never arrives,
// force-clear the gate and admit a new open; the late channel is still closed
// when its callback finally fires. Do not queue unbounded SSH channel requests
// during the wait.
const abandonedOpens = new WeakMap();

function wakeAbandonedWaiters(state) {
  const waiters = state?.waiters;
  if (!waiters || waiters.size === 0) return;
  state.waiters = new Set();
  for (const wake of waiters) {
    try { wake(); } catch { /* ignore */ }
  }
}

function abandonOpen(client, token) {
  let state = abandonedOpens.get(client);
  if (!state) {
    state = { tokens: new Set(), onClose: null, waiters: new Set() };
    state.onClose = () => {
      if (abandonedOpens.get(client) === state) abandonedOpens.delete(client);
      state.tokens.clear();
      wakeAbandonedWaiters(state);
    };
    abandonedOpens.set(client, state);
    client.once?.("close", state.onClose);
  }
  state.tokens.add(token);
}

function settleAbandonedOpen(client, token) {
  const state = abandonedOpens.get(client);
  if (!state || !state.tokens.delete(token) || state.tokens.size > 0) return;
  abandonedOpens.delete(client);
  client.removeListener?.("close", state.onClose);
  wakeAbandonedWaiters(state);
}

function forceClearAbandonedOpens(client) {
  const state = abandonedOpens.get(client);
  if (!state) return;
  abandonedOpens.delete(client);
  state.tokens.clear();
  try { client.removeListener?.("close", state.onClose); } catch { /* ignore */ }
  wakeAbandonedWaiters(state);
}

const DEFAULT_SFTP_CHANNEL_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_SFTP_CHANNEL_ABANDON_WAIT_MS = 2_000;

function resolveAbandonWaitMs(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_SFTP_CHANNEL_ABANDON_WAIT_MS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SFTP_CHANNEL_ABANDON_WAIT_MS;
  return Math.max(0, parsed);
}

function closeSftpChannel(channel) {
  if (!channel) return;
  try { channel.once?.("error", () => {}); } catch { /* ignore */ }
  try { channel.end?.(); } catch { /* ignore */ }
  try { channel.close?.(); } catch { /* ignore */ }
  try { channel.destroy?.(); } catch { /* ignore */ }
}

function createSftpOpenAbortError(signal) {
  const reason = signal?.reason;
  const error = reason instanceof Error ? reason : new Error("SFTP channel open was aborted");
  if (!error.code) error.code = "ABORT_ERR";
  return error;
}

function createPendingOpenError() {
  const error = new Error("A previous SFTP channel open is still pending on this connection");
  error.code = "SFTP_CHANNEL_OPEN_PENDING";
  return error;
}

function waitForAbandonedOpenAdmission(sshClient, options) {
  const state = abandonedOpens.get(sshClient);
  if (!state) return Promise.resolve();
  const abandonWaitMs = resolveAbandonWaitMs(options.abandonWaitMs);
  // A zero wait keeps the historical immediate rejection for callers that must
  // not block, and still lets upload fallback treat PENDING as a poisoned open.
  if (abandonWaitMs === 0) return Promise.reject(createPendingOpenError());

  const signal = options.signal || null;
  if (signal?.aborted) return Promise.reject(createSftpOpenAbortError(signal));
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      state.waiters?.delete(onGateCleared);
      if (timer) clearTimeoutFn(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onGateCleared = () => finish();
    const onAbort = () => finish(createSftpOpenAbortError(signal));

    if (!state.waiters) state.waiters = new Set();
    state.waiters.add(onGateCleared);
    if (abandonedOpens.get(sshClient) !== state) {
      finish();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) {
      finish(createSftpOpenAbortError(signal));
      return;
    }
    // Referenced on purpose: an unreferenced timer can let Node exit while
    // this admission promise is still pending.
    timer = setTimeoutFn(() => {
      if (abandonedOpens.get(sshClient) === state) forceClearAbandonedOpens(sshClient);
      finish();
    }, abandonWaitMs);
  });
}

function startBoundedSftpOpen(sshClient, options) {
  const signal = options.signal || null;
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const timeoutMs = Math.max(
    1,
    Number(options.timeoutMs) || DEFAULT_SFTP_CHANNEL_OPEN_TIMEOUT_MS,
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let requestPending = false;
    const token = Symbol("sftp-open");
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeoutFn(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (error, channel = null, { abandon = false } = {}) => {
      if (settled) {
        closeSftpChannel(channel);
        return false;
      }
      settled = true;
      cleanup();
      if (error && channel) closeSftpChannel(channel);
      if (abandon && requestPending) abandonOpen(sshClient, token);
      if (error) reject(error);
      else resolve(channel);
      return true;
    };
    const onAbort = () => finish(createSftpOpenAbortError(signal), null, {
      abandon: true,
    });

    if (signal?.aborted) {
      finish(createSftpOpenAbortError(signal));
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    // Keep the correctness deadline referenced until the open settles. An
    // unreferenced timer can let Node exit with this promise still pending.
    timer = setTimeoutFn(() => {
      const error = new Error(`SFTP channel open timed out after ${timeoutMs}ms`);
      error.code = "SFTP_CHANNEL_OPEN_TIMEOUT";
      finish(error, null, { abandon: true });
    }, timeoutMs);

    try {
      requestPending = true;
      sshClient.sftp((error, channel) => {
        requestPending = false;
        settleAbandonedOpen(sshClient, token);
        if (error) finish(error, channel || null);
        else finish(null, channel || null);
      });
    } catch (error) {
      requestPending = false;
      settleAbandonedOpen(sshClient, token);
      finish(error);
    }
  });
}

function openBoundedSftpChannel(sshClient, options = {}) {
  if (!sshClient || typeof sshClient.sftp !== "function") {
    return Promise.resolve(null);
  }
  const signal = options.signal || null;
  if (signal?.aborted) return Promise.reject(createSftpOpenAbortError(signal));
  if (!abandonedOpens.has(sshClient)) {
    return startBoundedSftpOpen(sshClient, options);
  }
  return waitForAbandonedOpenAdmission(sshClient, options).then(() => (
    openBoundedSftpChannel(sshClient, options)
  ));
}

module.exports = {
  DEFAULT_SFTP_CHANNEL_ABANDON_WAIT_MS,
  DEFAULT_SFTP_CHANNEL_OPEN_TIMEOUT_MS,
  closeSftpChannel,
  openBoundedSftpChannel,
};
