"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createDownloadStore } = require("./downloadStore.cjs");

test("download history stays local to its host and survives restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "host-browser-downloads-"));
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
