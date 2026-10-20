"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createExternalMcpController,
  EXTERNAL_MCP_CHAT_SESSION_ID,
} = require("./externalMcpController.cjs");

function createFakeBridge({ port = 45555, token = "tok-1" } = {}) {
  const scoped = new Map();
  const sessionIdleTimeouts = [];
  return {
    getOrCreateHost: async () => port,
    issueExternalMcpAuthToken: () => token,
    getExternalMcpAuthToken: () => token,
    revokeExternalMcpAuthToken: () => {},
    getPermissionMode: () => "confirm",
    getScopedSessionIds: (chatSessionId) => scoped.get(chatSessionId)?.sessionIds || [],
    updateSessionMetadata: (sessionList, chatSessionId) => {
      scoped.set(chatSessionId, {
        sessionIds: sessionList.map((s) => s.sessionId),
      });
    },
    syncLiveSessionsToExternalScope: (chatSessionId = EXTERNAL_MCP_CHAT_SESSION_ID) => {
      scoped.set(chatSessionId, { sessionIds: ["sess-1", "sess-2"] });
      return { ok: true, count: 2, chatSessionId };
    },
    cleanupScopedMetadata: async (chatSessionId) => {
      scoped.delete(chatSessionId);
    },
    cancelPtyExecsForSession: () => {},
    cancelBackgroundJobsForSession: () => {},
    cancelWorkerBackgroundJobsForSession: () => {},
    cancelSftpOpsForSession: async () => {},
    setChatSessionCancelled: () => {},
    clearPendingApprovals: () => {},
    disconnectExternalMcpClients: () => {},
    setSessionIdleTimeoutMinutes: (minutes) => sessionIdleTimeouts.push(minutes),
    _scoped: scoped,
    _sessionIdleTimeouts: sessionIdleTimeouts,
  };
}

describe("externalMcpController", () => {
  let tmpDir;
  let discoveryPath;
  let written;
  let removed;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-ext-ctrl-"));
    discoveryPath = path.join(tmpDir, "discovery.json");
    written = [];
    removed = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createController(overrides = {}) {
    const bridge = overrides.mcpServerBridge || createFakeBridge();
    const controller = createExternalMcpController({
      mcpServerBridge: bridge,
      getDiscoveryFilePath: () => discoveryPath,
      getLauncherPath: () => "/fake/netcatty-external-mcp",
      writeDiscovery: (filePath, options) => {
        written.push({ filePath, options });
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(options));
        return options;
      },
      removeDiscovery: (filePath) => {
        removed.push(filePath);
        fs.rmSync(filePath, { force: true });
      },
      createCodexSetup: () => ({
        getStatus: async () => ({ ok: true, state: "not_configured", launcherPath: "/fake/netcatty-external-mcp" }),
        addToCodex: async () => ({ ok: true, state: "configured", launcherPath: "/fake/netcatty-external-mcp" }),
      }),
      createClaudeSetup: () => ({
        getStatus: async () => ({ ok: true, state: "not_configured", launcherPath: "/fake/netcatty-external-mcp" }),
        addToClaude: async () => ({ ok: true, state: "configured", launcherPath: "/fake/netcatty-external-mcp" }),
      }),
      setTimeout: overrides.setTimeout || ((fn) => {
        // Do not auto-fire idle timers in unit tests unless requested.
        return 0;
      }),
      clearTimeout: () => {},
      ...overrides,
    });
    controller.init({ discoveryFilePath: discoveryPath, mcpServerBridge: bridge });
    controller.setSessionSyncHandler(async () => {
      bridge.syncLiveSessionsToExternalScope();
    });
    return { controller, bridge };
  }

  it("validates privacy config before updating discovery and propagates IPC failures", async () => {
    const { controller } = createController();
    await controller.setEnabled(true);
    const valid = { enabled: true, redactPrivateIps: true, cidrs: ["10.0.0.0/8"], patterns: ["internal-[a-z]+"] };
    assert.equal(controller.setConfig({ redaction: valid }).ok, true);
    assert.deepEqual(written.at(-1).options.redaction, valid);
    const handlers = new Map();
    controller.registerHandlers({ handle: (name, handler) => handlers.set(name, handler) });
    const result = await handlers.get("netcatty:external-mcp:set-config")({}, { redaction: { enabled: true, cidrs: ["bad-value"] } });
    assert.equal(result.ok, false);
    assert.deepEqual(controller.getStatus().redaction, valid);
    assert.deepEqual(written.at(-1).options.redaction, valid);
    assert.ok(!result.error.includes("bad-value"));
  });

  it("retries discovery persistence after a failed privacy change", async () => {
    let fail = false;
    let saved;
    const { controller } = createController({ writeDiscovery: (_path, options) => {
      if (fail) throw new Error("disk full");
      saved = options;
    } });
    await controller.setEnabled(true);
    fail = true;
    assert.equal(controller.setConfig({ redaction: { enabled: true } }).ok, false);
    assert.equal(controller.getStatus().redaction.enabled, false);
    assert.equal(saved.redaction.enabled, false);
    fail = false;
    assert.equal(controller.setConfig({ redaction: { enabled: true } }).ok, true);
    assert.equal(saved.redaction.enabled, true);
  });

  it("enables external mode, writes discovery, and syncs sessions", async () => {
    const { controller, bridge } = createController();
    const status = await controller.setEnabled(true);
    assert.equal(status.enabled, true);
    assert.equal(status.state, "running");
    assert.equal(status.port, 45555);
    assert.equal(written.length, 1);
    assert.equal(written[0].options.chatSessionId, EXTERNAL_MCP_CHAT_SESSION_ID);
    assert.equal(written[0].options.token, "tok-1");
    assert.deepEqual(bridge.getScopedSessionIds(EXTERNAL_MCP_CHAT_SESSION_ID), ["sess-1", "sess-2"]);
  });

  it("removes discovery and clears scope on disable", async () => {
    const { controller, bridge } = createController();
    await controller.setEnabled(true);
    const status = await controller.setEnabled(false);
    assert.equal(status.enabled, false);
    assert.equal(status.state, "disabled");
    assert.ok(removed.includes(discoveryPath));
    assert.deepEqual(bridge.getScopedSessionIds(EXTERNAL_MCP_CHAT_SESSION_ID), []);
  });

  it("rotates discovery on init so stale files are cleared", () => {
    fs.writeFileSync(discoveryPath, JSON.stringify({ port: 1, token: "stale" }));
    const { controller } = createController();
    assert.ok(removed.includes(discoveryPath));
    assert.equal(controller.getStatus().state, "disabled");
  });

  it("idle timeout in temporary mode disables the runtime", async () => {
    let idleFn = null;
    let idleDone = null;
    const idlePromise = new Promise((resolve) => {
      idleDone = resolve;
    });
    const { controller } = createController({
      setTimeout: (fn) => {
        idleFn = async () => {
          await fn();
          idleDone?.();
        };
        return 1;
      },
    });
    await controller.setEnabled(true);
    assert.equal(typeof idleFn, "function");
    await idleFn();
    await idlePromise;
    // Allow setEnabled(false) from the idle callback to settle.
    await new Promise((resolve) => setImmediate(resolve));
    const status = controller.getStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.state, "disabled");
  });

  it("persistent mode does not schedule idle shutdown", async () => {
    let scheduled = 0;
    const { controller } = createController({
      setTimeout: (fn) => {
        scheduled += 1;
        return 1;
      },
    });
    controller.setConfig({ mode: "persistent", idleTimeoutMinutes: 5 });
    await controller.setEnabled(true);
    assert.equal(scheduled, 0);
    assert.equal(controller.getStatus().mode, "persistent");
  });

  it("syncs the opened-session idle timeout to the MCP bridge", () => {
    const { controller, bridge } = createController();
    const status = controller.setConfig({ sessionIdleTimeoutMinutes: 45 });

    assert.equal(status.sessionIdleTimeoutMinutes, 45);
    assert.deepEqual(bridge._sessionIdleTimeouts, [45]);
  });

  it("builds a universal setup prompt from live paths and bundled Skill content", async () => {
    const { controller } = createController({
      readSkillContent: async () => [
        "---",
        "name: netcatty-mcp",
        "metadata:",
        "  managed-by: netcatty",
        "---",
        "Call get_environment first.",
      ].join("\n"),
    });

    const result = await controller.getUniversalSetupPrompt();

    assert.equal(result.ok, true);
    assert.match(result.prompt, /\/fake\/netcatty-external-mcp/);
    assert.match(result.prompt, new RegExp(discoveryPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.match(result.prompt, /managed-by: netcatty/);
    assert.match(result.prompt, /get_environment/);
  });

  it("serializes overlapping enable/disable so final enable recovers", async () => {
    let releaseStart = null;
    let startPasses = 0;
    const { controller, bridge } = createController();
    controller.setSessionSyncHandler(async () => {
      startPasses += 1;
      if (startPasses === 1) {
        await new Promise((resolve) => {
          releaseStart = resolve;
        });
      }
      bridge.syncLiveSessionsToExternalScope();
    });

    const firstEnable = controller.setEnabled(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof releaseStart, "function");

    const disableDuringStart = controller.setEnabled(false);
    const reenable = controller.setEnabled(true);
    releaseStart();

    await firstEnable;
    await disableDuringStart;
    const status = await reenable;
    assert.equal(status.enabled, true);
    assert.equal(status.state, "running");
    assert.ok(written.length >= 2);
  });

  it("does not listen on HTTP until the toggle is on, and stops when External MCP is disabled", async () => {
    const events = [];
    let listening = false;
    const { controller } = createController({
      createHttpServer: () => ({
        start: async () => {
          listening = true;
          events.push("start");
        },
        stop: async () => {
          listening = false;
          events.push("stop");
        },
        getState: () => ({ listening }),
      }),
    });

    await controller.setEnabled(true);
    await controller.whenHttpSettled();
    assert.equal(controller.getStatus().http.listening, false);
    assert.equal(controller.getStatus().http.enabled, false);
    assert.deepEqual(events, []);

    controller.setConfig({ httpEnabled: true, httpPort: 47391 });
    await controller.whenHttpSettled();
    assert.equal(controller.getStatus().http.listening, true);
    assert.equal(controller.getStatus().http.url, "http://127.0.0.1:47391/mcp");
    assert.equal(controller.getStatus().http.bearerToken, "tok-1");

    controller.setConfig({ httpAllowCustomBind: true, httpListenAddress: "0.0.0.0" });
    await controller.whenHttpSettled();
    assert.equal(controller.getStatus().http.url, null);
    assert.equal(controller.getStatus().http.errorCode, "client_host_required");
    controller.setConfig({ httpClientHost: "172.22.0.1" });
    assert.equal(controller.getStatus().http.url, "http://172.22.0.1:47391/mcp");

    await controller.setEnabled(false);
    await controller.whenHttpSettled();
    assert.equal(listening, false);
    assert.equal(controller.getStatus().http.listening, false);
    assert.equal(controller.getStatus().http.bearerToken, null);
    assert.deepEqual(events, ["start", "start", "stop"]);
  });

  it("routes HTTP dispatch through the bridge handler and rotates the shared external token", async () => {
    let token = "tok-0";
    let issued = 0;
    const calls = [];
    const bridge = createFakeBridge();
    bridge.issueExternalMcpAuthToken = () => {
      issued += 1;
      token = `tok-${issued}`;
      return token;
    };
    bridge.getExternalMcpAuthToken = () => token;
    bridge.dispatchBuiltinRpc = async (method, params, context) => {
      calls.push({ method, params, socket: context?.externalSocket || null });
      return { ok: true };
    };
    let captured = null;
    const { controller } = createController({
      mcpServerBridge: bridge,
      createHttpServer: (deps) => {
        captured = deps;
        return {
          start: async () => {},
          stop: async () => {},
          getState: () => ({ listening: true }),
        };
      },
    });

    await controller.setEnabled(true);
    controller.setConfig({ httpEnabled: true, rotateHttpToken: true });
    await controller.whenHttpSettled();
    assert.equal(controller.getStatus().http.bearerToken, "tok-2");
    assert.equal(written.at(-1).options.token, "tok-2");

    const client = { id: "http-session" };
    const result = await captured.dispatchRpc("netcatty/exec", {
      sessionId: "sess-9",
      command: "pwd",
      chatSessionId: "attacker",
    }, { externalClient: client });
    assert.equal(result.ok, true);
    assert.equal(calls[0].method, "netcatty/exec");
    assert.equal(calls[0].params.chatSessionId, EXTERNAL_MCP_CHAT_SESSION_ID);
    assert.equal(calls[0].params.sessionId, "sess-9");
    assert.equal(calls[0].socket, client);
  });
});
