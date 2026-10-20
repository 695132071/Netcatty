"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { registerPrivacyHandlers } = require("./aiBridge/privacyHandlers.cjs");
const { createAiPrivacyService } = require("../shared/aiPrivacyService.cjs");

test("AI privacy IPC validates sender and shares semantic transforms", async () => {
  const handlers = new Map();
  const service = createAiPrivacyService();
  service.configure({ enabled: true });
  registerPrivacyHandlers({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    validateSender: (event) => event.trusted === true,
    aiPrivacyService: service,
  });
  const transform = handlers.get("netcatty:ai:privacy:transform");
  assert.equal(transform({}, {}).ok, false);
  const request = { chatSessionId: "catty-chat", operation: "redact", value: ["password=synthetic-secret", "192.0.2.1"] };
  const masked = transform({ trusted: true }, request);
  assert.equal(masked.ok, true);
  assert.doesNotMatch(JSON.stringify(masked.value), /synthetic-secret|192\.0\.2\.1/);
  assert.deepEqual(transform({ trusted: true }, { ...request, operation: "restore", value: masked.value }).value, request.value);
  handlers.get("netcatty:ai:privacy:clear")({ trusted: true }, request.chatSessionId);
  assert.equal(transform({ trusted: true }, { ...request, operation: "restore", value: masked.value }).ok, false);
  service.invalidateConfiguration();
  assert.equal(handlers.get("netcatty:ai:privacy:status")({ trusted: true }).ok, false);
});
