"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { normalizeBrowserUrl } = require("./hostBrowserManager.cjs");

test("browser addresses accept bare localhost and domain ports", () => {
  assert.equal(normalizeBrowserUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizeBrowserUrl("localhost:3000/app"), "http://localhost:3000/app");
  assert.equal(normalizeBrowserUrl("127.0.0.1:8080"), "http://127.0.0.1:8080/");
  assert.equal(normalizeBrowserUrl("example.com:8080"), "https://example.com:8080/");
  assert.equal(normalizeBrowserUrl("https://example.com/app"), "https://example.com/app");
});

test("browser addresses keep rejecting external protocols and credentials", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "mailto:test@example.com", "https://user:password@example.com/"]) {
    assert.throws(() => normalizeBrowserUrl(url));
  }
});

test("late download notifications ignore closed browser chrome in a live terminal", () => {
  const source = readFileSync(require.resolve("./hostBrowserManager.cjs"), "utf8");
  const start = source.indexOf("const notifyDownloads =");
  const end = source.indexOf("const snapshot =", start);
  assert.ok(start > 0 && end > start);
  const record = {
    hostId: "host",
    win: { isDestroyed: () => false },
    chromeContents: {
      isDestroyed: () => true,
      send: () => { throw new Error("Object has been destroyed"); },
    },
    downloadsPanelOpen: false,
  };
  const notify = vm.runInNewContext(`${source.slice(start, end)};notifyDownloads;`, {
    downloadStore: { list: () => [] },
    windows: new Map([["closed", record]]),
  });
  assert.doesNotThrow(() => notify(record));
});
