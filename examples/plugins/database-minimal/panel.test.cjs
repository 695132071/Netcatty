"use strict";
/* global __dirname */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

test("the example clears session passwords before dispatch and renders result text safely", async () => {
  const elements = new Map();
  for (const id of ["username", "password", "query", "cancel", "result", "form", "endpoint"]) {
    const element = { value: "", textContent: "", disabled: false, listeners: {},
      addEventListener(event, listener) { this.listeners[event] = listener; },
    };
    Object.defineProperty(element, "innerHTML", { set() { throw new Error("HTML output is forbidden"); } });
    elements.set(id, element);
  }
  elements.get("username").value = "plugin_demo";
  elements.get("password").value = "synthetic-session-only";
  let settle;
  let submitted;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "panel.js"), "utf8"), {
    document: { getElementById: (id) => elements.get(id), documentElement: { style: { setProperty() {}, removeProperty() {} } } },
    window: { netcattyView: {
      onDidChangeEnvironment() {},
      executeCommand: async (name, params) => {
        if (name.endsWith(".endpoint")) return { endpoint: "tcp://172.30.247.2:3306" };
        assert.ok(name.endsWith(".query"));
        assert.equal(elements.get("password").value, "");
        submitted = params;
        return new Promise((resolve) => { settle = resolve; });
      },
    } },
  });
  const pending = elements.get("form").listeners.submit({ preventDefault() {} });
  assert.equal(submitted.password, "synthetic-session-only");
  assert.equal(elements.get("query").disabled, true);
  settle({ columns: ["value"], rows: [["<img src=x onerror=alert(1)>"]] });
  await pending;
  assert.equal(submitted.password, "");
  assert.equal(elements.get("password").value, "");
  assert.equal(elements.get("query").disabled, false);
  assert.match(elements.get("result").textContent, /<img/u);
  const html = fs.readFileSync(path.join(__dirname, "panel.html"), "utf8");
  assert.match(html, /id="password"[^>]*type="password"/u);
});
