import type { ConnectionLog } from "./models.ts";

/** Max unsaved connection logs whose terminal replay data we persist separately. */
export const MAX_PERSISTED_UNSAVED_TERMINAL_DATA_ENTRIES = 50;

export type ConnectionLogTerminalDataMap = Record<string, string>;

export const readTerminalDataFromLog = (log: ConnectionLog): string | undefined =>
  log.terminalData;

export const mergeTerminalDataIntoLogs = (
  logs: ConnectionLog[],
  terminalDataMap: ConnectionLogTerminalDataMap,
): ConnectionLog[] => {
  if (logs.length === 0) return logs;

  let changed = false;
  const next = logs.map((log) => {
    if (log.terminalData) return log;
    const sideData = terminalDataMap[log.id];
    if (!sideData) return log;
    changed = true;
    return { ...log, terminalData: sideData };
  });
  return changed ? next : logs;
};

/**
 * When another window reloads connection logs, keep in-memory / side-store
 * terminal replay data instead of wiping it.
 */
export const mergeConnectionLogsFromStorage = (
  prev: ConnectionLog[],
  next: ConnectionLog[],
  terminalDataMap: ConnectionLogTerminalDataMap,
): ConnectionLog[] => {
  if (next.length === 0) return next;

  const prevById = new Map(prev.map((log) => [log.id, log]));
  let changed = false;
  const merged = next.map((log) => {
    const memoryData = readTerminalDataFromLog(prevById.get(log.id) ?? log);
    const sideData = terminalDataMap[log.id];
    const terminalData = memoryData ?? readTerminalDataFromLog(log) ?? sideData;
    if (!terminalData || log.terminalData === terminalData) return log;
    changed = true;
    return { ...log, terminalData };
  });
  return changed ? merged : next;
};

/**
 * A peer snapshot must not discard a local mutation that has not committed.
 * Overlay only owned ids, including explicit deletion tombstones. Unowned
 * memory rows stay absent when another window deletes them.
 */
export type PendingConnectionLogMutation = {
  log: ConnectionLog | null;
  /** Only a new local row may be inserted when disk no longer contains it. */
  added?: boolean;
  /** Fields actually changed here; a capture must not undo a peer bookmark. */
  changes?: Partial<ConnectionLog>;
};

export type PendingConnectionLogWrite = PendingConnectionLogMutation & {
  generation: number;
  fieldGenerations?: Partial<Record<keyof ConnectionLog, number>>;
};

/** Retire only row/field generations whose storage write actually committed. */
export const acknowledgePendingConnectionLogWrites = (
  pending: ReadonlyMap<string, PendingConnectionLogWrite>,
  committed: ReadonlyMap<string, PendingConnectionLogWrite>,
  durability: {
    metadataPersisted: boolean;
    replayPersisted: boolean;
    mainReplay?: ConnectionLogTerminalDataMap;
  } = { metadataPersisted: true, replayPersisted: true },
): Map<string, PendingConnectionLogWrite> => {
  const remaining = new Map(pending);
  for (const [id, written] of committed) {
    const current = remaining.get(id);
    if (!current) continue;
    if (current.generation === written.generation && durability.metadataPersisted
      && (durability.replayPersisted || written.log === null)) {
      remaining.delete(id);
    } else if (current.log !== null && written.log !== null) {
      const changes = { ...current.changes };
      const fieldGenerations = { ...current.fieldGenerations };
      for (const field of Object.keys(written.fieldGenerations ?? {}) as Array<keyof ConnectionLog>) {
        // Use the bytes actually written, not this pending log's saved flag:
        // a peer may have unbookmarked it before the snapshot was rebased.
        const durable = field === "terminalData"
          ? durability.replayPersisted || (Object.hasOwn(durability.mainReplay ?? {}, id)
            && durability.mainReplay?.[id] === written.changes?.terminalData)
          : durability.metadataPersisted;
        if (durable && fieldGenerations[field] === written.fieldGenerations?.[field]) {
          delete changes[field];
          delete fieldGenerations[field];
        }
      }
      const added = durability.metadataPersisted && written.added ? false : current.added;
      if (Object.keys(changes).length === 0 && !added) remaining.delete(id);
      else remaining.set(id, {
        ...current, changes, fieldGenerations, added,
      });
    }
  }
  return remaining;
};

export const mergeConnectionLogsWithPendingMutations = (
  prev: ConnectionLog[],
  next: ConnectionLog[],
  terminalDataMap: ConnectionLogTerminalDataMap,
  pending: ReadonlyMap<string, PendingConnectionLogMutation>,
): ConnectionLog[] => {
  // Incoming disk/side-store bytes are authoritative unless this window owns
  // a newer capture. In particular, bookmarking must not replay stale bytes
  // over a final capture that a peer just committed.
  const prevById = new Map(prev.map((log) => [log.id, log]));
  const hydrated = next.map((log) => {
    const terminalData = log.terminalData ?? terminalDataMap[log.id] ?? prevById.get(log.id)?.terminalData;
    return terminalData === undefined || terminalData === log.terminalData
      ? log
      : { ...log, terminalData };
  });
  if (pending.size === 0) return pruneInMemoryUnsavedTerminalData(hydrated);
  const byId = new Map(hydrated.map((log) => [log.id, log]));
  for (const [id, mutation] of pending) {
    if (mutation.log === null) byId.delete(id);
    else {
      const stored = byId.get(id);
      if (!stored && !mutation.added) continue;
      byId.set(id, stored && mutation.changes
        ? { ...stored, ...mutation.changes }
        : mutation.log);
    }
  }
  return pruneInMemoryUnsavedTerminalData(
    [...byId.values()].sort((a, b) => b.startTime - a.startTime),
  );
};

/**
 * Apply a queued connection-log snapshot when it runs, not when it was captured.
 * Disk may have gained another window's logs during the wait. Keep those logs.
 * Metadata from this snapshot replaces a disk row only for ids the recipe added
 * or updated (`changedIds`) that are still in memory. An id deleted locally
 * after this snapshot was queued is not written back. Deletes from this
 * snapshot apply only while memory still agrees.
 */
export const rebaseQueuedConnectionLogs = (
  queued: readonly ConnectionLog[],
  removedIds: ReadonlySet<string>,
  changedIds: ReadonlySet<string>,
  memory: readonly ConnectionLog[],
  disk: readonly ConnectionLog[] | null,
): ConnectionLog[] => {
  const memoryById = new Map(memory.map((log) => [log.id, log]));
  const queuedById = new Map(queued.map((log) => [log.id, log]));
  const diskKept = (disk ?? []).filter(
    (log) => !(removedIds.has(log.id) && !memoryById.has(log.id)),
  );
  const present = new Set<string>();
  const withLocalEdits: ConnectionLog[] = [];
  for (const log of diskKept) {
    const queuedLog = queuedById.get(log.id);
    const memoryLog = memoryById.get(log.id);
    if (changedIds.has(log.id)) {
      if (!memoryLog) continue;
      present.add(log.id);
      withLocalEdits.push(memoryLog);
      continue;
    }
    present.add(log.id);
    const replay = queuedLog?.terminalData ?? memoryLog?.terminalData ?? log.terminalData;
    if (!replay || log.terminalData === replay) {
      withLocalEdits.push(log);
      continue;
    }
    withLocalEdits.push({ ...log, terminalData: replay });
  }
  const extras: ConnectionLog[] = [];
  for (const log of queued) {
    if (present.has(log.id) || !changedIds.has(log.id)) continue;
    const memoryLog = memoryById.get(log.id);
    if (!memoryLog) continue;
    extras.push(memoryLog);
  }
  if (extras.length === 0) return withLocalEdits;
  return pruneInMemoryUnsavedTerminalData(
    [...extras, ...withLocalEdits].sort((a, b) => b.startTime - a.startTime),
  );
};

/**
 * Drop `terminalData` from unsaved logs outside the newest `keep` entries.
 * Saved logs and the newest unsaved replays stay intact.
 */
export const retainNewestUnsavedReplays = (
  logs: readonly ConnectionLog[],
  keep: number,
): ConnectionLog[] => {
  const ranked = logs
    .filter((log) => !log.saved && log.terminalData)
    .sort((a, b) => b.startTime - a.startTime);
  if (ranked.length <= keep) return [...logs];
  const keepIds = new Set(ranked.slice(0, Math.max(0, keep)).map((log) => log.id));
  let changed = false;
  const next = logs.map((log) => {
    if (log.saved || log.terminalData === undefined || keepIds.has(log.id)) return log;
    changed = true;
    const { terminalData: _omitted, ...rest } = log;
    return rest;
  });
  return changed ? next : [...logs];
};

export const buildTerminalDataMapFromLogs = (
  logs: ConnectionLog[],
): ConnectionLogTerminalDataMap => {
  const map: ConnectionLogTerminalDataMap = {};
  for (const log of logs) {
    const data = readTerminalDataFromLog(log);
    if (data) map[log.id] = data;
  }
  return map;
};

/**
 * Keep only unsaved logs' terminal data, capped to the most recent entries.
 * Saved logs keep terminalData in the main connection log blob when bookmarked.
 */
export const pruneTerminalDataMapForStorage = (
  logs: ConnectionLog[],
  map: ConnectionLogTerminalDataMap,
): ConnectionLogTerminalDataMap => {
  const unsavedIds = logs
    .filter((log) => !log.saved)
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, MAX_PERSISTED_UNSAVED_TERMINAL_DATA_ENTRIES)
    .map((log) => log.id);

  const allowed = new Set(unsavedIds);
  for (const log of logs) {
    if (log.saved && map[log.id]) {
      allowed.add(log.id);
    }
  }

  const next: ConnectionLogTerminalDataMap = {};
  for (const id of allowed) {
    if (map[id]) next[id] = map[id];
  }
  return next;
};


/**
 * Drop in-memory `terminalData` from the oldest unsaved logs beyond the
 * persisted-entry cap. List metadata stays; only replay buffers are removed.
 * Matches what survives a restart (`pruneTerminalDataMapForStorage`).
 */
export const pruneInMemoryUnsavedTerminalData = (
  logs: ConnectionLog[],
  maxEntries: number = MAX_PERSISTED_UNSAVED_TERMINAL_DATA_ENTRIES,
): ConnectionLog[] => {
  const unsavedWithData = logs
    .filter((log) => !log.saved && log.terminalData !== undefined)
    .sort((a, b) => b.startTime - a.startTime);
  if (unsavedWithData.length <= maxEntries) return logs;

  const keep = new Set(unsavedWithData.slice(0, maxEntries).map((log) => log.id));
  let changed = false;
  const next = logs.map((log) => {
    if (log.saved || log.terminalData === undefined || keep.has(log.id)) return log;
    changed = true;
    const { terminalData: _omitted, ...rest } = log;
    return rest;
  });
  return changed ? next : logs;
};

export type ConnectionLogTerminalDataDiff = {
  puts: ConnectionLogTerminalDataMap;
  deleteIds: string[];
};

/** Changed replay blobs to write, and ids no longer in the persisted map. */
export const diffTerminalDataMaps = (
  previous: ConnectionLogTerminalDataMap,
  next: ConnectionLogTerminalDataMap,
): ConnectionLogTerminalDataDiff => {
  const puts: ConnectionLogTerminalDataMap = {};
  const deleteIds: string[] = [];
  for (const id of Object.keys(next)) {
    if (previous[id] !== next[id]) puts[id] = next[id];
  }
  for (const id of Object.keys(previous)) {
    if (!Object.prototype.hasOwnProperty.call(next, id)) deleteIds.push(id);
  }
  return { puts, deleteIds };
};

/** Fold side-store maps together, then cap to the allowed unsaved/saved set. */
export const mergeTerminalDataMapsForStorage = (
  logs: ConnectionLog[],
  persistedSnapshot: ConnectionLogTerminalDataMap,
  localMaps: ConnectionLogTerminalDataMap[],
  persistedLogIds: ReadonlySet<string>,
): ConnectionLogTerminalDataMap => {
  const combined: ConnectionLogTerminalDataMap = { ...persistedSnapshot };
  for (const map of localMaps) {
    for (const [id, data] of Object.entries(map)) {
      if (data) combined[id] = data;
    }
  }
  const pruned = pruneTerminalDataMapForStorage(logs, combined);

  // Retain replay buffers only for log ids still present in the persisted
  // connection-log blob but not yet loaded into this window's React state.
  for (const id of persistedLogIds) {
    if (!logs.some((log) => log.id === id) && combined[id]) {
      pruned[id] = combined[id];
    }
  }

  return pruned;
};
