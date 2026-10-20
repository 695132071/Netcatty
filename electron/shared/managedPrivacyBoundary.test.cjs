"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createAiPrivacyService } = require("./aiPrivacyService.cjs");
const { createManagedPrivacyBoundary } = require("./managedPrivacyBoundary.cjs");

test("managed prompt, MCP and CLI share a chat map, restoring before dispatch", async () => {
  const privacy = createAiPrivacyService();
  privacy.configure({ enabled: true });
  const prompt = privacy.redact("chat-one", "Investigate address=192.0.2.12");
  const token = prompt.match(/\[NC_[^\]]+\]/)[0];
  const calls = [];
  const rpc = createManagedPrivacyBoundary(async (method, params) => {
    calls.push({ method, params });
    return { ok: true, stdout: params.command || "address=192.0.2.12" };
  }, privacy);
  const result = await rpc("netcatty/exec", { chatSessionId: "chat-one", command: `echo ${token}` });
  assert.equal(calls[0].params.command, "echo 192.0.2.12");
  assert.equal(result.stdout, `echo ${token}`);
  assert.equal((await rpc("netcatty/read", { chatSessionId: "chat-one" })).stdout, `address=${token}`);
  await assert.rejects(rpc("netcatty/exec", { chatSessionId: "chat-two", command: `echo ${token}` }));
  assert.equal(calls.length, 2);
});

test("managed privacy fails closed on missing scope, changed policy, errors and binary content", async () => {
  const privacy = createAiPrivacyService();
  privacy.configure({ enabled: true });
  const errorRpc = createManagedPrivacyBoundary(async () => { throw new Error("address=192.0.2.1"); }, privacy);
  await assert.rejects(errorRpc("read", {}), /chat session/);
  await assert.rejects(errorRpc("read", { chatSessionId: "chat" }), (error) => !error.message.includes("192.0.2.1"));
  const binaryRpc = createManagedPrivacyBoundary(async () => ({ base64Data: "YmluYXJ5" }), privacy);
  await assert.rejects(binaryRpc("read", { chatSessionId: "chat" }));
  const textRpc = createManagedPrivacyBoundary(async () => ({ text: "192.0.2.1", base64Data: "duplicate" }), privacy);
  const result = await textRpc("netcatty/readAttachment", { chatSessionId: "chat" });
  assert.equal(result.base64Data, undefined);
  assert.doesNotMatch(result.text, /192\.0\.2\.1/);
  privacy.configure({ enabled: false });
  await assert.rejects(textRpc("read", { chatSessionId: "chat" }));
});

test("disabled managed privacy preserves ordinary unscoped CLI calls", async () => {
  const privacy = createAiPrivacyService();
  const result = { ok: true, stdout: "192.0.2.1" };
  const rpc = createManagedPrivacyBoundary(async () => result, privacy);
  assert.equal(await rpc("read", {}), result);
});
