"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DelegatedAgentScopes } = require("./delegatedScope.cjs");
const { PluginAISourceBinding } = require("../ai/sourceBinding.cjs");

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

function fixture() {
  let time = 1; let locked = false; let focus = "terminal-a";
  let source = { id: "source-a", kind: "third-party", origin: "https://example.invalid" };
  let privateOwner = "source:opaque-owner-a:com.example.assistant";
  let identity = { pluginId: "com.example.assistant", pluginVersion: "1", runtimeId: "r1", runtimeKind: "browser" };
  let authorize = async () => {};
  const context = { ...identity, assertActive: async () => {} };
  const database = {
    getActivePlugin: () => ({ source, enabled: true, activeVersion: "1", runtime: { status: "running" } }),
    getRetainedPluginSource: () => source,
    privateOwner: () => privateOwner,
    publicPluginId: (value) => value === privateOwner ? identity.pluginId : null,
  };
  const binding = new PluginAISourceBinding({ database, getRuntimeIdentity: () => identity });
  let backendRevision = "configured-1";
  const currentTargets = new Map([
    ["terminal-a", { owner: "window-1", revision: "session-a-v1" }],
    ["terminal-b", { owner: "window-2", revision: "session-b-v1" }],
  ]);
  const backend = { key: "host-configured-claude", revision: backendRevision,
    isCurrent: (snapshot) => snapshot.revision === backendRevision };
  const target = (id) => ({ kind: "terminal", id, ...currentTargets.get(id),
    isCurrent: (snapshot) => { const current = currentTargets.get(snapshot.id);
      return current?.owner === snapshot.owner && current?.revision === snapshot.revision; } });
  const scopes = new DelegatedAgentScopes({ resolveOwner: (ctx) => binding.resolve(ctx),
    assertHostActive: async () => { if (locked) throw Error("Locked"); },
    authorizeAction: (...args) => authorize(...args), clock: () => time });
  return { scopes, context, target, targets: currentTargets,
    issue: (targets = [target("terminal-a"), target("terminal-b")]) => scopes.issue(context,
      { backend, targets, capabilities: ["terminal.execute", "session.environment"] }),
    action: (id = "terminal-a") => ({ capabilityId: "terminal.execute", targets: [target(id)] }),
    tick: (ms) => { time += ms; }, lock: () => { locked = true; scopes.releaseAll(); },
    focusTo: (id) => { focus = id; }, focus: () => focus,
    authorize: (fn) => { authorize = fn; }, backendTo: (value) => { backendRevision = value; },
    replaceSource: () => { source = { ...source, id: "source-b" }; privateOwner = "source:opaque-owner-b:com.example.assistant"; },
    runtimeTo: (id) => { identity = { ...identity, runtimeId: id }; },
  };
}

test("host-issued scope exposes only opaque identity and expiry; cross-workspace focus does not change explicit targets", async () => {
  const f = fixture(); const ref = await f.issue();
  assert.deepEqual(Object.keys(ref).sort(), ["expiresAt", "handle"]);
  assert.doesNotMatch(JSON.stringify(ref), /window-|terminal-|source:|configured/);
  const ticket = await f.scopes.begin(ref.handle, f.context);
  f.focusTo("unselected-terminal");
  let calls = 0;
  assert.equal(await f.scopes.dispatch(ticket, f.context, f.action("terminal-b"), async () => ++calls), 1);
  assert.equal(f.focus(), "unselected-terminal");
  await assert.rejects(f.scopes.dispatch(ticket, f.context,
    { capabilityId: "terminal.execute", targets: [{ kind: "terminal", id: f.focus(), revision: "1", owner: "window-1" }] }, async () => ++calls));
  assert.equal(calls, 1);
});

test("forged runtime, cross-runtime session and source replacement cannot use a scope", async () => {
  const f = fixture(); const ref = await f.issue();
  await assert.rejects(f.scopes.begin(ref.handle, { ...f.context, runtimeId: "forged" }));
  f.runtimeTo("r2");
  await assert.rejects(f.scopes.begin(ref.handle, { ...f.context, runtimeId: "r2" }));
  f.runtimeTo("r1"); f.replaceSource();
  await assert.rejects(f.scopes.begin(ref.handle, f.context));
});

test("one host policy decision; target owner/revision is revalidated after approval waits", async () => {
  const f = fixture(); const ref = await f.issue(); const ticket = await f.scopes.begin(ref.handle, f.context);
  const entered = deferred(); const release = deferred(); let decisions = 0; let effects = 0;
  f.authorize(async (_context, owner, action) => {
    decisions++; assert.equal(owner.privateOwner, "source:opaque-owner-a:com.example.assistant");
    assert.equal(action.targets[0].id, "terminal-a"); entered.resolve(); await release.promise;
  });
  const result = f.scopes.dispatch(ticket, f.context, f.action(), async () => effects++);
  await entered.promise;
  f.targets.set("terminal-a", { owner: "new-window", revision: "session-a-v2" });
  release.resolve(); await assert.rejects(result);
  assert.equal(decisions, 1); assert.equal(effects, 0); assert.equal(ticket.controller.signal.aborted, true);
});

test("copied target ID with substituted owner or revision and undelegated capabilities fail before policy/execute", async () => {
  const f = fixture(); const ref = await f.issue(); const ticket = await f.scopes.begin(ref.handle, f.context);
  let decisions = 0; let effects = 0; f.authorize(async () => { decisions++; });
  for (const patch of [{ owner: "attacker" }, { revision: "old" }]) {
    await assert.rejects(f.scopes.dispatch(ticket, f.context,
      { capabilityId: "terminal.execute", targets: [{ ...f.target("terminal-a"), ...patch }] }, async () => effects++));
  }
  await assert.rejects(f.scopes.dispatch(ticket, f.context,
    { capabilityId: "vault.host.delete", targets: [] }, async () => effects++));
  assert.equal(decisions, 0); assert.equal(effects, 0);
});

test("Deny and revoked source during authorization never dispatch a tool", async () => {
  const f = fixture(); const ref = await f.issue(); const ticket = await f.scopes.begin(ref.handle, f.context);
  let effects = 0;
  f.authorize(async () => { throw Error("Denied"); });
  await assert.rejects(f.scopes.dispatch(ticket, f.context, f.action(), async () => effects++));
  f.authorize(async () => { f.replaceSource(); });
  await assert.rejects(f.scopes.dispatch(ticket, f.context, f.action(), async () => effects++));
  assert.equal(effects, 0);
});

test("Stop while approval waits cancels the exact turn and prevents invocation", async () => {
  const f = fixture(); const ref = await f.issue(); const ticket = await f.scopes.begin(ref.handle, f.context);
  const entered = deferred(); const release = deferred(); let effects = 0;
  f.authorize(async (_context, _owner, _action, signal) => {
    assert.equal(signal, ticket.controller.signal); entered.resolve(); await release.promise;
  });
  const result = f.scopes.dispatch(ticket, f.context, f.action(), async () => effects++);
  await entered.promise; assert.equal(await f.scopes.stop(ref.handle, f.context), true);
  release.resolve(); await assert.rejects(result); assert.equal(effects, 0);
  const next = await f.scopes.begin(ref.handle, f.context);
  assert.equal(f.scopes.finish(ticket), false); assert.equal(next.controller.signal.aborted, false);
});

for (const reason of ["runtime", "plugin", "lock", "stop"]) {
  test(`${reason} cancellation drops late native results and invalidates the old event ticket`, async () => {
    const f = fixture(); const ref = await f.issue(); const ticket = await f.scopes.begin(ref.handle, f.context);
    const entered = deferred(); const release = deferred();
    const result = f.scopes.dispatch(ticket, f.context, f.action(), async ({ signal }) => {
      assert.equal(signal, ticket.controller.signal); entered.resolve(); await release.promise; return "late";
    });
    await entered.promise;
    if (reason === "runtime") f.scopes.releaseRuntime(f.context.runtimeId);
    else if (reason === "plugin") f.scopes.releasePlugin(f.context.pluginId);
    else if (reason === "lock") f.lock();
    else await f.scopes.stop(ref.handle, f.context);
    release.resolve(); await assert.rejects(result); await assert.rejects(f.scopes.assertTurn(ticket, f.context));
    assert.equal(ticket.controller.signal.aborted, true);
  });
}

test("backend config changes and expiry invalidate scopes; host snapshots cannot silently refresh them", async () => {
  const f = fixture(); const ref = await f.issue(); const ticket = await f.scopes.begin(ref.handle, f.context);
  f.backendTo("new-config"); await assert.rejects(f.scopes.assertTurn(ticket, f.context));
  assert.equal(ticket.controller.signal.aborted, true);
  const g = fixture(); const next = await g.issue(); const active = await g.scopes.begin(next.handle, g.context);
  g.tick(300_000); await assert.rejects(g.scopes.assertTurn(active, g.context));
  assert.equal(active.controller.signal.aborted, true); assert.equal(g.scopes.scopes.size, 0);
});

test("bounded host scopes reject malformed snapshots without registering partial targets", async () => {
  const f = fixture(); await assert.rejects(f.issue([null])); assert.equal(f.scopes.scopes.size, 0);
  await assert.rejects(f.issue([f.target("terminal-a"), f.target("terminal-a")]));
  for (let i = 0; i < 8; i++) await f.issue();
  await assert.rejects(f.issue());
  f.tick(300_000); await f.issue(); assert.equal(f.scopes.scopes.size, 1);
  f.scopes.shutdown(); await assert.rejects(f.issue());
});
