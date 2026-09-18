import assert from "node:assert/strict";
import test from "node:test";

import { isTerminalReportSequence } from "./terminalReportSequence";

test("classifies automatic terminal-report replies as reports", () => {
  assert.equal(isTerminalReportSequence("\x1b[?1;2c"), true); // DA1 reply
  assert.equal(isTerminalReportSequence("\x1b[>0;95;0c"), true); // DA2 reply
  assert.equal(isTerminalReportSequence("\x1b[12;34R"), true); // CPR reply
  assert.equal(isTerminalReportSequence("\x1b[?12;34R"), true); // DECXCPR reply
  assert.equal(isTerminalReportSequence("\x1b[0n"), true); // DSR reply
  assert.equal(isTerminalReportSequence("\x1b[?62;1;2;6;9;15;22c"), true);
  assert.equal(isTerminalReportSequence("\x1b[I"), true);
  assert.equal(isTerminalReportSequence("\x1b[O"), true);
  assert.equal(isTerminalReportSequence("\x1b[?1u"), true); // Kitty query reply
  assert.equal(isTerminalReportSequence("\x1b[2;1$y"), true); // DECRPM reply
  assert.equal(isTerminalReportSequence("\x1b[8;24;80t"), true);
  assert.equal(isTerminalReportSequence("\x1b]11;rgb:0c/0c/0c\x07"), true);
  assert.equal(isTerminalReportSequence("\x1bP0!r\x1b\\"), true); // DCS reply
});

test("does not classify typed text or submit keys as reports", () => {
  assert.equal(isTerminalReportSequence("enable"), false);
  assert.equal(isTerminalReportSequence("\r"), false);
  assert.equal(isTerminalReportSequence("\n"), false);
  assert.equal(isTerminalReportSequence("\x03"), false);
  assert.equal(isTerminalReportSequence("\x7f"), false);
  assert.equal(isTerminalReportSequence("\x1b[A"), false); // Arrow key
  assert.equal(isTerminalReportSequence("\x1b[200~pasted\x1b[201~"), false);
  assert.equal(isTerminalReportSequence(""), false);
});
