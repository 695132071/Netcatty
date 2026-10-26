"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PluginAIContextService } = require("./aiContextService.cjs");

function fixture() {
  let current = true; let allowed = true; let reviewed = true; let sourceId = "source-a"; let revoke; let invoked = 0; let reads = 0;
  const authorizations = [];
  const context = { pluginId: "com.example.ai", runtimeId: "r", pluginVersion: "1", assertActive: async () => {} };
  const source = () => ({ id: sourceId, kind: "third-party", origin: "https://source.example" });
  const database = { getActivePlugin: () => ({ source: source(), enabled: true, activeVersion: "1", runtime: { status: "running" } }),
    getRetainedPluginSource: source, privateOwner: () => `opaque-${sourceId}`, publicPluginId: () => context.pluginId };
  const hostAdapter = { assertActive: async () => {},
    selectModel: async () => ({ label: "Synthetic", isCurrent: () => current, invoke: () => { invoked++; return (async function* () { yield { kind: "text", text: "Result" }; })(); } }),
    listSelected: async () => [{ key: "selected-note", scope: "note", title: "Synthetic", version: "1", isCurrent: () => current, readText: () => { reads++; return "Synthetic body"; } }],
    reviewText: async () => reviewed,
  };
  const permissionEngine = { onDidRevoke: (listener) => { revoke = listener; return { dispose() {} }; },
    authorize: async (_context, authorization) => { authorizations.push(authorization); if (!allowed) throw Error("Denied"); } };
  const service = new PluginAIContextService({ database, permissionEngine, hostAdapter, getRuntimeIdentity: () => ({ ...context, runtimeKind: "browser" }) });
  return { service, context, hostAdapter, authorizations, invoked: () => invoked, reads: () => reads,
    allow: (v) => { allowed = v; }, review: (v) => { reviewed = v; }, current: (v) => { current = v; }, source: (v) => { sourceId = v; }, revoke: () => revoke({ pluginId: context.pluginId }) };
}

test("model invocation independently requests content permission and reviewed text", async (t) => {
  const f = fixture(); t.after(() => f.service.shutdown());
  const { items: [reference] } = await f.service.list({}, f.context); assert.equal(f.reads(), 0);
  const chat = await f.service.open({}, f.context);
  f.allow(false);
  await assert.rejects(f.service.start({ chatHandle: chat.chatHandle, prompt: "Hi", contexts: [{ handle: reference.handle, version: reference.version }] }, f.context));
  assert.equal(f.reads(), 0); assert.equal(f.invoked(), 0);
  f.allow(true); f.review(false);
  await assert.rejects(f.service.start({ chatHandle: chat.chatHandle, prompt: "Hi", contexts: [{ handle: reference.handle, version: reference.version }] }, f.context));
  assert.equal(f.invoked(), 0);
  f.review(true);
  const turn = await f.service.start({ chatHandle: chat.chatHandle, prompt: "Hi", contexts: [{ handle: reference.handle, version: reference.version }] }, f.context);
  assert.equal((await f.service.read(turn, f.context)).text, "Result");
  assert.ok(f.authorizations.every((authorization) => authorization.permission === "context.selected.read" && authorization.allowedScopes[0] === "once"));
});

test("source change during host review suppresses text and inference", async (t) => {
  const f = fixture(); t.after(() => f.service.shutdown());
  const { items: [reference] } = await f.service.list({}, f.context); const chat = await f.service.open({}, f.context);
  f.hostAdapter.reviewText = async () => { f.source("source-b"); return true; };
  await assert.rejects(f.service.start({ chatHandle: chat.chatHandle, prompt: "Hi", contexts: [{ handle: reference.handle, version: reference.version }] }, f.context));
  assert.equal(f.invoked(), 0);
});

test("permission revocation clears all handles for the plugin, including chats without context", async (t) => {
  const f = fixture(); t.after(() => f.service.shutdown());
  await f.service.list({}, f.context); const chat = await f.service.open({}, f.context);
  const turn = await f.service.start({ chatHandle: chat.chatHandle, prompt: "Hi" }, f.context);
  f.revoke(); assert.equal(f.service.broker.turns.size, 0); assert.equal(f.service.selected.handles.size, 0);
  await assert.rejects(f.service.read(turn, f.context));
});
