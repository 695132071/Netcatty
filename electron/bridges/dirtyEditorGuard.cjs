const { randomUUID } = require("node:crypto");

/**
 * Dirty-editor guard helper.
 *
 * Both the before-quit handler (electron/main.cjs) and the auto-update install
 * handler (electron/bridges/autoUpdateBridge.cjs) need to ask the renderer
 * whether any SFTP editor tab has unsaved changes before letting the process
 * exit. This module centralizes that one-shot request/response round-trip so
 * the two call sites stay in sync (#1215).
 *
 * The renderer side lives in application/app/useAppStartupEffects.ts: it
 * listens for "app:query-dirty-editors" and replies on
 * "app:dirty-editors-result" with { hasDirty: boolean }.
 */

/**
 * Ask a specific renderer whether it has unsaved editor changes.
 *
 * Sends "app:query-dirty-editors" to the given webContents and resolves with
 * the renderer's reply. Resolves `false` (fail-open) if the renderer never
 * answers within `timeoutMs` without acknowledging unfinished transfers,
 * if the webContents can't be messaged, or if the
 * send throws — in every one of those cases there is no usable UI to surface a
 * "save first" warning on, so blocking the quit would only strand the user.
 *
 * Only a reply whose `event.sender` is the exact `webContents` we queried is
 * accepted; replies from any other window are ignored so a stray/rogue message
 * can't decide the result. The listener and timer are always torn down before
 * resolving, so a late timeout can't override an already-received reply (and
 * vice versa).
 *
 * @param {import("electron").WebContents | null | undefined} webContents
 * @param {number} timeoutMs - Max time to wait for the renderer reply.
 * @param {{ ipcMain?: import("electron").IpcMain }} [options] - Inject ipcMain
 *   for tests; defaults to electron's ipcMain.
 * @returns {Promise<boolean | "transfers">} Truthy when closing must be refused.
 */
function queryDirtyEditors(webContents, timeoutMs, options = {}) {
  const ipcMain = options.ipcMain || resolveIpcMain();

  // No renderer to ask, or no ipcMain to listen with — fail open.
  if (!ipcMain || !webContents) return Promise.resolve(false);
  if (webContents.isDestroyed?.() || webContents.isCrashed?.()) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const request = { requestId: randomUUID(), deadline: Date.now() + timeoutMs };
    let transfersPending = false;
    let settled = false;
    let timeoutId = null;

    const settle = (hasDirty) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      ipcMain.removeListener("app:dirty-editors-result", onResult);
      resolve(hasDirty);
    };

    function onResult(evt, payload) {
      // Defence in depth: only the renderer we queried may decide the result.
      // Use `.on` (not `.once`) so a rogue reply from another window doesn't
      // consume the listener slot and let the real reply fall through. A
      // missing/falsy sender is anomalous and treated as a wrong-window reply.
      if (evt?.sender !== webContents || payload?.requestId !== request.requestId) return;
      if (payload.pending === true && payload.hasDirty === true && payload.reason === "transfers") {
        transfersPending = true;
        return;
      }
      // "transfers": the user already declined the renderer's unfinished-
      // transfer quit prompt. Still truthy, so existing callers keep quit
      // cancelled; handleBeforeQuit uses it to skip the editor dialog.
      settle(payload?.hasDirty === true ? (payload?.reason === "transfers" ? "transfers" : true) : false);
    }
    ipcMain.on("app:dirty-editors-result", onResult);

    // Timeout fallback: if the renderer never replies (crash, unhandled
    // exception in its listener, etc.) we must not hang forever. Once the
    // renderer identifies unfinished transfers, silence is not permission to
    // discard them. Keep the ordinary unresponsive-editor fallback unchanged.
    timeoutId = setTimeout(() => settle(transfersPending ? "transfers" : false), timeoutMs);

    try {
      webContents.send("app:query-dirty-editors", request);
    } catch (err) {
      // webContents.send can throw if the renderer was destroyed between the
      // isCrashed?.() check above and this call (a real race when the GPU
      // process is dying). Tear down synchronously and fail open.
      console.warn("[DirtyEditorGuard] Failed to query renderer for dirty editors:", err);
      settle(false);
    }
  });
}

/**
 * Lazily resolve electron's ipcMain. Kept out of module top-level so this file
 * can be required in a plain `node --test` process (where `electron` isn't a
 * loadable module) as long as the caller injects ipcMain.
 */
function resolveIpcMain() {
  try {
    return require("electron").ipcMain;
  } catch {
    return null;
  }
}

module.exports = { queryDirtyEditors };
