"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

test("Starter panel renders the actual command result as text and reports denial", async () => {
  const root = path.resolve(__dirname, "../../examples/plugins/starter-netcatty");
  const plugin = (await import(pathToFileURL(path.join(root, "dist/index.js")).href)).default;
  let command;
  let receive;
  let click;
  const elements = new Map(["greet", "result", "title", "description"].map((id) => [id, {
    textContent: "", disabled: false, addEventListener(_event, callback) { click = callback; },
  }]));
  const greeting = '<img src=x onerror="alert(1)"> synthetic hello';
  await plugin.activate({
    subscriptions: { add() {} },
    commands: { registerCommand(id, handler) { assert.equal(id, "com.netcatty.starter.greet"); command = handler; } },
    settings: { get: async () => greeting },
    views: { postMessage: (_id, message) => receive?.(message) },
  });
  let deny = false;
  vm.runInNewContext(fs.readFileSync(path.join(root, "panel.js"), "utf8"), {
    document: { getElementById: (id) => elements.get(id), documentElement: { style: {} } },
    window: { netcattyView: {
      onDidChangeEnvironment: (listener) => listener({ locale: "en", theme: "light" }),
      onDidReceiveMessage: (listener) => { receive = listener; },
      executeCommand: async (id) => { assert.equal(id, "com.netcatty.starter.greet"); if (deny) throw new Error("Denied"); return command(); },
    } },
  });
  await click();
  assert.equal(elements.get("result").textContent, greeting);
  assert.equal(elements.get("greet").disabled, false);
  deny = true;
  await click();
  assert.match(elements.get("result").textContent, /Check permission approval/);
  assert.equal(elements.get("greet").disabled, false);
});
