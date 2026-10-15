/**
 * Classify how a remote SSH shell channel ended.
 *
 * An exit-signal (ssh2: code null, signal set) is an administrative
 * termination — idle kick, SIGHUP, SIGTERM — not a VPN/transport flap.
 * Those stay "signaled" so auto-reconnect can leave them alone.
 * A channel that closes with neither exit-status nor exit-signal stays
 * "closed" and is still eligible to reconnect.
 */

function normalizeRemoteExitSignal(signal) {
  return typeof signal === "string" && signal.length > 0 ? signal : null;
}

function classifyRemoteShellClose({ idleTimedOut, exitSignal, shellExited }) {
  if (idleTimedOut) return "timeout";
  const signal = normalizeRemoteExitSignal(exitSignal);
  if (signal) return "signaled";
  if (shellExited) return "exited";
  return "closed";
}

function buildRemoteShellExitPayload({
  sessionId,
  generation,
  exitCode,
  exitSignal,
  shellExited,
  idleTimedOut,
}) {
  const signal = normalizeRemoteExitSignal(exitSignal);
  const reason = classifyRemoteShellClose({
    idleTimedOut: idleTimedOut === true,
    exitSignal: signal,
    shellExited: shellExited === true,
  });
  const payload = {
    sessionId,
    reason,
    _terminalSessionGeneration: generation,
  };
  if (typeof exitCode === "number") {
    payload.exitCode = exitCode;
  } else if (!signal) {
    payload.remoteClosedWithoutExitStatus = true;
  }
  if (signal) {
    payload.exitSignal = signal;
  }
  return payload;
}

module.exports = {
  normalizeRemoteExitSignal,
  classifyRemoteShellClose,
  buildRemoteShellExitPayload,
};
