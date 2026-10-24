const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { Worker } = require("node:worker_threads");
const { queryDirtyEditors } = require("../../electron/bridges/dirtyEditorGuard.cjs");

for (const accept of [false, true]) {
  test(`native confirmation held beyond deadline: late ${accept ? "Accept" : "Cancel"} keeps the owner alive`, { timeout: 10000 }, async (t) => {
    const signal = new SharedArrayBuffer(4);
    const worker = new Worker(require.resolve("./__fixtures__/transferQuitRenderer.cjs"), {
      workerData: { accept, signal },
    });
    const ipcMain = new EventEmitter();
    const events = new EventEmitter();
    const replies = [];
    let promptShown = false;
    let closed = false;
    const wc = {
      isDestroyed: () => closed,
      isCrashed: () => false,
      send(channel, payload) { worker.postMessage({ channel, payload }); },
    };
    t.after(async () => { Atomics.store(new Int32Array(signal), 0, 1); Atomics.notify(new Int32Array(signal), 0); await worker.terminate(); });
    worker.on("message", (message) => {
      if (message.type === "reply") {
        replies.push(message.payload);
        ipcMain.emit(message.channel, { sender: wc }, message.payload);
      } else {
        if (message.type === "prompt") promptShown = true;
        events.emit(message.type, message);
      }
    });
    worker.on("error", (error) => events.emit("error", error));
    await once(events, "ready");
    const started = Date.now();
    const result = await queryDirtyEditors(wc, 5000, { ipcMain });
    if (!result) closed = true;
    assert.equal(promptShown, true);
    assert.equal(result, "transfers");
    assert.equal(closed, false, "main refuses close while the renderer is blocked in its native prompt");
    assert.ok(Date.now() - started >= 4900, "use the unchanged five-second production deadline");
    assert.equal(ipcMain.listenerCount("app:dirty-editors-result"), 0, "main settled without hanging");
    const done = once(events, "done");
    Atomics.store(new Int32Array(signal), 0, 1);
    Atomics.notify(new Int32Array(signal), 0);
    const [completed] = await done;
    assert.equal(completed.resumes, 1);
    assert.equal(replies.at(-1).hasDirty, true, "an expired Accept cannot authorize a later close");
    assert.equal(replies.at(-1).reason, "transfers");
    assert.equal(closed, false);
  });
}
