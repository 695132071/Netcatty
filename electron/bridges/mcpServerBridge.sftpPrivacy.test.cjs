"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createSftpHandlerApi } = require("./mcpServerBridge/sftpHandlers.cjs");
const { createAiPrivacyService } = require("../shared/aiPrivacyService.cjs");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const operations = [
  ["handleSftpList", {}],
  ["handleSftpRead", { path: "/synthetic" }],
  ["handleSftpWrite", { path: "/synthetic", content: "synthetic" }],
  ["handleSftpDownload", { remotePath: "/synthetic", localPath: "/synthetic-local" }],
  ["handleSftpUpload", { remotePath: "/synthetic", localPath: "/synthetic-local" }],
  ["handleSftpMkdir", { path: "/synthetic" }],
  ["handleSftpDelete", { path: "/synthetic" }],
  ["handleSftpRename", { oldPath: "/synthetic", newPath: "/synthetic-new" }],
  ["handleSftpStat", { path: "/synthetic" }],
  ["handleSftpChmod", { path: "/synthetic", mode: "600" }],
  ["handleSftpHome", {}],
];

for (const worker of [false, true]) {
  for (const [method, args] of operations) {
    test(`${method} blocks a policy change during ${worker ? "worker" : "main"} SFTP open`, async () => {
      const privacy = createAiPrivacyService();
      privacy.configure({ enabled: true });
      privacy.checkSession("chat");
      const entered = deferred();
      const release = deferred();
      const effects = [];
      const closed = [];
      const open = async () => {
        entered.resolve();
        await release.promise;
        return { sftpId: "synthetic-handle" };
      };
      const bridge = new Proxy({
        openSftpForSession: open,
        closeSftp: async (_event, payload) => { closed.push(payload); },
      }, {
        get: (target, key) => target[key] || (async (_event, payload) => { effects.push({ key, payload }); }),
      });
      const api = createSftpHandlerApi({
        sessions: new Map(worker ? [] : [["ssh", {}]]),
        terminalWorkerManager: worker ? {
          request: async (channel, payload) => {
            if (channel === "netcatty:sftp:openForSession") return open();
            if (channel === "netcatty:sftp:close") { closed.push(payload); return; }
            effects.push({ channel, payload });
          },
        } : null,
        sftpBridge: bridge,
        transferBridge: null,
        commandTimeoutMs: 1000,
        registerSftpOp: () => () => {},
        createTransferId: () => "synthetic-transfer",
        reportTransferEvent() {},
      });
      const pending = api[method]({ sessionId: "ssh", chatSessionId: "chat", ...args }, {
        beforeExecute: () => privacy.restore("chat", []),
      });
      const rejected = assert.rejects(pending, /start a new chat/);
      await entered.promise;
      privacy.configure({ enabled: false });
      release.resolve();
      await rejected;
      assert.deepEqual(effects, []);
      assert.equal(closed.length, 1, "the opened handle must still be released");
    });
  }
}

for (const method of ["handleSftpDownload", "handleSftpUpload"]) {
  for (const changePolicy of [false, true]) {
    test(`${method} ${changePolicy ? "blocks changed" : "preserves unchanged"} privacy after main transfer admission`, async () => {
      const privacy = createAiPrivacyService();
      privacy.configure({ enabled: true });
      privacy.checkSession("chat");
      const entered = deferred();
      const release = deferred();
      const effects = [];
      const opens = [];
      const closed = [];
      const admitted = [];
      const transferBridge = {
        getGlobalTransferConcurrency: () => 1,
        async runAdmittedTransfer(event, payload, _progress, runner) {
          admitted.push(payload);
          entered.resolve();
          await release.promise;
          return runner
            ? runner()
            : transferBridge.startTransfer(event, { ...payload, skipAdmission: true });
        },
        startTransfer(event, payload) {
          if (payload.skipAdmission !== true) {
            return transferBridge.runAdmittedTransfer(event, payload);
          }
          effects.push(payload);
          return Promise.resolve({ transferId: payload.transferId });
        },
      };
      const api = createSftpHandlerApi({
        sessions: new Map([["ssh", { hostId: "synthetic-host" }]]),
        terminalWorkerManager: null,
        sftpBridge: {
          openSftpForSession: async (_event, payload) => {
            opens.push(payload);
            return { sftpId: "synthetic-handle" };
          },
          closeSftp: async (_event, payload) => { closed.push(payload); },
        },
        transferBridge,
        commandTimeoutMs: 1000,
        registerSftpOp: () => () => {},
        createTransferId: () => "synthetic-transfer",
        reportTransferEvent() {},
      });
      const pending = api[method]({
        sessionId: "ssh", chatSessionId: "chat",
        remotePath: "/synthetic-remote", localPath: "/synthetic-local",
      }, { beforeExecute: () => privacy.restore("chat", []) });
      const rejected = changePolicy ? assert.rejects(pending, /start a new chat/) : null;
      await entered.promise;
      if (changePolicy) privacy.configure({ enabled: false });
      release.resolve();
      if (rejected) await rejected;
      else assert.equal((await pending).ok, true);
      assert.equal(admitted.length, 1, "the transfer must acquire only one admission slot");
      const hostField = method === "handleSftpDownload" ? "sourceHostId" : "targetHostId";
      assert.equal(admitted[0][hostField], "synthetic-host");
      assert.equal(admitted[0].globalConcurrency, 1);
      assert.equal(effects.length, changePolicy ? 0 : 1);
      assert.equal(opens.length, changePolicy ? 0 : 1);
      assert.equal(closed.length, opens.length);
      if (!changePolicy) assert.equal(effects[0].skipAdmission, true);
    });
  }
}

for (const method of ["handleSftpDownload", "handleSftpUpload"]) {
  for (const cancelQueued of [false, true]) {
    test(`${method} ${cancelQueued ? "cancels" : "completes"} through real admission with chat cleanup`, { timeout: 5000 }, async (t) => {
      const realTransfers = require("./transferBridge.cjs");
      const { createBackgroundJobApi } = require("./mcpServerBridge/backgroundJobs.cjs");
      const previousLimit = realTransfers.getGlobalTransferConcurrency();
      realTransfers.setGlobalTransferConcurrency(1);
      const hostId = `synthetic-${method}-${cancelQueued}`;
      const transferId = `${hostId}-transfer`;
      const releaseBlocker = deferred();
      const queued = deferred();
      const blocker = realTransfers.runAdmittedTransfer(
        { sender: { send() {} } },
        { transferId: `${hostId}-blocker`, sourceHostId: hostId },
        undefined,
        () => releaseBlocker.promise,
      );
      const privacy = createAiPrivacyService();
      privacy.configure({ enabled: true });
      privacy.checkSession("chat");
      const registryContext = {
        activeSessionSftpOps: new Map(), closingTerminalSessions: new Map(), activeSftpOpSeq: 0,
      };
      const registry = createBackgroundJobApi(registryContext);
      const effects = [];
      const opens = [];
      const closed = [];
      const events = [];
      let admissionCount = 0;
      let registrationCount = 0;
      let releaseCount = 0;
      let cancelCount = 0;
      let pending;
      t.after(async () => {
        releaseBlocker.resolve();
        await blocker;
        await pending;
        realTransfers.setGlobalTransferConcurrency(previousLimit);
      });
      const api = createSftpHandlerApi({
        sessions: new Map([["ssh", { hostId }]]),
        terminalWorkerManager: null,
        sftpBridge: {
          openSftpForSession: async () => { opens.push(true); return { sftpId: "synthetic-handle" }; },
          closeSftp: async () => { closed.push(true); },
        },
        transferBridge: {
          getGlobalTransferConcurrency: () => 1,
          runAdmittedTransfer: (...args) => {
            admissionCount++;
            return realTransfers.runAdmittedTransfer(...args);
          },
          cancelTransfer: (...args) => {
            cancelCount++;
            return realTransfers.cancelTransfer(...args);
          },
          startTransfer: async (_event, payload) => {
            assert.equal(payload.skipAdmission, true);
            effects.push(payload);
            return { transferId };
          },
        },
        commandTimeoutMs: 1000,
        registerSftpOp: (...args) => {
          registrationCount++;
          const unregister = registry.registerSftpOp(...args);
          return () => { releaseCount++; unregister(); };
        },
        createTransferId: () => transferId,
        reportTransferEvent: (event) => {
          events.push(event);
          if (event.type === "queued" && event.transferId === transferId) queued.resolve();
        },
      });
      let settled = false;
      pending = api[method]({
        sessionId: "ssh", chatSessionId: "chat",
        remotePath: "/synthetic-remote", localPath: "/synthetic-local",
      }, { beforeExecute: () => privacy.restore("chat", []) }).then((result) => {
        settled = true;
        return result;
      });
      await queued.promise;
      assert.equal(opens.length, 0);
      if (cancelQueued) {
        await registry.cancelSftpOpsForSession("chat");
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, true, "queued cancellation must settle before the occupied slot is released");
        assert.deepEqual(await pending, { ok: false, cancelled: true, transferId });
        assert.equal(cancelCount, 1);
        assert.equal(events.filter((event) => event.type === "cancelled").length, 1);
      } else {
        releaseBlocker.resolve();
        await blocker;
        assert.equal((await pending).ok, true);
        assert.equal(cancelCount, 0);
        assert.equal(events.filter((event) => event.type === "completed").length, 1);
      }
      releaseBlocker.resolve();
      await blocker;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(admissionCount, 1);
      assert.equal(effects.length, cancelQueued ? 0 : 1);
      assert.equal(opens.length, effects.length);
      assert.equal(closed.length, opens.length);
      assert.equal(registryContext.activeSessionSftpOps.size, 0);
      assert.equal(registrationCount, cancelQueued ? 1 : 2);
      assert.equal(releaseCount, registrationCount, "each cancellation registration is released exactly once");
      assert.equal(realTransfers._getPendingCancelCountForTests(), 0);
      assert.equal(await realTransfers.runAdmittedTransfer(
        { sender: { send() {} } },
        { transferId: `${hostId}-next`, sourceHostId: hostId },
        undefined,
        async () => "slot released",
      ), "slot released");
    });
  }
}
