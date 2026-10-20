"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPrivacyBoundary } = require("./externalMcpPrivacyBoundary.cjs");

const enabled = { enabled: true };

test("restores before dispatch and masks structured results and errors", async () => {
  const calls = [];
  const boundary = createPrivacyBoundary(async (method, args) => {
    calls.push(args);
    if (method === "error") throw new Error("Connection to 192.0.2.10 failed");
    return { ok: true, text: "server=192.0.2.10", nested: { password: 'fake-quote"\\secret' } };
  }, () => enabled);
  const result = await boundary("read", {});
  assert.doesNotMatch(JSON.stringify(result), /192\.0\.2\.10|fake-quote/);
  await boundary("write", { command: result.text, content: result.nested.password });
  assert.equal(calls[1].command, "server=192.0.2.10");
  assert.equal(calls[1].content, 'fake-quote"\\secret');
  await assert.rejects(boundary("error", {}), error => !error.message.includes("192.0.2.10"));
});

test("unknown and cross-session tokens never reach dispatch", async () => {
  let calls = 0;
  const one = createPrivacyBoundary(async () => ({ text: "192.0.2.10" }), () => enabled);
  const two = createPrivacyBoundary(async () => { calls++; return {}; }, () => enabled);
  const result = await one("read", {});
  await assert.rejects(two("write", { content: result.text }));
  assert.equal(calls, 0);
});

test("configuration changes require reconnect, including disabling", async () => {
  let config = enabled;
  let calls = 0;
  const boundary = createPrivacyBoundary(async () => { calls++; return {}; }, () => config);
  await boundary("read", {});
  config = { enabled: false };
  await assert.rejects(boundary("read", {}), /Reconnect/);
  assert.equal(calls, 1);
});

test("configuration changes while an operation runs cannot leak its result", async () => {
  let config = enabled;
  const boundary = createPrivacyBoundary(async () => {
    config = { enabled: false };
    return { text: "192.0.2.10" };
  }, () => config);
  await assert.rejects(boundary("read", {}), /Reconnect/);
});

test("unavailable/invalid policy fails closed before dispatch without echoing rules", async () => {
  let calls = 0;
  for (const getConfig of [() => { throw new Error("sensitive-path"); }, () => ({ patterns: ["["] })]) {
    const boundary = createPrivacyBoundary(async () => { calls++; }, getConfig);
    await assert.rejects(boundary("read", {}), error => /configuration/.test(error.message) && !error.message.includes("sensitive-path"));
  }
  assert.equal(calls, 0);
});

test("disabled mode remains byte-for-byte compatible", async () => {
  const source = { text: "192.0.2.10", base64Data: "YmluYXJ5" };
  let received;
  const boundary = createPrivacyBoundary(async (_, params) => { received = params; return source; }, () => undefined);
  const args = { content: "unchanged" };
  assert.equal(await boundary("read", args), source);
  assert.equal(received, args);
});


test("text attachments omit the encoded duplicate but binary-only attachments fail closed", async () => {
  let binary = false;
  const boundary = createPrivacyBoundary(async () => ({
    ok: true, filePath: undefined, base64Data: "MTkyLjAuMi4xMA==",
    ...(binary ? {} : { text: "192.0.2.10" }),
  }), () => enabled);
  const result = await boundary("netcatty/readAttachment", { filename: "synthetic.txt", filePath: undefined });
  assert.equal(Object.hasOwn(result, "base64Data"), false);
  assert.doesNotMatch(result.text, /192\.0\.2\.10/);
  binary = true;
  await assert.rejects(boundary("netcatty/readAttachment", { filename: "synthetic.png" }));
});


test("RPC control keys survive a matching secret value so terminal formatting retains output", async () => {
  const { formatTerminalExecuteMcpResponse } = require("../capabilities/codegen/mcpToolRegistry.cjs");
  const boundary = createPrivacyBoundary(async () => ({ ok: true, stdout: "password=stdout\nimportant output", exitCode: 0 }), () => enabled);
  const response = formatTerminalExecuteMcpResponse(await boundary("netcatty/exec", {}));
  assert.match(response.content[0].text, /important output/);
  assert.doesNotMatch(response.content[0].text, /password=stdout/);
});
