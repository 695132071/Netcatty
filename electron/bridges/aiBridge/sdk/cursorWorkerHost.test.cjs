"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { runCursorWorkerTurn } = require("./cursorWorkerHost.cjs");

const fixture = `
process.on('message', (message) => {
  if (message.type !== 'start') return;
  const data = message.params;
  process.send({ type: 'event', method: 'sessionId', args: [data.resumeSessionId] });
  process.send({ type: 'event', method: 'text', args: [process.env.NETCATTY_CLI_CHAT_SESSION_ID] });
  if (data.prompt !== 'hang') {
    process.send({ type: 'event', method: 'emitDone', args: [] });
    process.send({ type: 'result', result: { sessionId: data.resumeSessionId } });
  }
});
`;

test("real Cursor workers isolate environments and a cancelled stuck worker cannot block the next turn", async () => {
  const workers = [];
  const createWorker = (options) => {
    const worker = spawn(process.execPath, ["-e", fixture], {
      ...options, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    worker.postMessage = worker.send.bind(worker);
    workers.push(worker);
    return worker;
  };
  const original = process.env.NETCATTY_CLI_CHAT_SESSION_ID;
  const callsA = [];
  const callsB = [];
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const emitter = (calls, onText = () => {}) => ({
    sessionId: (id) => calls.push(["session", id]),
    text: (text) => { calls.push(["text", text]); onText(); },
    emitDone: () => calls.push(["done"]),
    emitError: (error) => calls.push(["error", error]),
  });
  const controller = new AbortController();
  try {
    const first = runCursorWorkerTurn({
      prompt: "hang", resumeSessionId: "agent-a", signal: controller.signal,
      runtimeEnv: { NETCATTY_CLI_CHAT_SESSION_ID: "chat-a" }, emitter: emitter(callsA, ready),
    }, createWorker);
    await started;
    const exited = once(workers[0], "exit");
    controller.abort();
    assert.deepEqual(await first, { sessionId: "agent-a" });
    const second = await runCursorWorkerTurn({
      prompt: "finish", resumeSessionId: "agent-b",
      runtimeEnv: { NETCATTY_CLI_CHAT_SESSION_ID: "chat-b" }, emitter: emitter(callsB),
    }, createWorker);
    assert.deepEqual(second, { sessionId: "agent-b" });
    assert.deepEqual(callsA, [["session", "agent-a"], ["text", "chat-a"]]);
    assert.deepEqual(callsB, [["session", "agent-b"], ["text", "chat-b"], ["done"]]);
    assert.equal(process.env.NETCATTY_CLI_CHAT_SESSION_ID, original);
    await exited;
  } finally {
    for (const worker of workers) worker.kill();
  }
});

test("an already cancelled Cursor turn never starts a worker", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runCursorWorkerTurn({ signal: controller.signal, emitter: {}, resumeSessionId: "old" },
    () => { throw new Error("must not start"); });
  assert.deepEqual(result, { sessionId: "old" });
});

test("Cursor worker startup errors reach the existing chat error path", async () => {
  const errors = [];
  const result = await runCursorWorkerTurn({ emitter: { emitError: (error) => errors.push(error) } },
    () => { throw new Error("worker unavailable"); });
  assert.deepEqual(errors, ["worker unavailable"]);
  assert.deepEqual(result, { sessionId: null });
});

test("stopping before the utility process spawns does not dispatch a turn", async () => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter();
  const sent = [];
  let killed = false;
  child.postMessage = (message) => sent.push(message);
  child.kill = () => { killed = true; child.emit("exit", 0); };
  const controller = new AbortController();
  const turn = runCursorWorkerTurn({ signal: controller.signal, emitter: {} }, () => child);
  controller.abort();
  assert.deepEqual(await turn, { sessionId: null });
  child.emit("spawn");
  assert.equal(killed, true);
  assert.deepEqual(sent, []);
});

test("utility-process fatal errors retain their reason and settle only once", async () => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter();
  const errors = [];
  let kills = 0;
  child.kill = () => { kills++; child.emit("exit", 1); };
  const turn = runCursorWorkerTurn({
    resumeSessionId: "existing-session",
    emitter: { emitError: (message) => errors.push(message) },
  }, () => child);
  child.emit("error", "FatalError", "v8::Heap", '{"environmentVariables":{"API_KEY":"secret"}}');
  assert.deepEqual(await turn, { sessionId: "existing-session" });
  assert.deepEqual(errors, ["FatalError: v8::Heap"]);
  assert.equal(kills, 1);
});

test("Cursor worker startup withholds semantic content until main validates the prompt handoff", async () => {
  const { EventEmitter } = require("node:events");
  const { createAiPrivacyService } = require("../../../shared/aiPrivacyService.cjs");
  const privacy = createAiPrivacyService();
  privacy.checkSession("chat");
  const child = new EventEmitter();
  const sent = [];
  const errors = [];
  let killed = false;
  child.postMessage = (message) => sent.push(structuredClone(message));
  child.kill = () => { killed = true; child.emit("exit", 0); };
  const turn = runCursorWorkerTurn({
    prompt: "raw-secret", attachments: [{ data: "raw-image" }],
    emitter: { emitError: (error) => errors.push(error) },
    assertSessionValid: () => privacy.checkSession("chat"),
  }, () => child);
  child.emit("spawn");
  assert.equal(sent[0].type, "start");
  assert.equal(sent[0].params.deferPrompt, true);
  assert.equal("prompt" in sent[0].params, false);
  assert.equal("attachments" in sent[0].params, false);
  assert.equal("assertSessionValid" in sent[0].params, false);
  privacy.configure({ enabled: true });
  child.emit("message", { type: "prompt-request" });
  await turn;
  assert.equal(sent.length, 1);
  assert.equal(killed, true);
  assert.match(errors.join("\n"), /start a new chat/);
});

test("Cursor releases the original prompt only on a valid post-startup request", async () => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter();
  const sent = [];
  let checks = 0;
  child.postMessage = (message) => sent.push(structuredClone(message));
  child.kill = () => child.emit("exit", 0);
  const turn = runCursorWorkerTurn({
    prompt: "hello", attachments: [], emitter: {},
    assertSessionValid: () => { checks++; },
  }, () => child);
  child.emit("spawn");
  child.emit("message", { type: "prompt-request" });
  assert.equal(checks, 2);
  assert.deepEqual(sent[1], { type: "prompt", prompt: "hello", attachments: [] });
  child.emit("message", { type: "result", result: { sessionId: null } });
  await turn;
});
