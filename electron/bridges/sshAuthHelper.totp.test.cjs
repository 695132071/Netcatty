const test = require("node:test");
const assert = require("node:assert/strict");

const { createKeyboardInteractiveHandler } = require("./sshAuthHelper.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const { encodeBase32, generateTotp } = require("../../domain/totp.shared.cjs");

const SECRET = Buffer.from("12345678901234567890", "ascii");
const TOTP = {
  uri: `otpauth://totp/JumpServer:root?secret=${encodeBase32(SECRET)}&digits=8&period=30`,
  autoSubmit: true,
};

const createSender = () => {
  const sent = [];
  return {
    sent,
    sender: {
      id: 7,
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
};

const drainPendingRequests = (sent, senderId = 7) => {
  for (const event of sent) {
    if (event.channel !== "netcatty:keyboard-interactive") continue;
    const requestId = event.payload?.requestId;
    if (requestId) {
      keyboardInteractiveHandler.handleResponse({ sender: { id: senderId } }, { requestId, cancelled: true });
    }
  }
};

const invoke = (handler, prompt, instructions = "") => {
  let finished = null;
  handler("root", instructions, "", [{ prompt, echo: true }], (responses) => {
    finished = responses;
  });
  return finished;
};

test("TOTP auto-submit runs once per connection attempt, then falls back to the dialog", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "jumpserver.example",
    totp: TOTP,
    now: () => 15_000,
  });
  const expected = generateTotp({
    secret: SECRET,
    algorithm: "SHA1",
    digits: 8,
    period: 30,
    timestamp: 15_000,
  });

  assert.deepEqual(invoke(handler, "[OTP Code]: ", "Please Enter MFA Code."), [expected]);
  assert.equal(sent.length, 0);

  const retry = invoke(handler, "[OTP Code]: ", "Please Enter MFA Code.");
  assert.equal(retry, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "netcatty:keyboard-interactive");
  assert.equal(sent[0].payload.totpUri, TOTP.uri);
  drainPendingRequests(sent);
});

test("keyboard-interactive dialog omits an encrypted TOTP placeholder", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-enc",
    hostname: "jumpserver.example",
    totp: { uri: "enc:v1:placeholder" },
    now: () => 15_000,
  });
  assert.equal(invoke(handler, "[OTP Code]: "), null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.totpUri, undefined);
  drainPendingRequests(sent);
});

test("a non-matching prompt does not consume the one TOTP auto-submit", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-2",
    hostname: "jumpserver.example",
    totp: TOTP,
    now: () => 15_000,
  });

  assert.equal(invoke(handler, "\n1. OTP\n2. SMS\nOption> ", "Please Select MFA Option"), null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.totpUri, TOTP.uri);
  drainPendingRequests(sent);

  const code = invoke(handler, "[OTP Code]: ", "Please Enter MFA Code.");
  assert.equal(code?.[0]?.length, 8);
  assert.equal(sent.length, 1);
});

test("SMS, email, and confirmation prompts are never auto-answered", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-3",
    hostname: "jumpserver.example",
    totp: TOTP,
    now: () => 15_000,
  });
  for (const prompt of ["[SMS Code]: ", "[EMAIL Code]: ", "Do you want to continue [Y/n]? : "]) {
    assert.equal(invoke(handler, prompt), null);
  }
  assert.equal(sent.length, 3);
  drainPendingRequests(sent);
});

test("legacy JumpServer and PAM prompts auto-submit, and a later mismatch opens the dialog", () => {
  const { sender, sent } = createSender();
  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-4",
    hostname: "pam.example",
    totp: TOTP,
    now: () => 15_000,
  });
  assert.equal(invoke(handler, "[MFA auth]: ")?.[0]?.length, 8);
  const fresh = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-5",
    hostname: "pam.example",
    totp: { ...TOTP },
    now: () => 15_000,
  });
  assert.equal(invoke(fresh, "Verification code: ")?.[0]?.length, 8);
  assert.equal(invoke(fresh, "Password:"), null);
  assert.equal(sent.length, 1);
  drainPendingRequests(sent);
});
