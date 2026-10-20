"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionService } = require("./sessionService.cjs");

test("closeTracked uses the same lifecycle while bypassing user-scope validation", async () => {
  const events = [];
  const service = createSessionService({
    validateClose: () => ({ ok: false, error: "scope was cleaned" }),
    beforeClose: async () => events.push("before"),
    invokeSessionAgent: async () => ({ ok: true, status: "closed" }),
    onClosed: async () => events.push("closed"),
    afterClose: async (_params, outcome) => events.push(outcome.closed ? "success" : "failed"),
  });

  const manualResult = await service.close({ sessionId: "session-1" });
  assert.equal(manualResult.ok, false);
  assert.deepEqual(events, []);

  const idleResult = await service.closeTracked({ sessionId: "session-1" });
  assert.equal(idleResult.ok, true);
  assert.deepEqual(events, ["before", "closed", "success"]);
});

test("failed closes report the outcome so idle tracking can resume", async () => {
  let outcome = null;
  const service = createSessionService({
    invokeSessionAgent: async () => ({ ok: false, error: "renderer unavailable" }),
    afterClose: async (_params, value) => {
      outcome = value;
    },
  });

  const result = await service.closeTracked({ sessionId: "session-1" });
  assert.equal(result.ok, false);
  assert.equal(outcome.closed, false);
  assert.equal(outcome.notFound, false);
  assert.deepEqual(outcome.result, result);
});

test("already-missing sessions are distinguished from retryable close failures", async () => {
  let outcome = null;
  const service = createSessionService({
    invokeSessionAgent: async () => ({ ok: false, error: 'Session "gone" was not found.' }),
    afterClose: async (_params, value) => {
      outcome = value;
    },
  });

  const result = await service.closeTracked({ sessionId: "gone" });
  assert.equal(result.ok, false);
  assert.equal(outcome.closed, false);
  assert.equal(outcome.notFound, true);
});

test("close rechecks its execution guard after cleanup and preserves failed-close lifecycle", async () => {
  const { createAiPrivacyService } = require("../../shared/aiPrivacyService.cjs");
  const privacy = createAiPrivacyService();
  privacy.checkSession("chat");
  let invokeCount = 0;
  let outcome;
  const service = createSessionService({
    beforeClose: async () => { privacy.configure({ enabled: true }); },
    invokeSessionAgent: async () => { invokeCount++; return { ok: true }; },
    afterClose: async (_params, value) => { outcome = value; },
  });
  await assert.rejects(service.close({ sessionId: "session-1" }, {
    beforeExecute: () => privacy.restore("chat", []),
  }), /start a new chat/);
  assert.equal(invokeCount, 0);
  assert.equal(outcome.closed, false);
  assert.equal(outcome.notFound, false);
});
