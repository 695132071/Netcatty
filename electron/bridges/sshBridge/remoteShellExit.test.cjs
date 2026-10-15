const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRemoteShellExitPayload,
  classifyRemoteShellClose,
  normalizeRemoteExitSignal,
} = require("./remoteShellExit.cjs");

test("normalizeRemoteExitSignal keeps a reported signal and drops empty values", () => {
  assert.equal(normalizeRemoteExitSignal("SIGHUP"), "SIGHUP");
  assert.equal(normalizeRemoteExitSignal("SIGUSR2"), "SIGUSR2");
  assert.equal(normalizeRemoteExitSignal(""), null);
  assert.equal(normalizeRemoteExitSignal(null), null);
  assert.equal(normalizeRemoteExitSignal(undefined), null);
});

test("an exit-signal is an administrative signaled close, not a transport close", () => {
  for (const exitSignal of ["SIGHUP", "SIGTERM", "SIGUSR2"]) {
    assert.equal(
      classifyRemoteShellClose({ idleTimedOut: false, exitSignal, shellExited: false }),
      "signaled",
    );
  }
});

test("a channel close without exit-status or exit-signal stays closed", () => {
  assert.equal(
    classifyRemoteShellClose({ idleTimedOut: false, exitSignal: null, shellExited: false }),
    "closed",
  );
});

test("a numeric shell exit stays exited, and a TMOUT banner stays timeout", () => {
  assert.equal(
    classifyRemoteShellClose({ idleTimedOut: false, exitSignal: null, shellExited: true }),
    "exited",
  );
  assert.equal(
    classifyRemoteShellClose({ idleTimedOut: true, exitSignal: null, shellExited: true }),
    "timeout",
  );
});

test("an exit-signal payload reports the signal and does not invent an exit code", () => {
  const payload = buildRemoteShellExitPayload({
    sessionId: "signal-exit",
    generation: 3,
    exitSignal: "SIGUSR2",
    shellExited: false,
    idleTimedOut: false,
  });

  assert.equal(payload.reason, "signaled");
  assert.equal(payload.exitSignal, "SIGUSR2");
  assert.equal(payload.exitCode, undefined);
  assert.equal(payload.remoteClosedWithoutExitStatus, undefined);
  assert.equal(payload._terminalSessionGeneration, 3);
});

test("a bare channel-close payload stays a reconnectable transport close", () => {
  const payload = buildRemoteShellExitPayload({
    sessionId: "transport-close",
    exitSignal: null,
    shellExited: false,
    idleTimedOut: false,
  });

  assert.equal(payload.reason, "closed");
  assert.equal(payload.exitSignal, undefined);
  assert.equal(payload.exitCode, undefined);
  assert.equal(payload.remoteClosedWithoutExitStatus, true);
});
