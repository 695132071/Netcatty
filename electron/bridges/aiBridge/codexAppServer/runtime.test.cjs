const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CodexAppServerRuntime,
  buildTurnInput,
  mapAppServerModels,
  normalizeFileChanges,
  resolveCodexPermissionConfig,
} = require("./runtime.cjs");

class FakeConnection {
  constructor(options) {
    this.options = options;
    this.requests = [];
    this.responses = [];
    this.threadId = "thread-1";
    this.turnId = "turn-1";
    this.closed = false;
  }
  async start() { return this; }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") {
      return { thread: { id: this.threadId } };
    }
    if (method === "turn/start") {
      if (this.turnStartGate) await this.turnStartGate;
      return { turn: { id: this.turnId } };
    }
    if (method === "turn/steer") {
      if (this.turnSteerGate) await this.turnSteerGate;
      if (this.turnSteerError) throw this.turnSteerError;
      return { turnId: this.turnId };
    }
    if (method === "turn/interrupt") {
      if (this.turnInterruptGate) await this.turnInterruptGate;
      if (this.turnInterruptError) throw this.turnInterruptError;
      return {};
    }
    if (method === "model/list") {
      return {
        data: [
          {
            id: "gpt-first",
            displayName: "GPT First",
            description: "First model in the catalog",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
            defaultReasoningEffort: "low",
            isDefault: false,
          },
          {
            id: "gpt-test",
            displayName: "GPT Test",
            description: "Server default model",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
            defaultReasoningEffort: "high",
            isDefault: true,
          },
        ],
        nextCursor: null,
      };
    }
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  respondError(id, code, message) { this.responses.push({ id, error: { code, message } }); }
  notify(message) { this.options.onNotification(message); }
  serverRequest(message) { return this.options.onServerRequest(message, this); }
  close() { this.closed = true; }
}

function createEmitter() {
  const events = [];
  return {
    events,
    emitDone: () => events.push(["done"]),
    sessionId: (id) => events.push(["session", id]),
    text: (text) => events.push(["text", text]),
    reasoning: (text) => events.push(["reasoning", text]),
    reasoningEnd: () => events.push(["reasoning-end"]),
    toolCall: (name, args, id) => events.push(["tool-call", name, args, id]),
    toolResult: (id, output, name) => events.push(["tool-result", id, output, name]),
    fileChange: (id, changes, status) => events.push(["file-change", id, changes, status]),
    webSearch: (id, query, status) => events.push(["web-search", id, query, status]),
    planUpdate: (id, items, status) => events.push(["plan", id, items, status]),
    warning: (id, message) => events.push(["warning", id, message]),
    usage: (usage) => events.push(["usage", usage]),
  };
}

async function waitFor(predicate) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not reached");
}

test("permission modes map to fail-closed Codex policies", () => {
  assert.deepEqual(resolveCodexPermissionConfig("observer"), {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "read-only",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
  assert.equal(resolveCodexPermissionConfig("confirm").approvalPolicy, "on-request");
  assert.equal(resolveCodexPermissionConfig("confirm").sandbox, "read-only");
  assert.equal(resolveCodexPermissionConfig("auto").sandbox, "danger-full-access");
});

test("turn input uses text plus local images only", () => {
  assert.deepEqual(buildTurnInput("hello", [
    { filePath: "/tmp/a.png", mediaType: "image/png" },
    { filePath: "/tmp/a.txt", mediaType: "text/plain" },
  ]), [
    { type: "text", text: "hello", text_elements: [] },
    { type: "localImage", path: "/tmp/a.png" },
  ]);
});

test("runtime maps lifecycle, activities, usage, and retry warnings", async () => {
  let connection;
  const runtime = new CodexAppServerRuntime({
    connectionFactory: (options) => (connection = new FakeConnection(options)),
  });
  const emitter = createEmitter();
  const run = runtime.runTurn({
    requestId: "request-1",
    chatSessionId: "chat-1",
    prompt: "hello",
    cwd: "/repo",
    model: "gpt-test/high",
    permissionMode: "confirm",
    env: { HOME: "/home" },
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter,
  });
  await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));

  connection.notify({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "msg-1", delta: "Hi" } });
  connection.notify({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", plan: [{ step: "Inspect", status: "completed" }] } });
  connection.notify({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "webSearch", id: "search-1", query: "Netcatty" } } });
  connection.notify({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "fileChange", id: "file-1", status: "completed", changes: [{ path: "a.ts", kind: { type: "add" } }] } } });
  connection.notify({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 13 } } } });
  connection.notify({ method: "error", params: { threadId: "thread-1", turnId: "turn-1", willRetry: true, error: { message: "network" } } });
  connection.notify({ method: "warning", params: { message: "global warning" } });
  connection.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });
  await run;

  assert.ok(emitter.events.some((event) => event[0] === "text" && event[1] === "Hi"));
  assert.ok(emitter.events.some((event) => event[0] === "plan"));
  assert.ok(emitter.events.some((event) => event[0] === "web-search" && event[3] === "running"));
  assert.ok(emitter.events.some((event) => event[0] === "file-change" && event[3] === "completed"));
  assert.ok(emitter.events.some((event) => event[0] === "usage" && event[1].cachedInputTokens === 2));
  assert.ok(emitter.events.some((event) => event[0] === "warning" && /retrying/.test(event[2])));
  assert.ok(emitter.events.some((event) => event[0] === "warning" && event[2] === "global warning"));
  assert.ok(emitter.events.some((event) => event[0] === "done"));
});

test("runtime bounds command output and avoids replaying streamed message prefixes", async () => {
  let connection;
  const runtime = new CodexAppServerRuntime({
    connectionFactory: (options) => (connection = new FakeConnection(options)),
  });
  const emitter = createEmitter();
  const run = runtime.runTurn({
    requestId: "request-bounded-output",
    chatSessionId: "chat-bounded-output",
    prompt: "run",
    permissionMode: "confirm",
    env: {},
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter,
  });
  await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));

  connection.notify({ method: "item/agentMessage/delta", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "msg-bounded", delta: "Hello",
  } });
  connection.notify({ method: "item/completed", params: {
    threadId: "thread-1", turnId: "turn-1",
    item: { type: "agentMessage", id: "msg-bounded", text: "Hello world" },
  } });
  connection.notify({ method: "item/commandExecution/outputDelta", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "cmd-bounded",
    delta: "x".repeat(1024 * 1024 + 1024),
  } });
  connection.notify({ method: "item/completed", params: {
    threadId: "thread-1", turnId: "turn-1",
    item: { type: "commandExecution", id: "cmd-bounded", command: "large", exitCode: 0 },
  } });
  connection.notify({ method: "turn/completed", params: {
    threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null },
  } });
  await run;

  assert.deepEqual(
    emitter.events.filter((event) => event[0] === "text"),
    [["text", "Hello"], ["text", " world"]],
  );
  const toolResult = emitter.events.find((event) => event[0] === "tool-result");
  assert.ok(toolResult);
  assert.ok(toolResult[2].length < 1024 * 1024 + 200);
  assert.match(toolResult[2], /output truncated: 1049600 characters total/);
  assert.match(toolResult[2], /\[exit code: 0\]$/);
});

test("runtime delegates injected MCP approvals to Netcatty's policy gate", async () => {
  let connection;
  const runtime = new CodexAppServerRuntime({
    connectionFactory: (options) => (connection = new FakeConnection(options)),
  });
  const run = runtime.runTurn({
    requestId: "request-mcp-policy",
    chatSessionId: "chat-mcp-policy",
    prompt: "inspect the terminal",
    permissionMode: "confirm",
    env: {},
    binPath: "/bin/codex",
    injectedMcpServers: [{
      name: "netcatty-remote-hosts",
      command: "/abs/electron",
      args: ["/abs/server.cjs"],
      env: [{ name: "NETCATTY_MCP_PERMISSION_MODE", value: "confirm" }],
    }],
    emitter: createEmitter(),
  });
  await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));

  const threadStart = connection.requests.find((request) => request.method === "thread/start");
  assert.deepEqual(threadStart.params.config.mcp_servers["netcatty-remote-hosts"], {
    command: "/abs/electron",
    args: ["/abs/server.cjs"],
    env: { NETCATTY_MCP_PERMISSION_MODE: "confirm" },
    default_tools_approval_mode: "approve",
  });

  connection.notify({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
  });
  await run;
});

test("runtime routes native approvals and request_user_input responses", async () => {
  let connection;
  let interaction;
  const runtime = new CodexAppServerRuntime({
    connectionFactory: (options) => (connection = new FakeConnection(options)),
    sendInteractionRequest: (payload) => { interaction = payload; return true; },
  });
  const run = runtime.runTurn({
    requestId: "request-2",
    chatSessionId: "chat-2",
    prompt: "change it",
    permissionMode: "confirm",
    env: {},
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter: createEmitter(),
  });
  await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));

  await connection.serverRequest({
    id: 70,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      command: "npm test",
      cwd: "/repo",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    },
  });
  assert.equal(interaction.kind, "command");
  assert.deepEqual(interaction.availableDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
  runtime.respondInteraction(interaction.interactionId, { decision: "session" });
  assert.deepEqual(connection.responses.at(-1), { id: 70, result: { decision: "acceptForSession" } });

  await connection.serverRequest({
    id: 72,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "permissions-1",
      permissions: { network: { enabled: true }, fileSystem: null },
      cwd: "/repo",
    },
  });
  runtime.respondInteraction(interaction.interactionId, { decision: "once" });
  assert.deepEqual(connection.responses.at(-1), {
    id: 72,
    result: { permissions: { network: { enabled: true } }, scope: "turn" },
  });

  await connection.serverRequest({
    id: 71,
    method: "item/tool/requestUserInput",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "question-1", questions: [{ id: "choice", question: "Choose", header: "Mode", isOther: true, isSecret: false, options: null }] },
  });
  runtime.respondInteraction(interaction.interactionId, { answers: { choice: { answers: ["safe"] } } });
  assert.deepEqual(connection.responses.at(-1), { id: 71, result: { answers: { choice: { answers: ["safe"] } } } });

  connection.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });
  await run;
});

test("runtime transforms user answers with authoritative pending chat context after sender validation", () => {
  const responses = [];
  const sender = {};
  const transformedContexts = [];
  const runtime = new CodexAppServerRuntime({
    transformUserInputAnswers(answers, context) {
      transformedContexts.push(context.chatSessionId);
      return { ...answers, question: { answers: ["protected-answer"] } };
    },
  });
  runtime.pendingInteractions.set("private-answer", {
    interactionId: "private-answer",
    kind: "user-input",
    context: { chatSessionId: "chat-private", sender },
    connection: { respond: (id, result) => responses.push({ id, result }) },
    rpcId: 90,
    params: {},
  });
  assert.equal(runtime.respondInteraction("private-answer", {
    answers: { question: { answers: ["private-input"] } },
  }, {}), false);
  assert.equal(transformedContexts.length, 0);
  assert.equal(runtime.respondInteraction("private-answer", {
    answers: { question: { answers: ["private-input"] } },
  }, sender), true);
  assert.deepEqual(transformedContexts, ["chat-private"]);
  assert.deepEqual(responses, [{ id: 90, result: { answers: { question: { answers: ["protected-answer"] } } } }]);
});

test("failed user answer transformation sends no raw reply and leaves interaction pending", () => {
  const responses = [];
  const runtime = new CodexAppServerRuntime({
    transformUserInputAnswers() { throw new Error("Privacy settings changed"); },
  });
  runtime.pendingInteractions.set("private-answer", {
    interactionId: "private-answer",
    kind: "user-input",
    context: { chatSessionId: "chat-private" },
    connection: { respond: (id, result) => responses.push({ id, result }) },
    rpcId: 91,
    params: {},
  });
  assert.throws(() => runtime.respondInteraction("private-answer", {
    answers: { question: { answers: ["private-input"] } },
  }), /Privacy settings changed/);
  assert.deepEqual(responses, []);
  assert.equal(runtime.pendingInteractions.has("private-answer"), true);
  runtime.close();
});

test("cancelInteractionTimeout re-arms the absolute approval deadline (Catty/MCP style)", async () => {
  let connection;
  let interaction;
  const realNow = Date.now;
  let now = 5_000_000;
  Date.now = () => now;

  const runtime = new CodexAppServerRuntime({
    connectionFactory: (options) => (connection = new FakeConnection(options)),
    sendInteractionRequest: (payload) => { interaction = payload; return true; },
  });
  try {
    const run = runtime.runTurn({
      requestId: "request-timeout-cancel",
      chatSessionId: "chat-timeout-cancel",
      prompt: "ask",
      permissionMode: "confirm",
      env: {},
      binPath: "/bin/codex",
      injectedMcpServers: [],
      emitter: createEmitter(),
    });
    await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));

    await connection.serverRequest({
      id: 90,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "question-timeout",
        questions: [{ id: "choice", question: "Choose", header: "Mode", isOther: true, isSecret: false, options: null }],
        autoResolutionMs: 100,
      },
    });
    assert.ok(interaction?.interactionId);

    // Jump close to the absolute ceiling, then cancel idle. Remaining absolute ~30ms.
    now += 70;
    assert.equal(runtime.cancelInteractionTimeout(interaction.interactionId), true);
    assert.equal(runtime.cancelInteractionTimeout(interaction.interactionId), false);

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(
      connection.responses.some((response) => response.id === 90),
      false,
      "must stay pending before absolute expiry",
    );

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      connection.responses.some((response) => response.id === 90),
      true,
      "absolute deadline must auto-reject after remaining time elapses",
    );
    assert.deepEqual(connection.responses.at(-1), {
      id: 90,
      result: { answers: {} },
    });

    connection.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });
    await run;
  } finally {
    Date.now = realNow;
  }
});

test("cancelInteractionTimeout still allows explicit approve before absolute expiry", async () => {
  let connection;
  let interaction;
  const runtime = new CodexAppServerRuntime({
    connectionFactory: (options) => (connection = new FakeConnection(options)),
    sendInteractionRequest: (payload) => { interaction = payload; return true; },
  });
  const run = runtime.runTurn({
    requestId: "request-timeout-approve",
    chatSessionId: "chat-timeout-approve",
    prompt: "ask",
    permissionMode: "confirm",
    env: {},
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter: createEmitter(),
  });
  await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));

  await connection.serverRequest({
    id: 91,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-approve",
      command: "echo ok",
      cwd: "/tmp",
      reason: "demo",
    },
  });
  assert.ok(interaction?.interactionId);
  assert.equal(runtime.cancelInteractionTimeout(interaction.interactionId), true);
  assert.equal(runtime.respondInteraction(interaction.interactionId, { decision: "once" }), true);
  assert.deepEqual(connection.responses.at(-1), {
    id: 91,
    result: { decision: "accept" },
  });

  connection.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });
  await run;
});

test("runtime steers the active turn with text, local images, and a stable user message id", async () => {
  let connection;
  const runtime = new CodexAppServerRuntime({
    connectionFactory: (options) => (connection = new FakeConnection(options)),
  });
  const run = runtime.runTurn({
    requestId: "request-steer",
    chatSessionId: "chat-steer",
    prompt: "initial",
    permissionMode: "confirm",
    env: {},
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter: createEmitter(),
  });
  await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));

  const result = await runtime.steerTurn("request-steer", {
    chatSessionId: "chat-steer",
    prompt: "use this image",
    attachments: [
      { filePath: "/tmp/image.png", mediaType: "image/png" },
      { filePath: "/tmp/notes.txt", mediaType: "text/plain" },
    ],
    clientUserMessageId: "user-steer-1",
  });

  assert.deepEqual(result, { status: "accepted" });
  assert.deepEqual(connection.requests.find((request) => request.method === "turn/steer"), {
    method: "turn/steer",
    params: {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [
        { type: "text", text: "use this image", text_elements: [] },
        { type: "localImage", path: "/tmp/image.png" },
      ],
      clientUserMessageId: "user-steer-1",
    },
  });

  connection.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });
  await run;
});

test("runtime serializes steering and classifies non-steerable turns", async () => {
  let connection;
  let releaseSteer;
  const runtime = new CodexAppServerRuntime({
    connectionFactory: (options) => {
      connection = new FakeConnection(options);
      connection.turnSteerGate = new Promise((resolve) => { releaseSteer = resolve; });
      return connection;
    },
  });
  const run = runtime.runTurn({
    requestId: "request-steer-busy",
    chatSessionId: "chat-steer-busy",
    prompt: "initial",
    permissionMode: "confirm",
    env: {},
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter: createEmitter(),
  });
  await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));

  const first = runtime.steerTurn("request-steer-busy", {
    chatSessionId: "chat-steer-busy",
    prompt: "first",
    clientUserMessageId: "user-first",
  });
  await waitFor(() => connection.requests.some((request) => request.method === "turn/steer"));
  assert.equal((await runtime.steerTurn("request-steer-busy", {
    chatSessionId: "chat-steer-busy",
    prompt: "second",
    clientUserMessageId: "user-second",
  })).status, "busy");
  releaseSteer();
  assert.equal((await first).status, "accepted");

  const error = new Error("active turn cannot be steered");
  error.data = { activeTurnNotSteerable: { turnKind: "review" } };
  connection.turnSteerError = error;
  const rejected = await runtime.steerTurn("request-steer-busy", {
    chatSessionId: "chat-steer-busy",
    prompt: "review change",
    clientUserMessageId: "user-review",
  });
  assert.deepEqual(rejected, {
    status: "not-steerable",
    turnKind: "review",
    message: "active turn cannot be steered",
  });

  connection.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });
  await run;
});

test("stop during steering cancels the UI result without creating a replacement turn", async () => {
  let connection;
  let releaseSteer;
  const runtime = new CodexAppServerRuntime({
    connectionFactory: (options) => {
      connection = new FakeConnection(options);
      connection.turnSteerGate = new Promise((resolve) => { releaseSteer = resolve; });
      return connection;
    },
  });
  const run = runtime.runTurn({
    requestId: "request-steer-stop",
    chatSessionId: "chat-steer-stop",
    prompt: "initial",
    permissionMode: "confirm",
    env: {},
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter: createEmitter(),
  });
  await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));
  const steer = runtime.steerTurn("request-steer-stop", {
    chatSessionId: "chat-steer-stop",
    prompt: "too late",
    clientUserMessageId: "user-steer-stop",
  });
  await waitFor(() => connection.requests.some((request) => request.method === "turn/steer"));
  assert.equal(await runtime.cancelTurn("request-steer-stop"), true);
  releaseSteer();
  assert.equal((await steer).status, "cancelled");
  assert.equal(connection.requests.filter((request) => request.method === "turn/start").length, 1);

  connection.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", error: null } } });
  await run;
});

test("stop requested while turn/start is pending interrupts the assigned turn", async () => {
  let connection;
  let releaseTurnStart;
  const runtime = new CodexAppServerRuntime({
    connectionFactory: (options) => {
      connection = new FakeConnection(options);
      connection.turnStartGate = new Promise((resolve) => { releaseTurnStart = resolve; });
      return connection;
    },
  });
  const emitter = createEmitter();
  const run = runtime.runTurn({
    requestId: "request-stop",
    chatSessionId: "chat-stop",
    prompt: "wait",
    permissionMode: "confirm",
    env: {},
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter,
  });
  await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));
  assert.equal(await runtime.cancelTurn("request-stop"), true);
  assert.equal(connection.requests.some((request) => request.method === "turn/interrupt"), false);

  releaseTurnStart();
  await waitFor(() => connection.requests.some((request) => request.method === "turn/interrupt"));
  connection.notify({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", error: null } },
  });
  await run;
  assert.equal(connection.requests.filter((request) => request.method === "turn/interrupt").length, 1);
  assert.ok(emitter.events.some((event) => event[0] === "done"));
});

test("failed interrupt force-settles the turn and releases its connection", async () => {
  let connection;
  const runtime = new CodexAppServerRuntime({
    interruptGraceMs: 5,
    connectionFactory: (options) => {
      connection = new FakeConnection(options);
      connection.turnInterruptError = new Error("interrupt unavailable");
      return connection;
    },
  });
  const run = runtime.runTurn({
    requestId: "request-interrupt-failure",
    chatSessionId: "chat-interrupt-failure",
    prompt: "wait",
    permissionMode: "confirm",
    env: {},
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter: createEmitter(),
  });
  await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));

  assert.equal(await runtime.cancelTurn("request-interrupt-failure"), true);
  await Promise.race([
    run,
    new Promise((_, reject) => setTimeout(() => reject(new Error("turn did not settle")), 50)),
  ]);

  assert.equal(connection.closed, true);
  assert.equal(runtime.activeByRequest.size, 0);
  assert.equal(runtime.activeByThread.size, 0);
  assert.equal(runtime.activeByTurn.size, 0);
});

test("hung interrupt request times out and force-settles the turn", async () => {
  let connection;
  const runtime = new CodexAppServerRuntime({
    interruptRequestTimeoutMs: 5,
    interruptGraceMs: 5,
    connectionFactory: (options) => {
      connection = new FakeConnection(options);
      connection.turnInterruptGate = new Promise(() => {});
      return connection;
    },
  });
  const run = runtime.runTurn({
    requestId: "request-interrupt-hung",
    chatSessionId: "chat-interrupt-hung",
    prompt: "wait",
    permissionMode: "confirm",
    env: {},
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter: createEmitter(),
  });
  await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));

  assert.equal(await runtime.cancelTurn("request-interrupt-hung"), true);
  await Promise.race([
    run,
    new Promise((_, reject) => setTimeout(() => reject(new Error("turn did not settle")), 50)),
  ]);

  assert.equal(connection.closed, true);
  assert.equal(runtime.activeByRequest.size, 0);
});

test("acknowledged interrupt force-settles when completion never arrives", async () => {
  let connection;
  const runtime = new CodexAppServerRuntime({
    interruptGraceMs: 5,
    connectionFactory: (options) => (connection = new FakeConnection(options)),
  });
  const run = runtime.runTurn({
    requestId: "request-interrupt-no-completion",
    chatSessionId: "chat-interrupt-no-completion",
    prompt: "wait",
    permissionMode: "confirm",
    env: {},
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter: createEmitter(),
  });
  await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));

  assert.equal(await runtime.cancelTurn("request-interrupt-no-completion"), true);
  await Promise.race([
    run,
    new Promise((_, reject) => setTimeout(() => reject(new Error("turn did not settle")), 50)),
  ]);

  assert.equal(connection.closed, true);
  assert.equal(runtime.activeByRequest.size, 0);
});

test("idle superseded app-server connections close when their active turn finishes", async () => {
  const connections = [];
  const runtime = new CodexAppServerRuntime({
    connectionFactory: (options) => {
      const connection = new FakeConnection(options);
      connection.threadId = `thread-${connections.length + 1}`;
      connection.turnId = `turn-${connections.length + 1}`;
      connections.push(connection);
      return connection;
    },
  });
  const firstRun = runtime.runTurn({
    requestId: "request-config-a",
    chatSessionId: "chat-config-a",
    prompt: "first",
    permissionMode: "confirm",
    env: { PROFILE: "a" },
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter: createEmitter(),
  });
  await waitFor(() => connections[0]?.requests.some((request) => request.method === "turn/start"));
  const secondRun = runtime.runTurn({
    requestId: "request-config-b",
    chatSessionId: "chat-config-b",
    prompt: "second",
    permissionMode: "confirm",
    env: { PROFILE: "b" },
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter: createEmitter(),
  });
  await waitFor(() => connections[1]?.requests.some((request) => request.method === "turn/start"));

  connections[0].notify({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
  });
  await firstRun;
  assert.equal(connections[0].closed, true);
  assert.equal(connections[1].closed, false);

  connections[1].notify({
    method: "turn/completed",
    params: { threadId: "thread-2", turn: { id: "turn-2", status: "completed", error: null } },
  });
  await secondRun;
  assert.equal(connections[1].closed, false);
  runtime.close();
});

test("force-cancelling the preferred connection keeps another active connection reusable", async () => {
  const connections = [];
  const runtime = new CodexAppServerRuntime({
    interruptGraceMs: 5,
    connectionFactory: (options) => {
      const connection = new FakeConnection(options);
      connection.threadId = `thread-reuse-${connections.length + 1}`;
      connection.turnId = `turn-reuse-${connections.length + 1}`;
      connections.push(connection);
      return connection;
    },
  });
  const firstRun = runtime.runTurn({
    requestId: "request-reuse-a",
    chatSessionId: "chat-reuse-a",
    prompt: "first",
    permissionMode: "confirm",
    env: { PROFILE: "reuse-a" },
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter: createEmitter(),
  });
  await waitFor(() => connections[0]?.requests.some((request) => request.method === "turn/start"));
  const secondRun = runtime.runTurn({
    requestId: "request-reuse-b",
    chatSessionId: "chat-reuse-b",
    prompt: "second",
    permissionMode: "confirm",
    env: { PROFILE: "reuse-b" },
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter: createEmitter(),
  });
  await waitFor(() => connections[1]?.requests.some((request) => request.method === "turn/start"));

  assert.equal(await runtime.cancelTurn("request-reuse-b"), true);
  await secondRun;
  connections[0].notify({
    method: "turn/completed",
    params: {
      threadId: "thread-reuse-1",
      turn: { id: "turn-reuse-1", status: "completed", error: null },
    },
  });
  await firstRun;

  assert.equal(connections[0].closed, false);
  runtime.close();
});

test("unsupported requests fail immediately and warn without hanging", async () => {
  let connection;
  const emitter = createEmitter();
  const runtime = new CodexAppServerRuntime({
    connectionFactory: (options) => (connection = new FakeConnection(options)),
  });
  const run = runtime.runTurn({
    requestId: "request-unsupported",
    chatSessionId: "chat-unsupported",
    prompt: "hello",
    permissionMode: "confirm",
    env: {},
    binPath: "/bin/codex",
    injectedMcpServers: [],
    emitter,
  });
  await waitFor(() => connection?.requests.some((request) => request.method === "turn/start"));
  await connection.serverRequest({
    id: 99,
    method: "item/unknown/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1" },
  });
  assert.deepEqual(connection.responses.at(-1), {
    id: 99,
    error: { code: -32601, message: "Unsupported Codex App Server request: item/unknown/requestApproval" },
  });
  assert.ok(emitter.events.some((event) => event[0] === "warning"));
  await connection.serverRequest({
    id: 100,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-no-renderer", command: "rm -rf /" },
  });
  assert.deepEqual(connection.responses.at(-1), { id: 100, result: { decision: "decline" } });
  connection.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } } });
  await run;
});

test("model and file-change normalization preserve UI contract", async () => {
  assert.deepEqual(normalizeFileChanges([
    { path: "a", kind: { type: "add" } },
    { path: "b", kind: { type: "delete" } },
    { path: "c", kind: { type: "update", move_path: null } },
  ]), [
    { path: "a", kind: "add" },
    { path: "b", kind: "delete" },
    { path: "c", kind: "update" },
  ]);
  assert.equal(mapAppServerModels([{ id: "hidden", hidden: true }]).length, 0);

  let connection;
  const runtime = new CodexAppServerRuntime({
    connectionFactory: (options) => (connection = new FakeConnection(options)),
  });
  const catalog = await runtime.listModels({ binPath: "/bin/codex", env: {} });
  assert.equal(connection.requests[0].method, "model/list");
  assert.equal(catalog.currentModelId, "gpt-test/high");
  assert.equal(catalog.models[0].id, "gpt-first");
  assert.deepEqual(catalog.models[1].thinkingLevels, ["low", "high"]);
  assert.equal(catalog.models[1].defaultThinkingLevel, "high");
});

for (const startupStage of ["connection", "thread"]) {
  test(`privacy off-to-on while Codex ${startupStage} startup is paused prevents turn/start`, async () => {
    const { createAiPrivacyService } = require("../../../shared/aiPrivacyService.cjs");
    const privacy = createAiPrivacyService();
    privacy.checkSession("chat-privacy-race");
    let notifyReady;
    let release;
    const ready = new Promise((resolve) => { notifyReady = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let connection;
    const runtime = new CodexAppServerRuntime({
      connectionFactory: (options) => {
        connection = new FakeConnection(options);
        if (startupStage === "connection") {
          connection.start = async () => { notifyReady(); await gate; };
        } else {
          const request = connection.request.bind(connection);
          connection.request = async (method, params) => {
            if (method === "thread/start") { notifyReady(); await gate; }
            return request(method, params);
          };
        }
        return connection;
      },
    });
    const run = runtime.runTurn({
      requestId: "privacy-race", chatSessionId: "chat-privacy-race",
      prompt: "raw-secret", binPath: "/bin/codex", emitter: createEmitter(),
      assertSessionValid: () => privacy.checkSession("chat-privacy-race"),
    });
    const rejected = assert.rejects(run, /start a new chat/);
    await ready;
    privacy.configure({ enabled: true });
    release();
    await rejected;
    assert.equal(connection.requests.some(({ method }) => method === "turn/start"), false);
    assert.equal(runtime.activeByRequest.size, 0);
    assert.equal(runtime.activeByThread.size, 0);
    await runtime.cleanupChatSession("chat-privacy-race");
  });
}
