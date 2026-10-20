const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  CodexAppServerConnection,
  buildCodexAppServerKey,
  buildCodexAppServerLaunch,
} = require("./connection.cjs");

function createFakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

async function readJsonLine(stream) {
  const [chunk] = await once(stream, "data");
  return JSON.parse(String(chunk).trim());
}

test("buildCodexAppServerLaunch runs JS entries through Node without a shell", () => {
  assert.deepEqual(
    buildCodexAppServerLaunch("/opt/codex/bin/codex.js", ["app-server", "--help"], { nodePath: "/usr/bin/node" }),
    {
      command: "/usr/bin/node",
      args: ["/opt/codex/bin/codex.js", "app-server", "--help"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  assert.deepEqual(
    buildCodexAppServerLaunch("/usr/local/bin/codex"),
    { command: "/usr/local/bin/codex", args: ["app-server", "--stdio"] },
  );
  assert.throws(() => buildCodexAppServerLaunch("C:\\npm\\codex.cmd"), /shell shim/);
});

test("App Server connection initializes once and correlates JSONL requests", async () => {
  const child = createFakeChild();
  const notifications = [];
  const connection = new CodexAppServerConnection({
    binPath: "/usr/bin/codex",
    env: { HOME: "/tmp/home" },
    appVersion: "1.2.3",
    spawnImpl: () => child,
    onNotification: (message) => notifications.push(message),
  });

  const startPromise = connection.start();
  const initialize = await readJsonLine(child.stdin);
  assert.equal(initialize.method, "initialize");
  assert.equal(initialize.params.clientInfo.name, "netcatty");
  assert.equal(initialize.params.capabilities.experimentalApi, true);
  child.stdout.write(`${JSON.stringify({ id: initialize.id, result: { userAgent: "codex" } })}\n`);
  await startPromise;
  const initialized = await readJsonLine(child.stdin);
  assert.equal(initialized.method, "initialized");

  const requestPromise = connection.request("model/list", { limit: 100 });
  const request = await readJsonLine(child.stdin);
  assert.equal(request.method, "model/list");
  child.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } })}\n`);
  assert.deepEqual(await requestPromise, { data: [], nextCursor: null });

  child.stdout.write(`${JSON.stringify({ method: "warning", params: { message: "heads up" } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications[0].method, "warning");
  connection.close();
});

test("App Server connection preserves a Chinese response split across UTF-8 chunks", async () => {
  const child = createFakeChild();
  const connection = new CodexAppServerConnection({
    binPath: "/usr/bin/codex",
    env: {},
    spawnImpl: () => child,
  });

  const startPromise = connection.start();
  const initialize = await readJsonLine(child.stdin);
  const response = Buffer.from(`${JSON.stringify({
    id: initialize.id,
    result: { message: "中文" },
  })}\n`, "utf8");
  const split = response.indexOf(Buffer.from("中", "utf8")) + 1;
  child.stdout.write(response.subarray(0, split));
  child.stdout.write(response.subarray(split));
  await startPromise;
  await readJsonLine(child.stdin);
  connection.close();
});

test("App Server connection rejects an unterminated oversized JSONL message", async () => {
  const child = createFakeChild();
  let fatal;
  const connection = new CodexAppServerConnection({
    binPath: "/usr/bin/codex",
    env: {},
    maxJsonlLineBytes: 8,
    spawnImpl: () => child,
    onFatal: (error) => { fatal = error; },
  });

  const startPromise = connection.start();
  await readJsonLine(child.stdin);
  child.stdout.write("123456789");

  await assert.rejects(startPromise, /message exceeded 8 bytes/);
  assert.match(fatal.message, /message exceeded 8 bytes/);
  assert.equal(child.killed, true);
});

test("App Server connection rejects pending RPCs when the process exits", async () => {
  const child = createFakeChild();
  let fatal;
  const connection = new CodexAppServerConnection({
    binPath: "/usr/bin/codex",
    env: {},
    spawnImpl: () => child,
    onFatal: (error) => { fatal = error; },
  });
  const startPromise = connection.start();
  const initialize = await readJsonLine(child.stdin);
  child.stdout.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await startPromise;
  await readJsonLine(child.stdin); // initialized notification

  const request = connection.request("thread/start", {});
  await readJsonLine(child.stdin);
  child.emit("exit", 1, null);
  await assert.rejects(request, /exited unexpectedly/);
  assert.match(fatal.message, /code 1/);
});

test("App Server close force-kills a child that ignores SIGTERM", async () => {
  const child = createFakeChild();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  const connection = new CodexAppServerConnection({
    binPath: "/usr/bin/codex",
    env: {},
    closeKillGraceMs: 5,
    spawnImpl: () => child,
  });
  const startPromise = connection.start();
  const initialize = await readJsonLine(child.stdin);
  child.stdout.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await startPromise;
  await readJsonLine(child.stdin);

  connection.close();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("App Server close does not retain or re-kill a child that exits synchronously on SIGTERM", async () => {
  const child = createFakeChild();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGTERM") child.emit("exit", 0, "SIGTERM");
    return true;
  };
  const connection = new CodexAppServerConnection({
    binPath: "/usr/bin/codex",
    env: {},
    closeKillGraceMs: 5,
    spawnImpl: () => child,
  });
  const startPromise = connection.start();
  const initialize = await readJsonLine(child.stdin);
  child.stdout.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await startPromise;
  await readJsonLine(child.stdin);

  connection.close();
  assert.equal(connection.getClosingProcessCountForTests(), 0);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(signals, ["SIGTERM"]);
});

test("App Server process keys include executable and environment identity", () => {
  assert.notEqual(
    buildCodexAppServerKey("/a/codex", { HOME: "/a" }),
    buildCodexAppServerKey("/b/codex", { HOME: "/a" }),
  );
  assert.notEqual(
    buildCodexAppServerKey("/a/codex", { HOME: "/a" }),
    buildCodexAppServerKey("/a/codex", { HOME: "/b" }),
  );
});

test("prompt guard runs after the connection's own startup await and prevents the JSONL write", async () => {
  const { createAiPrivacyService } = require("../../../shared/aiPrivacyService.cjs");
  const privacy = createAiPrivacyService();
  privacy.checkSession("chat");
  const child = createFakeChild();
  const writes = [];
  child.stdin.on("data", (chunk) => writes.push(String(chunk)));
  const connection = new CodexAppServerConnection({ binPath: "/bin/codex", spawnImpl: () => child });
  let release;
  connection.process = child;
  connection.start = () => new Promise((resolve) => { release = resolve; });
  const run = connection.request("turn/start", { input: [{ type: "text", text: "raw-secret" }] }, undefined, {
    beforeSend: () => privacy.checkSession("chat"),
  });
  const rejected = assert.rejects(run, /start a new chat/);
  privacy.configure({ enabled: true });
  release();
  await rejected;
  assert.deepEqual(writes, []);
  assert.equal(connection.pending.size, 0);
  connection.close();
});
