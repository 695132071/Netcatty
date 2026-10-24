"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  mapWorkerTransferChannelToGlobalEvent,
  fanoutGlobalTransferFromWorkerEvent,
  shouldForwardWorkerRendererEvent,
} = require("./terminalWorkerManager.cjs");

test("mapWorkerTransferChannelToGlobalEvent maps progress for store ingest", () => {
  const event = mapWorkerTransferChannelToGlobalEvent("netcatty:transfer:progress", {
    transferId: "t1",
    transferred: 42,
    totalBytes: 100,
    speed: 7,
    phase: "verifying",
    checkpointBytes: 40,
    parentTaskId: "folder-1",
    directoryEntryIndex: 3,
    directoryEntryIdentity: "entry-hash",
    lifecycleEpoch: 2,
    lifecycleState: "transferring",
  });
  assert.equal(event.type, "progress");
  assert.equal(event.transferId, "t1");
  assert.equal(event.transferred, 42);
  assert.equal(event.totalBytes, 100);
  assert.equal(event.checkpointBytes, 40);
  assert.equal(event.phase, "verifying");
  assert.equal(event.lifecycleEpoch, 2);
  assert.equal(event.lifecycleState, "transferring");
  assert.equal(event.parentTaskId, "folder-1");
  assert.equal(event.directoryEntryIndex, 3);
  assert.equal(event.directoryEntryIdentity, "entry-hash");
  assert.equal(event.resumable, undefined);
});

test("worker progress lifecycleEpoch is lifted into main-process space after soft-resume", () => {
  const transferBridge = require("./transferBridge.cjs");
  transferBridge._setWorkerTransferLifecycleEpochForTests("t-epoch", 5);
  try {
    // Worker still emits pre-resume local epoch 3; main advanced to 5 on resume.
    const event = mapWorkerTransferChannelToGlobalEvent("netcatty:transfer:progress", {
      transferId: "t-epoch",
      transferred: 10,
      totalBytes: 100,
      lifecycleEpoch: 3,
      lifecycleState: "transferring",
    });
    assert.equal(event.lifecycleEpoch, 5, "must not emit below main control epoch");
  } finally {
    transferBridge._clearWorkerTransferLifecycleEpochsForTests();
  }
});

test("worker transfer events are global-only and keep complete task metadata", () => {
  const started = mapWorkerTransferChannelToGlobalEvent("netcatty:transfer:started", {
    type: "started",
    transferId: "download-1",
    direction: "download",
    fileName: "report.bin",
    sourcePath: "/remote/report.bin",
    targetPath: "/tmp/report.bin",
    totalBytes: 100,
    resumable: false,
    pauseUnavailableReason: "SCP cannot pause",
    parentTaskId: "folder-1",
  });
  assert.equal(started.type, "started");
  assert.equal(started.direction, "download");
  assert.equal(started.sourcePath, "/remote/report.bin");
  assert.equal(started.resumable, false);
  assert.equal(started.parentTaskId, "folder-1");
  assert.equal(shouldForwardWorkerRendererEvent("netcatty:transfer:progress"), false);
  assert.equal(shouldForwardWorkerRendererEvent("netcatty:transfer:complete"), false);
  assert.equal(shouldForwardWorkerRendererEvent("netcatty:data"), true);
});

test("mapWorkerTransferChannelToGlobalEvent maps complete/error/cancel", () => {
  assert.equal(
    mapWorkerTransferChannelToGlobalEvent("netcatty:transfer:complete", { transferId: "t1" }).type,
    "completed",
  );
  assert.equal(
    mapWorkerTransferChannelToGlobalEvent("netcatty:transfer:cancelled", { transferId: "t1" }).type,
    "cancelled",
  );
  assert.equal(
    mapWorkerTransferChannelToGlobalEvent("netcatty:transfer:error", {
      transferId: "t1",
      error: "boom",
    }).type,
    "failed",
  );
  assert.equal(
    mapWorkerTransferChannelToGlobalEvent("netcatty:transfer:error", {
      transferId: "t1",
      error: "Transfer cancelled",
    }).type,
    "cancelled",
  );
});

test("worker completion preserves a per-file cleanup warning without changing status", () => {
  const warning = "Upload completed; remove backup /remote/.netcatty-backup-file.bin manually.";
  const event = mapWorkerTransferChannelToGlobalEvent("netcatty:transfer:complete", {
    transferId: "cleanup-warning", warning, totalBytes: 42, transferred: 42,
    parentTaskId: "folder", directoryEntryIndex: 4, directoryEntryIdentity: "entry",
  });
  assert.equal(event.type, "completed");
  assert.equal(event.warning, warning);
  assert.equal(event.error, undefined);
  assert.equal(event.totalBytes, 42);
  assert.equal(event.parentTaskId, "folder");
  assert.equal(event.directoryEntryIndex, 4);
});

test("mapWorkerTransferChannelToGlobalEvent maps compressed parent lifecycle", () => {
  const progress = mapWorkerTransferChannelToGlobalEvent("netcatty:compress:progress", {
    compressionId: "compressed-1",
    phase: "uploading",
    transferredBytes: 600,
    totalBytes: 1000,
    fileName: "photos (compressed)",
    sourcePath: "/local/photos",
    targetPath: "/remote/photos",
    lifecycleEpoch: 4,
    lifecycleState: "paused",
  });
  assert.deepEqual(progress, {
    type: "progress",
    transferId: "compressed-1",
    phase: "uploading",
    transferred: 600,
    totalBytes: 1000,
    fileName: "photos (compressed)",
    sourcePath: "/local/photos",
    targetPath: "/remote/photos",
    direction: "upload",
    isDirectory: true,
    controlKind: "compressed-upload",
    lifecycleEpoch: 4,
    lifecycleState: "paused",
  });
  assert.equal(
    mapWorkerTransferChannelToGlobalEvent("netcatty:compress:complete", { compressionId: "compressed-1" }).type,
    "completed",
  );
  assert.equal(
    mapWorkerTransferChannelToGlobalEvent("netcatty:compress:cancelled", { compressionId: "compressed-1" }).type,
    "cancelled",
  );
  assert.equal(
    mapWorkerTransferChannelToGlobalEvent("netcatty:compress:error", { compressionId: "compressed-1", error: "boom" }).type,
    "failed",
  );
});

test("fanoutGlobalTransferFromWorkerEvent sends global-transfer to all windows", () => {
  const sent = [];
  const electronModule = {
    BrowserWindow: {
      getAllWindows() {
        return [
          {
            isDestroyed: () => false,
            webContents: {
              isDestroyed: () => false,
              send(channel, payload) {
                sent.push({ channel, payload });
              },
            },
          },
        ];
      },
    },
  };

  const n = fanoutGlobalTransferFromWorkerEvent(
    electronModule,
    "netcatty:transfer:progress",
    { transferId: "worker-t", transferred: 9, totalBytes: 10, speed: 1 },
  );
  assert.equal(n, 1);
  assert.equal(sent[0].channel, "netcatty:sftp:global-transfer");
  assert.equal(sent[0].payload.transferId, "worker-t");
  assert.equal(sent[0].payload.type, "progress");
  assert.equal(sent[0].payload.transferred, 9);
});
