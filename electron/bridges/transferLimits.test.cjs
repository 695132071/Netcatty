const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FAST_DOWNLOAD_CHANNELS_PER_SESSION,
  SMALL_DOWNLOAD_SLOT_EXEMPT_BYTES,
  DOWNLOAD_TRANSFER_CONCURRENCY,
  SMALL_UPLOAD_SHARED_MAX_BYTES,
  UPLOAD_TRANSFER_CONCURRENCY,
  TRANSFER_CHUNK_SIZE,
  getSftpTransferConcurrency,
} = require("./transferLimits.cjs");

test("TERM-SSHD SFTP requests use one in-flight range to preserve file contents", () => {
  for (const software of ["TERM-SSHD", "term-sshd", "TERM-SSHD_1.0"]) {
    assert.equal(getSftpTransferConcurrency({ _client: { _remoteVer: software } }, 64), 1);
  }
});

test("the TERM-SSHD request policy does not slow other SSH peers or change chunk sizes", () => {
  for (const software of ["OpenSSH_9.6", "JumpServer", "BHostSSH_7.0", "my-term-sshd-proxy"]) {
    assert.equal(getSftpTransferConcurrency({ _client: { _remoteVer: software } }, 64), 64);
  }
  assert.equal(getSftpTransferConcurrency({}, 8), 8);
  assert.equal(TRANSFER_CHUNK_SIZE, 32 * 1024);
});

test("SFTP transfer limits preserve upload safety and the pre-regression download window", () => {
  assert.equal(UPLOAD_TRANSFER_CONCURRENCY, 64);
  assert.equal(DOWNLOAD_TRANSFER_CONCURRENCY, 64);
  assert.equal(FAST_DOWNLOAD_CHANNELS_PER_SESSION, 1);
  // Keep ssh2's default chunk size — larger packets can corrupt uploads on
  // servers that do not honour non-default WRITE sizes (#2022).
  assert.equal(TRANSFER_CHUNK_SIZE, 32 * 1024);
  // #2449 / Electerm-class: upload window is 2MB (64 × 32KB). Raising only
  // concurrency keeps the safe packet size while matching ssh2/Electerm defaults.
  assert.equal(UPLOAD_TRANSFER_CONCURRENCY * TRANSFER_CHUNK_SIZE, 2 * 1024 * 1024);
  // One fanout window. Files at or under this size upload on the shared browse
  // channel instead of opening a dedicated sftp-server per file.
  assert.equal(SMALL_UPLOAD_SHARED_MAX_BYTES, UPLOAD_TRANSFER_CONCURRENCY * TRANSFER_CHUNK_SIZE);
  // #2030 reduced the shared chunk size from 512KB to 32KB. Downloads need
  // enough parallel reads to preserve the 2MB in-flight window that existed
  // after #1533, otherwise high-latency proxy paths collapse to KB/s speeds.
  assert.equal(DOWNLOAD_TRANSFER_CONCURRENCY * TRANSFER_CHUNK_SIZE, 2 * 1024 * 1024);
});

test("small downloads (one READ window) are exempt from the per-session fast slot", () => {
  // Big files still serialize on FAST_DOWNLOAD_CHANNELS_PER_SESSION (#1507).
  assert.equal(FAST_DOWNLOAD_CHANNELS_PER_SESSION, 1);
  assert.equal(SMALL_DOWNLOAD_SLOT_EXEMPT_BYTES, DOWNLOAD_TRANSFER_CONCURRENCY * TRANSFER_CHUNK_SIZE);
  assert.equal(SMALL_DOWNLOAD_SLOT_EXEMPT_BYTES, 2 * 1024 * 1024);
});
