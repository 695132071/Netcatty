"use strict";

// Uses real Chromium storage and the production React hook.
// Run --check-bundle with Node to validate packaging without launching Electron.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const appRoot = path.resolve(__dirname, "..");

function buildRenderer() {
  return esbuild.buildSync({
    stdin: {
      resolveDir: appRoot, loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { useVaultState } from "./application/state/useVaultState";
import * as store from "./infrastructure/persistence/connectionLogTerminalDataStore";
import { localStorageAdapter as adapter } from "./infrastructure/persistence/localStorageAdapter";
import * as keys from "./infrastructure/config/storageKeys";
let latest: ReturnType<typeof useVaultState> | null = null;
let root: ReturnType<typeof createRoot> | null = null;
const events: string[] = [];
const errors: string[] = [];
window.addEventListener("storage", e => { if (e.key) events.push(e.key); });
window.addEventListener("error", e => errors.push(String(e.error?.stack || e.message)));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason?.stack || e.reason)));
function Fixture() { latest = useVaultState(); return React.createElement("div", null, latest.isInitialized ? "ready" : "loading"); }
export function mount() {
  if (root) throw new Error("already mounted");
  root = createRoot(document.getElementById("root")!);
  root.render(React.createElement(Fixture));
}
export async function seed(logs: any[], legacy: Record<string, string>, existing = {}) {
  if (root) throw new Error("cannot seed a mounted hook");
  localStorage.clear();
  if (!await store.clear()) throw new Error("real IndexedDB clear failed");
  // Keep unrelated optional startup migrations empty. No desktop bridge is mocked.
  for (const key of [keys.STORAGE_KEY_HOSTS, keys.STORAGE_KEY_KEYS, keys.STORAGE_KEY_SNIPPETS,
    keys.STORAGE_KEY_GROUPS, keys.STORAGE_KEY_IDENTITIES, keys.STORAGE_KEY_PROXY_PROFILES,
    keys.STORAGE_KEY_NOTES, keys.STORAGE_KEY_NOTE_GROUPS, keys.STORAGE_KEY_GROUP_CONFIGS]) adapter.write(key, []);
  if (!adapter.write(keys.STORAGE_KEY_CONNECTION_LOGS, logs)) throw new Error("metadata seed quota");
  if (!adapter.write(keys.STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA, legacy)) throw new Error("legacy seed quota");
  if (!await store.putMany(existing)) throw new Error("existing replay seed failed");
}
export async function migrate() {
  return store.migrateLegacyConnectionLogTerminalData({
    read: () => adapter.read(keys.STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA),
    remove: () => adapter.remove(keys.STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA),
  });
}
export async function snapshot() {
  return {
    initialized: latest?.isInitialized ?? false,
    logs: latest?.connectionLogs ?? [],
    diskLogs: adapter.read(keys.STORAGE_KEY_CONNECTION_LOGS) ?? [],
    replay: await store.tryLoadAll(),
    legacyPresent: localStorage.getItem(keys.STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA) !== null,
    rev: adapter.read(keys.STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA_REV),
    events: [...events], errors: [...errors],
    native: { indexedDB: indexedDB.constructor.name, secureContext: isSecureContext, locks: typeof navigator.locks?.request },
  };
}
export async function addAndCapture(log: any, terminalData: string) {
  if (!latest?.isInitialized) throw new Error("hook not ready");
  const id = latest.addConnectionLog(log);
  if (!await latest.updateConnectionLog(id, { terminalData, endTime: log.startTime + 1 })) throw new Error("capture persistence returned false");
  return id;
}
export async function failedAddAndCapture(log: any, terminalData: string) {
  // Fault only this renderer's native write boundaries. Reads and metadata-only
  // writes still use genuine browser storage; the production hook is unchanged.
  const transaction = IDBDatabase.prototype.transaction;
  const setItem = Storage.prototype.setItem;
  const faults = { indexedDB: 0, replayFallback: 0 };
  IDBDatabase.prototype.transaction = function (...args: any[]) {
    if (this.name === store.CONNECTION_LOG_TERMINAL_DATA_DB_NAME && args[1] === "readwrite") {
      faults.indexedDB++;
      throw new DOMException("injected replay write failure", "QuotaExceededError");
    }
    return transaction.apply(this, args as Parameters<typeof transaction>);
  };
  Storage.prototype.setItem = function (key: string, value: string) {
    if (this === localStorage && key === keys.STORAGE_KEY_CONNECTION_LOGS
      && JSON.parse(value).some((entry: any) => !entry.saved && entry.terminalData !== undefined)) {
      faults.replayFallback++;
      throw new DOMException("injected replay fallback failure", "QuotaExceededError");
    }
    return setItem.call(this, key, value);
  };
  try {
    const id = latest!.addConnectionLog(log);
    const persisted = await latest!.updateConnectionLog(id, { terminalData });
    return { id, persisted, faults };
  } finally {
    IDBDatabase.prototype.transaction = transaction;
    Storage.prototype.setItem = setItem;
  }
}
export function toggleSaved(id: string) { latest!.toggleConnectionLogSaved(id); }
export function deleteLog(id: string) { latest!.deleteConnectionLog(id); }
export function clearUnsaved() { latest!.clearUnsavedConnectionLogs(); }
export async function capture(id: string, terminalData: string) {
  return latest!.updateConnectionLog(id, { terminalData });
}
let releaseWrites: (() => void) | null = null;
export async function holdWrites() {
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const gate = new Promise<void>(resolve => { releaseWrites = resolve; });
  void navigator.locks.request("netcatty:vault-import:connection-logs", async () => { ready(); await gate; });
  await started;
}
export function resumeWrites() { releaseWrites?.(); releaseWrites = null; }
const pendingCaptures = new Map<string, Promise<boolean>>();
export function startCapture(id: string, terminalData: string) {
  const token = crypto.randomUUID();
  pendingCaptures.set(token, latest!.updateConnectionLog(id, { terminalData }));
  return token;
}
export async function waitCapture(token: string) { return pendingCaptures.get(token); }
export function staleMetadataEvent(logs: any[]) {
  window.dispatchEvent(new StorageEvent("storage", {
    key: keys.STORAGE_KEY_CONNECTION_LOGS, newValue: JSON.stringify(logs), storageArea: localStorage,
  }));
}
`,
    },
    bundle: true, format: "iife", globalName: "ConnectionLogAudit", platform: "browser",
    target: "chrome142", write: false,
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta": "{}" },
  }).outputFiles[0].text;
}

if (process.argv.includes("--check-bundle")) {
  const bundle = buildRenderer();
  process.stdout.write(`CONNECTION_LOG_AUDIT_BUNDLE_OK ${JSON.stringify({ bytes: Buffer.byteLength(bundle) })}\n`);
} else if (!process.versions.electron) {
  require("node:test")("connection-log persistence uses genuine browser IndexedDB", {
    skip: "run with Electron; --check-bundle validates the renderer bundle without launching",
  }, () => {});
} else {
  const { app, BrowserWindow, session } = require("electron");
  const http = require("node:http");
  const crypto = require("node:crypto");
  const temp = require("../electron/bridges/tempDirBridge.cjs");
  const userData = fs.mkdtempSync(`${temp.getTempFilePath("connection-log-persistence-audit")}-`);
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {});
  const windows = new Set();
  const completed = [];
  let server;
  let cleaned = false;
  const deadline = setTimeout(() => finish(1, new Error("audit exceeded 90 seconds")), 90000);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const sha = text => crypto.createHash("sha256").update(text).digest("hex");
  const payload = label => `\x1b[31m${label}\x1b[0m\r\nNUL:\x00 UTF8:\u4f60\u597d \ud83d\udc08\r\n` + Array.from({ length: 96 }, (_, i) => `${label} row ${i} ${"x".repeat(48)}\r\n`).join("");
  const log = (id, startTime, saved = false, terminalData) => ({ id, hostId: "", hostLabel: id,
    hostname: "localhost", username: "fixture", protocol: "local", localUsername: "fixture",
    localHostname: "fixture", startTime, endTime: startTime + 1, saved,
    ...(terminalData === undefined ? {} : { terminalData }), themeId: "fixture-theme", fontSize: 14 });
  const call = (win, method, ...args) => win.webContents.executeJavaScript(
    `ConnectionLogAudit[${JSON.stringify(method)}](...${JSON.stringify(args)})`, true,
  );
  async function until(label, fn, timeout = 10000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await fn();
      if (last) return last;
      await sleep(25);
    }
    throw new Error(`Timed out: ${label}`);
  }
  function pass(name, details = {}) {
    completed.push({ name, ...details });
    process.stdout.write(`CONNECTION_LOG_PERSISTENCE_PASS ${JSON.stringify(completed.at(-1))}\n`);
  }
  async function finish(code, error) {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(deadline);
    if (error) {
      console.error(error.stack || error);
      for (const win of windows) {
        if (win.isDestroyed()) continue;
        try {
          const state = await Promise.race([call(win, "snapshot"), sleep(1000).then(() => null)]);
          if (state) console.error("CONNECTION_LOG_FAILURE_STATE", JSON.stringify({
            windowId: win.id, initialized: state.initialized, errors: state.errors,
            memory: state.logs.map(x => ({ id: x.id, saved: x.saved, hasReplay: Boolean(x.terminalData) })),
            disk: state.diskLogs.map(x => ({ id: x.id, saved: x.saved, hasReplay: Boolean(x.terminalData) })),
            replayIds: Object.keys(state.replay || {}), rev: state.rev, events: state.events.length,
          }));
        } catch (snapshotError) { console.error(String(snapshotError)); }
      }
    }
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    server?.close();
    try { await session.defaultSession.clearStorageData(); } catch {}
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (cleanupError) { console.warn(String(cleanupError)); }
    if (code === 0) process.stdout.write(`CONNECTION_LOG_PERSISTENCE_OK ${JSON.stringify({ completed, scope: "real Chromium storage and production useVaultState; renderer reopen, not OS-process restart" })}\n`);
    app.exit(code);
  }

  void app.whenReady().then(async () => {
    const renderer = buildRenderer();
    server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end("<!doctype html><html><body><div id='root'></div></body></html>");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/fixture`;
    async function makeWindow() {
      const win = new BrowserWindow({ show: false, width: 640, height: 480,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      windows.add(win);
      await win.loadURL(url);
      await win.webContents.executeJavaScript(renderer);
      return win;
    }
    async function mount(win) {
      await call(win, "mount");
      return until("production useVaultState initialization", async () => {
        const s = await call(win, "snapshot");
        if (s.errors.length) throw new Error(s.errors.join("\n"));
        return s.initialized && s;
      });
    }
    async function converged(wins, predicate, label) {
      return until(label, async () => {
        const states = await Promise.all(wins.map(win => call(win, "snapshot")));
        for (const s of states) assert.deepEqual(s.errors, []);
        return states.every(predicate) && states;
      });
    }
    let a = await makeWindow();
    const simple = { "migration-a": payload("migration-a"), "migration-b": payload("migration-b") };
    await call(a, "seed", [], simple);
    const migrated = await call(a, "migrate");
    assert.equal(migrated.migrated, true);
    assert.equal(migrated.durable, true);
    assert.deepEqual(migrated.map, simple);
    let state = await call(a, "snapshot");
    assert.deepEqual(state.replay, simple);
    assert.equal(state.legacyPresent, false);
    assert.equal(state.native.indexedDB, "IDBFactory");
    assert.equal(state.native.locks, "function");
    assert.equal(state.native.secureContext, true);
    pass("legacy migration into empty native IndexedDB", { rows: 2, native: state.native });

    const legacy = {};
    const logs = Array.from({ length: 65 }, (_, i) => {
      const id = `unsaved-${String(i).padStart(3, "0")}`;
      legacy[id] = payload(id);
      return log(id, 1000 + i);
    });
    const saved = { "saved-main-a": payload("saved-main-a"), "saved-side-b": payload("saved-side-b"), "saved-main-c": payload("saved-main-c") };
    logs.push(log("saved-main-a", 1, true, saved["saved-main-a"]), log("saved-side-b", 2, true), log("saved-main-c", 3, true, saved["saved-main-c"]));
    legacy["saved-side-b"] = saved["saved-side-b"];
    const authoritative = payload("existing-IDB-wins-over-stale-legacy");
    await call(a, "seed", logs, legacy, { "unsaved-064": authoritative });
    state = await mount(a);
    const retainedIds = Array.from({ length: 50 }, (_, i) => `unsaved-${String(i + 15).padStart(3, "0")}`);
    assert.deepEqual(Object.keys(state.replay).sort(), [...retainedIds, "saved-side-b"].sort());
    assert.equal(state.replay["unsaved-064"], authoritative);
    assert.equal(state.legacyPresent, false);
    assert.equal(state.logs.length, 68);
    assert.equal(state.diskLogs.length, 68);
    assert.equal(state.logs.filter(x => !x.saved && x.terminalData).length, 50);
    for (const entry of state.logs) {
      if (entry.saved) assert.equal(entry.terminalData, saved[entry.id]);
      else assert.equal(entry.terminalData, retainedIds.includes(entry.id) ? (entry.id === "unsaved-064" ? authoritative : legacy[entry.id]) : undefined);
    }
    assert.equal(state.diskLogs.find(x => x.id === "saved-main-a").terminalData, saved["saved-main-a"]);
    assert.equal(state.diskLogs.filter(x => !x.saved && x.terminalData).length, 0);
    pass("production hook migration retains newest 50 of 65 unsaved replays", { metadata: 68, unsavedReplays: 50, savedReplayHashes: Object.fromEntries(Object.entries(saved).map(([id, data]) => [id, sha(data)])) });

    let b = await makeWindow();
    await mount(b);
    await converged([a, b], s => s.logs.length === 68 && s.logs.every(x => !x.saved || x.terminalData === saved[x.id]), "second window hydrates saved replays");
    const firstData = payload("new-A-final-capture");
    const firstId = await call(a, "addAndCapture", log("ignored", 2000), firstData);
    await converged([a, b], s => s.logs.some(x => x.id === firstId && x.terminalData === firstData) && s.replay[firstId] === firstData, "A capture reaches B through real storage events");
    const secondData = payload("new-B-final-capture");
    const secondId = await call(b, "addAndCapture", log("ignored", 2001), secondData);
    await converged([a, b], s => s.logs.some(x => x.id === secondId && x.terminalData === secondData) && s.replay[secondId] === secondData, "B capture reaches A through real storage events");
    pass("bidirectional close-capture convergence", { ids: [firstId, secondId] });

    await call(b, "toggleSaved", firstId);
    saved[firstId] = firstData;
    await converged([a, b], s => s.logs.some(x => x.id === firstId && x.saved && x.terminalData === firstData) && s.diskLogs.some(x => x.id === firstId && x.saved && x.terminalData === firstData), "bookmark is durable and visible in both windows");
    pass("bookmark retains exact replay in main localStorage blob");

    const concurrent = [];
    for (let round = 0; round < 3; round += 1) {
      const leftData = payload(`concurrent-A-${round}`);
      const rightData = payload(`concurrent-B-${round}`);
      const [left, right] = await Promise.all([
        call(a, "addAndCapture", log("ignored", 3000 + round * 2), leftData),
        call(b, "addAndCapture", log("ignored", 3001 + round * 2), rightData),
      ]);
      concurrent.push([left, leftData], [right, rightData]);
      await converged([a, b], s => concurrent.every(([id, data]) =>
        s.logs.some(x => x.id === id && x.terminalData === data) && s.diskLogs.some(x => x.id === id) && s.replay[id] === data), `concurrent two-window captures round ${round + 1}`);
    }
    state = await call(b, "snapshot");
    assert.ok(state.events.includes("netcatty_connection_log_terminal_data_rev_v1"));
    assert.ok(state.events.includes("netcatty_connection_logs_v1"));
    assert.ok(state.logs.filter(x => !x.saved && x.terminalData).length <= 50);
    pass("three rounds of concurrent two-window capture preserve all new logs", { captured: concurrent.length, nativeStorageEvents: state.events.length });

    const bookmarkedFinal = payload("concurrent-bookmark-final-capture");
    await Promise.all([
      call(a, "capture", secondId, bookmarkedFinal),
      call(b, "toggleSaved", secondId),
    ]);
    saved[secondId] = bookmarkedFinal;
    await converged([a, b], s => s.logs.some(x => x.id === secondId && x.saved && x.terminalData === bookmarkedFinal)
      && s.diskLogs.some(x => x.id === secondId && x.saved && x.terminalData === bookmarkedFinal), "concurrent final capture and bookmark retain both fields");
    pass("concurrent same-log capture and bookmark preserve final bytes and saved flag");

    const refreshed = payload("updated-unsaved-capture");
    assert.equal(await call(a, "capture", concurrent[0][0], refreshed), true);
    concurrent[0][1] = refreshed;
    await converged([a, b], s => s.logs.some(x => x.id === concurrent[0][0] && x.terminalData === refreshed)
      && s.replay[concurrent[0][0]] === refreshed, "new IndexedDB revision replaces old in-memory replay");
    pass("peer replay revision refreshes existing unsaved bytes");

    // Queue a peer deletion before an existing log's late capture. The real
    // Web Lock makes this interleaving deterministic without faking storage.
    const deletedCaptureId = concurrent[1][0];
    await call(a, "holdWrites");
    await call(b, "deleteLog", deletedCaptureId);
    await sleep(50);
    const token = await call(a, "startCapture", deletedCaptureId, payload("late-deleted-capture"));
    await sleep(50);
    await call(a, "resumeWrites");
    await call(a, "waitCapture", token);
    await converged([a, b], s => !s.logs.some(x => x.id === deletedCaptureId)
      && !s.diskLogs.some(x => x.id === deletedCaptureId) && !Object.hasOwn(s.replay, deletedCaptureId), "late capture must not resurrect peer-deleted log");
    concurrent.splice(1, 1);
    pass("late capture does not resurrect a peer deletion");

    // A controlled stale notification exercises the production event handler;
    // real cross-window event delivery is separately verified above.
    await call(a, "staleMetadataEvent", logs);
    await converged([a, b], s => concurrent.every(([id, data]) => s.logs.some(x => x.id === id && x.terminalData === data))
      && !s.logs.some(x => x.id === deletedCaptureId), "stale event reads current metadata without resurrecting deletion");
    pass("delayed stale notification cannot remove committed logs or restore deleted logs");

    await call(a, "deleteLog", "unsaved-040");
    await converged([a, b], s => !s.logs.some(x => x.id === "unsaved-040") && !s.diskLogs.some(x => x.id === "unsaved-040") && !Object.hasOwn(s.replay, "unsaved-040"), "deletion converges in metadata and IndexedDB");
    pass("delete removes matching replay in both windows");

    // A pruned metadata write can succeed while both replay destinations fail.
    // Failed replay ownership must not keep the already-committed addition or
    // metadata fields alive across a subsequent peer bookmark/deletion.
    async function failedCapture(label, startTime) {
      const data = payload(label);
      const result = await call(a, "failedAddAndCapture", log("ignored", startTime), data);
      assert.equal(result.persisted, false);
      assert.ok(result.faults.indexedDB > 0);
      assert.ok(result.faults.replayFallback > 0);
      const snapshot = await call(a, "snapshot");
      assert.equal(snapshot.diskLogs.find(x => x.id === result.id)?.saved, false);
      assert.equal(snapshot.diskLogs.find(x => x.id === result.id)?.terminalData, undefined);
      assert.equal(Object.hasOwn(snapshot.replay, result.id), false);
      await converged([b], s => s.logs.some(x => x.id === result.id), "peer sees metadata after failed replay capture");
      return { ...result, data };
    }
    const partialBookmark = await failedCapture("partial-write-bookmark", 4000);
    await call(b, "toggleSaved", partialBookmark.id);
    await converged([b], s => s.logs.some(x => x.id === partialBookmark.id && x.saved)
      && s.diskLogs.some(x => x.id === partialBookmark.id && x.saved), "peer bookmark commits after partial capture");
    assert.equal(await call(a, "capture", partialBookmark.id, partialBookmark.data), true);
    saved[partialBookmark.id] = partialBookmark.data;
    await converged([a, b], s => s.logs.some(x => x.id === partialBookmark.id && x.saved && x.terminalData === partialBookmark.data)
      && s.diskLogs.some(x => x.id === partialBookmark.id && x.saved && x.terminalData === partialBookmark.data), "partial-write retry retains peer bookmark and exact replay");
    pass("metadata-only success retires stale fields while retry preserves peer bookmark", { faults: partialBookmark.faults });

    const partialDelete = await failedCapture("partial-write-delete", 4001);
    await call(b, "deleteLog", partialDelete.id);
    await converged([b], s => !s.logs.some(x => x.id === partialDelete.id)
      && !s.diskLogs.some(x => x.id === partialDelete.id), "peer deletion commits after partial capture");
    assert.equal(await call(a, "capture", partialDelete.id, partialDelete.data), true);
    await converged([a, b], s => !s.logs.some(x => x.id === partialDelete.id)
      && !s.diskLogs.some(x => x.id === partialDelete.id) && !Object.hasOwn(s.replay, partialDelete.id), "partial-write retry never resurrects peer deletion");
    pass("metadata-only success retires addition ownership before peer deletion", { faults: partialDelete.faults });

    // Both renderer heaps are discarded; only persisted browser storage survives.
    a.destroy(); b.destroy();
    a = await makeWindow();
    state = await mount(a);
    for (const [id, data] of concurrent) assert.equal(state.logs.find(x => x.id === id)?.terminalData, data);
    for (const [id, data] of Object.entries(saved)) assert.equal(state.logs.find(x => x.id === id)?.terminalData, data);
    assert.equal(state.logs.some(x => x.id === "unsaved-040"), false);
    pass("fresh renderer reload preserves captures, bookmarks and deletion");

    b = await makeWindow();
    await mount(b);
    await call(b, "clearUnsaved");
    await converged([a, b], s => s.logs.length === Object.keys(saved).length && s.diskLogs.length === Object.keys(saved).length && s.logs.every(x => x.saved && x.terminalData === saved[x.id]) && Object.keys(s.replay).every(id => Object.hasOwn(saved, id)), "clear-unsaved preserves all bookmarked replay data");
    a.destroy(); b.destroy();
    const finalWindow = await makeWindow();
    state = await mount(finalWindow);
    assert.equal(state.logs.length, Object.keys(saved).length);
    for (const [id, data] of Object.entries(saved)) {
      assert.equal(state.logs.find(x => x.id === id)?.terminalData, data);
      assert.equal(state.diskLogs.find(x => x.id === id)?.terminalData, data);
    }
    pass("clear-unsaved and fresh renderer reload retain saved logs byte-for-byte", { saved: Object.keys(saved).length });
    await finish(0);
  }).catch(error => finish(1, error));
}
