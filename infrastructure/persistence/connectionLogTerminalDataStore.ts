import {
  diffTerminalDataMaps,
  type ConnectionLogTerminalDataMap,
} from "../../domain/connectionLogTerminalData.ts";

export const CONNECTION_LOG_TERMINAL_DATA_DB_NAME = "netcatty_connection_log_terminal_data";
export const CONNECTION_LOG_TERMINAL_DATA_STORE_NAME = "entries";

const DB_VERSION = 1;

export type ConnectionLogTerminalDataRev = {
  rev: number;
  /** Log ids currently in the side store. */
  ids?: string[];
  /**
   * Distinguishes two writes that would otherwise share `rev` and `ids`
   * in the same millisecond, so the other window still observes a change.
   */
  nonce?: string;
};

export type LegacyConnectionLogTerminalDataMigration = {
  read: () => ConnectionLogTerminalDataMap | null;
  remove: () => void;
};

export type MigratedConnectionLogTerminalData = {
  map: ConnectionLogTerminalDataMap;
  migrated: boolean;
  /**
   * False when `map` contains replay rows that are not committed in IndexedDB.
   * Callers must not use that map as a diff baseline until a later write commits.
   */
  durable: boolean;
};

type TerminalDataRow = {
  id: string;
  data: string;
};

let cachedDatabase: IDBDatabase | null = null;
let openingDatabase: Promise<IDBDatabase | null> | null = null;

const warnStoreFailure = (message: string, error: unknown): void => {
  console.warn(`[connectionLogTerminalDataStore] ${message}`, error);
};

const forgetDatabase = (): void => {
  const db = cachedDatabase;
  cachedDatabase = null;
  openingDatabase = null;
  try {
    db?.close();
  } catch {
    // The connection is already closing.
  }
};

const transactionComplete = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };
  tx.oncomplete = () => finish(() => resolve());
  tx.onabort = () => finish(() => reject(tx.error ?? new Error("IndexedDB transaction aborted")));
  tx.onerror = () => finish(() => reject(tx.error ?? new Error("IndexedDB transaction failed")));
});

const openDatabase = (): Promise<IDBDatabase | null> => new Promise((resolve) => {
  try {
    if (typeof indexedDB === "undefined" || indexedDB === null) {
      resolve(null);
      return;
    }
    const request = indexedDB.open(CONNECTION_LOG_TERMINAL_DATA_DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME)) {
        db.createObjectStore(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      warnStoreFailure("IndexedDB open failed", request.error);
      resolve(null);
    };
  } catch (error) {
    warnStoreFailure("IndexedDB open failed", error);
    resolve(null);
  }
});

const getDatabase = async (): Promise<IDBDatabase | null> => {
  if (cachedDatabase) return cachedDatabase;
  if (!openingDatabase) {
    openingDatabase = openDatabase().then((db) => {
      openingDatabase = null;
      if (!db) return null;
      cachedDatabase = db;
      db.onversionchange = () => {
        if (cachedDatabase === db) cachedDatabase = null;
        try {
          db.close();
        } catch {
          // Already closed by the deleting context.
        }
      };
      db.onclose = () => {
        if (cachedDatabase === db) cachedDatabase = null;
      };
      return db;
    }).catch((error: unknown) => {
      openingDatabase = null;
      warnStoreFailure("IndexedDB open failed", error);
      return null;
    });
  }
  return openingDatabase;
};

const rowsToMap = (rows: TerminalDataRow[]): ConnectionLogTerminalDataMap => {
  const map: ConnectionLogTerminalDataMap = {};
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || typeof row.data !== "string") continue;
    map[row.id] = row.data;
  }
  return map;
};

const sanitizeMap = (map: ConnectionLogTerminalDataMap | null): ConnectionLogTerminalDataMap => {
  if (!map || typeof map !== "object" || Array.isArray(map)) return {};
  const next: ConnectionLogTerminalDataMap = {};
  for (const [id, data] of Object.entries(map)) {
    if (typeof data === "string" && data.length > 0) next[id] = data;
  }
  return next;
};

const readAll = async (): Promise<ConnectionLogTerminalDataMap | null> => {
  try {
    const db = await getDatabase();
    if (!db) return null;
    const tx = db.transaction(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME, "readonly");
    const store = tx.objectStore(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME);
    const request = store.getAll() as IDBRequest<TerminalDataRow[]>;
    let rows: TerminalDataRow[] = [];
    request.onsuccess = () => {
      rows = request.result ?? [];
    };
    await transactionComplete(tx);
    return rowsToMap(rows);
  } catch (error) {
    forgetDatabase();
    warnStoreFailure("IndexedDB read failed", error);
    return null;
  }
};

export const loadAll = async (): Promise<ConnectionLogTerminalDataMap> => (await readAll()) ?? {};

/** `null` when IndexedDB could not be read. `{}` is a successful empty store. */
export const tryLoadAll = async (): Promise<ConnectionLogTerminalDataMap | null> => readAll();

export const replaceAll = async (map: ConnectionLogTerminalDataMap): Promise<boolean> => {
  try {
    const db = await getDatabase();
    if (!db) return false;
    const entries = sanitizeMap(map);
    const tx = db.transaction(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME, "readwrite");
    const store = tx.objectStore(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME);
    const done = transactionComplete(tx);
    store.clear();
    for (const [id, data] of Object.entries(entries)) {
      store.put({ id, data });
    }
    await done;
    return true;
  } catch (error) {
    forgetDatabase();
    warnStoreFailure("IndexedDB replace failed", error);
    return false;
  }
};

/** Insert ids that are still absent. Does not clear or overwrite existing rows. */
const putMissing = async (entries: ConnectionLogTerminalDataMap): Promise<boolean> => {
  const rows = sanitizeMap(entries);
  const ids = Object.keys(rows);
  if (ids.length === 0) return true;
  try {
    const db = await getDatabase();
    if (!db) return false;
    const tx = db.transaction(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME, "readwrite");
    const store = tx.objectStore(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME);
    const done = transactionComplete(tx);
    for (const id of ids) {
      const request = store.get(id) as IDBRequest<TerminalDataRow | undefined>;
      request.onsuccess = () => {
        if (request.result === undefined) store.put({ id, data: rows[id] });
      };
    }
    await done;
    return true;
  } catch (error) {
    forgetDatabase();
    warnStoreFailure("IndexedDB put failed", error);
    return false;
  }
};

export const putMany = async (entries: ConnectionLogTerminalDataMap): Promise<boolean> => {
  const rows = sanitizeMap(entries);
  const ids = Object.keys(rows);
  if (ids.length === 0) return true;
  try {
    const db = await getDatabase();
    if (!db) return false;
    const tx = db.transaction(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME, "readwrite");
    const store = tx.objectStore(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME);
    const done = transactionComplete(tx);
    for (const id of ids) store.put({ id, data: rows[id] });
    await done;
    return true;
  } catch (error) {
    forgetDatabase();
    warnStoreFailure("IndexedDB put failed", error);
    return false;
  }
};

export const deleteMany = async (ids: readonly string[]): Promise<boolean> => {
  if (ids.length === 0) return true;
  try {
    const db = await getDatabase();
    if (!db) return false;
    const tx = db.transaction(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME, "readwrite");
    const store = tx.objectStore(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME);
    const done = transactionComplete(tx);
    for (const id of ids) store.delete(id);
    await done;
    return true;
  } catch (error) {
    forgetDatabase();
    warnStoreFailure("IndexedDB delete failed", error);
    return false;
  }
};

export const clear = async (): Promise<boolean> => {
  try {
    const db = await getDatabase();
    if (!db) return false;
    const tx = db.transaction(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME, "readwrite");
    const store = tx.objectStore(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME);
    const done = transactionComplete(tx);
    store.clear();
    await done;
    return true;
  } catch (error) {
    forgetDatabase();
    warnStoreFailure("IndexedDB clear failed", error);
    return false;
  }
};

/**
 * Apply a persisted-map diff in one transaction. Unchanged maps do not open
 * a write. A failed commit leaves the previous rows in place for a retry.
 */
export const writeTerminalDataMapDiff = async (
  previous: ConnectionLogTerminalDataMap,
  next: ConnectionLogTerminalDataMap,
): Promise<{ persisted: boolean; changed: boolean }> => {
  const diff = diffTerminalDataMaps(previous, next);
  const puts = sanitizeMap(diff.puts);
  const putIds = Object.keys(puts);
  if (putIds.length === 0 && diff.deleteIds.length === 0) {
    return { persisted: true, changed: false };
  }
  try {
    const db = await getDatabase();
    if (!db) return { persisted: false, changed: true };
    const tx = db.transaction(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME, "readwrite");
    const store = tx.objectStore(CONNECTION_LOG_TERMINAL_DATA_STORE_NAME);
    const done = transactionComplete(tx);
    for (const id of putIds) store.put({ id, data: puts[id] });
    for (const id of diff.deleteIds) store.delete(id);
    await done;
    return { persisted: true, changed: true };
  } catch (error) {
    forgetDatabase();
    warnStoreFailure("IndexedDB diff write failed", error);
    return { persisted: false, changed: true };
  }
};

const safeRemove = (remove: () => void): void => {
  try {
    remove();
  } catch (error) {
    warnStoreFailure("Failed to remove legacy terminal replay blob", error);
  }
};

const readLegacyMap = (
  legacy: LegacyConnectionLogTerminalDataMigration,
): ConnectionLogTerminalDataMap | null => {
  try {
    return sanitizeMap(legacy.read());
  } catch (error) {
    warnStoreFailure("Failed to read legacy terminal replay blob", error);
    return null;
  }
};

/**
 * One-shot move from the legacy localStorage blob into IndexedDB.
 * An empty IndexedDB plus a legacy blob is copied, then the legacy key is
 * removed only after the transaction commits. Rows already in IndexedDB are
 * kept; legacy ids that are not there yet are inserted before the key is
 * removed. A failed read does not treat the store as empty, and a failed
 * write leaves the legacy key in place.
 */
export const migrateLegacyConnectionLogTerminalData = async (
  legacy: LegacyConnectionLogTerminalDataMigration,
): Promise<MigratedConnectionLogTerminalData> => {
  const loaded = await readAll();
  if (loaded === null) {
    const fallback = readLegacyMap(legacy);
    return { map: fallback ?? {}, migrated: false, durable: false };
  }
  if (Object.keys(loaded).length > 0) {
    const legacyMap = readLegacyMap(legacy);
    if (legacyMap === null) return { map: loaded, migrated: false, durable: true };
    const missing: ConnectionLogTerminalDataMap = {};
    for (const [id, data] of Object.entries(legacyMap)) {
      if (!Object.prototype.hasOwnProperty.call(loaded, id)) missing[id] = data;
    }
    if (Object.keys(missing).length === 0) {
      safeRemove(legacy.remove);
      return { map: loaded, migrated: false, durable: true };
    }
    const persisted = await putMissing(missing);
    if (!persisted) {
      return { map: { ...missing, ...loaded }, migrated: false, durable: false };
    }
    safeRemove(legacy.remove);
    const committed = await readAll();
    return {
      map: committed ?? { ...loaded, ...missing },
      migrated: true,
      durable: committed !== null,
    };
  }

  const legacyMap = readLegacyMap(legacy);
  if (legacyMap === null) return { map: {}, migrated: false, durable: false };
  if (Object.keys(legacyMap).length === 0) {
    safeRemove(legacy.remove);
    return { map: {}, migrated: false, durable: true };
  }
  // Insert without clearing. A row committed after the empty readAll must stay.
  const persisted = await putMissing(legacyMap);
  if (!persisted) return { map: legacyMap, migrated: false, durable: false };
  safeRemove(legacy.remove);
  const committed = await readAll();
  return { map: committed ?? legacyMap, migrated: true, durable: committed !== null };
};
