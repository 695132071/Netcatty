import test from "node:test";
import assert from "node:assert/strict";

import { UploadController, uploadEntriesDirect } from "../../../lib/uploadService";
import {
  cancelExternalUploadRuntime,
  getExternalUploadController,
  registerExternalUploadController,
  resetExternalUploadRuntimeForTests,
  unregisterExternalUploadController,
} from "./externalUploadRuntime";

test("external upload controls survive their originating panel unmount", async (t) => {
  resetExternalUploadRuntimeForTests();
  t.after(resetExternalUploadRuntimeForTests);

  const cancelled: string[] = [];
  const controller = new UploadController();
  controller.setBridge({
    mkdirSftp: async () => {},
    cancelTransfer: async (transferId) => {
      cancelled.push(transferId);
    },
  });
  controller.addActiveTransfer("child-1");

  registerExternalUploadController("folder-1", controller);
  registerExternalUploadController("child-1", controller);

  // A React panel unmount does not unregister process-level upload controls.
  assert.equal(getExternalUploadController("folder-1"), controller);
  await cancelExternalUploadRuntime("folder-1");
  assert.equal(controller.isCancelled(), true);
  assert.deepEqual(cancelled, ["child-1"]);

  unregisterExternalUploadController(controller);
  assert.equal(getExternalUploadController("folder-1"), undefined);
  assert.equal(getExternalUploadController("child-1"), undefined);
});

for (const selectedFile of ["a.bin", "c.bin"]) {
  test(`cancelling independent ${selectedFile} preserves its active and queued upload siblings`, async (t) => {
    resetExternalUploadRuntimeForTests();
    t.after(resetExternalUploadRuntimeForTests);
    const controller = new UploadController();
    const cancelled: string[] = [];
    const stagedCancelled: string[] = [];
    const ids = new Map<string, string>();
    const pending = new Map<string, (cancelled?: boolean) => void>();
    const started: string[] = [];
    const upload = uploadEntriesDirect(
      ["a.bin", "b.bin", "c.bin"].map((name) => ({
        file: null, relativePath: name, isDirectory: false, localPath: `/local/${name}`, size: 8,
      })),
      {
        targetPath: "/remote", sftpId: "fixture", isLocal: false,
        fileTransferConcurrency: 2, joinPath: (base, name) => `${base}/${name}`,
        callbacks: {
          onTaskCreated: (task) => {
            ids.set(task.fileName, task.id);
            registerExternalUploadController(task.id, controller, "file");
          },
        },
        bridge: {
          mkdirSftp: async () => {},
          cancelStagedUploadFile: async (id) => { stagedCancelled.push(id); },
          cancelTransfer: async (id) => { cancelled.push(id); pending.get(id)?.(true); },
          startStreamTransfer: ({ transferId, sourcePath }) => new Promise((resolve) => {
            started.push(sourcePath);
            pending.set(transferId, (cancelled = false) => resolve({ transferId, cancelled }));
          }),
        },
      },
      controller,
    );
    t.after(async () => {
      await controller.cancel();
      for (const finish of pending.values()) finish(true);
      await upload;
    });
    await new Promise(setImmediate);
    assert.deepEqual(started, ["/local/a.bin", "/local/b.bin"]);
    const selectedId = ids.get(selectedFile)!;
    await cancelExternalUploadRuntime(selectedId);
    assert.deepEqual(cancelled, [selectedId]);
    assert.deepEqual(stagedCancelled, [selectedId]);
    assert.equal(controller.isCancelled(), false);
    await new Promise(setImmediate);
    assert.deepEqual(started, selectedFile === "a.bin"
      ? ["/local/a.bin", "/local/b.bin", "/local/c.bin"]
      : ["/local/a.bin", "/local/b.bin"]);
    for (const [id, finish] of pending) if (id !== selectedId) finish();
    const results = (await upload).sort((a, b) => a.fileName.localeCompare(b.fileName));
    assert.deepEqual(results, ["a.bin", "b.bin", "c.bin"].map((fileName) => (
      fileName === selectedFile
        ? { fileName, success: false, cancelled: true }
        : { fileName, success: true }
    )));
  });
}
