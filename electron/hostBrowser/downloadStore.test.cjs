"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { createDownloadStore } = require("./downloadStore.cjs");
const { reserveDownloadFile } = require("./downloadFile.cjs");
const { getTempFilePath } = require("../bridges/tempDirBridge.cjs");

test("download history stays local to its host and survives restart", () => {
  const directory = fs.mkdtempSync(getTempFilePath("host-browser-downloads-"));
  try {
    const app = { getPath: () => directory };
    const file = path.join(directory, "download.bin");
    fs.writeFileSync(file, "downloaded");
    const first = createDownloadStore(app);
    first.upsert({ id: "one", hostId: "host-a", filename: "download.bin", status: "completed",
      savePath: file, received: 10, total: 10, startedAt: 100 });
    first.upsert({ id: "two", hostId: "host-b", filename: "other.bin", status: "waiting", startedAt: 200 });
    assert.equal(first.list("host-b").length, 1);
    const restored = createDownloadStore(app);
    assert.equal(restored.list("host-a")[0].status, "completed");
    assert.equal(restored.list("host-b")[0].status, "interrupted");
    fs.unlinkSync(file);
    assert.equal(restored.list("host-a")[0].missing, true);
    restored.clearFinished("host-a");
    assert.equal(restored.list("host-a").length, 0);
    assert.equal(restored.list("host-b").length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("automatic downloads reserve separate names without replacing existing files", (t) => {
  const directory = fs.mkdtempSync(getTempFilePath("host-browser-download-names-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "report.txt"), "existing file");
  fs.mkdirSync(path.join(directory, "report (1).txt"));
  const first = reserveDownloadFile(directory, "report.txt");
  const second = reserveDownloadFile(directory, "report.txt");
  assert.equal(path.basename(first.savePath), "report (2).txt");
  assert.equal(path.basename(second.savePath), "report (3).txt");
  assert.equal(fs.readFileSync(path.join(directory, "report.txt"), "utf8"), "existing file");
  first.cleanupEmpty();
  assert.equal(fs.existsSync(first.savePath), false);
  fs.writeFileSync(second.savePath, "downloaded content");
  second.cleanupEmpty();
  assert.equal(fs.readFileSync(second.savePath, "utf8"), "downloaded content");
});

test("cleanup removes only its own empty reservation", (t) => {
  const directory = fs.mkdtempSync(getTempFilePath("host-browser-download-cleanup-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reserved = reserveDownloadFile(directory, "../report.txt");
  assert.equal(reserved.savePath, path.join(directory, "report.txt"));
  const otherFile = path.join(directory, "replacement");
  fs.writeFileSync(otherFile, "");
  fs.renameSync(otherFile, reserved.savePath);
  reserved.cleanupEmpty();
  assert.equal(fs.existsSync(reserved.savePath), true, "a replacement made by someone else is left alone");
});

function progressFixture(t) {
  const vm = require("node:vm");
  const directory = fs.mkdtempSync(getTempFilePath("host-browser-progress-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "host-browser-downloads.json");
  const timers = new Map();
  let nextTimer = 0;
  let writes = 0;
  let fail = false;
  const warnings = [];
  const fakeFs = { ...fs, writeFileSync(...args) {
    if (fail) throw new Error("disk full");
    writes++;
    return fs.writeFileSync(...args);
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve("./downloadStore.cjs"), "utf8"), {
    module, process, console: { warn: (...args) => warnings.push(args) },
    require: (name) => name === "node:fs" ? fakeFs : require(name),
    setTimeout(fn, delay) { assert.equal(delay, 1000); const token = { id: ++nextTimer, unref() {} }; timers.set(token, fn); return token; },
    clearTimeout(token) { timers.delete(token); },
  });
  const store = module.exports.createDownloadStore({ getPath: () => directory });
  const row = { id: "active", hostId: "a", filename: "file.zip", savePath: path.join(directory, "file.zip"), status: "progressing", startedAt: 1, total: 100, received: 0 };
  return { store, row, timers, warnings, get writes() { return writes; }, fail(value) { fail = value; },
    saved: () => JSON.parse(fs.readFileSync(file, "utf8")),
    tick() { const callbacks = [...timers.values()]; timers.clear(); for (const fn of callbacks) fn(); },
  };
}

test("progress is immediate in memory and coalesced across downloads, then terminal state is durable", (t) => {
  const f = progressFixture(t);
  f.store.upsert(f.row);
  f.store.upsert({ ...f.row, id: "second" });
  for (let received = 1; received <= 20; received++) {
    for (const id of ["active", "second"]) f.store.upsert({ ...f.row, id, received }, { deferProgress: true });
  }
  assert.equal(f.writes, 2);
  assert.equal(f.timers.size, 1);
  assert.equal(f.store.list("a")[0].received, 20);
  assert.equal(f.saved()[0].received, 0);
  f.tick();
  assert.equal(f.writes, 3);
  assert.equal(f.saved()[0].received, 20);
  f.store.upsert({ ...f.row, received: 50 }, { deferProgress: true });
  f.store.upsert({ ...f.row, status: "completed", received: 100, endedAt: 2 });
  assert.equal(f.timers.size, 0);
  assert.equal(f.saved().find((item) => item.id === "active").status, "completed");
  f.tick();
  assert.equal(f.writes, 4);
});

test("new records, metadata and interrupted/cancelled transitions never defer", (t) => {
  const f = progressFixture(t);
  f.store.upsert(f.row, { deferProgress: true });
  assert.equal(f.writes, 1);
  for (const update of [{ savePath: "changed" }, { total: 200 }, { status: "interrupted" }, { status: "cancelled" }]) {
    const next = { ...f.store.get("a", "active"), ...update };
    const before = f.writes;
    f.store.upsert(next, { deferProgress: true });
    assert.equal(f.writes, before + 1);
    assert.equal(f.timers.size, 0);
  }
  assert.throws(() => f.store.upsert({ ...f.row, hostId: "b" }, { deferProgress: true }), /another host/);
  assert.equal(f.store.get("a", "active").status, "cancelled");
});

test("flush persists pending progress and removal cannot be resurrected by a pending timer", (t) => {
  const f = progressFixture(t);
  f.store.upsert(f.row);
  f.store.upsert({ ...f.row, received: 10 }, { deferProgress: true });
  f.store.flush();
  assert.equal(f.timers.size, 0);
  assert.equal(f.saved()[0].received, 10);
  f.store.flush();
  assert.equal(f.writes, 2);
  f.store.upsert({ ...f.row, id: "finished", status: "completed" });
  f.store.upsert({ ...f.row, received: 20 }, { deferProgress: true });
  assert.equal(f.store.remove("b", "finished"), false);
  assert.equal(f.store.remove("a", "active"), false);
  assert.equal(f.store.remove("a", "finished"), true);
  assert.equal(f.timers.size, 0);
  f.tick();
  assert.equal(f.saved().length, 1);
  assert.equal(f.saved()[0].received, 20);
  f.store.upsert({ ...f.row, id: "finished", status: "cancelled" });
  f.store.upsert({ ...f.row, received: 30 }, { deferProgress: true });
  f.store.clearFinished("a");
  assert.equal(f.timers.size, 0);
  assert.equal(f.saved().length, 1);
  assert.equal(f.saved()[0].received, 30);
});

test("failed deferred writes retain dirty state, preserve disk snapshot and do not spin", (t) => {
  const f = progressFixture(t);
  f.store.upsert(f.row);
  f.store.upsert({ ...f.row, received: 10 }, { deferProgress: true });
  f.fail(true);
  assert.doesNotThrow(() => f.tick());
  assert.equal(f.warnings.length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.saved()[0].received, 0);
  assert.throws(() => f.store.flush(), /disk full/);
  f.fail(false);
  f.store.flush();
  assert.equal(f.saved()[0].received, 10);
  assert.equal(f.timers.size, 0);
});
