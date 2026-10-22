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
 * When another window or a pruned localStorage write reloads connection logs,
 * keep in-memory / side-store terminal replay data instead of wiping it.
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

/**
 * Write the side store; if the write is rejected (localStorage quota), retry
 * without the oldest unsaved replay buffers so the newest sessions are kept.
 * Drops 1, 2, 4, … oldest entries per retry, so attempts stay O(log n).
 * Saved logs and ids not in `logs` are never dropped.
 *
 * `quotaFailedChars` is owned by the caller. It is the summed entry length of
 * the smallest payload that last hit the quota, so the next write can start
 * from the newest set that fits. A successful write of the full map returns
 * null. The helper does not keep that hint itself.
 */
export const writeTerminalDataMapWithQuotaRetry = (
  logs: ConnectionLog[],
  map: ConnectionLogTerminalDataMap,
  write: (next: ConnectionLogTerminalDataMap) => boolean,
  quotaFailedChars: number | null,
): { persisted: boolean; written: ConnectionLogTerminalDataMap; attempts: number; quotaFailedChars: number | null } => {
  const droppable = logs
    .filter((log) => !log.saved && map[log.id] !== undefined)
    .sort((a, b) => a.startTime - b.startTime)
    .map((log) => log.id);
  let chars = 0;
  for (const data of Object.values(map)) chars += data.length;

  let hint = quotaFailedChars;
  let dropCount = 0;
  if (hint !== null) {
    while (dropCount < droppable.length && chars >= hint) {
      chars -= map[droppable[dropCount]].length;
      dropCount += 1;
    }
  }

  let attempts = 0;
  for (;;) {
    let next = map;
    if (dropCount > 0) {
      const dropped = new Set(droppable.slice(0, dropCount));
      next = {};
      for (const [id, data] of Object.entries(map)) {
        if (!dropped.has(id)) next[id] = data;
      }
    }
    attempts += 1;
    if (write(next)) {
      if (dropCount === 0) hint = null;
      return { persisted: true, written: next, attempts, quotaFailedChars: hint };
    }
    hint = hint === null ? chars : Math.min(hint, chars);
    if (dropCount >= droppable.length) {
      return { persisted: false, written: map, attempts, quotaFailedChars: hint };
    }
    const target = Math.min(Math.max(dropCount * 2, 1), droppable.length);
    for (let i = dropCount; i < target; i += 1) chars -= map[droppable[i]].length;
    dropCount = target;
  }
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
