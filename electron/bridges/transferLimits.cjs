"use strict";

// Keep ssh2's default 32KB request size. Some SFTP servers mishandle larger
// requests and can silently produce truncated/corrupt files (GitHub #2022).
const TRANSFER_CHUNK_SIZE = 32 * 1024;

// Upload fanout: 64 parallel 32KB WRITE requests (~2MB in flight). Matches
// Electerm transfer.js / ssh2-style defaults (concurrency 64, chunk 32KB) for
// high-RTT body feel after #2449. Chunk size stays 32KB for server compatibility
// (#2022 / #2030). Uploads still prefer an isolated SFTP channel / dedicated
// transfer session so interactive terminal traffic is not starved (#1507).
const UPLOAD_TRANSFER_CONCURRENCY = 64;

// Downloads need a larger request window on high-latency proxy paths. 64 is
// ssh2's fastGet default and, with the safe 32KB request size, restores the 2MB
// in-flight window Netcatty used before the shared chunk-size fix in #2030.
const DOWNLOAD_TRANSFER_CONCURRENCY = 64;

// TERM-SSHD gateways can acknowledge concurrent WRITEs with misplaced data
// and return premature EOF for concurrent READs. Keep the normal window for
// other peers; this is a per-file request limit, not a global transfer limit.
function getSftpTransferConcurrency(sftp, requested) {
  const software = sftp?._client?._remoteVer;
  return typeof software === "string"
    && /^(?:SSH-2\.0-)?TERM-SSHD(?:[_-][0-9].*)?$/i.test(software)
    ? 1
    : requested;
}
// Prefix verification must fail closed when a server stops answering, but allow
// slow links to make progress without imposing a whole-transfer deadline.
const SFTP_OPEN_TIMEOUT_MS = 15_000;
const SFTP_REQUEST_TIMEOUT_MS = 30_000;
// Only one file per SFTP session holds the 64-request concurrent READ fanout
// (isolated channel or shared/sudo browse path). Additional downloads wait for
// a free slot rather than degrading to serial createReadStream (#2719 / #2449
// fail-closed). Folder fan-out is capped in the renderer by
// runSftpTransferWorkers (settings transfer concurrency). Multi-select
// top-level downloads enqueue in parallel and share the same host scheduler /
// channel pool caps - they must never fall back to serial body streams.
const FAST_DOWNLOAD_CHANNELS_PER_SESSION = 1;

// A file that fits in one READ fanout window (64 x 32KB) cannot hog the
// session the way a multi-GB download can, so it skips the per-session slot
// above and reads on the shared browse channel. Without this, folder downloads
// of small files ran strictly one file at a time regardless of the transfer
// concurrency setting.
const SMALL_DOWNLOAD_SLOT_EXEMPT_BYTES = DOWNLOAD_TRANSFER_CONCURRENCY * TRANSFER_CHUNK_SIZE;

// A file that fits in one fanout window finishes in a couple of round trips.
// Opening a dedicated sftp-server channel for it (channel open + subsystem +
// SFTP init) costs more than the body itself on WAN links and spawns one
// remote process per file in folder uploads, so small files use the shared
// session's pipelined WRITE path instead.
const SMALL_UPLOAD_SHARED_MAX_BYTES = UPLOAD_TRANSFER_CONCURRENCY * TRANSFER_CHUNK_SIZE;

module.exports = {
  DOWNLOAD_TRANSFER_CONCURRENCY,
  SMALL_DOWNLOAD_SLOT_EXEMPT_BYTES,
  SMALL_UPLOAD_SHARED_MAX_BYTES,
  FAST_DOWNLOAD_CHANNELS_PER_SESSION,
  SFTP_OPEN_TIMEOUT_MS,
  SFTP_REQUEST_TIMEOUT_MS,
  TRANSFER_CHUNK_SIZE,
  UPLOAD_TRANSFER_CONCURRENCY,
  getSftpTransferConcurrency,
};
