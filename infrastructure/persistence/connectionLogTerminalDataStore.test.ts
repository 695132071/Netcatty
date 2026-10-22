import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import {
  loadAll,
  migrateLegacyConnectionLogTerminalData,
  putMany,
  replaceAll,
  writeTerminalDataMapDiff,
  type ConnectionLogTerminalDataMap,
} from "./connectionLogTerminalDataStore.ts";

type Row = { id: string; data: string };

type FakeState = {
  failWrites: boolean;
  onGet?: (rows: Map<string, Row>) => void;
  openConnections: Set<{ close: () => void; onversionchange: (() => void) | null }>;
};

const fakeState: FakeState = {
  failWrites: false,
  openConnections: new Set(),
};

const databases = new Map<string, { version: number; stores: Map<string, Map<string, Row>> }>();

const previousIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");

class FakeRequest<T = unknown> {
  result: T | undefined;
  error: Error | null = null;
  onsuccess: ((event?: Event) => void) | null = null;
  onerror: ((event?: Event) => void) | null = null;
  onupgradeneeded: ((event?: Event) => void) | null = null;
}

function installFakeIndexedDB(): void {
  const indexedDB = {
    open(name: string, version = 1) {
      const request = new FakeRequest<FakeDatabase>();
      queueMicrotask(() => {
        let record = databases.get(name);
        if (!record) {
          record = { version: 0, stores: new Map() };
          databases.set(name, record);
        }
        const db = new FakeDatabase(record);
        fakeState.openConnections.add(db);
        request.result = db;
        if (version > record.version) {
          record.version = version;
          request.onupgradeneeded?.(new Event("upgradeneeded"));
        }
        request.onsuccess?.(new Event("success"));
      });
      return request;
    },
    deleteDatabase(name: string) {
      const request = new FakeRequest();
      queueMicrotask(() => {
        for (const db of [...fakeState.openConnections]) db.onversionchange?.();
        databases.delete(name);
        request.onsuccess?.(new Event("success"));
      });
      return request;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    value: indexedDB,
    configurable: true,
    writable: true,
  });
}

class FakeDatabase {
  onversionchange: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(private record: { version: number; stores: Map<string, Map<string, Row>> }) {}

  objectStoreNames = {
    contains: (name: string) => this.record.stores.has(name),
  };

  createObjectStore(name: string): void {
    if (!this.record.stores.has(name)) this.record.stores.set(name, new Map());
  }

  transaction(storeName: string): FakeTransaction {
    const rows = this.record.stores.get(storeName);
    if (!rows) throw new Error(`missing store ${storeName}`);
    return new FakeTransaction(rows);
  }

  close(): void {
    this.closed = true;
    fakeState.openConnections.delete(this);
    this.onclose?.();
  }
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private pending = 0;
  private settled = false;

  constructor(private rows: Map<string, Row>) {
    queueMicrotask(() => this.finish());
  }

  objectStore(): FakeStore {
    return new FakeStore(this.rows, this);
  }

  abort(): void {
    this.error = this.error ?? new Error("aborted");
    if (this.settled) return;
    this.settled = true;
    this.onabort?.();
  }

  track<T>(produce: () => T, writes = true): FakeRequest<T> {
    this.pending += 1;
    const request = new FakeRequest<T>();
    queueMicrotask(() => {
      try {
        if (writes && fakeState.failWrites) {
          const error = new Error("indexedDB write failed");
          this.error = error;
          request.error = error;
          request.onerror?.(new Event("error"));
          this.settled = true;
          this.onerror?.();
          this.onabort?.();
          return;
        }
        request.result = produce();
        request.onsuccess?.(new Event("success"));
      } catch (error) {
        request.error = error instanceof Error ? error : new Error(String(error));
        this.error = request.error;
        request.onerror?.(new Event("error"));
        this.settled = true;
        this.onerror?.();
        this.onabort?.();
        return;
      } finally {
        this.pending -= 1;
        this.finish();
      }
    });
    return request;
  }

  private finish(): void {
    if (this.settled || this.pending > 0) return;
    this.settled = true;
    this.oncomplete?.();
  }
}

class FakeStore {
  constructor(
    private rows: Map<string, Row>,
    private tx: FakeTransaction,
  ) {}

  getAll(): FakeRequest<Row[]> {
    return this.tx.track(() => [...this.rows.values()].map((row) => ({ ...row })), false);
  }

  get(id: string): FakeRequest<Row | undefined> {
    return this.tx.track(() => {
      fakeState.onGet?.(this.rows);
      const row = this.rows.get(id);
      return row ? { ...row } : undefined;
    }, false);
  }

  put(value: Row): FakeRequest<string> {
    return this.tx.track(() => {
      this.rows.set(value.id, { ...value });
      return value.id;
    });
  }

  delete(id: string): FakeRequest<undefined> {
    return this.tx.track(() => {
      this.rows.delete(id);
      return undefined;
    });
  }

  clear(): FakeRequest<undefined> {
    return this.tx.track(() => {
      this.rows.clear();
      return undefined;
    });
  }
}

installFakeIndexedDB();

const resetStore = async () => {
  fakeState.failWrites = false;
  fakeState.onGet = undefined;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("netcatty_connection_log_terminal_data");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(async () => {
  await resetStore();
});

after(() => {
  if (previousIndexedDB) Object.defineProperty(globalThis, "indexedDB", previousIndexedDB);
  else delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

test("putMany, deleteMany, replaceAll, and clear round-trip one row per log id", async () => {
  assert.equal(await replaceAll({ a: "one", b: "two" }), true);
  assert.deepEqual(await loadAll(), { a: "one", b: "two" });

  const diff = await writeTerminalDataMapDiff(
    { a: "one", b: "two" },
    { a: "one", b: "edited", c: "three" },
  );
  assert.deepEqual(diff, { persisted: true, changed: true });
  assert.deepEqual(await loadAll(), { a: "one", b: "edited", c: "three" });

  assert.equal(await replaceAll({ only: "left" }), true);
  assert.deepEqual(await loadAll(), { only: "left" });

  const { clear } = await import("./connectionLogTerminalDataStore.ts");
  assert.equal(await clear(), true);
  assert.deepEqual(await loadAll(), {});
});

test("writeTerminalDataMapDiff skips indexedDB when the map is unchanged", async () => {
  assert.equal(await putMany({ b: "2", a: "1" }), true);
  const result = await writeTerminalDataMapDiff(
    { b: "2", a: "1" },
    { a: "1", b: "2" },
  );
  assert.deepEqual(result, { persisted: true, changed: false });
  assert.deepEqual(await loadAll(), { a: "1", b: "2" });
});

test("migration inserts legacy rows without clearing a replay committed after the empty read", async () => {
  fakeState.onGet = (rows) => {
    rows.set("concurrent", { id: "concurrent", data: "new-window" });
    fakeState.onGet = undefined;
  };
  let removed = false;
  const loaded = await migrateLegacyConnectionLogTerminalData({
    read: () => ({ "log-old": "legacy" }),
    remove: () => {
      removed = true;
    },
  });

  assert.equal(removed, true);
  assert.equal(loaded.durable, true);
  assert.equal(loaded.map.concurrent, "new-window");
  assert.equal(loaded.map["log-old"], "legacy");
  assert.deepEqual(await loadAll(), { concurrent: "new-window", "log-old": "legacy" });
});

test("migration copies a legacy map into indexedDB and removes it only after commit", async () => {
  let removed = false;
  const legacy: ConnectionLogTerminalDataMap = { "log-new": "replay", "log-old": "older" };
  const loaded = await migrateLegacyConnectionLogTerminalData({
    read: () => legacy,
    remove: () => {
      removed = true;
    },
  });

  assert.equal(removed, true);
  assert.equal(loaded.migrated, true);
  assert.deepEqual(loaded.map, legacy);
  assert.deepEqual(await loadAll(), legacy);
});

test("migration keeps indexedDB rows and copies legacy ids that are not stored yet", async () => {
  assert.equal(await putMany({ kept: "from-idb" }), true);
  let removed = false;
  const loaded = await migrateLegacyConnectionLogTerminalData({
    read: () => ({ kept: "stale-legacy", missing: "from-legacy" }),
    remove: () => {
      removed = true;
    },
  });

  assert.equal(removed, true);
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.durable, true);
  assert.deepEqual(loaded.map, { kept: "from-idb", missing: "from-legacy" });
  assert.deepEqual(await loadAll(), { kept: "from-idb", missing: "from-legacy" });
});

test("migration keeps the legacy key when merging missing rows fails", async () => {
  assert.equal(await putMany({ kept: "from-idb" }), true);
  fakeState.failWrites = true;
  let removed = false;
  const loaded = await migrateLegacyConnectionLogTerminalData({
    read: () => ({ missing: "from-legacy" }),
    remove: () => {
      removed = true;
    },
  });

  assert.equal(removed, false);
  assert.equal(loaded.migrated, false);
  assert.equal(loaded.durable, false);
  assert.equal(loaded.map.missing, "from-legacy");
  assert.equal(loaded.map.kept, "from-idb");
  fakeState.failWrites = false;
  assert.deepEqual(await loadAll(), { kept: "from-idb" });
});

test("migration keeps the legacy key when the indexedDB replace fails", async () => {
  let removed = false;
  fakeState.failWrites = true;
  const loaded = await migrateLegacyConnectionLogTerminalData({
    read: () => ({ keep: "legacy" }),
    remove: () => {
      removed = true;
    },
  });

  assert.equal(removed, false);
  assert.equal(loaded.migrated, false);
  assert.deepEqual(loaded.map, { keep: "legacy" });
  fakeState.failWrites = false;
  assert.deepEqual(await loadAll(), {});
});

test("store methods soft-fail when indexedDB is unavailable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    assert.deepEqual(await loadAll(), {});
    assert.equal(await putMany({ a: "x" }), false);
    assert.equal(await replaceAll({ a: "x" }), false);
    const { deleteMany, clear } = await import("./connectionLogTerminalDataStore.ts");
    assert.equal(await deleteMany(["a"]), false);
    assert.equal(await clear(), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
  }
});
