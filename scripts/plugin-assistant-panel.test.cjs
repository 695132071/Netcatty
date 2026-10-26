"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

async function fixture(t, options = {}) {
  const root = path.resolve(__dirname, "../examples/plugins/assistant");
  const dom = new JSDOM(fs.readFileSync(path.join(root, "panel.html"), "utf8"), { runScripts: "outside-only" });
  t.after(() => dom.window.close());
  let now = 0; let opens = 0; let modelCalls = 0; let changed = false;
  const calls = [];
  const element = (id) => dom.window.document.getElementById(id);
  dom.window.Date.now = () => now;
  Object.defineProperty(dom.window, "netcattyView", { value: {
    onDidReceiveMessage: () => () => {},
    executeCommand: async (id, params) => {
      const operation = id.replace("com.netcatty.assistant.", ""); calls.push({ operation, params });
      if (operation === "open") {
        const count = ++opens;
        if (count > 1 && options.opening) await options.opening;
        return { chatHandle: `chat-${count}`, model: `Synthetic model ${count}`, expiresAt: now + 300_000 };
      }
      if (operation === "contexts") return [];
      if (operation === "close" || operation === "stop") return { ok: true };
      if (operation === "send") {
        if (params.chatHandle === "chat-1" && (changed || now >= 300_000)) throw Error("Session unavailable");
        modelCalls++;
        if (options.uncertain) throw Error("Reply lost after invocation");
        return { turnHandle: "synthetic-turn" };
      }
      if (operation === "read") return { kind: "end", sequence: 0 };
      throw Error(`Unexpected operation ${operation}`);
    },
  } });
  const waitFor = async (condition) => {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
      if (Date.now() >= deadline) throw Error(`Panel state timed out: ${element("status").textContent}`);
      await new Promise(setImmediate);
    }
  };
  dom.window.eval(fs.readFileSync(path.join(root, "panel.js"), "utf8"));
  await waitFor(() => element("status").textContent === "Ready");
  element("prompt").value = "Synthetic draft must survive session recovery";
  return { element, calls, waitFor, opens: () => opens, modelCalls: () => modelCalls,
    timeTo: (value) => { now = value; }, changeModel: () => { changed = true; },
    send: () => element("compose").dispatchEvent(new dom.window.Event("submit", { cancelable: true })) };
}

test("expired sample chat reopens before one explicit send and preserves the draft", async (t) => {
  const f = await fixture(t); f.timeTo(300_001); f.send();
  await f.waitFor(() => !f.element("prompt").disabled);
  assert.equal(f.opens(), 2);
  assert.deepEqual(f.calls.filter((call) => call.operation === "send").map((call) => call.params.chatHandle), ["chat-2"]);
  assert.equal(f.modelCalls(), 1);
  assert.equal(f.element("status").textContent, "Complete");
  assert.match(f.element("prompt").value, /must survive/);
});

test("changed-model rejection offers explicit reopen without automatically resending", async (t) => {
  const f = await fixture(t); f.changeModel(); f.send();
  await f.waitFor(() => !f.element("prompt").disabled);
  assert.equal(f.opens(), 1); assert.equal(f.modelCalls(), 0);
  assert.ok(f.element("refresh"), "A changed model needs an explicit session refresh control");
  f.element("refresh").click(); await f.waitFor(() => f.element("status").textContent === "Ready");
  assert.equal(f.opens(), 2); assert.equal(f.modelCalls(), 0);
  assert.match(f.element("model").textContent, /model 2/);
  assert.match(f.element("prompt").value, /must survive/);
  f.send(); await f.waitFor(() => f.element("status").textContent === "Complete");
  assert.equal(f.modelCalls(), 1);
});

test("uncertain inference outcome is never automatically retried by session refresh", async (t) => {
  const f = await fixture(t, { uncertain: true }); f.send();
  await f.waitFor(() => !f.element("prompt").disabled);
  assert.equal(f.modelCalls(), 1); assert.equal(f.opens(), 1);
  assert.ok(f.element("refresh"), "Recovery must reopen only, never retry inference");
  f.element("refresh").click(); await f.waitFor(() => f.element("status").textContent === "Ready");
  assert.equal(f.opens(), 2); assert.equal(f.modelCalls(), 1);
  assert.match(f.element("prompt").value, /must survive/);
});

test("Stop during expired-session reopening discards the late session without sending", async (t) => {
  let resume; const opening = new Promise((resolve) => { resume = resolve; });
  t.after(() => resume());
  const f = await fixture(t, { opening }); f.timeTo(300_001); f.send();
  await f.waitFor(() => f.opens() === 2);
  f.element("stop").click(); resume();
  await f.waitFor(() => f.calls.some((call) => call.operation === "close" && call.params.chatHandle === "chat-2"));
  assert.equal(f.modelCalls(), 0); assert.equal(f.element("status").textContent, "Stopped");
  assert.match(f.element("prompt").value, /must survive/);
});
