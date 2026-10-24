/* eslint-disable no-undef */
function createSftpHandlerApi(ctx) {
  with (ctx) {
    function getSessionSftpEncodingStateKey(chatSessionId, sessionId) {
      if (!chatSessionId || !sessionId) return null;
      return `chat:${chatSessionId}:session:${sessionId}`;
    }

    function getWorkerManager() {
      return typeof terminalWorkerManager !== "undefined" ? terminalWorkerManager : null;
    }

    function getMainSessions() {
      return typeof sessions !== "undefined" ? sessions : null;
    }

    function getStableTransferHostId(params) {
      if (typeof params?.hostId === "string" && params.hostId) return params.hostId;
      const mainHostId = getMainSessions()?.get?.(params?.sessionId)?.hostId;
      if (typeof mainHostId === "string" && mainHostId) return mainHostId;
      const workerHostId = getWorkerManager()?.getSessionHostId?.(params?.sessionId);
      if (typeof workerHostId === "string" && workerHostId) return workerHostId;
      return typeof params?.sessionId === "string" && params.sessionId ? params.sessionId : undefined;
    }

    function shouldProxySessionBackedSftpToWorker(params) {
      if (!params?.sessionId) return false;
      const manager = getWorkerManager();
      if (!manager?.request) return false;
      const mainSessions = getMainSessions();
      return !mainSessions?.get?.(params.sessionId);
    }

    function waitForWorkerSftpRequest(requestPromise, options = {}) {
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : 0;
      if (!timeoutMs) return requestPromise;

      let timer = null;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${options.operationName || "SFTP operation"} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      return Promise.race([requestPromise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    }

    function requestWorkerSftp(channel, payload, options = {}) {
      const manager = getWorkerManager();
      if (!manager?.request) {
        return Promise.reject(new Error("Terminal worker is unavailable"));
      }
      return waitForWorkerSftpRequest(manager.request(channel, payload, {}), options);
    }

    async function withWorkerSessionBackedSftp(params, workerChannel, options = {}) {
      if (!workerChannel) throw new Error("Worker SFTP channel is required");
      const chatSessionId = typeof params?.chatSessionId === "string" && params.chatSessionId ? params.chatSessionId : null;
      const encodingStateKey = getSessionSftpEncodingStateKey(chatSessionId, params.sessionId);
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 0;
      const operationName = options.operationName || "SFTP operation";
      let sftpId = null;
      let pendingOpenPromise = null;
      let boundedOpenPromise = null;
      let closePromise = null;
      let closeRequested = false;
      let cancellationError = null;

      const closeKnownSftpHandle = () => {
        if (!sftpId) return Promise.resolve();
        if (!closePromise) {
          closePromise = requestWorkerSftp("netcatty:sftp:close", { sftpId, encodingStateKey });
        }
        return closePromise;
      };
      const closeSftpHandle = async () => {
        closeRequested = true;
        if (!sftpId && boundedOpenPromise) {
          try {
            const opened = await boundedOpenPromise;
            sftpId = opened?.sftpId || null;
          } catch {
            // Do not let an unresponsive worker open block cancellation. If it
            // eventually succeeds, the late-result handler below closes it.
          }
        }
        return closeKnownSftpHandle();
      };
      const unregisterSftpOp = registerSftpOp(chatSessionId, params.sessionId, () => {
        if (!cancellationError) {
          cancellationError = new Error("Cancelled");
        }
        return closeSftpHandle().catch(() => {
          // Ignore close failures while cancelling a worker-backed SFTP handle.
        });
      });

      try {
        const manager = getWorkerManager();
        options.beforeExecute?.();
        pendingOpenPromise = manager.request("netcatty:sftp:openForSession", {
          sessionId: params.sessionId,
          encodingStateKey,
          timeoutMs,
        }, {});
        boundedOpenPromise = waitForWorkerSftpRequest(pendingOpenPromise, { timeoutMs, operationName });
        void pendingOpenPromise.then((lateOpened) => {
          if (!sftpId) sftpId = lateOpened?.sftpId || null;
          if (closeRequested) return closeKnownSftpHandle();
          return undefined;
        }).catch(() => {
          // The bounded request reports open failures to the active operation.
        });
        const opened = await boundedOpenPromise;
        sftpId = opened?.sftpId;
        if (!sftpId) throw new Error("Failed to open session-backed SFTP handle");
        if (cancellationError) throw cancellationError;

        const { abortSignal: _abortSignal, ...workerParams } = params || {};
        const workerPayload = options.buildWorkerPayload
          ? options.buildWorkerPayload(workerParams, sftpId)
          : { ...workerParams, sftpId, timeoutMs };
        options.beforeExecute?.();
        const value = await requestWorkerSftp(workerChannel, workerPayload, { timeoutMs, operationName });
        if (cancellationError) throw cancellationError;
        return value;
      } finally {
        unregisterSftpOp();
        try {
          await closeSftpHandle();
        } catch {
          // Ignore close failures for one-off worker-backed SFTP handles.
        }
      }
    }
    
    async function withSessionBackedSftp(params, action, options = {}) {
      if (!params?.sessionId) throw new Error("sessionId is required");
      if (shouldProxySessionBackedSftpToWorker(params) && options.workerChannel) {
        return withWorkerSessionBackedSftp(params, options.workerChannel, options);
      }
      const chatSessionId = typeof params?.chatSessionId === "string" && params.chatSessionId ? params.chatSessionId : null;
      const encodingStateKey = getSessionSftpEncodingStateKey(chatSessionId, params.sessionId);
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 0;
      const cancelCleanupGraceMs = Number.isFinite(options.cancelCleanupGraceMs) && options.cancelCleanupGraceMs >= 0
        ? options.cancelCleanupGraceMs
        : 1000;
      const operationName = options.operationName || "SFTP operation";
      const abortController = new AbortController();
      let sftpId = null;
      let timeoutId = null;
      let forceCloseTimer = null;
      let closeRequested = false;
      let closePromise = null;
      let cancellationError = null;
      let timeoutError = null;
      const closeSftpHandle = () => {
        if (!sftpId) {
          return Promise.resolve();
        }
        if (!closePromise) {
          closePromise = Promise.resolve().then(() => sftpBridge.closeSftp(null, { sftpId, encodingStateKey }));
        }
        return closePromise;
      };
      const closeSftpInBackground = () => {
        if (closeRequested) return;
        closeRequested = true;
        void closeSftpHandle().catch(() => {
          // Ignore close failures while cleaning up a cancelled or timed-out handle.
        });
      };
      const requestAbort = (err) => {
        if (!abortController.signal.aborted) {
          abortController.abort(err);
        }
        if (!forceCloseTimer && !closeRequested) {
          forceCloseTimer = setTimeout(() => {
            forceCloseTimer = null;
            closeSftpInBackground();
          }, cancelCleanupGraceMs);
        }
      };
      const unregisterSftpOp = registerSftpOp(chatSessionId, params.sessionId, () => {
        if (!cancellationError) {
          cancellationError = new Error("Cancelled");
        }
        requestAbort(cancellationError);
        closeRequested = true;
        return closeSftpHandle().catch(() => {
          // Ignore close failures while cancelling the SFTP operation.
        });
      });
      try {
        if (timeoutMs) {
          timeoutId = setTimeout(() => {
            if (!timeoutError) {
              timeoutError = new Error(`${operationName} timed out after ${timeoutMs}ms`);
            }
            requestAbort(timeoutError);
          }, timeoutMs);
        }
    
        options.beforeExecute?.();
        const opened = await sftpBridge.openSftpForSession(null, {
          sessionId: params.sessionId,
          encodingStateKey,
          abortSignal: abortController.signal,
          timeoutMs,
        });
        sftpId = opened?.sftpId;
        if (!sftpId) throw new Error("Failed to open session-backed SFTP handle");
        if (timeoutError) {
          throw timeoutError;
        }
        if (cancellationError) {
          throw cancellationError;
        }
    
        const payload = {
          ...params,
          sftpId,
          abortSignal: abortController.signal,
          timeoutMs,
        };
        const value = await Promise.resolve().then(() => {
          options.beforeExecute?.();
          return action(payload);
        });
        if (timeoutError) {
          throw timeoutError;
        }
        if (cancellationError) {
          throw cancellationError;
        }
        return value;
      } catch (err) {
        if (timeoutError) {
          throw timeoutError;
        }
        if (cancellationError) {
          throw cancellationError;
        }
        throw err;
      } finally {
        unregisterSftpOp();
        if (timeoutId) clearTimeout(timeoutId);
        if (forceCloseTimer) {
          clearTimeout(forceCloseTimer);
          forceCloseTimer = null;
        }
        try {
          await closeSftpHandle();
        } catch {
          // Ignore close failures for one-off internal SFTP handles.
        }
      }
    }
    
    async function runAdmittedSessionTransfer(params, event, payload, runner) {
      let queued = false;
      let cancelled = false;
      let registered = true;
      const cancelledResult = () => ({ transferId: payload.transferId, error: "Transfer cancelled", cancelled: true });
      const unregister = registerSftpOp(params?.chatSessionId, params?.sessionId, () => {
        cancelled = true;
        if (queued) return transferBridge.cancelTransfer?.(null, { transferId: payload.transferId });
      });
      const releaseRegistration = () => {
        if (!registered) return;
        registered = false;
        unregister();
      };
      try {
        // Registration may synchronously cancel an already-closing terminal.
        if (cancelled) return cancelledResult();
        queued = true;
        return await transferBridge.runAdmittedTransfer(event, payload, undefined, async () => {
          queued = false;
          releaseRegistration();
          if (cancelled) return cancelledResult();
          // The runner registers handle cleanup synchronously before its first
          // await, so admission and active-operation cancellation never overlap.
          return runner();
        });
      } finally {
        releaseRegistration();
      }
    }

    async function handleSftpList(params, executionContext = {}) {
      const entries = await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.listSftp(null, payload),
        { ...executionContext, timeoutMs: commandTimeoutMs, operationName: "SFTP list", workerChannel: "netcatty:sftp:list" },
      );
      return { ok: true, entries };
    }
    
    async function handleSftpRead(params, executionContext = {}) {
      if (!params?.path) throw new Error("path is required");
      const content = await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.readSftp(null, payload),
        { ...executionContext, timeoutMs: commandTimeoutMs, operationName: "SFTP read", workerChannel: "netcatty:sftp:read" },
      );
      return { ok: true, path: params.path, content };
    }
    
    async function handleSftpWrite(params, executionContext = {}) {
      if (!params?.path) throw new Error("path is required");
      if (typeof params?.content !== "string") throw new Error("content is required");
      await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.writeSftp(null, payload),
        { ...executionContext, timeoutMs: commandTimeoutMs, operationName: "SFTP write", workerChannel: "netcatty:sftp:write" },
      );
      return { ok: true, path: params.path };
    }
    
    async function handleSftpDownload(params, executionContext = {}) {
      if (!params?.remotePath || !params?.localPath) {
        throw new Error("remotePath and localPath are required");
      }
      const transferId = createTransferId();
      const sourceHostId = getStableTransferHostId(params);
      reportTransferEvent({
        type: "queued", transferId, origin: "agent", background: true,
        direction: "download", sourcePath: params.remotePath, targetPath: params.localPath,
        sessionId: params.sessionId, startedAt: Date.now(),
        sourceHostId,
      });
      try {
        let cancellationReported = false;
        const sender = {
          send(channel, payload) {
            if (channel === "netcatty:transfer:progress") {
              reportTransferEvent({ type: "progress", ...payload });
            } else if (channel === "netcatty:transfer:started") {
              reportTransferEvent({ type: "started", ...payload });
            } else if (channel === "netcatty:transfer:queued") {
              reportTransferEvent({ type: "queued", ...payload });
            } else if (channel === "netcatty:transfer:paused") {
              reportTransferEvent({ type: "paused", ...payload });
            } else if (channel === "netcatty:transfer:cancelled") {
              if (!cancellationReported) reportTransferEvent({ type: "cancelled", ...payload, endedAt: Date.now() });
              cancellationReported = true;
            }
          },
        };
        // Admit before opening the handle so the execution guard runs after
        // queue waits for main-process transfers as well as worker transfers.
        const useOuterAdmission = typeof transferBridge?.runAdmittedTransfer === "function";
        const runDownload = (skipAdmission) => withSessionBackedSftp(
          params,
          (payload) => transferBridge
            ? transferBridge.startTransfer({ sender }, {
                transferId,
                sourcePath: params.remotePath,
                targetPath: params.localPath,
                sourceType: "sftp",
                targetType: "local",
                sourceSftpId: payload.sftpId,
                sourceHostId,
                resumable: true,
                globalConcurrency: transferBridge.getGlobalTransferConcurrency?.(),
                // Only skip when outer runAdmittedTransfer already owns the slot.
                skipAdmission: skipAdmission === true,
              })
            : sftpBridge.downloadSftpToLocal(null, payload),
          {
            ...executionContext,
            timeoutMs: commandTimeoutMs,
            operationName: "SFTP download",
            workerChannel: transferBridge ? "netcatty:transfer:start" : "netcatty:sftp:downloadToLocal",
            buildWorkerPayload: transferBridge ? (_workerParams, sftpId) => ({
              transferId,
              sourcePath: params.remotePath,
              targetPath: params.localPath,
              sourceType: "sftp",
              targetType: "local",
              sourceSftpId: sftpId,
              sourceHostId,
              resumable: true,
              skipAdmission: true,
            }) : undefined,
          },
        );
        const result = await (
          useOuterAdmission
            ? runAdmittedSessionTransfer(
                params,
                { sender },
                { transferId, sourceHostId, globalConcurrency: transferBridge.getGlobalTransferConcurrency?.() },
                () => runDownload(true),
              )
            : runDownload(false)
        );
        if (result?.cancelled || result?.error === "Transfer cancelled") {
          if (!cancellationReported) reportTransferEvent({ type: "cancelled", transferId, endedAt: Date.now() });
          return { ok: false, cancelled: true, transferId };
        }
        if (result?.error) throw new Error(result.error);
        reportTransferEvent({ type: "completed", transferId, endedAt: Date.now() });
        return { ok: true, transferId, ...result };
      } catch (error) {
        reportTransferEvent({ type: "failed", transferId, endedAt: Date.now(), error: error?.message || String(error) });
        throw error;
      }
    }
    
    async function handleSftpUpload(params, executionContext = {}) {
      if (!params?.remotePath || !params?.localPath) {
        throw new Error("remotePath and localPath are required");
      }
      const transferId = createTransferId();
      const targetHostId = getStableTransferHostId(params);
      reportTransferEvent({
        type: "queued", transferId, origin: "agent", background: true,
        direction: "upload", sourcePath: params.localPath, targetPath: params.remotePath,
        sessionId: params.sessionId, startedAt: Date.now(),
        targetHostId,
      });
      try {
        let cancellationReported = false;
        const sender = {
          send(channel, payload) {
            if (channel === "netcatty:transfer:progress") {
              reportTransferEvent({ type: "progress", ...payload });
            } else if (channel === "netcatty:transfer:started") {
              reportTransferEvent({ type: "started", ...payload });
            } else if (channel === "netcatty:transfer:queued") {
              reportTransferEvent({ type: "queued", ...payload });
            } else if (channel === "netcatty:transfer:paused") {
              reportTransferEvent({ type: "paused", ...payload });
            } else if (channel === "netcatty:transfer:cancelled") {
              if (!cancellationReported) reportTransferEvent({ type: "cancelled", ...payload, endedAt: Date.now() });
              cancellationReported = true;
            }
          },
        };
        const useOuterAdmissionUpload = typeof transferBridge?.runAdmittedTransfer === "function";
        const runUpload = (skipAdmission) => withSessionBackedSftp(
          params,
          (payload) => transferBridge
            ? transferBridge.startTransfer({ sender }, {
                transferId,
                sourcePath: params.localPath,
                targetPath: params.remotePath,
                sourceType: "local",
                targetType: "sftp",
                targetSftpId: payload.sftpId,
                targetHostId,
                resumable: true,
                globalConcurrency: transferBridge.getGlobalTransferConcurrency?.(),
                // Only skip when outer runAdmittedTransfer already owns the slot.
                skipAdmission: skipAdmission === true,
              })
            : sftpBridge.uploadLocalToSftp(null, payload),
          {
            ...executionContext,
            timeoutMs: commandTimeoutMs,
            operationName: "SFTP upload",
            workerChannel: transferBridge ? "netcatty:transfer:start" : "netcatty:sftp:uploadLocal",
            buildWorkerPayload: transferBridge ? (_workerParams, sftpId) => ({
              transferId,
              sourcePath: params.localPath,
              targetPath: params.remotePath,
              sourceType: "local",
              targetType: "sftp",
              targetSftpId: sftpId,
              targetHostId,
              resumable: true,
              skipAdmission: true,
            }) : undefined,
          },
        );
        const result = await (
          useOuterAdmissionUpload
            ? runAdmittedSessionTransfer(
                params,
                { sender },
                { transferId, targetHostId, globalConcurrency: transferBridge.getGlobalTransferConcurrency?.() },
                () => runUpload(true),
              )
            : runUpload(false)
        );
        if (result?.cancelled || result?.error === "Transfer cancelled") {
          if (!cancellationReported) reportTransferEvent({ type: "cancelled", transferId, endedAt: Date.now() });
          return { ok: false, cancelled: true, transferId };
        }
        if (result?.error) throw new Error(result.error);
        reportTransferEvent({ type: "completed", transferId, endedAt: Date.now(), ...(result?.warning ? { warning: result.warning } : {}) });
        return { ok: true, transferId, ...result };
      } catch (error) {
        reportTransferEvent({ type: "failed", transferId, endedAt: Date.now(), error: error?.message || String(error) });
        throw error;
      }
    }
    
    async function handleSftpMkdir(params, executionContext = {}) {
      if (!params?.path) throw new Error("path is required");
      await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.mkdirSftp(null, payload),
        { ...executionContext, timeoutMs: commandTimeoutMs, operationName: "SFTP mkdir", workerChannel: "netcatty:sftp:mkdir" },
      );
      return { ok: true, path: params.path };
    }
    
    async function handleSftpDelete(params, executionContext = {}) {
      if (!params?.path) throw new Error("path is required");
      await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.deleteSftp(null, payload),
        { ...executionContext, timeoutMs: commandTimeoutMs, operationName: "SFTP delete", workerChannel: "netcatty:sftp:delete" },
      );
      return { ok: true, path: params.path };
    }
    
    async function handleSftpRename(params, executionContext = {}) {
      if (!params?.oldPath || !params?.newPath) {
        throw new Error("oldPath and newPath are required");
      }
      await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.renameSftp(null, payload),
        { ...executionContext, timeoutMs: commandTimeoutMs, operationName: "SFTP rename", workerChannel: "netcatty:sftp:rename" },
      );
      return { ok: true, oldPath: params.oldPath, newPath: params.newPath };
    }
    
    async function handleSftpStat(params, executionContext = {}) {
      if (!params?.path) throw new Error("path is required");
      const stat = await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.statSftp(null, payload),
        { ...executionContext, timeoutMs: commandTimeoutMs, operationName: "SFTP stat", workerChannel: "netcatty:sftp:stat" },
      );
      return { ok: true, stat };
    }
    
    async function handleSftpChmod(params, executionContext = {}) {
      if (!params?.path || !params?.mode) throw new Error("path and mode are required");
      await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.chmodSftp(null, payload),
        { ...executionContext, timeoutMs: commandTimeoutMs, operationName: "SFTP chmod", workerChannel: "netcatty:sftp:chmod" },
      );
      return { ok: true, path: params.path, mode: params.mode };
    }
    
    async function handleSftpHome(params, executionContext = {}) {
      const result = await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.getSftpHomeDir(null, payload),
        { ...executionContext, timeoutMs: commandTimeoutMs, operationName: "SFTP home", workerChannel: "netcatty:sftp:homeDir" },
      );
      if (!result?.success) {
        throw new Error(result?.error || "Could not determine home directory");
      }
      return { ok: true, homeDir: result.homeDir };
    }

    return {
      getSessionSftpEncodingStateKey,
      withSessionBackedSftp,
      handleSftpList,
      handleSftpRead,
      handleSftpWrite,
      handleSftpDownload,
      handleSftpUpload,
      handleSftpMkdir,
      handleSftpDelete,
      handleSftpRename,
      handleSftpStat,
      handleSftpChmod,
      handleSftpHome,
    };
  }
}

module.exports = { createSftpHandlerApi };
