const test = require("node:test");
const assert = require("node:assert/strict");
const { createStreamEmitter } = require("./emit.cjs");

function recordingSend() {
  const calls = [];
  const safeSend = (sender, channel, payload) => calls.push({ channel, payload });
  return { calls, safeSend };
}

test("emitEvent sends on netcatty:ai:sdk-agent:event with requestId+event", () => {
  const { calls, safeSend } = recordingSend();
  const e = createStreamEmitter({ safeSend, sender: {}, requestId: "req-1" });
  e.emitEvent({ type: "text-delta", textDelta: "hi" });
  assert.deepEqual(calls[0], {
    channel: "netcatty:ai:sdk-agent:event",
    payload: { requestId: "req-1", event: { type: "text-delta", textDelta: "hi" } },
  });
});

test("emitDone sends on netcatty:ai:sdk-agent:done", () => {
  const { calls, safeSend } = recordingSend();
  const e = createStreamEmitter({ safeSend, sender: {}, requestId: "req-2" });
  e.emitDone();
  assert.deepEqual(calls[0], { channel: "netcatty:ai:sdk-agent:done", payload: { requestId: "req-2" } });
});

test("emitError sends on netcatty:ai:sdk-agent:error with message", () => {
  const { calls, safeSend } = recordingSend();
  const e = createStreamEmitter({ safeSend, sender: {}, requestId: "req-3" });
  e.emitError("boom");
  assert.deepEqual(calls[0], { channel: "netcatty:ai:sdk-agent:error", payload: { requestId: "req-3", error: "boom" } });
});

test("convenience helpers emit the canonical event shapes", () => {
  const { calls, safeSend } = recordingSend();
  const e = createStreamEmitter({ safeSend, sender: {}, requestId: "r" });
  e.text("abc");
  e.toolCall("terminal_execute", { command: "ls" }, "tc-1");
  e.toolResult("tc-1", "out", "terminal_execute");
  e.fileChange("patch-1", [{ path: "src/app.ts", kind: "update" }], "completed");
  e.webSearch("search-1", "Codex events", "running");
  e.planUpdate("plan-1", [{ text: "Map events", completed: false }], "running");
  e.warning("warning-1", "Search unavailable");
  e.usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  e.status("Working...");
  e.sessionId("sess-9");
  assert.deepEqual(calls.map((c) => c.payload.event.type),
    [
      "text-delta", "tool-call", "tool-result", "file-change", "web-search",
      "plan-update", "warning", "usage", "status", "session-id",
    ]);
  assert.equal(calls[1].payload.event.toolName, "terminal_execute");
  assert.equal(calls[1].payload.event.toolCallId, "tc-1");
  assert.deepEqual(calls[1].payload.event.args, { command: "ls" });
  assert.equal(calls[2].payload.event.output, "out");
  assert.equal(calls[3].payload.event.itemId, "patch-1");
  assert.equal(calls[7].payload.event.totalTokens, 15);
  assert.equal(calls[9].payload.event.sessionId, "sess-9");
});

const PRIVATE_TOKEN = "[NC_aabbccddeeff_SECRET_1]";
function restoreTestValue(value) {
  if (typeof value === "string") {
    return value.replace(/\[NC_[^\]]*(?:\]|$)/g, (token) => {
      if (token !== PRIVATE_TOKEN) throw new Error("Unknown privacy token");
      return "private-original";
    });
  }
  if (Array.isArray(value)) return value.map(restoreTestValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restoreTestValue(entry)]));
  }
  return value;
}

test("privacy restoration buffers tokens at every text and reasoning split boundary", () => {
  for (const stream of ["text", "reasoning"]) {
    for (let split = 1; split < PRIVATE_TOKEN.length; split += 1) {
      const { calls, safeSend } = recordingSend();
      const emitter = createStreamEmitter({
        safeSend, sender: {}, requestId: "private", restoreValue: restoreTestValue,
      });
      emitter[stream](`Before ${PRIVATE_TOKEN.slice(0, split)}`);
      emitter[stream](`${PRIVATE_TOKEN.slice(split)} after`);
      if (stream === "reasoning") emitter.reasoningEnd();
      emitter.emitDone();
      const text = calls.map((entry) => entry.payload.event?.textDelta || entry.payload.event?.delta || "").join("");
      assert.equal(text, "Before private-original after", `${stream} split ${split}`);
      assert.doesNotMatch(JSON.stringify(calls), /\[NC_/);
    }
  }
});

test("privacy restoration supports character-at-a-time tokens and preserves event routing identifiers", () => {
  const { calls, safeSend } = recordingSend();
  const emitter = createStreamEmitter({
    safeSend, sender: {}, requestId: PRIVATE_TOKEN, restoreValue: restoreTestValue,
  });
  for (const character of PRIVATE_TOKEN) emitter.emitEvent({ type: "text-delta", textDelta: character });
  emitter.toolCall(PRIVATE_TOKEN, { command: `echo ${PRIVATE_TOKEN}` }, PRIVATE_TOKEN);
  emitter.sessionId(PRIVATE_TOKEN);
  emitter.emitDone();
  const events = calls.filter((entry) => entry.payload.event).map((entry) => entry.payload.event);
  assert.equal(events[0].textDelta, "private-original");
  assert.equal(events[1].toolName, PRIVATE_TOKEN);
  assert.equal(events[1].toolCallId, PRIVATE_TOKEN);
  assert.deepEqual(events[1].args, { command: "echo private-original" });
  assert.equal(events[2].sessionId, PRIVATE_TOKEN);
  assert.ok(calls.every((entry) => entry.payload.requestId === PRIVATE_TOKEN));
});

test("privacy restoration restores activity fields and never emits an unfinished token on abort", () => {
  const { calls, safeSend } = recordingSend();
  const emitter = createStreamEmitter({
    safeSend, sender: {}, requestId: "private", restoreValue: restoreTestValue,
  });
  emitter.toolResult("tool-1", { output: PRIVATE_TOKEN }, "tool");
  emitter.fileChange("file-1", [{ path: PRIVATE_TOKEN }], "completed");
  emitter.planUpdate("plan-1", [{ text: PRIVATE_TOKEN }], "running");
  emitter.webSearch("search-1", PRIVATE_TOKEN, "completed");
  emitter.warning("warning-1", PRIVATE_TOKEN);
  emitter.text("Before [NC_aabb");
  emitter.emitError("Aborted");
  assert.doesNotMatch(JSON.stringify(calls), /\[NC_/);
  assert.equal(calls.at(-1).payload.error, "Aborted");
  assert.match(JSON.stringify(calls), /private-original/);
});

test("privacy restoration fails closed on unknown complete tokens and incomplete final tokens", () => {
  const { calls, safeSend } = recordingSend();
  const emitter = createStreamEmitter({
    safeSend, sender: {}, requestId: "private", restoreValue: restoreTestValue,
  });
  assert.throws(() => emitter.text("[NC_other_SECRET_1]"), /Unknown privacy token/);
  emitter.text("[NC_incomplete");
  assert.throws(() => emitter.emitDone(), /Unknown privacy token/);
  emitter.emitError("[NC_other_SECRET_1]");
  assert.equal(calls.length, 1);
  assert.match(calls[0].payload.error, /Start a new conversation/);
  assert.doesNotMatch(JSON.stringify(calls), /\[NC_/);
});

test("disabled emitter does not buffer token-looking literal text", () => {
  const { calls, safeSend } = recordingSend();
  const emitter = createStreamEmitter({ safeSend, sender: {}, requestId: "plain" });
  emitter.text("[NC_");
  assert.equal(calls[0].payload.event.textDelta, "[NC_");
});
