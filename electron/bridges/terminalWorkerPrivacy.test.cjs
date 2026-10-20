"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createTerminalWorkerManager } = require("./terminalWorkerManager.cjs");
const { createTerminalWorkerRuntime } = require("../terminalWorker/runtime.cjs");
const { registerWorkerAiExecHandlers } = require("../terminalWorker/aiExec.cjs");
const { registerCattyExecHandlers } = require("./aiBridge/cattyExecHandlers.cjs");
const { createAiPrivacyService } = require("../shared/aiPrivacyService.cjs");
const { createManagedPrivacyBoundary } = require("../shared/managedPrivacyBoundary.cjs");
const { PROBE_OUTPUT_MARKER } = require("./ai/sessionShellKind.cjs");
const { isolateCliDiscoveryFile } = require("./cliDiscoveryTestIsolation.cjs");
isolateCliDiscoveryFile();
const bridge = require("./mcpServerBridge.cjs");

class LinkedWorker extends EventEmitter {
  constructor(sessions) {
    super();
    this.messages = [];
    let receive;
    const runtime = createTerminalWorkerRuntime({
      parentPort: {
        on: (_channel, listener) => { receive = listener; },
        postMessage: message => queueMicrotask(() => this.emit("message", message)),
      },
      registerBridges: ipcMain => registerWorkerAiExecHandlers(ipcMain, { sessions }),
    });
    runtime.start();
    this.receive = message => receive(message);
  }

  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(() => this.receive(message));
  }

  kill() {}
}

for (const [source, transport] of [
  ["catty", "pty"],
  ["catty", "channel"],
  ["managed-exec", "pty"],
  ["managed-exec", "channel"],
  ["managed-job", "pty"],
]) {
  test(`${source} rejects policy invalidation during worker ${transport} shell probe`, async (t) => {
    const service = createAiPrivacyService();
    service.configure({ enabled: true });
    const chatSessionId = `${source}-${transport}`;
    const command = "echo 192.0.2.41";
    const alias = service.redact(chatSessionId, command);
    const writes = [];
    let probeEntered;
    let releaseProbe;
    const entered = new Promise(resolve => { probeEntered = resolve; });
    const probe = new Promise(resolve => { releaseProbe = resolve; });
    const session = {
      protocol: "ssh",
      _shellKindExecProbe: async () => {
        probeEntered();
        await probe;
        return `${PROBE_OUTPUT_MARKER}/usr/bin/fish\n`;
      },
    };
    if (transport === "pty") {
      session.stream = new EventEmitter();
      session.stream.write = value => { writes.push(value); };
    } else {
      session.conn = { exec: value => { writes.push(value); } };
    }
    const worker = new LinkedWorker(new Map([["session", session]]));
    const manager = createTerminalWorkerManager({ utilityProcess: { fork: () => worker } });
    t.after(() => { bridge.cleanup(); manager.stop(); });
    bridge.init({ sessions: new Map(), terminalWorkerManager: manager, electronModule: null });
    bridge.setPermissionMode("auto");
    bridge.setCommandBlocklist([]);
    bridge.updateSessionMetadata([{
      sessionId: "session", protocol: "ssh", connected: true,
    }], chatSessionId);

    let pending;
    if (source === "catty") {
      const handlers = new Map();
      registerCattyExecHandlers({
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        validateSender: () => true,
        aiPrivacyService: service,
        sessions: new Map(),
        terminalWorkerManager: manager,
        mcpServerBridge: bridge,
      });
      pending = handlers.get("netcatty:ai:exec")({ sender: { id: 7 } }, {
        sessionId: "session", command, chatSessionId,
      });
    } else {
      const dispatch = createManagedPrivacyBoundary(bridge.dispatchBuiltinRpc, service);
      pending = dispatch(source === "managed-job" ? "netcatty/jobStart" : "netcatty/exec", {
        sessionId: "session", command: alias, chatSessionId,
      });
    }
    // Attach rejection handling before retiring the managed conversation.
    const result = Promise.resolve(pending).catch(error => ({ ok: false, error: error.message }));
    await entered;
    assert.equal(writes.length, 0);
    service.configure({ enabled: false });
    releaseProbe();
    const rejected = await result;
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /privacy session is unavailable/);
    assert.deepEqual(writes, [], "neither PTY nor SSH command may run after policy retirement");
    assert.ok(worker.messages.some(message => message.requiresExecutionValidation === true));
    assert.ok(worker.messages.some(message => message.kind === "execution-validation" && message.ok === false));
    if (source === "managed-job") {
      const retry = await manager.request("netcatty:ai:jobStart", {
        sessionId: "session", command, chatSessionId,
      }, { beforeExecute: () => { throw new Error("retired"); } });
      assert.match(retry.error, /privacy session is unavailable/, "failed validation releases the job reservation");
    }
  });
}
