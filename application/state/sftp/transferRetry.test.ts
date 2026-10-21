import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientTransferError,
  runWithTransferRetry,
} from "./transferRetry";

test("isTransientTransferError covers session and network blips", () => {
  assert.equal(isTransientTransferError(new Error("SFTP session not found")), true);
  assert.equal(isTransientTransferError(new Error("Connection reset")), true);
  assert.equal(isTransientTransferError(new Error("ECONNRESET")), true);
  assert.equal(isTransientTransferError(new Error("Permission denied")), false);
  assert.equal(isTransientTransferError(new Error("No such file")), false);
});

test("runWithTransferRetry succeeds after a single transient failure", async () => {
  let attempts = 0;
  const result = await runWithTransferRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("SFTP session not found");
    return "ok";
  }, { retries: 1, delayMs: 0 });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("runWithTransferRetry does not retry permanent errors", async () => {
  let attempts = 0;
  await assert.rejects(
    () => runWithTransferRetry(async () => {
      attempts += 1;
      throw new Error("Permission denied");
    }, { retries: 2, delayMs: 0 }),
    /Permission denied/,
  );
  assert.equal(attempts, 1);
});

test("a dead SFTP channel is not retried into another dial (#3310)", async () => {
  assert.equal(isTransientTransferError(new Error("SFTP channel closed")), false);
  assert.equal(isTransientTransferError(new Error("SFTP session not found")), true);
  let attempts = 0;
  await assert.rejects(
    () => runWithTransferRetry(async () => {
      attempts += 1;
      throw new Error("SFTP channel closed");
    }, { retries: 1, delayMs: 0 }),
    /SFTP channel closed/,
  );
  assert.equal(attempts, 1, "channel death must not schedule a reconnect");
});

test("runWithTransferRetry does not retry cancel", async () => {
  let attempts = 0;
  await assert.rejects(
    () => runWithTransferRetry(async () => {
      attempts += 1;
      throw new Error("Transfer cancelled");
    }, { retries: 2, delayMs: 0 }),
    /Transfer cancelled/,
  );
  assert.equal(attempts, 1);
});
