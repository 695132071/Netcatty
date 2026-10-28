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
  const stylesheet = dom.window.document.createElement("style");
  stylesheet.textContent = fs.readFileSync(path.join(root, "panel.css"), "utf8");
  dom.window.document.head.append(stylesheet);
  let now = 0; let opens = 0; let modelCalls = 0; let changed = false;
  const calls = [];
  const environmentListeners = new Set(); let environment;
  const element = (id) => dom.window.document.getElementById(id);
  dom.window.Date.now = options.clock ?? (() => now);
  Object.defineProperty(dom.window, "netcattyView", { value: {
    onDidReceiveMessage: () => () => {},
    onDidChangeEnvironment: (listener) => {
      environmentListeners.add(listener);
      if (environment) {
        const replay = environment;
        queueMicrotask(() => { if (environmentListeners.has(listener) && replay === environment) listener(replay); });
      }
      return { dispose: () => environmentListeners.delete(listener) };
    },
    executeCommand: async (id, params) => {
      const operation = id.replace("com.netcatty.assistant.", ""); calls.push({ operation, params });
      if (options.commands) return options.commands(operation, structuredClone(params));
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
  return { element, calls, waitFor, window: dom.window, opens: () => opens, modelCalls: () => modelCalls,
    emitEnvironment: (value) => { environment = value; for (const listener of environmentListeners) listener(value); },
    environmentListeners: () => environmentListeners.size,
    timeTo: (value) => { now = value; }, changeModel: () => { changed = true; },
    send: () => element("compose").dispatchEvent(new dom.window.Event("submit", { cancelable: true })) };
}

test("assistant follows host light/dark and accent updates with safe fallbacks and subscription cleanup", async (t) => {
  const f = await fixture(t); const root = f.window.document.documentElement;
  const computed = () => f.window.getComputedStyle(root);
  const calls = f.calls.length;
  assert.equal(computed().colorScheme, "light dark");
  assert.equal(computed().getPropertyValue("--background").trim(), "0 0% 100%");
  assert.equal(f.environmentListeners(), 1);
  f.emitEnvironment({ theme: "light", themeTokens: { "--background": "20 20% 98%", "--primary": "145 60% 35%", "--muted": "30 10% 90%", "--private-token": "ignored" } });
  assert.equal(root.style.colorScheme, "light"); assert.equal(root.dataset.theme, "light");
  assert.equal(root.style.getPropertyValue("--primary"), "145 60% 35%");
  assert.equal(root.style.getPropertyValue("--private-token"), "");
  f.emitEnvironment({ theme: "dark", themeTokens: { "--background": "220 20% 10%", "--primary": "280 80% 75%" } });
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(root.style.getPropertyValue("--primary"), "280 80% 75%");
  assert.equal(root.style.getPropertyValue("--muted"), "");
  assert.equal(computed().getPropertyValue("--muted").trim(), "219 27% 21%");
  f.emitEnvironment({ theme: "light", themeTokens: { "--primary": "x".repeat(97) } });
  assert.equal(root.style.colorScheme, "light"); assert.equal(root.style.getPropertyValue("--primary"), "");
  assert.equal(computed().getPropertyValue("--background").trim(), "0 0% 100%");
  f.emitEnvironment({ theme: "system" }); assert.equal(root.style.colorScheme, "light dark");
  assert.equal(f.calls.length, calls); assert.equal(f.modelCalls(), 0);
  f.window.dispatchEvent(new f.window.Event("pagehide")); assert.equal(f.environmentListeners(), 0);
  f.emitEnvironment({ theme: "dark", themeTokens: { "--primary": "210 90% 70%" } });
  assert.equal(root.style.colorScheme, "light dark");
  f.window.dispatchEvent(new f.window.Event("pageshow"));
  await new Promise(setImmediate);
  assert.equal(f.environmentListeners(), 1); assert.equal(root.style.colorScheme, "dark");
  assert.equal(root.style.getPropertyValue("--primary"), "210 90% 70%");
});

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

test("expired real selected Note requires explicit re-selection and fresh content permission without duplicate review", async (t) => {
  const { PluginAIContextService } = require("../electron/plugins/ai/aiContextService.cjs");
  let now = 0; let selections = 0; let reads = 0; let modelCalls = 0;
  let contentAllowed = false;
  const grants = []; const reviews = [];
  const caller = { pluginId: "com.netcatty.assistant", runtimeId: "selected-note-panel", pluginVersion: "0.1.0", assertActive: async () => {} };
  const source = { id: "synthetic-source", kind: "third-party", origin: "https://synthetic.example" };
  const service = new PluginAIContextService({
    database: {
      getActivePlugin: () => ({ source, enabled: true, activeVersion: caller.pluginVersion, runtime: { status: "running" } }),
      getRetainedPluginSource: () => source, privateOwner: () => "synthetic-private-owner", publicPluginId: () => caller.pluginId,
    },
    getRuntimeIdentity: () => ({ ...caller, runtimeKind: "browser" }),
    permissionEngine: { onDidRevoke: () => ({ dispose() {} }), authorize: async (_caller, grant) => {
      grants.push(grant); if (!contentAllowed) throw Error("Synthetic content grant denied");
    } },
    hostAdapter: {
      assertActive: async () => {},
      selectModel: async () => ({ label: "Synthetic model", isCurrent: () => true, invoke: () => {
        modelCalls++; return (async function* () { yield { kind: "text", text: "Synthetic summary" }; })();
      } }),
      listSelected: async () => {
        selections++;
        return [{ key: "synthetic-note", scope: "note", title: "Synthetic selected Note", version: "v1", isCurrent: () => true,
          readText: () => { reads++; return "Synthetic selected Note body"; } }];
      },
      reviewText: async (text) => { reviews.push(text); throw Error("Unexpected duplicate content review"); },
    },
  });
  service.selected.clock = () => now; service.broker.clock = () => now;
  t.after(() => service.shutdown());
  const commands = {
    open: () => service.open({}, caller), contexts: async () => (await service.list({}, caller)).items,
    send: (params) => service.start(params, caller), read: (params) => service.read(params, caller),
    stop: (params) => service.stop(params, caller), close: (params) => service.close(params, caller),
  };
  const f = await fixture(t, { clock: () => now, commands: (operation, params) => commands[operation](params) });
  const selector = f.element("context"); const oldHandle = selector.options[1].value;
  selector.value = oldHandle;
  now = 300_001;
  f.send(); await f.waitFor(() => !f.element("prompt").disabled);
  assert.match(f.element("status").textContent, /reference expired/i);
  assert.equal(f.calls.filter((call) => call.operation === "send").length, 0);
  assert.equal(selections, 1); assert.equal(modelCalls, 0); assert.equal(reads, 0);
  await assert.rejects(service.selected.assertCurrent({ handle: oldHandle, version: "v1" }, caller));
  f.element("refresh").click(); await f.waitFor(() => f.element("status").textContent === "Ready");
  assert.equal(selections, 1); // Refresh model must not silently share the Note again.
  f.send(); await f.waitFor(() => !f.element("prompt").disabled);
  assert.match(f.element("status").textContent, /reference expired/i);
  assert.ok(f.element("choose-reference"));
  f.element("choose-reference").click(); await f.waitFor(() => f.element("status").textContent.startsWith("References updated"));
  assert.equal(selections, 2); assert.equal(selector.value, "");
  const newHandle = selector.options[1].value;
  assert.notEqual(newHandle, oldHandle);
  const [fresh] = await service.selected.summaries(caller);
  assert.equal(fresh.handle, newHandle); assert.equal(fresh.expiresAt, 600_001);
  await assert.rejects(service.selected.assertCurrent({ handle: oldHandle, version: "v1" }, caller));
  assert.equal(reads, 0); assert.equal(grants.length, 0); assert.equal(modelCalls, 0);
  selector.value = newHandle;
  f.send(); await f.waitFor(() => f.element("status").textContent.startsWith("Request ended"));
  assert.equal(grants.length, 1); assert.equal(reads, 0); assert.equal(modelCalls, 0);
  contentAllowed = true;
  f.send(); await f.waitFor(() => f.element("status").textContent === "Complete");
  assert.equal(modelCalls, 1); assert.equal(reviews.length, 0);
  assert.ok(grants.every((grant) => grant.permission === "context.selected.read" && grant.allowedScopes[0] === "once"
    && grant.resources[0] === `selected:${newHandle}:v1`));
  assert.match(f.element("prompt").value, /must survive/);
  // Repeat with both lifetimes expired, without manually refreshing the model.
  now = 600_002;
  f.send(); await f.waitFor(() => !f.element("prompt").disabled);
  assert.match(f.element("status").textContent, /reference expired/i);
  assert.equal(modelCalls, 1); assert.equal(selections, 2);
  f.element("choose-reference").click(); await f.waitFor(() => f.element("status").textContent.startsWith("References updated"));
  const repeatedHandle = selector.options[1].value;
  assert.notEqual(repeatedHandle, newHandle); assert.equal(selector.value, "");
  selector.value = repeatedHandle;
  f.send(); await f.waitFor(() => f.element("status").textContent === "Complete");
  assert.equal(modelCalls, 2); assert.equal(grants.at(-1).resources[0], `selected:${repeatedHandle}:v1`);
  await assert.rejects(service.selected.assertCurrent({ handle: newHandle, version: "v1" }, caller));
  assert.match(f.element("prompt").value, /must survive/);
});
