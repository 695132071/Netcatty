import { terminalHiddenRendererStore } from "./terminalHiddenRendererStore.ts";

/**
 * Walk keep-count victims until one hibernate completes, then retain the
 * leaving tab only if its reserved slot still fits.
 *
 * The reservation is taken before the first await. Clearing a victim marker
 * during wake would otherwise look like spare capacity to a second hidden-tab
 * timer, and both tabs would soft-hide once the same eviction resolved.
 */
export async function retainLeavingTabAfterEviction(input: {
  sessionId: string;
  candidates: readonly string[];
  /** Count captured when this leave started. Used only if resolveKeepCount is absent. */
  keepCount: number;
  /**
   * Live keep-count read after eviction settles. Settings can change while the
   * victim drains or serializes; retaining against the captured count would
   * soft-hide a tab the user no longer wants kept.
   */
  resolveKeepCount?: () => number;
  stillWantsRetention: () => boolean;
  softHide: () => void;
  fullHibernate: () => void;
  evict?: (sessionId: string) => Promise<boolean> | boolean;
}): Promise<void> {
  const token = terminalHiddenRendererStore.reserveLeavingSlot(input.sessionId);
  try {
    const evict = input.evict ?? ((sessionId: string) => (
      terminalHiddenRendererStore.evictSoftHidden(sessionId)
    ));
    let completed = false;
    for (const candidate of input.candidates) {
      if (!candidate || candidate === input.sessionId) continue;
      if (await evict(candidate)) {
        completed = true;
        break;
      }
    }
    if (!input.stillWantsRetention()) return;
    const keepCount = input.resolveKeepCount?.() ?? input.keepCount;
    if (
      completed
      && terminalHiddenRendererStore.leavingSlotStillFits(input.sessionId, keepCount)
    ) {
      input.softHide();
      return;
    }
    input.fullHibernate();
  } finally {
    terminalHiddenRendererStore.releaseLeavingSlot(input.sessionId, token);
  }
}
