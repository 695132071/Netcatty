"use strict";
/* global __dirname, setImmediate */
const test = require("node:test"); const assert = require("node:assert/strict");
const fs = require("node:fs"); const path = require("node:path"); const { JSDOM } = require("jsdom");

test("global Chat sample follows host theme and preserves drafts on explicit target expiry without re-sharing or retrying", async (t) => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "panel.html"), "utf8"), { runScripts: "outside-only" });
  let now = 1; let environment; let selections = 0; let sends = 0; let disposed = 0;
  const calls = [];
  dom.window.Date.now = () => now;
  Object.defineProperty(dom.window, "netcattyView", { value: {
    onDidChangeEnvironment: (callback) => { environment = callback; return { dispose: () => disposed++ }; }, onDidReceiveMessage: () => ({ dispose() {} }),
    executeCommand: async (name) => {
      const op = name.split(".").at(-1); calls.push(op);
      if (op === "backends") return { items: [{ backendRef: "host-ref", label: "Synthetic configured Catty", status: "supported", reason: "ready" }] };
      if (op === "chats" || op === "history") return { items: [] };
      if (op === "targets") { selections++; return { selectionHandle: "selection", expiresAt: now + 300_000, items: [{ title: "Synthetic terminal" }] }; }
      if (op === "open") return { chatHandle: "chat", backendLabel: "Synthetic Catty", expiresAt: now + 300_000 };
      if (op === "send") { sends++; throw Error("Synthetic denied send"); }
      return { ok: true };
    },
  } });
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event("pagehide")); dom.window.close(); });
  const element = (id) => dom.window.document.getElementById(id);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
  dom.window.eval(fs.readFileSync(path.join(__dirname, "panel.js"), "utf8")); await settle();
  environment({ theme: "light", themeTokens: { "--primary": "120 70% 40%" } });
  assert.equal(dom.window.document.documentElement.dataset.theme, "light"); assert.equal(dom.window.document.documentElement.style.getPropertyValue("--primary"), "120 70% 40%");
  environment({ theme: "dark", themeTokens: {} }); assert.equal(dom.window.document.documentElement.dataset.theme, "dark");
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--primary"), "");
  element("targets").click(); await settle(); element("open").click(); await settle();
  element("prompt").value = "Keep this synthetic draft"; now += 300_001;
  const send = () => element("compose").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  send(); await settle(); assert.match(element("status").textContent, /expired/); assert.equal(sends, 0); assert.equal(selections, 1);
  element("refresh").click(); await settle(); element("open").click(); await settle();
  assert.match(element("status").textContent, /expired/); assert.equal(selections, 1); assert.equal(element("prompt").value, "Keep this synthetic draft");
  element("targets").click(); await settle(); element("open").click(); await settle();
  send(); await settle(); assert.equal(sends, 1); assert.equal(selections, 2); assert.match(element("status").textContent, /Request ended/);
  await settle(); assert.equal(sends, 1, "a failed inference is never automatically retried");
  assert.equal(element("prompt").value, "Keep this synthetic draft"); assert.ok(calls.includes("history")); assert.equal(disposed, 0);
});
