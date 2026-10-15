import test from "node:test";
import assert from "node:assert/strict";

import {
  formatSessionClosedExitMessage,
  resolveTerminalSessionExitIntent,
  shouldCloseTerminalPopupOnExit,
  shouldRevealTerminalPopupOnExit,
} from "./resolveTerminalSessionExitIntent.ts";

test("backend exited events close the session tab only when auto-close is enabled", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "exited", exitCode: 0 }, true),
    { kind: "closeSession" },
  );
});

test("omitted auto-close setting keeps the session tab on a clean exit", () => {
  // The fallback for callers that have not loaded the terminal setting yet:
  // keep the tab so a jump host / bastion reaping a session (a clean exit)
  // never silently deletes the user's scrollback.
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "exited", exitCode: 0 }),
    { kind: "markDisconnected" },
  );
});

test("disabled auto-close keeps the session tab after a clean exit", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "exited", exitCode: 0 }, false),
    { kind: "markDisconnected" },
  );
});

test("non-zero backend exits keep the tab and mark it disconnected", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "exited", exitCode: 1 }),
    { kind: "markDisconnected" },
  );
});

test("backend exits without a confirmed clean exit code keep the tab", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "exited" }),
    { kind: "markDisconnected" },
  );
});

test("backend timeout events keep the tab and mark it disconnected", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "timeout", error: "idle timeout" }),
    { kind: "markDisconnected" },
  );
});

test("backend error events keep the tab and mark it disconnected", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "error", error: "connection reset" }),
    { kind: "markDisconnected" },
  );
});

test("backend closed events keep the tab and mark it disconnected", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "closed", exitCode: 0 }),
    { kind: "markDisconnected" },
  );
});

test("administrative exit-signal disconnects keep the tab", () => {
  assert.deepEqual(
    resolveTerminalSessionExitIntent({ reason: "signaled", exitSignal: "SIGHUP" }, true),
    { kind: "markDisconnected" },
  );
});

test("terminal popup only auto-closes after clean command exit", () => {
  assert.equal(shouldCloseTerminalPopupOnExit({ reason: "exited", exitCode: 0 }), true);
  assert.equal(shouldCloseTerminalPopupOnExit({ reason: "exited", exitCode: 1 }), false);
  assert.equal(shouldCloseTerminalPopupOnExit({ reason: "error", error: "connection reset" }), false);
  assert.equal(shouldCloseTerminalPopupOnExit({ reason: "closed", exitCode: 0 }), false);
  assert.equal(shouldCloseTerminalPopupOnExit({ reason: "signaled", exitSignal: "SIGHUP" }), false);
});

test("disabled auto-close keeps command and attached terminal popups open", () => {
  assert.equal(
    shouldCloseTerminalPopupOnExit(
      { reason: "exited", exitCode: 0 },
      { autoCloseOnExit: false },
    ),
    false,
  );
  assert.equal(
    shouldCloseTerminalPopupOnExit(
      { reason: "closed", exitCode: 0 },
      { autoCloseOnExit: false, isAttachMode: true },
    ),
    false,
  );
});

test("disabled auto-close reveals every command popup exit instead of reporting startup failure", () => {
  assert.equal(
    shouldRevealTerminalPopupOnExit(
      { reason: "exited", exitCode: 0 },
      { autoCloseOnExit: false },
    ),
    true,
  );
  assert.equal(
    shouldRevealTerminalPopupOnExit(
      { reason: "exited", exitCode: 1 },
      { autoCloseOnExit: false },
    ),
    true,
  );
  assert.equal(
    shouldRevealTerminalPopupOnExit(
      { reason: "exited" },
      { autoCloseOnExit: false },
    ),
    true,
  );
  assert.equal(
    shouldRevealTerminalPopupOnExit(
      { reason: "exited", exitCode: 0 },
      { autoCloseOnExit: false, isAttachMode: true },
    ),
    false,
  );
});

test("attached terminal popups keep their existing auto-close behavior by default", () => {
  assert.equal(
    shouldCloseTerminalPopupOnExit(
      { reason: "closed", exitCode: 0 },
      { isAttachMode: true },
    ),
    true,
  );
});

test("exit messages show the reported code for a real remote exit", () => {
  assert.equal(
    formatSessionClosedExitMessage({ reason: "exited", exitCode: 0 }),
    "\r\n[session closed (code 0)]",
  );
  assert.equal(
    formatSessionClosedExitMessage({ reason: "exited", exitCode: 127 }),
    "\r\n[session closed (code 127)]",
  );
});

test("an administrative exit-signal renders as a remote signal, not a clean code", () => {
  assert.equal(
    formatSessionClosedExitMessage({ reason: "signaled", exitSignal: "SIGHUP" }),
    "\r\n[session closed by remote signal]",
  );
  assert.equal(
    formatSessionClosedExitMessage({ reason: "closed", exitSignal: "SIGTERM" }),
    "\r\n[session closed by remote signal]",
  );
});

test("a channel closed without exit-status or exit-signal must not render as code 0", () => {
  assert.equal(
    formatSessionClosedExitMessage({
      reason: "closed",
      remoteClosedWithoutExitStatus: true,
    }),
    "\r\n[session closed by remote (no exit status)]",
  );
});

test("exit messages without a reported code stay plain instead of showing a sentinel", () => {
  assert.equal(
    formatSessionClosedExitMessage({ reason: "closed" }),
    "\r\n[session closed]",
  );
  assert.equal(formatSessionClosedExitMessage({}), "\r\n[session closed]");
});

test("infrastructure teardowns must not render a numeric code as a clean exit (#3631)", () => {
  // A terminal-worker exit broadcast carries the worker's own exit status
  // (graceful drain = 0). It belongs to the infrastructure failure, not to
  // any remote shell, so it must never read as "session closed (code 0)".
  assert.equal(
    formatSessionClosedExitMessage({
      reason: "error",
      exitCode: 0,
      error: "Terminal worker exited with code 0",
    }),
    "\r\n[session closed unexpectedly]",
  );
  assert.equal(
    formatSessionClosedExitMessage({ reason: "error", exitCode: 1 }),
    "\r\n[session closed unexpectedly]",
  );
  assert.equal(
    formatSessionClosedExitMessage({ reason: "error" }),
    "\r\n[session closed unexpectedly]",
  );
});
