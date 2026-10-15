const test = require("node:test");
const assert = require("node:assert/strict");
const { CodebuddySessionManager, computeOptionsFingerprint } = require("./codebuddySessionManager.cjs");

function collector() {
  const events = [];
  const emitter = {
    text: (t) => events.push({ k: "text", t }),
    reasoning: (d) => events.push({ k: "reasoning", d }),
    toolCall: (name, args, id) => events.push({ k: "toolCall", name, args, id }),
    toolResult: (id, out, name) => events.push({ k: "toolResult", id, out, name }),
    usage: (usage) => events.push({ k: "usage", usage }),
    status: (m) => events.push({ k: "status", m }),
    sessionId: (s) => events.push({ k: "sessionId", s }),
    emitDone: () => events.push({ k: "done" }),
    emitError: (m) => events.push({ k: "error", m }),
    emitEvent: (ev) => events.push({ k: "event", ev }),
  };
  return { events, emitter };
}

/** Create a fake V2 session that yields predefined messages. */
function fakeSession(messages, opts = {}) {
  let sentMessages = [];
  let closed = false;
  let interruptCalls = 0;
  return {
    sessionId: opts.sessionId || "fake-sess-1",
    sentMessages,
    get closed() { return closed; },
    get interruptCalls() { return interruptCalls; },
    async connect() {},
    async send(msg) { sentMessages.push(msg); },
    async *stream() { for (const m of messages) yield m; },
    async interrupt() { interruptCalls += 1; },
    async setModel(model) { this._model = model; },
    setHooks(hooks) { this._hooks = hooks; },
    setCanUseTool(handler) { this._canUseTool = handler; },
    close() { closed = true; },
  };
}

test("getOrCreateSession reuses existing session when options match", async () => {
  const mgr = new CodebuddySessionManager();
  const session = fakeSession([], { sessionId: "existing-sess" });
  const opts = { cwd: "/tmp", model: "glm-5" };
  mgr.sessions.set("reuse-key", { session, fingerprint: computeOptionsFingerprint(opts) });

  const result = await mgr.getOrCreateSession({
    sessionKey: "reuse-key",
    sessionOptions: opts,
  });
  assert.equal(result, session);
});

test("getOrCreateSession refreshes turn-scoped callbacks on a reused session", async () => {
  let createdOptions;
  const session = fakeSession([], { sessionId: "callback-session" });
  const mgr = new CodebuddySessionManager({
    loadSdk: async () => ({
      unstable_v2_createSession: (options) => {
        createdOptions = options;
        return session;
      },
      unstable_v2_resumeSession: () => session,
    }),
  });
  const firstEvents = [];
  const secondEvents = [];
  const firstOptions = {
    cwd: "/tmp",
    hooks: { Notification: [{ hooks: [() => firstEvents.push("hook")] }] },
    canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
    elicitation: {
      create: async () => {
        firstEvents.push("elicitation");
        return { action: "accept" };
      },
    },
  };
  const secondOptions = {
    cwd: "/tmp",
    hooks: { Notification: [{ hooks: [() => secondEvents.push("hook")] }] },
    canUseTool: async () => ({ behavior: "deny", message: "second turn" }),
    elicitation: {
      create: async () => {
        secondEvents.push("elicitation");
        return { action: "decline" };
      },
    },
  };

  const first = await mgr.getOrCreateSession({
    sessionKey: "callback-key",
    sessionOptions: firstOptions,
  });
  const second = await mgr.getOrCreateSession({
    sessionKey: "callback-key",
    sessionOptions: secondOptions,
  });

  assert.equal(first, session);
  assert.equal(second, session);
  assert.equal(session._hooks, secondOptions.hooks);
  assert.equal(session._canUseTool, secondOptions.canUseTool);
  assert.notEqual(createdOptions.elicitation, firstOptions.elicitation);
  await session._hooks.Notification[0].hooks[0]();
  assert.deepEqual(await session._canUseTool(), {
    behavior: "deny",
    message: "second turn",
  });
  assert.deepEqual(
    await createdOptions.elicitation.create({}, { signal: new AbortController().signal }),
    { action: "decline" },
  );
  assert.deepEqual(firstEvents, []);
  assert.deepEqual(secondEvents, ["hook", "elicitation"]);
});

test("getOrCreateSession closes stale session when options change", async () => {
  const oldSession = fakeSession([], { sessionId: "old-sess" });
  const replacementSession = fakeSession([], { sessionId: "new-sess" });
  const mgr = new CodebuddySessionManager({
    loadSdk: async () => ({
      unstable_v2_createSession: () => replacementSession,
      unstable_v2_resumeSession: () => replacementSession,
    }),
  });
  const oldOpts = { cwd: "/tmp", model: "glm-4" };
  const newOpts = { cwd: "/tmp", model: "glm-5" };
  mgr.sessions.set("stale-key", {
    session: oldSession,
    fingerprint: computeOptionsFingerprint(oldOpts),
  });

  const result = await mgr.getOrCreateSession({
    sessionKey: "stale-key",
    sessionOptions: newOpts,
  });

  assert.ok(oldSession.closed);
  assert.equal(result, replacementSession);
  assert.equal(mgr.sessions.get("stale-key").session, replacementSession);
  assert.equal(
    mgr.sessions.get("stale-key").fingerprint,
    computeOptionsFingerprint(newOpts),
  );
});

test("runTurn closes a session when initial send fails before fallback", async () => {
  const session = fakeSession([], { sessionId: "failed-connect-session" });
  session.send = async () => {
    throw new Error("connect failed");
  };
  const mgr = new CodebuddySessionManager({
    loadSdk: async () => ({
      unstable_v2_createSession: () => session,
      unstable_v2_resumeSession: () => session,
    }),
  });

  const { events, emitter } = collector();
  const result = await mgr.runTurn({
    sessionKey: "failed-connect-key",
    prompt: "hello",
    attachments: [],
    options: { abortController: new AbortController() },
    emitter,
    sessionOptions: {},
  });

  assert.equal(result, null);
  assert.equal(session.closed, true);
  assert.equal(mgr.sessions.has("failed-connect-key"), false);
  assert.deepEqual(events, []);
});

test("runTurn closes and evicts a session when response streaming fails", async () => {
  const session = fakeSession([], { sessionId: "failed-stream-session" });
  session.stream = async function* stream() {
    throw new Error("transport died");
  };
  const mgr = new CodebuddySessionManager({
    loadSdk: async () => ({
      unstable_v2_createSession: () => session,
      unstable_v2_resumeSession: () => session,
    }),
  });

  const { events, emitter } = collector();
  const result = await mgr.runTurn({
    sessionKey: "failed-stream-key",
    prompt: "hello",
    attachments: [],
    options: { abortController: new AbortController() },
    emitter,
    sessionOptions: {},
  });

  assert.deepEqual(result, {
    sessionId: "failed-stream-session",
    usedV2: true,
  });
  assert.equal(session.closed, true);
  assert.equal(mgr.sessions.has("failed-stream-key"), false);
  assert.deepEqual(events, [
    { k: "sessionId", s: "failed-stream-session" },
    { k: "error", m: "transport died" },
  ]);
});

test("computeOptionsFingerprint detects option changes", () => {
  const base = {
    cwd: "/tmp",
    model: "glm-5",
    maxTurns: 10,
    effort: "high",
    extraArgs: { "dangerously-skip-permissions": null },
  };
  const same = {
    cwd: "/tmp",
    model: "glm-5",
    maxTurns: 10,
    effort: "high",
    extraArgs: { "dangerously-skip-permissions": null },
  };
  const diffModel = { cwd: "/tmp", model: "glm-4", maxTurns: 10, effort: "high" };
  const diffMaxTurns = { cwd: "/tmp", model: "glm-5", maxTurns: 20, effort: "high" };
  const diffEffort = { cwd: "/tmp", model: "glm-5", maxTurns: 10, effort: "low" };
  const diffPersistSession = { ...base, persistSession: false };
  const diffExtraArgs = {
    ...base,
    extraArgs: { "dangerously-skip-permissions": "false" },
  };
  assert.equal(computeOptionsFingerprint(base), computeOptionsFingerprint(same));
  assert.notEqual(computeOptionsFingerprint(base), computeOptionsFingerprint(diffModel));
  assert.notEqual(computeOptionsFingerprint(base), computeOptionsFingerprint(diffMaxTurns));
  assert.notEqual(computeOptionsFingerprint(base), computeOptionsFingerprint(diffEffort));
  assert.notEqual(computeOptionsFingerprint(base), computeOptionsFingerprint(diffPersistSession));
  assert.notEqual(computeOptionsFingerprint(base), computeOptionsFingerprint(diffExtraArgs));
});

test("getOrCreateSession never reuses sessions with unserializable option fingerprints", async () => {
  const circular = {};
  circular.self = circular;
  const oldSession = fakeSession([], { sessionId: "circular-old" });
  const replacementSession = fakeSession([], { sessionId: "circular-new" });
  const mgr = new CodebuddySessionManager({
    loadSdk: async () => ({
      unstable_v2_createSession: () => replacementSession,
      unstable_v2_resumeSession: () => replacementSession,
    }),
  });
  mgr.sessions.set("circular-key", {
    session: oldSession,
    fingerprint: computeOptionsFingerprint({ mcpServers: circular }),
  });

  const result = await mgr.getOrCreateSession({
    sessionKey: "circular-key",
    sessionOptions: { mcpServers: circular },
  });

  assert.equal(result, replacementSession);
  assert.equal(oldSession.closed, true);
  assert.equal(mgr.sessions.get("circular-key").session, replacementSession);
});

test("runTurn streams messages via V2 session when available", async () => {
  const mgr = new CodebuddySessionManager();
  const messages = [
    { type: "system", session_id: "sess-v2" },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi from v2" } } },
  ];
  const session = fakeSession(messages, { sessionId: "sess-v2" });
  // Pre-populate the session map to bypass SDK import.
  mgr.sessions.set("preloaded-key", { session, fingerprint: computeOptionsFingerprint({}) });

  const { events, emitter } = collector();
  const result = await mgr.runTurn({
    sessionKey: "preloaded-key",
    prompt: "say hi",
    attachments: [],
    options: { abortController: new AbortController() },
    emitter,
    sessionOptions: {},
  });

  assert.deepEqual(result, { sessionId: "sess-v2", usedV2: true });
  assert.ok(events.some((e) => e.k === "text" && e.t === "hi from v2"));
  assert.ok(events.some((e) => e.k === "done"));
  assert.deepEqual(
    events.filter((event) => event.k === "sessionId"),
    [{ k: "sessionId", s: "sess-v2" }],
  );
  assert.ok(session.sentMessages.includes("say hi"));
});

test("runTurn sends before connecting a resumed session and skips replayed history", async () => {
  let explicitlyConnected = false;
  const session = fakeSession([], { sessionId: "resumed-session" });
  session.connect = async () => {
    explicitlyConnected = true;
  };
  session.send = async (message) => {
    session.sentMessages.push(message);
  };
  session.stream = async function* stream() {
    if (explicitlyConnected) {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "old response" }] },
      };
    }
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "new response" }] },
    };
  };
  const mgr = new CodebuddySessionManager({
    loadSdk: async () => ({
      unstable_v2_createSession: () => session,
      unstable_v2_resumeSession: () => session,
    }),
  });
  const { events, emitter } = collector();

  const result = await mgr.runTurn({
    sessionKey: "resumed-key",
    prompt: "new question",
    attachments: [],
    options: { abortController: new AbortController() },
    emitter,
    sessionOptions: {},
    resumeSessionId: "resumed-session",
  });

  assert.deepEqual(result, { sessionId: "resumed-session", usedV2: true });
  assert.equal(explicitlyConnected, false);
  assert.deepEqual(session.sentMessages, ["new question"]);
  assert.deepEqual(
    events.filter((event) => event.k === "text").map((event) => event.t),
    ["new response"],
  );
  assert.deepEqual(
    events.filter((event) => event.k === "sessionId"),
    [{ k: "sessionId", s: "resumed-session" }],
  );
});

test("runTurn does not connect or send when already aborted", async () => {
  let loadSdkCalls = 0;
  const mgr = new CodebuddySessionManager({
    loadSdk: async () => {
      loadSdkCalls += 1;
      return {};
    },
  });
  const controller = new AbortController();
  controller.abort();
  const { events, emitter } = collector();

  const result = await mgr.runTurn({
    sessionKey: "pre-aborted-key",
    prompt: "must not run",
    attachments: [],
    options: { abortController: controller },
    emitter,
    sessionOptions: {},
  });

  assert.deepEqual(result, { sessionId: null, usedV2: true });
  assert.equal(loadSdkCalls, 0);
  assert.deepEqual(events, [{ k: "done" }]);
});

test("runTurn does not stream when aborted while the initial send connects", async () => {
  let releaseSend;
  const session = fakeSession([], { sessionId: "slow-connect-session" });
  session.send = (message) => new Promise((resolve) => {
    session.sentMessages.push(message);
    releaseSend = resolve;
  });
  const mgr = new CodebuddySessionManager({
    loadSdk: async () => ({
      unstable_v2_createSession: () => session,
      unstable_v2_resumeSession: () => session,
    }),
  });
  const controller = new AbortController();
  const { events, emitter } = collector();

  const runPromise = mgr.runTurn({
    sessionKey: "slow-connect-key",
    prompt: "must not run",
    attachments: [],
    options: { abortController: controller },
    emitter,
    sessionOptions: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseSend, "function");

  controller.abort();
  releaseSend();
  const result = await runPromise;

  assert.deepEqual(result, {
    sessionId: "slow-connect-session",
    usedV2: true,
  });
  assert.deepEqual(session.sentMessages, ["must not run"]);
  assert.equal(session.interruptCalls, 1);
  assert.deepEqual(events, [{ k: "done" }]);
});

test("runTurn treats an abort rejection while streaming as normal completion", async () => {
  let rejectStream;
  const session = fakeSession([], { sessionId: "stream-abort-session" });
  session.stream = async function* stream() {
    await new Promise((_resolve, reject) => {
      rejectStream = reject;
    });
  };
  session.interrupt = async () => {
    rejectStream?.(new Error("interrupted"));
  };
  const mgr = new CodebuddySessionManager({
    loadSdk: async () => ({
      unstable_v2_createSession: () => session,
      unstable_v2_resumeSession: () => session,
    }),
  });
  const controller = new AbortController();
  const { events, emitter } = collector();

  const runPromise = mgr.runTurn({
    sessionKey: "stream-abort-key",
    prompt: "wait",
    attachments: [],
    options: { abortController: controller },
    emitter,
    sessionOptions: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  assert.deepEqual(await runPromise, {
    sessionId: "stream-abort-session",
    usedV2: true,
  });
  assert.ok(mgr.sessions.has("stream-abort-key"));
  assert.equal(session.closed, false);
  assert.deepEqual(events, [
    { k: "sessionId", s: "stream-abort-session" },
    { k: "done" },
  ]);
});

test("steer returns unsupported when no session exists", async () => {
  const mgr = new CodebuddySessionManager();
  const { emitter } = collector();
  const result = await mgr.steer({
    sessionKey: "nonexistent",
    prompt: "follow up",
    attachments: [],
    emitter,
  });
  assert.deepEqual(result, { status: "unsupported" });
});

test("steer stays unsupported because Session.send resets the active SDK stream", async () => {
  const mgr = new CodebuddySessionManager();
  const session = fakeSession([]);
  mgr.sessions.set("steer-key", {
    session,
    fingerprint: computeOptionsFingerprint({}),
  });

  const result = await mgr.steer({
    sessionKey: "steer-key",
    prompt: "now do this",
    attachments: [],
  });

  assert.deepEqual(result, { status: "unsupported" });
  assert.deepEqual(session.sentMessages, []);
});

test("closeSession removes and closes the session", () => {
  const mgr = new CodebuddySessionManager();
  const session = fakeSession([]);
  mgr.sessions.set("close-key", { session, fingerprint: null });

  mgr.closeSession("close-key");
  assert.ok(!mgr.sessions.has("close-key"));
  assert.ok(session.closed);
});

test("closeForChat closes all sessions matching the chat prefix", () => {
  const mgr = new CodebuddySessionManager();
  const s1 = fakeSession([]);
  const s2 = fakeSession([]);
  const s3 = fakeSession([]);
  mgr.sessions.set("chat1\u0000codebuddy\u0000/bin/cb\u0000sdk", { session: s1, fingerprint: null });
  mgr.sessions.set("chat1\u0000codebuddy\u0000/other/cb\u0000sdk", { session: s2, fingerprint: null });
  mgr.sessions.set("chat2\u0000codebuddy\u0000/bin/cb\u0000sdk", { session: s3, fingerprint: null });

  mgr.closeForChat("chat1");
  assert.ok(!mgr.sessions.has("chat1\u0000codebuddy\u0000/bin/cb\u0000sdk"));
  assert.ok(!mgr.sessions.has("chat1\u0000codebuddy\u0000/other/cb\u0000sdk"));
  assert.ok(mgr.sessions.has("chat2\u0000codebuddy\u0000/bin/cb\u0000sdk"));
  assert.ok(s1.closed);
  assert.ok(s2.closed);
  assert.ok(!s3.closed);
});

test("closeForChat cancels pending elicitations scoped to the chat", () => {
  const mgr = new CodebuddySessionManager();
  const resolved = [];
  mgr.elicitationPending.set("el-chat1", {
    resolve: (v) => resolved.push(["el-chat1", v]),
    reject: () => {},
    chatSessionId: "chat1",
  });
  mgr.elicitationPending.set("el-chat2", {
    resolve: (v) => resolved.push(["el-chat2", v]),
    reject: () => {},
    chatSessionId: "chat2",
  });

  mgr.closeForChat("chat1");

  assert.deepEqual(resolved, [["el-chat1", { action: "cancel" }]]);
  assert.ok(!mgr.elicitationPending.has("el-chat1"));
  assert.ok(mgr.elicitationPending.has("el-chat2"));
});

test("closeAll closes every session", () => {
  const mgr = new CodebuddySessionManager();
  const s1 = fakeSession([]);
  const s2 = fakeSession([]);
  mgr.sessions.set("a", { session: s1, fingerprint: null });
  mgr.sessions.set("b", { session: s2, fingerprint: null });

  mgr.closeAll();
  assert.equal(mgr.sessions.size, 0);
  assert.ok(s1.closed);
  assert.ok(s2.closed);
});

test("closeAll cancels every pending elicitation", () => {
  const mgr = new CodebuddySessionManager();
  const resolved = [];
  mgr.elicitationPending.set("el-a", {
    resolve: (v) => resolved.push(["el-a", v]),
    reject: () => {},
    chatSessionId: "chat1",
  });
  mgr.elicitationPending.set("el-b", {
    resolve: (v) => resolved.push(["el-b", v]),
    reject: () => {},
    chatSessionId: "chat2",
  });

  mgr.closeAll();

  assert.equal(mgr.elicitationPending.size, 0);
  assert.deepEqual(resolved, [
    ["el-a", { action: "cancel" }],
    ["el-b", { action: "cancel" }],
  ]);
});

test("setModel returns false when session does not exist", async () => {
  const mgr = new CodebuddySessionManager();
  const result = await mgr.setModel("missing", "new-model");
  assert.equal(result, false);
});

test("setModel delegates to the session", async () => {
  const mgr = new CodebuddySessionManager();
  const session = fakeSession([]);
  mgr.sessions.set("model-key", { session, fingerprint: null });

  const result = await mgr.setModel("model-key", "glm-5");
  assert.equal(result, true);
  assert.equal(session._model, "glm-5");
});

test("resolveElicitation resolves pending and returns true", () => {
  const mgr = new CodebuddySessionManager();
  let resolved;
  mgr.elicitationPending.set("el-1", {
    resolve: (v) => { resolved = v; },
    reject: () => {},
  });

  const ok = mgr.resolveElicitation("el-1", { action: "accept" });
  assert.equal(ok, true);
  assert.deepEqual(resolved, { action: "accept" });
  assert.ok(!mgr.elicitationPending.has("el-1"));
});

test("resolveElicitation returns false for unknown id", () => {
  const mgr = new CodebuddySessionManager();
  const ok = mgr.resolveElicitation("unknown", { action: "cancel" });
  assert.equal(ok, false);
});
