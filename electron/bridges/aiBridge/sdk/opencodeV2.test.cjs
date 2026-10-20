const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter, getEventListeners } = require("node:events");
const { createAiPrivacyService } = require("../../../shared/aiPrivacyService.cjs");
const {
  buildOpenCodeBasicAuthorization,
  buildOpenCodeV2ConfigContent,
  mergeOpenCodeV2ConfigContent,
  createOpenCodeServeStartupParser,
  createOpenCodeV2Client,
  detectOpenCodeCliVersion,
  isOpenCodeV2Version,
  listOpenCodeV2Models,
  mapOpenCodeV2Catalog,
  parseOpenCodeVersionOutput,
  resetOpenCodeVersionCache,
  runOpenCodeV2Turn,
  translateOpenCodeV2Event,
  waitForOpenCodeChildReady,
} = require("./opencodeV2.cjs");
const { listOpenCodeModels, resetOpenCodeListServerPool, runOpenCodeTurn } = require("./opencodeDriver.cjs");

test("parseOpenCodeVersionOutput distinguishes OpenCode 1.x from 2.x", () => {
  assert.deepEqual(parseOpenCodeVersionOutput("v2.1.0\n"), { major: 2, minor: 1, patch: 0 });
  assert.deepEqual(parseOpenCodeVersionOutput("2.1.0"), { major: 2, minor: 1, patch: 0 });
  assert.deepEqual(parseOpenCodeVersionOutput("opencode version 1.19.3"), { major: 1, minor: 19, patch: 3 });
  assert.equal(parseOpenCodeVersionOutput("v2.0.0-beta.1").major, 2);
  assert.equal(parseOpenCodeVersionOutput(""), null);
  assert.equal(parseOpenCodeVersionOutput("not a version"), null);
  assert.equal(parseOpenCodeVersionOutput("listening on 127.0.0.1:4096"), null);
  assert.equal(
    parseOpenCodeVersionOutput("TypeError: Cannot read properties of undefined (reading 'split')\nNode.js v22.23.1\n"),
    null,
  );
  assert.equal(parseOpenCodeVersionOutput("panic: failed\nBun v1.3.14 (linux x64)\n"), null);
  assert.deepEqual(parseOpenCodeVersionOutput("v2.1.0\nNode.js v22.23.1\n"), { major: 2, minor: 1, patch: 0 });
  assert.deepEqual(parseOpenCodeVersionOutput("v2.1.0\nBun v1.3.14\n"), { major: 2, minor: 1, patch: 0 });
  assert.equal(isOpenCodeV2Version(parseOpenCodeVersionOutput("v2.1.0")), true);
  assert.equal(isOpenCodeV2Version(parseOpenCodeVersionOutput("1.19.3")), false);
  assert.equal(isOpenCodeV2Version(null), false);
});

test("version cache follows the PATH binary when OpenCode is replaced", async () => {
  resetOpenCodeVersionCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-version-cache-"));
  const bin = path.join(dir, "opencode");
  fs.writeFileSync(bin, "#!/bin/sh\necho v1.19.3\n", { mode: 0o755 });
  try {
    const env = { PATH: `${dir}${path.delimiter}${process.env.PATH || ""}` };
    const first = await detectOpenCodeCliVersion({ env });
    assert.equal(first.major, 1);
    fs.writeFileSync(bin, "#!/bin/sh\necho v2.1.0\n", { mode: 0o755 });
    const replacedAt = new Date(Date.now() + 2000);
    fs.utimesSync(bin, replacedAt, replacedAt);
    const replaced = await detectOpenCodeCliVersion({ env });
    assert.equal(replaced.major, 2);
  } finally {
    resetOpenCodeVersionCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a crashed --version probe is not classified as OpenCode 2", async () => {
  resetOpenCodeVersionCache();
  const crash = "TypeError: Cannot read properties of undefined (reading 'split')\nNode.js v22.23.1\n";
  const version = await detectOpenCodeCliVersion({
    binPath: "opencode",
    execFileImpl: (_command, _args, _options, callback) => {
      const error = new Error("opencode --version failed");
      error.code = 1;
      callback(error, "", crash);
    },
  });
  assert.equal(version, null);
  assert.equal(isOpenCodeV2Version(version), false);
});

test("a Bun crash banner is not cached as OpenCode 1.x", async () => {
  resetOpenCodeVersionCache();
  let calls = 0;
  const probe = () => detectOpenCodeCliVersion({
    binPath: "opencode",
    execFileImpl: (_command, _args, _options, callback) => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("opencode --version failed");
        error.code = 1;
        callback(error, "", "panic: failed\nBun v1.3.14 (linux x64)\n");
        return;
      }
      callback(null, "v2.1.0\n", "");
    },
  });
  assert.equal(await probe(), null);
  assert.equal((await probe()).major, 2);
  assert.equal(calls, 2);
});

test("OpenCode serve startup matches the 2.x banner and a split password line", () => {
  const parser = createOpenCodeServeStartupParser();
  assert.deepEqual(parser.push("server listen"), { url: null, password: null, ready: false });
  assert.deepEqual(
    parser.push("ing on http://127.0.0.1:4455\nser"),
    { url: "http://127.0.0.1:4455", password: null, ready: true },
  );
  assert.deepEqual(
    parser.push("ver password zNAK.secret\n"),
    { url: "http://127.0.0.1:4455", password: "zNAK.secret", ready: true },
  );

  const v1 = createOpenCodeServeStartupParser();
  assert.deepEqual(
    v1.push("opencode server listening on http://127.0.0.1:4096\n"),
    { url: "http://127.0.0.1:4096", password: null, ready: true },
  );
});

test("startup waiter captures a late password and never returns server spam", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 42;
  let stopped = 0;
  const ready = waitForOpenCodeChildReady(child, {
    timeoutMs: 1000,
    passwordGraceMs: 30,
    stop: () => { stopped += 1; },
  });
  child.stdout.emit("data", Buffer.from("server listening on http://127.0.0.1:4096\n"));
  child.stderr.emit("data", Buffer.from("server password printed-secret\n"));
  const result = await ready;
  assert.equal(result.url, "http://127.0.0.1:4096");
  assert.equal(result.password, "printed-secret");
  assert.equal(stopped, 0);

  const timedOut = new EventEmitter();
  timedOut.stdout = new EventEmitter();
  timedOut.stderr = new EventEmitter();
  timedOut.pid = 43;
  const pending = waitForOpenCodeChildReady(timedOut, {
    timeoutMs: 20,
    passwordGraceMs: 500,
    stop: () => {},
  });
  timedOut.stderr.emit("data", Buffer.from("debug server password hunter2\nstill starting\n"));
  await assert.rejects(pending, (error) => {
    assert.equal(error.message, "ai.opencode.v2.startupTimeout");
    assert.equal(JSON.stringify(error).includes("hunter2"), false);
    return true;
  });
});

test("startup waiter reports an exit without the server log", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const pending = waitForOpenCodeChildReady(child, { timeoutMs: 1000, passwordGraceMs: 20, stop: () => {} });
  child.stderr.emit("data", Buffer.from("server password hunter2\npanic\n"));
  child.emit("exit", 7);
  await assert.rejects(pending, (error) => {
    assert.equal(error.message, "ai.opencode.v2.exited");
    assert.equal(JSON.stringify(error).includes("hunter2"), false);
    assert.equal(JSON.stringify(error).includes("panic"), false);
    return true;
  });
});

test("startup waiter resolves with the injected password when 2.x omits the password line", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const ready = waitForOpenCodeChildReady(child, { timeoutMs: 1000, passwordGraceMs: 20, stop: () => {} });
  child.stdout.emit("data", Buffer.from("server listening on http://127.0.0.1:4096\n"));
  const result = await ready;
  assert.equal(result.url, "http://127.0.0.1:4096");
  assert.equal(result.password, null);
});

test("2.x config keeps permissions and local MCP without the 1.x startup keys", () => {
  const content = buildOpenCodeV2ConfigContent({
    share: "disabled",
    autoupdate: false,
    permission: { edit: "deny", bash: "allow", read: { "*": "deny", "/tmp/**": "allow" } },
    mcp: {
      netcatty: { type: "local", command: ["node", "cli.js"], environment: { A: "b" }, enabled: true },
    },
    model: "openai/gpt-5",
  });
  assert.equal(content.share, "disabled");
  assert.equal(content.update, "disable");
  assert.equal(content.permission, undefined);
  assert.equal(content.autoupdate, undefined);
  assert.deepEqual(content.permissions, [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "bash", resource: "*", effect: "allow" },
    { action: "read", resource: "*", effect: "deny" },
    { action: "read", resource: "/tmp/**", effect: "allow" },
  ]);
  assert.deepEqual(content.mcp.servers.netcatty, {
    type: "local",
    command: ["node", "cli.js"],
    environment: { A: "b" },
    disabled: false,
  });
  assert.equal(content.model, "openai/gpt-5");
});

test("2.x config keeps caller providers and plugins", () => {
  const generated = buildOpenCodeV2ConfigContent({
    share: "disabled",
    autoupdate: false,
    model: "openai/gpt-5",
    mcp: { netcatty: { type: "local", command: ["node", "cli.js"], environment: {}, enabled: true } },
  });
  const merged = mergeOpenCodeV2ConfigContent(generated, JSON.stringify({
    username: "other",
    permission: { edit: "allow" },
    autoupdate: true,
    model: "anthropic/claude",
    providers: { local: { models: { coder: { modelID: "real" } } } },
    plugins: ["opencode-provider"],
    mcp: { servers: { extra: { type: "local", command: ["echo"] } } },
  }));
  assert.equal(merged.model, "openai/gpt-5");
  assert.equal(merged.username, undefined);
  assert.equal(merged.permission, undefined);
  assert.equal(merged.autoupdate, undefined);
  assert.deepEqual(merged.providers.local.models.coder, { modelID: "real" });
  assert.deepEqual(merged.plugins, ["opencode-provider"]);
  assert.deepEqual(merged.mcp.servers.extra, { type: "local", command: ["echo"] });
  assert.equal(merged.mcp.servers.netcatty.type, "local");
  assert.equal(mergeOpenCodeV2ConfigContent(generated, "not json"), generated);
});

test("mapOpenCodeV2Catalog uses provider and model ids from the 2.x payloads", () => {
  const catalog = mapOpenCodeV2Catalog(
    { data: [
      { providerID: "openai", modelID: "gpt-5", name: "GPT-5", enabled: true },
      { providerID: "openai", modelID: "hidden", name: "Hidden", enabled: false },
    ] },
    { data: [{ id: "openai", name: "OpenAI" }] },
    { data: { providerID: "openai", modelID: "gpt-5", name: "GPT-5" } },
  );
  assert.deepEqual(catalog, {
    currentModelId: "openai/gpt-5",
    models: [{ id: "openai/gpt-5", name: "OpenAI GPT-5" }],
  });

  const aliased = mapOpenCodeV2Catalog(
    { data: [
      { id: "coding-default", modelID: "gpt-5.2", providerID: "openai", name: "Coding default", enabled: true },
      { id: "anthropic/claude-sonnet-4.5", modelID: "claude-sonnet-4.5", providerID: "openrouter", name: "Sonnet", enabled: true },
    ] },
    { data: [{ id: "openai", name: "OpenAI" }, { id: "openrouter", name: "OpenRouter" }] },
    { data: { id: "coding-default", modelID: "gpt-5.2", providerID: "openai", name: "Coding default" } },
  );
  assert.deepEqual(aliased, {
    currentModelId: "openai/coding-default",
    models: [
      { id: "openai/coding-default", name: "OpenAI Coding default" },
      { id: "openrouter/anthropic/claude-sonnet-4.5", name: "OpenRouter Sonnet" },
    ],
  });
});

test("OpenCode 2 client sends Basic auth and hides unauthorized bodies", async () => {
  const requests = [];
  const password = "s3cret-value";
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/api/info")) {
      return new Response(`<html>server password ${password}</html>`, { status: 401, headers: { "content-type": "text/html" } });
    }
    if (String(url).includes("/api/model/default")) {
      return jsonResponse({ data: { providerID: "openai", modelID: "gpt-5", name: "GPT-5" } });
    }
    if (String(url).includes("/api/provider")) {
      return jsonResponse({ data: [{ id: "openai", name: "OpenAI" }] });
    }
    return jsonResponse({ data: [{ providerID: "openai", modelID: "gpt-5", name: "GPT-5", enabled: true }] });
  };
  const client = createOpenCodeV2Client({
    baseUrl: "http://127.0.0.1:4096",
    username: "opencode",
    password,
    fetchImpl,
  });
  assert.equal(client.authorization, buildOpenCodeBasicAuthorization("opencode", password));

  const catalog = await client.listCatalog(undefined, "/workspace");
  assert.equal(catalog.currentModelId, "openai/gpt-5");
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.init.headers.Authorization, client.authorization);
    assert.equal(request.init.headers.authorization, undefined);
  }
  const modelUrl = new URL(requests.find((request) => request.url.includes("/api/model") && !request.url.includes("default")).url);
  assert.equal(modelUrl.searchParams.get("location[directory]"), "/workspace");

  await assert.rejects(client.info(), (error) => {
    assert.equal(error.message, "ai.opencode.v2.unauthorized");
    assert.equal(JSON.stringify(error).includes(password), false);
    assert.equal(JSON.stringify(error).includes("<html>"), false);
    return true;
  });

  const implicit = createOpenCodeV2Client({
    baseUrl: "http://127.0.0.1:4096",
    password,
    fetchImpl: async () => jsonResponse({ data: {} }),
  });
  assert.equal(implicit.authorization, buildOpenCodeBasicAuthorization("opencode", password));
});

test("OpenCode 2 client hides undici transport failures", async () => {
  const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  const fetchFailed = new TypeError("fetch failed");
  fetchFailed.cause = cause;
  const failing = createOpenCodeV2Client({
    baseUrl: "http://127.0.0.1:4096",
    username: "opencode",
    password: "s3cret",
    fetchImpl: async () => { throw fetchFailed; },
  });
  await assert.rejects(failing.info(), (error) => {
    assert.equal(error.message, "ai.opencode.v2.unavailable");
    assert.equal(String(error).includes("fetch failed"), false);
    assert.equal(String(error).includes("other side closed"), false);
    return true;
  });

  const dropped = createOpenCodeV2Client({
    baseUrl: "http://127.0.0.1:4096",
    username: "opencode",
    password: "s3cret",
    fetchImpl: async () => ({
      status: 200,
      body: { cancel() {} },
      text: async () => { throw new TypeError("terminated"); },
    }),
  });
  await assert.rejects(dropped.info(), (error) => {
    assert.equal(error.message, "ai.opencode.v2.unavailable");
    assert.equal(String(error).includes("terminated"), false);
    return true;
  });
});

test("OpenCode 2 event stream handles rejected reader cancellation on abort", async () => {
  const abortController = new AbortController();
  let cancelled = false;
  const client = createOpenCodeV2Client({
    baseUrl: "http://127.0.0.1:4096",
    password: "synthetic-test-password",
    fetchImpl: async () => new Response(new ReadableStream({
      start() {},
      cancel() {
        cancelled = true;
        return Promise.reject(new Error("synthetic reader cancellation failure"));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  const stream = await client.openEventStream(abortController.signal);
  const next = stream.next();
  abortController.abort();
  assert.deepEqual(await next, { value: undefined, done: true });
  assert.equal(cancelled, true);
  assert.equal(getEventListeners(abortController.signal, "abort").length, 0);
  // Let node:test observe any unhandled cancellation rejection.
  await new Promise((resolve) => setImmediate(resolve));
});

test("listCatalog omits the location query when no directory is set", async () => {
  const urls = [];
  const client = createOpenCodeV2Client({
    baseUrl: "http://127.0.0.1:4096/",
    username: "opencode",
    password: "pw",
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes("/api/model/default")) return jsonResponse({ data: null });
      if (String(url).includes("/api/provider")) return jsonResponse({ data: [] });
      return jsonResponse({ data: [] });
    },
  });
  await client.listCatalog();
  assert.equal(urls.some((url) => url.includes("location")), false);
});

test("translateOpenCodeV2Event streams text, tools, and a safe session failure", () => {
  const events = [];
  const emitter = {
    text: (t) => events.push(["text", t]),
    reasoning: (t) => events.push(["reasoning", t]),
    reasoningEnd: () => events.push(["reasoningEnd"]),
    toolCall: (name, input, id) => events.push(["tool", name, input, id]),
    toolResult: (id, output, name) => events.push(["result", id, output, name]),
    emitError: (message) => events.push(["error", message]),
  };
  const state = { sessionID: "ses_1" };
  assert.equal(translateOpenCodeV2Event({
    type: "session.text.delta",
    data: { sessionID: "ses_1", delta: "Hello" },
  }, emitter, state).content, true);
  translateOpenCodeV2Event({
    type: "session.text.delta",
    data: { sessionID: "other", delta: "nope" },
  }, emitter, state);
  translateOpenCodeV2Event({
    type: "session.tool.input.started",
    data: { sessionID: "ses_1", id: "call_1", name: "bash" },
  }, emitter, state);
  translateOpenCodeV2Event({
    type: "session.tool.called",
    data: { sessionID: "ses_1", id: "call_1", input: { cmd: "ls" } },
  }, emitter, state);
  translateOpenCodeV2Event({
    type: "session.tool.failed",
    data: { sessionID: "ses_1", id: "call_1", error: { message: "command not found" } },
  }, emitter, state);
  const failed = translateOpenCodeV2Event({
    type: "session.execution.failed",
    data: { sessionID: "ses_1", error: { message: "server password hunter2\nstack" } },
  }, emitter, state);
  assert.equal(failed.error, true);
  assert.deepEqual(events, [
    ["text", "Hello"],
    ["tool", "bash", { cmd: "ls" }, "call_1"],
    ["result", "call_1", "command not found", "bash"],
    ["error", "ai.opencode.v2.sessionFailed"],
  ]);
  assert.equal(JSON.stringify(events).includes("hunter2"), false);
});

test("runOpenCodeV2Turn authenticates, keeps the user prompt unchanged, and streams the session", async () => {
  const requests = [];
  const encoder = new TextEncoder();
  const sse = new ReadableStream({
    start(controller) {
      const send = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      send({ type: "server.connected", data: {} });
      send({ type: "session.reasoning.delta", data: { sessionID: "ses_1", delta: "Think" } });
      send({ type: "session.reasoning.ended", data: { sessionID: "ses_1" } });
      send({ type: "session.text.delta", data: { sessionID: "ses_1", delta: "Hello" } });
      send({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } });
      controller.close();
    },
  });
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const path = new URL(url).pathname;
    if (path === "/api/session" && init.method === "POST") return jsonResponse({ data: { id: "ses_1" } });
    if (path.includes("/instructions/")) return new Response(null, { status: 204 });
    if (path === "/api/event") {
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/prompt")) return jsonResponse({ data: { id: "msg_1" } });
    return jsonResponse({ data: {} });
  };
  const events = [];
  let closed = false;
  const result = await runOpenCodeV2Turn({
    prompt: "hello",
    systemPrompt: "netcatty context",
    cwd: "/workspace",
    model: "openai/gpt-5",
    emitter: {
      sessionId: (id) => events.push(["session", id]),
      text: (t) => events.push(["text", t]),
      reasoning: (t) => events.push(["reasoning", t]),
      reasoningEnd: () => events.push(["reasoningEnd"]),
      emitDone: () => events.push(["done"]),
      emitError: (message) => events.push(["error", message]),
      warning: (id, message) => events.push(["warning", id, message]),
    },
    openCodeV2Factory: async () => ({
      client: createOpenCodeV2Client({
        baseUrl: "http://127.0.0.1:4096",
        username: "opencode",
        password: "s3cret",
        fetchImpl,
      }),
      server: { close: () => { closed = true; } },
    }),
  });

  assert.equal(result.sessionId, "ses_1");
  assert.equal(closed, true);
  assert.deepEqual(events, [
    ["session", "ses_1"],
    ["reasoning", "Think"],
    ["reasoningEnd"],
    ["text", "Hello"],
    ["done"],
  ]);
  const created = requests.find((request) => new URL(request.url).pathname === "/api/session");
  assert.deepEqual(JSON.parse(created.body).model, { id: "gpt-5", providerID: "openai" });
  const prompt = requests.find((request) => request.url.endsWith("/prompt"));
  assert.equal(JSON.parse(prompt.body).text, "hello");
  assert.equal(JSON.parse(prompt.body).text.includes("netcatty context"), false);
  const instruction = requests.find((request) => request.url.includes("/instructions/"));
  assert.equal(JSON.parse(instruction.body).value, "netcatty context");
  for (const request of requests) {
    assert.equal(request.headers.Authorization, buildOpenCodeBasicAuthorization("opencode", "s3cret"));
  }
});

test("runOpenCodeV2Turn continues when the instruction entry is rejected", async () => {
  const requests = [];
  const encoder = new TextEncoder();
  const sse = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        type: "session.text.delta",
        data: { sessionID: "ses_1", delta: "Hello" },
      })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        type: "session.execution.succeeded",
        data: { sessionID: "ses_1" },
      })}\n\n`));
      controller.close();
    },
  });
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method, body: init.body });
    const path = new URL(url).pathname;
    if (path === "/api/session" && init.method === "POST") return jsonResponse({ data: { id: "ses_1" } });
    if (path.includes("/instructions/")) {
      return new Response(JSON.stringify({ message: "value must be an object" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/api/event") {
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/prompt")) return jsonResponse({ data: { id: "msg_1" } });
    return jsonResponse({ data: {} });
  };
  const events = [];
  const result = await runOpenCodeV2Turn({
    prompt: "hello",
    systemPrompt: "netcatty context",
    emitter: {
      sessionId: (id) => events.push(["session", id]),
      text: (text) => events.push(["text", text]),
      emitDone: () => events.push(["done"]),
      emitError: (message) => events.push(["error", message]),
      warning: (id, message) => events.push(["warning", id, message]),
    },
    openCodeV2Factory: async () => ({
      client: createOpenCodeV2Client({
        baseUrl: "http://127.0.0.1:4096",
        username: "opencode",
        password: "s3cret",
        fetchImpl,
      }),
      server: { close() {} },
    }),
  });
  assert.equal(result.sessionId, "ses_1");
  assert.deepEqual(events, [
    ["session", "ses_1"],
    ["warning", "opencode-v2-context", "ai.opencode.v2.contextSkipped"],
    ["text", "Hello"],
    ["done"],
  ]);
  const prompt = requests.find((request) => request.url.endsWith("/prompt"));
  assert.equal(JSON.parse(prompt.body).text, "hello");
  const instruction = requests.find((request) => request.url.includes("/instructions/"));
  assert.equal(JSON.parse(instruction.body).value, "netcatty context");
});

test("runOpenCodeV2Turn posts the prompt only after the event stream is open", async () => {
  let releaseEvent;
  const eventGate = new Promise((resolve) => { releaseEvent = resolve; });
  const order = [];
  const encoder = new TextEncoder();
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/session") return jsonResponse({ data: { id: "ses_1" } });
    if (path === "/api/event") {
      order.push("event-start");
      await eventGate;
      order.push("event-open");
      const sse = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: "session.text.delta",
            data: { sessionID: "ses_1", delta: "Hi" },
          })}\n\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: "session.execution.succeeded",
            data: { sessionID: "ses_1" },
          })}\n\n`));
          controller.close();
        },
      });
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/prompt")) {
      order.push("prompt");
      return jsonResponse({ data: { id: "msg_1" } });
    }
    return new Response(null, { status: 204 });
  };
  const events = [];
  const running = runOpenCodeV2Turn({
    prompt: "hello",
    emitter: {
      sessionId: () => {},
      text: (text) => events.push(text),
      emitDone: () => events.push("done"),
      emitError: (message) => events.push(["error", message]),
    },
    openCodeV2Factory: async () => ({
      client: createOpenCodeV2Client({
        baseUrl: "http://127.0.0.1:4096",
        username: "opencode",
        password: "s3cret",
        fetchImpl,
      }),
      server: { close() {} },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["event-start"]);
  releaseEvent();
  await running;
  assert.deepEqual(order, ["event-start", "event-open", "prompt"]);
  assert.deepEqual(events, ["Hi", "done"]);
});

for (const pausedAt of ["server startup", "session creation", "event stream opening"]) {
  test(`runOpenCodeTurn v2 rechecks privacy after paused ${pausedAt}`, { timeout: 2000 }, async () => {
    const privacy = createAiPrivacyService();
    privacy.checkSession("chat");
    const abortController = new AbortController();
    const sends = [];
    const errors = [];
    let closed = false;
    let streamCancelled = false;
    let entered;
    let release;
    const ready = new Promise((resolve) => { entered = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    async function pause(stage) {
      if (stage !== pausedAt) return;
      entered();
      await waiting;
    }
    const fetchImpl = async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/session") {
        await pause("session creation");
        return jsonResponse({ data: { id: "ses_1" } });
      }
      if (pathname.includes("/instructions/")) {
        sends.push(["instruction", JSON.parse(init.body).value]);
        return new Response(null, { status: 204 });
      }
      if (pathname === "/api/event") {
        await pause("event stream opening");
        return new Response(new ReadableStream({
          start() {},
          cancel() { streamCancelled = true; },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (pathname.endsWith("/prompt")) {
        sends.push(["prompt", JSON.parse(init.body).text]);
        // Keep the unguarded regression finite without an execution event.
        return jsonResponse({ message: "unexpected prompt" }, 400);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    };
    const running = runOpenCodeTurn({
      prompt: "synthetic raw prompt",
      systemPrompt: "synthetic raw context",
      abortController,
      assertSessionValid: () => privacy.checkSession("chat"),
      versionProbe: async () => ({ major: 2, minor: 1, patch: 0 }),
      emitter: {
        sessionId() {},
        emitDone() { assert.fail("a retired chat must not complete"); },
        emitError: (message) => errors.push(message),
      },
      openCodeV2Factory: async () => {
        await pause("server startup");
        return {
          client: createOpenCodeV2Client({
            baseUrl: "http://127.0.0.1:4096",
            password: "synthetic-test-password",
            fetchImpl,
          }),
          server: { close() { closed = true; } },
        };
      },
    });
    await ready;
    privacy.configure({ enabled: true });
    release();
    await running;

    assert.deepEqual(sends, pausedAt === "event stream opening"
      ? [["instruction", "synthetic raw context"]]
      : []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /start a new chat/);
    assert.equal(closed, true);
    assert.equal(streamCancelled, pausedAt === "event stream opening");
    assert.equal(abortController.signal.aborted, false);
    assert.equal(getEventListeners(abortController.signal, "abort").length, 0);
  });
}

test("runOpenCodeV2Turn reports a rejected prompt without waiting on the event stream", { timeout: 2000 }, async () => {
  let releaseEvent;
  const eventOpen = new Promise((resolve) => { releaseEvent = resolve; });
  let streamCancelled = false;
  const sse = new ReadableStream({
    start() {},
    cancel() { streamCancelled = true; },
  });
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/api/session" && init.method === "POST") return jsonResponse({ data: { id: "ses_1" } });
    if (path === "/api/event") {
      releaseEvent();
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/prompt")) {
      await eventOpen;
      return new Response(JSON.stringify({ message: "model not found" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 204 });
  };
  const events = [];
  let closed = false;
  const result = await runOpenCodeV2Turn({
    prompt: "hello",
    emitter: {
      sessionId: (id) => events.push(["session", id]),
      text: () => {},
      emitDone: () => events.push(["done"]),
      emitError: (message) => events.push(["error", message]),
    },
    openCodeV2Factory: async () => ({
      client: createOpenCodeV2Client({
        baseUrl: "http://127.0.0.1:4096",
        username: "opencode",
        password: "s3cret",
        fetchImpl,
      }),
      server: { close: () => { closed = true; } },
    }),
  });
  assert.equal(result.sessionId, "ses_1");
  assert.equal(closed, true);
  assert.equal(streamCancelled, true);
  assert.deepEqual(events, [
    ["session", "ses_1"],
    ["error", "model not found"],
  ]);
});

test("runOpenCodeV2Turn maps a mid-stream server disconnect to a localized failure", async () => {
  const encoder = new TextEncoder();
  const disconnect = new TypeError("terminated");
  disconnect.cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  let sent = false;
  const sse = new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "session.text.delta",
          data: { sessionID: "ses_1", delta: "Hel" },
        })}\n\n`));
        return;
      }
      controller.error(disconnect);
    },
  });
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/api/session" && init.method === "POST") return jsonResponse({ data: { id: "ses_1" } });
    if (path === "/api/event") {
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/prompt")) return jsonResponse({ data: { id: "msg_1" } });
    return new Response(null, { status: 204 });
  };
  const events = [];
  const result = await runOpenCodeV2Turn({
    prompt: "hello",
    emitter: {
      sessionId: (id) => events.push(["session", id]),
      text: (text) => events.push(["text", text]),
      emitDone: () => events.push(["done"]),
      emitError: (message) => events.push(["error", message]),
    },
    openCodeV2Factory: async () => ({
      client: createOpenCodeV2Client({
        baseUrl: "http://127.0.0.1:4096",
        username: "opencode",
        password: "s3cret",
        fetchImpl,
      }),
      server: { close() {} },
    }),
  });
  assert.equal(result.sessionId, "ses_1");
  assert.deepEqual(events, [
    ["session", "ses_1"],
    ["text", "Hel"],
    ["error", "ai.opencode.v2.sessionFailed"],
  ]);
  assert.equal(JSON.stringify(events).includes("terminated"), false);
  assert.equal(JSON.stringify(events).includes("other side closed"), false);
});

test("runOpenCodeV2Turn maps an event stream that ends before the turn finishes", async () => {
  const encoder = new TextEncoder();
  const sse = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        type: "session.text.delta",
        data: { sessionID: "ses_1", delta: "Hel" },
      })}\n\n`));
      controller.close();
    },
  });
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/api/session" && init.method === "POST") return jsonResponse({ data: { id: "ses_1" } });
    if (path === "/api/event") {
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/prompt")) return jsonResponse({ data: { id: "msg_1" } });
    return new Response(null, { status: 204 });
  };
  const events = [];
  await runOpenCodeV2Turn({
    prompt: "hello",
    emitter: {
      sessionId: (id) => events.push(["session", id]),
      text: (text) => events.push(["text", text]),
      emitDone: () => events.push(["done"]),
      emitError: (message) => events.push(["error", message]),
    },
    openCodeV2Factory: async () => ({
      client: createOpenCodeV2Client({
        baseUrl: "http://127.0.0.1:4096",
        username: "opencode",
        password: "s3cret",
        fetchImpl,
      }),
      server: { close() {} },
    }),
  });
  assert.deepEqual(events, [
    ["session", "ses_1"],
    ["text", "Hel"],
    ["error", "ai.opencode.v2.sessionFailed"],
  ]);
});

test("listOpenCodeModels stays on the 1.x factory for OpenCode 1.x", async () => {
  resetOpenCodeListServerPool();
  let v1 = false;
  const models = await listOpenCodeModels({
    versionProbe: async () => ({ major: 1, minor: 19, patch: 3 }),
    openCodeFactory: async () => {
      v1 = true;
      return {
        client: { config: { providers: async () => ({ providers: [], default: {} }) } },
        server: { close() {} },
      };
    },
    openCodeV2Factory: async () => {
      throw new Error("v2 catalog should not run");
    },
  });
  assert.equal(v1, true);
  assert.deepEqual(models.models, []);
  resetOpenCodeListServerPool();
});

test("listOpenCodeV2Models refetches the catalog after model.updated", async () => {
  let updated = false;
  const result = await listOpenCodeV2Models({
    openCodeV2Factory: async () => ({
      client: {
        async listCatalog() {
          if (!updated) {
            return { currentModelId: null, models: [{ id: "opencode/big-pickle", name: "builtin" }] };
          }
          return {
            currentModelId: "custom/coder",
            models: [
              { id: "opencode/big-pickle", name: "builtin" },
              { id: "custom/coder", name: "Coder" },
            ],
          };
        },
        async openEventStream() {
          return (async function* partialCatalog() {
            await new Promise((resolve) => setTimeout(resolve, 30));
            updated = true;
            yield { type: "model.updated", data: {} };
            await new Promise(() => {});
          })();
        },
      },
      server: { close() {} },
    }),
  });
  assert.deepEqual(result.models.map((model) => model.id), ["opencode/big-pickle", "custom/coder"]);
  assert.equal(result.currentModelId, "custom/coder");
});

test("listOpenCodeV2Models refetches when model.updated arrives during the first catalog read", async () => {
  let releaseFirst;
  const firstCatalog = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const result = await listOpenCodeV2Models({
    openCodeV2Factory: async () => ({
      client: {
        async listCatalog() {
          calls += 1;
          if (calls === 1) {
            await firstCatalog;
            return { currentModelId: null, models: [{ id: "opencode/big-pickle", name: "builtin" }] };
          }
          return {
            currentModelId: "custom/coder",
            models: [
              { id: "opencode/big-pickle", name: "builtin" },
              { id: "custom/coder", name: "Coder" },
            ],
          };
        },
        async openEventStream() {
          return (async function* updateDuringFetch() {
            await new Promise((resolve) => setTimeout(resolve, 20));
            yield { type: "model.updated", data: {} };
            releaseFirst();
            await new Promise(() => {});
          })();
        },
      },
      server: { close() {} },
    }),
  });
  assert.ok(calls >= 2);
  assert.equal(result.currentModelId, "custom/coder");
  assert.deepEqual(result.models.map((model) => model.id), ["opencode/big-pickle", "custom/coder"]);
});

test("listOpenCodeV2Models refetches when the settlement budget elapses during the first read", async () => {
  let releaseFirst;
  const firstCatalog = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const result = await listOpenCodeV2Models({
    catalogSettle: { maxMs: 30, quietMs: 5000, pollMs: 10 },
    openCodeV2Factory: async () => ({
      client: {
        async listCatalog() {
          calls += 1;
          if (calls === 1) {
            await firstCatalog;
            return { currentModelId: null, models: [{ id: "opencode/big-pickle", name: "builtin" }] };
          }
          return {
            currentModelId: "custom/coder",
            models: [
              { id: "opencode/big-pickle", name: "builtin" },
              { id: "custom/coder", name: "Coder" },
            ],
          };
        },
        async openEventStream() {
          return (async function* updateAfterDeadline() {
            await new Promise((resolve) => setTimeout(resolve, 50));
            yield { type: "provider.updated", data: {} };
            releaseFirst();
            await new Promise(() => {});
          })();
        },
      },
      server: { close() {} },
    }),
  });
  assert.ok(calls >= 2);
  assert.equal(result.currentModelId, "custom/coder");
});

test("listOpenCodeModels uses the 2.x catalog when the binary is 2.x", async () => {
  const models = await listOpenCodeModels({
    versionProbe: async () => parseOpenCodeVersionOutput("v2.1.0"),
    openCodeV2Factory: async () => ({
      client: {
        listCatalog: async () => ({
          currentModelId: "openai/gpt-5",
          models: [{ id: "openai/gpt-5", name: "OpenAI GPT-5" }],
        }),
      },
      server: { close() {} },
    }),
  });
  assert.equal(models.currentModelId, "openai/gpt-5");
});

test("runOpenCodeTurn keeps the injected 1.x factory when a factory is supplied", async () => {
  const events = [];
  await runOpenCodeTurn({
    prompt: "hi",
    versionProbe: async () => ({ major: 2, minor: 1, patch: 0 }),
    emitter: {
      sessionId: () => {},
      text: (t) => events.push(t),
      emitDone: () => events.push("done"),
      emitError: (message) => events.push(message),
    },
    openCodeFactory: async () => ({
      client: {
        global: { event: async () => ({ stream: (async function* empty() {})() }) },
        session: {
          create: async () => ({ data: { id: "sess-1" } }),
          promptAsync: async () => ({ data: true }),
        },
      },
      server: { close() {} },
    }),
  });
  assert.ok(events.includes("ai.opencode.v2.empty") === false);
  assert.ok(events.includes("done") || events.some((event) => String(event).includes("empty")));
});

test("listOpenCodeV2Models returns an empty catalog when the caller already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const models = await listOpenCodeV2Models({
    signal: controller.signal,
    openCodeV2Factory: async () => { throw new Error("should not connect"); },
  });
  assert.deepEqual(models, { currentModelId: null, models: [] });
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
