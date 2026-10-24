import type { TransferTask, TransferStatus } from "../../../domain/models";
import type { UploadCallbacks, UploadTaskInfo } from "../../../lib/uploadService";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";
import { joinPath } from "./utils";

type UploadTransferStore = Pick<
  typeof sftpTransferCenterStore,
  "upsertTasks" | "patchTask" | "dismiss"
> & Partial<Pick<typeof sftpTransferCenterStore, "getTask">>;

interface UploadTaskCallbacksParams {
  ownerId: string;
  connectionId: string;
  targetPath: string;
  targetHostId?: string;
  targetHostLabel?: string;
  targetConnectionKey?: string;
  store?: UploadTransferStore;
}

export const createUploadTaskCallbacks = ({
  ownerId,
  connectionId,
  targetPath,
  targetHostId,
  targetHostLabel,
  targetConnectionKey,
  store = sftpTransferCenterStore,
}: UploadTaskCallbacksParams): UploadCallbacks => ({
  onScanningStart: (taskId: string, info?: { label?: string }) => {
    store.upsertTasks([{
      id: taskId,
      ownerId,
      fileName: info?.label?.trim() || "Scanning files...",
      sourcePath: "local",
      targetPath,
      sourceConnectionId: "external",
      targetConnectionId: connectionId,
      targetHostId,
      targetHostLabel,
      sourceHostLabel: "Local",
      targetConnectionKey,
      direction: "upload",
      status: "pending" as TransferStatus,
      // Progressive discovery: totalBytes = found so far, completed stays 0
      // until real transfers start (UI: "0 done · N found").
      totalBytes: 0,
      transferredBytes: 0,
      speed: 0,
      startTime: Date.now(),
      isDirectory: true,
      progressMode: "files",
      origin: "drag-drop",
      background: false,
      resumable: true,
      phase: "scanning",
    }]);
  },
  onScanningProgress: (taskId: string, progress) => {
    store.patchTask(taskId, {
      // Found count is the growing total; nothing is completed during scan.
      totalBytes: Math.max(0, progress.fileCount),
      transferredBytes: 0,
      progressMode: "files",
      phase: "scanning",
      ...(progress.label?.trim() ? { fileName: progress.label.trim() } : null),
    });
  },
  onScanningEnd: (taskId: string) => {
    store.dismiss(taskId);
  },
  onTaskCreated: (task: UploadTaskInfo) => {
    store.upsertTasks([{
      id: task.id,
      ownerId,
      fileName: task.displayName,
      sourcePath: task.sourcePath ?? "local",
      targetPath: joinPath(targetPath, task.fileName),
      sourceConnectionId: "external",
      targetConnectionId: connectionId,
      targetHostId,
      targetHostLabel,
      sourceHostLabel: "Local",
      targetConnectionKey,
      direction: "upload",
      status: "transferring" as TransferStatus,
      totalBytes: task.totalBytes,
      transferredBytes: 0,
      speed: 0,
      startTime: Date.now(),
      isDirectory: task.isDirectory,
      progressMode: task.progressMode ?? "bytes",
      parentTaskId: task.parentTaskId,
      origin: "drag-drop",
      background: false,
      resumable: true,
      phase: "transferring",
      controlKind: task.controlKind,
    }]);
  },
  onTaskProgress: (taskId: string, progress) => {
    const durableCheckpoint = Number.isFinite(Number(progress.checkpointBytes))
      ? Math.max(0, Math.trunc(Number(progress.checkpointBytes)))
      : progress.transferred;
    // Progressive folder walks keep the scanning row as pending until real
    // progress arrives. Promote pending/queued → transferring so the panel
    // leaves "Waiting..." and matches the transfer-center live state.
    const current = "getTask" in store && typeof store.getTask === "function"
      ? store.getTask(taskId)
      : undefined;
    const shouldPromote =
      !!current
      && (current.status === "pending" || current.status === "queued")
      && current.reconnectRequired !== true
      && (
        progress.phase === "scanning"
        || progress.phase === "transferring"
        || progress.transferred > 0
        || progress.total > 0
      );
    // Only patch fingerprint/checkpoint while paused — do not keep animating
    // high-water transferred after the user hit Pause.
    const isPausedLike = current?.status === "paused" || current?.status === "pausing";
    if (isPausedLike) {
      store.patchTask(taskId, {
        checkpointBytes: durableCheckpoint,
        resumable: progress.resumable,
        pauseUnavailableReason: progress.pauseUnavailableReason,
        ...("sourceFingerprint" in progress && progress.sourceFingerprint
          ? { sourceFingerprint: progress.sourceFingerprint as string }
          : null),
      });
      return;
    }
    store.patchTask(taskId, {
      transferredBytes: progress.transferred,
      totalBytes: progress.total,
      // Soft-drain high-water transferred must not become the resume offset.
      checkpointBytes: durableCheckpoint,
      speed: progress.speed,
      phase: progress.phase,
      resumable: progress.resumable,
      pauseUnavailableReason: progress.pauseUnavailableReason,
      ...(shouldPromote ? { status: "transferring" as TransferStatus } : null),
      // Durable pause identity may arrive on a forced progress event while
      // status is already paused — keep it for restart/resume safety.
      ...("sourceFingerprint" in progress && progress.sourceFingerprint
        ? { sourceFingerprint: progress.sourceFingerprint as string }
        : null),
    });
  },
  onTaskNameUpdate: (taskId: string, value: string) => {
    const separator = value.lastIndexOf("|");
    const phase = separator >= 0 ? value.slice(separator + 1) : "transferring";
    store.patchTask(taskId, {
      phase: phase === "compressed" ? "transferring" : phase as TransferTask["phase"],
    });
  },
  onTaskWarning: (taskId: string, warning: string) => {
    // Preserve cleanup details before completion can compact a child row.
    store.patchTask(taskId, { warning });
  },
  onTaskCompleted: (taskId: string, totalBytes: number) => {
    store.patchTask(taskId, {
      status: "completed" as TransferStatus,
      endTime: Date.now(),
      transferredBytes: totalBytes,
      speed: 0,
      phase: undefined,
    });
  },
  onTaskFailed: (taskId: string, error: string) => {
    store.patchTask(taskId, {
      status: "failed" as TransferStatus,
      endTime: Date.now(),
      error,
      speed: 0,
      phase: undefined,
    });
  },
  onTaskCancelled: (taskId: string) => {
    store.patchTask(taskId, {
      status: "cancelled" as TransferStatus,
      endTime: Date.now(),
      speed: 0,
      phase: undefined,
    });
  },
});
