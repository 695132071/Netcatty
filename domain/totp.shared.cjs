"use strict";

/* global Buffer, URL, URLSearchParams */

const crypto = require("node:crypto");
const { NON_TOTP_PROMPT } = require("./totpPrompt.shared.cjs");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALGORITHMS = new Set(["SHA1", "SHA256", "SHA512"]);
const HMAC_NAMES = { SHA1: "sha1", SHA256: "sha256", SHA512: "sha512" };
const BUILTIN_TOTP_PROMPTS = [
  /^\[OTP Code\]:\s*$/,
  /^\[MFA auth\]:\s*$/,
  /^Verification code:\s*$/,
];
// SMS, email, RADIUS, menus, and confirmations must never be auto-answered,
// even when a host regex would otherwise match. The pattern lives in
// totpPrompt.shared.cjs so the auth dialog can use the same list.
const MAX_PROMPT_PATTERN_LENGTH = 200;
const MAX_PROMPT_SUBJECT_LENGTH = 1024;
let compileBoundedPattern = null;

function boundedPatternMatches(pattern, text) {
  if (!compileBoundedPattern) {
    const { RE2JS } = require("re2js");
    compileBoundedPattern = (source) => RE2JS.compile(source);
  }
  return compileBoundedPattern(pattern).matcher(text).find();
}
const MIN_SECRET_BYTES = 10;
const MAX_SECRET_BYTES = 128;

function decodeBase32(input) {
  const cleaned = String(input || "").replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  if (!cleaned || /[^A-Z2-7]/.test(cleaned)) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of cleaned) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function generateTotp({ secret, algorithm = "SHA1", digits = 6, period = 30, timestamp = Date.now() }) {
  const algo = HMAC_NAMES[String(algorithm || "SHA1").toUpperCase()];
  if (!algo) throw new Error("invalid-algorithm");
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new Error("invalid-digits");
  if (!Number.isInteger(period) || period < 1) throw new Error("invalid-period");
  if (!Buffer.isBuffer(secret) || secret.length === 0) throw new Error("invalid-secret");
  const counter = BigInt(Math.floor(Number(timestamp) / 1000 / period));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const hash = crypto.createHmac(algo, secret).update(message).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const binary = ((hash[offset] & 0x7f) << 24)
    | ((hash[offset + 1] & 0xff) << 16)
    | ((hash[offset + 2] & 0xff) << 8)
    | (hash[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

function buildOtpauthUri({ secret, algorithm, digits, period, issuer, label }) {
  const account = label || issuer || "TOTP";
  const pathLabel = issuer && label && !label.startsWith(`${issuer}:`)
    ? `${issuer}:${label}`
    : account;
  const params = new URLSearchParams();
  params.set("secret", encodeBase32(secret));
  params.set("algorithm", algorithm);
  params.set("digits", String(digits));
  params.set("period", String(period));
  if (issuer) params.set("issuer", issuer);
  return `otpauth://totp/${encodeURIComponent(pathLabel)}?${params.toString()}`;
}

function parseRawSecret(text) {
  const secret = decodeBase32(text);
  if (!secret || secret.length < MIN_SECRET_BYTES || secret.length > MAX_SECRET_BYTES) {
    return { ok: false, error: "invalid-secret" };
  }
  return finalizeParsed({
    secret,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    issuer: "",
    label: "",
  });
}

function finalizeParsed(fields) {
  return {
    ok: true,
    ...fields,
    uri: buildOtpauthUri(fields),
  };
}

function parseOtpauthUri(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "invalid-uri" };
  }
  const type = (url.hostname || "").toLowerCase();
  if (!type) return { ok: false, error: "invalid-uri" };
  if (type === "hotp") return { ok: false, error: "hotp" };
  if (type !== "totp") return { ok: false, error: "unsupported-type" };
  const secretParam = url.searchParams.get("secret");
  if (!secretParam || !secretParam.trim()) return { ok: false, error: "missing-secret" };
  const secret = decodeBase32(secretParam);
  if (!secret || secret.length < MIN_SECRET_BYTES || secret.length > MAX_SECRET_BYTES) {
    return { ok: false, error: "invalid-secret" };
  }
  const algorithm = String(url.searchParams.get("algorithm") || "SHA1").replace(/-/g, "").toUpperCase();
  if (!ALGORITHMS.has(algorithm)) return { ok: false, error: "invalid-algorithm" };
  const digitsText = url.searchParams.get("digits");
  const digits = digitsText == null || digitsText.trim() === "" ? 6 : Number(digitsText);
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) return { ok: false, error: "invalid-digits" };
  const periodText = url.searchParams.get("period");
  const period = periodText == null || periodText.trim() === "" ? 30 : Number(periodText);
  if (!Number.isInteger(period) || period < 1 || period > 300) return { ok: false, error: "invalid-period" };

  const rawLabel = decodeURIComponent(url.pathname.replace(/^\//, "")).trim();
  let issuer = (url.searchParams.get("issuer") || "").trim();
  let label = rawLabel;
  if (!issuer && rawLabel.includes(":")) {
    const splitAt = rawLabel.indexOf(":");
    issuer = rawLabel.slice(0, splitAt).trim();
    label = rawLabel.slice(splitAt + 1).trim();
  } else if (issuer && rawLabel.toLowerCase().startsWith(`${issuer.toLowerCase()}:`)) {
    label = rawLabel.slice(issuer.length + 1).trim();
  }
  return finalizeParsed({ secret, algorithm, digits, period, issuer, label });
}

function parseTotpInput(input) {
  const text = String(input ?? "").trim();
  if (!text) return { ok: false, error: "empty" };
  if (/^otpauth-migration:/i.test(text)) return { ok: false, error: "migration" };
  if (/^otpauth:/i.test(text)) return parseOtpauthUri(text);
  return parseRawSecret(text);
}

function currentTotp(parsed, timestamp = Date.now()) {
  const periodMs = parsed.period * 1000;
  const into = Number(timestamp) % periodMs;
  const remainingMs = into === 0 ? periodMs : periodMs - into;
  return {
    code: generateTotp({ ...parsed, timestamp }),
    secondsRemaining: Math.ceil(remainingMs / 1000),
    period: parsed.period,
  };
}

function planTotpSubmission(parsed, timestamp = Date.now()) {
  const periodMs = parsed.period * 1000;
  const into = Number(timestamp) % periodMs;
  const remainingMs = into === 0 ? periodMs : periodMs - into;
  if (remainingMs <= 2000) {
    return {
      code: generateTotp({ ...parsed, timestamp: Number(timestamp) + remainingMs }),
      delayMs: remainingMs,
    };
  }
  return {
    code: generateTotp({ ...parsed, timestamp }),
    delayMs: 0,
  };
}

function previewTotpText(input, timestamp = Date.now()) {
  const parsed = parseTotpInput(input);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const current = currentTotp(parsed, timestamp);
  return {
    ok: true,
    uri: parsed.uri,
    code: current.code,
    secondsRemaining: current.secondsRemaining,
    period: parsed.period,
    algorithm: parsed.algorithm,
    digits: parsed.digits,
    issuer: parsed.issuer,
    label: parsed.label,
  };
}

function isExcludedTotpPrompt(prompts, name, instructions) {
  const promptText = typeof prompts?.[0]?.prompt === "string" ? prompts[0].prompt : "";
  const context = [name, instructions, promptText]
    .filter((part) => typeof part === "string" && part.trim())
    .join("\n");
  return NON_TOTP_PROMPT.test(promptText) || NON_TOTP_PROMPT.test(context);
}

function isAutoSubmittableTotpPrompt({ prompts, name, instructions, promptPattern } = {}) {
  if (!Array.isArray(prompts) || prompts.length !== 1) return false;
  if (isExcludedTotpPrompt(prompts, name, instructions)) return false;
  const promptText = typeof prompts[0]?.prompt === "string" ? prompts[0].prompt : "";
  const pattern = typeof promptPattern === "string" ? promptPattern.trim() : "";
  if (
    pattern
    && pattern.length <= MAX_PROMPT_PATTERN_LENGTH
    && promptText.length <= MAX_PROMPT_SUBJECT_LENGTH
  ) {
    try {
      if (boundedPatternMatches(pattern, promptText)) return true;
    } catch {
      // An invalid or non-RE2 pattern still leaves the built-in prompts available.
    }
  }
  return BUILTIN_TOTP_PROMPTS.some((pattern) => pattern.test(promptText));
}

function planTotpAutoSubmit({ uri, prompts, name, instructions, promptPattern, autoSubmit, timestamp }) {
  if (autoSubmit === false) return { action: "skip" };
  if (typeof uri !== "string" || !uri || uri.startsWith("enc:v1:")) return { action: "skip" };
  if (!isAutoSubmittableTotpPrompt({ prompts, name, instructions, promptPattern })) {
    return { action: "skip" };
  }
  const parsed = parseTotpInput(uri);
  if (!parsed.ok) return { action: "fail" };
  return { action: "submit", ...planTotpSubmission(parsed, timestamp) };
}

function selectTotpFromQrPayloads(payloads) {
  let sawHotp = false;
  let sawMigration = false;
  for (const payload of payloads) {
    const parsed = parseTotpInput(payload);
    if (parsed.ok) return { ok: true, uri: parsed.uri, parsed };
    if (parsed.error === "hotp") sawHotp = true;
    else if (parsed.error === "migration") sawMigration = true;
  }
  if (sawHotp) return { ok: false, error: "hotp" };
  if (sawMigration) return { ok: false, error: "migration" };
  return { ok: false, error: "not-found" };
}

function bgraToRgba(bitmap, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const source = bitmap instanceof Uint8Array ? bitmap : new Uint8Array(bitmap);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    rgba[offset] = source[offset + 2];
    rgba[offset + 1] = source[offset + 1];
    rgba[offset + 2] = source[offset];
    rgba[offset + 3] = source[offset + 3];
  }
  return rgba;
}

module.exports = {
  NON_TOTP_PROMPT,
  decodeBase32,
  encodeBase32,
  generateTotp,
  parseTotpInput,
  currentTotp,
  planTotpSubmission,
  previewTotpText,
  isAutoSubmittableTotpPrompt,
  planTotpAutoSubmit,
  selectTotpFromQrPayloads,
  bgraToRgba,
};
