import assert from "node:assert/strict";
import test from "node:test";
import { uploadEntriesDirect } from "./uploadService";
import { uploadLocalFoldersProgressively } from "./progressiveFolderUpload";
import type { UploadCallbacks, UploadTaskInfo } from "./uploadService.types";
import { createSftpTransferCenterStore } from "../application/state/sftpTransferCenterStore";
import { createUploadTaskCallbacks } from "../application/state/sftp/uploadTaskCallbacks";

const warning = "Upload completed; remove backup /remote/.netcatty-backup-file.bin manually.";
const config = {
  targetPath: "/remote", sftpId: "remote", isLocal: false,
  joinPath: (base: string, name: string) => `${base}/${name}`,
  bridge: {
    mkdirSftp: async () => {},
    startStreamTransfer: async ({ transferId }: { transferId: string }) => ({ transferId, warning }),
  },
};

test("external file upload keeps success and the cleanup warning in its direct result", async () => {
  const results = await uploadEntriesDirect([
    { file: null, localPath: "/local/file.bin", relativePath: "file.bin", size: 10, isDirectory: false },
  ], config);
  assert.deepEqual(results, [{ fileName: "file.bin", success: true, warning }]);
});

test("progressive folder upload keeps each successful child's cleanup warning", async () => {
  const results = await uploadLocalFoldersProgressively([{ name: "folder", localPath: "/local/folder" }], {
    ...config,
    listLocalTree: async (_path, options) => {
      options.onEntries?.([
        { localPath: "/local/folder/file.bin", relativePath: "folder/file.bin", type: "file", size: 10, lastModified: 1 },
      ]);
      return [];
    },
  });
  assert.deepEqual(results, [{ fileName: "folder/file.bin", success: true, warning }]);
});

for (const mode of ["progressive", "bundled", "standalone"] as const) {
  for (const managesTransferLifecycle of [false, true]) {
    test(`${mode} result-first warnings survive late completion and history (IPC lifecycle: ${managesTransferLifecycle})`, { timeout: 5000 }, async () => {
      let persisted: string | null = null;
      let onPersist: (() => void) | undefined;
      const store = createSftpTransferCenterStore({
        read: () => persisted,
        write: (value) => { persisted = value; onPersist?.(); },
      });
      const created: UploadTaskInfo[] = [];
      const warningAtCompletion = new Map<string, string | undefined>();
      const taskCallbacks = createUploadTaskCallbacks({
        ownerId: "warning-test", connectionId: "remote", targetPath: "/remote", store,
      });
      const callbacks: UploadCallbacks = {
        ...taskCallbacks,
        onTaskCreated: (task) => { created.push(task); taskCallbacks.onTaskCreated?.(task); },
        onTaskCompleted: (taskId, totalBytes) => {
          warningAtCompletion.set(taskId, store.getTask(taskId)?.warning);
          taskCallbacks.onTaskCompleted?.(taskId, totalBytes);
        },
      };
      const uploadConfig = {
        ...config,
        callbacks,
        fileTransferConcurrency: 1,
        bridge: {
          ...config.bridge,
          managesTransferLifecycle,
          // Deliberately return before delivering any completed IPC.
          startStreamTransfer: async ({ transferId, sourcePath }: { transferId: string; sourcePath: string }) => ({
            transferId, ...(sourcePath.endsWith("warned.bin") ? { warning } : {}),
          }),
        },
      };
      const names = ["warned.bin", "clean.bin"];
      const entries = names.map((name) => ({
        localPath: `/local/folder/${name}`,
        relativePath: mode === "standalone" ? name : `folder/${name}`,
        size: 10,
      }));
      const results = mode === "progressive"
        ? await uploadLocalFoldersProgressively([{ name: "folder", localPath: "/local/folder" }], {
          ...uploadConfig,
          listLocalTree: async (_path, options) => {
            options.onEntries?.(entries.map((entry) => ({ ...entry, type: "file" as const, lastModified: 1 })));
            return [];
          },
        })
        : await uploadEntriesDirect(entries.map((entry) => ({ ...entry, file: null, isDirectory: false })), uploadConfig);
      assert.equal(results.length, 2);
      assert.ok(results.every((result) => result.success));
      const warned = created.find((task) => !task.isDirectory && task.fileName.endsWith("warned.bin"))!;
      const clean = created.find((task) => !task.isDirectory && task.fileName.endsWith("clean.bin"))!;
      assert.ok(warned);
      assert.equal(store.getTask(warned.id)?.warning, warning, "invoke metadata is retained before any late event");
      if (mode === "progressive" || !managesTransferLifecycle) {
        assert.equal(warningAtCompletion.get(warned.id), warning, "warning precedes the compaction-triggering callback");
        assert.equal(store.getTask(warned.id)?.status, "completed");
      } else {
        assert.equal(warningAtCompletion.has(warned.id), false, "IPC-owned files keep their existing lifecycle owner");
        assert.equal(store.getTask(warned.id)?.status, "transferring", "metadata callback does not claim completion");
      }
      for (const task of [warned, clean]) {
        store.ingestBackgroundEvent({
          type: "completed", transferId: task.id, transferred: 10,
          ...(task.id === warned.id ? { warning } : {}),
        });
      }
      assert.equal(store.getTask(warned.id)?.status, "completed");
      assert.equal(store.getTask(warned.id)?.warning, warning);
      if (mode !== "standalone") {
        assert.equal(store.getTask(clean.id)?.warning, undefined, "warnings stay on the affected file, not siblings");
        assert.equal(store.getTask(warned.parentTaskId!)?.status, "completed");
      }
      // Child lifecycle persistence is intentionally coalesced. Await its write,
      // not an arbitrary delay, before simulating a process restart.
      await new Promise<void>((resolve) => {
        onPersist = () => {
          const saved = JSON.parse(persisted || '{"tasks":[]}').tasks as Array<{ id: string; status: string; warning?: string }>;
          if (saved.some((task) => task.id === warned.id && task.status === "completed" && task.warning === warning)) resolve();
        };
        onPersist();
      });
      const restored = createSftpTransferCenterStore({ read: () => persisted, write: () => {} });
      assert.equal(restored.getTask(warned.id)?.status, "completed");
      assert.equal(restored.getTask(warned.id)?.warning, warning, "the actionable backup path survives restart");
    });
  }
}

for (const mode of ["progressive", "bundled"] as const) {
  for (const outcome of [{ error: "write failed" }, { cancelled: true }]) {
    test(`${mode} unsuccessful results do not publish cleanup metadata (${"error" in outcome ? "failed" : "cancelled"})`, async () => {
      const store = createSftpTransferCenterStore();
      const created: UploadTaskInfo[] = [];
      const warnings: string[] = [];
      const taskCallbacks = createUploadTaskCallbacks({
        ownerId: "warning-test", connectionId: "remote", targetPath: "/remote", store,
      });
      const uploadConfig = {
        ...config,
        callbacks: {
          ...taskCallbacks,
          onTaskCreated: (task: UploadTaskInfo) => { created.push(task); taskCallbacks.onTaskCreated?.(task); },
          onTaskWarning: (taskId: string, value: string) => { warnings.push(value); taskCallbacks.onTaskWarning?.(taskId, value); },
        },
        bridge: {
          ...config.bridge,
          startStreamTransfer: async ({ transferId }: { transferId: string }) => ({ transferId, ...outcome, warning }),
        },
      };
      const entry = { localPath: "/local/folder/file.bin", relativePath: "folder/file.bin", size: 10 };
      if (mode === "progressive") {
        await uploadLocalFoldersProgressively([{ name: "folder", localPath: "/local/folder" }], {
          ...uploadConfig,
          listLocalTree: async (_path, options) => {
            options.onEntries?.([{ ...entry, type: "file", lastModified: 1 }]);
            return [];
          },
        });
      } else {
        await uploadEntriesDirect([{ ...entry, file: null, isDirectory: false }], uploadConfig);
      }
      assert.deepEqual(warnings, []);
      const file = created.find((task) => !task.isDirectory)!;
      assert.equal(store.getTask(file.id)?.status, "error" in outcome ? "failed" : "cancelled");
      assert.equal(store.getTask(file.id)?.warning, undefined);
    });
  }
}
