import assert from "node:assert/strict";
import test from "node:test";
import type { TransferTask } from "../../../domain/models";
import { canRetryFromCheckpoint } from "./retryFromCheckpoint";

const failed = (over: Partial<TransferTask> = {}): TransferTask => ({
  id: "t", fileName: "big.bin", sourcePath: "/l/big.bin", targetPath: "/r/big.bin",
  sourceConnectionId: "local", targetConnectionId: "remote", direction: "upload",
  status: "failed", totalBytes: 100, transferredBytes: 40, checkpointBytes: 40,
  speed: 0, startTime: 1, isDirectory: false, error: "SFTP channel closed", ...over,
});

test("canRetryFromCheckpoint resumes the channel-loss forms the bridge already classifies", () => {
  for (const error of [
    "read ECONNABORTED",
    "socket hang up",
    "ERR_SFTP_CHANNEL_CLOSED",
    "SFTP pipelined upload failed: socket hang up",
    "client-socket",
  ]) {
    assert.equal(canRetryFromCheckpoint(failed({ error })), true, error);
  }
});

test("canRetryFromCheckpoint only for a top-level file that lost its connection with progress", () => {
  assert.equal(canRetryFromCheckpoint(failed()), true);
  assert.equal(canRetryFromCheckpoint(failed({ error: "read ECONNRESET" })), true);
  assert.equal(canRetryFromCheckpoint(failed({ checkpointBytes: 0 })), false, "nothing to resume");
  assert.equal(canRetryFromCheckpoint(failed({ error: "Permission denied" })), false, "content errors restart");
  assert.equal(canRetryFromCheckpoint(failed({ isDirectory: true })), false);
  assert.equal(canRetryFromCheckpoint(failed({ parentTaskId: "dir" })), false);
  assert.equal(canRetryFromCheckpoint(failed({ status: "cancelled" })), false);
  assert.equal(canRetryFromCheckpoint(failed({ retryable: false })), false);
  assert.equal(canRetryFromCheckpoint(failed({ direction: "download" })), false, "downloads keep the owner retry");
  assert.equal(canRetryFromCheckpoint(failed({ direction: "remote-to-remote" })), false, "remote copies keep the owner retry");
  assert.equal(canRetryFromCheckpoint(failed({ direction: "local-copy" })), false);
  assert.equal(canRetryFromCheckpoint(undefined), false);
});
