import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  generateTotp,
  parseTotpInput,
  isAutoSubmittableTotpPrompt,
  planTotpSubmission,
  selectTotpFromQrPayloads,
  encodeBase32,
} = require("./totp.shared.cjs") as {
  generateTotp: (input: {
    secret: Buffer;
    algorithm: string;
    digits: number;
    period: number;
    timestamp: number;
  }) => string;
  parseTotpInput: (input: string) => {
    ok: boolean;
    error?: string;
    uri?: string;
    algorithm?: string;
    digits?: number;
    period?: number;
    issuer?: string;
    label?: string;
    secret?: Buffer;
  };
  isAutoSubmittableTotpPrompt: (input: {
    prompts?: Array<{ prompt?: string }>;
    name?: string;
    instructions?: string;
    promptPattern?: string;
  }) => boolean;
  planTotpSubmission: (parsed: { secret: Buffer; algorithm: string; digits: number; period: number }, timestamp: number) => {
    code: string;
    delayMs: number;
  };
  selectTotpFromQrPayloads: (payloads: string[]) => { ok: boolean; error?: string; uri?: string };
  encodeBase32: (buffer: Buffer) => string;
};

const SHA1_SECRET = Buffer.from("12345678901234567890", "ascii");
const SHA256_SECRET = Buffer.from("12345678901234567890123456789012", "ascii");
const SHA512_SECRET = Buffer.from(
  "1234567890123456789012345678901234567890123456789012345678901234",
  "ascii",
);

const RFC_VECTORS: Array<[number, string, string, string]> = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

for (const [time, sha1, sha256, sha512] of RFC_VECTORS) {
  test(`RFC 6238 TOTP at ${time}`, () => {
    const timestamp = time * 1000;
    assert.equal(generateTotp({ secret: SHA1_SECRET, algorithm: "SHA1", digits: 8, period: 30, timestamp }), sha1);
    assert.equal(generateTotp({ secret: SHA256_SECRET, algorithm: "SHA256", digits: 8, period: 30, timestamp }), sha256);
    assert.equal(generateTotp({ secret: SHA512_SECRET, algorithm: "SHA512", digits: 8, period: 30, timestamp }), sha512);
  });
}

test("parseTotpInput keeps algorithm, digits, period, issuer, and label", () => {
  const parsed = parseTotpInput(
    "otpauth://totp/Example:alice%40example.com?secret=gezdgnbvg y3tqojqgezdgnbvgy3tqojq&issuer=Example&algorithm=SHA256&digits=7&period=45",
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.algorithm, "SHA256");
  assert.equal(parsed.digits, 7);
  assert.equal(parsed.period, 45);
  assert.equal(parsed.issuer, "Example");
  assert.equal(parsed.label, "alice@example.com");
  assert.equal(parsed.secret?.equals(SHA1_SECRET), true);
  assert.match(parsed.uri || "", /^otpauth:\/\/totp\//);
  assert.match(parsed.uri || "", /algorithm=SHA256/);
  assert.match(parsed.uri || "", /digits=7/);
  assert.match(parsed.uri || "", /period=45/);
  assert.match(parsed.uri || "", /issuer=Example/);
});

test("parseTotpInput accepts a raw Base32 secret with SHA1/6/30 defaults", () => {
  const parsed = parseTotpInput(`  ${encodeBase32(SHA1_SECRET).toLowerCase()}  `);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.algorithm, "SHA1");
  assert.equal(parsed.digits, 6);
  assert.equal(parsed.period, 30);
  assert.equal(parsed.secret?.equals(SHA1_SECRET), true);
});

test("parseTotpInput accepts SHA-1 spelling and uppercase type", () => {
  const parsed = parseTotpInput(
    `OTPAUTH://TOTP/JumpServer?secret=${encodeBase32(SHA1_SECRET)}&algorithm=SHA-1`,
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.algorithm, "SHA1");
  assert.equal(parsed.issuer, "");
  assert.equal(parsed.label, "JumpServer");
});

test("parseTotpInput splits issuer out of the label when the query omits it", () => {
  const parsed = parseTotpInput(
    `otpauth://totp/JumpServer:root?secret=${encodeBase32(SHA1_SECRET)}`,
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.issuer, "JumpServer");
  assert.equal(parsed.label, "root");
});

test("parseTotpInput rejects HOTP, migration QR codes, and bad parameters", () => {
  assert.equal(parseTotpInput("otpauth://hotp/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=1").error, "hotp");
  assert.equal(parseTotpInput("otpauth-migration://offline?data=abc").error, "migration");
  assert.equal(parseTotpInput("").error, "empty");
  assert.equal(parseTotpInput("otpauth://totp/Example:alice").error, "missing-secret");
  assert.equal(parseTotpInput("otpauth://push/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").error, "unsupported-type");
  assert.equal(parseTotpInput("not a secret").error, "invalid-secret");
  assert.equal(parseTotpInput("AAAA").error, "invalid-secret");
  assert.equal(parseTotpInput(`otpauth://totp/A?secret=${encodeBase32(SHA1_SECRET)}&algorithm=SHA384`).error, "invalid-algorithm");
  assert.equal(parseTotpInput(`otpauth://totp/A?secret=${encodeBase32(SHA1_SECRET)}&digits=5`).error, "invalid-digits");
  assert.equal(parseTotpInput(`otpauth://totp/A?secret=${encodeBase32(SHA1_SECRET)}&digits=9`).error, "invalid-digits");
  assert.equal(parseTotpInput(`otpauth://totp/A?secret=${encodeBase32(SHA1_SECRET)}&period=0`).error, "invalid-period");
  assert.equal(parseTotpInput(`otpauth://totp/A?secret=${encodeBase32(SHA1_SECRET)}&period=301`).error, "invalid-period");
  assert.equal(parseTotpInput("otpauth:").error, "invalid-uri");
});

test("auto-submit waits out the last two seconds of the current window", () => {
  const parsed = parseTotpInput(`otpauth://totp/A?secret=${encodeBase32(SHA1_SECRET)}&digits=8&period=30`);
  assert.equal(parsed.ok, true);
  const soon = planTotpSubmission(parsed as { secret: Buffer; algorithm: string; digits: number; period: number }, 59_000);
  assert.equal(soon.delayMs, 1000);
  assert.equal(soon.code, generateTotp({
    secret: SHA1_SECRET,
    algorithm: "SHA1",
    digits: 8,
    period: 30,
    timestamp: 60_000,
  }));
  const early = planTotpSubmission(parsed as { secret: Buffer; algorithm: string; digits: number; period: number }, 15_000);
  assert.equal(early.delayMs, 0);
});

const prompt = (text: string) => ({ prompts: [{ prompt: text }] });

test("prompt matcher accepts JumpServer and PAM TOTP prompts", () => {
  assert.equal(isAutoSubmittableTotpPrompt({
    ...prompt("[OTP Code]: "),
    instructions: "Please Enter MFA Code.",
  }), true);
  assert.equal(isAutoSubmittableTotpPrompt(prompt("[OTP Code]:")), true);
  assert.equal(isAutoSubmittableTotpPrompt({
    ...prompt("[MFA auth]: "),
    instructions: "Please enter 6 digits.",
  }), true);
  assert.equal(isAutoSubmittableTotpPrompt(prompt("Verification code: ")), true);
  assert.equal(isAutoSubmittableTotpPrompt(prompt("Verification code:")), true);
});

test("prompt matcher rejects SMS, email, option menus, and confirmations", () => {
  assert.equal(isAutoSubmittableTotpPrompt(prompt("[SMS Code]: ")), false);
  assert.equal(isAutoSubmittableTotpPrompt(prompt("[EMAIL Code]: ")), false);
  assert.equal(isAutoSubmittableTotpPrompt(prompt("[OTP_RADIUS Code]: ")), false);
  assert.equal(isAutoSubmittableTotpPrompt({
    prompts: [{ prompt: "\n1. OTP\n2. SMS\nOption> " }],
    instructions: "Please Select MFA Option",
  }), false);
  assert.equal(isAutoSubmittableTotpPrompt(prompt("Do you want to continue [Y/n]? : ")), false);
  assert.equal(isAutoSubmittableTotpPrompt(prompt("Password:")), false);
  assert.equal(isAutoSubmittableTotpPrompt({
    prompts: [{ prompt: "Password:" }, { prompt: "[OTP Code]: " }],
  }), false);
});

test("a host regex can add a prompt without overriding the exclusion list", () => {
  assert.equal(isAutoSubmittableTotpPrompt({
    ...prompt("My OTP: "),
    promptPattern: "^My OTP:\\s*$",
  }), true);
  assert.equal(isAutoSubmittableTotpPrompt({
    ...prompt("[OTP Code]: "),
    promptPattern: "^My OTP:\\s*$",
  }), true);
  assert.equal(isAutoSubmittableTotpPrompt({
    ...prompt("[SMS Code]: "),
    promptPattern: ".*",
  }), false);
  assert.equal(isAutoSubmittableTotpPrompt({
    ...prompt("Option> "),
    promptPattern: ".*",
  }), false);
  assert.equal(isAutoSubmittableTotpPrompt({
    ...prompt("[OTP Code]: "),
    promptPattern: "(",
  }), true);
});

test("custom prompt patterns stay linear and ignore syntax RE2 rejects", () => {
  const started = Date.now();
  assert.equal(isAutoSubmittableTotpPrompt({
    prompts: [{ prompt: `${"a".repeat(32)}!` }],
    promptPattern: "(a+)+$",
  }), false);
  assert.ok(Date.now() - started < 1000);
  assert.equal(isAutoSubmittableTotpPrompt({
    prompts: [{ prompt: "x".repeat(2048) }],
    promptPattern: "x+",
  }), false);
  assert.equal(isAutoSubmittableTotpPrompt({
    ...prompt("My OTP: "),
    promptPattern: "^(a)\\1$",
  }), false);
});

test("QR payload selection keeps the first totp URI and rejects HOTP or migration", () => {
  const totpUri = `otpauth://totp/Example:alice?secret=${encodeBase32(SHA1_SECRET)}`;
  const selected = selectTotpFromQrPayloads([
    "otpauth://hotp/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=1",
    totpUri,
  ]);
  assert.equal(selected.ok, true);
  assert.match(selected.uri || "", /^otpauth:\/\/totp\//);
  assert.equal(selectTotpFromQrPayloads(["otpauth://hotp/A?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=1"]).error, "hotp");
  assert.equal(selectTotpFromQrPayloads(["otpauth-migration://offline?data=abc"]).error, "migration");
  assert.equal(selectTotpFromQrPayloads(["hello"]).error, "not-found");
});
