import type { TransferTask } from "../../../domain/models";

// Failures that only mean "the SSH/SFTP connection went away". The staged
// .part is intact up to the checkpoint, so Retry can continue from it instead
// of restarting at byte 0 (which also strands the old stage on the server,
// because the new attempt stages under a fresh transfer id).
const SESSION_LOSS_ERROR = /SFTP (channel closed|session lost)|ECONNRESET|EPIPE|Not connected|No response from server|Keepalive timeout|connection (lost|closed|reset)/i;

/**
 * True when Retry should resume the same task from its checkpoint.
 * Only local-to-remote uploads (`direction === "upload"`) do this. Downloads
 * and remote copies have no unfingerprinted stage to keep, so they stay on
 * the owner's fresh retry.
 */
export function canRetryFromCheckpoint(task: TransferTask | undefined): boolean {
  if (!task) return false;
  return task.status === "failed"
    && !task.isDirectory
    && !task.parentTaskId
    && task.retryable !== false
    && !task.conflict
    && task.direction === "upload"
    && (task.checkpointBytes ?? 0) > 0
    && SESSION_LOSS_ERROR.test(task.error ?? "");
}
