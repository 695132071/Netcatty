const test = require("node:test");
const assert = require("node:assert/strict");

const { scanScreensForTotp, previewTotpInput, captureScreenBitmaps } = require("./totpBridge.cjs");
const { encodeBase32 } = require("../../domain/totp.shared.cjs");

const SECRET = Buffer.from("12345678901234567890", "ascii");
const TOTP_URI = `otpauth://totp/Example:alice?secret=${encodeBase32(SECRET)}&algorithm=SHA1&digits=8&period=30`;

test("previewTotpInput returns the current code without echoing a separate secret field", () => {
  const preview = previewTotpInput({ text: TOTP_URI }, 59_000);
  assert.equal(preview.ok, true);
  assert.equal(preview.code, "94287082");
  assert.equal(preview.algorithm, "SHA1");
  assert.equal(preview.digits, 8);
  assert.equal("secret" in preview, false);
  assert.equal(previewTotpInput({ text: "otpauth://hotp/A?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=1" }).error, "hotp");
  assert.equal(previewTotpInput({ text: "otpauth-migration://offline?data=abc" }).error, "migration");
});

test("screen scan returns a permission error when macOS screen recording is denied", async () => {
  const result = await scanScreensForTotp({
    electron: { systemPreferences: { getMediaAccessStatus: () => "denied" } },
    capture: async () => {
      throw new Error("capture should not run");
    },
  });
  assert.deepEqual(result, { ok: false, error: "screen-permission-denied" });
});

test("screen scan takes the first otpauth totp URI and ignores a leading HOTP code", async () => {
  const result = await scanScreensForTotp({
    electron: { systemPreferences: { getMediaAccessStatus: () => "granted" } },
    capture: async () => [{ width: 1, height: 1, bitmap: Buffer.from([0, 0, 0, 255]) }],
    decode: () => ({ data: TOTP_URI }),
    now: () => 59_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "94287082");
  assert.match(result.uri, /^otpauth:\/\/totp\//);
  assert.equal("secret" in result, false);
});

test("an empty macOS capture without screen-recording permission is a clear denial", async () => {
  const result = await scanScreensForTotp({
    platform: "darwin",
    electron: { systemPreferences: { getMediaAccessStatus: () => "not-determined" } },
    capture: async () => [],
  });
  assert.equal(result.error, "screen-permission-denied");
});

function thumbnail(label) {
  return {
    getSize: () => ({ width: 2, height: 2 }),
    toBitmap: () => Buffer.from(label),
  };
}

test("screen capture scans each unmatched source once", async () => {
  let calls = 0;
  const images = await captureScreenBitmaps({
    screen: {
      getAllDisplays: () => [
        { id: 1, size: { width: 800, height: 600 }, scaleFactor: 1 },
        { id: 2, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
      ],
    },
    desktopCapturer: {
      getSources: async (options) => {
        calls += 1;
        assert.deepEqual(options.thumbnailSize, { width: 1920, height: 1080 });
        return [
          { id: "left", display_id: "", thumbnail: thumbnail("left") },
          { id: "right", display_id: "", thumbnail: thumbnail("right") },
        ];
      },
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(images.map((image) => image.bitmap.toString()), ["left", "right"]);
});

test("screen capture uses the largest width and height across orientations", async () => {
  let thumbnailSize;
  await captureScreenBitmaps({
    screen: {
      getAllDisplays: () => [
        { id: 1, size: { width: 3840, height: 2160 }, scaleFactor: 1 },
        { id: 2, size: { width: 2160, height: 3840 }, scaleFactor: 1 },
      ],
    },
    desktopCapturer: {
      getSources: async (options) => {
        thumbnailSize = options.thumbnailSize;
        return [
          { id: "landscape", display_id: "1", thumbnail: thumbnail("landscape") },
          { id: "portrait", display_id: "2", thumbnail: thumbnail("portrait") },
        ];
      },
    },
  });
  assert.deepEqual(thumbnailSize, { width: 3840, height: 3840 });
});

test("screen capture keeps a matched display and still scans an unmatched source", async () => {
  const images = await captureScreenBitmaps({
    screen: {
      getAllDisplays: () => [
        { id: 10, size: { width: 100, height: 100 }, scaleFactor: 2 },
        { id: 20, size: { width: 100, height: 100 }, scaleFactor: 1 },
      ],
    },
    desktopCapturer: {
      getSources: async (options) => {
        assert.deepEqual(options.thumbnailSize, { width: 200, height: 200 });
        return [
          { id: "known", display_id: "10", thumbnail: thumbnail("known") },
          { id: "other", display_id: "", thumbnail: thumbnail("other") },
        ];
      },
    },
  });
  assert.deepEqual(images.map((image) => image.bitmap.toString()), ["known", "other"]);
});

test("screen scan reports HOTP and a friendly miss", async () => {
  const hotp = await scanScreensForTotp({
    electron: { systemPreferences: { getMediaAccessStatus: () => "granted" } },
    capture: async () => [{ width: 1, height: 1, bitmap: Buffer.from([0, 0, 0, 255]) }],
    decode: () => ({ data: "otpauth://hotp/A?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=1" }),
  });
  assert.equal(hotp.error, "hotp");
  const missed = await scanScreensForTotp({
    electron: { systemPreferences: { getMediaAccessStatus: () => "granted" } },
    capture: async () => [{ width: 1, height: 1, bitmap: Buffer.from([0, 0, 0, 255]) }],
    decode: () => null,
  });
  assert.equal(missed.error, "not-found");
});
