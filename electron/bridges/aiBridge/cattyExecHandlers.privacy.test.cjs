"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { registerCattyExecHandlers } = require("./cattyExecHandlers.cjs");
const { createAiPrivacyService } = require("../../shared/aiPrivacyService.cjs");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(privacyService, overrides = {}) {
  const handlers = new Map();
  const effects = [];
  const locks = [];
  const mcpServerBridge = {
    getPermissionMode: () => "auto",
    getSessionBusyError: () => null,
    getSessionMeta: () => ({ protocol: "ssh" }),
    checkCommandSafetyCommonOnly: () => ({ blocked: false }),
    checkCommandSafetyForShell: () => ({ blocked: false }),
    resolveSessionBlocklistShellKind: () => "posix",
    reserveSessionExecution: () => ({ ok: true, token: "lock" }),
    releaseSessionExecution: () => { locks.push("released"); },
    activePtyExecs: new Map(),
    dispatchBuiltinRpc: async (method, params, context) => {
      context.beforeExecute();
      effects.push({ method, params });
      return { ok: true };
    },
    ...overrides.mcpServerBridge,
  };
  registerCattyExecHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    validateSender: () => true,
    aiPrivacyService: privacyService,
    sessions: overrides.sessions || new Map(),
    terminalWorkerManager: {
      request: async (channel, payload) => {
        effects.push({ channel, payload });
        return { ok: true };
      },
    },
    electronModule: {},
    safeSend() {},
    getFreshIdlePrompt: () => "",
    execViaPty: async () => {
      effects.push({ terminal: true });
      return { ok: true };
    },
    ...overrides,
    mcpServerBridge,
  });
  const event = { sender: { id: 7 } };
  return {
    effects,
    locks,
    exec: (chatSessionId) => handlers.get("netcatty:ai:exec")(event, {
      sessionId: "session", command: "echo synthetic", chatSessionId,
    }),
    capability: (chatSessionId) => handlers.get("netcatty:ai:capability")(event, {
      rpcMethod: "netcatty/sftp/write", params: { sessionId: "session", path: "/synthetic" }, chatSessionId,
    }),
  };
}

test("Catty main execution requires a live pinned chat when privacy is enabled", async () => {
  const service = createAiPrivacyService();
  service.configure({ enabled: true });
  const ctx = harness(service);
  assert.equal((await ctx.exec("unseen")).ok, false);
  assert.equal((await ctx.capability("unseen")).ok, false);
  assert.equal(service.hasSession("unseen"), false);
  assert.equal(ctx.effects.length, 0);
  service.checkSession("pinned");
  assert.equal((await ctx.exec("pinned")).ok, true);
  assert.equal((await ctx.capability("pinned")).ok, true);
  assert.equal(ctx.effects.length, 2);
  service.configure({ enabled: false });
  assert.equal((await ctx.exec("pinned")).ok, false);
  assert.equal((await ctx.capability("pinned")).ok, false);
  assert.equal(ctx.effects.length, 2);
});

test("Catty legacy no-chat execution is allowed only for initialized disabled privacy", async () => {
  const loading = harness(createAiPrivacyService({ initialized: false }));
  assert.equal((await loading.exec()).ok, false);
  assert.equal((await loading.capability()).ok, false);
  assert.equal(loading.effects.length, 0);
  const service = createAiPrivacyService();
  const ctx = harness(service);
  assert.equal((await ctx.exec()).ok, true);
  assert.equal((await ctx.capability()).ok, true);
  service.configure({ enabled: true });
  assert.equal((await ctx.exec()).ok, false);
  assert.equal((await ctx.capability()).ok, false);
  assert.equal(ctx.effects.length, 2);
});

for (const chatSessionId of ["pinned", undefined]) {
  test(`Catty capability rechecks policy after dispatcher approval (${chatSessionId || "legacy"})`, async () => {
    const service = createAiPrivacyService();
    if (chatSessionId) {
      service.configure({ enabled: true });
      service.checkSession(chatSessionId);
    }
    const entered = deferred();
    const approval = deferred();
    let calls = 0;
    const ctx = harness(service, {
      mcpServerBridge: {
        dispatchBuiltinRpc: async (_method, _params, context) => {
          entered.resolve();
          await approval.promise;
          context.beforeExecute();
          calls++;
          return { ok: true };
        },
      },
    });
    const pending = ctx.capability(chatSessionId);
    await entered.promise;
    service.configure({ enabled: !chatSessionId });
    approval.resolve();
    assert.equal((await pending).ok, false);
    assert.equal(calls, 0);
  });
}

test("Catty terminal rechecks a deleted chat after shell probing and releases its lock", async () => {
  const service = createAiPrivacyService();
  service.configure({ enabled: true });
  service.checkSession("pinned");
  const entered = deferred();
  const probe = deferred();
  const ctx = harness(service, {
    sessions: new Map([["session", { protocol: "local", shellKind: "posix", pty: { write() {} } }]]),
    ensureSessionShellKindForExec: async () => {
      entered.resolve();
      await probe.promise;
      return { ok: true };
    },
  });
  const pending = ctx.exec("pinned");
  await entered.promise;
  service.clearSession("pinned");
  const rejected = assert.rejects(pending, /privacy session is unavailable/);
  probe.resolve();
  await rejected;
  assert.equal(ctx.effects.length, 0);
  assert.deepEqual(ctx.locks, ["released"]);
});
