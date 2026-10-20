"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const moduleExports = require("./aiPrivacyService.cjs");
const { createAiPrivacyService, aiPrivacyService } = moduleExports;

const TOKEN = /^\[NC_[a-f0-9]{12}_(?:IP|HOST|SECRET)_\d+\]$/;
const NEW_CHAT = /start a new chat/;
const enabledService = (policy = {}, limits) => {
  const service = createAiPrivacyService(limits);
  service.configure({ enabled: true, ...policy });
  return service;
};

test("singleton and factory expose validated, copied, disabled-by-default configuration", () => {
  assert.equal(moduleExports.redact, aiPrivacyService.redact);
  assert.throws(() => aiPrivacyService.isEnabled(), /settings are still loading/);
  const service = createAiPrivacyService();
  assert.deepEqual(service.getConfig(), { enabled: false, redactPrivateIps: false, cidrs: [], patterns: [] });
  assert.equal(service.isEnabled(), false);
  const source = { password: "synthetic-password", binary: Buffer.from("synthetic") };
  assert.equal(service.redact("disabled-chat", source), source);
  assert.equal(service.restore("disabled-chat", source), source);
  assert.equal(service.checkSession("disabled-chat"), false);
  assert.equal(service.hasSession("disabled-chat"), false);
  const policy = { enabled: true, patterns: ["ACCOUNT-[0-9]+"], cidrs: ["10.0.0.0/8"] };
  const configured = service.configure(policy);
  configured.patterns.push("changed");
  policy.cidrs.push("192.168.0.0/16");
  assert.deepEqual(service.getConfig().patterns, ["ACCOUNT-[0-9]+"]);
  assert.deepEqual(service.getConfig().cidrs, ["10.0.0.0/8"]);
  const read = service.getConfig();
  read.enabled = false;
  read.cidrs.length = 0;
  assert.equal(service.isEnabled(), true);
  assert.deepEqual(service.getConfig().cidrs, ["10.0.0.0/8"]);
  assert.throws(() => aiPrivacyService.isEnabled(), /settings are still loading/);
});

test("production singleton fails closed until persisted policy is initialized successfully", () => {
  const startupOperations = [
    () => aiPrivacyService.isEnabled(),
    () => aiPrivacyService.getConfig(),
    () => aiPrivacyService.checkSession("startup"),
    () => aiPrivacyService.redact("startup", "8.8.8.8"),
    () => aiPrivacyService.restore("startup", "8.8.8.8"),
  ];
  for (const operation of startupOperations) {
    assert.throws(operation, { message: "AI privacy settings are still loading; try again" });
  }
  assert.equal(aiPrivacyService.hasSession("startup"), false);
  assert.throws(() => aiPrivacyService.configure({ enabled: "corrupt-saved-value" }),
    { message: "Invalid AI privacy configuration" });
  for (const operation of startupOperations) {
    assert.throws(operation, { message: "Invalid AI privacy configuration" });
  }
  aiPrivacyService.configure({ enabled: true });
  assert.equal(aiPrivacyService.isEnabled(), true);
  // Failed pre-initialization calls must not leave a disabled snapshot behind.
  assert.match(aiPrivacyService.redact("startup", "8.8.8.8"), TOKEN);
  aiPrivacyService.invalidateConfiguration();
  assert.throws(() => aiPrivacyService.isEnabled(), /Invalid AI privacy configuration/);
  aiPrivacyService.configure({ enabled: false });
  assert.equal(aiPrivacyService.isEnabled(), false);
  assert.throws(() => aiPrivacyService.redact("startup", "8.8.8.8"), NEW_CHAT);
  assert.equal(aiPrivacyService.redact("loaded-disabled", "8.8.8.8"), "8.8.8.8");
});

test("a pending factory can initialize a valid disabled policy without blocking its first chat", () => {
  const service = createAiPrivacyService({ initialized: false });
  assert.throws(() => service.checkSession("waiting"), /settings are still loading/);
  service.configure({});
  assert.equal(service.checkSession("waiting"), false);
  assert.equal(service.redact("waiting", "8.8.8.8"), "8.8.8.8");
});

test("maps are isolated per stable chat identity and per service instance", () => {
  const service = enabledService();
  assert.equal(service.hasSession("chat-one"), false);
  assert.equal(service.checkSession("chat-one"), true);
  assert.equal(service.hasSession("chat-one"), true);
  const one = service.redact("chat-one", "8.8.8.8");
  const two = service.redact("chat-two", "8.8.8.8");
  assert.match(one, TOKEN);
  assert.match(two, TOKEN);
  assert.notEqual(one, two);
  assert.equal(service.redact("chat-one", "8.8.8.8"), one);
  assert.equal(service.restore("chat-one", one), "8.8.8.8");
  assert.throws(() => service.restore("chat-two", one), /Unknown AI privacy token/);
  assert.throws(() => service.redact("chat-two", one), /Unknown AI privacy token/);
  const other = enabledService();
  other.checkSession("chat-one");
  assert.throws(() => other.restore("chat-one", one), /Unknown AI privacy token/);
  assert.notEqual(other.redact("chat-one", "8.8.8.8"), one);
});

test("multiple model boundaries preserve existing aliases, including numeric and boolean secrets", () => {
  const service = enabledService();
  const source = { host: "synthetic.example.test", password: "synthetic-secret", token: 123456, secret: false };
  const first = service.redact("chat", source);
  assert.deepEqual(service.redact("chat", first), first);
  assert.deepEqual(service.redact("chat", { text: first.token, nested: [first.secret, first.host] }),
    { text: first.token, nested: [first.secret, first.host] });
  assert.equal(service.redact("chat", first.token), first.token);
  assert.equal(service.restore("chat", first.token), 123456);
  assert.equal(service.restore("chat", first.secret), false);
  assert.deepEqual(service.restore("chat", first), source);
  const later = service.redact("chat", `${first.host} with synthetic-secret and 1.1.1.1`);
  assert.equal(later.includes(first.host), true);
  assert.equal(later.includes(first.password), true);
  assert.equal(later.includes("1.1.1.1"), false);
  assert.equal(service.restore("chat", later), "synthetic.example.test with synthetic-secret and 1.1.1.1");
});

test("unknown, malformed, cross-chat and modified aliases fail closed, including preserved keys", () => {
  const service = enabledService();
  const token = service.redact("chat", "8.8.8.8");
  for (const value of [
    "[NC_literal]", "[NC_unclosed", token.replace("_IP_", "_HOST_"),
    { "[NC_unknown]": "ordinary" }, { text: "[NC_unknown]" },
  ]) {
    assert.throws(() => service.redact("chat", value), { message: "Unknown AI privacy token; start a new chat" });
    assert.throws(() => service.restore("chat", value), { message: "Unknown AI privacy token; start a new chat" });
  }
  assert.throws(() => service.restore("unseen", token), NEW_CHAT);
  assert.equal(service.hasSession("unseen"), false);
});

test("semantic root control keys stay intact while nested user-data keys are protected", () => {
  const service = enabledService();
  const source = {
    stdout: "password=stdout\n8.8.8.8", stderr: "", exitCode: 0,
    details: { stdout: "nested key", "8.8.8.8": "address key" },
  };
  const masked = service.redact("chat", source);
  assert.deepEqual(Object.keys(masked), Object.keys(source));
  assert.equal(Object.hasOwn(masked.details, "stdout"), false);
  assert.equal(Object.hasOwn(masked.details, "8.8.8.8"), false);
  assert.deepEqual(service.redact("chat", masked), masked);
  assert.deepEqual(service.restore("chat", masked), source);
  assert.equal(source.stdout, "password=stdout\n8.8.8.8");
});

test("hostnames are remembered across earlier fields, later responses and model boundaries", () => {
  const service = enabledService();
  const masked = service.redact("chat", { text: "db responded", host: "db" });
  assert.equal(masked.text, `${masked.host} responded`);
  assert.equal(service.redact("chat", "ssh db; adb dbx db.internal"), `ssh ${masked.host}; adb dbx db.internal`);
  assert.equal(service.redact("chat", masked.text), masked.text);
  assert.equal(service.restore("chat", masked.text), "db responded");
});

test("equivalent configuration preserves maps, while any policy change retires active chats", () => {
  const service = enabledService();
  const token = service.redact("chat", "8.8.8.8");
  service.configure({ patterns: [], enabled: true, cidrs: [], redactPrivateIps: false });
  assert.equal(service.hasSession("chat"), true);
  assert.equal(service.redact("chat", token), token);
  service.configure({ enabled: false });
  assert.equal(service.hasSession("chat"), false);
  assert.throws(() => service.checkSession("chat"), NEW_CHAT);
  assert.throws(() => service.redact("chat", "8.8.8.8"), NEW_CHAT);
  assert.throws(() => service.restore("chat", token), NEW_CHAT);
  service.configure({ enabled: true });
  assert.throws(() => service.redact("chat", "8.8.8.8"), NEW_CHAT);
  assert.notEqual(service.redact("new-chat", "8.8.8.8"), token);
  service.configure({ enabled: true, redactPrivateIps: true });
  assert.throws(() => service.checkSession("new-chat"), NEW_CHAT);
});

test("disabled chats are also pinned and cannot silently switch policy midway through history", () => {
  const service = createAiPrivacyService();
  service.checkSession("disabled");
  service.configure({ enabled: true });
  assert.throws(() => service.redact("disabled", "8.8.8.8"), NEW_CHAT);
  assert.match(service.redact("fresh", "8.8.8.8"), TOKEN);
});

test("invalid or explicitly invalidated configuration blocks all paths until valid recovery", () => {
  const service = enabledService();
  const token = service.redact("chat", "8.8.8.8");
  assert.throws(() => service.configure({ enabled: "sensitive-invalid-input" }),
    { message: "Invalid AI privacy configuration" });
  for (const operation of [
    () => service.isEnabled(), () => service.getConfig(), () => service.checkSession("chat"),
    () => service.redact("chat", "8.8.8.8"), () => service.restore("chat", token),
  ]) assert.throws(operation, { message: "Invalid AI privacy configuration" });
  assert.equal(service.hasSession("chat"), false);
  service.configure({ enabled: true });
  assert.throws(() => service.checkSession("chat"), NEW_CHAT);
  assert.match(service.redact("recovered", "8.8.8.8"), TOKEN);
  service.invalidateConfiguration();
  assert.throws(() => service.isEnabled(), /Invalid AI privacy configuration/);
  service.configure({});
  assert.equal(service.isEnabled(), false);
  assert.throws(() => service.redact("recovered", "text"), NEW_CHAT);
});

test("cleanup removes maps, is idempotent and rejects late callbacks even for unseen chats", () => {
  const service = enabledService();
  const token = service.redact("chat", "8.8.8.8");
  service.clearSession("chat");
  service.clearSession("chat");
  assert.equal(service.hasSession("chat"), false);
  assert.throws(() => service.checkSession("chat"), NEW_CHAT);
  assert.throws(() => service.redact("chat", "8.8.8.8"), NEW_CHAT);
  assert.throws(() => service.restore("chat", token), NEW_CHAT);
  service.clearSession("not-started");
  assert.throws(() => service.redact("not-started", "8.8.8.8"), NEW_CHAT);
  assert.match(service.redact("fresh", "8.8.8.8"), TOKEN);
});

test("enabled alias maps are bounded without evicting live maps or retired IDs", () => {
  const service = enabledService({}, { maxSessions: 2 });
  const first = service.redact("one", "8.8.8.8");
  const second = service.redact("two", "1.1.1.1");
  assert.throws(() => service.redact("three", "9.9.9.9"), /session limit reached/);
  assert.equal(service.redact("one", first), first);
  service.clearSession("one");
  assert.throws(() => service.redact("one", "8.8.8.8"), NEW_CHAT);
  service.redact("three", "9.9.9.9");
  service.clearSession("three");
  assert.throws(() => service.redact("three", "9.9.9.9"), NEW_CHAT);
  assert.match(service.redact("four", "9.9.9.9"), TOKEN);
  assert.equal(service.restore("two", second), "1.1.1.1");
  assert.throws(() => service.redact("one", first), NEW_CHAT);
});

test("default-off chats have no enabled-map or cleanup cap and still reject stale callbacks", () => {
  const service = createAiPrivacyService({ maxSessions: 1 });
  const source = { password: "synthetic-ordinary-value" };
  for (let index = 0; index < 4100; index++) {
    const id = `disabled-${index}`;
    assert.equal(service.checkSession(id), false);
    assert.equal(service.redact(id, source), source);
    assert.equal(service.restore(id, source), source);
  }
  for (let index = 0; index < 4100; index++) service.clearSession(`disabled-${index}`);
  assert.equal(service.checkSession("still-disabled"), false);
  assert.equal(service.redact("still-disabled", source), source);
  assert.throws(() => service.redact("disabled-0", source), NEW_CHAT);
  assert.throws(() => service.redact("disabled-4099", source), NEW_CHAT);
  service.configure({ enabled: true });
  assert.throws(() => service.redact("still-disabled", source), NEW_CHAT);
  assert.match(service.redact("new-enabled", "8.8.8.8"), TOKEN);
  assert.throws(() => service.redact("enabled-over-limit", "1.1.1.1"), /session limit reached/);
});

test("turning privacy off restores unlimited new chats without reviving protected maps", () => {
  const service = enabledService({}, { maxSessions: 1 });
  const token = service.redact("protected", "8.8.8.8");
  service.configure({ enabled: false });
  for (let index = 0; index < 70; index++) {
    assert.equal(service.checkSession(`off-${index}`), false);
    assert.equal(service.redact(`off-${index}`, "8.8.8.8"), "8.8.8.8");
  }
  assert.throws(() => service.restore("protected", token), NEW_CHAT);
  assert.throws(() => service.redact("protected", "8.8.8.8"), NEW_CHAT);
  service.configure({ enabled: true });
  assert.throws(() => service.redact("off-69", "8.8.8.8"), NEW_CHAT);
  assert.match(service.redact("fresh-protected", "8.8.8.8"), TOKEN);
});

test("IDs, unsupported values and capacity errors are sanitized without leaking input data", () => {
  const service = enabledService();
  for (const id of [undefined, null, {}, "", " ", "x".repeat(513), "unsafe\0id"]) {
    assert.throws(() => service.redact(id, "sensitive-source"),
      { message: "AI privacy requires a valid chat session" });
  }
  for (const value of [Buffer.from("sensitive-source"), { type: "image", data: "sensitive-source" }, "text\0binary"]) {
    assert.throws(() => service.redact("chat", value),
      { message: "AI privacy could not safely process this value" });
  }
  for (const limits of [{ maxSessions: 0 }, { maxSessions: Number.NaN }, { initialized: "false" }]) {
    assert.throws(() => createAiPrivacyService(limits), /Invalid AI privacy configuration/);
  }
});

test("external execution guards reject policy changes even when settings change back", () => {
  const service = createAiPrivacyService();
  service.configure({ enabled: true });
  const guard = service.createPolicyGuard();
  guard();
  service.configure({ enabled: true });
  guard();
  service.configure({ enabled: false });
  service.configure({ enabled: true });
  assert.throws(guard, /settings changed/);
  const current = service.createPolicyGuard();
  service.invalidateConfiguration();
  assert.throws(current, /Invalid AI privacy/);
});
