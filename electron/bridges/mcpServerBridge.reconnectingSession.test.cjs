"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { isolateCliDiscoveryFile } = require("./cliDiscoveryTestIsolation.cjs");
isolateCliDiscoveryFile();

function loadFreshBridge() {
  const bridgePath = require.resolve("./mcpServerBridge.cjs");
  delete require.cache[bridgePath];
  return require("./mcpServerBridge.cjs");
}

function setup(t, { sessions } = {}) {
  const bridge = loadFreshBridge();
  t.after(() => bridge.cleanup());
  bridge.init({ sessions: sessions || new Map(), electronModule: null });
  bridge.setPermissionMode("auto");
  return bridge;
}

test('reusing a user tab adds visibility without ownership or idle tracking', async (t) => {
  const bridge = setup(t);
  bridge.setVaultAgentInvoker(async () => ({ ok: true, reused: true, sessionId: 'user-tab', hostId: 'host-b', status: 'connected' }));
  await bridge.dispatchBuiltinRpc('public/vault/hosts/open', { chatSessionId: 'chat-b', hostId: 'host-b' });
  assert.deepEqual(bridge.getScopedSessionIds('chat-b'), ['user-tab']);
  assert.equal(bridge.reportOpenedSessionActivity({ sessionId: 'user-tab', phase: 'touch' }), false);
  const close = await bridge.dispatchBuiltinRpc('public/session/close', { chatSessionId: 'chat-b', sessionId: 'user-tab' });
  assert.equal(close.ok, false);
  assert.match(close.error, /not opened by the current AI scope/);
});

test('reuse keeps the original chat owner and its idle tracking', async (t) => {
  const bridge = setup(t);
  const calls = [];
  bridge.setVaultAgentInvoker(async (op, params) => {
    calls.push({ op, params });
    if (op === 'session.close') return { ok: true };
    return { ok: true, reused: params.chatSessionId !== 'owner', sessionId: 'shared-tab', hostId: 'host-b', status: 'connected' };
  });
  for (const chatSessionId of ['owner', 'borrower']) {
    await bridge.dispatchBuiltinRpc('public/vault/hosts/open', { chatSessionId, hostId: 'host-b' });
  }
  assert.equal(bridge.reportOpenedSessionActivity({ sessionId: 'shared-tab', phase: 'touch' }), true);
  assert.equal((await bridge.dispatchBuiltinRpc('public/session/close', { chatSessionId: 'borrower', sessionId: 'shared-tab' })).ok, false);
  assert.equal((await bridge.dispatchBuiltinRpc('public/session/close', { chatSessionId: 'owner', sessionId: 'shared-tab' })).ok, true);
  assert.equal(calls.filter(({ op }) => op === 'session.close').length, 1);
});

test('a deleted chat cannot reclaim a reused tab or revive its own scope', async (t) => {
  const bridge = setup(t);
  let finishOpen;
  const calls = [];
  bridge.updateSessionMetadata([{ sessionId: 'user-tab', connected: true }], 'original');
  bridge.setVaultAgentInvoker((op) => {
    calls.push(op);
    return new Promise((resolve) => { finishOpen = resolve; });
  });
  const opening = bridge.dispatchBuiltinRpc('public/vault/hosts/open', { chatSessionId: 'deleted', hostId: 'host-b' });
  await bridge.cleanupScopedMetadata('deleted');
  bridge.mergeSessionMetadata([{ sessionId: 'user-tab', connected: true }], 'deleted');
  finishOpen({ ok: true, reused: true, sessionId: 'user-tab', status: 'connected' });
  const rejected = await opening;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'SESSION_SCOPE_BIND_FAILED');
  assert.equal(rejected.sessionId, 'user-tab');
  assert.deepEqual(calls, ['host.open']);
  assert.deepEqual(bridge.getScopedSessionIds('deleted'), []);
  assert.deepEqual(bridge.getScopedSessionIds('original'), ['user-tab']);
  assert.equal(bridge.reportOpenedSessionActivity({ sessionId: 'user-tab', phase: 'touch' }), false);
});

test("getContext keeps a scoped disconnected session visible with connected:false", async (t) => {
  const bridge = setup(t);
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-reconnecting",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: true,
      hostId: "host-b",
      protocol: "ssh",
    },
  ], "chat-1");
  // Connection dropped: renderer pushes connected:false while the tab
  // auto-reconnects. The scope keeps the same sessionId.
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-reconnecting",
      hostname: "10.0.0.2",
      label: "server-b",
      connected: false,
      hostId: "host-b",
      protocol: "ssh",
    },
  ], "chat-1");

  const environment = await bridge.dispatchBuiltinRpc("netcatty/getContext", {
    chatSessionId: "chat-1",
  });
  const host = environment.hosts.find((entry) => entry.sessionId === "sess-reconnecting");
  assert.ok(host, "reconnecting session must stay visible to the agent");
  assert.equal(host.connected, false);
});

test("getContext keeps a live-map session without transport visible when scoped", async (t) => {
  const bridge = setup(t, {
    sessions: new Map([["sess-live", { hostname: "10.0.0.3", label: "server-c" }]]),
  });
  bridge.updateSessionMetadata([
    {
      sessionId: "sess-live",
      hostname: "10.0.0.3",
      label: "server-c",
      connected: false,
      hostId: "host-c",
      protocol: "ssh",
    },
  ], "chat-1");

  const environment = await bridge.dispatchBuiltinRpc("netcatty/getContext", {
    chatSessionId: "chat-1",
  });
  const host = environment.hosts.find((entry) => entry.sessionId === "sess-live");
  assert.ok(host, "reconnecting live-map session must stay visible");
  assert.equal(host.connected, false);
});

test("getContext still hides disconnected sessions outside the agent scope", async (t) => {
  const bridge = setup(t);
  bridge.updateSessionMetadata([
    {
      sessionId: "foreign",
      hostname: "10.0.0.9",
      label: "foreign",
      connected: false,
      hostId: "host-x",
      protocol: "ssh",
    },
  ], "chat-other");

  const environment = await bridge.dispatchBuiltinRpc("netcatty/getContext", {
    chatSessionId: "chat-1",
  });
  assert.equal(environment.hosts.length, 0);
});

test("external context preserves reconnecting metadata beside another live transport", async (t) => {
  const bridge = setup(t, { sessions: new Map([["online", { hostname: "online", stream: { write() {} } }]]) });
  const scope = bridge.EXTERNAL_MCP_CHAT_SESSION_ID;
  bridge.setExternalMcpHooks({ isEnabled: () => true });
  bridge.updateSessionMetadata([
    { sessionId: "online", hostname: "online", connected: true },
    { sessionId: "retrying", hostname: "retrying", connected: false },
  ], scope);
  const context = await bridge.dispatchBuiltinRpc("netcatty/getContext", { chatSessionId: scope });
  assert.equal(context.hostCount, 2);
  assert.equal(context.hosts.find(host => host.sessionId === "retrying")?.connected, false);
  assert.equal(context.hosts.find(host => host.sessionId === "online")?.connected, true);
  // A renderer-authoritative removal must still remove the closed tab.
  bridge.updateSessionMetadata([{ sessionId: "online", connected: true }], scope);
  const afterClose = await bridge.dispatchBuiltinRpc("netcatty/getContext", { chatSessionId: scope });
  assert.deepEqual(afterClose.hosts.map(host => host.sessionId), ["online"]);
});
