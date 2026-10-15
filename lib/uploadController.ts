import type { UploadBridge } from "./uploadService.types";

export class UploadController {
  private cancelled = false;
  private cancelledFileIds = new Set<string>();
  private activeFileTransferIds = new Set<string>();
  private activeCompressionIds = new Set<string>();
  private currentTransferId = "";
  private bridge: UploadBridge | null = null;
  private cancelListeners = new Set<() => void>();

  /**
   * Register a listener fired as soon as cancel() is requested (before async
   * cleanup). Used to abort in-flight local tree scans.
   */
  addCancelListener(listener: () => void): () => void {
    this.cancelListeners.add(listener);
    return () => {
      this.cancelListeners.delete(listener);
    };
  }

  /**
   * Cancel all active uploads
   */
  async cancel(): Promise<void> {
    this.cancelled = true;
    for (const listener of Array.from(this.cancelListeners)) {
      try {
        listener();
      } catch {
        // Ignore listener errors so cancel still drains transfers.
      }
    }

    // Cancel all active compressed uploads
    const activeCompressionIds = Array.from(this.activeCompressionIds);
    for (const compressionId of activeCompressionIds) {
      try {
        // Import and call cancelCompressedUpload
        const { cancelCompressedUpload } = await import('../infrastructure/services/compressUploadService');
        await cancelCompressedUpload(compressionId);
      } catch {
        // Ignore cancel errors
      }
    }

    // Cancel all active file uploads
    const activeIds = Array.from(this.activeFileTransferIds);
    for (const transferId of activeIds) {
      await this.cancelFile(transferId);
    }

    // Also cancel current one if not in the set
    if (this.currentTransferId && !activeIds.includes(this.currentTransferId)) {
      try {
        if (this.bridge?.cancelTransfer) {
          await this.bridge.cancelTransfer(this.currentTransferId);
        }
      } catch {
        // Ignore cancel errors
      }
    }
  }

  /** Cancel one standalone file without stopping the shared upload queue. */
  async cancelFile(transferId: string): Promise<void> {
    this.cancelledFileIds.add(transferId);
    try {
      await this.bridge?.cancelStagedUploadFile?.(transferId);
      await this.bridge?.cancelTransfer?.(transferId);
    } catch {
      // The transfer runtime reconciles backend cancellation failures.
    }
  }

  /**
   * Check if upload was cancelled
   */
  isCancelled(fileId?: string): boolean {
    return this.cancelled || (!!fileId && this.cancelledFileIds.has(fileId));
  }

  /**
   * Get all active transfer IDs
   */
  getActiveTransferIds(): string[] {
    const ids = Array.from(this.activeFileTransferIds);
    if (this.currentTransferId && !ids.includes(this.currentTransferId)) {
      ids.push(this.currentTransferId);
    }
    // Also include compression IDs
    const compressionIds = Array.from(this.activeCompressionIds);
    return [...ids, ...compressionIds];
  }

  /**
   * Reset controller state for a brand-new upload session.
   * Prefer prepareForEntries when the controller already owns an external drop
   * (scan cancel listeners must stay attached until the drop settles).
   */
  reset(): void {
    this.cancelled = false;
    this.cancelledFileIds.clear();
    this.cancelListeners.clear();
    this.activeFileTransferIds.clear();
    this.activeCompressionIds.clear();
    this.currentTransferId = "";
  }

  /**
   * Soft prepare for entry upload without clearing cancel latches/listeners.
   * External drop flows attach scan/conflict cancel listeners before entries
   * are ready; a full reset would leave the scanning row uncancelable.
   */
  prepareForEntries(): void {
    this.activeFileTransferIds.clear();
    this.activeCompressionIds.clear();
    this.currentTransferId = "";
  }

  /**
   * Set the bridge for cancellation
   */
  setBridge(bridge: UploadBridge): void {
    this.bridge = bridge;
  }

  /**
   * Track a file transfer ID
   */
  addActiveTransfer(id: string): void {
    this.activeFileTransferIds.add(id);
    this.currentTransferId = id;
  }

  /**
   * Remove a tracked file transfer ID
   */
  removeActiveTransfer(id: string): void {
    this.activeFileTransferIds.delete(id);
    if (this.currentTransferId === id) {
      this.currentTransferId = "";
    }
  }

  /**
   * Clear current transfer ID
   */
  clearCurrentTransfer(): void {
    this.currentTransferId = "";
  }

  /**
   * Track a compression ID
   */
  addActiveCompression(id: string): void {
    this.activeCompressionIds.add(id);
  }

  /**
   * Remove a tracked compression ID
   */
  removeActiveCompression(id: string): void {
    this.activeCompressionIds.delete(id);
  }
}
