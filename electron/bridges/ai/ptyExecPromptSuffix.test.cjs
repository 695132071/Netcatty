"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { hasExpectedPromptSuffix } = require("./ptyExecHelpers.cjs");
const { stripAnsi } = require("./shellUtils.cjs");

// The behaviour before the tail window was introduced: normalise the whole
// text, then compare its end.
function referenceHasExpectedPromptSuffix(text, expectedPrompt) {
  if (!expectedPrompt) return false;
  const normalizedText = stripAnsi(String(text || "")).replace(/\r/g, "");
  const normalizedPrompt = stripAnsi(String(expectedPrompt || "")).replace(/\r/g, "");
  return !!normalizedPrompt && normalizedText.endsWith(normalizedPrompt);
}

const COLORED_PROMPT = "\x1b[01;32mroot@3160T\x1b[00m:\x1b[01;34m~\x1b[00m# ";

const CASES = [
  ["plain prompt at the end", "output\r\nroot@3160T:~# ", "root@3160T:~# "],
  ["prompt not at the end", "root@3160T:~# ls\r\nfile\r\n", "root@3160T:~# "],
  ["colored prompt in the text, plain expected", `out\r\n${COLORED_PROMPT}`, "root@3160T:~# "],
  ["colored prompt on both sides", `out\r\n${COLORED_PROMPT}`, COLORED_PROMPT],
  ["carriage returns inside the prompt", "out\r\nroot@3160T:~\r# ", "root@3160T:~# "],
  ["empty text", "", "root@3160T:~# "],
  ["empty expected prompt", "root@3160T:~# ", ""],
  ["null inputs", null, null],
  ["text shorter than the prompt", "~# ", "root@3160T:~# "],
];

for (const [name, text, prompt] of CASES) {
  test(`prompt suffix matches the full-text result: ${name}`, () => {
    assert.equal(hasExpectedPromptSuffix(text, prompt), referenceHasExpectedPromptSuffix(text, prompt));
  });
}

test("prompt suffix is found after a very large flood of CRLF output", () => {
  const flood = "y\r\n".repeat(700_000);
  assert.equal(hasExpectedPromptSuffix(`${flood}root@3160T:~# `, "root@3160T:~# "), true);
  assert.equal(hasExpectedPromptSuffix(`${flood}root@3160T:~# x`, "root@3160T:~# "), false);
  assert.equal(hasExpectedPromptSuffix(`${flood}${COLORED_PROMPT}`, "root@3160T:~# "), true);
});

test("prompt suffix check does not scan the whole buffer on every call", () => {
  // 2M characters of CRLF output used to cost seconds per call because every
  // call stripped ANSI and carriage returns over the entire text.
  const flood = "y\r\n".repeat(700_000);
  const started = process.hrtime.bigint();
  for (let i = 0; i < 50; i += 1) hasExpectedPromptSuffix(flood, "root@3160T:~# ");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `50 checks took ${elapsedMs.toFixed(0)} ms`);
});
